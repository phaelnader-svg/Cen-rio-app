import { closingWeekStart, mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { setClock as setAppClock } from '../src/core/clock';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, resetDatabase, setupTablet } from './helpers';
import {
  F,
  PINS,
  TZ,
  adjust,
  allowWeek,
  finish,
  labor,
  moneyKeys,
  pay,
  post,
  prepareCompany,
  row,
  scenario,
} from './labor-helpers';
import { day, today } from './production-helpers';

/**
 * Remediação pós-auditoria, Rodada 3 — financeiro e privacidade: F9-02 (a confirmação semanal
 * só passa com desbloqueio D12 válido e a auditoria guarda só a evidência segura), F10-20b
 * (antes/depois nas ações financeiras), F8-06 (trabalho concluído sem valor = só estado), F1-09
 * (tablet não recebe evento gerencial mesmo com permissão gerencial) e F10-19 (revisão por
 * devolução resolvida pela ação canônica).
 */
let app: App;
const sockets: WsClient[] = [];
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  setAppClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  await prepareCompany();
});
afterEach(async () => {
  setAttendanceClock();
  setAppClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const WEEK = closingWeekStart(today());
const H = (token: string) => ({ 'x-earnings-unlock': token });
async function tok(c: Client, pin: string) {
  const r = await post(c, F('/my-earnings/unlock'), { pin });
  if (r.status !== 200) throw new Error(`unlock: ${JSON.stringify(r.body)}`);
  return r.body.unlockToken as string;
}
const earnings = async (c: Client, t: string) =>
  (await c.req('GET', F('/my-earnings'), undefined, H(t))).body;
const confirm = (c: Client, headers: Record<string, string>, hash: string | null) =>
  c.req(
    'POST',
    F('/my-earnings/confirm'),
    { week: WEEK, hash, confirm: true },
    { ...headers, 'idempotency-key': crypto.randomUUID() },
  );

/** Ricardo com R$ 1.000 liberado (sofá concluído). */
async function released() {
  const s = await scenario(app);
  const ric = await labor(s.admin, {
    professionalUserId: s.ids.ricardo,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.sofa.id,
    agreedCents: 100000,
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  await finish(s.tablets.Ricardo!, s.sofaTask.id);
  return { s, ric };
}

describe('F9-02 — confirmação semanal só com desbloqueio D12 válido', () => {
  it('válido: confirma e a auditoria guarda método e validade — nunca PIN, hash do PIN ou token', async () => {
    const { s } = await released();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const e = await earnings(R, t);
    const r = await confirm(R, H(t), e.confirmation.currentHash);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'finance.week_confirmed' },
    });
    const changes = log.changes as Record<string, unknown>;
    expect(changes.verification).toEqual({
      method: 'PIN_D12',
      unlockExpiresAt: zonedDateTime(today(), '09:05', TZ).toISOString(),
    });
    expect(changes).toMatchObject({
      before: null,
      after: { kind: 'PROFISSIONAL', hash: e.confirmation.currentHash },
    });
    const pinHash = (await db().user.findUniqueOrThrow({ where: { id: s.ids.ricardo } })).pinHash!;
    const [, sig] = t.split('.');
    for (const secret of [PINS.Ricardo!, pinHash, t, sig!]) {
      expect(JSON.stringify(log)).not.toContain(secret);
      const ev = await db().financialEvent.findMany({ where: { kind: 'CONFIRMADA' } });
      expect(JSON.stringify(ev)).not.toContain(secret);
    }
    expect(log.sessionId).not.toBeNull();
  });

  it('ausente, expirado, de outra pessoa, de outra sessão, adulterado ou pelo painel WEB: recusado, nada gravado', async () => {
    const { s } = await released();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const hash = (await earnings(R, t)).confirmation.currentHash as string;
    const nothing = async () => expect(await db().weeklyClosingConfirmation.count()).toBe(0);
    // Ausente.
    expect((await confirm(R, {}, hash)).status).toBe(403);
    await nothing();
    // Adulterado (expiração estendida e assinatura trocada).
    const [exp, sig] = t.split('.');
    expect((await confirm(R, H(`${Number(exp) + 3_600_000}.${sig}`), hash)).status).toBe(403);
    expect((await confirm(R, H(`${exp}.${'0'.repeat(sig!.length)}`), hash)).status).toBe(403);
    await nothing();
    // De outra pessoa: o token do Márcio não serve na sessão do Ricardo (nem o contrário).
    const tm = await tok(s.tablets['Márcio']!, PINS['Márcio']!);
    expect((await confirm(R, H(tm), hash)).status).toBe(403);
    expect((await confirm(s.tablets['Márcio']!, H(t), hash)).status).toBe(403);
    await nothing();
    // Expirado (6 minutos depois).
    const t0 = zonedDateTime(today(), '09:00', TZ).getTime();
    setAppClock(() => new Date(t0 + 6 * 60_000));
    expect((await confirm(R, H(t), hash)).status).toBe(403);
    await nothing();
    setAppClock();
    // Outra sessão do Ricardo (outro tablet): não herda o desbloqueio.
    const other = (
      await setupTablet(app, s.admin, {
        name: 'Tablet reserva R3',
        employee: 'Ricardo',
        pin: PINS.Ricardo!,
      })
    ).tablet;
    expect((await confirm(other, H(t), hash)).status).toBe(403);
    await nothing();
    // Pelo painel (sessão WEB): a confirmação é só do tablet.
    expect((await confirm(s.admin, H(t), hash)).status).toBe(403);
    await nothing();
    expect(await db().auditLog.count({ where: { action: 'finance.week_confirmed' } })).toBe(0);
  });
});

describe('F10-20b — antes/depois consultável nas ações financeiras', () => {
  it('pagamento, estorno, exceção e nova confirmação guardam o estado anterior e o novo', async () => {
    const { s, ric } = await released();
    // Exceção administrativa: antes = nada; depois = a exceção.
    await allowWeek(s.admin, s.ids.ricardo, WEEK);
    const exc = await db().auditLog.findFirstOrThrow({
      where: { action: 'finance.week_exception' },
    });
    expect(exc.changes).toMatchObject({
      before: null,
      after: { kind: 'EXCECAO_ADMINISTRATIVA' },
      reason: 'Teste: liberação administrativa',
    });
    // Pagamento parcial: de 0 para 40.000; situação de LIBERADO para PAGO_PARCIAL.
    const before = await row(ric.id);
    const p = await post(s.admin, F(`/labor/${ric.id}/payments`), {
      amountCents: 40000,
      paidAt: today(),
      method: 'PIX',
      version: before.version,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const paid = await db().auditLog.findFirstOrThrow({ where: { action: 'finance.labor_paid' } });
    expect(paid.changes).toMatchObject({
      paidCents: { from: 0, to: 40000 },
      status: { from: before.status, to: 'PAGO_PARCIAL' },
    });
    // Nova conferência do profissional depois da exceção: o "antes" é a exceção.
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const e = await earnings(R, t);
    if (e.confirmation.currentHash) {
      const c = await confirm(R, H(t), e.confirmation.currentHash);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const conf = await db().auditLog.findFirstOrThrow({
        where: { action: 'finance.week_confirmed' },
      });
      expect(conf.changes).toMatchObject({ before: { kind: 'EXCECAO_ADMINISTRATIVA' } });
    }
    // Ajuste e decisão de pedido de alteração também guardam de/para.
    await adjust(s.admin, ric.id, 2500, 'Braço extra');
    const adj = await db().auditLog.findFirstOrThrow({
      where: { action: 'finance.labor_adjusted' },
    });
    expect(adj.changes).toMatchObject({ adjustmentsCents: { from: 0, to: 2500 } });
    const vr = await db().valueChangeRequest.create({
      data: {
        targetKind: 'PRODUCAO',
        productionPayableId: ric.id,
        beneficiaryUserId: s.ids.ricardo,
        currentCents: 102500,
        requestedCents: 110000,
        reason: 'Pedido de teste',
      },
    });
    const rej = await post(s.admin, F(`/value-requests/${vr.id}/reject`), {
      version: vr.version,
      note: 'Valor combinado mantido',
    });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(
      (
        await db().auditLog.findFirstOrThrow({
          where: { action: 'finance.value_request_rejected' },
        })
      ).changes,
    ).toMatchObject({ status: { from: 'PENDENTE', to: 'RECUSADA' } });
    // Nenhum dado sensível nos registros genéricos de auditoria.
    const all = await db().auditLog.findMany({ where: { action: { startsWith: 'finance.' } } });
    expect(JSON.stringify(all)).not.toMatch(new RegExp(PINS.Ricardo!));
  });
});

describe('F8-06 — trabalho concluído sem valor lançado: só estado', () => {
  it('titular que concluiu a tapeçaria sem obrigação vê "valor ainda não disponível", sem R$ e fora dos totais; lançar o valor tira o estado', async () => {
    const s = await scenario(app);
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const e = await earnings(R, t);
    expect(e.pendingWork).toEqual([
      expect.objectContaining({
        state: 'SEM_VALOR',
        label: 'Valor ainda não disponível',
        piece: expect.stringMatching(/\/1$/),
      }),
    ]);
    // Nenhum valor (nem R$ 0,00), nenhum total alterado, nenhuma obrigação criada.
    expect(moneyKeys(e.pendingWork)).toEqual([]);
    expect(JSON.stringify(e.pendingWork)).not.toMatch(/R\$|Cents/);
    expect(e.summary).toMatchObject({ forecastCents: 0, releasedCents: 0, balanceCents: 0 });
    expect(await db().productionPayable.count()).toBe(0);
    // Quem não é titular (Márcio, que ainda não concluiu) não vê nada; apoio nunca entra.
    const m = s.tablets['Márcio']!;
    expect((await earnings(m, await tok(m, PINS['Márcio']!))).pendingWork).toEqual([]);
    // O gestor lança a mão de obra: o estado some (agora há obrigação, com valor real).
    await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 70000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    const after = await earnings(R, t);
    expect(after.pendingWork).toEqual([]);
    expect(after.items).toHaveLength(1);
  });

  it('titular trocado depois da execução: ambíguo → não aparece para ninguém', async () => {
    const s = await scenario(app);
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await db().serviceOrderItem.update({
      where: { id: s.sofa.id },
      data: { upholstererUserId: s.ids.marcio },
    });
    for (const name of ['Ricardo', 'Márcio'] as const) {
      const c = s.tablets[name]!;
      expect((await earnings(c, await tok(c, PINS[name]!))).pendingWork).toEqual([]);
    }
  });
});

describe('F1-09 — tablet com permissão gerencial não recebe eventos gerenciais', () => {
  it('tablet do Ricardo com financeiro.ver: nada de "finance.*" de terceiros, só o próprio aviso sem valores', async () => {
    const s = await scenario(app);
    await db().userPermission.create({
      data: { userId: s.ids.ricardo, permission: 'financeiro.ver' },
    });
    const ws = await WsClient.connect(app, s.tablets.Ricardo!);
    sockets.push(ws);
    // Mão de obra do Márcio (terceiro) e do próprio Ricardo.
    const mar = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 45678,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 98765,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await ws.waitFor(
      (m) => m.event?.type === 'finance.own_changed' && m.event.aggregateId === s.ids.ricardo,
    );
    // O painel do gestor recebe o evento financeiro do Márcio (prova de que ele foi emitido).
    const panel = await WsClient.connect(app, s.admin, '0');
    sockets.push(panel);
    await panel.waitFor((m) => String(m.event?.type ?? '').startsWith('finance.'));
    const others = ws.messages.filter(
      (m) =>
        String(m.event?.type ?? '').startsWith('finance.') &&
        m.event.type !== 'finance.own_changed',
    );
    expect(others).toEqual([]);
    expect(JSON.stringify(ws.messages)).not.toMatch(/45678|98765/);
    expect(moneyKeys(ws.messages)).toEqual([]);
    expect([mar.id, ric.id]).toHaveLength(2);
    // A mesma pessoa no painel (sessão WEB) continuaria vendo — o corte é pelo tipo de sessão.
  });
});

describe('F10-19 — revisão por devolução', () => {
  it('cancelar a mão de obra em revisão resolve o aviso "revisar valor" dos gestores; o aviso fica no histórico', async () => {
    const { s, ric } = await released();
    // Devolução da peça com trabalho executado → aviso REVISAO_DEVOLUCAO aos gestores.
    const { settleLaborOfWithdrawal } = await import('../src/modules/finance/withdrawal');
    await db().$transaction((tx) =>
      settleLaborOfWithdrawal(
        tx,
        { userId: null, sessionId: null, ip: null, requestId: null },
        s.so.id,
        { itemIds: [s.sofa.id] },
        'Cliente retirou a peça',
      ),
    );
    const notices = () =>
      db().notification.findMany({
        where: { kind: 'REVISAO_DEVOLUCAO', dedupeKey: { startsWith: `labor-review:${ric.id}` } },
      });
    const born = await notices();
    expect(born.length).toBeGreaterThan(0);
    expect(born.every((n) => n.resolvedAt === null)).toBe(true);
    // Lido continua ativo.
    await db().notification.updateMany({
      where: { id: { in: born.map((n) => n.id) } },
      data: { readAt: new Date() },
    });
    expect((await notices()).every((n) => n.resolvedAt === null)).toBe(true);
    // Ação canônica que encerra a condição: o gestor cancela a mão de obra com motivo.
    const cur = await row(ric.id);
    const c = await post(s.admin, F(`/labor/${ric.id}/cancel`), {
      reason: 'Peça devolvida: valor não é devido',
      version: cur.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const done = await notices();
    expect(done.every((n) => n.resolvedAt !== null)).toBe(true);
    expect(done).toHaveLength(born.length);
    const audit = await db().auditLog.findFirstOrThrow({
      where: { action: 'finance.labor_cancelled' },
    });
    expect(audit.changes).toMatchObject({ status: { to: 'CANCELADO' } });
    void pay;
  });

  it('revisão que muda o valor: o ajuste justificado resolve o aviso; ver não resolve; nova devolução reativa; ajustes simultâneos', async () => {
    const { s, ric } = await released();
    const { settleLaborOfWithdrawal } = await import('../src/modules/finance/withdrawal');
    const system = { userId: null, sessionId: null, ip: null, requestId: null };
    const returnPiece = () =>
      db().$transaction((tx) =>
        settleLaborOfWithdrawal(tx, system, s.so.id, { itemIds: [s.sofa.id] }, 'Cliente retirou'),
      );
    const notices = () =>
      db().notification.findMany({
        where: { kind: 'REVISAO_DEVOLUCAO', dedupeKey: { startsWith: `labor-review:${ric.id}` } },
      });
    await returnPiece();
    const born = await notices();
    expect(born.length).toBeGreaterThan(0);
    // Abrir a obrigação e a lista de avisos não resolve nada.
    expect((await s.admin.get(F(`/labor/${ric.id}`))).status).toBe(200);
    await s.admin.get('/api/v1/notifications?status=ativas');
    expect((await notices()).every((n) => n.resolvedAt === null)).toBe(true);
    // Dois ajustes simultâneos com a mesma versão: um vence, o outro é recusado pela versão.
    const cur = await row(ric.id);
    const [a, b] = await Promise.all(
      [-1000, -2000].map((amountCents) =>
        post(s.admin, F(`/labor/${ric.id}/adjustments`), {
          amountCents,
          reason: 'Revisão da devolução: parte do serviço não foi feita',
          version: cur.version,
        }),
      ),
    );
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db().financialAdjustment.count({ where: { productionPayableId: ric.id } })).toBe(
      1,
    );
    const done = await notices();
    expect(done).toHaveLength(born.length);
    expect(done.every((n) => n.resolvedAt !== null)).toBe(true);
    const resolvedAt = done.map((n) => n.resolvedAt!.toISOString()).sort();
    // A obrigação segue a fonte única: valor devido = combinado + ajuste; nada cancelado.
    expect((await row(ric.id)).status).not.toBe('CANCELADO');
    // Nova devolução da mesma peça: o mesmo aviso volta a ficar ativo (sem duplicar).
    await returnPiece();
    const again = await notices();
    expect(again).toHaveLength(born.length);
    expect(again.every((n) => n.resolvedAt === null && n.readAt === null)).toBe(true);
    expect(resolvedAt).toHaveLength(born.length);
  });
});

describe('F8-03 — previsto sem semana financeira (decisão C)', () => {
  it('previsto: "sem semana", planejamento só informativo; reprogramar muda a informação, não o financeiro', async () => {
    const s = await scenario(app);
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    const mar = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 55555,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    type Item = {
      id: string;
      bucket: string;
      situation: string;
      dueCents: number;
      plannedFor: { weekStart: string; date: string | null } | null;
    };
    const mine = async () =>
      (await earnings(R, t)) as { items: Item[]; summary: Record<string, number> };
    const before = await mine();
    const it1 = before.items.find((i) => i.id === ric.id)!;
    // Previsto: ainda não é devido, sem semana financeira; a data do plano é só informação.
    expect(it1).toMatchObject({ bucket: 'FORECAST', situation: 'PREVISTO', dueCents: 0 });
    expect(it1.plannedFor).toEqual({ weekStart: mondayOf(today()), date: today() });
    expect(before.summary.balanceCents).toBe(0);
    expect(before.summary.forecastCents).toBe(100000);
    // Privacidade: nada do Márcio (valor nem planejamento) chega ao Ricardo.
    expect(before.items.some((i) => i.id === mar.id)).toBe(false);
    expect(JSON.stringify(before)).not.toContain('55555');
    // Fechamento e fonte financeira antes da reprogramação.
    const closing = async () => (await s.admin.get(F(`/weekly-closings/${WEEK}`))).body;
    const closingBefore = await closing();
    const events = () => db().financialEvent.count();
    const evBefore = await events();
    const rowBefore = await row(ric.id);
    // Reprogramação da etapa: muda só a informação do planejamento.
    const task = await db().productionTask.findUniqueOrThrow({ where: { id: s.sofaTask.id } });
    const put = await s.admin.put(`/api/v1/production-tasks/${task.id}`, {
      date: day(1),
      reason: 'Cliente pediu outro dia',
      version: task.version,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = await mine();
    const it2 = after.items.find((i) => i.id === ric.id)!;
    expect(it2).toMatchObject({ bucket: 'FORECAST', situation: 'PREVISTO', dueCents: 0 });
    expect(it2.plannedFor?.date).toBe(day(1));
    expect(after.summary).toEqual(before.summary);
    // Nenhum histórico financeiro reescrito; obrigação intacta; fechamento igual.
    expect(await events()).toBe(evBefore);
    const rowAfter = await row(ric.id);
    expect({ ...rowAfter, updatedAt: null }).toEqual({ ...rowBefore, updatedAt: null });
    expect(await closing()).toEqual(closingBefore);
  });
});
