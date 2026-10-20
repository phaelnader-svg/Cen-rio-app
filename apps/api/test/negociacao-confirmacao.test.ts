import { closingWeekStart, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, resetDatabase } from './helpers';
import {
  F,
  PINS,
  TZ,
  adjust,
  allowWeek,
  finish,
  labor,
  moneyKeys,
  post,
  prepareCompany,
  row,
  scenario,
  setOwner,
  type Scenario,
} from './labor-helpers';
import { day, tabletOf, today, userIdOf } from './production-helpers';

/**
 * R2 — negociação de valores, confirmação semanal do profissional e portão de pagamento (D13).
 * Ricardo: sofá liberado (R$ 1.000); Márcio: poltronas (R$ 450, condição "produção concluída").
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
const LAST_WEEK = closingWeekStart(day(-7));
const H = (token: string) => ({ 'x-earnings-unlock': token });
async function tok(c: Client, pin: string) {
  const r = await post(c, F('/my-earnings/unlock'), { pin });
  if (r.status !== 200) throw new Error(`unlock: ${JSON.stringify(r.body)}`);
  return r.body.unlockToken as string;
}
const earnings = async (c: Client, t: string, week?: string) =>
  (await c.req('GET', F(`/my-earnings${week ? `?week=${week}` : ''}`), undefined, H(t))).body;
const ask = (c: Client, t: string, body: Record<string, unknown>) =>
  c.req('POST', F('/my-earnings/requests'), body, {
    ...H(t),
    'idempotency-key': crypto.randomUUID(),
  });
const confirm = (c: Client, t: string, hash: string | null, week = WEEK) =>
  c.req(
    'POST',
    F('/my-earnings/confirm'),
    { week, hash, confirm: true },
    { ...H(t), 'idempotency-key': crypto.randomUUID() },
  );
async function confirmOwn(c: Client, t: string, week = WEEK) {
  const e = await earnings(c, t, week);
  const r = await confirm(c, t, e.confirmation.currentHash, week);
  if (r.status !== 200) throw new Error(`confirm: ${JSON.stringify(r.body)}`);
  return r.body as { code: string };
}
const payDirect = async (admin: Client, id: string, amountCents: number, extra = {}) =>
  post(admin, F(`/labor/${id}/payments`), {
    amountCents,
    paidAt: today(),
    method: 'PIX',
    version: (await row(id)).version,
    ...extra,
  });
const payLot = (admin: Client, userId: string, amountCents: number, category = 'TAPECARIA') =>
  post(admin, F(`/weekly-closings/${WEEK}/payments`), {
    beneficiaryUserId: userId,
    category,
    amountCents,
    paidAt: today(),
    method: 'PIX',
  });
const decide = async (admin: Client, id: string, action: 'approve' | 'reject', note?: string) => {
  const r = await db().valueChangeRequest.findUniqueOrThrow({ where: { id } });
  return post(admin, F(`/value-requests/${id}/${action}`), {
    version: r.version,
    ...(note !== undefined ? { note } : {}),
  });
};

/** Ricardo com R$ 1.000 liberado; Márcio com R$ 450 previsto (libera ao concluir). */
async function base(): Promise<{
  s: Scenario;
  ric: { id: string; code: string };
  mar: { id: string; code: string };
}> {
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
    agreedCents: 45000,
    service: 'Troca de tecido das poltronas',
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  await finish(s.tablets.Ricardo!, s.sofaTask.id);
  return { s, ric, mar };
}

/** Viagem devida ao André (conta a pagar vinculada), como no fechamento. */
async function andreTrip(cents = 12000) {
  const andre = await userIdOf('André');
  const ap = await db().accountPayable.create({
    data: {
      beneficiary: 'André',
      category: 'LOGISTICA',
      description: 'Entrega do André',
      amountCents: cents,
      dueDate: new Date(`${today()}T00:00:00Z`),
    },
  });
  const c = await db().logisticsCost.create({
    data: {
      kind: 'ENTREGA',
      description: 'Entrega feita pelo André',
      amountCents: cents,
      date: new Date(`${today()}T00:00:00Z`),
      splitMethod: 'IGUAL',
      status: 'DEVIDO',
      payeeUserId: andre,
      dueAt: new Date(),
      payableId: ap.id,
    },
  });
  return { andre, cost: c, payable: ap };
}

// ─────────────────────────── Negociação ───────────────────────────

