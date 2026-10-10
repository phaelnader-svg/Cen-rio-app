import { closingWeekStart, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import {
  WsClient,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';
import {
  createCustomer,
  createOrder,
  createPickup,
  panelUserWith,
  receiptBody,
} from './commercial-helpers';
import { grant, openServiceOrder } from './measurement-helpers';
import { day, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 7 — fechamento semanal geral (tapeceiros + logística). Dados fictícios.
 * Exemplo A: Ricardo 5 peças = R$ 3.500; Márcio 4 peças = R$ 3.200; André 8 retiradas +
 * 6 entregas de R$ 100 = R$ 1.400 → devido R$ 8.100.
 */
let app: App;
const sockets: WsClient[] = [];
const TZ = 'America/Sao_Paulo';
const WEEK = closingWeekStart(today());

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const F = (path: string) => `/api/v1/finance${path}`;
const C = (week = WEEK, q = '') => F(`/weekly-closings/${week}${q}`);
const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown, key = idemKey()) =>
  c.req('PUT', path, body, { 'idempotency-key': key });
type Row = {
  beneficiary: { userId: string | null; displayName: string };
  category: string;
  dueCents: number;
  [k: string]: unknown;
};
const rowOf = (d: { rows: Row[] }, name: string, category?: string) =>
  d.rows.find((r) => r.beneficiary.displayName === name && (!category || r.category === category))!;

async function setOwner(
  admin: Client,
  itemId: string,
  userId: string,
  expectedUserId: string | null,
) {
  const r = await put(admin, `/api/v1/service-order-items/${itemId}/upholsterer`, {
    userId,
    expectedUserId,
    reason: expectedUserId ? 'Substituição de teste' : undefined,
    confirm: Boolean(expectedUserId),
  });
  if (r.status !== 200) throw new Error(`owner: ${JSON.stringify(r.body)}`);
}
async function labor(
  admin: Client,
  professionalUserId: string,
  so: { id: string },
  itemId: string,
  agreedCents: number,
) {
  const r = await post(admin, F('/labor'), {
    professionalUserId,
    serviceOrderId: so.id,
    serviceOrderItemId: itemId,
    service: 'Mão de obra',
    agreedCents,
    eligibility: 'QUALIDADE_APROVADA',
  });
  if (r.status !== 201) throw new Error(`labor: ${JSON.stringify(r.body)}`);
  return r.body as { id: string; code: string; version: number };
}
/** Aprovação de qualidade (atalho de dados): etapa da peça + leitura que recalcula a situação. */
async function stage(admin: Client, itemIds: string[], s: string) {
  await db().serviceOrderItem.updateMany({
    where: { id: { in: itemIds } },
    data: { fulfillmentStage: s },
  });
  await admin.get(F('/labor'));
}
async function realizePickup(admin: Client, pickupId: string) {
  for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
    const p = (await admin.get(`/api/v1/pickups/${pickupId}`)).body;
    const r = await post(admin, `/api/v1/pickups/${pickupId}/transition`, {
      toStatus,
      version: p.version,
    });
    if (r.status !== 200) throw new Error(`pickup: ${JSON.stringify(r.body)}`);
  }
}
/** Entrega concluída (atalho de dados) e custo registrado depois → devido na hora. */
async function completedDelivery(
  admin: Client,
  customerId: string,
  itemIds: string[],
  amountCents: number,
  people: string[],
) {
  const d = await post(admin, '/api/v1/deliveries', {
    customerId,
    scheduledDate: day(1),
    team: 'LOGISTICA_TERCEIRIZADA',
    itemIds,
    provisional: true,
  });
  if (d.status !== 201) throw new Error(`delivery: ${JSON.stringify(d.body)}`);
  await db().delivery.update({
    where: { id: d.body.id },
    data: { status: 'CONCLUIDA', completedAt: new Date() },
  });
  const c = await put(admin, F('/trip-costs'), {
    deliveryId: d.body.id,
    amountCents,
    participantUserIds: people,
  });
  if (c.status !== 200) throw new Error(`trip: ${JSON.stringify(c.body)}`);
  return d.body.id as string;
}

async function exampleA() {
  const admin = await loginAdmin(app);
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    andre: await userIdOf('André'),
    izaias: await userIdOf('Izaías'),
  };
  await put(admin, F('/logistics-defaults'), {
    defaultPickupCostCents: 10000,
    defaultDeliveryCostCents: 10000,
    logisticsPayeeUserId: ids.andre,
  });
  const sos = [];
  for (let i = 0; i < 5; i++) sos.push(await openServiceOrder(admin, `Cliente Fechamento ${i}`));
  // 6 entregas (uma por peça das 3 primeiras OS), antes de liberar a mão de obra.
  for (const so of sos.slice(0, 3)) {
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }))
      .customerId;
    for (const it of so.items)
      await completedDelivery(admin, customerId, [it.id], 10000, [ids.andre, ids.izaias]);
  }
  const ric = [];
  const mar = [];
  for (const [k, so] of sos.entries()) {
    await setOwner(admin, so.items[0].id, ids.ricardo, null);
    await setOwner(admin, so.items[1].id, ids.marcio, null);
    ric.push(await labor(admin, ids.ricardo, so, so.items[0].id, 70000));
    mar.push(await labor(admin, ids.marcio, so, so.items[1].id, k < 4 ? 80000 : 85000));
  }
  await stage(
    admin,
    [...sos.map((s) => s.items[0].id), ...sos.slice(0, 4).map((s) => s.items[1].id)],
    'AGUARDANDO_EMBALAGEM',
  );
  await stage(admin, [sos[4]!.items[1].id], 'EM_PRODUCAO');
  // 8 retiradas realizadas.
  for (let i = 0; i < 8; i++) {
    const customer = await createCustomer(admin, {
      name: `Cliente Retirada ${i}`,
      phone: null,
      allowSimilar: true,
    });
    const pk = await createPickup(admin, await createOrder(admin, customer), day(1));
    await put(admin, F('/trip-costs'), {
      pickupId: pk.id,
      amountCents: 10000,
      participantUserIds: [ids.andre, ids.izaias],
    });
    await realizePickup(admin, pk.id);
  }
  return { admin, ids, sos, ric, mar };
}

