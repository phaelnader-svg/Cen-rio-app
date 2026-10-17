import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { linkForecastsOnArrival } from '../src/modules/purchasing/forecasts';
import {
  createCustomer,
  createOrder,
  createPickup,
  panelUserWith,
  receiptBody,
} from './commercial-helpers';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createMeasurement, fillAndSubmit, gestorUserId, nextFriday } from './measurement-helpers';
import { confirmPurchase, createPurchase, createSupplier, ok, receive } from './purchasing-helpers';

/**
 * Compras e materiais sem duplicidade — Etapa 3: compra ANTES da chegada da peça.
 * PREVISAO_COMPRA presa à peça do pedido, comprável sem OS; na chegada a MESMA linha é vinculada à
 * OS real (sem copiar compra, recebimento, custo nem reserva); a medição real a substitui (cadeia
 * da Etapa 2). Custo do recebimento pré-OS aparece na OS exatamente uma vez, com a data original.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
/** A edição da previsão é idempotente (rota com chave), como as demais ações de compra. */
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.put(url, body, { 'idempotency-key': key });

const linen = (quantity: number, color = 'Cru') => ({
  kind: 'TECIDO',
  sourcing: 'EXCLUSIVO_OS',
  description: 'Linho',
  color,
  quantity,
  unit: 'METRO',
});
const staples = (quantity: number) => ({
  kind: 'OUTRO',
  sourcing: 'ESTOQUE',
  description: 'Grampos 80/10',
  quantity,
  unit: 'EMBALAGEM',
});

type OrderBody = { id: string; version: number; items: { id: string; quantity: number }[] };
/** Pedido com Sofá A (1) e Poltronas (2), ainda sem chegada. */
async function newOrder(admin: Client, name = 'Cliente Pré-chegada'): Promise<OrderBody> {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  return createOrder(admin, customer, [
    { pieceType: 'SOFA', description: 'Sofá A', quantity: 1 },
    { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
  ]);
}
async function forecast(admin: Client, orderId: string, itemId: string, body: unknown) {
  const r = await post(admin, `/api/v1/orders/${orderId}/items/${itemId}/material-forecasts`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Forecasts;
}
type Line = {
  requirementId: string;
  need: number;
  covered: number;
  awaiting: number;
  inDraft: number;
  shortfall: number;
  forecast: boolean;
  orderItemId: string;
  serviceOrder: { id: string } | null;
  pendingLink: boolean;
  virgin: boolean;
  excess: { available: number; draft: number; awaiting: number };
};
type Forecasts = {
  forecasts: Line[];
  orphans: { requirementId: string; receivedExclusive: number; status: string }[];
  pieces: { orderItemId: string; serviceOrderItems: { id: string }[] }[];
};
const forecastsOf = async (admin: Client, orderId: string) =>
  (await admin.get(`/api/v1/orders/${orderId}/material-forecasts`)).body as Forecasts;
const reqOf = (id: string) => db().materialRequirement.findUniqueOrThrow({ where: { id } });

/** Chegada física das peças (recebimento do pedido). */
async function arrive(
  admin: Client,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
) {
  const r = await post(admin, '/api/v1/receipts', receiptBody(orderId, lines));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
/** OS real criada para as peças que chegaram (mesmo serviço da criação automática). */
async function openOs(
  admin: Client,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
) {
  const r = await post(admin, '/api/v1/service-orders', {
    orderId,
    items: lines.map((l) => ({
      orderItemId: l.orderItemId,
      quantity: l.quantity,
      description: 'Peça',
      serviceType: 'REFORMA_COMPLETA',
    })),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; version: number; items: { id: string; orderItemId: string }[] };
}
async function exclusivePurchase(admin: Client, reqId: string, quantity: number, confirm = true) {
  const supplier = await createSupplier(admin, `Fornecedor ${idemKey().slice(0, 6)}`);
  const po = await createPurchase(admin, {
    supplierId: supplier.id,
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: reqId, quantity }],
        quantity,
        unitPriceCents: 4500,
      },
    ],
  });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  if (!confirm) return po.body;
  const c = await confirmPurchase(admin, po.body);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body;
}
const needs = async (admin: Client) =>
  (await admin.get('/api/v1/purchasing/needs?pendingOnly=false')).body as {
    requirementId: string;
    pendingToBuy: number;
    serviceOrder: unknown;
    preArrival: { order: { code: string }; piece: string; pendingLink: boolean } | null;
    forecast: boolean;
  }[];
const readiness = async (admin: Client, soId: string) =>
  (await admin.get(`/api/v1/service-orders/${soId}/material-readiness`)).body as {
    state: string;
    pending: { forecasts: number };
    lines: Line[];
  };
const costsOf = (soId: string) =>
  db().serviceOrderCost.findMany({
    where: { serviceOrderId: soId },
    orderBy: { sourceKey: 'asc' },
  });
const syncCosts = async (admin: Client, soId: string) =>
  (await admin.get(`/api/v1/finance/service-orders/${soId}`)).status;

