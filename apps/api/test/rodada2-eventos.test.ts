import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVENT_TYPES, closingWeekStart } from '@cenario/shared';
import type { Prisma } from '@cenario/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { detectOpenShifts } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { resolveNotifications } from '../src/modules/notifications/notify';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, employeeByName, loginAdmin, resetDatabase } from './helpers';
import {
  F,
  PINS,
  absenceProposal,
  adjust,
  allowWeek,
  finish,
  labor,
  moneyKeys,
  post,
  prepareCompany,
  row,
  scenario,
} from './labor-helpers';
import { act, day, tabletOf, today, userIdOf } from './production-helpers';
import { arrive, attendanceAction, setClock } from './presence-helpers';

/**
 * Remediação pós-auditoria, Rodada 2 — F8-15b (Meus Ganhos ao vivo: `finance.own_changed`, só
 * para o próprio profissional e sem valores) e F10-19 (notificação persistida ATIVA × RESOLVIDA
 * pela ação que resolve a condição; migration aditiva com reversão condicionada).
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  await prepareCompany();
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const WEEK = closingWeekStart(today());
const OWN = EVENT_TYPES.FINANCE_OWN_CHANGED;
type Ev = { type: string; aggregateId: string; payload: unknown };
const headOf = async (c: Client) => String((await c.get('/api/sync/status')).body.headSeq);
/** Eventos que a sessão enxerga desde `since` (a mesma regra de audiência do tempo real). */
const seen = async (c: Client, since: string) =>
  (await c.get(`/api/sync/events?since=${since}`)).body.events as Ev[];
const own = (events: Ev[]) => events.filter((e) => e.type === OWN);
const noValues = (events: Ev[]) => {
  for (const e of events) {
    expect(moneyKeys(e.payload)).toEqual([]);
    expect(JSON.stringify(e.payload)).not.toMatch(/\d{3,}/);
  }
};

// ─────────────────────────── F8-15b — finance.own_changed ───────────────────────────