// ───────────────────────────────────────────────────────────────────────────

describe('Fechamento semanal (CA7-01..03, 06, 09)', () => {
  it('1. Exemplo A: R$ 8.100 devido, reconciliado item a item; previsão fora do pagável; filtros', async () => {
    const { admin, ids } = await exampleA();
    const d = (await admin.get(C())).body;
    expect(d).toMatchObject({ weekStart: WEEK, timezone: TZ, status: 'ABERTO', version: 0 });
    expect(rowOf(d, 'Ricardo')).toMatchObject({
      category: 'TAPECARIA',
      weekDueCents: 350000,
      dueCents: 350000,
      items: 5,
      paidInWeekCents: 0,
      openAtEndCents: 350000,
    });
    expect(rowOf(d, 'Márcio')).toMatchObject({
      category: 'TAPECARIA',
      weekDueCents: 320000,
      forecastCents: 85000,
      items: 5,
    });
    expect(rowOf(d, 'André')).toMatchObject({
      category: 'LOGISTICA',
      weekDueCents: 140000,
      items: 14,
      canPay: true,
    });
    expect(d.rows.find((r: Row) => r.beneficiary.displayName === 'Izaías')).toBeUndefined();
    expect(d.totals.dueCents).toBe(810000);
    expect(d.totals.forecastCents).toBe(85000);
    // Total = soma das linhas = soma dos itens (fonte a fonte).
    expect(d.rows.reduce((a: number, r: Row) => a + r.dueCents, 0)).toBe(810000);
    for (const r of d.rows as Row[]) {
      const items = d.items.filter(
        (i: { beneficiary: { displayName: string }; category: string }) =>
          i.beneficiary.displayName === r.beneficiary.displayName && i.category === r.category,
      );
      expect(items.reduce((a: number, i: { dueCents: number }) => a + i.dueCents, 0)).toBe(
        r.dueCents,
      );
    }
    // Rastreável por OS, peça e profissional; cada obrigação aparece uma vez.
    const tap = d.items.filter((i: { category: string }) => i.category === 'TAPECARIA');
    expect(
      tap.every(
        (i: { serviceOrders: unknown[]; piece: unknown }) =>
          i.serviceOrders.length === 1 && i.piece,
      ),
    ).toBe(true);
    expect(new Set(d.items.map((i: { id: string }) => i.id)).size).toBe(d.items.length);
    const trip = d.items.find((i: { category: string }) => i.category === 'LOGISTICA');
    expect(trip.notes.join(' ')).toMatch(/Participantes: .*Izaías/);
    expect(await db().accountPayable.count()).toBe(14);
    // Filtros.
    const lg = (await admin.get(C(WEEK, '?category=LOGISTICA'))).body;
    expect(lg.rows).toHaveLength(1);
    expect(lg.totals.dueCents).toBe(140000);
    expect(
      (await admin.get(C(WEEK, `?beneficiaryUserId=${ids.ricardo}`))).body.totals.dueCents,
    ).toBe(350000);
    const prev = (await admin.get(C(WEEK, '?state=PREVISTO'))).body;
    expect(prev.items.map((i: { currentOpenCents: number }) => i.currentOpenCents)).toEqual([
      85000,
    ]);
    expect(
      (await admin.get(F(`/weekly-closings/${day(0) === WEEK ? '2026-10-06' : day(0)}`))).status,
    ).toBe(400);
  });

  it('2. Exemplos B e C: Pix parcial R$ 600 → saldo R$ 800; idempotente; concorrência; liquida sem nova despesa', async () => {
    const { admin, ids, sos, mar } = await exampleA();
    const pay = (amountCents: number, key = idemKey()) =>
      post(
        admin,
        F(`/weekly-closings/${WEEK}/payments`),
        {
          beneficiaryUserId: ids.andre,
          category: 'LOGISTICA',
          amountCents,
          paidAt: today(),
          method: 'PIX',
          reference: 'E2E-PIX-001',
        },
        key,
      );
    const key = idemKey();
    const a = await pay(60000, key);
    expect(a.status).toBe(201);
    expect(rowOf(a.body, 'André')).toMatchObject({
      dueCents: 140000,
      paidInWeekCents: 60000,
      openAtEndCents: 80000,
    });
    const again = await pay(60000, key);
    expect(rowOf(again.body, 'André').paidInWeekCents).toBe(60000);
    expect(await db().closingPayment.count()).toBe(1);
    // Duas baixas concorrentes do saldo inteiro: só uma passa.
    const both = await Promise.all([pay(80000), pay(80000)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 422]);
    expect((await pay(1)).status).toBe(422);
    const d = (await admin.get(C())).body;
    expect(rowOf(d, 'André')).toMatchObject({
      paidInWeekCents: 140000,
      openAtEndCents: 0,
      currentOpenCents: 0,
    });
    expect(await db().accountPayable.count()).toBe(14);
    expect(await db().accountPayable.count({ where: { status: 'PAGO' } })).toBe(14);
    expect(await db().operationalExpense.count()).toBe(0);
    const sum = await db().payablePayment.aggregate({ _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(140000);
    // Exemplo C: R$ 850 em execução = previsto; aguardando qualidade = não liberado; liberado = 1 vez.
    await stage(admin, [sos[4]!.items[1].id], 'AGUARDANDO_INSPECAO');
    let m = rowOf((await admin.get(C())).body, 'Márcio');
    expect(m).toMatchObject({ forecastCents: 0, awaitingCents: 85000, dueCents: 320000 });
    await stage(admin, [sos[4]!.items[1].id], 'AGUARDANDO_EMBALAGEM');
    m = rowOf((await admin.get(C())).body, 'Márcio');
    expect(m).toMatchObject({ forecastCents: 0, awaitingCents: 0, dueCents: 405000, items: 5 });
    const last = mar[4]!;
    const items = (await admin.get(C())).body.items.filter((i: { id: string }) => i.id === last.id);
    expect(items).toHaveLength(1);
  });
});

/** Cliente com N OS (uma poltrona cada). */
async function sameCustomer(admin: Client, n: number) {
  const customer = await createCustomer(admin, {
    name: 'Cliente Rota',
    phone: null,
    allowSimilar: true,
  });
  const sos = [];
  for (let k = 0; k < n; k++) {
    const order = await createOrder(admin, customer, [
      { pieceType: 'POLTRONA', description: `Poltrona ${k}`, quantity: 1 },
    ]);
    await post(
      admin,
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]),
    );
    const so = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: [
        {
          orderItemId: order.items[0].id,
          quantity: 1,
          description: `Poltrona ${k}`,
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    });
    sos.push(so.body);
  }
  return { customer, sos };
}

