import { closingWeekStart, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, resetDatabase } from './helpers';
import {
  F,
  TZ,
  absenceProposal,
  adjust,
  changePrincipal,
  finish,
  labor,
  pay,
  post,
  prepareCompany,
  put,
  row,
  scenario,
  setOwner,
} from './labor-helpers';
import { day, today } from './production-helpers';

/**
 * R1 — mão de obra confiável (fonte de verdade antes de "Meus Ganhos"):
 * - P0-1: trocar o principal (inclusive pela Reprogramação) passa pela regra canônica do titular;
 * - P0-2: devolução parcial com mão de obra da OS inteira abre revisão (sem desconto);
 * - estorno com estado/revisão/versão; revisão só bloqueia a semana relacionada; semana
 *   conferida não é reescrita por ajuste posterior; situação única da obrigação da OS inteira;
 *   pagamento em lote continua sem confirmação do profissional (D13 fica para R2).
 * OS de teste: sofá (titular Ricardo) + poltronas (titular Márcio). Valores em centavos.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});
afterEach(() => setAttendanceClock());

const WEEK = closingWeekStart(today());
const LAST_WEEK = closingWeekStart(day(-7));
const C = (week: string, path = '') => F(`/weekly-closings/${week}${path}`);
const openReviews = () =>
  db().laborReview.findMany({ where: { status: 'ABERTA' }, orderBy: { number: 'asc' } });
/** Libera a mão de obra numa data passada (a semana anterior), como se tivesse ocorrido lá. */
const releasedAt = (id: string, iso: string, hhmm = '10:00') =>
  db().productionPayable.update({
    where: { id },
    data: { eligibleAt: zonedDateTime(iso, hhmm, TZ), createdAt: zonedDateTime(iso, '08:00', TZ) },
  });

// ───────────────────────────────────────────────────────────────────────────