/** Medição real da OS (enviada), aprovada com a decisão indicada (substitui a previsão). */
async function measure(
  admin: Client,
  soId: string,
  items: unknown[],
  decide: (d: {
    items: { id: string }[];
    substitution: { suggested: Record<string, string | null> };
  }) => unknown = (d) => ({
    substitutions: Object.entries(d.substitution.suggested)
      .filter((e): e is [string, string] => Boolean(e[1]))
      .map(([requestItemId, replacesRequirementId]) => ({ requestItemId, replacesRequirementId })),
  }),
) {
  const m = await createMeasurement(admin, {
    serviceOrderId: soId,
    kind: 'EXTRAORDINARIA',
    reason: 'Medição real',
    assigneeUserId: await gestorUserId(),
    dueDate: nextFriday(),
  });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  const sub = await fillAndSubmit(admin, m.body, { items });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const d = (await admin.get(`/api/v1/measurements/${m.body.id}`)).body;
  const r = await post(admin, `/api/v1/measurements/${m.body.id}/request/approve`, {
    version: d.request.version,
    ...(decide(d) as object),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return d;
}

// ─────────────────────────── AB-1 / AB-2 / modelo ───────────────────────────

describe('AB-1/AB-2 — PREVISAO_COMPRA na peça do pedido, com materiais.aprovar', () => {
  it('cria previsão sem OS (previsão, não medição); constraints do banco protegem o modelo', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const f = await forecast(admin, o.id, o.items[0]!.id, linen(12));
    expect(f.forecasts).toHaveLength(1);
    const line = f.forecasts[0]!;
    expect(line).toMatchObject({
      forecast: true,
      serviceOrder: null,
      need: 12,
      shortfall: 12,
      virgin: true,
    });
    const row = await reqOf(line.requirementId);
    expect(row).toMatchObject({
      origin: 'PREVISAO_COMPRA',
      status: 'ATIVA',
      serviceOrderId: null,
      orderItemId: o.items[0]!.id,
      materialRequestItemId: null,
      unitCode: 'METRO',
    });
    // Peça de OS sem OS e necessidade sem destino são recusadas pelo banco.
    await expect(
      db().$executeRawUnsafe(
        `UPDATE material_requirements SET order_item_id = NULL WHERE id = '${row.id}'::uuid`,
      ),
    ).rejects.toThrow(/destination_chk|forecast_fields_chk/);
    await expect(
      db().$executeRawUnsafe(
        `UPDATE material_requirements SET origin = 'PREVISAO_MANUAL' WHERE id = '${row.id}'::uuid`,
      ),
    ).rejects.toThrow(/preos_forecast_chk/);
  });

  it('só materiais.aprovar prevê (compras.gerenciar não); PREVISAO_MANUAL continua fora das compras', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const buyer = await panelUserWith(app, admin, 'comprador', [
      'compras.ver',
      'compras.gerenciar',
      'pedidos.ver',
    ]);
    const denied = await post(
      buyer,
      `/api/v1/orders/${o.id}/items/${o.items[0]!.id}/material-forecasts`,
      linen(5),
    );
    expect(denied.status).toBe(403);
    const approver = await panelUserWith(app, admin, 'aprovador', ['materiais.aprovar']);
    const allowed = await post(
      approver,
      `/api/v1/orders/${o.id}/items/${o.items[0]!.id}/material-forecasts`,
      linen(5),
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });
});

// ─────────────────────────── A comprar e compra pré-OS ───────────────────────────

describe('A comprar / compra pré-OS (cenários 1–3)', () => {
  it('previsão aparece como Pré-chegada, sem prazo/bloqueio; compra pela falta líquida, sem overbuy', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const f = await forecast(admin, o.id, o.items[0]!.id, linen(12));
    const id = f.forecasts[0]!.requirementId;
    const n = (await needs(admin)).find((x) => x.requirementId === id)!;
    expect(n).toMatchObject({ serviceOrder: null, forecast: true, pendingToBuy: 12 });
    expect(n.preArrival).toMatchObject({ piece: 'Sofá A', pendingLink: false });
    const groups = (await admin.get('/api/v1/purchasing/shortages')).body as {
      description: string;
      rows: { requirementId: string; deadlineState: string; blocksProduction: boolean }[];
    }[];
    const row = groups.flatMap((g) => g.rows).find((r) => r.requirementId === id)!;
    expect(row).toMatchObject({ deadlineState: 'SEM_PRAZO', blocksProduction: false });
    // Rascunho 12 → falta 0; comprar mais é recusado (mesma regra da falta).
    await exclusivePurchase(admin, id, 12, false);
    expect((await needs(admin)).find((x) => x.requirementId === id)!.pendingToBuy).toBe(0);
    const supplier = await createSupplier(admin, 'Fornecedor Overbuy');
    const over = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: id, quantity: 1 }],
          quantity: 1,
          unitPriceCents: 4500,
        },
      ],
    });
    expect(over.status).toBe(409);
    // Item exclusivo pré-OS: sem OS no item nem na alocação.
    const alloc = await db().purchaseAllocation.findFirstOrThrow({
      where: { materialRequirementId: id },
    });
    expect(alloc.serviceOrderId).toBeNull();
  });
});

