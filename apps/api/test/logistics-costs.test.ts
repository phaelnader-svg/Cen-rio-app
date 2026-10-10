import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
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
import { openServiceOrder } from './measurement-helpers';
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

/**
 * Evolução, Fase 6 — custos de retirada e entrega. Dados fictícios; valores em centavos.
 * André é o recebedor configurado; Izaías participa da execução sem ser credor.
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';

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
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const F = (path: string) => `/api/v1/finance${path}`;
const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown, key = idemKey()) =>
  c.req('PUT', path, body, { 'idempotency-key': key });
const moneyKeys = (v: unknown): string[] => {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object')
      for (const [k, val] of Object.entries(x)) {
        if (/cents$|price|revenue|margin|cost|valor|preco|amount|salary|payable/i.test(k))
          out.push(k);
        walk(val);
      }
  };
  walk(v);
  return out;
};

async function base() {
  const admin = await loginAdmin(app);
  const ids = {
    andre: await userIdOf('André'),
    izaias: await userIdOf('Izaías'),
    joao: await userIdOf('João'),
  };
  return { admin, ids };
}
async function setPayee(admin: Client, userId: string | null, pickup = 8000, delivery = 12000) {
  const r = await put(admin, F('/logistics-defaults'), {
    defaultPickupCostCents: pickup,
    defaultDeliveryCostCents: delivery,
    logisticsPayeeUserId: userId,
  });
  if (r.status !== 200) throw new Error(`defaults: ${JSON.stringify(r.body)}`);
  return r.body;
}
/** Pedido com retirada agendada (sem custo). */
async function pickupOf(admin: Client, name = 'Cliente Retirada', tripCost?: unknown) {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(admin, customer);
  if (!tripCost) return { order, customer, pickup: await createPickup(admin, order, day(2)) };
  const r = await post(admin, '/api/v1/pickups', {
    orderId: order.id,
    scheduledDate: day(2),
    windowStart: '09:00',
    windowEnd: '12:00',
    team: 'LOGISTICA_TERCEIRIZADA',
    items: order.items.map((i: { id: string; quantity: number }) => ({
      orderItemId: i.id,
      quantity: i.quantity,
    })),
    tripCost,
  });
  return { order, customer, pickup: r.body, res: r };
}
const tripCost = (admin: Client, body: Record<string, unknown>, key = idemKey()) =>
  put(admin, F('/trip-costs'), body, key);
