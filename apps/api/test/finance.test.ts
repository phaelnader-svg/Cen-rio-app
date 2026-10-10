import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createOrder, createPickup, panelUserWith } from './commercial-helpers';
import { grant, openServiceOrder } from './measurement-helpers';
import {
  act,
  addOs,
  createPlan,
  day,
  publish,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  receive,
  staples,
} from './purchasing-helpers';

/**
 * Fase 11 — financeiro operacional, custos por OS, pagamentos por produção e indicadores.
 * Dados fictícios. Valores em centavos. Pedido de teste: R$ 3.500,00 (sofá + 2 poltronas).
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';
const setClock = (hhmm: string) => setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));

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
  await db().companySettings.update({
    where: { id: 1 },
    data: {
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      arrivalWindowStart: '07:00',
      workdayStart: '08:30',
      arrivalAlertAt: '09:30',
      workdayEnd: '18:00',
      lateAlertMinutes: 15,
    },
  });
  setClock('08:00');
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
};
const F = (path: string) => `/api/v1/finance${path}`;
const post = (c: Client, path: string, body: Record<string, unknown> = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const orderIdOf = async (soId: string) =>
  (await db().serviceOrder.findUniqueOrThrow({ where: { id: soId } })).orderId;
const setStage = (itemId: string, stage: string) =>
  db().serviceOrderItem.update({ where: { id: itemId }, data: { fulfillmentStage: stage } });
const result = async (c: Client, soId: string) => {
  const r = await c.get(F(`/service-orders/${soId}`));
  if (r.status !== 200) throw new Error(`result: ${JSON.stringify(r.body)}`);
  return r.body;
};
const month = () => today().slice(0, 7);

async function receivable(admin: Client, orderId: string, amountCents: number, key = idemKey()) {
  return post(
    admin,
    F('/receivables'),
    {
      orderId,
      description: 'Entrada (50%)',
      amountCents,
      dueDate: today(),
      expectedMethod: 'PIX',
    },
    key,
  );
}

async function labor(admin: Client, body: Record<string, unknown>, key = idemKey()) {
  return post(
    admin,
    F('/labor'),
    { service: 'Reforma completa do sofá', agreedCents: 80000, ...body },
    key,
  );
}

/** OS publicada: sofá → Ricardo, poltronas → Márcio; todos chegaram; relógio às 09:00. */
async function scenario(
  makeSo: (admin: Client) => Promise<Awaited<ReturnType<typeof openServiceOrder>>> = (admin) =>
    openServiceOrder(admin, 'Cliente Financeiro'),
) {
  const admin = await loginAdmin(app);
  const so = await makeSo(admin);
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
  };
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: ids.ricardo,
      date: day(-1),
    })
  ).body as { tasks: { id: string }[] };
  for (const t of added.tasks)
    await post(admin, `/api/v1/production-tasks/${t.id}/cancel`, { reason: 'Fora do teste' });
  const task = async (body: Record<string, unknown>) => {
    const r = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      date: day(-1),
      time: '08:00',
      ...body,
    });
    if (r.status !== 201) throw new Error(`task: ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  };
  const sofa = so.items[0]!;
  const poltronas = so.items[1]!;
  const sofaTask = await task({
    activity: 'REVESTIMENTO',
    title: 'Revestimento do sofá',
    serviceOrderItemId: sofa.id,
    role: 'PRINCIPAL',
    assigneeUserId: ids.ricardo,
  });
  const poltronaTask = await task({
    activity: 'ACABAMENTO',
    title: 'Acabamento das poltronas',
    serviceOrderItemId: poltronas.id,
    role: 'PRINCIPAL',
    assigneeUserId: ids.marcio,
  });
  await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'Márcio', 'Thiago'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  setClock('08:30');
  for (const name of Object.keys(tablets)) {
    const r = await post(tablets[name]!, '/api/v1/attendance/me/arrive');
    if (r.status !== 200) throw new Error(`arrive: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  return { admin, so, sofa, poltronas, ids, tablets, sofaTask, poltronaTask };
}

async function finish(c: Client, taskId: string) {
  const s = await act(c, taskId, 'start');
  if (s.status !== 200) throw new Error(`start: ${JSON.stringify(s.body)}`);
  const r = await act(c, taskId, 'complete', { note: 'Serviço concluído' });
  if (r.status !== 200) throw new Error(`complete: ${JSON.stringify(r.body)}`);
}

/** Thiago aprova a inspeção aberta da peça (checklist todo conforme). */
async function approveInspection(thiago: Client, itemId: string) {
  const open = await db().qualityInspection.findFirstOrThrow({
    where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
  });
  let i = (await thiago.get(`/api/v1/quality/inspections/${open.id}`)).body;
  for (const it of i.items) {
    const r = await thiago.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
      result: 'OK',
      note: null,
    });
    if (r.status !== 200) throw new Error(`check: ${JSON.stringify(r.body)}`);
  }
  i = (await thiago.get(`/api/v1/quality/inspections/${open.id}`)).body;
  const r = await post(thiago, `/api/v1/quality/inspections/${i.id}/approve`, {
    version: i.version,
  });
  if (r.status !== 200) throw new Error(`approve: ${JSON.stringify(r.body)}`);
}

// ───────────────────────────────────────────────────────────────────────────