describe('Negociação de valores (1–18)', () => {
  it('1/8/11/16/18. tapeceiro pede; gestor aprova pelo ajuste existente; profissional vê; sem segunda fonte', async () => {
    const { s, ric } = await base();
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const r = await ask(s.tablets.Ricardo!, t, {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 120000,
      reason: 'Tecido grosso exigiu costura dupla',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      status: 'PENDENTE',
      currentCents: 100000,
      requestedCents: 120000,
    });
    const list = (await s.admin.get(F('/value-requests?status=PENDENTE'))).body;
    expect(list[0]).toMatchObject({
      code: r.body.code,
      beneficiary: { userId: s.ids.ricardo },
      diffCents: 20000,
      staleReason: null,
      weekStart: WEEK,
    });
    const before = await db().productionPayable.count();
    const ok = await decide(s.admin, r.body.id, 'approve', 'Combinado por telefone');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APROVADA', appliedAs: 'AJUSTE' });
    // Efeito pelo mecanismo existente: um ajuste justificado na mesma obrigação.
    expect(await row(ric.id)).toMatchObject({ agreedCents: 100000, adjustmentsCents: 20000 });
    const adj = await db().financialAdjustment.findMany({ where: { productionPayableId: ric.id } });
    expect(adj).toHaveLength(1);
    expect(adj[0]!.reason).toMatch(new RegExp(`Pedido ${r.body.code} aprovado`));
    expect(await db().productionPayable.count()).toBe(before);
    const mine = await earnings(s.tablets.Ricardo!, t);
    expect(mine.items[0].request).toMatchObject({ code: r.body.code, status: 'APROVADA' });
    expect(mine.items[0].totalDueCents).toBe(120000);
  });

  it('valor ainda não liberado e sem pagamento: aplica como valor combinado', async () => {
    const { s, mar } = await base();
    const t = await tok(s.tablets['Márcio']!, PINS['Márcio']!);
    const r = await ask(s.tablets['Márcio']!, t, {
      targetKind: 'PRODUCAO',
      targetId: mar.id,
      requestedCents: 50000,
      reason: 'Poltronas com mais botões',
    });
    expect(r.status).toBe(201);
    const ok = await decide(s.admin, r.body.id, 'approve');
    expect(ok.body.appliedAs).toBe('VALOR_COMBINADO');
    expect(await row(mar.id)).toMatchObject({ agreedCents: 50000, adjustmentsCents: 0 });
  });

  it('2. logística pede alteração da própria viagem; aprovação ajusta custo e conta a pagar', async () => {
    const { s } = await base();
    const { cost, payable } = await andreTrip(12000);
    const tab = await tabletOf(app, s.admin, 'André', PINS['André']!);
    const t = await tok(tab, PINS['André']!);
    const r = await ask(tab, t, {
      targetKind: 'LOGISTICA',
      targetId: cost.id,
      requestedCents: 15000,
      reason: 'Pedágio e estacionamento',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await decide(s.admin, r.body.id, 'approve')).status).toBe(200);
    expect(
      (await db().logisticsCost.findUniqueOrThrow({ where: { id: cost.id } })).adjustmentsCents,
    ).toBe(3000);
    expect(
      (await db().accountPayable.findUniqueOrThrow({ where: { id: payable.id } })).amountCents,
    ).toBe(15000);
  });

  it('3/4. ajudante não pede; ninguém pede sobre valor de outra pessoa', async () => {
    const { s, mar } = await base();
    const { cost } = await andreTrip();
    expect(
      (await post(s.tablets['João']!, F('/my-earnings/unlock'), { pin: PINS['João'] })).status,
    ).toBe(403);
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    for (const body of [
      { targetKind: 'PRODUCAO', targetId: mar.id },
      { targetKind: 'LOGISTICA', targetId: cost.id },
    ]) {
      const r = await ask(s.tablets.Ricardo!, t, {
        ...body,
        requestedCents: 99999,
        reason: 'Tentativa indevida',
      });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/45000|12000/);
    }
    // Sem o desbloqueio (D12) também não.
    const raw = await post(s.tablets.Ricardo!, F('/my-earnings/requests'), {
      targetKind: 'PRODUCAO',
      targetId: mar.id,
      requestedCents: 1,
      reason: 'Sem desbloqueio',
    });
    expect(raw.status).toBe(403);
    expect(await db().valueChangeRequest.count()).toBe(0);
  });

  it('5/6/7. uma pendente por alvo; repetição idempotente; concorrência sem duplicar', async () => {
    const { s, ric } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const body = {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 110000,
      reason: 'Costura extra',
    };
    const both = await Promise.all([
      ask(R, t, body),
      ask(R, t, { ...body, requestedCents: 130000, reason: 'Outro valor' }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([201, 409]);
    const first = both.find((x) => x.status === 201)!.body;
    const again = await ask(R, t, {
      ...body,
      requestedCents: first.requestedCents,
      reason: first.reason,
    });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.id);
    expect(await db().valueChangeRequest.count()).toBe(1);
  });

  it('9/10/17. recusa exige motivo, não muda valor; o motivo só chega ao próprio profissional', async () => {
    const { s, ric } = await base();
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const r = (
      await ask(s.tablets.Ricardo!, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 150000,
        reason: 'Peço reajuste',
      })
    ).body;
    expect((await decide(s.admin, r.id, 'reject')).status).toBe(400);
    const no = await decide(s.admin, r.id, 'reject', 'Valor já combinado no orçamento');
    expect(no.body).toMatchObject({
      status: 'RECUSADA',
      decisionNote: 'Valor já combinado no orçamento',
    });
    expect(await row(ric.id)).toMatchObject({ agreedCents: 100000, adjustmentsCents: 0 });
    expect(await db().financialAdjustment.count()).toBe(0);
    const mine = await earnings(s.tablets.Ricardo!, t);
    expect(mine.items[0].request).toMatchObject({
      status: 'RECUSADA',
      decisionNote: 'Valor já combinado no orçamento',
    });
    const tm = await tok(s.tablets['Márcio']!, PINS['Márcio']!);
    expect(JSON.stringify(await earnings(s.tablets['Márcio']!, tm))).not.toMatch(
      /orçamento|Peço reajuste|150000/,
    );
    // Tablet nunca vê a fila do gestor.
    expect((await s.tablets.Ricardo!.get(F('/value-requests'))).status).toBe(403);
    // Decidido: nova decisão recusada.
    expect((await decide(s.admin, r.id, 'approve')).status).toBe(422);
  });

  it('12/13. alvo mudou → obsoleta (nada aplicado); aprovação × ajuste simultâneos consistentes', async () => {
    const { s, ric } = await base();
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const r1 = (
      await ask(s.tablets.Ricardo!, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 120000,
        reason: 'Pedido um',
      })
    ).body;
    expect((await adjust(s.admin, ric.id, 5000, 'Ajuste do gestor')).status).toBe(200);
    const late = await decide(s.admin, r1.id, 'approve');
    expect(late.status).toBe(422);
    expect(late.body.error.message).toMatch(/obsoleto/i);
    expect((await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe(
      'OBSOLETA',
    );
    expect((await row(ric.id)).adjustmentsCents).toBe(5000);
    // Novo pedido (o obsoleto não bloqueia) × ajuste manual ao mesmo tempo.
    const r2 = (
      await ask(s.tablets.Ricardo!, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 125000,
        reason: 'Pedido dois',
      })
    ).body;
    const v = (await row(ric.id)).version;
    const [a, b] = await Promise.all([
      decide(s.admin, r2.id, 'approve'),
      post(s.admin, F(`/labor/${ric.id}/adjustments`), {
        amountCents: 1000,
        reason: 'Concorrente',
        version: v,
      }),
    ]);
    const p = await row(ric.id);
    const st = (await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r2.id } })).status;
    if (a.status === 200) {
      expect(b.status).toBe(409);
      expect(p.adjustmentsCents).toBe(25000);
    } else {
      expect(b.status).toBe(200);
      expect(st).toBe('OBSOLETA');
      expect(p.adjustmentsCents).toBe(6000);
    }
  });

  it('14/15. revisão financeira / troca de titular: pedido obsoleto e novo pedido recusado', async () => {
    const { s, ric } = await base();
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const r = (
      await ask(s.tablets.Ricardo!, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 120000,
        reason: 'Pedido antes da troca',
      })
    ).body;
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Ricardo afastado');
    const res = await decide(s.admin, r.id, 'approve');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/titular|revisão/i);
    expect(await db().financialAdjustment.count()).toBe(0);
    const again = await ask(s.tablets.Ricardo!, t, {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 130000,
      reason: 'Pedido durante revisão',
    });
    expect(again.status).toBe(422);
  });
});