const view = async (admin: Client, q: string) => (await admin.get(F(`/trip-costs?${q}`))).body;
async function step(admin: Client, pickupId: string, toStatus: string, note?: string) {
  const p = (await admin.get(`/api/v1/pickups/${pickupId}`)).body;
  const r = await post(admin, `/api/v1/pickups/${pickupId}/transition`, {
    toStatus,
    version: p.version,
    ...(note ? { note } : {}),
  });
  if (r.status !== 200) throw new Error(`transition ${toStatus}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const realize = async (admin: Client, pickupId: string) => {
  await step(admin, pickupId, 'EM_EXECUCAO');
  return step(admin, pickupId, 'RETIRADA_REALIZADA');
};
const costOf = (pickupId: string) =>
  db().logisticsCost.findFirstOrThrow({ where: { pickupId, kind: 'RETIRADA' } });

// ───────────────────────────────────────────────────────────────────────────

describe('Padrões, valor total e recebedor (CA6-01..04)', () => {
  it('1. padrões distintos sugeridos; mudar o padrão não muda viagens registradas; RBAC e auditoria', async () => {
    const { admin, ids } = await base();
    const viewer = await panelUserWith(app, admin, 'fin-ver', ['financeiro.ver']);
    expect(
      (
        await put(viewer, F('/logistics-defaults'), {
          defaultPickupCostCents: 1,
          defaultDeliveryCostCents: 1,
          logisticsPayeeUserId: null,
        })
      ).status,
    ).toBe(403);
    for (const bad of [0, -5, 10.5, 10_000_001])
      expect(
        (
          await put(admin, F('/logistics-defaults'), {
            defaultPickupCostCents: bad,
            defaultDeliveryCostCents: null,
            logisticsPayeeUserId: null,
          })
        ).status,
        String(bad),
      ).toBe(400);
    const d = await setPayee(admin, ids.andre, 8000, 12000);
    expect(d).toMatchObject({
      defaultPickupCostCents: 8000,
      defaultDeliveryCostCents: 12000,
      payee: { userId: ids.andre, displayName: 'André', active: true },
    });
    expect(d.people.map((p: { displayName: string }) => p.displayName)).toEqual(
      expect.arrayContaining(['André', 'Izaías']),
    );
    const { pickup } = await pickupOf(admin);
    expect((await view(admin, `pickupId=${pickup.id}`)).suggestedCents).toBe(8000);
    expect((await tripCost(admin, { pickupId: pickup.id, amountCents: 8000 })).status).toBe(200);
    await setPayee(admin, ids.andre, 9900, 15000);
    expect((await costOf(pickup.id)).amountCents).toBe(8000);
    const { pickup: p2 } = await pickupOf(admin, 'Cliente Novo Padrão');
    expect((await view(admin, `pickupId=${p2.id}`)).suggestedCents).toBe(9900);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'finance.logistics_defaults' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.changes).toMatchObject({ defaultPickupCostCents: { from: 8000, to: 9900 } });
    // Recebedor precisa ser funcionário ativo.
    await db().user.update({ where: { id: ids.izaias }, data: { active: false } });
    expect(
      (
        await put(admin, F('/logistics-defaults'), {
          defaultPickupCostCents: null,
          defaultDeliveryCostCents: null,
          logisticsPayeeUserId: ids.izaias,
        })
      ).status,
    ).toBe(422);
  });

  it('2. André + Izaías por R$ 100: custo R$ 100 (não 200); só André é credor; Izaías participante', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup, res } = await pickupOf(admin, 'Cliente Dois Participantes', {
      amountCents: 10000,
      participantUserIds: [ids.andre, ids.izaias],
    });
    expect(res!.status).toBe(201);
    let v = await view(admin, `pickupId=${pickup.id}`);
    expect(v.cost).toMatchObject({
      amountCents: 10000,
      status: 'PREVISTO',
      situation: 'COMBINADO',
      dueCents: 0,
      payable: null,
    });
    expect(v.cost.participants.map((p: { displayName: string }) => p.displayName).sort()).toEqual([
      'André',
      'Izaías',
    ]);
    expect(await db().logisticsCost.count()).toBe(1);
    expect(await db().accountPayable.count()).toBe(0);
    await realize(admin, pickup.id);
    v = await view(admin, `pickupId=${pickup.id}`);
    expect(v.cost).toMatchObject({
      status: 'DEVIDO',
      dueCents: 10000,
      payee: { userId: ids.andre },
      situation: 'DEVIDO',
    });
    const payables = await db().accountPayable.findMany();
    expect(payables).toHaveLength(1);
    expect(payables[0]).toMatchObject({
      beneficiary: 'André',
      amountCents: 10000,
      category: 'LOGISTICA',
    });
    expect(await db().logisticsCost.count({ where: { payeeUserId: ids.izaias } })).toBe(0);
    // Histórico: quem executou, quem recebe, quem autorizou e quando.
    const hist = v.cost.history.map((h: { kind: string }) => h.kind);
    expect(hist).toEqual(expect.arrayContaining(['COMBINADO', 'DEVIDO']));
    expect(v.cost.dueAt).not.toBeNull();
  });

  it('3. validação no backend: zero, negativo, fração, NaN, texto e estouro; permissão do financeiro', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup } = await pickupOf(admin);
    for (const amountCents of [0, -100, 10.5, null, 'abc', 10_000_001, 2 ** 40])
      expect(
        (await tripCost(admin, { pickupId: pickup.id, amountCents })).status,
        String(amountCents),
      ).toBe(400);
    expect(await db().logisticsCost.count()).toBe(0);
    // Agendador sem permissão do financeiro não informa custo (nem pela retirada).
    const sched = await panelUserWith(app, admin, 'agenda', [
      'retiradas.ver',
      'retiradas.gerenciar',
    ]);
    expect((await tripCost(sched, { pickupId: pickup.id, amountCents: 100 })).status).toBe(403);
    const customer = await createCustomer(admin, {
      name: 'Cliente Sem Fin',
      phone: null,
      allowSimilar: true,
    });
    const order = await createOrder(admin, customer);
    const r = await post(sched, '/api/v1/pickups', {
      orderId: order.id,
      scheduledDate: day(2),
      windowStart: '09:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
      tripCost: { amountCents: 100 },
    });
    expect(r.status).toBe(403);
    expect(await db().pickupRequest.count({ where: { orderId: order.id } })).toBe(0);
    // Participante inativo recusado.
    await db().user.update({ where: { id: ids.izaias }, data: { active: false } });
    expect(
      (
        await tripCost(admin, {
          pickupId: pickup.id,
          amountCents: 100,
          participantUserIds: [ids.izaias],
        })
      ).status,
    ).toBe(422);
  });
});

describe('Ciclo de vida (CA6-05..08)', () => {
  it('4. agendar não libera; a realização constitui o devido uma única vez', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { order, pickup } = await pickupOf(admin);
    await tripCost(admin, {
      pickupId: pickup.id,
      amountCents: 10000,
      participantUserIds: [ids.andre],
    });
    await step(admin, pickup.id, 'EM_EXECUCAO');
    expect((await costOf(pickup.id)).status).toBe('PREVISTO');
    expect(await db().accountPayable.count()).toBe(0);
    await step(admin, pickup.id, 'RETIRADA_REALIZADA');
    expect((await costOf(pickup.id)).status).toBe('DEVIDO');
    // Recebimento na oficina (RECEBIDA_NA_OFICINA) não constitui de novo.
    const rec = await post(
      admin,
      '/api/v1/receipts',
      receiptBody(
        order.id,
        order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        pickup.id,
      ),
    );
    expect(rec.status).toBe(201);
    expect((await db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })).status).toBe(
      'RECEBIDA_NA_OFICINA',
    );
    expect(await db().accountPayable.count()).toBe(1);
    const c = await costOf(pickup.id);
    expect(await db().financialEvent.count({ where: { entityId: c.id, kind: 'DEVIDO' } })).toBe(1);
    // Depois de devido, o combinado não é sobrescrito: só ajuste.
    const edit = await tripCost(admin, {
      pickupId: pickup.id,
      amountCents: 9000,
      reason: 'Tentativa de sobrescrever',
      version: c.version,
    });
    expect(edit.status).toBe(422);
    // Retirada recebida direto (sem passos da logística) também constitui.
    const other = await pickupOf(admin, 'Cliente Recebido Direto');
    await tripCost(admin, { pickupId: other.pickup.id, amountCents: 5000 });
    await post(
      admin,
      '/api/v1/receipts',
      receiptBody(
        other.order.id,
        other.order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        other.pickup.id,
      ),
    );
    expect((await costOf(other.pickup.id)).status).toBe('DEVIDO');
  });

  it('5. cancelar antes da realização não gera valor devido (retirada e pedido cancelados)', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const a = await pickupOf(admin, 'Cliente Cancela');
    await tripCost(admin, { pickupId: a.pickup.id, amountCents: 7000 });
    await step(admin, a.pickup.id, 'CANCELADA', 'Cliente desistiu');
    expect(await costOf(a.pickup.id)).toMatchObject({ status: 'CANCELADO', payableId: null });
    expect((await tripCost(admin, { pickupId: a.pickup.id, amountCents: 7000 })).status).toBe(422);
    const b = await pickupOf(admin, 'Cliente Pedido Cancelado');
    await tripCost(admin, { pickupId: b.pickup.id, amountCents: 6000 });
    const order = (await admin.get(`/api/v1/orders/${b.order.id}`)).body;
    const cancel = await post(admin, `/api/v1/orders/${b.order.id}/cancel`, {
      reason: 'Pedido desfeito',
      version: order.version,
    });
    expect(cancel.status).toBe(200);
    expect((await costOf(b.pickup.id)).status).toBe('CANCELADO');
    expect(await db().accountPayable.count()).toBe(0);
  });

  it('6. tentativa frustrada: nada devido sem autorização; taxa explícita; não simula realização', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup } = await pickupOf(admin);
    await tripCost(admin, {
      pickupId: pickup.id,
      amountCents: 10000,
      participantUserIds: [ids.andre, ids.izaias],
    });
    expect(
      (
        await post(admin, F('/trip-costs/fee'), {
          pickupId: pickup.id,
          amountCents: 3000,
          reason: 'Antes',
        })
      ).status,
    ).toBe(422); // viagem não frustrada
    await step(admin, pickup.id, 'EM_EXECUCAO');
    await step(admin, pickup.id, 'COM_OCORRENCIA', 'Cliente ausente');
    expect((await costOf(pickup.id)).status).toBe('PREVISTO');
    expect(await db().accountPayable.count()).toBe(0);
    const operator = await panelUserWith(app, admin, 'fin-op', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    expect(
      (
        await post(operator, F('/trip-costs/fee'), {
          pickupId: pickup.id,
          amountCents: 3000,
          reason: 'Ida perdida',
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(admin, F('/trip-costs/fee'), { pickupId: pickup.id, amountCents: 3000 })).status,
    ).toBe(400);
    const fee = await post(admin, F('/trip-costs/fee'), {
      pickupId: pickup.id,
      amountCents: 3000,
      reason: 'Deslocamento perdido, autorizado pelo gestor',
    });
    expect(fee.status).toBe(200);
    expect(fee.body.cost).toMatchObject({ status: 'PREVISTO', dueCents: 0 });
    expect(fee.body.fees).toHaveLength(1);
    expect(fee.body.fees[0]).toMatchObject({
      kind: 'TENTATIVA_FRUSTRADA',
      status: 'DEVIDO',
      dueCents: 3000,
      payee: { userId: ids.andre },
    });
    // Segunda frustração soma à mesma taxa (ajuste autorizado), sem nova obrigação.
    const fee2 = await post(admin, F('/trip-costs/fee'), {
      pickupId: pickup.id,
      amountCents: 1000,
      reason: 'Segunda ida perdida',
    });
    expect(fee2.body.fees).toHaveLength(1);
    expect(fee2.body.fees[0].dueCents).toBe(4000);
    expect(await db().accountPayable.count()).toBe(1);
    // Reagendada e realizada: o serviço vira devido; a taxa continua separada.
    await step(admin, pickup.id, 'AGENDADA');
    await realize(admin, pickup.id);
    const v = await view(admin, `pickupId=${pickup.id}`);
    expect(v.cost).toMatchObject({ status: 'DEVIDO', dueCents: 10000 });
    expect(await db().accountPayable.count()).toBe(2);
    const sum = await db().accountPayable.aggregate({ _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(14000);
  });

  it('7. reagendar várias vezes preserva um único serviço/obrigação; criação concorrente não duplica', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup, order } = await pickupOf(admin);
    const both = await Promise.all([
      tripCost(admin, { pickupId: pickup.id, amountCents: 10000 }),
      tripCost(admin, { pickupId: pickup.id, amountCents: 10000 }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    for (const d of [3, 4, 5]) {
      const p = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
      const r = await admin.put(`/api/v1/pickups/${pickup.id}`, {
        scheduledDate: day(d),
        windowStart: '13:00',
        windowEnd: '15:00',
        team: 'LOGISTICA_TERCEIRIZADA',
        items: order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        version: p.version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect(await db().logisticsCost.count()).toBe(1);
    expect((await costOf(pickup.id)).amountCents).toBe(10000);
    // Realização concorrente (mesma versão): uma vence; uma obrigação.
    await step(admin, pickup.id, 'EM_EXECUCAO');
    const p = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
    const r = await Promise.all([
      post(admin, `/api/v1/pickups/${pickup.id}/transition`, {
        toStatus: 'RETIRADA_REALIZADA',
        version: p.version,
      }),
      post(admin, `/api/v1/pickups/${pickup.id}/transition`, {
        toStatus: 'RETIRADA_REALIZADA',
        version: p.version,
      }),
    ]);
    expect(r.filter((x) => x.status === 200)).toHaveLength(1);
    expect(await db().accountPayable.count()).toBe(1);
  });
});

/** Cliente com N OS abertas (peças recebidas). */
async function sameCustomerOrders(admin: Client, n: number) {
  const customer = await createCustomer(admin, {
    name: 'Cliente Rota Única',
    phone: null,
    allowSimilar: true,
  });
  const sos = [];
  for (let k = 0; k < n; k++) {
    const order = await createOrder(admin, customer, [
      { pieceType: 'POLTRONA', description: `Poltrona ${k + 1}`, quantity: 1 },
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
          description: `Poltrona ${k + 1}`,
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    });
    if (so.status !== 201) throw new Error(JSON.stringify(so.body));
    sos.push(so.body);
  }
  return { customer, sos };
}

describe('Rateio e OS (CA6-09, 10)', () => {
  it('8. R$ 100 entre três OS: 33,34 + 33,33 + 33,33 = 100,00; remover OS refaz com histórico', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { customer, sos } = await sameCustomerOrders(admin, 3);
    const d = await post(admin, '/api/v1/deliveries', {
      customerId: customer.id,
      scheduledDate: day(3),
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: ids.andre,
      itemIds: sos.map((s) => s.items[0].id),
      provisional: true,
      tripCost: { amountCents: 10000, participantUserIds: [ids.andre, ids.izaias] },
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    let v = await view(admin, `deliveryId=${d.body.id}`);
    expect(
      v.cost.allocations.map((a: { code: string; amountCents: number }) => [a.code, a.amountCents]),
    ).toEqual([
      [sos[0].code, 3334],
      [sos[1].code, 3333],
      [sos[2].code, 3333],
    ]);
    // Margem: previsto inclui o combinado; realizado ainda não.
    const r0 = (await admin.get(F(`/service-orders/${sos[0].id}`))).body;
    expect(r0.forecast.logisticsCents).toBe(3334);
    expect(r0.actual.logisticsCents).toBe(0);
    // Remove a terceira OS da viagem (com motivo): novo rateio, anterior preservado.
    const full = (await admin.get(`/api/v1/deliveries/${d.body.id}`)).body;
    const upd = await admin.put(`/api/v1/deliveries/${d.body.id}`, {
      scheduledDate: day(3),
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: ids.andre,
      itemIds: [sos[0].items[0].id, sos[1].items[0].id],
      reason: 'Terceira poltrona fica para outra viagem',
      version: full.version,
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    v = await view(admin, `deliveryId=${d.body.id}`);
    expect(v.cost.allocations.map((a: { amountCents: number }) => a.amountCents)).toEqual([
      5000, 5000,
    ]);
    expect(v.cost.amountCents).toBe(10000);
    expect(await db().logisticsCostAllocation.count()).toBe(5);
    await expect(db().logisticsCostAllocation.deleteMany()).rejects.toThrow();
    const ev = v.cost.history.find(
      (h: { kind: string; note?: string | null }) =>
        h.kind === 'RATEIO' && /Terceira/.test(h.note ?? ''),
    );
    expect(ev).toBeTruthy();
    expect((await admin.get(F(`/service-orders/${sos[2].id}`))).body.forecast.logisticsCents).toBe(
      0,
    );
  });

  it('9. OS criada após pagamento: só o rateio muda; obrigação e pagamento intactos', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup, order } = await pickupOf(admin);
    await tripCost(admin, { pickupId: pickup.id, amountCents: 9000 });
    await realize(admin, pickup.id);
    const c = await costOf(pickup.id);
    expect(c.allocationRevision).toBe(0); // pedido ainda sem OS: rateio pendente
    const p = (await admin.get(F(`/payables/${c.payableId}`))).body;
    await post(admin, F(`/payables/${p.id}/payments`), {
      amountCents: 9000,
      paidAt: today(),
      method: 'PIX',
      version: p.version,
    });
    await post(
      admin,
      '/api/v1/receipts',
      receiptBody(
        order.id,
        order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        pickup.id,
      ),
    );
    const so = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: order.items.map((i: { id: string; quantity: number; description?: string }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
        description: 'Peça recebida',
        serviceType: 'REFORMA_COMPLETA',
      })),
    });
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    const after = await db().accountPayable.findUniqueOrThrow({ where: { id: c.payableId! } });
    expect(after).toMatchObject({ amountCents: 9000, paidCents: 9000, status: 'PAGO' });
    const r = (await admin.get(F(`/service-orders/${so.body.id}`))).body;
    expect(r.actual.logisticsCents).toBe(9000);
  });
});

describe('Pagamento, ajuste e estorno (CA6-11, 12)', () => {
  it('10. parcial e integral abatem a mesma obrigação; repetição idempotente; nunca acima do saldo', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup } = await pickupOf(admin);
    await tripCost(admin, { pickupId: pickup.id, amountCents: 10000 });
    await realize(admin, pickup.id);
    const c = await costOf(pickup.id);
    let p = (await admin.get(F(`/payables/${c.payableId}`))).body;
    const key = idemKey();
    const body = { amountCents: 4000, paidAt: today(), method: 'PIX', version: p.version };
    const a = await post(admin, F(`/payables/${p.id}/payments`), body, key);
    const b = await post(admin, F(`/payables/${p.id}/payments`), body, key);
    expect(a.body).toMatchObject({ status: 'PARCIAL', paidCents: 4000, openCents: 6000 });
    expect(b.body).toEqual(a.body);
    p = a.body;
    expect(
      (
        await post(admin, F(`/payables/${p.id}/payments`), {
          ...body,
          amountCents: 6001,
          version: p.version,
        })
      ).status,
    ).toBe(422);
    const full = await post(admin, F(`/payables/${p.id}/payments`), {
      ...body,
      amountCents: 6000,
      version: p.version,
    });
    expect(full.body).toMatchObject({ status: 'PAGO', paidCents: 10000, openCents: 0 });
    expect(await db().accountPayable.count()).toBe(1);
    expect(await db().operationalExpense.count()).toBe(0);
    expect(await db().payablePayment.count()).toBe(2);
    expect((await view(admin, `pickupId=${pickup.id}`)).cost.situation).toBe('PAGO');
  });

  it('11. após pagamento: ajuste nunca abaixo do pago; estorno auditável; histórico preservado', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const { pickup } = await pickupOf(admin);
    await tripCost(admin, { pickupId: pickup.id, amountCents: 10000 });
    await realize(admin, pickup.id);
    let c = await costOf(pickup.id);
    let p = (await admin.get(F(`/payables/${c.payableId}`))).body;
    p = (
      await post(admin, F(`/payables/${p.id}/payments`), {
        amountCents: 10000,
        paidAt: today(),
        method: 'PIX',
        version: p.version,
      })
    ).body;
    const below = await post(admin, F(`/logistics-costs/${c.id}/adjustments`), {
      amountCents: -2000,
      reason: 'Combinado era menor',
      version: c.version,
    });
    expect(below.status).toBe(422);
    // Cancelar a conta diretamente é recusado (a correção passa pelo custo).
    expect(
      (
        await post(admin, F(`/payables/${p.id}/cancel`), {
          reason: 'x'.repeat(5),
          version: p.version,
        })
      ).status,
    ).toBe(422);
    const viewer = await panelUserWith(app, admin, 'fin-op', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    const payId = p.payments[0].id;
    expect(
      (
        await post(viewer, F(`/payables/${p.id}/payments/${payId}/reverse`), {
          reason: 'Pago em duplicidade',
          version: p.version,
        })
      ).status,
    ).toBe(403);
    const rev = await post(admin, F(`/payables/${p.id}/payments/${payId}/reverse`), {
      reason: 'PIX devolvido pelo banco',
      version: p.version,
    });
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ paidCents: 0, status: 'ABERTO' });
    expect(rev.body.payments[0].reversal).toMatchObject({ reason: 'PIX devolvido pelo banco' });
    expect(
      (
        await post(admin, F(`/payables/${p.id}/payments/${payId}/reverse`), {
          reason: 'De novo',
          version: rev.body.version,
        })
      ).status,
    ).toBe(409);
    c = await costOf(pickup.id);
    const adj = await post(admin, F(`/logistics-costs/${c.id}/adjustments`), {
      amountCents: -2000,
      reason: 'Combinado era R$ 80',
      version: c.version,
    });
    expect(adj.status).toBe(200);
    expect(adj.body).toMatchObject({ amountCents: 10000, adjustmentsCents: -2000, dueCents: 8000 });
    expect((await db().accountPayable.findUniqueOrThrow({ where: { id: p.id } })).amountCents).toBe(
      8000,
    );
    // Registros imutáveis.
    await expect(db().payablePayment.deleteMany()).rejects.toThrow();
    await expect(db().payablePaymentReversal.deleteMany()).rejects.toThrow();
    await expect(db().logisticsCostAdjustment.deleteMany()).rejects.toThrow();
    expect(await db().payablePayment.count()).toBe(1);
    expect(await db().auditLog.count({ where: { action: 'finance.trip_cost_adjusted' } })).toBe(1);
    expect(
      await db().auditLog.count({ where: { action: 'finance.payable_payment_reversed' } }),
    ).toBe(1);
    // Lançamento avulso de retirada de uma viagem cadastrada: recusado (fonte única).
    const manual = await post(admin, F('/logistics-costs'), {
      kind: 'RETIRADA',
      description: 'Avulso',
      amountCents: 5000,
      date: today(),
      pickupId: pickup.id,
      splitMethod: 'IGUAL',
      allocations: [],
    });
    expect([400, 422]).toContain(manual.status);
  });
});

describe('Recebedor ausente, segurança e semana (C2, CA6-13, CA6-15)', () => {
  it('12. sem recebedor ativo: devido sem conta a pagar e aviso ao gestor; configurado depois, gera uma vez', async () => {
    const { admin, ids } = await base();
    const { pickup } = await pickupOf(admin);
    await tripCost(admin, {
      pickupId: pickup.id,
      amountCents: 10000,
      participantUserIds: [ids.andre],
    });
    await realize(admin, pickup.id);
    let c = await costOf(pickup.id);
    expect(c).toMatchObject({
      status: 'DEVIDO',
      payableId: null,
      pendingReason: 'RECEBEDOR_AUSENTE',
    });
    expect((await view(admin, `pickupId=${pickup.id}`)).cost.situation).toBe('PENDENTE_RECEBEDOR');
    const gestor =
      (await admin.get('/api/auth/me')).body.user?.id ?? (await admin.get('/api/auth/me')).body.id;
    expect(
      await db().notification.count({
        where: { dedupeKey: { startsWith: 'LOGISTICA_SEM_RECEBEDOR' } },
      }),
    ).toBeGreaterThan(0);
    void gestor;
    // Recebedor inativo: continua pendente (nunca escolhe outro).
    await setPayee(admin, ids.andre);
    await db().user.update({ where: { id: ids.andre }, data: { active: false } });
    await post(admin, F(`/logistics-costs/${c.id}/constitute`));
    expect((await costOf(pickup.id)).payableId).toBeNull();
    await db().user.update({ where: { id: ids.andre }, data: { active: true } });
    const both = await Promise.all([
      post(admin, F(`/logistics-costs/${c.id}/constitute`)),
      post(admin, F(`/logistics-costs/${c.id}/constitute`)),
    ]);
    expect(both.every((r) => r.status === 200)).toBe(true);
    c = await costOf(pickup.id);
    expect(c.payableId).not.toBeNull();
    expect(await db().accountPayable.count()).toBe(1);
  });

  it('13. André, Izaías, tablets e usuários sem financeiro não veem custos; sem vazamento por WS', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const izaias = (
      await setupTablet(app, admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '552211' })
    ).tablet;
    const wsA = track(await WsClient.connect(app, andre));
    const wsAdmin = track(await WsClient.connect(app, admin));
    const { pickup } = await pickupOf(admin);
    await tripCost(admin, {
      pickupId: pickup.id,
      amountCents: 10000,
      participantUserIds: [ids.andre, ids.izaias],
    });
    const p = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
    await put(admin, `/api/v1/pickups/${pickup.id}/logistics`, {
      logisticsUserId: ids.andre,
      version: p.version,
    });
    // André executa pelo celular: saída e retirada realizada (constitui o devido).
    const cur = await db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } });
    const s1 = await post(andre, `/api/v1/logistics/pickups/${pickup.id}/step`, {
      step: 'SAIDA',
      version: cur.version,
    });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    const cur2 = await db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } });
    const s2 = await post(andre, `/api/v1/logistics/pickups/${pickup.id}/step`, {
      step: 'RETIRADA_REALIZADA',
      version: cur2.version,
    });
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    expect((await costOf(pickup.id)).status).toBe('DEVIDO');
    await wsAdmin.waitFor((m) => /finance\./.test(String(m.event?.type)));
    const plain = await panelUserWith(app, admin, 'entregas', ['entregas.ver', 'retiradas.ver']);
    for (const c of [andre, izaias, plain])
      for (const path of [
        F(`/trip-costs?pickupId=${pickup.id}`),
        F('/logistics-costs'),
        F(`/logistics-weekly?from=${day(-7)}&to=${day(7)}`),
        F('/logistics-defaults'),
        F('/payables'),
        F('/reports/custos?from=2026-01-01&to=2026-12-31&format=csv'),
      ]) {
        const r = await c.get(path);
        expect(r.status, path).toBe(403);
      }
    for (const c of [andre, izaias])
      for (const path of [
        '/api/v1/logistics/jobs',
        '/api/auth/me',
        '/api/v1/notifications?limit=50',
      ]) {
        const r = await c.get(path);
        if (r.status >= 400) continue;
        expect(moneyKeys(r.body), path).toEqual([]);
      }
    for (const path of [`/api/v1/pickups/${pickup.id}`, '/api/v1/logistics/jobs'])
      expect(moneyKeys((await plain.get(path)).body), path).toEqual([]);
    expect(moneyKeys(wsA.messages)).toEqual([]);
    expect(JSON.stringify(wsA.messages)).not.toMatch(/finance\.|10000/);
  });

  it('14. semana do fato gerador (realização) no fuso da oficina; agendamento em outra semana não conta', async () => {
    const { admin, ids } = await base();
    await setPayee(admin, ids.andre);
    const mk = async (name: string) => {
      const { pickup } = await pickupOf(admin, name);
      await tripCost(admin, { pickupId: pickup.id, amountCents: 10000 });
      await realize(admin, pickup.id);
      return costOf(pickup.id);
    };
    const a = await mk('Cliente Domingo');
    const b = await mk('Cliente Segunda');
    const c = await mk('Cliente Pendente');
    // Domingo 2026-10-04 23:30 local (= segunda 02:30 UTC) → semana de 2026-09-28.
    await db().logisticsCost.update({
      where: { id: a.id },
      data: {
        dueAt: zonedDateTime('2026-10-04', '23:30', TZ),
        date: new Date('2026-09-20T00:00:00Z'),
      },
    });
    // Segunda 2026-10-05 00:10 local → semana de 2026-10-05.
    await db().logisticsCost.update({
      where: { id: b.id },
      data: { dueAt: zonedDateTime('2026-10-05', '00:10', TZ) },
    });
    await db().logisticsCost.update({
      where: { id: c.id },
      data: { dueAt: zonedDateTime('2026-10-20', '10:00', TZ) },
    });
    const pb = (await admin.get(F(`/payables/${b.payableId}`))).body;
    await post(admin, F(`/payables/${pb.id}/payments`), {
      amountCents: 2500,
      paidAt: today(),
      method: 'PIX',
      version: pb.version,
    });
    const w = (
      await admin.get(F(`/logistics-weekly?from=2026-09-28&to=2026-10-11&payeeUserId=${ids.andre}`))
    ).body;
    expect(w.timezone).toBe(TZ);
    expect(
      w.items.map((i: { code: string; factDate: string; weekStart: string }) => [
        i.factDate,
        i.weekStart,
      ]),
    ).toEqual([
      ['2026-10-04', '2026-09-28'],
      ['2026-10-05', '2026-10-05'],
    ]);
    expect(w.weeks).toEqual([
      expect.objectContaining({
        weekStart: '2026-09-28',
        dueCents: 10000,
        paidCents: 0,
        openCents: 10000,
        items: 1,
      }),
      expect.objectContaining({
        weekStart: '2026-10-05',
        dueCents: 10000,
        paidCents: 2500,
        openCents: 7500,
        items: 1,
      }),
    ]);
    // Limite: domingo 23:30 fica fora de um período que começa na segunda.
    const only = (await admin.get(F('/logistics-weekly?from=2026-10-05&to=2026-10-11'))).body;
    expect(only.items).toHaveLength(1);
    expect((await admin.get(F('/logistics-weekly?from=2026-10-11&to=2026-10-05'))).status).toBe(
      400,
    );
  });
});

describe('Entrega completa (CA6-02, 05, 07 pela entrega)', () => {
  it('15. entrega concluída por André constitui; frustrada não; reagendada continua única', async () => {
    const admin = await loginAdmin(app);
    const ids = {
      andre: await userIdOf('André'),
      izaias: await userIdOf('Izaías'),
      ricardo: await userIdOf('Ricardo'),
    };
    await setPayee(admin, ids.andre);
    await db().companySettings.update({
      where: { id: 1 },
      data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
    });
    setAttendanceClock(() => zonedDateTime(today(), '08:00', TZ));
    const so = await openServiceOrder(admin, 'Cliente Entrega');
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
    const task = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      date: day(-1),
      time: '08:00',
      activity: 'REVESTIMENTO',
      title: 'Sofá',
      serviceOrderItemId: so.items[0].id,
      role: 'PRINCIPAL',
      assigneeUserId: ids.ricardo,
    });
    await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const thiago = await tabletOf(app, admin, 'Thiago', '271828');
    const joao = await tabletOf(app, admin, 'João', '121212');
    setAttendanceClock(() => zonedDateTime(today(), '08:30', TZ));
    for (const t of [ricardo, thiago, joao]) await post(t, '/api/v1/attendance/me/arrive');
    setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ));
    await act(ricardo, task.body.id, 'start');
    await act(ricardo, task.body.id, 'complete', { note: 'ok' });
    const insp = await db().qualityInspection.findFirstOrThrow({
      where: { serviceOrderItemId: so.items[0].id },
    });
    let i = (await thiago.get(`/api/v1/quality/inspections/${insp.id}`)).body;
    for (const it of i.items)
      await thiago.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
        result: 'OK',
        note: null,
      });
    i = (await thiago.get(`/api/v1/quality/inspections/${insp.id}`)).body;
    expect(
      (await post(thiago, `/api/v1/quality/inspections/${i.id}/approve`, { version: i.version }))
        .status,
    ).toBe(200);
    const pack = await db().packagingRecord.findFirstOrThrow({
      where: { serviceOrderItemId: so.items[0].id },
    });
    const loc = (await db().itemLocation.findUniqueOrThrow({ where: { key: 'EXPEDICAO' } })).id;
    expect(
      (
        await post(joao, `/api/v1/packaging/${pack.id}/complete`, {
          protection: 'PLASTICO_BOLHA',
          locationId: loc,
          version: pack.version,
        })
      ).status,
    ).toBe(200);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }))
      .customerId;
    const d = await post(admin, '/api/v1/deliveries', {
      customerId,
      scheduledDate: day(1),
      windowStart: '10:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: ids.andre,
      itemIds: [so.items[0].id],
      tripCost: { amountCents: 10000, participantUserIds: [ids.andre, ids.izaias] },
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    // 1ª tentativa frustrada: nada devido.
    let dep = await post(andre, `/api/v1/deliveries/${d.body.id}/depart`, {
      version: d.body.version,
    });
    let arr = await post(andre, `/api/v1/deliveries/${d.body.id}/arrive`, {
      version: dep.body.version,
    });
    const fr = await post(andre, `/api/v1/deliveries/${d.body.id}/frustrate`, {
      kind: 'CLIENTE_INDISPONIVEL',
      reason: 'Ninguém em casa',
      version: arr.body.version,
    });
    expect(fr.status).toBe(200);
    let v = await view(admin, `deliveryId=${d.body.id}`);
    expect(v.cost).toMatchObject({ status: 'PREVISTO', dueCents: 0 });
    expect(await db().accountPayable.count()).toBe(0);
    // Reagendada (mesmo custo) e concluída.
    const full = (await admin.get(`/api/v1/deliveries/${d.body.id}`)).body;
    const again = await admin.put(`/api/v1/deliveries/${d.body.id}`, {
      scheduledDate: day(2),
      windowStart: '10:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: ids.andre,
      itemIds: [so.items[0].id],
      reason: 'Cliente pediu outro dia',
      version: full.version,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    dep = await post(andre, `/api/v1/deliveries/${d.body.id}/depart`, {
      version: again.body.version,
    });
    arr = await post(andre, `/api/v1/deliveries/${d.body.id}/arrive`, {
      version: dep.body.version,
    });
    const items = await post(andre, `/api/v1/deliveries/${d.body.id}/items`, {
      items: [{ serviceOrderItemId: so.items[0].id, status: 'ENTREGUE' }],
      version: arr.body.version,
    });
    const done = await post(andre, `/api/v1/deliveries/${d.body.id}/complete`, {
      version: items.body.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    v = await view(admin, `deliveryId=${d.body.id}`);
    expect(v.cost).toMatchObject({
      status: 'DEVIDO',
      dueCents: 10000,
      payee: { userId: ids.andre },
    });
    expect(await db().logisticsCost.count()).toBe(1);
    expect(await db().accountPayable.count()).toBe(1);
    const r = (await admin.get(F(`/service-orders/${so.id}`))).body;
    expect(r.actual.logisticsCents).toBe(10000);
    // André não vê o valor nos próprios trabalhos.
    expect(moneyKeys((await andre.get('/api/v1/logistics/jobs')).body)).toEqual([]);
  });
});
