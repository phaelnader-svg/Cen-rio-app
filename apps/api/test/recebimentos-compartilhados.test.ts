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
import { arrivalTestHooks } from '../src/modules/arrivals/routes';
import {
  address,
  createCustomer,
  createOrder,
  createPickup,
  panelUserWith,
} from './commercial-helpers';
import { foam } from './measurement-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  createPurchase,
  createSupplier,
  linen,
  staples,
} from './purchasing-helpers';
import { day, today, userIdOf } from './production-helpers';

/**
 * Simplificação Fase 3 — recebimentos compartilhados (dados fictícios; nenhum pagamento real).
 *  A. Central "Aguardando chegada": peças × materiais, privacidade, sem valores, sem "atraso".
 *  B. Peças: confirmação rápida, parcial → OS só do que chegou, versão (dois tablets),
 *     simultâneas, repetição após falha de rede, tempo real.
 *  C. Materiais: contagem física, metros sem metragem inventada (conferência depois), parcial,
 *     divergência opcional, sem estoque/obrigação duplicados.
 *  D. Participantes operacionais da logística (com e sem custo) e permissões.
 */
let app: App;
const sockets: WsClient[] = [];
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

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown) =>
  c.req('PUT', path, body, { 'idempotency-key': idemKey() });

async function logistics(admin: Client) {
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

/** Serviço fechado (Fase 2) com retirada HOJE: três sofás iguais + uma poltrona. */
async function service(
  admin: Client,
  pickup: Record<string, unknown> = {},
  name = 'Maria Aparecida Fictícia',
) {
  const r = await post(admin, '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name,
      phone: null,
      allowSimilar: true,
      address: { ...address, isPrimary: true },
    },
    service: {
      promisedDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      contractedService: 'Reforma completa',
      agreedValueCents: 450000,
      items: [
        {
          pieceType: 'SOFA',
          description: 'Sofás iguais',
          quantity: 3,
          serviceType: 'REFORMA_COMPLETA',
        },
        {
          pieceType: 'POLTRONA',
          description: 'Poltrona',
          quantity: 1,
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    },
    pickup: {
      scheduledDate: today(),
      windowStart: '00:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      ...pickup,
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const order = await db().commercialOrder.findUniqueOrThrow({
    where: { id: r.body.order.id },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  return { res: r.body, order, sofas: order.items[0]!, armchair: order.items[1]! };
}

async function tablets(admin: Client) {
  const joao = (
    await setupTablet(app, admin, { name: 'Tablet João', employee: 'João', pin: '111222' })
  ).tablet;
  const marcio = (
    await setupTablet(app, admin, { name: 'Tablet Márcio', employee: 'Márcio', pin: '333444' })
  ).tablet;
  return { joao, marcio };
}

const arrivals = async (c: Client) => (await c.get('/api/v1/arrivals')).body;
const pieceCard = async (c: Client, pickupId: string) =>
  ((await arrivals(c)).pieces ?? []).find((p: { pickupId: string }) => p.pickupId === pickupId);

describe('A. Central "Aguardando chegada"', () => {
  it('peças e materiais separados; nome reduzido no tablet; sem valores e sem "atraso" (CA3-01..03, CA3-22)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res } = await service(admin, { amountCents: 10000 });
    // Retirada de outro dia não aparece; a de hoje sim.
    const future = await service(
      admin,
      { scheduledDate: day(3), windowStart: '10:00' },
      'Cliente Futuro',
    );
    const { joao } = await tablets(admin);
    const a = await arrivals(joao);
    expect(Array.isArray(a.pieces)).toBe(true);
    expect(Array.isArray(a.materials)).toBe(true);
    const card = a.pieces.find((p: { pickupId: string }) => p.pickupId === res.pickup.id);
    expect(card).toMatchObject({
      customerName: 'Maria F.',
      pendingTotal: 4,
      stage: 'RETIRADA_PREVISTA',
    });
    expect(card.stageLabel).toMatch(/equipe no cliente a partir das 00:00/);
    expect(a.pieces.some((p: { pickupId: string }) => p.pickupId === future.res.pickup.id)).toBe(
      false,
    );
    const text = JSON.stringify(a);
    expect(text).not.toMatch(/Cents|price|preço|valor|amount|atras/i);
    // Painel vê o nome completo.
    expect((await pieceCard(admin, res.pickup.id)).customerName).toBe('Maria Aparecida Fictícia');
    // Retirada realizada (coleta feita): "a caminho da oficina" — nunca "atrasada".
    const p = (await admin.get(`/api/v1/pickups/${res.pickup.id}`)).body;
    for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
      const cur = (await admin.get(`/api/v1/pickups/${p.id}`)).body;
      expect(
        (
          await post(admin, `/api/v1/pickups/${p.id}/transition`, {
            toStatus,
            version: cur.version,
          })
        ).status,
      ).toBe(200);
    }
    expect(await pieceCard(joao, res.pickup.id)).toMatchObject({
      stage: 'A_CAMINHO',
      stageLabel: 'A caminho da oficina',
    });
  });
});

describe('B. Peças de clientes', () => {
  it('confirmação rápida registra quem, tablet e quando; parcial cria OS só do que chegou (CA3-04..08)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order, sofas } = await service(admin);
    const { joao } = await tablets(admin);
    const card = await pieceCard(joao, res.pickup.id);
    // Chegaram 2 dos 3 sofás (a poltrona ainda não).
    const r = await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: card.version,
      lines: [{ orderItemId: sofas.id, quantity: 2 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'PECAS', remaining: 2, confirmedBy: 'João' });
    expect(r.body.serviceOrder.code).toMatch(/^OS-/);
    const receipt = await db().receipt.findUniqueOrThrow({
      where: { id: r.body.receipt.id },
      include: { lines: true, device: true, registeredBy: true },
    });
    expect(receipt.device?.name).toBe('Tablet João');
    expect(receipt.registeredBy?.displayName).toBe('João');
    expect(receipt.lines.map((l) => [l.orderItemId, l.quantity])).toEqual([[sofas.id, 2]]);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'receipt.registered', entityId: receipt.id },
    });
    expect(log.changes).toMatchObject({ deviceId: receipt.deviceId });
    const so = await db().serviceOrder.findUniqueOrThrow({
      where: { id: r.body.serviceOrder.id },
      include: { items: true },
    });
    expect(so.items.map((i) => [i.orderItemId, i.quantity])).toEqual([[sofas.id, 2]]);
    // Ausentes continuam pendentes; o aviso mostra o saldo e "chegou em parte".
    const after = await pieceCard(joao, res.pickup.id);
    expect(after).toMatchObject({ stage: 'CHEGOU_EM_PARTE', pendingTotal: 2 });
    expect(
      after.items.map((i: { description: string; pending: number }) => [i.description, i.pending]),
    ).toEqual([
      ['Sofás iguais', 1],
      ['Poltrona', 1],
    ]);
    expect((await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'RECEBIDO_PARCIAL',
    );
    expect(
      (await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } })).status,
    ).toBe('RETIRADA_REALIZADA');
    // O restante (confirmação padrão = todo o saldo) cria a OS do restante e encerra o aviso.
    const rest = await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: after.version,
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.remaining).toBe(0);
    const so2 = await db().serviceOrder.findUniqueOrThrow({
      where: { id: rest.body.serviceOrder.id },
      include: { items: true },
    });
    expect(so2.items.map((i) => i.quantity).sort()).toEqual([1, 1]);
    expect(await pieceCard(joao, res.pickup.id)).toBeUndefined();
    expect(
      (await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } })).status,
    ).toBe('RECEBIDA_NA_OFICINA');
    const inOs = await db().serviceOrderItem.aggregate({
      where: { serviceOrder: { orderId: order.id } },
      _sum: { quantity: true },
    });
    expect(inOs._sum.quantity).toBe(4);
  });

  it('João e Márcio com a mesma tela: só uma confirmação vale; a outra recebe "já atualizado" (CA3-09, CA3-10)', async () => {
    const admin = await loginAdmin(app);
    const { andre } = await logistics(admin);
    const { res, order } = await service(admin, { amountCents: 10000 });
    const { joao, marcio } = await tablets(admin);
    const seen = await pieceCard(joao, res.pickup.id);
    const first = await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: seen.version,
    });
    expect(first.status).toBe(201);
    const stale = await post(marcio, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: seen.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toBe(
      'Este recebimento já foi atualizado. Confira o saldo atual antes de confirmar.',
    );
    expect(await db().receipt.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    // Custo da viagem: UMA obrigação (André), nenhuma para quem confirmou.
    expect(await db().accountPayable.count()).toBe(1);
    const cost = await db().logisticsCost.findFirstOrThrow({ where: { pickupId: res.pickup.id } });
    expect(cost).toMatchObject({ status: 'DEVIDO', payeeUserId: andre });
  });

  it('simultâneas com a mesma versão: uma vence; nada é duplicado (CA3-10)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order } = await service(admin, { amountCents: 10000 });
    const { joao, marcio } = await tablets(admin);
    const v = (await pieceCard(joao, res.pickup.id)).version;
    const [a, b] = await Promise.all([
      post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v }),
      post(marcio, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db().receipt.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    const items = await db().commercialOrderItem.findMany({ where: { orderId: order.id } });
    expect(items.reduce((s, i) => s + i.receivedQuantity, 0)).toBe(4);
    expect(await db().accountPayable.count()).toBe(1);
  });

  it('corrida forçada (determinística): B lê a retirada, A confirma e grava, B lê o saldo → 409 (CA3-10)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order } = await service(admin, { amountCents: 10000 });
    const { joao, marcio } = await tablets(admin);
    const v = (await pieceCard(joao, res.pickup.id)).version;
    const url = `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`;
    // Intercalação exata da corrida original (CI nº 88), sem atrasos: B pausa logo após ler a
    // retirada (versão v) e só continua depois que A terminou e gravou.
    let bReadPickup!: () => void;
    const bPaused = new Promise<void>((r) => (bReadPickup = r));
    let resumeB!: () => void;
    const gate = new Promise<void>((r) => (resumeB = r));
    let calls = 0;
    arrivalTestHooks.afterPickupRead = async () => {
      if (++calls === 1) {
        bReadPickup();
        await gate;
      }
    };
    try {
      const bReq = post(marcio, url, { version: v });
      await bPaused; // B já leu a retirada com a versão v
      const a = await post(joao, url, { version: v }); // A confirma tudo e grava
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      resumeB(); // B lê o saldo (já zerado pela confirmação de A)
      const b = await bReq;
      expect(calls).toBe(2);
      expect(b.status, JSON.stringify(b.body)).toBe(409);
      expect(b.body.error.message).toBe(
        'Este recebimento já foi atualizado. Confira o saldo atual antes de confirmar.',
      );
      expect(b.body.error.details).toMatchObject({ currentVersion: v + 1 });
    } finally {
      arrivalTestHooks.afterPickupRead = undefined;
    }
    // Integridade: um recebimento, uma OS, saldo coerente, uma obrigação, retirada concluída.
    expect(await db().receipt.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    const items = await db().commercialOrderItem.findMany({ where: { orderId: order.id } });
    expect(items.reduce((s, i) => s + i.receivedQuantity, 0)).toBe(4);
    expect(await db().accountPayable.count()).toBe(1);
    const pk = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } });
    expect(pk).toMatchObject({ version: v + 1, status: 'RECEBIDA_NA_OFICINA' });
    // Persistência coerente: o recebimento é o de A (João) e o aviso sumiu do tablet de B.
    const receipt = await db().receipt.findFirstOrThrow({ where: { orderId: order.id } });
    expect(receipt.receivedByEmployeeId).toBe(
      (await db().employee.findFirstOrThrow({ where: { displayName: 'João' } })).id,
    );
    expect(await pieceCard(marcio, res.pickup.id)).toBeUndefined();
  });

  it('falha de rede: repetir a mesma confirmação devolve o mesmo resultado (CA3-11)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order } = await service(admin);
    const { joao } = await tablets(admin);
    const v = (await pieceCard(joao, res.pickup.id)).version;
    const key = idemKey();
    const first = await post(
      joao,
      `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`,
      { version: v },
      key,
    );
    const again = await post(
      joao,
      `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`,
      { version: v },
      key,
    );
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await db().receipt.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(1);
    // O tablet consulta o estado atualizado: o aviso não existe mais.
    expect(await pieceCard(joao, res.pickup.id)).toBeUndefined();
  });

  it('dois funcionários com quantidades parciais diferentes em sequência: sem perda nem duplicação', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order, sofas, armchair } = await service(admin);
    const { joao, marcio } = await tablets(admin);
    const v1 = (await pieceCard(joao, res.pickup.id)).version;
    const a = await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: v1,
      lines: [{ orderItemId: sofas.id, quantity: 1 }],
    });
    expect(a.status).toBe(201);
    const v2 = (await pieceCard(marcio, res.pickup.id)).version;
    expect(v2).toBeGreaterThan(v1);
    const b = await post(marcio, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: v2,
      lines: [
        { orderItemId: sofas.id, quantity: 2 },
        { orderItemId: armchair.id, quantity: 1 },
      ],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.remaining).toBe(0);
    const recs = await db().receipt.findMany({
      where: { orderId: order.id },
      include: { registeredBy: true },
    });
    expect(recs.map((r) => r.registeredBy?.displayName).sort()).toEqual(['João', 'Márcio']);
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(2);
    // Acima do saldo da retirada: recusado.
    const over = await post(marcio, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: b.body
        ? (await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } })).version
        : 0,
      lines: [{ orderItemId: sofas.id, quantity: 1 }],
    });
    expect(over.status).toBe(409);
  });

  it('o aviso some dos outros tablets em tempo real; reconexão recupera o estado (CA3-12, CA3-13)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res } = await service(admin);
    const { joao, marcio } = await tablets(admin);
    const ws = await WsClient.connect(app, marcio);
    sockets.push(ws);
    const v = (await pieceCard(joao, res.pickup.id)).version;
    expect(
      (await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v }))
        .status,
    ).toBe(201);
    const ev = await ws.waitFor((m) => m.event?.type === 'receipt.registered');
    expect(JSON.stringify(ev.event.payload)).not.toMatch(/Cents|amount|valor/i);
    expect(await pieceCard(marcio, res.pickup.id)).toBeUndefined();
    // Reconexão a partir de uma sequência antiga recebe o evento perdido.
    const back = await WsClient.connect(app, marcio, '0');
    sockets.push(back);
    await back.waitFor((m) => m.event?.type === 'receipt.registered');
  });

  it('pedidos antigos: recebimento pelo painel sem versão continua; parcial não fecha a retirada (CA3-24)', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin, { name: 'Cliente Legado', phone: null });
    const order = await createOrder(admin, customer, [
      { pieceType: 'CADEIRA', description: 'Cadeiras', quantity: 4 },
    ]);
    const pk = await post(admin, '/api/v1/pickups', {
      orderId: order.id,
      scheduledDate: today(),
      windowStart: '09:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items: [{ orderItemId: order.items[0].id, quantity: 4 }],
    });
    expect(pk.status).toBe(201);
    const r1 = await post(admin, '/api/v1/receipts', {
      orderId: order.id,
      pickupId: pk.body.id,
      origin: 'RETIRADA',
      lines: [
        { orderItemId: order.items[0].id, quantity: 3, condition: 'BOA', location: 'Bancada' },
      ],
    });
    expect(r1.status).toBe(201);
    expect(r1.body.generatedServiceOrder).toBeNull();
    expect((await admin.get(`/api/v1/pickups/${pk.body.id}`)).body.status).toBe(
      'RETIRADA_REALIZADA',
    );
    const r2 = await post(admin, '/api/v1/receipts', {
      orderId: order.id,
      pickupId: pk.body.id,
      origin: 'RETIRADA',
      lines: [
        { orderItemId: order.items[0].id, quantity: 1, condition: 'BOA', location: 'Bancada' },
      ],
    });
    expect(r2.status).toBe(201);
    expect((await admin.get(`/api/v1/pickups/${pk.body.id}`)).body.status).toBe(
      'RECEBIDA_NA_OFICINA',
    );
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('C. Materiais comprados', () => {
  async function purchase(admin: Client) {
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Material', (s) => [
      linen(s.items[0].id, 15),
      foam({ serviceOrderItemId: s.items[0].id, quantity: 20 }),
      staples({ quantity: 4 }),
    ]);
    const supplier = await createSupplier(admin);
    const byKind = (k: string) => reqs.find((r) => r.kind === k)!;
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      expectedDate: today(),
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: byKind('TECIDO').id, quantity: 15 }],
          quantity: 15,
          unitPriceCents: 4500,
        },
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: byKind('ESPUMA').id, quantity: 20 }],
          quantity: 20,
          unitPriceCents: 3000,
        },
        {
          sourcing: 'ESTOQUE',
          allocations: [{ materialRequirementId: byKind('OUTRO').id, quantity: 4 }],
          quantity: 4,
          unitPriceCents: 1000,
        },
      ],
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const c = await confirmPurchase(admin, po.body);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const items = await db().purchaseOrderItem.findMany({
      where: { purchaseOrderId: po.body.id },
      orderBy: { position: 'asc' },
    });
    return { so, po: c.body, fabricItem: items[0]!, foamItem: items[1]!, stapleItem: items[2]! };
  }
  const card = async (c: Client, poId: string) =>
    (await arrivals(c)).materials.find(
      (m: { purchaseOrderId: string }) => m.purchaseOrderId === poId,
    );

  it('contagem física, metros sem metragem inventada, parcial e conferência posterior (CA3-14..16, CA3-18, CA3-19)', async () => {
    const admin = await loginAdmin(app);
    const { po, fabricItem, foamItem, stapleItem } = await purchase(admin);
    const { joao, marcio } = await tablets(admin);
    const payablesBefore = await db().accountPayable.count();
    const c0 = await card(joao, po.id);
    expect(c0).toMatchObject({ code: po.code, dueLabel: 'Previsto para hoje' });
    expect(
      c0.items.map((i: { description: string; mode: string; pending: number }) => [
        i.mode,
        i.pending,
      ]),
    ).toEqual([
      ['FISICA', 15],
      ['CONTAGEM', 20],
      ['CONTAGEM', 4],
    ]);
    expect(JSON.stringify(c0)).not.toMatch(/Cents|price|preço|valor/i);
    // Chegaram 3 rolos de tecido, 15 de 20 placas de espuma e as 4 embalagens de grampo.
    const r = await post(joao, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, {
      version: c0.version,
      lines: [
        { purchaseOrderItemId: fabricItem.id, quantity: 3, physicalUnit: 'ROLO' },
        { purchaseOrderItemId: foamItem.id, quantity: 15 },
        { purchaseOrderItemId: stapleItem.id, quantity: 4 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.receipt.code).toMatch(/^RM-/);
    expect(r.body.arrival.code).toMatch(/^CH-/);
    expect(r.body.remaining).toBe(5);
    const items = new Map(
      (await db().purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } })).map((i) => [
        i.id,
        Number(i.receivedQuantity),
      ]),
    );
    // 3 rolos NÃO viraram 3 metros.
    expect(items.get(fabricItem.id)).toBe(0);
    expect(items.get(foamItem.id)).toBe(15);
    expect(items.get(stapleItem.id)).toBe(4);
    const arrival = await db().materialArrival.findUniqueOrThrow({
      where: { id: r.body.arrival.id },
    });
    expect(arrival.lines).toEqual([
      expect.objectContaining({
        purchaseOrderItemId: fabricItem.id,
        physicalCount: 3,
        physicalUnit: 'ROLO',
        unit: 'METRO',
      }),
    ]);
    // Estoque: UMA entrada das 4 embalagens (item de estoque).
    const mv = await db().stockMovement.findMany({ where: { type: 'ENTRADA_COMPRA' } });
    expect(mv.map((m) => Number(m.quantity))).toEqual([4]);
    // Central: só as 5 placas faltando; o tecido aguarda conferência (não volta como pendente).
    const c1 = await card(marcio, po.id);
    expect(
      c1.items.map((i: { purchaseOrderItemId: string; pending: number }) => [
        i.purchaseOrderItemId,
        i.pending,
      ]),
    ).toEqual([[foamItem.id, 5]]);
    expect(c1.awaitingConference).toBe(1);
    // Márcio com a tela antiga: recusado, nada duplicado.
    const stale = await post(marcio, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, {
      version: c0.version,
      lines: [{ purchaseOrderItemId: foamItem.id, quantity: 5 }],
    });
    expect(stale.status).toBe(409);
    expect(await db().stockMovement.count({ where: { type: 'ENTRADA_COMPRA' } })).toBe(1);
    // Márcio com a tela atual: as 5 restantes.
    const fin = await post(marcio, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, {
      version: c1.version,
      lines: [{ purchaseOrderItemId: foamItem.id, quantity: 5 }],
    });
    expect(fin.status, JSON.stringify(fin.body)).toBe(201);
    expect(fin.body.remaining).toBe(0);
    expect(await card(marcio, po.id)).toBeUndefined();
    // Gestor confere o tecido (medida real) e libera; a chegada física fica CONFERIDA.
    const pending = (await admin.get('/api/v1/material-arrivals?status=PENDENTE_CONFERENCIA')).body;
    expect(pending.map((a: { id: string }) => a.id)).toEqual([arrival.id]);
    expect(pending[0]).toMatchObject({ receivedBy: 'João', device: 'Tablet João' });
    // Recebimento comum do mesmo tecido (sem a conferência) é recusado: contaria a remessa 2×.
    const bypass = await post(admin, '/api/v1/material-receipts', {
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderItemId: fabricItem.id, acceptedQuantity: 14.5, specConfirmed: true }],
    });
    expect(bypass.status).toBe(409);
    expect(bypass.body.error.message).toMatch(/aguarda conferência/);
    // A conferência só inclui os itens da própria chegada.
    const outside = await post(admin, '/api/v1/material-receipts', {
      purchaseOrderId: po.id,
      arrivalId: arrival.id,
      lines: [{ purchaseOrderItemId: stapleItem.id, acceptedQuantity: 1, specConfirmed: true }],
    });
    expect(outside.status).toBe(400);
    const conf = await post(admin, '/api/v1/material-receipts', {
      purchaseOrderId: po.id,
      arrivalId: arrival.id,
      lines: [{ purchaseOrderItemId: fabricItem.id, acceptedQuantity: 14.5, specConfirmed: true }],
    });
    expect(conf.status, JSON.stringify(conf.body)).toBe(201);
    expect(
      (await db().materialArrival.findUniqueOrThrow({ where: { id: arrival.id } })).status,
    ).toBe('CONFERIDA');
    expect(
      Number(
        (await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: fabricItem.id } }))
          .receivedQuantity,
      ),
    ).toBe(14.5);
    // Nenhuma conta a pagar criada pelos recebimentos.
    expect(await db().accountPayable.count()).toBe(payablesBefore);
  });

  it('simultâneas e divergência opcional: material danificado registrado, mas não disponível (CA3-17, CA3-10)', async () => {
    const admin = await loginAdmin(app);
    const { po, foamItem } = await purchase(admin);
    const { joao, marcio } = await tablets(admin);
    const v = (await card(joao, po.id)).version;
    const [a, b] = await Promise.all([
      post(joao, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, {
        version: v,
        lines: [{ purchaseOrderItemId: foamItem.id, quantity: 10 }],
      }),
      post(marcio, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, {
        version: v,
        lines: [{ purchaseOrderItemId: foamItem.id, quantity: 10 }],
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(
      Number(
        (await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: foamItem.id } }))
          .receivedQuantity,
      ),
    ).toBe(10);
    const v2 = (await card(joao, po.id)).version;
    const damaged = await post(joao, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, {
      version: v2,
      lines: [{ purchaseOrderItemId: foamItem.id, quantity: 2 }],
      problem: {
        kind: 'DANIFICADO',
        purchaseOrderItemId: foamItem.id,
        note: 'Duas placas rasgadas',
      },
    });
    expect(damaged.status, JSON.stringify(damaged.body)).toBe(201);
    const line = await db().materialReceiptLine.findFirstOrThrow({
      where: { purchaseOrderItemId: foamItem.id, issue: 'DANIFICADO' },
    });
    expect([Number(line.acceptedQuantity), Number(line.rejectedQuantity)]).toEqual([0, 2]);
    expect(
      Number(
        (await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: foamItem.id } }))
          .receivedQuantity,
      ),
    ).toBe(10);
  });
});