describe('Titular e troca de principal (P0-1)', () => {
  it('1/2. titular recebe a obrigação; a troca pela rota canônica abre revisão e preserva o fato', async () => {
    const s = await scenario(app);
    // Só o titular da peça pode ter o valor da peça.
    const wrong = await post(s.admin, F('/labor'), {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      service: 'Reforma',
      agreedCents: 80000,
    });
    expect(wrong.status).toBe(422);
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    expect(await row(mo.id)).toMatchObject({
      professionalUserId: s.ids.ricardo,
      status: 'PREVISTO',
    });
    const r = await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Ricardo afastado');
    expect(r).toMatchObject({ changed: true, financialReviewRequired: true });
    const [rv] = await openReviews();
    expect(rv).toMatchObject({ serviceOrderItemId: s.sofa.id });
    expect(await row(mo.id)).toMatchObject({
      professionalUserId: s.ids.ricardo,
      agreedCents: 80000,
    });
  });

  it('3/4/5/6. TROCAR_PRINCIPAL pela Reprogramação = substituição canônica + revisão; nada inventado', async () => {
    const s = await scenario(app, { arrive: ['Márcio', 'Thiago', 'João'] });
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    const p = await absenceProposal(s);
    const r = await changePrincipal(s, p, s.ids.marcio);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Tarefa e titular operacional mudam juntos.
    const task = await db().productionTask.findUniqueOrThrow({ where: { id: s.sofaTask.id } });
    expect(task.assigneeUserId).toBe(s.ids.marcio);
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    expect(item.upholstererUserId).toBe(s.ids.marcio);
    // Histórico da troca (com motivo) e revisão financeira ligada a ela.
    const change = await db().serviceOrderItemOwnerChange.findFirstOrThrow({
      where: { serviceOrderItemId: s.sofa.id, kind: 'SUBSTITUICAO' },
    });
    expect(change).toMatchObject({
      fromUserId: s.ids.ricardo,
      toUserId: s.ids.marcio,
      financialReviewRequired: true,
    });
    expect(change.reason).toMatch(/aprovada pelo gestor/);
    const reviews = await openReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ serviceOrderItemId: s.sofa.id, ownerChangeId: change.id });
    expect(
      await db().auditLog.count({ where: { action: 'production.piece_owner_replaced' } }),
    ).toBe(1);
    // O antigo titular não segue recebendo em silêncio: a obrigação dele fica EM REVISÃO.
    expect(await row(mo.id)).toMatchObject({
      professionalUserId: s.ids.ricardo,
      agreedCents: 80000,
    });
    const v = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(v.pieces[0].payables[0].situation).toBe('EM_REVISAO');
    expect((await pay(s.admin, mo.id, 1000).catch((e: Error) => e)) instanceof Error).toBe(true);
    // O novo titular não ganha valor inventado: nenhuma obrigação nova antes da resolução.
    expect(
      await db().productionPayable.count({ where: { professionalUserId: s.ids.marcio } }),
    ).toBe(0);
  });

  it('7. repetição da troca: mesma chave devolve o mesmo resultado; nova decisão é recusada', async () => {
    const s = await scenario(app, { arrive: ['Márcio', 'Thiago', 'João'] });
    await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    const p = await absenceProposal(s);
    const key = idemKey();
    const a = await changePrincipal(s, p, s.ids.marcio, key);
    const b = await changePrincipal(s, p, s.ids.marcio, key);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await changePrincipal(s, p, s.ids.marcio)).status).not.toBe(200);
    expect(await openReviews()).toHaveLength(1);
    expect(await db().serviceOrderItemOwnerChange.count({ where: { kind: 'SUBSTITUICAO' } })).toBe(
      1,
    );
    // Rota canônica repetida com o titular antigo (tela desatualizada): conflito, sem efeito.
    const stale = await put(s.admin, `/api/v1/service-order-items/${s.sofa.id}/upholsterer`, {
      userId: s.ids.thiago,
      expectedUserId: s.ids.ricardo,
      reason: 'Tela antiga',
      confirm: true,
    });
    expect(stale.status).toBe(409);
  });

  it('8. trocas concorrentes (rota × rota e rota × Reprogramação): uma vence, estado consistente', async () => {
    const s = await scenario(app, { arrive: ['Márcio', 'Thiago', 'João'] });
    await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    const p = await absenceProposal(s);
    const [route, resched] = await Promise.all([
      put(s.admin, `/api/v1/service-order-items/${s.sofa.id}/upholsterer`, {
        userId: s.ids.marcio,
        expectedUserId: s.ids.ricardo,
        reason: 'Troca direta',
        confirm: true,
      }),
      changePrincipal(s, p, s.ids.marcio),
    ]);
    // A segunda vê o titular já trocado (CAS) e é recusada inteira — sem efeito parcial.
    expect([route.status, resched.status].sort()).toEqual([200, 409]);
    const loser = route.status === 409 ? route : resched;
    expect(loser.body.error.message).toMatch(/titular desta peça mudou/);
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    expect(item.upholstererUserId).toBe(s.ids.marcio);
    expect(await openReviews()).toHaveLength(1);
    expect(await db().serviceOrderItemOwnerChange.count({ where: { kind: 'SUBSTITUICAO' } })).toBe(
      1,
    );
    // Duas rotas concorrentes com o mesmo titular esperado: uma vence, a outra é conflito.
    const both = await Promise.all(
      [s.ids.ricardo, s.ids.ricardo].map((userId) =>
        put(s.admin, `/api/v1/service-order-items/${s.poltronas.id}/upholsterer`, {
          userId,
          expectedUserId: s.ids.marcio,
          reason: 'Concorrência',
          confirm: true,
        }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 409].sort());
  });
});