describe('Receita e recebimentos', () => {
  it('1. receita por OS: reaproveita o valor negociado do pedido, situação e rateio entre OS', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Receita');
    const orderId = await orderIdOf(so.id);
    const r = (await admin.get(F(`/orders/${orderId}`))).body;
    expect(r).toMatchObject({
      contractedCents: 350000,
      adjustmentsCents: 0,
      finalCents: 350000,
      billedCents: 0,
      receivedCents: 0,
      openCents: 350000,
      financialStatus: 'SEM_COBRANCA',
    });
    expect(r.serviceOrders).toEqual([
      { id: so.id, code: so.code, revenueCents: 350000, manual: false },
    ]);
    // O resultado da OS usa a mesma receita (nada é digitado de novo).
    expect((await result(admin, so.id)).revenueCents).toBe(350000);
    // Rateio manual precisa somar o valor final.
    const bad = await admin.put(F(`/orders/${orderId}/revenue-split`), {
      shares: [{ serviceOrderId: so.id, revenueCents: 1000 }],
      reason: 'Teste de rateio',
    });
    expect(bad.status).toBe(422);
    const good = await admin.put(F(`/orders/${orderId}/revenue-split`), {
      shares: [{ serviceOrderId: so.id, revenueCents: 350000 }],
      reason: 'Uma OS só',
    });
    expect(good.status).toBe(200);
    expect(good.body.serviceOrders[0]).toMatchObject({ revenueCents: 350000, manual: true });
    // Pedido sem valor contratado: sem receita e situação "sem valor".
    await db().commercialOrder.update({ where: { id: orderId }, data: { agreedValueCents: null } });
    const none = (await admin.get(F(`/orders/${orderId}`))).body;
    expect(none).toMatchObject({ finalCents: null, financialStatus: 'SEM_VALOR' });
    expect((await result(admin, so.id)).warnings.join(' ')).toMatch(
      /sem valor contratado|não tem valor/,
    );
  });

  it('2. ajuste comercial: só com permissão específica, motivo, auditoria e histórico imutável', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Ajuste');
    const orderId = await orderIdOf(so.id);
    const viewer = await panelUserWith(app, admin, 'fin-leitura', ['financeiro.ver']);
    const denied = await post(viewer, F(`/orders/${orderId}/adjustments`), {
      kind: 'DESCONTO',
      amountCents: 20000,
      reason: 'Cliente antigo',
    });
    expect(denied.status).toBe(403);
    const noReason = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'DESCONTO',
      amountCents: 20000,
      reason: '',
    });
    expect(noReason.status).toBe(400);
    const d = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'DESCONTO',
      amountCents: 20000,
      reason: 'Cliente antigo',
    });
    expect(d.status).toBe(200);
    const a = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'ACRESCIMO',
      amountCents: 5000,
      reason: 'Pés torneados adicionais',
    });
    expect(a.body).toMatchObject({ adjustmentsCents: -15000, finalCents: 335000 });
    expect(
      a.body.adjustments.map((x: { kind: string; amountCents: number }) => [x.kind, x.amountCents]),
    ).toEqual([
      ['DESCONTO', -20000],
      ['ACRESCIMO', 5000],
    ]);
    expect((await result(admin, so.id)).revenueCents).toBe(335000);
    expect(await db().auditLog.count({ where: { action: 'finance.commercial_adjustment' } })).toBe(
      2,
    );
    // Histórico imutável.
    await expect(
      db().commercialAdjustment.updateMany({ where: { orderId }, data: { amountCents: 1 } }),
    ).rejects.toThrow();
    // Desconto que deixaria o valor final abaixo do já recebido é recusado.
    const rc = await receivable(admin, orderId, 300000);
    await post(admin, F(`/receivables/${rc.body.id}/payments`), {
      amountCents: 300000,
      receivedAt: today(),
      method: 'PIX',
      version: rc.body.version,
    });
    const tooMuch = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'DESCONTO',
      amountCents: 50000,
      reason: 'Desconto grande',
    });
    expect(tooMuch.status).toBe(422);
  });

  it('3. recebimento parcial: saldo, situação e nunca acima do valor; cobrança limitada ao valor final', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Parcial');
    const orderId = await orderIdOf(so.id);
    const over = await receivable(admin, orderId, 350001);
    expect(over.status).toBe(422);
    const rc = await receivable(admin, orderId, 175000);
    expect(rc.status).toBe(201);
    expect(rc.body).toMatchObject({ code: 'RC-00001', status: 'ABERTO', openCents: 175000 });
    const p1 = await post(admin, F(`/receivables/${rc.body.id}/payments`), {
      amountCents: 50000,
      receivedAt: today(),
      method: 'PIX',
      version: rc.body.version,
    });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ status: 'PARCIAL', receivedCents: 50000, openCents: 125000 });
    const overpay = await post(admin, F(`/receivables/${rc.body.id}/payments`), {
      amountCents: 125001,
      receivedAt: today(),
      method: 'PIX',
      version: p1.body.version,
    });
    expect(overpay.status).toBe(422);
    const p2 = await post(admin, F(`/receivables/${rc.body.id}/payments`), {
      amountCents: 125000,
      receivedAt: today(),
      method: 'DINHEIRO',
      version: p1.body.version,
    });
    expect(p2.body).toMatchObject({ status: 'RECEBIDO', receivedCents: 175000, openCents: 0 });
    expect(p2.body.payments).toHaveLength(2);
    const order = (await admin.get(F(`/orders/${orderId}`))).body;
    expect(order).toMatchObject({
      billedCents: 175000,
      receivedCents: 175000,
      openCents: 175000,
      financialStatus: 'PARCIAL',
    });
    // Recebido não pode ser cancelado.
    const cancel = await post(admin, F(`/receivables/${rc.body.id}/cancel`), {
      reason: 'Engano',
      version: p2.body.version,
    });
    expect(cancel.status).toBe(422);
  });

  it('4. recebimento duplicado: mesma chave não duplica; versão antiga é recusada; estorno único', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Duplicado');
    const rc = (await receivable(admin, await orderIdOf(so.id), 100000)).body;
    const key = idemKey();
    const body = { amountCents: 40000, receivedAt: today(), method: 'PIX', version: rc.version };
    const a = await post(admin, F(`/receivables/${rc.id}/payments`), body, key);
    const b = await post(admin, F(`/receivables/${rc.id}/payments`), body, key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(await db().customerPayment.count()).toBe(1);
    // Mesmo pagamento com outra chave, mas versão antiga: conflito (não duplica).
    const stale = await post(admin, F(`/receivables/${rc.id}/payments`), body);
    expect(stale.status).toBe(409);
    expect(await db().customerPayment.count()).toBe(1);
    // Estorno: uma única vez, gera linha negativa e reabre o saldo.
    const payId = a.body.payments[0].id;
    const rev = await post(admin, F(`/receivables/${rc.id}/payments/${payId}/reverse`), {
      reason: 'PIX devolvido pelo banco',
    });
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ status: 'ABERTO', receivedCents: 0 });
    const again = await post(admin, F(`/receivables/${rc.id}/payments/${payId}/reverse`), {
      reason: 'De novo',
    });
    expect([409, 422]).toContain(again.status);
    const rows = await db().customerPayment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.amountCents)).toEqual([40000, -40000]);
    await expect(db().customerPayment.deleteMany()).rejects.toThrow();
  });
});