// ─────────────────────────── Custo — contraprova obrigatória ───────────────────────────

describe('Custo exatamente uma vez, com a data ORIGINAL do recebimento (critério de GO)', () => {
  it('pré-OS: zero custo; chegada vincula as mesmas linhas; sync cria 1 linha por receipt_line com a data original', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const f = await forecast(admin, o.id, o.items[0]!.id, linen(12));
    const id = f.forecasts[0]!.requirementId;
    const po = await exclusivePurchase(admin, id, 12);
    // Duas entregas legítimas do fornecedor antes da chegada do sofá.
    expect((await receive(admin, po.id, [ok(po.items[0].id, 8)])).status).toBe(201);
    expect((await receive(admin, po.id, [ok(po.items[0].id, 4)])).status).toBe(201);
    // Recebimentos são só-inserção (gatilho do banco): a data é a real do recebimento.
    const receipts = await db().materialReceipt.findMany({ where: { purchaseOrderId: po.id } });
    const receivedAt = new Set(receipts.map((x) => x.receivedAt.toISOString()));
    await new Promise((res) => setTimeout(res, 20));
    // 1) Antes da OS: nenhum custo de OS; valor só no pedido/recebimento; não virou estoque livre.
    expect(await db().serviceOrderCost.count()).toBe(0);
    expect(await db().stockMovement.count()).toBe(0);
    expect(await db().stockReservation.count()).toBe(0);
    // 2) A peça chega: a mesma necessidade/alocação/item exclusivo recebem a OS.
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const linked = await reqOf(id);
    expect(linked).toMatchObject({
      serviceOrderId: so.id,
      serviceOrderItemId: so.items[0]!.id,
      status: 'ATIVA',
    });
    expect(await db().materialRequirement.count({ where: { origin: 'PREVISAO_COMPRA' } })).toBe(1);
    expect(
      (await db().purchaseAllocation.findFirstOrThrow({ where: { materialRequirementId: id } }))
        .serviceOrderId,
    ).toBe(so.id);
    expect(
      (await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: po.items[0].id } }))
        .serviceOrderId,
    ).toBe(so.id);
    // 3–5) Sync cria o custo na OS: 2 linhas (2 receipt_lines), data original, repetição não duplica.
    expect(await syncCosts(admin, so.id)).toBe(200);
    expect(await syncCosts(admin, so.id)).toBe(200);
    const costs = await costsOf(so.id);
    expect(
      costs
        .map((c) => [c.source, Number(c.quantity), c.amountCents])
        .sort((a, b) => Number(b[1]) - Number(a[1])),
    ).toEqual([
      ['COMPRA_EXCLUSIVA', 8, 8 * 4500],
      ['COMPRA_EXCLUSIVA', 4, 4 * 4500],
    ]);
    expect(new Set(costs.map((c) => c.sourceKey)).size).toBe(2);
    // Data econômica = data ORIGINAL do recebimento, anterior à criação da OS (nunca a da vinculação).
    const osRow = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    for (const c of costs) {
      expect(receivedAt.has(c.occurredAt.toISOString())).toBe(true);
      expect(c.occurredAt.getTime()).toBeLessThan(osRow.createdAt.getTime());
    }
    // 6) Retry da vinculação não duplica nada.
    await db().$transaction((tx) =>
      linkForecastsOnArrival(tx, { userId: null, permissions: new Set() } as never, so.id),
    );
    expect(await syncCosts(admin, so.id)).toBe(200);
    expect(await costsOf(so.id)).toHaveLength(2);
    expect(await db().purchaseAllocation.count()).toBe(1);
    // Relatório por período: o custo entra no mês original (janeiro), uma única vez.
    const day = costs[0]!.occurredAt.toISOString().slice(0, 10);
    const report = await admin.get(`/api/v1/finance/reports/custos?from=${day}&to=${day}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const exclusive = (report.body.rows as unknown[][]).filter(
      (row) => row[1] === 'COMPRA_EXCLUSIVA',
    );
    // Uma linha de categoria, 2 lançamentos (as 2 receipt_lines), somadas uma única vez.
    expect(exclusive).toHaveLength(1);
    expect(exclusive[0]![2]).toBe(2);
    expect(String(exclusive[0]![3]).replace(/\D/g, '')).toBe(String(12 * 4500));
  });

  it('chegada × recebimento do fornecedor concorrentes: custo e recebido contam uma vez', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(10))).forecasts[0]!.requirementId;
    const po = await exclusivePurchase(admin, id, 10);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const [so, rc] = await Promise.all([
      post(admin, '/api/v1/service-orders', {
        orderId: o.id,
        items: [
          {
            orderItemId: o.items[0]!.id,
            quantity: 1,
            description: 'Sofá',
            serviceType: 'REFORMA_COMPLETA',
          },
        ],
      }),
      receive(admin, po.id, [ok(po.items[0].id, 10)]),
    ]);
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    expect(await syncCosts(admin, so.body.id)).toBe(200);
    const costs = await costsOf(so.body.id);
    expect(costs).toHaveLength(1);
    expect(Number(costs[0]!.quantity)).toBe(10);
    const r = await readiness(admin, so.body.id);
    expect(r.lines[0]).toMatchObject({ need: 10, covered: 10 });
  });
});

// ─────────────────────────── AB-4 — medição obrigatória ───────────────────────────

describe('AB-4 — previsão 100% coberta não libera produção', () => {
  it('OS com previsão coberta fica pendente; só a medição real (substituindo) torna COMPLETO', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(12))).forecasts[0]!.requirementId;
    const po = await exclusivePurchase(admin, id, 12);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    let r = await readiness(admin, so.id);
    expect(r.lines[0]).toMatchObject({ need: 12, covered: 12, forecast: true });
    expect(r.pending.forecasts).toBe(1);
    expect(r.state).not.toBe('COMPLETO');
    expect(
      (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).materialsReadiness,
    ).not.toBe('COMPLETO');
    // Medição real 10 m substitui a previsão (pré-seleção segura: mesma peça e tipo).
    await measure(admin, so.id, [{ ...linen(10), serviceOrderItemId: so.items[0]!.id }]);
    expect((await reqOf(id)).status).toBe('SUBSTITUIDA');
    r = await readiness(admin, so.id);
    expect(r.pending.forecasts).toBe(0);
    expect(r.lines[0]).toMatchObject({
      need: 10,
      covered: 10,
      forecast: false,
      excess: { available: 2 },
    });
    expect(r.state).toBe('COMPLETO');
  });
});

// ─────────────────────────── Reconciliação (12→10, 10→13, X→Y) ───────────────────────────

describe('Reconciliação previsão × medição (cadeia da Etapa 2)', () => {
  it('10 → 13 herda os 10 compatíveis: falta 3 (nunca recompra 13)', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(10))).forecasts[0]!.requirementId;
    await exclusivePurchase(admin, id, 10);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    await measure(admin, so.id, [{ ...linen(13), serviceOrderItemId: so.items[0]!.id }]);
    const head = (await needs(admin)).find((n) => n.serviceOrder && n.forecast === false)!;
    expect(head.pendingToBuy).toBe(3);
  });

  it('X previsto → Y medido: Y começa com falta real; X fica sem necessidade ativa', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(12, 'Cru'))).forecasts[0]!
      .requirementId;
    const po = await exclusivePurchase(admin, id, 12);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    await measure(admin, so.id, [{ ...linen(12, 'Cinza'), serviceOrderItemId: so.items[0]!.id }]);
    const r = (await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`)).body;
    expect(r.lines[0]).toMatchObject({ need: 12, covered: 0, shortfall: 12 });
    expect(r.orphans).toEqual([
      expect.objectContaining({ requirementId: id, receivedExclusive: 12 }),
    ]);
  });
});