describe('D. Participantes operacionais e permissões', () => {
  it('equipe própria sem custo: João participante vê a parada; nenhuma obrigação (CA3-20, CA3-21)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const joaoId = await userIdOf('João');
    const { res } = await service(admin, { team: 'EQUIPE_PROPRIA', participantUserIds: [joaoId] });
    expect(res.pickup).toMatchObject({ responsible: 'Thiago', participants: ['João'] });
    expect(
      await db().logisticsTripParticipant.count({
        where: { pickupId: res.pickup.id, userId: joaoId },
      }),
    ).toBe(1);
    const pickup = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } });
    expect(pickup.teamNotes ?? '').not.toMatch(/Participantes/);
    const { joao } = await tablets(admin);
    const route = (await joao.get(`/api/v1/logistics/route?date=${today()}`)).body;
    expect(route.stops.map((s: { job: { id: string } }) => s.job.id)).toContain(res.pickup.id);
    expect(JSON.stringify(route)).not.toMatch(/Cents|amount|R\$/i);
    const thiago = (
      await setupTablet(app, admin, { name: 'Tablet Thiago', employee: 'Thiago', pin: '555666' })
    ).tablet;
    const tr = (await thiago.get(`/api/v1/logistics/route?date=${today()}`)).body;
    expect(tr.stops.map((s: { job: { id: string } }) => s.job.id)).toContain(res.pickup.id);
    // Ricardo não participa: não vê.
    const ricardo = (
      await setupTablet(app, admin, { name: 'Tablet Ricardo', employee: 'Ricardo', pin: '777888' })
    ).tablet;
    const rr = (await ricardo.get(`/api/v1/logistics/route?date=${today()}`)).body;
    expect(rr.stops.map((s: { job: { id: string } }) => s.job.id)).not.toContain(res.pickup.id);
    // Concluída a operação: nenhum custo, nenhuma obrigação para participantes.
    const v = (await pieceCard(joao, res.pickup.id)).version;
    expect(
      (await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v }))
        .status,
    ).toBe(201);
    expect(await db().logisticsCost.count({ where: { pickupId: res.pickup.id } })).toBe(0);
    expect(await db().accountPayable.count()).toBe(0);
    // Participantes atualizáveis pelo gestor.
    const pk = (await admin.get(`/api/v1/pickups/${res.pickup.id}`)).body;
    void pk;
  });

  it('terceirizada R$ 100 com André e Izaías: um único credor; Izaías participante vê a parada (CA3-21)', async () => {
    const admin = await loginAdmin(app);
    const { andre, izaias } = await logistics(admin);
    const { res } = await service(admin, { participantUserIds: [izaias], amountCents: 10000 });
    expect(
      await db().logisticsTripParticipant.count({
        where: { pickupId: res.pickup.id, userId: izaias },
      }),
    ).toBe(1);
    const iz = (
      await setupTablet(app, admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '999000' })
    ).tablet;
    const route = (await iz.get(`/api/v1/logistics/route?date=${today()}`)).body;
    expect(route.stops.map((s: { job: { id: string } }) => s.job.id)).toContain(res.pickup.id);
    const { joao } = await tablets(admin);
    const v = (await pieceCard(joao, res.pickup.id)).version;
    expect(
      (await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v }))
        .status,
    ).toBe(201);
    const payables = await db().accountPayable.findMany();
    expect(payables).toHaveLength(1);
    expect(payables[0]!.amountCents).toBe(10000);
    const cost = await db().logisticsCost.findFirstOrThrow({ where: { pickupId: res.pickup.id } });
    expect(cost.payeeUserId).toBe(andre);
  });

  it('permissões: logística sem recebimento de peças; confirmar não dá acesso financeiro (CA3-23)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res } = await service(admin);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const a = await arrivals(andre);
    expect(a.pieces).toBeNull();
    const card = await pieceCard(admin, res.pickup.id);
    expect(
      (
        await post(andre, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
          version: card.version,
        })
      ).status,
    ).toBe(403);
    const { joao } = await tablets(admin);
    for (const path of [
      '/api/v1/finance/labor',
      '/api/v1/finance/payables',
      '/api/v1/material-arrivals',
      '/api/v1/purchasing/needs',
    ]) {
      expect((await joao.get(path)).status, path).toBe(403);
    }
    // Recebimentos no tablet: cliente com nome reduzido.
    const v = card.version;
    await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v });
    const list = (await joao.get('/api/v1/receipts')).body;
    expect(list[0].customer.name).toBe('Maria F.');
  });
});