describe('Custos de material', () => {
  it('5. material consumido: compra exclusiva recebida entra uma vez; comprado ≠ consumido', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Material', (s) => [
      linen(s.items[0].id),
    ]);
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!, 4500);
    let r = await result(admin, so.id);
    // Comprado (pedido confirmado) mas ainda não recebido: não é custo consumido.
    expect(r.materials).toMatchObject({
      purchasedCents: 54000,
      consumedCents: 0,
      forecastCents: 54000,
    });
    expect(r.actual.materialsCents).toBe(0);
    expect(r.forecast.materialsCents).toBe(54000);
    const rec = await receive(admin, po.id, [ok(po.items[0].id, 8)]);
    expect(rec.status).toBe(201);
    r = await result(admin, so.id);
    expect(r.materials).toMatchObject({ purchasedCents: 54000, consumedCents: 36000 });
    // Reabrir o resultado não duplica os lançamentos (chave de origem única).
    r = await result(admin, so.id);
    expect(r.materials.consumedCents).toBe(36000);
    expect(r.materials.lines).toHaveLength(1);
    expect(r.materials.lines[0]).toMatchObject({
      source: 'COMPRA_EXCLUSIVA',
      quantity: 8,
      unitCostCents: 4500,
    });
    expect(await db().serviceOrderCost.count()).toBe(1);
    await expect(db().serviceOrderCost.updateMany({ data: { amountCents: 0 } })).rejects.toThrow();
  });

  it('6. reserva sem consumo não é custo; saída e devolução ao estoque ajustam o custo da OS', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Estoque', () => [staples()]);
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      expectedDate: '2030-01-10',
      items: [
        {
          sourcing: 'ESTOQUE',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 2 }],
          quantity: 6,
          unitPriceCents: 1890,
        },
      ],
    });
    const c = await confirmPurchase(admin, po.body);
    // A compra do estoque comum não vira custo da OS.
    await receive(admin, c.body.id, [ok(c.body.items[0].id, 6)]);
    let r = await result(admin, so.id);
    expect(r.materials).toMatchObject({ purchasedCents: 0, reservedCents: 3780, consumedCents: 0 });
    expect(r.actual.materialsCents).toBe(0);
    // Entrega do reservado à OS (saída): custo médio × quantidade.
    const resv = await db().stockReservation.findFirstOrThrow({ where: { serviceOrderId: so.id } });
    const consumed = await post(admin, `/api/v1/stock-reservations/${resv.id}/consume`);
    expect(consumed.status).toBe(200);
    r = await result(admin, so.id);
    expect(r.materials).toMatchObject({ reservedCents: 0, consumedCents: 3780 });
    // Devolução de 1 ao estoque: sai do custo da OS; nunca mais do que saiu.
    const stock = await db().stockItem.findFirstOrThrow();
    const tooMuch = await post(admin, `/api/v1/stock-items/${stock.id}/adjust`, {
      quantity: 3,
      reason: 'Sobrou na OS',
      serviceOrderId: so.id,
    });
    expect(tooMuch.status).toBe(422);
    const back = await post(admin, `/api/v1/stock-items/${stock.id}/adjust`, {
      quantity: 1,
      reason: 'Sobrou na OS',
      serviceOrderId: so.id,
    });
    expect(back.status).toBe(200);
    r = await result(admin, so.id);
    expect(r.materials.consumedCents).toBe(1890);
    expect(r.materials.lines.map((l: { source: string }) => l.source)).toEqual([
      'SAIDA_ESTOQUE',
      'DEVOLUCAO_ESTOQUE',
    ]);
  });

  it('7. sobra transferida: o custo sai da OS de origem e entra na de destino, sem duplicar', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await approvedNeeds(admin, 'Cliente Origem', (s) => [linen(s.items[0].id)]);
    const b = await openServiceOrder(admin, 'Cliente Destino');
    const po = await confirmedFabricPurchase(admin, supplier.id, a.reqs[0]!, 4500);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    const leftover = await admin.post('/api/v1/material-leftovers', {
      serviceOrderId: a.so.id,
      kind: 'TECIDO',
      description: 'Linho',
      color: 'Bege',
      quantity: 3,
      unit: 'METRO',
      location: 'Prateleira 3',
      condition: 'BOA',
      reusable: true,
    });
    expect(leftover.status).toBe(201);
    // Registrar a sobra não muda custo (o material continua da OS de origem).
    expect((await result(admin, a.so.id)).materials.consumedCents).toBe(54000);
    const t = await post(admin, `/api/v1/material-leftovers/${leftover.body.id}/transfer`, {
      targetServiceOrderId: b.id,
      quantity: 2,
      reason: 'Aproveitar na almofada',
    });
    expect(t.status).toBe(200);
    const ra = await result(admin, a.so.id);
    const rb = await result(admin, b.id);
    expect(ra.materials.consumedCents).toBe(54000 - 9000);
    expect(rb.materials.consumedCents).toBe(9000);
    expect(ra.materials.consumedCents + rb.materials.consumedCents).toBe(54000);
    expect(rb.materials.lines[0]).toMatchObject({ source: 'SOBRA_ENTRADA', unitCostCents: 4500 });
  });
});