describe('Logística e revisões (CA7-04, 07, 08)', () => {
  it('3. Exemplo D e estados: multi-OS = 1 obrigação; cancelada fora; frustrada só com taxa; sem custo e gratuita; recebedor inativo', async () => {
    const admin = await loginAdmin(app);
    const andre = await userIdOf('André');
    const izaias = await userIdOf('Izaías');
    await put(admin, F('/logistics-defaults'), {
      defaultPickupCostCents: 10000,
      defaultDeliveryCostCents: 10000,
      logisticsPayeeUserId: andre,
    });
    const { customer, sos } = await sameCustomer(admin, 3);
    await completedDelivery(
      admin,
      customer.id,
      sos.map((s) => s.items[0].id),
      10000,
      [andre, izaias],
    );
    let d = (await admin.get(C())).body;
    const trip = d.items.filter(
      (i: { category: string; bucket: string }) =>
        i.category === 'LOGISTICA' && i.bucket === 'WEEK',
    );
    expect(trip).toHaveLength(1);
    expect(trip[0]).toMatchObject({ dueCents: 10000, beneficiary: { userId: andre } });
    expect(trip[0].serviceOrders.map((s: { amountCents: number }) => s.amountCents)).toEqual([
      3334, 3333, 3333,
    ]);
    expect(await db().accountPayable.count()).toBe(1);
    // Cancelada antes da realização: fora. Frustrada sem taxa: previsão; com taxa: devido.
    const mk = async (name: string) => {
      const c = await createCustomer(admin, { name, phone: null, allowSimilar: true });
      const pk = await createPickup(admin, await createOrder(admin, c), day(1));
      await put(admin, F('/trip-costs'), { pickupId: pk.id, amountCents: 10000 });
      return pk.id as string;
    };
    const cancelled = await mk('Cliente Cancela');
    const p1 = (await admin.get(`/api/v1/pickups/${cancelled}`)).body;
    await post(admin, `/api/v1/pickups/${cancelled}/transition`, {
      toStatus: 'CANCELADA',
      note: 'Desistiu',
      version: p1.version,
    });
    const frustrated = await mk('Cliente Frustrada');
    for (const [toStatus, note] of [
      ['EM_EXECUCAO', undefined],
      ['COM_OCORRENCIA', 'Ausente'],
    ] as const) {
      const p = (await admin.get(`/api/v1/pickups/${frustrated}`)).body;
      await post(admin, `/api/v1/pickups/${frustrated}/transition`, {
        toStatus,
        note,
        version: p.version,
      });
    }
    d = (await admin.get(C())).body;
    expect(rowOf(d, 'André')).toMatchObject({ dueCents: 10000, forecastCents: 10000 });
    await post(admin, F('/trip-costs/fee'), {
      pickupId: frustrated,
      amountCents: 3000,
      reason: 'Ida perdida autorizada',
    });
    d = (await admin.get(C())).body;
    expect(rowOf(d, 'André')).toMatchObject({ dueCents: 13000, forecastCents: 10000 });
    // Realizada sem custo: pendência bloqueante; gratuita confirmada resolve sem criar dívida.
    const c2 = await createCustomer(admin, {
      name: 'Cliente Sem Custo',
      phone: null,
      allowSimilar: true,
    });
    const free = await createPickup(admin, await createOrder(admin, c2), day(1));
    await realizePickup(admin, free.id);
    d = (await admin.get(C())).body;
    expect(
      d.pendencies.filter((p: { kind: string }) => p.kind === 'CUSTO_NAO_INFORMADO'),
    ).toHaveLength(1);
    expect((await post(admin, C(WEEK, '/confirm'), { version: 0 })).status).toBe(422);
    expect(
      (
        await post(admin, F('/trip-costs/free'), {
          pickupId: free.id,
          reason: 'Cortesia combinada com o cliente',
        })
      ).status,
    ).toBe(200);
    d = (await admin.get(C())).body;
    expect(
      d.pendencies.filter((p: { kind: string }) => p.kind === 'CUSTO_NAO_INFORMADO'),
    ).toHaveLength(0);
    expect(
      (await put(admin, F('/trip-costs'), { pickupId: free.id, amountCents: 100 })).status,
    ).toBe(422);
    expect(d.totals.dueCents).toBe(13000);
    // Recebedor inativo: obrigação pendente de configuração, visível e bloqueante.
    await db().user.update({ where: { id: andre }, data: { active: false } });
    const pending = await mk('Cliente Sem Recebedor');
    await realizePickup(admin, pending);
    d = (await admin.get(C())).body;
    const pend = d.items.find((i: { state: string }) => i.state === 'PENDENTE_CONFIGURACAO');
    expect(pend).toMatchObject({ currentOpenCents: 10000, payable: false });
    expect(
      d.pendencies.some(
        (p: { kind: string; blocking: boolean }) => p.kind === 'SEM_RECEBEDOR' && p.blocking,
      ),
    ).toBe(true);
    expect(d.totals.dueCents).toBe(13000);
    expect(await db().accountPayable.count()).toBe(2);
  });

  it('4. revisão aberta trava; resolvida preserva os dois créditos; nenhuma obrigação duplicada', async () => {
    const admin = await loginAdmin(app);
    const ric = await userIdOf('Ricardo');
    const mar = await userIdOf('Márcio');
    const so = await openServiceOrder(admin, 'Cliente Revisão');
    await setOwner(admin, so.items[0].id, ric, null);
    const mo = await labor(admin, ric, so, so.items[0].id, 80000);
    await stage(admin, [so.items[0].id], 'AGUARDANDO_EMBALAGEM');
    await setOwner(admin, so.items[0].id, mar, ric);
    let d = (await admin.get(C())).body;
    const item = d.items.find((i: { id: string }) => i.id === mo.id);
    expect(item).toMatchObject({ state: 'EM_REVISAO', payable: false, bucket: 'FORECAST' });
    expect(d.totals.dueCents).toBe(0);
    expect(d.pendencies.some((p: { kind: string }) => p.kind === 'REVISAO_ABERTA')).toBe(true);
    expect(
      (
        await post(admin, F(`/weekly-closings/${WEEK}/payments`), {
          beneficiaryUserId: ric,
          category: 'TAPECARIA',
          amountCents: 100,
          paidAt: today(),
          method: 'PIX',
        })
      ).status,
    ).toBe(422);
    expect((await post(admin, C(WEEK, '/confirm'), { version: 0 })).status).toBe(422);
    const rv = (await admin.get(F('/labor-reviews?status=ABERTA'))).body[0];
    await post(admin, F(`/labor-reviews/${rv.id}/resolve`), {
      lines: [
        { professionalUserId: ric, amountCents: 30000 },
        { professionalUserId: mar, amountCents: 50000 },
      ],
      reason: 'Divisão definida pelo gestor',
      version: rv.version,
    });
    d = (await admin.get(C())).body;
    expect(rowOf(d, 'Ricardo').dueCents).toBe(30000);
    expect(rowOf(d, 'Márcio').dueCents).toBe(50000);
    expect(d.totals.dueCents).toBe(80000);
    expect(d.items.filter((i: { category: string }) => i.category === 'TAPECARIA')).toHaveLength(2);
    expect((await post(admin, C(WEEK, '/confirm'), { version: 0 })).status).toBe(200);
  });
});

