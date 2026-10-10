import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';
import {
  createCustomer,
  createOrder,
  createPickup,
  panelUserWith,
  receiptBody,
} from './commercial-helpers';
import { day, userIdOf } from './production-helpers';

/**
 * Correção global de interface, OS e logística — dados fictícios, valores em centavos.
 *  A. OS criada com titular e mão de obra por peça NA MESMA transação (atômica), permissões,
 *     idempotência, sem duplicar obrigação e sem liberar pagamento.
 *  B. Agendamento por HORÁRIO DE CHEGADA (retirada e entrega), solicitação sem horário,
 *     valor total da equipe e responsável já na solicitação.
 *  C. Roteiro diário: ordem, visibilidade por pessoa, sequência sem mexer no compromisso,
 *     conflitos, concorrência (409), histórico e remarcação.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
});

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown, key = idemKey()) =>
  c.req('PUT', path, body, { 'idempotency-key': key });

/** Pedido com 2 peças recebidas (sofá + 2 poltronas), pronto para a OS. */
async function receivedOrder(admin: Client, name = 'Cliente OS Completa') {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(admin, customer, [
    { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
    { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
  ]);
  const rec = await post(
    admin,
    '/api/v1/receipts',
    receiptBody(
      order.id,
      order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    ),
  );
  if (rec.status !== 201) throw new Error(`receipt: ${JSON.stringify(rec.body)}`);
  return { customer, order };
}

function osBody(
  order: { id: string; items: { id: string }[] },
  extra: [Record<string, unknown>, Record<string, unknown>] = [{}, {}],
) {
  return {
    orderId: order.id,
    items: [
      {
        orderItemId: order.items[0]!.id,
        quantity: 1,
        description: 'Sofá 3 lugares',
        serviceType: 'REFORMA_COMPLETA',
        ...extra[0],
      },
      {
        orderItemId: order.items[1]!.id,
        quantity: 2,
        description: 'Poltronas',
        serviceType: 'TROCA_DE_TECIDO',
        ...extra[1],
      },
    ],
  };
}

describe('A. Nova OS: titular e mão de obra por peça, atômica (CA-08..12, CA-24)', () => {
  it('cria OS com dois tapeceiros, valor por peça, sem pagamento e sem duplicar', async () => {
    const admin = await loginAdmin(app);
    const ric = await userIdOf('Ricardo');
    const mar = await userIdOf('Márcio');
    const { order } = await receivedOrder(admin);
    const avail = (await admin.get(`/api/v1/service-orders/available?orderId=${order.id}`)).body;
    expect(avail.permissions).toEqual({ upholsterer: true, labor: true });
    expect(avail.commercial).toMatchObject({ contractedCents: 350000, finalCents: 350000 });
    expect(avail.upholsterers.map((u: { displayName: string }) => u.displayName)).toEqual(
      expect.arrayContaining(['Ricardo', 'Márcio']),
    );
    const key = idemKey();
    const body = osBody(order, [
      { upholstererUserId: ric, labor: { agreedCents: 80000 } },
      { upholstererUserId: mar, labor: { agreedCents: 45000, eligibility: 'PRODUCAO_CONCLUIDA' } },
    ]);
    const r = await post(admin, '/api/v1/service-orders', body, key);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // Repetição com a mesma chave: a mesma OS, nenhuma obrigação a mais (idempotência).
    const again = await post(admin, '/api/v1/service-orders', body, key);
    expect(again.body.id).toBe(r.body.id);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    const items = await db().serviceOrderItem.findMany({
      where: { serviceOrderId: r.body.id },
      orderBy: { position: 'asc' },
    });
    expect(items.map((i) => i.upholstererUserId)).toEqual([ric, mar]);
    const labor = await db().productionPayable.findMany({
      where: { serviceOrderId: r.body.id },
      orderBy: { agreedCents: 'desc' },
    });
    expect(labor).toHaveLength(2);
    expect(labor.map((l) => [l.professionalUserId, l.serviceOrderItemId, l.agreedCents])).toEqual([
      [ric, items[0]!.id, 80000],
      [mar, items[1]!.id, 45000],
    ]);
    expect(labor.map((l) => l.eligibility)).toEqual(['QUALIDADE_APROVADA', 'PRODUCAO_CONCLUIDA']);
    // Nada liberado nem pago na criação.
    expect(labor.every((l) => l.status === 'PREVISTO' && l.paidCents === 0)).toBe(true);
    expect(await db().professionalPayment.count()).toBe(0);
    // Auditoria: titular definido e mão de obra combinada.
    const actions = (
      await db().auditLog.findMany({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'service_order.created',
        'production.piece_owner_defined',
        'finance.labor_created',
      ]),
    );
    // Uma obrigação por profissional por peça: combinar de novo a mesma peça é recusado.
    const dup = await post(admin, '/api/v1/finance/labor', {
      professionalUserId: ric,
      serviceOrderId: r.body.id,
      serviceOrderItemId: items[0]!.id,
      service: 'Tapeçaria',
      agreedCents: 1000,
    });
    expect(dup.status).toBe(409);
  });

  it('falha no titular ou na mão de obra desfaz a OS inteira (nada parcialmente criado)', async () => {
    const admin = await loginAdmin(app);
    const ric = await userIdOf('Ricardo');
    const joao = await userIdOf('João');
    const { order } = await receivedOrder(admin);
    // João não é tapeceiro: titular inválido na 2ª peça.
    const bad = await post(
      admin,
      '/api/v1/service-orders',
      osBody(order, [
        { upholstererUserId: ric, labor: { agreedCents: 80000 } },
        { upholstererUserId: joao },
      ]),
    );
    expect(bad.status).toBe(422);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db().productionPayable.count()).toBe(0);
    // Mão de obra sem titular: recusada na validação.
    const noOwner = await post(
      admin,
      '/api/v1/service-orders',
      osBody(order, [{ labor: { agreedCents: 100 } }, {}]),
    );
    expect(noOwner.status).toBe(400);
    expect(JSON.stringify(noOwner.body)).toMatch(/titular/);
    // As peças continuam disponíveis para uma nova tentativa.
    const avail = (await admin.get(`/api/v1/service-orders/available?orderId=${order.id}`)).body;
    expect(avail.items.map((i: { available: number }) => i.available)).toEqual([1, 2]);
    // Sem titular e sem valor: a OS continua sendo criada como antes (contrato compatível).
    const plain = await post(admin, '/api/v1/service-orders', osBody(order));
    expect(plain.status).toBe(201);
    expect(await db().productionPayable.count()).toBe(0);
  });

  it('cada parte exige a própria permissão; valores ocultos sem permissão', async () => {
    const admin = await loginAdmin(app);
    const ric = await userIdOf('Ricardo');
    const { order } = await receivedOrder(admin);
    const os = await panelUserWith(app, admin, 'so-only', [
      'os.gerenciar',
      'os.ver',
      'pedidos.ver',
    ]);
    const avail = (await os.get(`/api/v1/service-orders/available?orderId=${order.id}`)).body;
    expect(avail.commercial).toBeNull();
    expect(avail.permissions).toEqual({ upholsterer: false, labor: false });
    expect(avail.upholsterers).toEqual([]);
    const withOwner = await post(
      os,
      '/api/v1/service-orders',
      osBody(order, [{ upholstererUserId: ric }, {}]),
    );
    expect(withOwner.status).toBe(403);
    const planner = await panelUserWith(app, admin, 'so-plan', [
      'os.gerenciar',
      'os.ver',
      'producao.planejar',
    ]);
    const withLabor = await post(
      planner,
      '/api/v1/service-orders',
      osBody(order, [{ upholstererUserId: ric, labor: { agreedCents: 5000 } }, {}]),
    );
    expect(withLabor.status).toBe(403);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(0);
    const ok = await post(
      planner,
      '/api/v1/service-orders',
      osBody(order, [{ upholstererUserId: ric }, {}]),
    );
    expect(ok.status).toBe(201);
  });
});

describe('B. Agendamento por horário de chegada (CA-13..16, CA-19, CA-20)', () => {
  it('retirada: data exige chegada; sem fim de janela; solicitação sem horário com valor total', async () => {
    const admin = await loginAdmin(app);
    const andre = await userIdOf('André');
    const izaias = await userIdOf('Izaías');
    await put(admin, '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: 8000,
      defaultDeliveryCostCents: 12000,
      logisticsPayeeUserId: andre,
    });
    const customer = await createCustomer(admin, {
      name: 'Cliente Chegada',
      phone: null,
      allowSimilar: true,
    });
    const order = await createOrder(admin, customer);
    const items = order.items.map((i: { id: string; quantity: number }) => ({
      orderItemId: i.id,
      quantity: i.quantity,
    }));
    const noTime = await post(admin, '/api/v1/pickups', {
      orderId: order.id,
      scheduledDate: day(3),
      team: 'LOGISTICA_TERCEIRIZADA',
      items,
    });
    expect(noTime.status).toBe(400);
    expect(JSON.stringify(noTime.body)).toMatch(/horário de chegada/);
    // Só solicitada (sem data): sem horário, mas já com equipe, responsável e valor total.
    const req = await post(admin, '/api/v1/pickups', {
      orderId: order.id,
      team: 'LOGISTICA_TERCEIRIZADA',
      logisticsUserId: andre,
      items,
      tripCost: { amountCents: 10000, participantUserIds: [andre, izaias] },
    });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.status).toBe('AGUARDANDO_AGENDAMENTO');
    const row = await db().pickupRequest.findUniqueOrThrow({ where: { id: req.body.id } });
    expect(row.logisticsUserId).toBe(andre);
    const cost = await db().logisticsCost.findFirstOrThrow({
      where: { pickupId: req.body.id },
      include: { participants: true },
    });
    // Valor total único (não por pessoa); nada devido no agendamento: o recebedor configurado
    // (André) só é gravado quando a obrigação nasce (viagem realizada).
    expect(cost.amountCents).toBe(10000);
    expect(cost.participants.map((p) => p.userId).sort()).toEqual([andre, izaias].sort());
    expect(cost.status).toBe('PREVISTO');
    expect(cost.payableId).toBeNull();
    expect(cost.payeeUserId).toBeNull();
    const view = (await admin.get(`/api/v1/finance/trip-costs?pickupId=${req.body.id}`)).body;
    expect(view.payee).toMatchObject({ userId: andre });
    expect(view.cost).toMatchObject({ status: 'PREVISTO', dueCents: 0 });
    expect(
      await db().notification.count({ where: { userId: andre, kind: 'ENTREGA_ATRIBUIDA' } }),
    ).toBe(1);
    // Agenda com horário único de chegada (sem fim).
    const p = (await admin.get(`/api/v1/pickups/${req.body.id}`)).body;
    const sched = await put(admin, `/api/v1/pickups/${p.id}`, {
      scheduledDate: day(3),
      windowStart: '16:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items,
      version: p.version,
    });
    expect(sched.status, JSON.stringify(sched.body)).toBe(200);
    expect(sched.body).toMatchObject({ status: 'AGENDADA', windowStart: '16:00', windowEnd: null });
    // Executor inválido (sem permissão de logística/produção) é recusado.
    const viewer = await panelUserWith(app, admin, 'pk-ver', ['retiradas.ver']);
    const viewerId = (await db().user.findFirstOrThrow({ where: { email: 'pk-ver@teste.local' } }))
      .id;
    void viewer;
    const order2 = await createOrder(admin, customer);
    const badExec = await post(admin, '/api/v1/pickups', {
      orderId: order2.id,
      team: 'LOGISTICA_TERCEIRIZADA',
      logisticsUserId: viewerId,
      items: order2.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
    expect(badExec.status).toBe(422);
  });

  it('registros antigos com janela continuam válidos e inalterados', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin, {
      name: 'Cliente Legado',
      phone: null,
      allowSimilar: true,
    });
    const order = await createOrder(admin, customer);
    // createPickup grava a janela antiga 09:00–12:00 (formato anterior).
    const legacy = await createPickup(admin, order, day(4));
    expect(legacy).toMatchObject({ windowStart: '09:00', windowEnd: '12:00' });
    const p = (await admin.get(`/api/v1/pickups/${legacy.id}`)).body;
    // Editar mantendo a chegada e a janela: preservada (nenhuma conversão automática).
    const kept = await put(admin, `/api/v1/pickups/${p.id}`, {
      scheduledDate: day(4),
      windowStart: '09:00',
      windowEnd: '12:00',
      team: p.team,
      items: p.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
      version: p.version,
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ windowStart: '09:00', windowEnd: '12:00' });
  });
});

