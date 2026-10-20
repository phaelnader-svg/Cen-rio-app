import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { address, createCustomer, createOrder, panelUserWith } from './commercial-helpers';
import { day, userIdOf } from './production-helpers';

/**
 * Simplificação Fase 2 — "Novo serviço" (dados fictícios; valores em centavos; nenhum pagamento).
 *  A. Operação única: cliente novo/existente + pedido fechado + retirada + custo, atômica e
 *     idempotente (CA2-02..14).
 *  B. Equipe própria (Thiago, configurável) × terceirizada (André + Izaías, valor único).
 *  C. OS automática SOMENTE na confirmação da chegada; parcial, repetição, vínculos (CA2-15..20).
 *  D. Permissões, CSRF, registros antigos e tempo real (CA2-21, 22, 24).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown) =>
  c.req('PUT', path, body, { 'idempotency-key': idemKey() });

const ITEMS = [
  {
    pieceType: 'SOFA',
    description: 'Sofá 3 lugares',
    quantity: 1,
    serviceType: 'REFORMA_COMPLETA',
    fabricName: 'Linho cinza',
    technicalNotes: 'Trocar espuma do assento',
  },
  { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2, serviceType: 'TROCA_DE_TECIDO' },
];

function newCustomer(name = 'Cliente Novo Serviço', extra: Record<string, unknown> = {}) {
  return {
    mode: 'NOVO',
    kind: 'PF',
    name,
    phone: '(11) 98888-7766',
    email: 'cliente.servico@teste.local',
    notes: 'Portão azul; cachorro bravo.',
    address: {
      ...address,
      complement: 'Casa 2',
      reference: 'Em frente à praça',
      isPrimary: true,
    },
    ...extra,
  };
}

async function body(
  overrides: { customer?: unknown; service?: object; pickup?: object } = {},
): Promise<Record<string, unknown>> {
  return {
    customer: overrides.customer ?? newCustomer(),
    service: {
      contractedService: 'Reforma completa',
      agreedValueCents: 300000,
      paymentTerms: '50% na retirada',
      promisedDate: day(30),
      technicalNotes: 'Cliente quer costura dupla.',
      items: ITEMS,
      ...overrides.service,
    },
    pickup: {
      scheduledDate: day(2),
      windowStart: '09:30',
      team: 'LOGISTICA_TERCEIRIZADA',
      ...overrides.pickup,
    },
  };
}

async function logisticsSetup(admin: Client) {
  const andre = await userIdOf('André');
  const izaias = await userIdOf('Izaías');
  const r = await put(admin, '/api/v1/finance/logistics-defaults', {
    defaultPickupCostCents: 8000,
    defaultDeliveryCostCents: 12000,
    logisticsPayeeUserId: andre,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { andre, izaias };
}

const counts = async () => ({
  customers: await db().customer.count(),
  orders: await db().commercialOrder.count(),
  pickups: await db().pickupRequest.count(),
  costs: await db().logisticsCost.count(),
  serviceOrders: await db().serviceOrder.count(),
  payables: await db().accountPayable.count(),
  receivables: await db().customerReceivable.count(),
});

async function receive(
  c: Client,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
  pickupId: string | null,
  key = idemKey(),
) {
  return post(
    c,
    '/api/v1/receipts',
    {
      orderId,
      pickupId,
      origin: pickupId ? 'RETIRADA' : 'ENTREGUE_PELO_CLIENTE',
      lines: lines.map((l) => ({ ...l, condition: 'BOA', location: 'Área de recebimento' })),
    },
    key,
  );
}

describe('A. Novo serviço: uma operação, atômica e idempotente', () => {
  it('cliente novo + serviço fechado + retirada terceirizada com valor único (CA2-02,04..07,09,10)', async () => {
    const admin = await loginAdmin(app);
    const { andre, izaias } = await logisticsSetup(admin);
    const before = await counts();
    const r = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { participantUserIds: [izaias], amountCents: 10000 } }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.customer).toMatchObject({ name: 'Cliente Novo Serviço', created: true });
    expect(r.body.order).toMatchObject({ totalPieces: 3, agreedValueCents: 300000 });
    expect(r.body.pickup).toMatchObject({
      status: 'AGENDADA',
      scheduledDate: day(2),
      windowStart: '09:30',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsible: 'André',
      participants: ['Izaías'],
    });
    expect(r.body.pickup.address).toMatchObject({
      complement: 'Casa 2',
      reference: 'Em frente à praça',
    });
    expect(r.body.tripCost).toMatchObject({ amountCents: 10000, status: 'PREVISTO' });

    const after = await counts();
    expect(after.customers - before.customers).toBe(1);
    expect(after.orders - before.orders).toBe(1);
    expect(after.pickups - before.pickups).toBe(1);
    expect(after.costs - before.costs).toBe(1);
    // CA2-10/15: nada de OS, conta a pagar ou receita no agendamento.
    expect(after.serviceOrders).toBe(before.serviceOrders);
    expect(after.payables).toBe(before.payables);
    expect(after.receivables).toBe(before.receivables);

    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    expect(order).toMatchObject({
      autoServiceOrder: true,
      agreedValueCents: 300000,
      technicalNotes: 'Cliente quer costura dupla.',
      status: 'RETIRADA_AGENDADA',
    });
    expect(order.items.map((i) => [i.description, i.quantity, i.serviceType])).toEqual([
      ['Sofá 3 lugares', 1, 'REFORMA_COMPLETA'],
      ['Poltronas', 2, 'TROCA_DE_TECIDO'],
    ]);
    expect(order.items[0]).toMatchObject({ fabricName: 'Linho cinza' });
    const customer = await db().customer.findUniqueOrThrow({ where: { id: r.body.customer.id } });
    expect(customer.notes).toBe('Portão azul; cachorro bravo.');

    // CA2-09/10: UM custo de R$ 100, participantes não são credores, sem obrigação ainda.
    const cost = await db().logisticsCost.findFirstOrThrow({
      where: { pickupId: r.body.pickup.id },
      include: { participants: true },
    });
    expect(cost).toMatchObject({ amountCents: 10000, status: 'PREVISTO', payableId: null });
    expect(cost.participants.map((p) => p.userId).sort()).toEqual([izaias].sort());
    const pickup = await db().pickupRequest.findUniqueOrThrow({ where: { id: r.body.pickup.id } });
    expect(pickup.logisticsUserId).toBe(andre);
    expect(pickup.windowEnd).toBeNull();
  });

  it('cliente existente é reutilizado; semelhante pede confirmação; documento igual bloqueia (CA2-03)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const existing = await createCustomer(admin, {
      name: 'Maria Existente',
      phone: '(11) 97777-1111',
    });
    const before = await counts();
    const r = await post(
      admin,
      '/api/v1/services',
      await body({ customer: { mode: 'EXISTENTE', customerId: existing.id } }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.customer).toMatchObject({ id: existing.id, created: false });
    expect((await counts()).customers).toBe(before.customers);
    // Endereço novo para cliente existente, na mesma operação.
    const r2 = await post(
      admin,
      '/api/v1/services',
      await body({
        customer: {
          mode: 'EXISTENTE',
          customerId: existing.id,
          newAddress: { ...address, label: 'Casa de praia', street: 'Av. Litorânea' },
        },
      }),
    );
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.pickup.address.street).toBe('Av. Litorânea');
    // Mesmo telefone = possível duplicidade: devolve o cadastro encontrado, nada é criado.
    const dup = await post(
      admin,
      '/api/v1/services',
      await body({ customer: newCustomer('Outra Maria', { phone: '(11) 97777-1111' }) }),
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(dup.body.error.details.candidates[0]).toMatchObject({ id: existing.id });
    // Pessoas diferentes podem compartilhar telefone: com confirmação explícita, prossegue.
    const ok = await post(
      admin,
      '/api/v1/services',
      await body({
        customer: newCustomer('Outra Maria', { phone: '(11) 97777-1111', allowSimilar: true }),
      }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // Mesmo CPF: duplicidade evidente, sempre bloqueia.
    await createCustomer(admin, { name: 'Com CPF', phone: null, document: '52998224725' });
    const hard = await post(
      admin,
      '/api/v1/services',
      await body({
        customer: newCustomer('Com CPF 2', { document: '52998224725', allowSimilar: true }),
      }),
    );
    expect(hard.status).toBe(409);
    expect(hard.body.error.code).toBe('CONFLICT');
  });

  it('falha em qualquer etapa desfaz tudo — nada parcialmente criado (CA2-12)', async () => {
    const admin = await loginAdmin(app);
    const { andre } = await logisticsSetup(admin);
    const before = await counts();
    // Falha na etapa da retirada (responsável fora da equipe escolhida) após cliente e pedido.
    const thiago = await userIdOf('Thiago');
    const bad = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { logisticsUserId: thiago } }),
    );
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/não pertence à equipe/);
    expect(await counts()).toEqual(before);
    // Falha no custo (sem permissão financeira) após cliente, pedido e retirada.
    const seller = await panelUserWith(app, admin, 'vendedor', [
      'pedidos.gerenciar',
      'retiradas.gerenciar',
      'clientes.gerenciar',
    ]);
    const noFin = await post(
      seller,
      '/api/v1/services',
      await body({
        service: { agreedValueCents: null, paymentTerms: null },
        pickup: { amountCents: 10000 },
      }),
    );
    expect(noFin.status).toBe(403);
    expect(await counts()).toEqual(before);
    // Falha no pedido (valor sem permissão) após o cliente novo.
    const noValues = await post(seller, '/api/v1/services', await body());
    expect(noValues.status).toBe(403);
    expect(await counts()).toEqual(before);
    void andre;
  });

  it('repetição com a mesma chave não duplica; simultâneas também não (CA2-13, CA2-14)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const before = await counts();
    const payload = await body({ pickup: { amountCents: 10000 } });
    const key = idemKey();
    const first = await post(admin, '/api/v1/services', payload, key);
    expect(first.status).toBe(201);
    const replay = await post(admin, '/api/v1/services', payload, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    let now = await counts();
    expect([now.customers, now.orders, now.pickups, now.costs]).toEqual([
      before.customers + 1,
      before.orders + 1,
      before.pickups + 1,
      before.costs + 1,
    ]);
    // Duas requisições simultâneas com a MESMA chave: um único serviço.
    const payload2 = await body({
      customer: newCustomer('Cliente Simultâneo', { phone: '(11) 96666-0000', email: null }),
    });
    const key2 = idemKey();
    const [a, b] = await Promise.all([
      post(admin, '/api/v1/services', payload2, key2),
      post(admin, '/api/v1/services', payload2, key2),
    ]);
    expect([a.status, b.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
    // Duas requisições simultâneas com chaves DIFERENTES para o mesmo cliente novo: a trava do
    // cadastro faz a segunda ver o primeiro (possível duplicidade) — um cliente só.
    const payload3 = await body({
      customer: newCustomer('Cliente Corrida', { phone: '(11) 95555-0000', email: null }),
    });
    const [c, d] = await Promise.all([
      post(admin, '/api/v1/services', payload3),
      post(admin, '/api/v1/services', payload3),
    ]);
    expect([c.status, d.status].sort()).toEqual([201, 409]);
    now = await counts();
    expect(await db().customer.count({ where: { name: 'Cliente Simultâneo' } })).toBe(1);
    expect(await db().customer.count({ where: { name: 'Cliente Corrida' } })).toBe(1);
    expect(now.orders).toBe(before.orders + 3);
    expect(now.pickups).toBe(before.pickups + 3);
  });

  it('servidor gravou e a resposta se perdeu: a nova tentativa com a mesma chave devolve o mesmo serviço (F2-08)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const existing = await createCustomer(admin, { name: 'Cliente Rede Instável' });
    const before = await counts();
    const payload = await body({
      customer: { mode: 'EXISTENTE', customerId: existing.id },
      service: { payment: { model: 'ENTRADA_ENTREGA' } },
      pickup: { amountCents: 10000 },
    });
    const key = idemKey();
    // 1ª tentativa: o servidor grava tudo; a tela nunca recebe esta resposta.
    const lost = await post(admin, '/api/v1/services', payload, key);
    expect(lost.status, JSON.stringify(lost.body)).toBe(201);
    // A tela repete com a MESMA chave e o MESMO corpo.
    const retry = await post(admin, '/api/v1/services', payload, key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(lost.body);
    const orderId = (retry.body as { order: { id: string } }).order.id;
    const now = await counts();
    expect(now).toEqual({
      ...before,
      orders: before.orders + 1,
      pickups: before.pickups + 1,
      costs: before.costs + 1,
      payables: now.payables,
      receivables: before.receivables + 2,
    });
    expect(now.customers).toBe(before.customers);
    expect(await db().commercialOrder.count({ where: { customerId: existing.id } })).toBe(1);
    expect(await db().pickupRequest.count({ where: { orderId } })).toBe(1);
    expect(await db().customerReceivable.count({ where: { orderId } })).toBe(2);
    // Mesma chave com corpo editado: recusado, nada novo é criado.
    const edited = await post(
      admin,
      '/api/v1/services',
      { ...payload, service: { ...(payload.service as object), agreedValueCents: 310000 } },
      key,
    );
    expect(edited.status).toBe(422);
    expect(edited.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await counts()).toEqual(now);
  });
});

describe('B. Equipes: própria (Thiago, configurável) e terceirizada (André + Izaías)', () => {
  it('equipe própria usa Thiago por padrão, sem custo de terceirização (CA2-08)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const thiago = await userIdOf('Thiago');
    const defaults = (await admin.get('/api/v1/services/new-defaults')).body;
    expect(defaults.ownTeam).toMatchObject({
      userId: thiago,
      displayName: 'Thiago',
      problem: null,
    });
    expect(defaults.outsourced).toMatchObject({ displayName: 'André' });
    expect(
      defaults.people.EQUIPE_PROPRIA.map((p: { displayName: string }) => p.displayName),
    ).toContain('Thiago');
    expect(
      defaults.people.LOGISTICA_TERCEIRIZADA.map((p: { displayName: string }) => p.displayName),
    ).toEqual(['André', 'Izaías']);

    const r = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { team: 'EQUIPE_PROPRIA' } }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.pickup).toMatchObject({ team: 'EQUIPE_PROPRIA', responsible: 'Thiago' });
    expect(r.body.tripCost).toBeNull();
    expect(await db().logisticsCost.count({ where: { pickupId: r.body.pickup.id } })).toBe(0);

    // Equipe própria com valor de terceirização: recusado (aqui e na rota antiga de retirada).
    const withCost = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { team: 'EQUIPE_PROPRIA', amountCents: 5000 } }),
    );
    expect(withCost.status).toBe(400);
    const order = await createOrder(
      admin,
      await createCustomer(admin, { name: 'Legado X', phone: null }),
    );
    const legacyPickup = await post(admin, '/api/v1/pickups', {
      orderId: order.id,
      team: 'EQUIPE_PROPRIA',
      items: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
      tripCost: { amountCents: 5000, participantUserIds: [] },
    });
    expect(legacyPickup.status).toBe(400);
    expect(JSON.stringify(legacyPickup.body)).toMatch(/Equipe própria não gera custo/);

    // Outro profissional elegível pode ser escolhido no lugar do padrão.
    const joao = await userIdOf('João');
    const other = await post(
      admin,
      '/api/v1/services',
      await body({
        customer: newCustomer('Cliente Dois', { phone: '(11) 94444-0000', email: null }),
        pickup: { team: 'EQUIPE_PROPRIA', logisticsUserId: joao },
      }),
    );
    expect(other.status).toBe(201);
    expect(other.body.pickup.responsible).toBe('João');
  });

  it('configuração em Empresa: protegida, auditada, validada; padrão inválido vira pendência', async () => {
    const admin = await loginAdmin(app);
    const thiago = await userIdOf('Thiago');
    const joao = await userIdOf('João');
    const andre = await userIdOf('André');
    let cfg = (await admin.get('/api/v1/company/own-team')).body;
    expect(cfg).toMatchObject({ userId: thiago, problem: null });
    // André (logística terceirizada) não é da equipe própria.
    const bad = await put(admin, '/api/v1/company/own-team', {
      userId: andre,
      version: cfg.version,
    });
    expect(bad.status).toBe(422);
    const ok = await put(admin, '/api/v1/company/own-team', { userId: joao, version: cfg.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ userId: joao, displayName: 'João', problem: null });
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'company.own_team_default_changed' },
    });
    expect(log.changes).toMatchObject({ ownTeamDefaultUserId: { from: thiago, to: joao } });
    // Versão desatualizada: conflito.
    expect(
      (await put(admin, '/api/v1/company/own-team', { userId: thiago, version: cfg.version }))
        .status,
    ).toBe(409);
    // Sem permissão de configurar a empresa: negado.
    const seller = await panelUserWith(app, admin, 'vend2', [
      'pedidos.gerenciar',
      'retiradas.gerenciar',
    ]);
    cfg = (await seller.get('/api/v1/company/own-team')).body;
    expect(
      (await put(seller, '/api/v1/company/own-team', { userId: thiago, version: cfg.version }))
        .status,
    ).toBe(403);
    // Padrão inativado → pendência clara; o Novo serviço exige escolher alguém.
    await db().user.update({ where: { id: joao }, data: { active: false } });
    cfg = (await admin.get('/api/v1/company/own-team')).body;
    expect(cfg).toMatchObject({ userId: joao, problem: 'INATIVO' });
    expect(cfg.candidates.map((c: { userId: string }) => c.userId)).not.toContain(joao);
    await logisticsSetup(admin);
    const r = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { team: 'EQUIPE_PROPRIA' } }),
    );
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/inativo/);
    const chosen = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { team: 'EQUIPE_PROPRIA', logisticsUserId: thiago } }),
    );
    expect(chosen.status).toBe(201);
  });

  it('retirada aparece na agenda e no roteiro do responsável, sem valores (CA2-11)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const izaias = await userIdOf('Izaías');
    const r = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { participantUserIds: [izaias], amountCents: 10000 } }),
    );
    expect(r.status).toBe(201);
    const agenda = (await admin.get(`/api/v1/pickups?from=${day(2)}&to=${day(2)}`)).body;
    expect(agenda.map((p: { id: string }) => p.id)).toContain(r.body.pickup.id);
    const route = (await admin.get(`/api/v1/logistics/route?date=${day(2)}`)).body;
    expect(route.stops.map((s: { job: { id: string } }) => s.job.id)).toContain(r.body.pickup.id);
    for (const [name, pin] of [
      ['André', '640218'],
      ['Izaías', '555123'],
    ] as const) {
      const { tablet } = await setupTablet(app, admin, {
        name: `Celular ${name}`,
        employee: name,
        pin,
      });
      const mine = (await tablet.get(`/api/v1/logistics/route?date=${day(2)}`)).body;
      const stop = mine.stops.find((s: { job: { id: string } }) => s.job.id === r.body.pickup.id);
      expect(stop, name).toBeTruthy();
      expect(JSON.stringify(mine)).toContain('09:30');
      expect(JSON.stringify(mine)).not.toMatch(/Cents|amount|R\$|agreedValue/i);
    }
  });
});

describe('C. OS automática somente na chegada das peças', () => {
  async function scheduled(admin: Client) {
    await logisticsSetup(admin);
    const r = await post(admin, '/api/v1/services', await body({ pickup: { amountCents: 10000 } }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    return { res: r.body, order };
  }

  it('sem recebimento não há OS; a chegada cria a OS com vínculos e valores (CA2-15,16,19,20)', async () => {
    const admin = await loginAdmin(app);
    const { res, order } = await scheduled(admin);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(0);
    // Criar OS manual antes da chegada continua bloqueado (regra preservada).
    const manual = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: [
        {
          orderItemId: order.items[0]!.id,
          quantity: 1,
          serviceType: 'REFORMA_COMPLETA',
          description: 'Sofá',
        },
      ],
    });
    expect(manual.status).toBe(422);

    const rec = await receive(
      admin,
      order.id,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      res.pickup.id,
    );
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body.generatedServiceOrder).toMatchObject({ code: expect.stringMatching(/^OS-/) });
    const so = await db().serviceOrder.findUniqueOrThrow({
      where: { id: rec.body.generatedServiceOrder.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    expect(so).toMatchObject({
      orderId: order.id,
      customerId: order.customerId,
      sourceReceiptId: rec.body.id,
      status: 'ABERTA',
      technicalInstructions: 'Cliente quer costura dupla.',
      revenueCents: null,
    });
    expect(so.promisedDate?.toISOString().slice(0, 10)).toBe(day(30));
    expect(so.items.map((i) => [i.orderItemId, i.quantity, i.serviceType])).toEqual([
      [order.items[0]!.id, 1, 'REFORMA_COMPLETA'],
      [order.items[1]!.id, 2, 'TROCA_DE_TECIDO'],
    ]);
    expect(so.items[0]).toMatchObject({
      fabricName: 'Linho cinza',
      technicalNotes: 'Trocar espuma do assento',
      upholstererUserId: null,
    });
    // CA2-19/CA2-06: valores do pedido preservados; receita da OS = participação do pedido.
    const revenue = (await admin.get(`/api/v1/finance/orders/${order.id}`)).body;
    expect(JSON.stringify(revenue)).toContain('300000');
    expect(await db().customerReceivable.count()).toBe(0);
    // CA2-20: nada de produção, titular, mão de obra ou planejamento automático.
    expect(await db().productionTask.count({ where: { serviceOrderId: so.id } })).toBe(0);
    expect(await db().productionPlanItem.count({ where: { serviceOrderId: so.id } })).toBe(0);
    expect(await db().productionPayable.count({ where: { serviceOrderId: so.id } })).toBe(0);
    // Custo da retirada passou a devido e é rateado na OS gerada (regra da Fase 6).
    const cost = await db().logisticsCost.findFirstOrThrow({
      where: { pickupId: res.pickup.id },
      include: { allocations: true },
    });
    expect(cost.status).toBe('DEVIDO');
    expect(cost.allocations.filter((a) => a.serviceOrderId === so.id).length).toBeGreaterThan(0);
    expect(await db().accountPayable.count()).toBe(1);
    // Auditoria e histórico da OS registram a origem automática.
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'service_order.created', entityId: so.id },
    });
    expect(log.summary).toMatch(/gerada automaticamente pelo recebimento/);
  });

  it('recebimento parcial: só as peças que chegaram; repetição não duplica (CA2-17, CA2-18)', async () => {
    const admin = await loginAdmin(app);
    const { res, order } = await scheduled(admin);
    const [sofa, poltronas] = order.items;
    const key = idemKey();
    const lines = [
      { orderItemId: sofa!.id, quantity: 1 },
      { orderItemId: poltronas!.id, quantity: 1 },
    ];
    const r1 = await receive(admin, order.id, lines, res.pickup.id, key);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    // Repetição da mesma confirmação (reenvio de rede): mesmo recebimento, mesma OS.
    const again = await receive(admin, order.id, lines, res.pickup.id, key);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(r1.body.id);
    expect(await db().receipt.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    const so1 = await db().serviceOrder.findUniqueOrThrow({
      where: { id: r1.body.generatedServiceOrder.id },
      include: { items: true },
    });
    expect(so1.items.map((i) => [i.orderItemId, i.quantity]).sort()).toEqual(
      [
        [sofa!.id, 1],
        [poltronas!.id, 1],
      ].sort(),
    );
    // A poltrona ausente NÃO foi marcada como recebida.
    const items = await db().commercialOrderItem.findMany({ where: { orderId: order.id } });
    expect(items.find((i) => i.id === poltronas!.id)!.receivedQuantity).toBe(1);
    expect((await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'RECEBIDO_PARCIAL',
    );
    // Chegada da poltrona restante: nova OS só com ela.
    const r2 = await receive(admin, order.id, [{ orderItemId: poltronas!.id, quantity: 1 }], null);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const so2 = await db().serviceOrder.findUniqueOrThrow({
      where: { id: r2.body.generatedServiceOrder.id },
      include: { items: true },
    });
    expect(so2.items.map((i) => [i.orderItemId, i.quantity])).toEqual([[poltronas!.id, 1]]);
    // Nenhuma peça em duas OS; total em OS = total recebido.
    const inOs = await db().serviceOrderItem.aggregate({
      where: { serviceOrder: { orderId: order.id } },
      _sum: { quantity: true },
    });
    expect(inOs._sum.quantity).toBe(3);
    // Recebimento além do pedido continua recusado (regra preservada) — sem OS extra.
    const over = await receive(admin, order.id, [{ orderItemId: sofa!.id, quantity: 1 }], null);
    expect(over.status).toBe(409);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('peça já colocada em OS manual não é duplicada; recebimentos simultâneos não duplicam OS', async () => {
    const admin = await loginAdmin(app);
    const { order } = await scheduled(admin);
    const [sofa, poltronas] = order.items;
    const [a, b] = await Promise.all([
      receive(admin, order.id, [{ orderItemId: sofa!.id, quantity: 1 }], null),
      receive(admin, order.id, [{ orderItemId: sofa!.id, quantity: 1 }], null),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    // Banco: o mesmo recebimento não pode gerar duas OS.
    const receiptId = (a.status === 201 ? a : b).body.id;
    await expect(
      db().serviceOrder.create({
        data: { orderId: order.id, customerId: order.customerId, sourceReceiptId: receiptId },
      }),
    ).rejects.toThrow();
    void poltronas;
  });

  it('pedidos antigos (fora do Novo serviço) continuam sem OS automática (CA2-22)', async () => {
    const admin = await loginAdmin(app);
    const order = await createOrder(
      admin,
      await createCustomer(admin, { name: 'Antigo', phone: null }),
    );
    const r = await receive(
      admin,
      order.id,
      order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
      null,
    );
    expect(r.status).toBe(201);
    expect(r.body.generatedServiceOrder).toBeNull();
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(0);
    // OS manual segue funcionando como antes.
    const so = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: order.items.map((i: { id: string; quantity: number; description: string }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
        serviceType: 'REFORMA_COMPLETA',
        description: i.description,
      })),
    });
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    expect((await admin.get(`/api/v1/orders/${order.id}`)).body.autoServiceOrder).toBe(false);
  });
});

describe('D. Segurança, permissões e tempo real', () => {
  it('cada parte exige sua permissão; tablet e origem estranha são recusados (CA2-21)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    // Sem permissão de pedidos/retiradas: nem os padrões.
    const viewer = await panelUserWith(app, admin, 'leitor', ['pedidos.ver', 'clientes.ver']);
    expect((await viewer.get('/api/v1/services/new-defaults')).status).toBe(403);
    expect((await post(viewer, '/api/v1/services', await body())).status).toBe(403);
    // Operador comercial sem valores, sem financeiro e sem cadastro de cliente.
    const op = await panelUserWith(app, admin, 'operador', [
      'pedidos.gerenciar',
      'retiradas.gerenciar',
    ]);
    const d = (await op.get('/api/v1/services/new-defaults')).body;
    expect(d).toMatchObject({
      canSetValues: false,
      canSetTripCost: false,
      canCreateCustomer: false,
    });
    expect(d.suggestedPickupCostCents).toBeNull();
    expect(
      (
        await post(
          op,
          '/api/v1/services',
          await body({ service: { agreedValueCents: null, paymentTerms: null } }),
        )
      ).status,
    ).toBe(403);
    const existing = await createCustomer(admin, { name: 'Cliente do Operador', phone: null });
    const plain = {
      customer: { mode: 'EXISTENTE', customerId: existing.id },
      service: { agreedValueCents: null, paymentTerms: null },
    };
    expect(
      (await post(op, '/api/v1/services', await body({ ...plain, pickup: { amountCents: 100 } })))
        .status,
    ).toBe(403);
    expect(
      (await post(op, '/api/v1/services', await body({ customer: plain.customer }))).status,
    ).toBe(403);
    const ok = await post(op, '/api/v1/services', await body(plain));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.tripCost).toBeNull();
    expect(ok.body.order.agreedValueCents).toBeNull();
    // Valor monetário inválido é recusado na validação.
    expect(
      (await post(admin, '/api/v1/services', await body({ service: { agreedValueCents: -5 } })))
        .status,
    ).toBe(400);
    expect(
      (await post(admin, '/api/v1/services', await body({ pickup: { amountCents: 10.5 } }))).status,
    ).toBe(400);
    // Sessão de tablet não usa o Novo serviço.
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet A',
      employee: 'Thiago',
      pin: '481516',
    });
    expect((await post(tablet, '/api/v1/services', await body())).status).toBe(403);
    // CSRF: origem não permitida.
    admin.origin = 'http://site-malicioso.test';
    expect((await post(admin, '/api/v1/services', await body())).status).toBe(403);
  });

  it('data sem horário de chegada é recusada; sem data fica aguardando agendamento', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const noTime = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { windowStart: null } }),
    );
    expect(noTime.status).toBe(400);
    expect(JSON.stringify(noTime.body)).toMatch(/horário de chegada/);
    const unscheduled = await post(
      admin,
      '/api/v1/services',
      await body({ pickup: { scheduledDate: null, windowStart: null } }),
    );
    expect(unscheduled.status, JSON.stringify(unscheduled.body)).toBe(201);
    expect(unscheduled.body.pickup.status).toBe('AGUARDANDO_AGENDAMENTO');
  });

  it('eventos em tempo real: pedido, retirada e OS gerada chegam ao painel (CA2-24)', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    // Outra sessão do painel (a própria sessão não recebe o eco do que ela mesma fez).
    const ws = await WsClient.connect(app, await loginAdmin(app));
    const r = await post(admin, '/api/v1/services', await body());
    expect(r.status).toBe(201);
    await ws.waitFor((m) => m.event?.type === 'order.created');
    await ws.waitFor((m) => m.event?.type === 'pickup.created');
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: true },
    });
    const rec = await receive(
      admin,
      order.id,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      r.body.pickup.id,
    );
    expect(rec.status).toBe(201);
    await ws.waitFor((m) => m.event?.type === 'service_order.created');
    const ev = await ws.waitFor((m) => m.event?.type === 'receipt.registered');
    expect(ev.event.payload.serviceOrderId).toBe(rec.body.generatedServiceOrder.id);
    await ws.close();
  });
});

describe('E. Estabilização: serviço sem retirada (cliente entrega as peças)', () => {
  const noPickup = async (
    customer: unknown = newCustomer('Cliente Entrega', { address: undefined }),
  ) => {
    const b = await body({ customer });
    return { ...b, pickup: null };
  };

  it('sem retirada é válido: nada de retirada, custo, agenda ou endereço inventado; a chegada gera a OS', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const before = await counts();
    const r = await post(admin, '/api/v1/services', await noPickup());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.pickup).toBeNull();
    expect(r.body.tripCost).toBeNull();
    expect(r.body.order.customerDropOff).toBe(true);
    const after = await counts();
    expect(after).toMatchObject({
      customers: before.customers + 1,
      orders: before.orders + 1,
      pickups: before.pickups,
      costs: before.costs,
      payables: before.payables,
      serviceOrders: before.serviceOrders,
    });
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: {
        items: { orderBy: { position: 'asc' } },
        customer: { include: { addresses: true } },
      },
    });
    expect(order).toMatchObject({
      customerDropOff: true,
      autoServiceOrder: true,
      pickupAddressId: null,
      status: 'AGUARDANDO_RETIRADA',
    });
    expect(order.pickupAddressSnapshot).toBeNull();
    expect(order.customer.addresses).toHaveLength(0); // nenhum endereço inventado
    // A lista de pedidos informa a situação real (cliente entrega).
    const list = await admin.get('/api/v1/orders');
    const row = (list.body.items ?? list.body).find((o: { id: string }) => o.id === order.id);
    expect(row.customerDropOff).toBe(true);
    // Agenda/roteiro: nenhuma parada para este pedido.
    expect(await db().pickupRequest.count({ where: { orderId: order.id } })).toBe(0);
    // O cliente entrega as peças: recebimento "entregue pelo cliente" gera a OS automática.
    const rec = await receive(
      admin,
      order.id,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      null,
    );
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const so = await db().serviceOrder.findMany({
      where: { orderId: order.id },
      include: { items: true },
    });
    expect(so).toHaveLength(1);
    expect(so[0]!.items.reduce((a, i) => a + i.quantity, 0)).toBe(3);
    expect((await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'RECEBIDO',
    );
    expect((await counts()).payables).toBe(before.payables); // nenhum custo de transporte
  });

  it('retirada omitida (campo ausente) também vale; cliente existente sem endereço escolhido não ganha endereço automático', async () => {
    const admin = await loginAdmin(app);
    const c = await createCustomer(admin, {
      name: 'Cliente Existente Entrega',
      phone: null,
      allowSimilar: true,
    });
    const b = await body({ customer: { mode: 'EXISTENTE', customerId: c.id } });
    delete b.pickup;
    const r = await post(admin, '/api/v1/services', b);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.pickup).toBeNull();
    const order = await db().commercialOrder.findUniqueOrThrow({ where: { id: r.body.order.id } });
    expect(order).toMatchObject({ customerDropOff: true, pickupAddressId: null });
  });

  it('com retirada, cliente novo sem endereço é recusado; nada é criado', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const before = await counts();
    const r = await post(
      admin,
      '/api/v1/services',
      await body({ customer: newCustomer('Sem Endereço', { address: undefined }) }),
    );
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/endereço de retirada/);
    expect(await counts()).toEqual(before);
  });

  it('falha intermediária sem retirada desfaz tudo; repetição com a mesma chave não duplica', async () => {
    const admin = await loginAdmin(app);
    const before = await counts();
    // Peça com quantidade inválida: recusada antes de gravar qualquer coisa.
    const bad = await noPickup();
    (bad as unknown as { service: { items: unknown[] } }).service.items = [
      { ...ITEMS[0], quantity: 0 },
    ];
    expect((await post(admin, '/api/v1/services', bad)).status).toBe(400);
    expect(await counts()).toEqual(before);
    // Documento já cadastrado: cliente recusado na transação → pedido também não fica.
    const doc = await createCustomer(admin, {
      name: 'Dono do CPF',
      document: '52998224725',
      allowSimilar: true,
    });
    expect(doc.id).toBeTruthy();
    const mid = await counts();
    const dup = await post(
      admin,
      '/api/v1/services',
      await noPickup(
        newCustomer('Outro com o mesmo CPF', { address: undefined, document: '52998224725' }),
      ),
    );
    expect(dup.status).toBe(409);
    expect(await counts()).toEqual(mid);
    // Idempotência.
    const key = idemKey();
    const okBody = await noPickup(newCustomer('Cliente Idempotente', { address: undefined }));
    const a = await post(admin, '/api/v1/services', okBody, key);
    const b2 = await post(admin, '/api/v1/services', okBody, key);
    expect(a.status).toBe(201);
    expect(b2.body).toEqual(a.body);
    expect((await counts()).orders).toBe(mid.orders + 1);
  });

  it('o cliente mudou de ideia: agendar uma retirada depois desmarca "cliente entrega"', async () => {
    const admin = await loginAdmin(app);
    await logisticsSetup(admin);
    const r = await post(
      admin,
      '/api/v1/services',
      await noPickup(newCustomer('Cliente Mudou', {})),
    );
    expect(r.status).toBe(201);
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: true, customer: { include: { addresses: true } } },
    });
    expect(order.customerDropOff).toBe(true);
    const pk = await post(admin, '/api/v1/pickups', {
      orderId: order.id,
      addressId: order.customer.addresses[0]!.id,
      scheduledDate: day(3),
      windowStart: '10:00',
      windowEnd: null,
      team: 'LOGISTICA_TERCEIRIZADA',
      items: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    });
    expect(pk.status, JSON.stringify(pk.body)).toBe(201);
    const after = await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({ customerDropOff: false, status: 'RETIRADA_AGENDADA' });
  });
});