// ─────────────────────────── AB-3 — quantidade > 1 ───────────────────────────

describe('AB-3 — Poltronas ×2, previsão 10, chegadas parciais', () => {
  it('chegada parcial não vincula; nada da segunda vai silenciosamente para a primeira; gestor vincula', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const pol = o.items[1]!.id;
    const id = (await forecast(admin, o.id, pol, linen(10))).forecasts[0]!.requirementId;
    await exclusivePurchase(admin, id, 10);
    await arrive(admin, o.id, [{ orderItemId: pol, quantity: 1 }]);
    const os1 = await openOs(admin, o.id, [{ orderItemId: pol, quantity: 1 }]);
    expect((await reqOf(id)).serviceOrderId).toBeNull();
    expect(await db().purchaseAllocation.count({ where: { serviceOrderId: os1.id } })).toBe(0);
    expect((await readiness(admin, os1.id)).lines).toEqual([]);
    let f = await forecastsOf(admin, o.id);
    expect(f.forecasts[0]).toMatchObject({ pendingLink: true, serviceOrder: null });
    expect((await needs(admin)).find((n) => n.requirementId === id)!.preArrival!.pendingLink).toBe(
      true,
    );
    await arrive(admin, o.id, [{ orderItemId: pol, quantity: 1 }]);
    const os2 = await openOs(admin, o.id, [{ orderItemId: pol, quantity: 1 }]);
    expect((await reqOf(id)).serviceOrderId).toBeNull();
    // Decisão explícita do gestor: a previsão inteira vai para a peça da OS escolhida.
    const link = await post(admin, `/api/v1/material-forecasts/${id}/link`, {
      serviceOrderItemId: os2.items[0]!.id,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect((await reqOf(id)).serviceOrderId).toBe(os2.id);
    expect((await readiness(admin, os1.id)).lines).toEqual([]);
    expect((await readiness(admin, os2.id)).lines).toHaveLength(1);
    // Vinculação a peça de outra linha do pedido é recusada; repetir não muda nada.
    const again = await post(admin, `/api/v1/material-forecasts/${id}/link`, {
      serviceOrderItemId: os1.items[0]!.id,
    });
    expect(again.status).toBe(200);
    expect((await reqOf(id)).serviceOrderId).toBe(os2.id);
    f = await forecastsOf(admin, o.id);
    expect(f.forecasts[0]!.pendingLink).toBe(false);
  });

  it('as duas poltronas chegando juntas (linha inteira numa OS) vinculam automaticamente', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const pol = o.items[1]!.id;
    const id = (await forecast(admin, o.id, pol, linen(10))).forecasts[0]!.requirementId;
    await arrive(admin, o.id, [{ orderItemId: pol, quantity: 2 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: pol, quantity: 2 }]);
    expect((await reqOf(id)).serviceOrderId).toBe(so.id);
  });
});