// ─────────────────────────── Confirmação semanal ───────────────────────────

describe('Confirmação semanal (19–34)', () => {
  it('19/20/21/22/23. abre, hash determinístico, confirma, repetição devolve a mesma', async () => {
    const { s } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const a = await earnings(R, t);
    const b = await earnings(R, t);
    expect(a.confirmation).toMatchObject({ state: 'SEM_CONFIRMACAO', totalCents: 100000 });
    expect(a.confirmation.currentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.confirmation.currentHash).toBe(a.confirmation.currentHash);
    const c1 = await confirm(R, t, a.confirmation.currentHash);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    const c2 = await confirm(R, t, a.confirmation.currentHash);
    expect(c2.body.code).toBe(c1.body.code);
    expect(await db().weeklyClosingConfirmation.count()).toBe(1);
    const after = await earnings(R, t);
    expect(after.confirmation).toMatchObject({
      state: 'CONFIRMADA',
      latest: { kind: 'PROFISSIONAL' },
    });
    const row0 = await db().weeklyClosingConfirmation.findFirstOrThrow();
    expect(row0).toMatchObject({
      kind: 'PROFISSIONAL',
      totalCents: 100000,
      hash: a.confirmation.currentHash,
    });
    expect(row0.deviceId).not.toBeNull();
    expect(JSON.stringify(row0.items)).not.toMatch(/Ricardo|Cliente/);
    // Imutável no banco.
    await expect(
      db().weeklyClosingConfirmation.update({ where: { id: row0.id }, data: { totalCents: 1 } }),
    ).rejects.toThrow();
    // Gestor vê no fechamento.
    const d = (await s.admin.get(F(`/weekly-closings/${WEEK}`))).body;
    expect(
      d.rows.find(
        (x: { beneficiary: { userId: string } }) => x.beneficiary.userId === s.ids.ricardo,
      ).confirmation.state,
    ).toBe('CONFIRMADA');
  });

  it('24/25/33. A não confirma B; semana errada; semana sem itens', async () => {
    const { s } = await base();
    const tr = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const hash = (await earnings(s.tablets.Ricardo!, tr)).confirmation.currentHash;
    const tm = await tok(s.tablets['Márcio']!, PINS['Márcio']!);
    // Márcio (sem nada liberado) com o hash do Ricardo: nada a conferir.
    const m = await confirm(s.tablets['Márcio']!, tm, hash);
    expect(m.status).toBe(422);
    expect((await earnings(s.tablets['Márcio']!, tm)).confirmation.state).toBe('SEM_ITENS');
    // Semana anterior com o hash desta semana: recusado.
    expect([409, 422]).toContain((await confirm(s.tablets.Ricardo!, tr, hash, LAST_WEEK)).status);
    expect(await db().weeklyClosingConfirmation.count()).toBe(0);
  });

  it('26. pedido pendente impede confirmar', async () => {
    const { s, ric } = await base();
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const r = (
      await ask(s.tablets.Ricardo!, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 120000,
        reason: 'Contesto o valor',
      })
    ).body;
    const e = await earnings(s.tablets.Ricardo!, t);
    expect(e.confirmation.pendingRequests).toEqual([r.code]);
    const c = await confirm(s.tablets.Ricardo!, t, e.confirmation.currentHash);
    expect(c.status).toBe(422);
    expect(c.body.error.message).toMatch(/pendente/);
  });

  it('27/28/30/31. ajuste e negociação invalidam; confirmação antiga preservada; nova confirmação', async () => {
    const { s, ric } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    await confirmOwn(R, t);
    expect((await adjust(s.admin, ric.id, 5000, 'Ajuste após conferência')).status).toBe(200);
    let e = await earnings(R, t);
    expect(e.confirmation).toMatchObject({ state: 'DESATUALIZADA', changed: [ric.code] });
    expect(await db().weeklyClosingConfirmation.count()).toBe(1);
    await confirmOwn(R, t);
    e = await earnings(R, t);
    expect(e.confirmation.state).toBe('CONFIRMADA');
    // Negociação aprovada também muda o retrato.
    const r = (
      await ask(R, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 110000,
        reason: 'Ajuste final',
      })
    ).body;
    await decide(s.admin, r.id, 'approve');
    e = await earnings(R, t);
    expect(e.confirmation.state).toBe('DESATUALIZADA');
    expect(await db().weeklyClosingConfirmation.count()).toBe(2);
  });

  it('29/39/40/41. confirmação libera pagamento; pagamentos parciais não invalidam', async () => {
    const { s, ric } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    await confirmOwn(R, t);
    expect((await payDirect(s.admin, ric.id, 30000)).status).toBe(200);
    expect((await earnings(R, t)).confirmation.state).toBe('CONFIRMADA');
    expect((await payDirect(s.admin, ric.id, 30000)).status).toBe(200);
    expect((await payLot(s.admin, s.ids.ricardo, 40000)).status).toBe(201);
    expect(await row(ric.id)).toMatchObject({ paidCents: 100000, status: 'PAGO' });
    const ev = await db().financialEvent.findMany({
      where: { entityId: ric.id, kind: 'PAGAMENTO' },
    });
    expect(
      ev.every(
        (x) => (x.data as { coverage?: { kind: string } }).coverage?.kind === 'PROFISSIONAL',
      ),
    ).toBe(true);
  });

  it('32/38. logística confirma a própria semana; sem confirmação a conta da viagem não é paga', async () => {
    const { s } = await base();
    const { andre, payable } = await andreTrip(12000);
    const payAp = async () =>
      post(s.admin, F(`/payables/${payable.id}/payments`), {
        amountCents: 12000,
        paidAt: today(),
        method: 'PIX',
        version: (await db().accountPayable.findUniqueOrThrow({ where: { id: payable.id } }))
          .version,
      });
    // Rota genérica de conta a pagar: não contorna o portão.
    const blocked = await payAp();
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/não foi confirmada/);
    expect((await payLot(s.admin, andre, 12000, 'LOGISTICA')).status).toBe(422);
    const tab = await tabletOf(app, s.admin, 'André', PINS['André']!);
    const t = await tok(tab, PINS['André']!);
    await confirmOwn(tab, t);
    expect((await payLot(s.admin, andre, 12000, 'LOGISTICA')).status).toBe(201);
  });

  it('34. fuso: liberação no domingo 23h30 local pertence à semana daquele domingo', async () => {
    const { s, ric } = await base();
    const sunday = day(-((new Date(`${today()}T12:00:00Z`).getUTCDay() + 7) % 7 || 7));
    await db().productionPayable.update({
      where: { id: ric.id },
      data: { eligibleAt: zonedDateTime(sunday, '23:30', TZ) },
    });
    const week = closingWeekStart(sunday);
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const e = await earnings(s.tablets.Ricardo!, t, week);
    expect(e.confirmation.lines.map((l: { code: string }) => l.code)).toEqual([ric.code]);
    await confirmOwn(s.tablets.Ricardo!, t, week);
    const ok = await payDirect(s.admin, ric.id, 1000, { paidAt: sunday });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

// ─────────────────────────── D13 ───────────────────────────

describe('Portão de pagamento D13 (35–55)', () => {
  it('35/36/37/49. sem confirmação: direto, parcial e lote bloqueados', async () => {
    const { s, ric } = await base();
    for (const amount of [100000, 1000]) {
      const r = await payDirect(s.admin, ric.id, amount);
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(
        /Esta semana ainda não foi confirmada pelo profissional/,
      );
    }
    const lot = await payLot(s.admin, s.ids.ricardo, 1000);
    expect(lot.status).toBe(422);
    expect(lot.body.error.message).toMatch(/não foi confirmada/);
    expect(await db().professionalPayment.count()).toBe(0);
  });

  it('42. valor mudou depois da confirmação: a confirmação antiga não libera', async () => {
    const { s, ric } = await base();
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    await confirmOwn(s.tablets.Ricardo!, t);
    await adjust(s.admin, ric.id, 5000, 'Mudou depois');
    expect((await payDirect(s.admin, ric.id, 1000)).status).toBe(422);
  });

  it('43/44/45/46/47. exceção: motivo, pessoa, semana e retrato exatos; não finge confirmação', async () => {
    const { s, ric, mar } = await base();
    await finish(s.tablets['Márcio']!, s.poltronaTask.id);
    const noReason = await post(s.admin, F(`/weekly-closings/${WEEK}/exceptions`), {
      beneficiaryUserId: s.ids.ricardo,
    });
    expect(noReason.status).toBe(400);
    const tablet = await post(s.tablets.Ricardo!, F(`/weekly-closings/${WEEK}/exceptions`), {
      beneficiaryUserId: s.ids.ricardo,
      reason: 'Tentativa do tablet',
    });
    expect(tablet.status).toBe(403);
    await allowWeek(s.admin, s.ids.ricardo, WEEK);
    expect((await payDirect(s.admin, ric.id, 20000)).status).toBe(200);
    // Exceção do Ricardo não libera o Márcio.
    expect((await payDirect(s.admin, mar.id, 1000)).status).toBe(422);
    // Exceção desta semana não libera pagamento datado na semana anterior.
    expect((await payDirect(s.admin, ric.id, 1000, { paidAt: day(-7) })).status).toBe(422);
    // Valor mudou: a exceção antiga não cobre.
    await adjust(s.admin, ric.id, 3000, 'Ajuste após exceção');
    expect((await payDirect(s.admin, ric.id, 1000)).status).toBe(422);
    // Registro: tipo próprio, motivo interno, gestor; o profissional vê só a mensagem neutra.
    const ex = await db().weeklyClosingConfirmation.findFirstOrThrow({
      where: { kind: 'EXCECAO_ADMINISTRATIVA' },
    });
    expect(ex).toMatchObject({
      reason: 'Teste: liberação administrativa',
      publicNote: 'Pagamento liberado administrativamente.',
    });
    expect(ex.createdById).not.toBeNull();
    expect(await db().auditLog.count({ where: { action: 'finance.week_exception' } })).toBe(1);
    const t = await tok(s.tablets.Ricardo!, PINS.Ricardo!);
    const e = await earnings(s.tablets.Ricardo!, t);
    expect(e.items[0].payments[0]).toMatchObject({ amountCents: 20000, administrative: true });
    expect(JSON.stringify(e)).not.toContain('Teste: liberação administrativa');
    expect(e.confirmation.state).toBe('DESATUALIZADA');
  });

  it('48. antecipação não contorna o D13; só exceção com o item exato', async () => {
    const { s, mar } = await base();
    const early = { earlyReason: 'Adiantamento combinado' };
    expect((await payDirect(s.admin, mar.id, 10000, early)).status).toBe(422);
    // Exceção "da semana" (sem itens) não inclui o que ainda não foi liberado.
    expect(
      (
        await post(s.admin, F(`/weekly-closings/${WEEK}/exceptions`), {
          beneficiaryUserId: s.ids.marcio,
          reason: 'Sem itens devidos',
        })
      ).status,
    ).toBe(422);
    await allowWeek(s.admin, s.ids.marcio, WEEK, [mar.id]);
    const ok = await payDirect(s.admin, mar.id, 10000, early);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('50/51/52/53. concorrência: pagamentos, confirmação, ajuste e negociação × pagamento', async () => {
    const { s, ric } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    // Confirmação × pagamento: ou o pagamento vê a confirmação, ou é recusado.
    const e = await earnings(R, t);
    const [c, p0] = await Promise.all([
      confirm(R, t, e.confirmation.currentHash),
      payDirect(s.admin, ric.id, 10000),
    ]);
    expect(c.status).toBe(200);
    expect([200, 409, 422]).toContain(p0.status);
    // Dois pagamentos simultâneos não passam do saldo.
    const open = 100000 - (await row(ric.id)).paidCents;
    const v = (await row(ric.id)).version;
    const two = await Promise.all(
      [0, 1].map(() =>
        post(s.admin, F(`/labor/${ric.id}/payments`), {
          amountCents: open - 10000,
          paidAt: today(),
          method: 'PIX',
          version: v,
        }),
      ),
    );
    expect(two.filter((x) => x.status === 200)).toHaveLength(1);
    expect((await row(ric.id)).paidCents).toBeLessThanOrEqual(100000);
    // Ajuste × pagamento: estado sempre coerente (pago ≤ devido; sem deadlock).
    const v2 = (await row(ric.id)).version;
    const [adj, pay] = await Promise.all([
      post(s.admin, F(`/labor/${ric.id}/adjustments`), {
        amountCents: 2000,
        reason: 'Concorrente',
        version: v2,
      }),
      payDirect(s.admin, ric.id, 1000),
    ]);
    expect([200, 409, 422]).toContain(adj.status);
    expect([200, 409, 422]).toContain(pay.status);
    const p = await row(ric.id);
    expect(p.paidCents).toBeLessThanOrEqual(p.agreedCents + p.adjustmentsCents);
    // Negociação × pagamento.
    const req = (
      await ask(R, await tok(R, PINS.Ricardo!), {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: p.agreedCents + p.adjustmentsCents + 1000,
        reason: 'Concorrência',
      })
    ).body;
    const [ap, py] = await Promise.all([
      decide(s.admin, req.id, 'approve'),
      payDirect(s.admin, ric.id, 500),
    ]);
    expect([200, 422]).toContain(ap.status);
    expect([200, 409, 422]).toContain(py.status);
    const q = await row(ric.id);
    expect(q.paidCents).toBeLessThanOrEqual(q.agreedCents + q.adjustmentsCents);
  });

  it('54/55. exceção × confirmação e duas exceções simultâneas: ambas registradas, sem deadlock', async () => {
    const { s } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const e = await earnings(R, t);
    const res = await Promise.all([
      confirm(R, t, e.confirmation.currentHash),
      post(s.admin, F(`/weekly-closings/${WEEK}/exceptions`), {
        beneficiaryUserId: s.ids.ricardo,
        reason: 'Exceção A',
      }),
      post(s.admin, F(`/weekly-closings/${WEEK}/exceptions`), {
        beneficiaryUserId: s.ids.ricardo,
        reason: 'Exceção B',
      }),
    ]);
    expect(res.map((r) => r.status)).toEqual([200, 201, 201]);
    expect(await db().weeklyClosingConfirmation.count()).toBe(3);
  });
});

describe('F9-03/F9-06: versão, retrato e histórico da confirmação', () => {
  const closingOf = async (admin: Client) =>
    (await admin.get(F(`/weekly-closings/${WEEK}`))).body as { version: number };

  it('versão N vale enquanto nada muda; mudou → não libera; nova versão referencia o novo estado; antiga fica no histórico', async () => {
    const { s, ric } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const v1 = await confirmOwn(R, t);
    const first = await db().weeklyClosingConfirmation.findFirstOrThrow();
    let e = await earnings(R, t);
    expect(e.confirmation.history).toEqual([
      expect.objectContaining({
        code: v1.code,
        kind: 'PROFISSIONAL',
        hash: e.confirmation.currentHash,
        status: 'VIGENTE',
        changed: [],
        // Semana ainda não conferida pelo gestor: sem versão de fechamento.
        closingVersion: null,
        invalidatedAt: null,
      }),
    ]);
    // Nada mudou: continua valendo (pagamento parcial passa e não invalida).
    expect((await payDirect(s.admin, ric.id, 10000)).status).toBe(200);
    expect((await earnings(R, t)).confirmation.state).toBe('CONFIRMADA');
    // Valor mudou: a confirmação antiga não libera — direto, parcial e lote.
    expect((await adjust(s.admin, ric.id, 5000, 'Mudou depois da versão 1')).status).toBe(200);
    expect((await payDirect(s.admin, ric.id, 1000)).status).toBe(422);
    expect((await payLot(s.admin, s.ids.ricardo, 1000)).status).toBe(422);
    e = await earnings(R, t);
    expect(e.confirmation.state).toBe('DESATUALIZADA');
    expect(e.confirmation.history[0]).toMatchObject({
      code: v1.code,
      status: 'INVALIDA',
      changed: [ric.code],
      invalidatedAt: null,
    });
    // A tela antiga (hash da versão 1) não confirma o estado novo.
    expect((await confirm(R, t, first.hash)).status).toBe(409);
    // Nova versão: nova confirmação, sobre o estado atual.
    const v2 = await confirmOwn(R, t);
    e = await earnings(R, t);
    expect(e.confirmation.state).toBe('CONFIRMADA');
    expect(e.confirmation.history.map((h: { code: string }) => h.code)).toEqual([v2.code, v1.code]);
    expect(e.confirmation.history[0]).toMatchObject({
      status: 'VIGENTE',
      hash: e.confirmation.currentHash,
    });
    expect(e.confirmation.history[0].hash).not.toBe(first.hash);
    const line = (
      await db().weeklyClosingConfirmation.findFirstOrThrow({ where: { NOT: { id: first.id } } })
    ).items as { id: string; totalDueCents: number }[];
    expect(line.find((l) => l.id === ric.id)!.totalDueCents).toBe(105000);
    // A antiga: retrato intacto, marcada como invalidada pela nova (quando e por qual).
    expect(e.confirmation.history[1]).toMatchObject({
      code: v1.code,
      status: 'INVALIDA',
      invalidatedBy: v2.code,
    });
    expect(e.confirmation.history[1].invalidatedAt).toBeTruthy();
    const again = await db().weeklyClosingConfirmation.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect([again.hash, again.items, again.totalCents]).toEqual([
      first.hash,
      first.items,
      first.totalCents,
    ]);
    expect(
      await db().financialEvent.count({ where: { entityId: first.id, kind: 'INVALIDADA' } }),
    ).toBe(1);
    // Agora o pagamento (parcial e lote) passa pela versão nova.
    expect((await payDirect(s.admin, ric.id, 1000)).status).toBe(200);
    expect((await payLot(s.admin, s.ids.ricardo, 1000)).status).toBe(201);
    const pay = await db().financialEvent.findFirstOrThrow({
      where: { entityId: ric.id, kind: { in: ['PAGAMENTO', 'PAGAMENTO_PARCIAL'] } },
      orderBy: { createdAt: 'desc' },
    });
    expect((pay.data as { coverage?: { code?: string } }).coverage?.code).toBe(v2.code);
  });

  it('versão do fechamento do gestor fica gravada; exceção administrativa continua funcionando', async () => {
    const { s, ric } = await base();
    const before = await closingOf(s.admin);
    const conf = await post(s.admin, F(`/weekly-closings/${WEEK}/confirm`), {
      version: before.version ?? 0,
    });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    const closing = await db().weeklyClosing.findFirstOrThrow();
    const ex = await allowWeek(s.admin, s.ids.ricardo, WEEK);
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const e = await earnings(R, t);
    expect(e.confirmation.state).toBe('LIBERADA_POR_EXCECAO');
    expect(e.confirmation.history[0]).toMatchObject({
      code: ex.code,
      kind: 'EXCECAO_ADMINISTRATIVA',
      status: 'VIGENTE',
      closingVersion: closing.version,
    });
    expect(JSON.stringify(e.confirmation.history)).not.toContain('Teste: liberação administrativa');
    expect((await payDirect(s.admin, ric.id, 5000)).status).toBe(200);
  });

  it('antecipação respeita o D13 com a versão exata do item', async () => {
    const { s, mar } = await base();
    const early = { earlyReason: 'Adiantamento combinado' };
    expect((await payDirect(s.admin, mar.id, 10000, early)).status).toBe(422);
    await allowWeek(s.admin, s.ids.marcio, WEEK, [mar.id]);
    expect((await payDirect(s.admin, mar.id, 10000, early)).status).toBe(200);
    // Mudou o valor previsto: a exceção antiga não cobre a nova versão do item.
    expect((await adjust(s.admin, mar.id, 2000, 'Mudou o previsto')).status).toBe(200);
    expect((await payDirect(s.admin, mar.id, 1000, early)).status).toBe(422);
  });

  it('confirmação × alteração simultâneas: nunca libera um estado que não foi conferido', async () => {
    const { s, ric } = await base();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    for (let n = 0; n < 3; n++) {
      const e = await earnings(R, t);
      const [c, a] = await Promise.all([
        confirm(R, t, e.confirmation.currentHash),
        adjust(s.admin, ric.id, 1000, `Concorrente ${n}`),
      ]);
      expect([200, 409]).toContain(c.status);
      expect([200, 409, 422]).toContain(a.status);
      const cur = (await earnings(R, t)).confirmation;
      const vigente = cur.history.some((h: { status: string }) => h.status === 'VIGENTE');
      const p = await payDirect(s.admin, ric.id, 100);
      // Paga só se alguma confirmação tem exatamente o estado atual do item.
      expect(p.status).toBe(vigente ? 200 : 422);
    }
  });
});

describe('Privacidade e notificações (26–29 do roteiro)', () => {
  it('confirmações e pedidos só do próprio; WS e notificações sem valores', async () => {
    const { s, ric } = await base();
    const ws = await WsClient.connect(app, s.tablets.Ricardo!);
    sockets.push(ws);
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const r = (
      await ask(R, t, {
        targetKind: 'PRODUCAO',
        targetId: ric.id,
        requestedCents: 123456,
        reason: 'Pedido privado',
      })
    ).body;
    await decide(s.admin, r.id, 'reject', 'Motivo do gestor');
    await confirmOwn(R, t);
    // Márcio não vê nada do Ricardo.
    const tm = await tok(s.tablets['Márcio']!, PINS['Márcio']!);
    const m = await earnings(s.tablets['Márcio']!, tm);
    expect(JSON.stringify(m)).not.toMatch(/123456|Pedido privado|Motivo do gestor|SV-|CS-/);
    // Notificações: sem valores.
    const nR = (await R.get('/api/v1/notifications')).body;
    expect(JSON.stringify(nR)).toMatch(/SV-00001/);
    expect(JSON.stringify(nR)).not.toMatch(/123456|1\.234|R\$/);
    const nG = await db().notification.findMany({ where: { kind: 'VALOR_SOLICITADO' } });
    expect(nG.length).toBeGreaterThan(0);
    expect(nG.every((n) => !/\d{3,}[.,]\d{2}|R\$/.test(n.body))).toBe(true);
    await new Promise((x) => setTimeout(x, 300));
    expect(moneyKeys(ws.messages)).toEqual([]);
    expect(JSON.stringify(ws.messages)).not.toMatch(/123456/);
  });
});