describe('Mão de obra por produção', () => {
  it('8. concluir a tarefa não paga: o valor só é liberado na condição definida; um tapeceiro por peça', async () => {
    const s = await scenario();
    const created = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      eligibility: 'QUALIDADE_APROVADA',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      code: 'MO-00001',
      status: 'PREVISTO',
      dueCents: 80000,
      eligible: false,
    });
    // Equipe fixa (João) não recebe por produção.
    const joao = await labor(s.admin, {
      professionalUserId: s.ids.joao,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
    });
    expect(joao.status).toBe(422);
    // Nunca dividir automaticamente: a mesma peça não tem outro tapeceiro (nem a OS inteira).
    const marcioSofa = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    expect(marcioSofa.status).toBe(409);
    const whole = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
    });
    expect(whole.status).toBe(409);
    const marcio = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      service: 'Troca de tecido das poltronas',
      agreedCents: 45000,
    });
    expect(marcio.status).toBe(201);

    // Ricardo conclui no tablet (duas vezes): continua PREVISTO e sem pagamento.
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'De novo' });
    let mo = (await s.admin.get(F(`/labor/${created.body.id}`))).body;
    expect(mo).toMatchObject({ status: 'PREVISTO', eligible: false, paidCents: 0 });
    expect(await db().professionalPayment.count()).toBe(0);
    const early = await post(s.admin, F(`/labor/${mo.id}/payments`), {
      amountCents: 80000,
      paidAt: today(),
      method: 'PIX',
      version: mo.version,
    });
    expect(early.status).toBe(422);

    // Inspeção aprovada pelo Thiago → liberado (uma vez só).
    await approveInspection(s.tablets.Thiago!, s.sofa.id);
    mo = (await s.admin.get(F(`/labor/${created.body.id}`))).body;
    expect(mo).toMatchObject({ status: 'LIBERADO', eligible: true });
    expect(mo.eligibleAt).not.toBeNull();
    const paid = await post(s.admin, F(`/labor/${mo.id}/payments`), {
      amountCents: 80000,
      paidAt: today(),
      method: 'PIX',
      version: mo.version,
    });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAGO', paidCents: 80000, openCents: 0 });
    expect(paid.body.history.map((h: { kind: string }) => h.kind)).toEqual(
      expect.arrayContaining(['COMBINADO', 'LIBERADO', 'PAGAMENTO']),
    );
    // Valor do Márcio continua previsto (poltronas não concluídas).
    expect((await s.admin.get(F(`/labor/${marcio.body.id}`))).body.status).toBe('PREVISTO');
  });

  it('9. ajuste autorizado do valor de produção: permissão, motivo, histórico e nunca abaixo do pago', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    const manager = await panelUserWith(app, s.admin, 'fin-operador', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    const denied = await post(manager, F(`/labor/${mo.id}/adjustments`), {
      amountCents: 10000,
      reason: 'Costura extra',
      version: mo.version,
    });
    expect(denied.status).toBe(403);
    const adj = await post(s.admin, F(`/labor/${mo.id}/adjustments`), {
      amountCents: 10000,
      reason: 'Costura extra nos braços',
      version: mo.version,
    });
    expect(adj.status).toBe(200);
    expect(adj.body).toMatchObject({
      agreedCents: 80000,
      adjustmentsCents: 10000,
      dueCents: 90000,
    });
    expect(adj.body.adjustments[0]).toMatchObject({
      amountCents: 10000,
      reason: 'Costura extra nos braços',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    let cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    expect(cur.status).toBe('LIBERADO');
    const part = await post(manager, F(`/labor/${mo.id}/payments`), {
      amountCents: 60000,
      paidAt: today(),
      method: 'DINHEIRO',
      version: cur.version,
    });
    expect(part.body).toMatchObject({ status: 'PAGO_PARCIAL', paidCents: 60000, openCents: 30000 });
    cur = part.body;
    const below = await post(s.admin, F(`/labor/${mo.id}/adjustments`), {
      amountCents: -40000,
      reason: 'Redução indevida',
      version: cur.version,
    });
    expect(below.status).toBe(422);
    expect(await db().auditLog.count({ where: { action: 'finance.labor_adjusted' } })).toBe(1);
    await expect(db().financialAdjustment.deleteMany()).rejects.toThrow();
  });

  it('10. pagamento duplicado: mesma chave não repete, valor acima do devido é recusado', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    const key = idemKey();
    const body = { amountCents: 80000, paidAt: today(), method: 'PIX', version: cur.version };
    const a = await post(s.admin, F(`/labor/${mo.id}/payments`), body, key);
    const b = await post(s.admin, F(`/labor/${mo.id}/payments`), body, key);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const again = await post(s.admin, F(`/labor/${mo.id}/payments`), {
      ...body,
      amountCents: 1,
      version: a.body.version,
    });
    expect(again.status).toBe(422);
    expect(await db().professionalPayment.count()).toBe(1);
    // Pago não pode ser cancelado.
    const cancel = await post(s.admin, F(`/labor/${mo.id}/cancel`), {
      reason: 'Engano',
      version: a.body.version,
    });
    expect(cancel.status).toBe(422);
  });
});

