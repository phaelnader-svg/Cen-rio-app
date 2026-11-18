import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  createCustomer,
  createOrder,
  generateOsFromOrder,
  panelUserWith,
} from './commercial-helpers';
import { day, userIdOf } from './production-helpers';

/**
 * Estabilização da Simplificação, Fase 2 — o fechamento do serviço registra o tapeceiro titular e
 * a mão de obra PREVISTA de cada peça (Fase 1 §4.3 opção B). Rastreio:
 * tela → contrato (`newServiceSchema`) → API (`POST /services`) → persistência
 * (`commercial_order_items.planned_*`) → OS gerada no fechamento (titular + mão de obra combinada,
 * valor por unidade × quantidade) → planejamento (titular da peça) → financeiro
 * (obrigação PREVISTO; nada pago, nada duplicado).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDatabase());

const post = (c: Client, path: string, body: unknown, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown) =>
  c.req('PUT', path, body, { 'idempotency-key': idemKey() });

type Intent = { plannedUpholstererUserId?: string | null; plannedLaborUnitCents?: number | null };

async function closeService(c: Client, sofa: Intent, poltronas: Intent, key = idemKey()) {
  return post(
    c,
    '/api/v1/services',
    {
      customer: {
        mode: 'NOVO',
        kind: 'PF',
        name: 'Cliente Titular Previsto',
        phone: null,
        allowSimilar: true,
      },
      service: {
        contractedService: 'Reforma completa',
        promisedDate: day(30),
        items: [
          {
            pieceType: 'SOFA',
            description: 'Sofá 3 lugares',
            quantity: 1,
            serviceType: 'REFORMA_COMPLETA',
            ...sofa,
          },
          {
            pieceType: 'POLTRONA',
            description: 'Poltronas',
            quantity: 2,
            serviceType: 'TROCA_DE_TECIDO',
            ...poltronas,
          },
        ],
      },
      pickup: null,
    },
    key,
  );
}

const orderOf = async (c: Client, id: string) => {
  const r = await c.get(`/api/v1/orders/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    version: number;
    plannedLaborVisible: boolean;
    items: {
      id: string;
      description: string;
      plannedUpholsterer: { userId: string; displayName: string } | null;
      plannedLaborUnitCents: number | null;
    }[];
  };
};
const osItems = (orderId: string) =>
  db().serviceOrderItem.findMany({
    where: { serviceOrder: { orderId } },
    orderBy: [{ serviceOrder: { number: 'asc' } }, { position: 'asc' }],
    include: { serviceOrder: { select: { id: true, notes: true } } },
  });
const payables = (orderId: string) =>
  db().productionPayable.findMany({
    where: { serviceOrder: { orderId } },
    orderBy: { number: 'asc' },
  });
const counts = async () => ({
  orders: await db().commercialOrder.count(),
  items: await db().commercialOrderItem.count(),
  customers: await db().customer.count(),
  payables: await db().productionPayable.count(),
});

describe('A. Fechamento: persistência e validação', () => {
  it('registra titular e mão de obra prevista por peça; nada financeiro nasce no fechamento', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await userIdOf('Ricardo');
    const marcio = await userIdOf('Márcio');
    const r = await closeService(
      admin,
      { plannedUpholstererUserId: ricardo, plannedLaborUnitCents: 30000 },
      { plannedUpholstererUserId: marcio, plannedLaborUnitCents: 15000 },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const order = await orderOf(admin, r.body.order.id);
    expect(order.plannedLaborVisible).toBe(true);
    expect(order.items.map((i) => [i.plannedUpholsterer, i.plannedLaborUnitCents])).toEqual([
      [{ userId: ricardo, displayName: 'Ricardo' }, 30000],
      [{ userId: marcio, displayName: 'Márcio' }, 15000],
    ]);
    // Fluxo da OS (2026-11-18): o fechamento não gera OS nem obrigação; o previsto fica no
    // pedido e preenche a OS quando ela for gerada.
    expect(await db().serviceOrder.count()).toBe(0);
    expect(await db().productionPayable.count()).toBe(0);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'order.created', entityId: r.body.order.id },
    });
    expect((log.changes as { plannedIntent: unknown[] }).plannedIntent).toHaveLength(2);
    // Sem financeiro.ver: o titular aparece, o valor previsto não.
    const viewer = await panelUserWith(app, admin, 'vendedor', ['pedidos.ver']);
    const seen = await orderOf(viewer, r.body.order.id);
    expect(seen.plannedLaborVisible).toBe(false);
    expect(
      seen.items.map((i) => [i.plannedUpholsterer?.displayName, i.plannedLaborUnitCents]),
    ).toEqual([
      ['Ricardo', null],
      ['Márcio', null],
    ]);
  });

  it('recusa intenção inválida sem gravar nada (sem titular, inelegível, não tapeceiro principal)', async () => {
    const admin = await loginAdmin(app);
    const before = await counts();
    // Mão de obra sem titular: contrato.
    const a = await closeService(admin, { plannedLaborUnitCents: 30000 }, {});
    expect(a.status).toBe(400);
    expect(JSON.stringify(a.body)).toMatch(/Escolha o tapeceiro titular/);
    const zero = await closeService(
      admin,
      { plannedUpholstererUserId: await userIdOf('Ricardo'), plannedLaborUnitCents: 0 },
      {},
    );
    expect(zero.status).toBe(400);
    // Thiago sem corte e costura não pode ser titular.
    const thiago = await userIdOf('Thiago');
    const b = await closeService(admin, { plannedUpholstererUserId: thiago }, {});
    expect(b.status).toBe(422);
    expect(b.body.error.message).toMatch(/titular precisa ser um tapeceiro ativo/);
    // Com corte e costura ele pode ser titular, mas mão de obra por produção é só do tapeceiro.
    const emp = await db().employee.findFirstOrThrow({ where: { userId: thiago } });
    await db().employeeSkill.create({ data: { employeeId: emp.id, skill: 'CORTE_COSTURA' } });
    const c = await closeService(
      admin,
      { plannedUpholstererUserId: thiago, plannedLaborUnitCents: 20000 },
      {},
    );
    expect(c.status).toBe(422);
    expect(c.body.error.message).toMatch(/só para o tapeceiro principal/);
    // Usuário inexistente como titular.
    const d = await closeService(
      admin,
      { plannedUpholstererUserId: '00000000-0000-4000-8000-000000000000' },
      {},
    );
    expect(d.status).toBe(422);
    expect(await counts()).toEqual(before);
    // Thiago com a competência, sem valor: aceito.
    const ok = await closeService(admin, { plannedUpholstererUserId: thiago }, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('permissões: titular exige producao.planejar; mão de obra exige financeiro.gerenciar', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await userIdOf('Ricardo');
    const base = ['pedidos.gerenciar', 'retiradas.gerenciar', 'clientes.gerenciar'];
    const seller = await panelUserWith(app, admin, 'vendas', base);
    const planner = await panelUserWith(app, admin, 'planejador', [...base, 'producao.planejar']);
    const before = await counts();
    const a = await closeService(seller, { plannedUpholstererUserId: ricardo }, {});
    expect(a.status).toBe(403);
    const b = await closeService(
      planner,
      { plannedUpholstererUserId: ricardo, plannedLaborUnitCents: 30000 },
      {},
    );
    expect(b.status).toBe(403);
    expect(await counts()).toEqual(before);
    // O planejador define só o titular; a tela recebe a lista de titulares e as permissões.
    const c = await closeService(planner, { plannedUpholstererUserId: ricardo }, {});
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const defaults = (await planner.get('/api/v1/services/new-defaults')).body;
    expect(defaults).toMatchObject({ canPlanUpholsterer: true, canPlanLabor: false });
    expect(defaults.upholsterers.map((u: { displayName: string }) => u.displayName)).toEqual(
      expect.arrayContaining(['Ricardo', 'Márcio']),
    );
    expect(defaults.upholsterers.map((u: { displayName: string }) => u.displayName)).not.toContain(
      'Thiago',
    );
    const sellerDefaults = (await seller.get('/api/v1/services/new-defaults')).body;
    expect(sellerDefaults).toMatchObject({
      upholsterers: [],
      canPlanUpholsterer: false,
      canPlanLabor: false,
    });
  });
});

describe('B. A OS gerada no pedido vem com o titular e a mão de obra prevista', () => {
  it('OS com todas as peças; previsto = unidade × quantidade; repetição do fechamento não duplica', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await userIdOf('Ricardo');
    const marcio = await userIdOf('Márcio');
    const key = idemKey();
    const intent = [
      { plannedUpholstererUserId: ricardo, plannedLaborUnitCents: 30000 },
      { plannedUpholstererUserId: marcio, plannedLaborUnitCents: 15000 },
    ] as const;
    const r = await closeService(admin, intent[0], intent[1], key);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).not.toHaveProperty('serviceOrder');
    // Mesma chave: mesmo resultado, nada em dobro.
    expect((await closeService(admin, intent[0], intent[1], key)).body).toEqual(r.body);
    const orderId = r.body.order.id as string;
    expect(await db().serviceOrder.count({ where: { orderId } })).toBe(0);
    await generateOsFromOrder(admin, orderId);
    expect(await db().serviceOrder.count({ where: { orderId } })).toBe(1);
    const items = await osItems(orderId);
    expect(items.map((i) => [i.description, i.quantity, i.upholstererUserId])).toEqual([
      ['Sofá 3 lugares', 1, ricardo],
      ['Poltronas', 2, marcio],
    ]);
    const rows = await payables(orderId);
    expect(rows.map((p) => [p.serviceOrderItemId, p.professionalUserId, p.agreedCents])).toEqual([
      [items[0]!.id, ricardo, 30000],
      [items[1]!.id, marcio, 30000],
    ]);
    // Previsto, não pago.
    expect(rows.every((p) => p.status === 'PREVISTO' && p.paidCents === 0)).toBe(true);
    // O planejamento vê a peça com o titular (nenhuma escolha manual necessária).
    const owners = await db().serviceOrderItemOwnerChange.count({
      where: { serviceOrderItemId: { in: items.map((i) => i.id) } },
    });
    expect(owners).toBe(2);
  });

  it('legado / sem intenção: OS sem titular e sem mão de obra, como antes', async () => {
    const admin = await loginAdmin(app);
    const r = await closeService(admin, {}, {});
    const orderId = r.body.order.id as string;
    await generateOsFromOrder(admin, orderId);
    const order = await orderOf(admin, orderId);
    expect(
      order.items.every((i) => !i.plannedUpholsterer && i.plannedLaborUnitCents === null),
    ).toBe(true);
    expect((await osItems(orderId)).map((i) => i.upholstererUserId)).toEqual([null, null]);
    expect(await payables(orderId)).toEqual([]);
    // Pedido antigo (cadastro manual, sem OS automática): DTO compatível, sem intenção.
    const customer = await createCustomer(admin, { name: 'Cliente Antigo', allowSimilar: true });
    const legacy = await createOrder(admin, customer, [
      { pieceType: 'SOFA', description: 'Sofá', quantity: 1 },
    ]);
    const dto = await orderOf(admin, legacy.id);
    expect(dto.items[0]).toMatchObject({ plannedUpholsterer: null, plannedLaborUnitCents: null });
  });
});

describe('C. Alteração posterior ao fechamento — vale só para as OS futuras', () => {
  it('troca titular e valor com versão; OS e obrigação já geradas não mudam', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await userIdOf('Ricardo');
    const marcio = await userIdOf('Márcio');
    const r = await closeService(
      admin,
      {},
      { plannedUpholstererUserId: ricardo, plannedLaborUnitCents: 15000 },
    );
    const orderId = r.body.order.id as string;
    await generateOsFromOrder(admin, orderId);
    const order = await orderOf(admin, orderId);
    const poltronas = order.items[1]!;
    const path = `/api/v1/orders/${orderId}/planned-intent`;
    const change = {
      version: order.version,
      items: [
        {
          orderItemId: poltronas.id,
          plannedUpholstererUserId: marcio,
          plannedLaborUnitCents: 17000,
        },
      ],
    };
    const ok = await put(admin, path, change);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.items[1]).toMatchObject({
      plannedUpholsterer: { userId: marcio },
      plannedLaborUnitCents: 17000,
    });
    // Versão antiga: recusada.
    const stale = await put(admin, path, change);
    expect(stale.status).toBe(409);
    // A OS (já gerada) e a obrigação continuam com Ricardo/15000 por unidade.
    const rows = await payables(orderId);
    expect(rows.map((p) => [p.professionalUserId, p.agreedCents])).toEqual([[ricardo, 30000]]);
    expect((await osItems(orderId)).map((i) => i.upholstererUserId)).toEqual([null, ricardo]);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'order.planned_intent_updated', entityId: orderId },
    });
    expect(log.summary).toMatch(/valem para as OS geradas a partir de agora/);
  });

  it('validação e permissões na alteração; sem financeiro.ver o valor é preservado', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await userIdOf('Ricardo');
    const marcio = await userIdOf('Márcio');
    const r = await closeService(
      admin,
      { plannedUpholstererUserId: ricardo, plannedLaborUnitCents: 30000 },
      {},
    );
    const orderId = r.body.order.id as string;
    const path = `/api/v1/orders/${orderId}/planned-intent`;
    const order = await orderOf(admin, orderId);
    const [sofa, poltronas] = order.items;
    const planner = await panelUserWith(app, admin, 'planejador2', [
      'pedidos.ver',
      'pedidos.gerenciar',
      'producao.planejar',
    ]);
    // Sem financeiro.ver: mão de obra enviada como null é ignorada (preservada) — nada muda.
    const same = await put(planner, path, {
      version: order.version,
      items: [
        { orderItemId: sofa!.id, plannedUpholstererUserId: ricardo, plannedLaborUnitCents: null },
      ],
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(
      (await db().commercialOrderItem.findUniqueOrThrow({ where: { id: sofa!.id } }))
        .plannedLaborUnitCents,
    ).toBe(30000);
    // Trocar o titular de quem tem mão de obra prevista é decisão financeira.
    const v = (await orderOf(admin, orderId)).version;
    const swap = await put(planner, path, {
      version: v,
      items: [
        { orderItemId: sofa!.id, plannedUpholstererUserId: marcio, plannedLaborUnitCents: null },
      ],
    });
    expect(swap.status).toBe(403);
    // Peça sem mão de obra: o planejador define o titular.
    const set = await put(planner, path, {
      version: v,
      items: [
        {
          orderItemId: poltronas!.id,
          plannedUpholstererUserId: marcio,
          plannedLaborUnitCents: null,
        },
      ],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // Tirar o titular mantendo o valor: recusado (o valor é do titular).
    const v2 = (await orderOf(admin, orderId)).version;
    const orphan = await put(admin, path, {
      version: v2,
      items: [
        { orderItemId: sofa!.id, plannedUpholstererUserId: null, plannedLaborUnitCents: 30000 },
      ],
    });
    expect(orphan.status).toBe(400);
    const thiago = await put(admin, path, {
      version: v2,
      items: [
        {
          orderItemId: sofa!.id,
          plannedUpholstererUserId: await userIdOf('Thiago'),
          plannedLaborUnitCents: null,
        },
      ],
    });
    expect(thiago.status).toBe(422);
    // Remover tudo (com permissão financeira): aceito.
    const clear = await put(admin, path, {
      version: v2,
      items: [
        { orderItemId: sofa!.id, plannedUpholstererUserId: null, plannedLaborUnitCents: null },
      ],
    });
    expect(clear.status, JSON.stringify(clear.body)).toBe(200);
    expect(clear.body.items[0]).toMatchObject({
      plannedUpholsterer: null,
      plannedLaborUnitCents: null,
    });
    // Pedido antigo (sem OS automática) e pedido cancelado: recusados.
    const customer = await createCustomer(admin, { name: 'Cliente Manual', allowSimilar: true });
    const manual = await createOrder(admin, customer, [
      { pieceType: 'SOFA', description: 'Sofá', quantity: 1 },
    ]);
    const m = await put(admin, `/api/v1/orders/${manual.id}/planned-intent`, {
      version: manual.version,
      items: [
        {
          orderItemId: manual.items[0].id,
          plannedUpholstererUserId: ricardo,
          plannedLaborUnitCents: null,
        },
      ],
    });
    expect(m.status).toBe(422);
    const other = await put(admin, path, {
      version: clear.body.version,
      items: [
        {
          orderItemId: manual.items[0].id,
          plannedUpholstererUserId: ricardo,
          plannedLaborUnitCents: null,
        },
      ],
    });
    expect(other.status).toBe(400);
  });
});