// ─────────────────────────── AB-5 — reserva na chegada ───────────────────────────

describe('AB-5 — estoque recebido antes da peça: reserva só na chegada e só se inequívoca', () => {
  async function stockForecast(admin: Client, qty = 5) {
    const o = await newOrder(admin, `Cliente Estoque ${idemKey().slice(0, 4)}`);
    const id = (await forecast(admin, o.id, o.items[0]!.id, staples(qty))).forecasts[0]!
      .requirementId;
    const supplier = await createSupplier(admin, `Forn ${idemKey().slice(0, 4)}`);
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'ESTOQUE',
          allocations: [{ materialRequirementId: id, quantity: qty }],
          quantity: qty,
          unitPriceCents: 500,
        },
      ],
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const c = await confirmPurchase(admin, po.body);
    await receive(admin, c.body.id, [ok(c.body.items[0].id, qty)]);
    return { o, id, stockItemId: c.body.items[0].stockItem.id as string };
  }

  it('antes da OS: entrada no estoque sem reserva; na chegada: reserva exatamente o destinado', async () => {
    const admin = await loginAdmin(app);
    const { o, id, stockItemId } = await stockForecast(admin, 5);
    expect(await db().stockReservation.count()).toBe(0);
    expect(
      Number((await db().stockItem.findUniqueOrThrow({ where: { id: stockItemId } })).onHand),
    ).toBe(5);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const res = await db().stockReservation.findMany();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      serviceOrderId: so.id,
      materialRequirementId: id,
      status: 'ATIVA',
    });
    expect(Number(res[0]!.quantity)).toBe(5);
  });

  it('saldo tomado por reserva de outra OS: não inventa cobertura (fica "Reservar" manual)', async () => {
    const admin = await loginAdmin(app);
    const { o, stockItemId } = await stockForecast(admin, 5);
    // Outra OS reserva o saldo livre antes da chegada.
    const other = await newOrder(admin, 'Cliente Outra OS');
    await arrive(admin, other.id, [{ orderItemId: other.items[0]!.id, quantity: 1 }]);
    const otherOs = await openOs(admin, other.id, [
      { orderItemId: other.items[0]!.id, quantity: 1 },
    ]);
    const taken = await post(admin, '/api/v1/stock-reservations', {
      stockItemId,
      serviceOrderId: otherOs.id,
      quantity: 5,
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    expect(await db().stockReservation.count({ where: { serviceOrderId: so.id } })).toBe(0);
  });
});

// ─────────────────────────── AB-7 / AB-9 / cancelamento / AB-8 ───────────────────────────