describe('E. Estabilização: data/hora, recusas e dados legados', () => {
  it('data e hora efetivamente gravadas na confirmação (CA3-05)', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order } = await service(admin);
    const { joao } = await tablets(admin);
    const v = (await pieceCard(joao, res.pickup.id)).version;
    const t0 = Date.now();
    const r = await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v });
    const t1 = Date.now();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const receipt = await db().receipt.findFirstOrThrow({ where: { orderId: order.id } });
    for (const at of [receipt.receivedAt, receipt.createdAt]) {
      expect(at.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
      expect(at.getTime()).toBeLessThanOrEqual(t1 + 1000);
    }
    expect(r.body.confirmedAt).toBe(receipt.createdAt.toISOString());
    // O mesmo instante aparece na auditoria do recebimento.
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'receipt.registered', entityId: receipt.id },
    });
    expect(Math.abs(log.createdAt.getTime() - receipt.createdAt.getTime())).toBeLessThan(1000);
    // Recebimento pelo painel com data/hora informadas: grava exatamente o informado.
    const legacyCustomer = await createCustomer(admin, {
      name: 'Cliente Hora Informada',
      phone: null,
      allowSimilar: true,
    });
    const legacy = await createOrder(admin, legacyCustomer, [
      { pieceType: 'SOFA', description: 'Sofá', quantity: 1 },
    ]);
    const at = '2026-10-10T14:35:00-03:00';
    const p = await post(admin, '/api/v1/receipts', {
      orderId: legacy.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      receivedAt: at,
      lines: [{ orderItemId: legacy.items[0].id, quantity: 1, condition: 'BOA', location: 'Área' }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const saved = await db().receipt.findUniqueOrThrow({ where: { id: p.body.id } });
    expect(saved.receivedAt.toISOString()).toBe(new Date(at).toISOString());
  });

  it('recusas sem efeito colateral: retirada inexistente, cancelada e sem permissão', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { res, order } = await service(admin);
    const { joao } = await tablets(admin);
    const counts = async () => ({
      receipts: await db().receipt.count(),
      os: await db().serviceOrder.count(),
      received: (await db().commercialOrderItem.findMany({ where: { orderId: order.id } })).reduce(
        (a, i) => a + i.receivedQuantity,
        0,
      ),
      payables: await db().accountPayable.count(),
    });
    const before = await counts();
    const v = (await pieceCard(joao, res.pickup.id)).version;
    // Retirada inexistente → 404.
    const missing = await post(joao, `/api/v1/arrivals/pickups/${crypto.randomUUID()}/confirm`, {
      version: 1,
    });
    expect(missing.status).toBe(404);
    // Painel sem "recebimentos.registrar" → 403.
    const viewer = await panelUserWith(app, admin, 'so-pedidos', ['pedidos.ver']);
    expect(
      (await post(viewer, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, { version: v }))
        .status,
    ).toBe(403);
    // Retirada cancelada → recusada (a peça não vai chegar por ela).
    const pk = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } });
    const cancel = await admin.post(
      `/api/v1/pickups/${res.pickup.id}/transition`,
      { toStatus: 'CANCELADA', note: 'Cliente desistiu', version: pk.version },
      { 'idempotency-key': idemKey() },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const after = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup.id } });
    const refused = await post(joao, `/api/v1/arrivals/pickups/${res.pickup.id}/confirm`, {
      version: after.version,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.message).toMatch(/não está em situação de recebimento/);
    expect(await counts()).toEqual(before);
  });

  it('pedido antigo (sem OS automática) confirmado no tablet: recebe as peças e não cria OS', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const customer = await createCustomer(admin, {
      name: 'Cliente Pedido Antigo',
      phone: null,
      allowSimilar: true,
    });
    const order = await createOrder(admin, customer, [
      { pieceType: 'SOFA', description: 'Sofá antigo', quantity: 2 },
    ]);
    const pickup = await createPickup(admin, order, today());
    const { joao } = await tablets(admin);
    const card = await pieceCard(joao, pickup.id);
    expect(card).toBeTruthy();
    const r = await post(joao, `/api/v1/arrivals/pickups/${pickup.id}/confirm`, {
      version: card.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.serviceOrder).toBeNull();
    expect(await db().serviceOrder.count({ where: { orderId: order.id } })).toBe(0);
    const item = await db().commercialOrderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(item.receivedQuantity).toBe(2);
    const o = await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.autoServiceOrder).toBe(false);
    // A OS segue manual, como antes da Fase 2.
    const so = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: [
        {
          orderItemId: item.id,
          quantity: 2,
          description: 'Sofá antigo',
          serviceType: 'REFORMA_COMPLETA',
        },
      ],
    });
    expect(so.status, JSON.stringify(so.body)).toBe(201);
  });
});