describe('Devolução (P0-2)', () => {
  async function returnPieces(admin: Client, soItemIds: string[]) {
    const items = await db().serviceOrderItem.findMany({ where: { id: { in: soItemIds } } });
    const so = await db().serviceOrder.findUniqueOrThrow({
      where: { id: items[0]!.serviceOrderId },
    });
    const r = await post(admin, '/api/v1/returns', {
      orderId: so.orderId,
      reason: 'Cliente desistiu',
      returnDate: today(),
      destination: 'Entregue no endereço do cliente',
      lines: items.map((i) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
        serviceOrderItemIds: [i.id],
      })),
    });
    if (r.status !== 201) throw new Error(`return: ${JSON.stringify(r.body)}`);
    return r.body as { id: string; version: number };
  }
  const confirm = (admin: Client, ret: { id: string; version: number }) =>
    post(admin, `/api/v1/returns/${ret.id}/confirm`, {
      note: 'Cliente recebeu as peças',
      version: ret.version,
    });

  it('9. obrigação por peça: a peça devolvida sem execução é cancelada; a outra fica intacta; sem revisão', async () => {
    const s = await scenario(app);
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    const mar = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 45000,
    });
    expect((await confirm(s.admin, await returnPieces(s.admin, [s.poltronas.id]))).status).toBe(
      200,
    );
    expect((await row(mar.id)).status).toBe('CANCELADO');
    expect(await row(ric.id)).toMatchObject({ status: 'PREVISTO', agreedCents: 80000 });
    expect(await openReviews()).toHaveLength(0);
  });

  it('10/11. obrigação legada da OS inteira: devolução parcial abre revisão, sem desconto; repetição e concorrência', async () => {
    const s = await scenario(app, { owners: false });
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    const ret = await returnPieces(s.admin, [s.poltronas.id]);
    // Duas confirmações simultâneas da mesma devolução: só uma aplica.
    const both = await Promise.all([confirm(s.admin, ret), confirm(s.admin, ret)]);
    // A confirmação repetida devolve a mesma devolução (sem reaplicar nada).
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    // Nada foi descontado nem cancelado: o valor integral fica EM REVISÃO até a decisão.
    expect(await row(mo.id)).toMatchObject({
      status: 'PREVISTO',
      agreedCents: 80000,
      adjustmentsCents: 0,
    });
    const reviews = await openReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ serviceOrderId: s.so.id, serviceOrderItemId: null });
    expect(reviews[0]!.reason).toMatch(/Devolução parcial/);
    const v = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(v.wholeOrder[0].situation).toBe('EM_REVISAO');
    expect(
      await db().financialEvent.count({ where: { entityId: mo.id, kind: 'REVISAO_DEVOLUCAO' } }),
    ).toBe(1);
    // Pagar fica travado enquanto a revisão estiver aberta.
    const blocked = await post(s.admin, F(`/labor/${mo.id}/payments`), {
      amountCents: 1000,
      paidAt: today(),
      method: 'PIX',
      earlyReason: 'Adiantamento combinado',
      version: (await row(mo.id)).version,
    });
    expect(blocked.status).toBe(422);
    // O gestor decide na revisão (sem rateio automático): R$ 500 pela parte que ficou.
    const rv = (await s.admin.get(F(`/labor-reviews/${reviews[0]!.id}`))).body;
    const res = await post(s.admin, F(`/labor-reviews/${rv.id}/resolve`), {
      lines: [{ professionalUserId: s.ids.ricardo, amountCents: 50000 }],
      reason: 'Poltronas devolvidas: só o sofá',
      version: rv.version,
    });
    expect(res.status).toBe(200);
    expect(await row(mo.id)).toMatchObject({ agreedCents: 80000, adjustmentsCents: -30000 });
  });

  it('12. devolução total: OS cancelada; obrigação sem execução cancelada (regra existente), sem revisão', async () => {
    const s = await scenario(app, { owners: false });
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
    });
    const ret = await returnPieces(s.admin, [s.sofa.id, s.poltronas.id]);
    expect((await confirm(s.admin, ret)).status).toBe(200);
    expect((await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } })).status).toBe(
      'CANCELADA',
    );
    expect((await row(mo.id)).status).toBe('CANCELADO');
    expect(await openReviews()).toHaveLength(0);
  });
});