describe('AB-9 edição, AB-7 remoção, cancelamento e AB-8 sobra pré-OS', () => {
  it('previsão virgem edita no lugar; com rascunho, substitui (rascunho antigo → 409 ao confirmar)', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(12))).forecasts[0]!.requirementId;
    let r = await put(admin, `/api/v1/material-forecasts/${id}`, linen(10));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Number((await reqOf(id)).quantity)).toBe(10);
    expect(await db().materialRequirement.count()).toBe(1);
    const draft = await exclusivePurchase(admin, id, 10, false);
    r = await put(admin, `/api/v1/material-forecasts/${id}`, linen(8));
    expect(r.status).toBe(200);
    expect((await reqOf(id)).status).toBe('SUBSTITUIDA');
    const head = await db().materialRequirement.findFirstOrThrow({
      where: { replacesRequirementId: id },
    });
    expect(head).toMatchObject({
      status: 'ATIVA',
      origin: 'PREVISAO_COMPRA',
      serviceOrderId: null,
    });
    const f = await forecastsOf(admin, o.id);
    expect(f.forecasts[0]).toMatchObject({
      requirementId: head.id,
      need: 8,
      inDraft: 10,
      excess: { draft: 2 },
    });
    expect((await confirmPurchase(admin, draft)).status).toBe(409);
  });

  it('remoção da peça: virgem sai junto; com rascunho é recusada com mensagem clara', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const sofa = o.items[0]!;
    await forecast(admin, o.id, sofa.id, linen(5));
    const order = (await admin.get(`/api/v1/orders/${o.id}`)).body;
    const keep = order.items
      .filter((i: { id: string }) => i.id !== sofa.id)
      .map((i: { id: string; pieceType: string; description: string; quantity: number }) => ({
        id: i.id,
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
      }));
    const base = {
      contractedService: order.contractedService,
      pickupAddressId: order.pickupAddress?.id ?? null,
      version: order.version,
    };
    // Com rascunho: recusa.
    const o2 = await newOrder(admin, 'Cliente Remoção 2');
    const id2 = (await forecast(admin, o2.id, o2.items[0]!.id, linen(5))).forecasts[0]!
      .requirementId;
    await exclusivePurchase(admin, id2, 5, false);
    const order2 = (await admin.get(`/api/v1/orders/${o2.id}`)).body;
    const refused = await admin.put(`/api/v1/orders/${o2.id}`, {
      contractedService: order2.contractedService,
      pickupAddressId: order2.pickupAddress?.id ?? null,
      version: order2.version,
      items: order2.items
        .filter((i: { id: string }) => i.id !== o2.items[0]!.id)
        .map((i: { id: string; pieceType: string; description: string; quantity: number }) => ({
          id: i.id,
          pieceType: i.pieceType,
          description: i.description,
          quantity: i.quantity,
        })),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/previsão de material/);
    // Virgem: sai junto com a peça.
    const okRemove = await admin.put(`/api/v1/orders/${o.id}`, { ...base, items: keep });
    expect(okRemove.status, JSON.stringify(okRemove.body)).toBe(200);
    expect(await db().materialRequirement.count({ where: { orderItemId: sofa.id } })).toBe(0);
  });

  it('pedido cancelado: previsões CANCELADA, compra sem destino, exclusivo recebido vira sobra pré-OS rastreável', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(12))).forecasts[0]!.requirementId;
    const po = await exclusivePurchase(admin, id, 12);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    const order = (await admin.get(`/api/v1/orders/${o.id}`)).body;
    const cancel = await admin.post(`/api/v1/orders/${o.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: order.version,
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(await reqOf(id)).toMatchObject({ status: 'CANCELADA', serviceOrderId: null });
    expect((await reqOf(id)).closeReason).toMatch(/Pedido cancelado/);
    // Compra e recebimento permanecem; pedido de compra mostra "sem destino".
    expect((await db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).not.toBe(
      'CANCELADO',
    );
    const list = (await admin.get('/api/v1/purchase-orders')).body;
    const row = (list.items ?? list).find((p: { id: string }) => p.id === po.id);
    expect(row.withoutDestination.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect((await needs(admin)).find((n) => n.requirementId === id)).toBeUndefined();
    const f = await forecastsOf(admin, o.id);
    expect(f.orphans).toEqual([
      expect.objectContaining({ requirementId: id, receivedExclusive: 12 }),
    ]);
    // AB-8: sobra sem OS, presa à previsão de origem; não passa do recebido.
    const leftover = (q: number) =>
      post(admin, '/api/v1/material-leftovers', {
        serviceOrderId: null,
        sourceRequirementId: id,
        kind: 'TECIDO',
        description: 'Linho',
        color: 'Cru',
        quantity: q,
        unit: 'METRO',
        location: 'Prateleira A',
        condition: 'BOA',
        reusable: true,
      });
    expect((await leftover(13)).status).toBe(422);
    const l = await leftover(12);
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect(l.body).toMatchObject({
      serviceOrder: null,
      preArrival: { requirementId: id, piece: 'Sofá A' },
    });
    expect((await leftover(1)).status).toBe(422);
    expect((await forecastsOf(admin, o.id)).orphans).toEqual([]);
    // Transferência humana para outra OS: custo com o preço original.
    const other = await newOrder(admin, 'Cliente Destino Sobra');
    await arrive(admin, other.id, [{ orderItemId: other.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, other.id, [{ orderItemId: other.items[0]!.id, quantity: 1 }]);
    const t = await post(admin, `/api/v1/material-leftovers/${l.body.id}/transfer`, {
      targetServiceOrderId: so.id,
      quantity: 5,
      reason: 'Reaproveitar no outro sofá',
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(await syncCosts(admin, so.id)).toBe(200);
    const costs = await costsOf(so.id);
    expect(costs.map((c) => [c.source, c.amountCents])).toEqual([['SOBRA_ENTRADA', 5 * 4500]]);
  });

  it('cancelamento manual (endpoint da Etapa 2) vale para a previsão pré-OS; retirada cancelada não cancela previsão', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(5))).forecasts[0]!.requirementId;
    const c = await post(admin, `/api/v1/material-requirements/${id}/cancel`, {
      reason: 'Cliente trouxe o tecido',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await reqOf(id)).status).toBe('CANCELADA');
    const again = await post(admin, `/api/v1/material-requirements/${id}/cancel`, {
      reason: 'De novo',
    });
    expect(again.status).toBe(200);
    expect((await reqOf(id)).closeReason).toBe('Cliente trouxe o tecido');
  });
});

// ─────────────────────────── Depois da chegada (Etapa 2 reaproveitada) ───────────────────────────

describe('Depois da chegada: devolução e OS cancelada encerram a previsão vinculada', () => {
  it('OS cancelada → previsão CANCELADA; compra permanece', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(5))).forecasts[0]!.requirementId;
    await exclusivePurchase(admin, id, 5);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    const c = await admin.post(`/api/v1/service-orders/${so.id}/cancel`, {
      reason: 'Desistiu',
      version: os.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await reqOf(id)).status).toBe('CANCELADA');
    expect(await db().purchaseAllocation.count()).toBe(1);
  });
});

// ─────────────────────────── Concorrência ───────────────────────────

describe('Concorrência real e idempotência', () => {
  it('edição da previsão × criação de compra: nunca duas previsões ativas nem compra perdida', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(12))).forecasts[0]!.requirementId;
    const supplier = await createSupplier(admin, 'Fornecedor Corrida');
    const [e, p] = await Promise.all([
      put(admin, `/api/v1/material-forecasts/${id}`, linen(10)),
      createPurchase(admin, {
        supplierId: supplier.id,
        items: [
          {
            sourcing: 'EXCLUSIVO_OS',
            allocations: [{ materialRequirementId: id, quantity: 12 }],
            quantity: 12,
            unitPriceCents: 4500,
          },
        ],
      }),
    ]);
    expect(e.status).toBe(200);
    expect([201, 409]).toContain(p.status);
    const active = await db().materialRequirement.findMany({ where: { status: 'ATIVA' } });
    expect(active).toHaveLength(1);
    if (p.status === 201) expect((await reqOf(id)).status).toBe('SUBSTITUIDA');
    else expect(Number((await reqOf(id)).quantity)).toBe(10);
  });

  it('chegada × confirmação de compra; cancelamento do pedido × compra; sem deadlock', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(6))).forecasts[0]!.requirementId;
    const draft = await exclusivePurchase(admin, id, 6, false);
    await arrive(admin, o.id, [{ orderItemId: o.items[0]!.id, quantity: 1 }]);
    const [so, conf] = await Promise.all([
      post(admin, '/api/v1/service-orders', {
        orderId: o.id,
        items: [
          {
            orderItemId: o.items[0]!.id,
            quantity: 1,
            description: 'Sofá',
            serviceType: 'REFORMA_COMPLETA',
          },
        ],
      }),
      confirmPurchase(admin, draft),
    ]);
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect((await reqOf(id)).serviceOrderId).toBe(so.body.id);
    // Cancelamento do pedido × nova compra da previsão de outra peça (ainda pré-OS).
    const o2 = await newOrder(admin, 'Cliente Corrida 2');
    const id2 = (await forecast(admin, o2.id, o2.items[0]!.id, linen(4))).forecasts[0]!
      .requirementId;
    const order2 = (await admin.get(`/api/v1/orders/${o2.id}`)).body;
    const supplier = await createSupplier(admin, 'Fornecedor Corrida 2');
    const [cancel, buy] = await Promise.all([
      admin.post(`/api/v1/orders/${o2.id}/cancel`, { reason: 'Desistiu', version: order2.version }),
      createPurchase(admin, {
        supplierId: supplier.id,
        items: [
          {
            sourcing: 'EXCLUSIVO_OS',
            allocations: [{ materialRequirementId: id2, quantity: 4 }],
            quantity: 4,
            unitPriceCents: 4500,
          },
        ],
      }),
    ]);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect([201, 409]).toContain(buy.status);
    expect((await reqOf(id2)).status).toBe('CANCELADA');
  });

  it('duas chegadas parciais simultâneas da linha ×2: nenhuma vincula; retry da OS com a mesma chave não duplica', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const pol = o.items[1]!.id;
    const id = (await forecast(admin, o.id, pol, linen(10))).forecasts[0]!.requirementId;
    await arrive(admin, o.id, [{ orderItemId: pol, quantity: 2 }]);
    const body = (q: number) => ({
      orderId: o.id,
      items: [
        { orderItemId: pol, quantity: q, description: 'Poltrona', serviceType: 'REFORMA_COMPLETA' },
      ],
    });
    const [a, b] = await Promise.all([
      post(admin, '/api/v1/service-orders', body(1)),
      post(admin, '/api/v1/service-orders', body(1)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect((await reqOf(id)).serviceOrderId).toBeNull();
    // Retry idempotente de uma criação de OS (mesma chave): mesma OS, nada vinculado em dobro.
    const o2 = await newOrder(admin, 'Cliente Retry');
    const id2 = (await forecast(admin, o2.id, o2.items[0]!.id, linen(3))).forecasts[0]!
      .requirementId;
    await arrive(admin, o2.id, [{ orderItemId: o2.items[0]!.id, quantity: 1 }]);
    const key = idemKey();
    const payload = {
      orderId: o2.id,
      items: [
        {
          orderItemId: o2.items[0]!.id,
          quantity: 1,
          description: 'Sofá',
          serviceType: 'REFORMA_COMPLETA',
        },
      ],
    };
    const r1 = await post(admin, '/api/v1/service-orders', payload, key);
    const r2 = await post(admin, '/api/v1/service-orders', payload, key);
    expect(r1.body.id).toBe(r2.body.id);
    expect((await reqOf(id2)).serviceOrderId).toBe(r1.body.id);
    expect(await db().serviceOrder.count({ where: { orderId: o2.id } })).toBe(1);
  });
});

// ─────────────────────────── Cenários complementares ───────────────────────────

describe('Cenários complementares (15, 19, 20, 22, 28)', () => {
  it('edição depois da confirmação: substitui; excedente "aguardando"; fornecedor não é cancelado', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(12))).forecasts[0]!.requirementId;
    const po = await exclusivePurchase(admin, id, 12);
    expect((await put(admin, `/api/v1/material-forecasts/${id}`, linen(10))).status).toBe(200);
    const f = await forecastsOf(admin, o.id);
    expect(f.forecasts[0]).toMatchObject({
      need: 10,
      awaiting: 10,
      shortfall: 0,
      excess: { awaiting: 2 },
    });
    expect((await db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(
      'CONFIRMADO',
    );
  });

  it('retirada reagendada ou cancelada não cancela a previsão', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const id = (await forecast(admin, o.id, o.items[0]!.id, linen(5))).forecasts[0]!.requirementId;
    const pk = await createPickup(admin, o, '2026-12-01');
    const moved = await admin.put(`/api/v1/pickups/${pk.id}`, {
      scheduledDate: '2026-12-08',
      windowStart: '09:00',
      windowEnd: '12:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items: o.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      version: pk.version,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const cancel = await admin.post(`/api/v1/pickups/${pk.id}/transition`, {
      toStatus: 'CANCELADA',
      note: 'Cliente pediu outra data',
      version: moved.body.version,
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await reqOf(id)).status).toBe('ATIVA');
  });

  it('duas peças, mesmo tecido, compra consolidada; só A chega; entregas parciais antes e depois', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const [sofa, pol] = [o.items[0]!.id, o.items[1]!.id];
    const a = (await forecast(admin, o.id, sofa, linen(10))).forecasts[0]!.requirementId;
    const b = (await forecast(admin, o.id, pol, linen(5))).forecasts.find(
      (x) => x.orderItemId === pol,
    )!.requirementId;
    const supplier = await createSupplier(admin, 'Fornecedor Consolidado');
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: a, quantity: 10 }],
          quantity: 10,
          unitPriceCents: 4500,
        },
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: b, quantity: 5 }],
          quantity: 5,
          unitPriceCents: 4500,
        },
      ],
    });
    const c = (await confirmPurchase(admin, po.body)).body;
    const itemA = c.items.find(
      (i: { allocations: { materialRequirementId: string }[] }) =>
        i.allocations[0]!.materialRequirementId === a,
    );
    // 8 antes da chegada da peça.
    expect((await receive(admin, c.id, [ok(itemA.id, 8)])).status).toBe(201);
    await arrive(admin, o.id, [{ orderItemId: sofa, quantity: 1 }]);
    const so = await openOs(admin, o.id, [{ orderItemId: sofa, quantity: 1 }]);
    // 2 depois.
    expect((await receive(admin, c.id, [ok(itemA.id, 2)])).status).toBe(201);
    expect((await reqOf(a)).serviceOrderId).toBe(so.id);
    expect((await reqOf(b)).serviceOrderId).toBeNull();
    const itemB = await db().purchaseOrderItem.findFirstOrThrow({
      where: { allocations: { some: { materialRequirementId: b } } },
    });
    expect(itemB.serviceOrderId).toBeNull();
    const r = await readiness(admin, so.id);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ requirementId: a, need: 10, covered: 10 });
    expect(await syncCosts(admin, so.id)).toBe(200);
    const costs = await costsOf(so.id);
    expect(costs.map((x) => Number(x.quantity)).sort()).toEqual([2, 8]);
    expect((await needs(admin)).find((n) => n.requirementId === b)!.preArrival!.piece).toBe(
      'Poltronas',
    );
  });

  it('peça devolvida depois da chegada: previsão vinculada é CANCELADA (Etapa 2)', async () => {
    const admin = await loginAdmin(app);
    const o = await newOrder(admin);
    const sofa = o.items[0]!.id;
    const id = (await forecast(admin, o.id, sofa, linen(5))).forecasts[0]!.requirementId;
    await arrive(admin, o.id, [
      { orderItemId: sofa, quantity: 1 },
      { orderItemId: o.items[1]!.id, quantity: 2 },
    ]);
    const so = await openOs(admin, o.id, [
      { orderItemId: sofa, quantity: 1 },
      { orderItemId: o.items[1]!.id, quantity: 2 },
    ]);
    const soItem = so.items.find((i) => i.orderItemId === sofa)!;
    const ret = await post(admin, '/api/v1/returns', {
      orderId: o.id,
      reason: 'Cliente desistiu do sofá',
      returnDate: new Date().toISOString().slice(0, 10),
      destination: 'Entregue ao cliente',
      lines: [{ orderItemId: sofa, quantity: 1, serviceOrderItemIds: [soItem.id] }],
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const c = await post(admin, `/api/v1/returns/${ret.body.id}/confirm`, {
      note: 'Levou',
      version: ret.body.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await reqOf(id)).status).toBe('CANCELADA');
  });
});