describe('Logística, equipe fixa e despesas', () => {
  it('11. custo logístico ligado à OS, com conta a pagar, sem lançar duas vezes a mesma viagem', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Frete');
    // Retirada de outro pedido do mesmo cliente (ainda não recebido), atendida na mesma viagem.
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }))
      .customerId;
    const customer = (await admin.get(`/api/v1/customers/${customerId}`)).body;
    const pickup = await createPickup(admin, await createOrder(admin, customer));
    // Evolução Fase 6: retirada de viagem cadastrada não é lançamento avulso (fonte única).
    const manual = await post(admin, F('/logistics-costs'), {
      kind: 'RETIRADA',
      description: 'Retirada com van terceirizada',
      amountCents: 12000,
      date: today(),
      pickupId: pickup.id,
      beneficiary: 'Transportes Exemplo',
      splitMethod: 'IGUAL',
      allocations: [{ serviceOrderId: so.id }],
      payableDueDate: day(7),
    });
    expect(manual.status).toBe(422);
    const andre = (await db().user.findFirstOrThrow({ where: { displayName: 'André' } })).id;
    await admin.req(
      'PUT',
      F('/logistics-defaults'),
      { defaultPickupCostCents: null, defaultDeliveryCostCents: null, logisticsPayeeUserId: andre },
      { 'idempotency-key': idemKey() },
    );
    const body = { pickupId: pickup.id, amountCents: 12000, serviceOrderIds: [so.id] };
    const c = await admin.req('PUT', F('/trip-costs'), body, { 'idempotency-key': idemKey() });
    expect(c.status).toBe(200);
    expect(c.body.cost).toMatchObject({ code: 'LG-00001', amountCents: 12000, payable: null });
    expect(c.body.cost.allocations).toEqual([
      { serviceOrderId: so.id, code: so.code, amountCents: 12000 },
    ]);
    // Combinado ≠ realizado; a obrigação nasce na realização (uma vez).
    expect((await result(admin, so.id)).actual.logisticsCents).toBe(0);
    for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
      const cur = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
      await post(admin, `/api/v1/pickups/${pickup.id}/transition`, {
        toStatus,
        version: cur.version,
      });
    }
    const cost = (await admin.get(F(`/trip-costs?pickupId=${pickup.id}`))).body.cost;
    expect(cost.payable).toMatchObject({ status: 'ABERTO' });
    const dup = await admin.req(
      'PUT',
      F('/trip-costs'),
      { ...body, reason: 'Repetido', version: cost.version },
      { 'idempotency-key': idemKey() },
    );
    expect(dup.status).toBe(422);
    const payable = (await admin.get(F(`/payables/${cost.payable.id}`))).body;
    expect(payable).toMatchObject({
      category: 'LOGISTICA',
      amountCents: 12000,
      beneficiary: 'André',
      origin: { kind: 'LOGISTICA' },
    });
    expect((await result(admin, so.id)).actual.logisticsCents).toBe(12000);
    // Pagamento registrado (sem transferência) e comprovante opcional.
    const paid = await post(admin, F(`/payables/${payable.id}/payments`), {
      amountCents: 12000,
      paidAt: today(),
      method: 'PIX',
      version: payable.version,
    });
    expect(paid.body).toMatchObject({ status: 'PAGO', paidCents: 12000 });
  });

  it('12. rateio de uma viagem entre OS: soma exata, nada contado duas vezes', async () => {
    const admin = await loginAdmin(app);
    const a = await openServiceOrder(admin, 'Cliente Rota A');
    const b = await openServiceOrder(admin, 'Cliente Rota B');
    const manualBad = await post(admin, F('/logistics-costs'), {
      kind: 'ENTREGA',
      description: 'Entrega na zona sul',
      amountCents: 10001,
      date: today(),
      splitMethod: 'MANUAL',
      allocations: [
        { serviceOrderId: a.id, amountCents: 5000 },
        { serviceOrderId: b.id, amountCents: 5000 },
      ],
    });
    expect(manualBad.status).toBe(400);
    const same = await post(admin, F('/logistics-costs'), {
      kind: 'ENTREGA',
      description: 'Entrega na zona sul',
      amountCents: 10001,
      date: today(),
      splitMethod: 'IGUAL',
      allocations: [{ serviceOrderId: a.id }, { serviceOrderId: a.id }],
    });
    expect(same.status).toBe(400);
    const c = await post(admin, F('/logistics-costs'), {
      kind: 'ENTREGA',
      description: 'Entrega na zona sul',
      amountCents: 10001,
      date: today(),
      splitMethod: 'IGUAL',
      splitNote: 'Mesma viagem, dois clientes',
      allocations: [{ serviceOrderId: a.id }, { serviceOrderId: b.id }],
    });
    expect(c.status).toBe(201);
    const ra = await result(admin, a.id);
    const rb = await result(admin, b.id);
    expect(ra.actual.logisticsCents + rb.actual.logisticsCents).toBe(10001);
    expect([ra.actual.logisticsCents, rb.actual.logisticsCents].sort()).toEqual([5000, 5001]);
    // Cancelar o custo tira das duas OS.
    await post(admin, F(`/logistics-costs/${c.body.id}/cancel`), {
      reason: 'Lançado errado',
      version: c.body.version,
    });
    expect((await result(admin, a.id)).actual.logisticsCents).toBe(0);
    expect(await db().logisticsCostAllocation.count()).toBe(2);
  });

  it('13. despesas recorrentes: geração mensal idempotente, conta a pagar e categoria', async () => {
    const admin = await loginAdmin(app);
    const rec = await post(admin, F('/recurring-expenses'), {
      category: 'ALUGUEL',
      description: 'Aluguel do galpão',
      amountCents: 250000,
      dayOfMonth: 31,
      beneficiary: 'Imobiliária Exemplo',
      startMonth: '2026-01',
    });
    expect(rec.status).toBe(201);
    await post(admin, F('/recurring-expenses'), {
      category: 'INTERNET',
      description: 'Internet fibra',
      amountCents: 15000,
      dayOfMonth: 5,
      beneficiary: 'Provedor Exemplo',
      startMonth: '2026-03',
      endMonth: '2026-03',
    });
    const g1 = await post(admin, F('/recurring-expenses/generate'), { month: '2026-02' });
    expect(g1.body).toEqual({ created: 1, templates: 1 });
    // Concorrência: duas gerações simultâneas do mesmo mês criam uma vez só.
    const [x, y] = await Promise.all([
      post(admin, F('/recurring-expenses/generate'), { month: '2026-03' }),
      post(admin, F('/recurring-expenses/generate'), { month: '2026-03' }),
    ]);
    expect(x.body.created + y.body.created).toBe(2);
    const again = await post(admin, F('/recurring-expenses/generate'), { month: '2026-03' });
    expect(again.body.created).toBe(0);
    const list = (await admin.get(F('/expenses?from=2026-02-01&to=2026-03-31'))).body;
    expect(list).toHaveLength(3);
    const feb = list.find((e: { competence: string }) => e.competence === '2026-02');
    // Dia 31 em fevereiro → último dia do mês.
    expect(feb.payable).toMatchObject({ status: 'ABERTO', dueDate: '2026-02-28' });
    expect(feb.recurring).toBe(true);
    // Alterar o modelo não altera despesas já geradas.
    await admin.put(F(`/recurring-expenses/${rec.body.id}`), {
      ...rec.body,
      amountCents: 260000,
    });
    const after = (await admin.get(F('/expenses?from=2026-02-01&to=2026-02-28'))).body;
    expect(after[0].amountCents).toBe(250000);
    // Equipe fixa: custo mensal, não é pagamento por produção.
    const team = await admin.put(F('/team-costs'), {
      userId: await userIdOf('João'),
      month: '2026-02',
      amountCents: 300000,
    });
    expect(team.status).toBe(200);
    expect(await db().productionPayable.count()).toBe(0);
    const csv = await admin.get(F('/reports/despesas?from=2026-02-01&to=2026-03-31&format=csv'));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(String(csv.body)).toContain('Aluguel do galpão');
    expect(String(csv.body)).toContain('2500,00');
  });
});