describe('Competência, conferência e correções (CA7-12, 13)', () => {
  it('5. saldo anterior e pagamento posterior: aparecem uma vez em cada semana, sem duplicar', async () => {
    const admin = await loginAdmin(app);
    const ric = await userIdOf('Ricardo');
    const so = await openServiceOrder(admin, 'Cliente Semana Anterior');
    await setOwner(admin, so.items[0].id, ric, null);
    const mo = await labor(admin, ric, so, so.items[0].id, 50000);
    await stage(admin, [so.items[0].id], 'AGUARDANDO_EMBALAGEM');
    const prevWeek = closingWeekStart(day(-7));
    await db().productionPayable.update({
      where: { id: mo.id },
      data: { eligibleAt: zonedDateTime(prevWeek, '10:00', TZ) },
    });
    // Semana anterior: devido na semana, ainda em aberto.
    expect(rowOf((await admin.get(C(prevWeek))).body, 'Ricardo')).toMatchObject({
      weekDueCents: 50000,
      previousOpenCents: 0,
      openAtEndCents: 50000,
    });
    // Semana atual: saldo anterior identificável; pagamento parcial nesta semana.
    let cur = rowOf((await admin.get(C())).body, 'Ricardo');
    expect(cur).toMatchObject({ weekDueCents: 0, previousOpenCents: 50000, dueCents: 50000 });
    await post(admin, F(`/weekly-closings/${WEEK}/payments`), {
      beneficiaryUserId: ric,
      category: 'TAPECARIA',
      amountCents: 20000,
      paidAt: today(),
      method: 'PIX',
    });
    cur = rowOf((await admin.get(C())).body, 'Ricardo');
    expect(cur).toMatchObject({
      previousOpenCents: 50000,
      paidInWeekCents: 20000,
      openAtEndCents: 30000,
    });
    const before = rowOf((await admin.get(C(prevWeek))).body, 'Ricardo');
    expect(before).toMatchObject({
      dueCents: 50000,
      paidInWeekCents: 0,
      paidAfterCents: 20000,
      currentOpenCents: 30000,
    });
    // Semana seguinte (futura) só carrega o saldo restante.
    const nextWeek = closingWeekStart(day(7));
    expect(rowOf((await admin.get(C(nextWeek))).body, 'Ricardo')).toMatchObject({
      previousOpenCents: 30000,
    });
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: mo.id } })).paidCents,
    ).toBe(20000);
  });

  it('6. conferir, reabrir, divergência após ajuste, estorno do lote: tudo auditável e imutável', async () => {
    const { admin, ids, ric } = await exampleA();
    const reader = await panelUserWith(app, admin, 'fin-op', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    const both = await Promise.all([
      post(admin, C(WEEK, '/confirm'), { version: 0, note: 'Conferido com as planilhas' }),
      post(admin, C(WEEK, '/confirm'), { version: 0, note: 'Duplo clique' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    let d = (await admin.get(C())).body;
    expect(d).toMatchObject({
      status: 'CONFERIDO',
      version: 1,
      checkedBy: expect.any(String),
      divergent: false,
    });
    expect((await post(admin, C(WEEK, '/confirm'), { version: 1 })).status).toBe(422);
    expect((await post(reader, C(WEEK, '/reopen'), { reason: 'Rever', version: 1 })).status).toBe(
      403,
    );
    // Ajuste depois da conferência: divergência visível (sem reescrever o retrato).
    const mo = (await admin.get(F(`/labor/${ric[0]!.id}`))).body;
    await post(admin, F(`/labor/${mo.id}/adjustments`), {
      amountCents: 5000,
      reason: 'Costura extra',
      version: mo.version,
    });
    d = (await admin.get(C())).body;
    expect(d.divergent).toBe(true);
    expect(d.divergences.join(' ')).toContain(mo.code);
    expect((await post(admin, C(WEEK, '/reopen'), { reason: 'Ajuste', version: 9 })).status).toBe(
      409,
    );
    expect(
      (await post(admin, C(WEEK, '/reopen'), { reason: 'Ajuste após conferência', version: 1 }))
        .status,
    ).toBe(200);
    expect(
      (await post(admin, C(WEEK, '/confirm'), { version: 2, note: 'Reconferido' })).status,
    ).toBe(200);
    d = (await admin.get(C())).body;
    expect(d).toMatchObject({ status: 'CONFERIDO', version: 3, divergent: false });
    expect(d.totals.dueCents).toBe(815000);
    // Pagamento em lote e estorno do lote (cada baixa estornada na obrigação original).
    const pay = await post(admin, F(`/weekly-closings/${WEEK}/payments`), {
      beneficiaryUserId: ids.ricardo,
      category: 'TAPECARIA',
      amountCents: 100000,
      paidAt: today(),
      method: 'TRANSFERENCIA',
      reference: 'TED-1',
    });
    expect(pay.status).toBe(201);
    const pf = pay.body.payments[0];
    expect(
      pf.parts
        .map((p: { amountCents: number }) => p.amountCents)
        .reduce((a: number, b: number) => a + b, 0),
    ).toBe(100000);
    const rev = await post(admin, F(`/closing-payments/${pf.id}/reverse`), {
      reason: 'Transferência devolvida',
    });
    expect(rev.status).toBe(200);
    expect(rowOf(rev.body, 'Ricardo')).toMatchObject({
      paidInWeekCents: 0,
      openAtEndCents: 355000,
    });
    expect(rev.body.payments[0].reversed).toBe(true);
    expect(
      (await post(admin, F(`/closing-payments/${pf.id}/reverse`), { reason: 'De novo' })).status,
    ).toBe(409);
    expect(await db().professionalPaymentReversal.count()).toBe(pf.parts.length);
    expect(await db().professionalPayment.count()).toBe(pf.parts.length);
    expect(d.history.map((h: { kind: string }) => h.kind)).toEqual([
      'CONFERIDO',
      'REABERTO',
      'CONFERIDO',
    ]);
    const hist = (await admin.get(C())).body.history.map((h: { kind: string }) => h.kind);
    expect(hist).toEqual(['CONFERIDO', 'REABERTO', 'CONFERIDO', 'PAGAMENTO', 'ESTORNO']);
    await expect(db().weeklyClosingEvent.deleteMany()).rejects.toThrow();
    await expect(db().closingPayment.deleteMany()).rejects.toThrow();
    await expect(db().weeklyClosing.deleteMany()).rejects.toThrow();
    expect(
      await db().auditLog.count({ where: { action: { startsWith: 'finance.weekly_closing' } } }),
    ).toBe(3);
  });
});

describe('Segurança (CA7-14)', () => {
  it('7. tablets, André, Izaías e sem permissão: nada do fechamento; leitura ≠ gestão; IDOR; CSV protegido', async () => {
    const { admin, ids, ric } = await exampleA();
    await grant(admin, 'Ricardo', ['financeiro.producao_propria']);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const izaias = (
      await setupTablet(app, admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '552211' })
    ).tablet;
    const plain = await panelUserWith(app, admin, 'sem-fin', ['producao.ver', 'entregas.ver']);
    const viewer = await panelUserWith(app, admin, 'fin-ver', ['financeiro.ver']);
    const wsR = await WsClient.connect(app, ricardo);
    const wsA = await WsClient.connect(app, andre);
    sockets.push(wsR, wsA);
    const payBody = {
      beneficiaryUserId: ids.andre,
      category: 'LOGISTICA',
      amountCents: 100,
      paidAt: today(),
      method: 'PIX',
    };
    for (const c of [ricardo, andre, izaias, plain]) {
      expect((await c.get(C())).status).toBe(403);
      expect((await c.get(C(WEEK, '?format=csv'))).status).toBe(403);
      expect((await c.get(F('/weekly-closings'))).status).toBe(403);
      expect((await post(c, C(WEEK, '/confirm'), { version: 0 })).status).toBe(403);
      expect((await post(c, F(`/weekly-closings/${WEEK}/payments`), payBody)).status).toBe(403);
    }
    expect((await viewer.get(C())).status).toBe(200);
    expect((await post(viewer, C(WEEK, '/confirm'), { version: 0 })).status).toBe(403);
    expect((await post(viewer, F(`/weekly-closings/${WEEK}/payments`), payBody)).status).toBe(403);
    const csv = await admin.get(C(WEEK, '?format=csv'));
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.headers['cache-control']).toBe('no-store');
    // Pagamento do gestor: tablets não recebem nada pelo tempo real.
    expect((await post(admin, F(`/weekly-closings/${WEEK}/payments`), payBody)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 400));
    for (const ws of [wsR, wsA])
      expect(JSON.stringify(ws.messages)).not.toMatch(/weekly_closing|finance\.|Cents/);
    // Ricardo: só os próprios valores, com PIN.
    const mine = await post(ricardo, F('/my-production/unlock'), { pin: '482915' });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toMatch(/Márcio|André|80000/);
    // IDOR e regras: pagamento de outra obrigação/categoria, recebedor inativo, estorno cruzado.
    expect(
      (
        await post(admin, F(`/weekly-closings/${WEEK}/payments`), {
          ...payBody,
          beneficiaryUserId: ids.ricardo,
        })
      ).status,
    ).toBe(422);
    await db().user.update({ where: { id: ids.izaias }, data: { active: false } });
    expect(
      (
        await post(admin, F(`/weekly-closings/${WEEK}/payments`), {
          ...payBody,
          beneficiaryUserId: ids.izaias,
        })
      ).status,
    ).toBe(422);
    const anyPay = await db().payablePayment.findFirstOrThrow();
    expect(
      (
        await post(admin, F(`/labor/${ric[0]!.id}/payments/${anyPay.id}/reverse`), {
          reason: 'Cruzado',
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await post(admin, F(`/weekly-closings/${WEEK}/payments`), { ...payBody, paidAt: day(3) }))
        .status,
    ).toBe(422);
  });
});

describe('Concorrência (CA7-11, 18)', () => {
  it('8. ajuste de custo durante a conferência e troca de titular durante o pagamento: estado sempre consistente', async () => {
    const { admin, ids, sos } = await exampleA();
    const cost = await db().logisticsCost.findFirstOrThrow({ where: { status: 'DEVIDO' } });
    const [conf, adj] = await Promise.all([
      post(admin, C(WEEK, '/confirm'), { version: 0 }),
      post(admin, F(`/logistics-costs/${cost.id}/adjustments`), {
        amountCents: 500,
        reason: 'Pedágio',
        version: cost.version,
      }),
    ]);
    expect(conf.status).toBe(200);
    expect(adj.status).toBe(200);
    const d = (await admin.get(C())).body;
    // Ou o ajuste entrou antes do retrato (sem divergência), ou depois (divergência apontada).
    const snapshotHasIt = d.divergent === false;
    expect(d.totals.dueCents).toBe(810500);
    if (!snapshotHasIt) expect(d.divergences.join(' ')).toContain('LG-');
    // Pagamento do Ricardo × substituição do titular de uma peça dele, ao mesmo tempo.
    const item = sos[0]!.items[0].id;
    const [pay, sub] = await Promise.all([
      post(admin, F(`/weekly-closings/${WEEK}/payments`), {
        beneficiaryUserId: ids.ricardo,
        category: 'TAPECARIA',
        amountCents: 350000,
        paidAt: today(),
        method: 'PIX',
      }),
      put(admin, `/api/v1/service-order-items/${item}/upholsterer`, {
        userId: ids.marcio,
        expectedUserId: ids.ricardo,
        reason: 'Troca concorrente',
        confirm: true,
      }),
    ]);
    expect(sub.status).toBe(200);
    const rows = await db().productionPayable.findMany({
      where: { professionalUserId: ids.ricardo },
    });
    for (const r of rows)
      expect(r.paidCents).toBeLessThanOrEqual(r.agreedCents + r.adjustmentsCents);
    const paid = await db().professionalPayment.aggregate({ _sum: { amountCents: true } });
    if (pay.status === 201) expect(paid._sum.amountCents).toBe(350000);
    else {
      expect(pay.status).toBe(422);
      expect(paid._sum.amountCents ?? 0).toBe(0);
    }
    const parts = await db().closingPaymentPart.aggregate({ _sum: { amountCents: true } });
    expect(parts._sum.amountCents ?? 0).toBe(paid._sum.amountCents ?? 0);
  });
});