describe('F8-15b — Meus Ganhos ao vivo (finance.own_changed)', () => {
  it('cada mudança do próprio valor avisa só o profissional certo, sem valores', async () => {
    const s = await scenario(app);
    const R = s.tablets.Ricardo!;
    const M = s.tablets['Márcio']!;
    const since = { R: await headOf(R), M: await headOf(M), A: await headOf(s.admin) };
    const wR = track(await WsClient.connect(app, R));
    // Criação da obrigação (previsto).
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await wR.waitFor((m) => m.event?.type === OWN);
    // Liberação (obrigação passa a devida), ajuste, pagamento e estorno.
    await finish(R, s.sofaTask.id);
    expect((await adjust(s.admin, ric.id, 5000, 'Ajuste combinado')).status).toBe(200);
    await allowWeek(s.admin, s.ids.ricardo, WEEK);
    const paid = await post(s.admin, F(`/labor/${ric.id}/payments`), {
      amountCents: 30000,
      paidAt: today(),
      method: 'PIX',
      version: (await row(ric.id)).version,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const pay = await db().professionalPayment.findFirstOrThrow({
      where: { productionPayableId: ric.id },
    });
    const rev = await post(s.admin, F(`/labor/${ric.id}/payments/${pay.id}/reverse`), {
      reason: 'Pix devolvido',
      version: (await row(ric.id)).version,
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const mine = own(await seen(R, since.R));
    // Uma transação = no máximo um aviso por pessoa; todos endereçados ao próprio Ricardo.
    expect(mine.length).toBeGreaterThanOrEqual(6);
    expect(new Set(mine.map((e) => e.aggregateId))).toEqual(new Set([s.ids.ricardo]));
    noValues(mine);
    // Ninguém mais recebe o aviso do Ricardo: nem o tablet do Márcio, nem o gestor (que já
    // acompanha pelos eventos financeiros com a permissão dele).
    expect(own(await seen(M, since.M))).toEqual([]);
    expect(own(await seen(s.admin, since.A))).toEqual([]);
    // Ao vivo, também nenhum valor no payload.
    noValues(wR.events(OWN));
  });

  it('negociação aprovada avisa o profissional; a do outro não', async () => {
    const s = await scenario(app);
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const t = (await post(s.tablets.Ricardo!, F('/my-earnings/unlock'), { pin: PINS.Ricardo })).body
      .unlockToken as string;
    const r = await s.tablets.Ricardo!.req(
      'POST',
      F('/my-earnings/requests'),
      { targetKind: 'PRODUCAO', targetId: ric.id, requestedCents: 120000, reason: 'Costura dupla' },
      { 'x-earnings-unlock': t, 'idempotency-key': crypto.randomUUID() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const sinceR = await headOf(s.tablets.Ricardo!);
    const sinceM = await headOf(s.tablets['Márcio']!);
    const vr = await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    const ok = await post(s.admin, F(`/value-requests/${vr.id}/approve`), { version: vr.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(own(await seen(s.tablets.Ricardo!, sinceR)).length).toBeGreaterThanOrEqual(1);
    expect(own(await seen(s.tablets['Márcio']!, sinceM))).toEqual([]);
  });

  it('logística: ajuste do custo devido avisa o recebedor da viagem (e só ele)', async () => {
    const s = await scenario(app);
    const andre = await userIdOf('André');
    const tab = await tabletOf(app, s.admin, 'André', PINS['André']!);
    const ap = await db().accountPayable.create({
      data: {
        beneficiary: 'André',
        category: 'LOGISTICA',
        description: 'Entrega do André',
        amountCents: 10000,
        dueDate: new Date(`${today()}T00:00:00Z`),
      },
    });
    const cost = await db().logisticsCost.create({
      data: {
        kind: 'ENTREGA',
        description: 'Entrega feita pelo André',
        amountCents: 10000,
        date: new Date(`${today()}T00:00:00Z`),
        splitMethod: 'IGUAL',
        status: 'DEVIDO',
        payeeUserId: andre,
        dueAt: new Date(),
        payableId: ap.id,
      },
    });
    const since = { A: await headOf(tab), R: await headOf(s.tablets.Ricardo!) };
    const r = await post(s.admin, F(`/logistics-costs/${cost.id}/adjustments`), {
      amountCents: 2000,
      reason: 'Pedágio combinado',
      version: cost.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mine = own(await seen(tab, since.A));
    expect(mine.length).toBe(1);
    expect(mine[0]!.aggregateId).toBe(andre);
    noValues(mine);
    expect(own(await seen(s.tablets.Ricardo!, since.R))).toEqual([]);
  });

  it('logística: troca do recebedor avisa o antigo e o novo; reconexão recupera o aviso', async () => {
    const s = await scenario(app);
    const andre = await userIdOf('André');
    const tab = await tabletOf(app, s.admin, 'André', PINS['André']!);
    // O previsto da logística aparece para o recebedor configurado (`buildClosingItems`).
    const defaults = (await s.admin.get(F('/logistics-defaults'))).body;
    const setPayee = async (userId: string) => {
      const r = await s.admin.req(
        'PUT',
        F('/logistics-defaults'),
        {
          defaultPickupCostCents: defaults.defaultPickupCostCents ?? null,
          defaultDeliveryCostCents: defaults.defaultDeliveryCostCents ?? null,
          logisticsPayeeUserId: userId,
        },
        { 'idempotency-key': crypto.randomUUID() },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await setPayee(s.ids.thiago);
    const since = { A: await headOf(tab), T: await headOf(s.tablets.Thiago!) };
    const sinceM = await headOf(s.tablets['Márcio']!);
    await setPayee(andre);
    // O antigo recebedor também é avisado (o previsto saiu do Meus Ganhos dele).
    expect(own(await seen(s.tablets.Thiago!, since.T)).map((e) => e.aggregateId)).toEqual([
      s.ids.thiago,
    ]);
    // Reconexão (resume a partir do último visto): o aviso perdido é reenviado só para ele.
    const w = track(await WsClient.connect(app, tab, since.A));
    await w.waitFor((m) => m.kind === 'replay.done');
    const replayed = w.events(OWN) as Ev[];
    expect(replayed.map((e) => e.aggregateId)).toEqual([andre]);
    noValues(replayed);
    const wM = track(await WsClient.connect(app, s.tablets['Márcio']!, sinceM));
    await wM.waitFor((m) => m.kind === 'replay.done');
    expect(wM.events(OWN)).toEqual([]);
  });
});

// ─────────────────────────── F10-19 — notificações resolvidas ───────────────────────────

const list = async (c: Client, status?: string) =>
  (await c.get(`/api/v1/notifications${status ? `?status=${status}` : ''}`)).body as {
    items: { id: string; kind: string; resolvedAt: string | null }[];
    unread: number;
  };
const meId = async (c: Client) => (await c.get('/api/auth/me')).body.user.id as string;

describe('F10-19 — notificação ATIVA × RESOLVIDA', () => {
  async function requestValue(s: Awaited<ReturnType<typeof scenario>>, payableId: string) {
    const t = (await post(s.tablets.Ricardo!, F('/my-earnings/unlock'), { pin: PINS.Ricardo })).body
      .unlockToken as string;
    const r = await s.tablets.Ricardo!.req(
      'POST',
      F('/my-earnings/requests'),
      {
        targetKind: 'PRODUCAO',
        targetId: payableId,
        requestedCents: 110000,
        reason: 'Braço extra',
      },
      { 'x-earnings-unlock': t, 'idempotency-key': crypto.randomUUID() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string };
  }

  it('criada ativa; decisão resolve; sai da lista ativa e fica no histórico; repetir não muda', async () => {
    const s = await scenario(app);
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const req = await requestValue(s, ric.id);
    const gestor = await meId(s.admin);
    let active = await list(s.admin);
    const notice = active.items.find((n) => n.kind === 'VALOR_SOLICITADO')!;
    expect(notice).toMatchObject({ resolvedAt: null });
    const unreadBefore = active.unread;
    const vr = await db().valueChangeRequest.findUniqueOrThrow({ where: { id: req.id } });
    const since = await headOf(s.admin);
    expect(
      (
        await post(s.admin, F(`/value-requests/${vr.id}/reject`), {
          version: vr.version,
          note: 'Não',
        })
      ).status,
    ).toBe(200);
    active = await list(s.admin);
    expect(active.items.some((n) => n.id === notice.id)).toBe(false);
    expect(active.unread).toBe(unreadBefore - 1);
    const resolved = await list(s.admin, 'resolvidas');
    expect(resolved.items.find((n) => n.id === notice.id)!.resolvedAt).not.toBeNull();
    // A caixa do gestor é avisada (só ele), para sair da lista em tempo real.
    const ev = (await seen(s.admin, since)).filter((e) => e.type === 'notification.resolved');
    expect(ev.map((e) => e.aggregateId)).toEqual([gestor]);
    // O aviso informativo do profissional (decisão) continua ativo: outro tipo, não é tocado.
    expect((await list(s.tablets.Ricardo!)).items.some((n) => n.kind === 'VALOR_DECIDIDO')).toBe(
      true,
    );
    // Idempotente: repetir a resolução não muda a data nem publica de novo.
    const at = (await db().notification.findUniqueOrThrow({ where: { id: notice.id } })).resolvedAt;
    const again = await db().$transaction((tx) =>
      resolveNotifications(tx, { userId: gestor, requestId: null } as never, 'VALOR_SOLICITADO', [
        `VALOR:${vr.id}`,
      ]),
    );
    expect(again).toBe(0);
    expect(
      (await db().notification.findUniqueOrThrow({ where: { id: notice.id } })).resolvedAt,
    ).toEqual(at);
  });

  it('concorrência: duas resoluções simultâneas marcam uma vez; outro assunto não é resolvido', async () => {
    const s = await scenario(app);
    const gestor = await meId(s.admin);
    const mk = (key: string) =>
      db().notification.create({
        data: {
          userId: gestor,
          kind: 'VALOR_SOLICITADO',
          title: 'Pedido de alteração de valor',
          body: 'Teste',
          dedupeKey: key,
        },
      });
    const a = await mk(`VALOR:${crypto.randomUUID()}:${gestor}`);
    const b = await mk(`VALOR:${crypto.randomUUID()}:${gestor}`);
    const subject = a.dedupeKey.split(':').slice(0, 2).join(':');
    const run = () =>
      db().$transaction((tx) =>
        resolveNotifications(tx, { userId: gestor, requestId: null } as never, 'VALOR_SOLICITADO', [
          subject,
        ]),
      );
    const counts = await Promise.all([run(), run()]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(
      (await db().notification.findUniqueOrThrow({ where: { id: a.id } })).resolvedAt,
    ).not.toBeNull();
    expect(
      (await db().notification.findUniqueOrThrow({ where: { id: b.id } })).resolvedAt,
    ).toBeNull();
  });

  it('legado: aviso anterior à coluna (resolved_at nulo) continua ativo e contado', async () => {
    const s = await scenario(app);
    const gestor = await meId(s.admin);
    const legacy = await db().notification.create({
      data: {
        userId: gestor,
        kind: 'OS_ATUALIZADA',
        title: 'OS atualizada',
        body: 'Aviso antigo',
        dedupeKey: 'LEGADO:1',
      },
    });
    const l = await list(s.admin);
    expect(l.items.find((n) => n.id === legacy.id)).toMatchObject({ resolvedAt: null });
    expect(l.unread).toBeGreaterThanOrEqual(1);
    expect((await list(s.admin, 'resolvidas')).items.some((n) => n.id === legacy.id)).toBe(false);
  });

  it('reprogramação pendente: a decisão resolve o aviso dos planejadores', async () => {
    const s = await scenario(app, { arrive: ['Márcio', 'Thiago', 'João'] });
    const proposal = await absenceProposal(s);
    const gestor = await meId(s.admin);
    const pending = await db().notification.findMany({
      where: { userId: gestor, kind: 'REPROGRAMACAO_PENDENTE' },
    });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.every((n) => n.resolvedAt === null)).toBe(true);
    const r = await post(s.admin, `/api/v1/reschedule-proposals/${proposal.id}/reject`, {
      note: 'Mantém como está',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await db().notification.findMany({
      where: {
        userId: gestor,
        kind: 'REPROGRAMACAO_PENDENTE',
        dedupeKey: { contains: proposal.id },
      },
    });
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.every((n) => n.resolvedAt !== null)).toBe(true);
  });

  it('expediente sem saída: registrar a saída resolve o aviso', async () => {
    const s = await scenario(app, { arrive: [] });
    setClock('08:30', day(-1));
    expect((await arrive(s.tablets['João']!)).status).toBe(200);
    setClock('08:00');
    expect(await detectOpenShifts(app.ctx.prisma)).toBe(1);
    const gestor = await meId(s.admin);
    const open = await db().notification.findFirstOrThrow({
      where: { userId: gestor, kind: 'EXPEDIENTE_ABERTO' },
    });
    expect(open.resolvedAt).toBeNull();
    const joao = await employeeByName('João');
    const before = await db().operationalAttendance.findUniqueOrThrow({
      where: {
        employeeId_date: { employeeId: joao.id, date: new Date(`${day(-1)}T00:00:00.000Z`) },
      },
    });
    const reg = await attendanceAction(s.admin, {
      employeeId: joao.id,
      date: day(-1),
      action: 'REGISTRAR_SAIDA',
      departureTime: '17:30',
      reason: 'Saiu às 17h30 (confirmado com ele)',
      version: before.version,
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(
      (await db().notification.findUniqueOrThrow({ where: { id: open.id } })).resolvedAt,
    ).not.toBeNull();
  });

  it('ocorrência atribuída: cancelar a ocorrência resolve o aviso de quem a recebeu', async () => {
    const s = await scenario(app);
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    const issue = await post(s.tablets.Ricardo!, '/api/v1/issues', {
      taskId: s.sofaTask.id,
      kind: 'TECNICO',
      description: 'Máquina de costura travando',
      impact: 'DIFICULDADE',
    });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    const asg = await post(s.admin, `/api/v1/issues/${issue.body.id}/assign`, {
      assigneeUserId: s.ids.joao,
      instructions: 'Ajustar a tensão da linha',
      confirmConflict: true,
    });
    expect(asg.status, JSON.stringify(asg.body)).toBe(200);
    const notice = await db().notification.findFirstOrThrow({
      where: { userId: s.ids.joao, kind: 'OCORRENCIA_ATRIBUIDA' },
    });
    expect(notice.resolvedAt).toBeNull();
    const cur = await db().productionIssue.findUniqueOrThrow({ where: { id: issue.body.id } });
    const c = await post(s.admin, `/api/v1/issues/${issue.body.id}/cancel`, {
      note: 'Registrada por engano',
      version: cur.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(
      (await db().notification.findUniqueOrThrow({ where: { id: notice.id } })).resolvedAt,
    ).not.toBeNull();
    // Para o João, o aviso sai da lista ativa e fica no histórico.
    expect((await list(s.tablets['João']!)).items.some((n) => n.id === notice.id)).toBe(false);
    expect(
      (await list(s.tablets['João']!, 'resolvidas')).items.some((n) => n.id === notice.id),
    ).toBe(true);
  });
});

// ─────────────────────────── F10-19 — migration e reversão ───────────────────────────

/** Separa os comandos de um script de reversão respeitando blocos $$ … $$ (sem BEGIN/COMMIT). */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let cur = '';
  let quoted = false;
  for (const line of sql.replace(/--.*$/gm, '').split('\n')) {
    cur += line + '\n';
    quoted = quoted !== ((line.match(/\$\$/g) ?? []).length % 2 === 1);
    if (!quoted && line.trim().endsWith(';')) {
      const st = cur.trim().replace(/;$/, '');
      if (!/^(BEGIN|COMMIT)$/i.test(st)) statements.push(st);
      cur = '';
    }
  }
  return statements;
}

describe('F10-19 — migration 20270216000000_notificacoes_resolvidas', () => {
  it('aditiva, sem backfill; reversão sem dados novos é limpa; com aviso resolvido é bloqueada', async () => {
    const DB = resolve(__dirname, '../../../packages/db');
    const NAME = '20270216000000_notificacoes_resolvidas';
    const up = readFileSync(resolve(DB, `prisma/migrations/${NAME}/migration.sql`), 'utf8');
    const down = splitSql(readFileSync(resolve(DB, `rollback/${NAME}.down.sql`), 'utf8'));
    const column = (tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>) =>
      tx.$queryRawUnsafe<{ type: string; nullable: string; default: string | null }[]>(
        `SELECT data_type AS type, is_nullable AS nullable, column_default AS "default"
           FROM information_schema.columns
          WHERE table_name = 'notifications' AND column_name = 'resolved_at'`,
      );
    expect(await column(db())).toEqual([
      { type: 'timestamp with time zone', nullable: 'YES', default: null },
    ]);
    const admin = await loginAdmin(app);
    const gestor = await meId(admin);
    const n = await db().notification.create({
      data: {
        userId: gestor,
        kind: 'OS_ATUALIZADA',
        title: 'OS',
        body: 'Antigo',
        dedupeKey: 'MIG:1',
      },
    });
    const snapshot = async (tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>) =>
      tx.$queryRawUnsafe<{ s: string }[]>(
        `SELECT md5(string_agg(id::text || kind || body || dedupe_key || coalesce(read_at::text, '-'), '/' ORDER BY id)) AS s
           FROM notifications`,
      );
    const before = await snapshot(db());
    // Sem aviso resolvido: a reversão remove a coluna e o registro; os dados ficam intactos;
    // reaplicar a migration volta ao estado atual (tudo numa transação desfeita no fim).
    await expect(
      db().$transaction(async (tx) => {
        for (const st of down) await tx.$executeRawUnsafe(st);
        expect(await column(tx)).toEqual([]);
        expect(
          await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '${NAME}'`,
          ),
        ).toEqual([{ n: 0 }]);
        expect(await snapshot(tx)).toEqual(before);
        await tx.$executeRawUnsafe(up);
        expect(await column(tx)).toHaveLength(1);
        expect(
          await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM notifications WHERE resolved_at IS NOT NULL`,
          ),
        ).toEqual([{ n: 0 }]);
        throw new Error('desfazer');
      }),
    ).rejects.toThrow('desfazer');
    // Com um aviso resolvido, a reversão é recusada e nada muda.
    await db().notification.update({ where: { id: n.id }, data: { resolvedAt: new Date() } });
    await expect(
      db().$transaction(async (tx) => {
        for (const st of down) await tx.$executeRawUnsafe(st);
      }),
    ).rejects.toThrow(/Reversão bloqueada: 1 notificação/);
    expect(await column(db())).toHaveLength(1);
    expect(
      (await db().notification.findUniqueOrThrow({ where: { id: n.id } })).resolvedAt,
    ).not.toBeNull();
  });
});