describe('C. Roteiro diário (CA-17, CA-18, CA-20, CA-22, CA-24)', () => {
  async function dayWithStops(admin: Client) {
    const andre = await userIdOf('André');
    const izaias = await userIdOf('Izaías');
    await put(admin, '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: 8000,
      defaultDeliveryCostCents: 12000,
      logisticsPayeeUserId: andre,
    });
    const mk = async (name: string, time: string, extra: Record<string, unknown> = {}) => {
      const c = await createCustomer(admin, { name, phone: null, allowSimilar: true });
      const o = await createOrder(admin, c);
      const r = await post(admin, '/api/v1/pickups', {
        orderId: o.id,
        scheduledDate: day(5),
        windowStart: time,
        team: 'LOGISTICA_TERCEIRIZADA',
        items: o.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        ...extra,
      });
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      return r.body as { id: string; code: string; version: number };
    };
    const a = await mk('Cliente Tarde', '16:00', { logisticsUserId: andre });
    const b = await mk('Cliente Manhã', '09:00', {
      logisticsUserId: andre,
      tripCost: { amountCents: 10000, participantUserIds: [andre, izaias] },
    });
    const c = await mk('Cliente Meio-dia', '12:00');
    return { a, b, c, andre, izaias };
  }

  it('ordena pelo horário; gestor vê tudo; André e Izaías só as próprias paradas, sem valores', async () => {
    const admin = await loginAdmin(app);
    const { a, b, c } = await dayWithStops(admin);
    const r = (await admin.get(`/api/v1/logistics/route?date=${day(5)}`)).body;
    expect(r.scope).toBe('GESTOR');
    expect(r.stops.map((s: { job: { code: string } }) => s.job.code)).toEqual([
      b.code,
      c.code,
      a.code,
    ]);
    expect(r.stops.map((s: { position: number }) => s.position)).toEqual([1, 2, 3]);
    expect(r.warnings.join(' ')).toMatch(/sem responsável/);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const ra = (await andre.get(`/api/v1/logistics/route?date=${day(5)}`)).body;
    expect(ra.scope).toBe('EQUIPE');
    expect(ra.stops.map((s: { job: { code: string } }) => s.job.code)).toEqual([b.code, a.code]);
    expect(JSON.stringify(ra)).not.toMatch(/Cents|amount|R\$|agreedValue/i);
    const izaias = (
      await setupTablet(app, admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '555123' })
    ).tablet;
    const ri = (await izaias.get(`/api/v1/logistics/route?date=${day(5)}`)).body;
    expect(ri.stops.map((s: { job: { code: string } }) => s.job.code)).toEqual([b.code]);
    // Participação não cria obrigação para Izaías (só André é credor).
    const cost = await db().logisticsCost.findFirstOrThrow({ where: { pickupId: b.id } });
    expect(cost.payeeUserId).not.toBe(await userIdOf('Izaías'));
    // Quem executa não altera a sequência.
    const forbid = await put(andre, '/api/v1/logistics/route/sequence', {
      date: day(5),
      stops: [{ kind: 'RETIRADA', id: a.id }],
    });
    expect(forbid.status).toBe(403);
  });

  it('reordenar não muda horário nem versão; registra histórico; alerta e 409 de concorrência', async () => {
    const admin = await loginAdmin(app);
    const { a, b, c } = await dayWithStops(admin);
    const before = await db().pickupRequest.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    const seq = await put(admin, '/api/v1/logistics/route/sequence', {
      date: day(5),
      stops: [
        { kind: 'RETIRADA', id: a.id },
        { kind: 'RETIRADA', id: b.id },
        { kind: 'RETIRADA', id: c.id },
      ],
      reason: 'Cliente da tarde pediu antecipar',
    });
    expect(seq.status, JSON.stringify(seq.body)).toBe(200);
    expect(seq.body.route.stops.map((s: { job: { code: string } }) => s.job.code)).toEqual([
      a.code,
      b.code,
      c.code,
    ]);
    const after = await db().pickupRequest.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    for (const x of after) {
      const y = before.find((z) => z.id === x.id)!;
      expect([x.windowStart, x.windowEnd, x.version, x.scheduledDate]).toEqual([
        y.windowStart,
        y.windowEnd,
        y.version,
        y.scheduledDate,
      ]);
    }
    // A sequência contraria os horários: alerta sem inventar deslocamento.
    const stopB = seq.body.route.stops.find((s: { job: { id: string } }) => s.job.id === b.id);
    expect(stopB.conflicts.join(' ')).toMatch(/confira o deslocamento/);
    const hist = (await admin.get(`/api/v1/logistics/route/history?date=${day(5)}`)).body;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      reason: 'Cliente da tarde pediu antecipar',
      after: [a.code, b.code, c.code],
      before: [b.code, c.code, a.code],
    });
    // Lista desatualizada (falta uma parada): 409, nada muda.
    const stale = await put(admin, '/api/v1/logistics/route/sequence', {
      date: day(5),
      stops: [
        { kind: 'RETIRADA', id: c.id },
        { kind: 'RETIRADA', id: a.id },
      ],
    });
    expect(stale.status).toBe(409);
    expect(
      (await db().pickupRequest.findUniqueOrThrow({ where: { id: c.id } })).routeSequence,
    ).toBe(3);
    // Remarcar para outro dia tira a parada da sequência do dia antigo.
    const pc = (await admin.get(`/api/v1/pickups/${c.id}`)).body;
    const moved = await put(admin, `/api/v1/pickups/${c.id}`, {
      scheduledDate: day(6),
      windowStart: '12:00',
      team: pc.team,
      items: pc.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
      version: pc.version,
    });
    expect(moved.status).toBe(200);
    expect(
      (await db().pickupRequest.findUniqueOrThrow({ where: { id: c.id } })).routeSequence,
    ).toBeNull();
    const now = (await admin.get(`/api/v1/logistics/route?date=${day(5)}`)).body;
    expect(now.stops.map((s: { job: { code: string } }) => s.job.code)).toEqual([a.code, b.code]);
    // Cancelada sai do roteiro.
    const pa = (await admin.get(`/api/v1/pickups/${a.id}`)).body;
    const cancel = await post(admin, `/api/v1/pickups/${a.id}/transition`, {
      toStatus: 'CANCELADA',
      note: 'Cliente desistiu',
      version: pa.version,
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const after2 = (await admin.get(`/api/v1/logistics/route?date=${day(5)}`)).body;
    expect(after2.stops.map((s: { job: { code: string } }) => s.job.code)).toEqual([b.code]);
  });

  it('mesmo horário para a mesma pessoa vira alerta', async () => {
    const admin = await loginAdmin(app);
    const andre = await userIdOf('André');
    const mk = async (name: string) => {
      const c = await createCustomer(admin, { name, phone: null, allowSimilar: true });
      const o = await createOrder(admin, c);
      return (
        await post(admin, '/api/v1/pickups', {
          orderId: o.id,
          scheduledDate: day(7),
          windowStart: '10:00',
          team: 'LOGISTICA_TERCEIRIZADA',
          logisticsUserId: andre,
          items: o.items.map((i: { id: string; quantity: number }) => ({
            orderItemId: i.id,
            quantity: i.quantity,
          })),
        })
      ).body as { code: string };
    };
    await mk('Cliente Dez A');
    const second = await mk('Cliente Dez B');
    const r = (await admin.get(`/api/v1/logistics/route?date=${day(7)}`)).body;
    const s2 = r.stops.find((s: { job: { code: string } }) => s.job.code === second.code);
    expect(s2.conflicts.join(' ')).toMatch(/Mesmo horário de chegada \(10:00\).*André/);
  });
});