describe('Resultado, painel e indicadores', () => {
  it('14. margem de contribuição: previsto × realizado, tributo estimado, sem confundir com lucro', async () => {
    let req: { id: string; quantity: unknown } | undefined;
    const s = await scenario(async (admin) => {
      const n = await approvedNeeds(admin, 'Cliente Margem', (so) => [linen(so.items[0].id)]);
      req = n.reqs[0]!;
      return n.so;
    });
    await s.admin.put(F('/settings'), { taxRateBps: 600 });
    const supplier = await createSupplier(s.admin);
    const po = await confirmedFabricPurchase(s.admin, supplier.id, req!, 4500);
    await receive(s.admin, po.id, [ok(po.items[0].id, 12)]);
    await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      service: 'Troca de tecido das poltronas',
      agreedCents: 45000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await post(s.admin, F('/logistics-costs'), {
      kind: 'ENTREGA',
      description: 'Entrega',
      amountCents: 12000,
      date: today(),
      splitMethod: 'IGUAL',
      allocations: [{ serviceOrderId: s.so.id }],
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const r = await result(s.admin, s.so.id);
    expect(r.revenueCents).toBe(350000);
    expect(r.taxRateBps).toBe(600);
    // Previsto: toda a mão de obra combinada.
    expect(r.forecast).toMatchObject({
      materialsCents: 54000,
      laborCents: 125000,
      logisticsCents: 12000,
      taxCents: 21000,
      marginCents: 350000 - 54000 - 125000 - 12000 - 21000,
    });
    // Realizado: só a mão de obra já liberada (Ricardo).
    expect(r.actual).toMatchObject({
      materialsCents: 54000,
      laborCents: 80000,
      variableCostsCents: 54000 + 80000 + 12000 + 21000,
      marginCents: 350000 - 167000,
    });
    expect(r.actual.marginPct).toBeCloseTo(52.3, 1);
    // Outro custo variável lançado manualmente (com justificativa e auditoria).
    const extra = await post(s.admin, F('/costs'), {
      serviceOrderId: s.so.id,
      category: 'OUTRO_VARIAVEL',
      description: 'Taxa da maquininha',
      amountCents: 7000,
      reason: 'Cobrança no cartão',
    });
    expect(extra.status).toBe(201);
    expect(extra.body.actual.otherVariableCents).toBe(7000);
    expect(extra.body.actual.marginCents).toBe(350000 - 167000 - 7000);
    expect(await db().auditLog.count({ where: { action: 'finance.cost_adjusted' } })).toBe(1);
  });

  it('15. painel financeiro e resultado gerencial: competência × caixa, despesas e equipe fixa', async () => {
    const admin = await loginAdmin(app);
    await admin.put(F('/settings'), { taxRateBps: 600 });
    const so = await openServiceOrder(admin, 'Cliente Painel');
    const orderId = await orderIdOf(so.id);
    const rc = (await receivable(admin, orderId, 175000)).body;
    await post(admin, F(`/receivables/${rc.id}/payments`), {
      amountCents: 175000,
      receivedAt: today(),
      method: 'PIX',
      version: rc.version,
    });
    await post(admin, F('/expenses'), {
      category: 'ENERGIA',
      description: 'Energia elétrica',
      amountCents: 40000,
      competence: month(),
      dueDate: today(),
      beneficiary: 'Distribuidora Exemplo',
    });
    await admin.put(F('/team-costs'), {
      userId: await userIdOf('João'),
      month: month(),
      amountCents: 300000,
    });
    let d = (await admin.get(F('/dashboard'))).body;
    expect(d.accrual).toMatchObject({
      contractedCents: 350000,
      completedOrders: 0,
      contributionMarginCents: 0,
    });
    expect(d.inProgress).toMatchObject({ orders: 1, revenueCents: 350000 });
    expect(d.cash).toMatchObject({ receivedCents: 175000, paidPayablesCents: 0, netCents: 175000 });
    expect(d.open).toMatchObject({ receivableCents: 0, payableCents: 40000 });
    // Todas as peças entregues → OS concluída no período (margem realizada).
    for (const it of so.items) await setStage(it.id, 'ENTREGUE');
    d = (await admin.get(F('/dashboard'))).body;
    const margin = 350000 - 21000;
    expect(d.accrual).toMatchObject({
      completedOrders: 1,
      revenueCompletedCents: 350000,
      contributionMarginCents: margin,
      operationalExpensesCents: 40000,
      fixedTeamCents: 300000,
      managementResultCents: margin - 40000 - 300000,
    });
    expect(d.expensesByCategory).toEqual([{ category: 'ENERGIA', amountCents: 40000 }]);
    expect(d.topServices[0]).toMatchObject({ serviceType: 'TROCA_DE_TECIDO', orders: 1 });
    expect(d.notes.join(' ')).toMatch(/não é lucro líquido/);
    // Período sem movimento.
    const empty = (await admin.get(F('/dashboard?from=2020-01-01&to=2020-01-31'))).body;
    expect(empty.accrual.contractedCents).toBe(0);
    expect(empty.cash.receivedCents).toBe(0);
    // Relatórios em JSON e CSV.
    for (const kind of [
      'resultado-os',
      'receita',
      'custos',
      'producao',
      'despesas',
      'margens',
      'produtividade',
      'retrabalhos',
      'servicos-rentaveis',
    ]) {
      const j = await admin.get(F(`/reports/${kind}`));
      expect(j.status, kind).toBe(200);
      expect(j.body.header.length).toBeGreaterThan(0);
      const c = await admin.get(F(`/reports/${kind}?format=csv`));
      expect(c.status, kind).toBe(200);
      expect(c.headers['content-disposition']).toContain(`${kind}-`);
    }
    const margens = (await admin.get(F('/reports/margens'))).body;
    expect(margens.rows).toHaveLength(1);
    expect(margens.rows[0][0]).toBe(so.code);
  });

  it('16. produtividade: tempos, prazos, impedimentos separados e sem ranking', async () => {
    const s = await scenario();
    // Ricardo tem prazo até hoje; a tarefa do Márcio era para ontem (dia programado).
    await db().productionTask.update({
      where: { id: s.sofaTask.id },
      data: { dueDate: new Date(`${today()}T00:00:00Z`) },
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    // Márcio pausa por impedimento, retoma e conclui.
    expect((await act(s.tablets['Márcio']!, s.poltronaTask.id, 'start')).status).toBe(200);
    const pause = await act(s.tablets['Márcio']!, s.poltronaTask.id, 'pause', {
      reason: 'OUTRO',
      impediment: true,
      note: 'Faltou grampo',
    });
    expect(pause.status).toBe(200);
    expect((await act(s.tablets['Márcio']!, s.poltronaTask.id, 'resume')).status).toBe(200);
    expect(
      (await act(s.tablets['Márcio']!, s.poltronaTask.id, 'complete', { note: 'Pronto' })).status,
    ).toBe(200);
    const p = (await s.admin.get(F('/productivity'))).body;
    const ricardo = p.rows.find((r: { userId: string }) => r.userId === s.ids.ricardo);
    const marcio = p.rows.find((r: { userId: string }) => r.userId === s.ids.marcio);
    expect(ricardo).toMatchObject({
      tasksCompleted: 1,
      impediments: 0,
      reworkTasks: 0,
      withDueDate: 1,
      late: 0,
      onTime: 1,
    });
    expect(marcio).toMatchObject({
      tasksCompleted: 1,
      impediments: 1,
      withDueDate: 1,
      late: 1,
      lateWithImpediment: 1,
    });
    expect(ricardo.executionMinutes).toBeGreaterThanOrEqual(0);
    // Sem ranking: nenhuma posição/pontuação, ordem alfabética.
    expect(Object.keys(ricardo)).not.toContain('rank');
    expect(Object.keys(ricardo)).not.toContain('score');
    const names = p.rows.map((r: { displayName: string }) => r.displayName);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'pt-BR')));
    expect(p.notes.join(' ')).toMatch(/sem ranking/);
  });
});

describe('Segurança, concorrência e sincronização', () => {
  it('17. permissões: só o gestor vê tudo; tapeceiro vê só os próprios valores, se autorizado', async () => {
    const s = await scenario();
    const orderId = await orderIdOf(s.so.id);
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
      })
    ).body;
    await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 45000,
    });
    // Usuário do painel com acesso a pedidos e OS, mas sem financeiro.
    const office = await panelUserWith(app, s.admin, 'escritorio', ['pedidos.ver', 'os.ver']);
    for (const path of [
      '/dashboard',
      `/orders/${orderId}`,
      '/receivables',
      '/labor',
      `/service-orders/${s.so.id}`,
      '/reports/margens',
    ])
      expect((await office.get(F(path))).status, path).toBe(403);
    // Leitura do financeiro não registra nada.
    const reader = await panelUserWith(app, s.admin, 'fin-leitor', ['financeiro.ver']);
    expect((await reader.get(F('/dashboard'))).status).toBe(200);
    expect((await receivable(reader, orderId, 1000)).status).toBe(403);
    expect(
      (
        await post(reader, F(`/labor/${mo.id}/payments`), {
          amountCents: 1,
          paidAt: today(),
          method: 'PIX',
          version: mo.version,
        })
      ).status,
    ).toBe(403);
    expect((await post(reader, F('/expenses'), {})).status).toBe(403);
    // Tablets: nunca o financeiro geral, nem com permissão (sessão do painel exigida).
    const ricardo = s.tablets.Ricardo!;
    expect((await ricardo.get(F('/labor'))).status).toBe(403);
    expect((await ricardo.get(F('/my-production'))).status).toBe(403);
    await grant(s.admin, 'Thiago', ['financeiro.ver']);
    expect((await s.tablets.Thiago!.get(F('/dashboard'))).status).toBe(403);
    // Autorizado pelo gestor: Ricardo vê só os próprios valores.
    await grant(s.admin, 'Ricardo', ['financeiro.producao_propria']);
    // Evolução Fase 5: no tablet compartilhado, só com o PIN redigitado.
    expect((await ricardo.get(F('/my-production'))).status).toBe(403);
    const mine = await post(ricardo, F('/my-production/unlock'), { pin: PINS.Ricardo });
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      code: mo.code,
      dueCents: 80000,
      status: 'PREVISTO',
    });
    expect(mine.body.totals).toMatchObject({ forecastCents: 80000, paidCents: 0 });
    const text = JSON.stringify(mine.body);
    expect(text).not.toContain('45000');
    expect(text).not.toContain('350000');
    expect(text).not.toContain('Márcio');
    // Márcio sem autorização continua sem acesso.
    expect((await s.tablets['Márcio']!.get(F('/my-production'))).status).toBe(403);
  });

  it('18. tablets nunca recebem eventos ou valores financeiros', async () => {
    const s = await scenario();
    const orderId = await orderIdOf(s.so.id);
    const wAdmin = track(await WsClient.connect(app, s.admin));
    const wRicardo = track(await WsClient.connect(app, s.tablets.Ricardo!));
    await grant(s.admin, 'Ricardo', ['financeiro.producao_propria']);
    const rc = (await receivable(s.admin, orderId, 100000)).body;
    await post(s.admin, F(`/receivables/${rc.id}/payments`), {
      amountCents: 100000,
      receivedAt: today(),
      method: 'PIX',
      version: rc.version,
    });
    await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    await post(s.admin, F('/expenses'), {
      category: 'MARKETING',
      description: 'Anúncio',
      amountCents: 9000,
      competence: month(),
      dueDate: today(),
      beneficiary: 'Agência Exemplo',
    });
    const paid = await wAdmin.waitFor((m) => m.event?.type === 'finance.payment_recorded');
    await wAdmin.waitFor((m) => m.event?.type === 'finance.expense_created');
    await wAdmin.waitFor((m) => m.event?.type === 'finance.receivable_created');
    // Eventos sem valores.
    expect(JSON.stringify(paid.event.payload)).not.toMatch(/Cents|100000/);
    for (const e of wAdmin.events().filter((x) => x.type.startsWith('finance.')))
      expect(JSON.stringify(e.payload)).not.toMatch(/Cents|00000/);
    // O tablet segue recebendo eventos dele, mas nenhum financeiro.
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await wRicardo.waitFor((m) => m.event?.type === 'production.task_completed');
    expect(wRicardo.events().filter((e) => e.type.startsWith('finance.'))).toHaveLength(0);
    // Telas de produção do tablet (Meu dia, OS da tarefa) sem valores do cliente.
    const mine = await s.tablets.Ricardo!.get('/api/v1/production-tasks/mine');
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toMatch(/agreedValue|350000|valueCents|Cents/);
  });

  it('19. concorrência: dois recebimentos simultâneos na mesma versão → só um entra', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Concorrência');
    const rc = (await receivable(admin, await orderIdOf(so.id), 150000)).body;
    const pay = () =>
      post(admin, F(`/receivables/${rc.id}/payments`), {
        amountCents: 100000,
        receivedAt: today(),
        method: 'PIX',
        version: rc.version,
      });
    const res = await Promise.all([pay(), pay()]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const cur = await db().customerReceivable.findUniqueOrThrow({ where: { id: rc.id } });
    expect(cur.receivedCents).toBe(100000);
    expect(await db().customerPayment.count()).toBe(1);
    // Mão de obra: duas criações simultâneas para a mesma peça → uma.
    const s2 = await openServiceOrder(admin, 'Cliente Concorrência 2');
    const ricardo = await userIdOf('Ricardo');
    const both = await Promise.all([
      labor(admin, {
        professionalUserId: ricardo,
        serviceOrderId: s2.id,
        serviceOrderItemId: s2.items[0].id,
      }),
      labor(admin, {
        professionalUserId: ricardo,
        serviceOrderId: s2.id,
        serviceOrderItemId: s2.items[0].id,
      }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db().productionPayable.count({ where: { serviceOrderId: s2.id } })).toBe(1);
  });

  it('20. idempotência: repetir a mesma criação devolve o mesmo registro', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Idempotente');
    const orderId = await orderIdOf(so.id);
    const k1 = idemKey();
    const a = await receivable(admin, orderId, 1000, k1);
    const b = await receivable(admin, orderId, 1000, k1);
    expect(b.body.id).toBe(a.body.id);
    expect(await db().customerReceivable.count()).toBe(1);
    const k2 = idemKey();
    const expense = {
      category: 'CONTABILIDADE',
      description: 'Honorários do contador',
      amountCents: 60000,
      competence: month(),
      dueDate: today(),
      beneficiary: 'Escritório Exemplo',
    };
    const e1 = await post(admin, F('/expenses'), expense, k2);
    const e2 = await post(admin, F('/expenses'), expense, k2);
    expect(e2.body.id).toBe(e1.body.id);
    expect(await db().operationalExpense.count()).toBe(1);
    expect(await db().accountPayable.count()).toBe(1);
    const k3 = idemKey();
    const logi = {
      kind: 'DESLOCAMENTO',
      description: 'Viagem extra',
      amountCents: 3000,
      date: today(),
      splitMethod: 'IGUAL',
      allocations: [{ serviceOrderId: so.id }],
    };
    const l1 = await post(admin, F('/logistics-costs'), logi, k3);
    const l2 = await post(admin, F('/logistics-costs'), logi, k3);
    expect(l2.body.id).toBe(l1.body.id);
    expect(await db().logisticsCost.count()).toBe(1);
    // Sem chave de idempotência, a operação é recusada.
    const noKey = await admin.post(F('/expenses'), expense);
    expect(noKey.status).toBe(400);
  });

  it('21. sincronização: painel recebe eventos financeiros (ao vivo e na reconciliação), tablet não', async () => {
    const s = await scenario();
    const orderId = await orderIdOf(s.so.id);
    const headAdmin = (await s.admin.get('/api/sync/status')).body.headSeq;
    const headTablet = (await s.tablets.Ricardo!.get('/api/sync/status')).body.headSeq;
    const rc = (await receivable(s.admin, orderId, 50000)).body;
    await post(s.admin, F(`/receivables/${rc.id}/payments`), {
      amountCents: 50000,
      receivedAt: today(),
      method: 'PIX',
      version: rc.version,
    });
    await post(s.admin, F('/payables'), {
      beneficiary: 'Fornecedor Exemplo',
      category: 'SERVICOS',
      description: 'Conserto da máquina de costura',
      amountCents: 20000,
      dueDate: today(),
    });
    const adminEvents = (await s.admin.get(`/api/sync/events?since=${headAdmin}`)).body.events as {
      type: string;
      payload: unknown;
    }[];
    const types = adminEvents.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'finance.receivable_created',
        'finance.payment_recorded',
        'finance.payable_created',
      ]),
    );
    const tabletEvents = (await s.tablets.Ricardo!.get(`/api/sync/events?since=${headTablet}`)).body
      .events as { type: string }[];
    expect(tabletEvents.filter((e) => e.type.startsWith('finance.'))).toHaveLength(0);
    // Reconexão do painel: reenvio dos eventos perdidos.
    const w = track(await WsClient.connect(app, s.admin, String(headAdmin)));
    await w.waitFor((m) => m.kind === 'replay.done');
    expect(w.events('finance.payment_recorded')).toHaveLength(1);
  });

  it('22. histórico financeiro imutável e sem exclusão (base para backup/restauração)', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Histórico');
    const rc = (await receivable(admin, await orderIdOf(so.id), 1000)).body;
    await post(admin, F(`/receivables/${rc.id}/payments`), {
      amountCents: 1000,
      receivedAt: today(),
      method: 'PIX',
      version: rc.version,
    });
    await post(admin, F('/expenses'), {
      category: 'SISTEMAS',
      description: 'Assinatura de sistema',
      amountCents: 5000,
      competence: month(),
      dueDate: today(),
      beneficiary: 'Software Exemplo',
    });
    await expect(db().financialEvent.deleteMany()).rejects.toThrow();
    await expect(db().financialEvent.updateMany({ data: { note: 'x' } })).rejects.toThrow();
    await expect(db().customerReceivable.deleteMany()).rejects.toThrow();
    await expect(db().accountPayable.deleteMany()).rejects.toThrow();
    await expect(db().operationalExpense.deleteMany()).rejects.toThrow();
    await expect(
      db().$executeRawUnsafe(`UPDATE customer_receivables SET received_cents = amount_cents + 1`),
    ).rejects.toThrow();
    const hist = (await admin.get(F(`/receivables/${rc.id}`))).body.history.map(
      (h: { kind: string }) => h.kind,
    );
    expect(hist).toEqual(['LANCADA', 'QUITADA']);
  });
});