describe('Ajuste, pagamento e estorno (16–21)', () => {
  async function released(s: Awaited<ReturnType<typeof scenario>>, agreedCents = 100000) {
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    expect((await row(mo.id)).status).toBe('LIBERADO');
    return mo;
  }
  const payments = (id: string) =>
    db().professionalPayment.findMany({
      where: { productionPayableId: id },
      orderBy: { createdAt: 'asc' },
    });
  const reverse = async (id: string, paymentId: string, version?: number) =>
    post(s0.admin, F(`/labor/${id}/payments/${paymentId}/reverse`), {
      reason: 'Pix devolvido pelo banco',
      version: version ?? (await row(id)).version,
    });
  let s0: Awaited<ReturnType<typeof scenario>>;

  it('16/17/18/19. ajuste com motivo, pagamento parcial e total, estorno: histórico preservado', async () => {
    s0 = await scenario(app);
    const mo = await released(s0);
    const noReason = await post(s0.admin, F(`/labor/${mo.id}/adjustments`), {
      amountCents: 5000,
      version: (await row(mo.id)).version,
    });
    expect(noReason.status).toBe(400);
    expect((await adjust(s0.admin, mo.id, 5000, 'Costura extra no braço')).status).toBe(200);
    await pay(s0.admin, mo.id, 40000);
    expect((await row(mo.id)).status).toBe('PAGO_PARCIAL');
    await pay(s0.admin, mo.id, 65000);
    expect(await row(mo.id)).toMatchObject({ status: 'PAGO', paidCents: 105000 });
    const [first] = await payments(mo.id);
    expect((await reverse(mo.id, first!.id)).status).toBe(200);
    expect(await row(mo.id)).toMatchObject({ status: 'PAGO_PARCIAL', paidCents: 65000 });
    // O pagamento original permanece; o estorno é um fato próprio.
    expect(await payments(mo.id)).toHaveLength(2);
    expect(await db().professionalPaymentReversal.count()).toBe(1);
    expect(await db().financialEvent.count({ where: { entityId: mo.id, kind: 'ESTORNO' } })).toBe(
      1,
    );
  });

  it('20. estornos simultâneos do mesmo pagamento: um aplica, o outro é conflito', async () => {
    s0 = await scenario(app);
    const mo = await released(s0);
    await pay(s0.admin, mo.id, 30000);
    const [p] = await payments(mo.id);
    const v = (await row(mo.id)).version;
    const both = await Promise.all([reverse(mo.id, p!.id, v), reverse(mo.id, p!.id, v)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await row(mo.id)).toMatchObject({ paidCents: 0, status: 'LIBERADO' });
    // Repetição depois: conflito claro (já estornado), nunca um segundo estorno.
    expect((await reverse(mo.id, p!.id)).status).toBe(409);
    expect(await db().professionalPaymentReversal.count()).toBe(1);
  });

  it('21. estorno × revisão aberta: recusado (direto e pelo lote) até a revisão ser resolvida', async () => {
    s0 = await scenario(app);
    const mo = await released(s0);
    const lot = await post(s0.admin, C(WEEK, '/payments'), {
      beneficiaryUserId: s0.ids.ricardo,
      category: 'TAPECARIA',
      amountCents: 20000,
      paidAt: today(),
      method: 'PIX',
    });
    expect(lot.status, JSON.stringify(lot.body)).toBe(201);
    await setOwner(s0.admin, s0.sofa.id, s0.ids.marcio, s0.ids.ricardo, 'Ricardo afastado');
    expect(await openReviews()).toHaveLength(1);
    const [p] = await payments(mo.id);
    expect((await reverse(mo.id, p!.id)).status).toBe(422);
    const header = await db().closingPayment.findFirstOrThrow();
    const lotReverse = await post(s0.admin, F(`/closing-payments/${header.id}/reverse`), {
      reason: 'Pix devolvido',
    });
    expect(lotReverse.status).toBe(422);
    expect(await row(mo.id)).toMatchObject({ paidCents: 20000 });
    expect(await db().professionalPaymentReversal.count()).toBe(0);
  });
});

describe('Semana conferida e escopo da revisão (22–24, 39, 40)', () => {
  it('22/23. semana conferida congelada: ajuste posterior entra na semana em que foi feito', async () => {
    const s = await scenario(app);
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await releasedAt(mo.id, day(-7));
    // Semana A: R$ 1.000,00, conferida.
    const conf = await post(s.admin, C(LAST_WEEK, '/confirm'), { version: 0 });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    const snap = await db().weeklyClosing.findFirstOrThrow();
    expect(snap.dueCents).toBe(100000);
    // Semana B (atual): ajuste +R$ 200,00 referente à obrigação antiga.
    expect((await adjust(s.admin, mo.id, 20000, 'Acabamento refeito a pedido')).status).toBe(200);
    const a = (await s.admin.get(C(LAST_WEEK))).body;
    expect(a).toMatchObject({ status: 'CONFERIDO', divergent: false });
    expect(a.totals.dueCents).toBe(100000);
    const itemA = a.items.find((i: { id: string }) => i.id === mo.id);
    expect(itemA).toMatchObject({ totalDueCents: 100000, dueCents: 100000, bucket: 'WEEK' });
    expect(itemA.changes).toEqual([
      expect.objectContaining({ amountCents: 20000, afterWeek: true, kind: 'AJUSTE' }),
    ]);
    expect(itemA.notes.join(' ')).toMatch(/Mudança posterior de 200\.00/);
    // O retrato histórico não foi tocado.
    expect((await db().weeklyClosing.findFirstOrThrow()).snapshot).toEqual(snap.snapshot);
    // Semana B: saldo anterior (R$ 1.000) + o ajuste (R$ 200), rastreável e com a data real.
    const b = (await s.admin.get(C(WEEK))).body;
    const itemB = b.items.find((i: { id: string }) => i.id === mo.id);
    expect(itemB).toMatchObject({
      bucket: 'WEEK',
      dueCents: 120000,
      previousCents: 100000,
      totalDueCents: 120000,
    });
    expect(itemB.changes[0]).toMatchObject({ competence: today(), afterWeek: false });
    expect(b.totals).toMatchObject({ weekDueCents: 20000, previousOpenCents: 100000 });
    const adj = await db().financialAdjustment.findFirstOrThrow({
      where: { productionPayableId: mo.id },
    });
    expect(adj.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Relatório semanal: a liberação fica na semana A; o ajuste, na B.
    const w = (await s.admin.get(F(`/labor-weekly?from=${LAST_WEEK}&to=${today()}`))).body;
    const rel = (week: string) =>
      w.rows.find((r: { weekStart: string }) => r.weekStart === week)?.releasedCents;
    expect([rel(LAST_WEEK), rel(WEEK)]).toEqual([100000, 20000]);
    // Reabrir continua explícito, com motivo.
    expect((await post(s.admin, C(LAST_WEEK, '/reopen'), { version: 1 })).status).toBe(400);
  });

  it('24. revisão de outra semana não bloqueia; a da semana relacionada bloqueia', async () => {
    const s = await scenario(app);
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await releasedAt(mo.id, day(-7));
    await pay(s.admin, mo.id, 100000, day(-7));
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Reforma passa ao Márcio');
    expect(await openReviews()).toHaveLength(1);
    const cur = (await s.admin.get(C(WEEK))).body;
    const rvCur = cur.pendencies.find((p: { kind: string }) => p.kind === 'REVISAO_ABERTA');
    expect(rvCur.blocking).toBe(false);
    expect((await post(s.admin, C(WEEK, '/confirm'), { version: 0 })).status).toBe(200);
    const last = (await s.admin.get(C(LAST_WEEK))).body;
    expect(
      last.pendencies.find((p: { kind: string }) => p.kind === 'REVISAO_ABERTA').blocking,
    ).toBe(true);
    expect((await post(s.admin, C(LAST_WEEK, '/confirm'), { version: 0 })).status).toBe(422);
  });

  it('39. obrigação legada da OS inteira: a mesma situação na lista, no fechamento e em Meus Ganhos', async () => {
    const s = await scenario(app, { owners: false });
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      eligibility: 'QUALIDADE_APROVADA',
    });
    // Poltronas devolvidas; sofá aguardando inspeção: só as peças não devolvidas contam.
    await db().serviceOrderItem.update({
      where: { id: s.poltronas.id },
      data: { fulfillmentStage: 'DEVOLVIDA' },
    });
    await db().serviceOrderItem.update({
      where: { id: s.sofa.id },
      data: { fulfillmentStage: 'AGUARDANDO_INSPECAO' },
    });
    const list = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(list.wholeOrder[0].situation).toBe('AGUARDANDO_QUALIDADE');
    const closing = (await s.admin.get(C(WEEK))).body;
    expect(closing.items.find((i: { id: string }) => i.id === mo.id).state).toBe(
      'AGUARDANDO_QUALIDADE',
    );
    const r = s.tablets.Ricardo!;
    const u = await post(r, F('/my-earnings/unlock'), { pin: '482915' });
    const mine = await r.req('GET', F('/my-earnings'), undefined, {
      'x-earnings-unlock': u.body.unlockToken,
    });
    expect(mine.body.items.find((i: { id: string }) => i.id === mo.id).situation).toBe(
      'AGUARDANDO_LIBERACAO',
    );
  });

  it('40. pagamento em lote continua funcionando sem confirmação do profissional (D13 fora)', async () => {
    const s = await scenario(app);
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    expect((await s.admin.get(C(WEEK))).body.status).toBe('ABERTO');
    const lot = await post(s.admin, C(WEEK, '/payments'), {
      beneficiaryUserId: s.ids.ricardo,
      category: 'TAPECARIA',
      amountCents: 80000,
      paidAt: today(),
      method: 'PIX',
    });
    expect(lot.status, JSON.stringify(lot.body)).toBe(201);
    expect(await row(mo.id)).toMatchObject({ status: 'PAGO', paidCents: 80000 });
  });
});
