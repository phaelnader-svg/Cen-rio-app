import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';
import {
  approvedNeeds,
  confirmPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  readiness,
  receive,
  staples,
} from './purchasing-helpers';
import { today, userIdOf } from './production-helpers';

/**
 * Compras e materiais sem duplicidade — Etapa 1. Regra única da falta (lista, consolidado,
 * prontidão, aba da OS, Central), estoque livre só desconta da SUGESTÃO, sobra só como sugestão,
 * recusa com decisão explícita (repor / não repor), consumo esquecido visível, sem preço visível,
 * CSV de custos sincronizado. Contraprovas dos defeitos E1–E4 contra a fórmula antiga.
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

type Need = {
  requirementId: string;
  sourcing: string;
  need: number;
  purchased: number;
  purchasedDraft: number;
  received: number;
  reserved: number;
  transferredIn: number;
  covered: number;
  awaiting: number;
  pendingToBuy: number;
  divergence: boolean;
  blocksProduction?: boolean;
  serviceOrder: { id: string; code: string };
};
type Group = {
  key: string;
  description: string;
  sourcing: string;
  need: number;
  covered: number;
  inPurchase: number;
  awaiting: number;
  inDraft: number;
  shortfall: number;
  freeStock: number | null;
  freePending: number;
  suggestion: number;
  stockItem: { id: string } | null;
  leftovers: { id: string; quantity: number }[];
  blocksProduction: boolean;
  rows: Need[];
};

/**
 * Fórmula ANTERIOR (purchase-orders.ts, antes desta etapa), recalculada sobre os mesmos fatos —
 * contraprova: `need − sobra − (exclusivo ? pipeline : max(pipeline, reservado+entregue))`,
 * só com as reservas VINCULADAS à necessidade e sem estoque livre nem consolidação.
 */
async function legacyPendingToBuy(n: Need) {
  const linked = await db().stockReservation.findMany({
    where: { materialRequirementId: n.requirementId, status: { in: ['ATIVA', 'CONSUMIDA'] } },
  });
  const reserved = linked.reduce((s, r) => s + Number(r.quantity), 0);
  const pipeline = n.purchased + n.purchasedDraft;
  const covered = n.sourcing === 'EXCLUSIVO_OS' ? pipeline : Math.max(pipeline, reserved);
  return Math.max(0, n.need - n.transferredIn - covered);
}

const needs = async (c: Client) =>
  (await c.get('/api/v1/purchasing/needs?pendingOnly=false')).body as Need[];
const needOf = async (c: Client, requirementId: string) =>
  (await needs(c)).find((n) => n.requirementId === requirementId)!;
const shortages = async (c: Client) =>
  (await c.get('/api/v1/purchasing/shortages')).body as Group[];
const groupOf = async (c: Client, description: string) =>
  (await shortages(c)).find((g) => g.description === description);

/** Material do catálogo de estoque com saldo físico livre (sem preço: ajuste de inventário). */
async function stockOf(admin: Client, onHand: number, description = 'Grampos 80/10') {
  const item = await admin.post('/api/v1/stock-items', {
    kind: 'OUTRO',
    description,
    unit: 'EMBALAGEM',
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  if (onHand > 0) {
    const adj = await post(admin, `/api/v1/stock-items/${item.body.id}/adjust`, {
      quantity: onHand,
      reason: 'Inventário inicial',
    });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
  }
  return item.body as { id: string };
}
async function reserve(
  admin: Client,
  body: {
    stockItemId: string;
    serviceOrderId: string;
    materialRequirementId?: string | null;
    quantity: number;
  },
) {
  const r = await post(admin, '/api/v1/stock-reservations', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}
/** Pedido de estoque confirmado (com preço) alocado às necessidades indicadas. */
async function stockPurchase(
  admin: Client,
  supplierId: string,
  allocations: { materialRequirementId: string; quantity: number }[],
  quantity: number,
  opts: { confirm?: boolean; stockItemId?: string; unitPriceCents?: number } = {},
) {
  const po = await createPurchase(admin, {
    supplierId,
    items: [
      {
        sourcing: 'ESTOQUE',
        ...(opts.stockItemId ? { stockItemId: opts.stockItemId } : {}),
        allocations,
        quantity,
        unitPriceCents: opts.unitPriceCents ?? 1000,
      },
    ],
  });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  if (opts.confirm === false) return po.body;
  const c = await confirmPurchase(admin, po.body);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body;
}
async function fabricPurchase(
  admin: Client,
  supplierId: string,
  requirementId: string,
  quantity: number,
  confirm = true,
) {
  const po = await createPurchase(admin, {
    supplierId,
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: requirementId, quantity }],
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
const stapleOs = (admin: Client, name: string, quantity: number) =>
  approvedNeeds(admin, name, () => [staples({ quantity })]);
const persistedReadiness = async (id: string) =>
  (await db().serviceOrder.findUniqueOrThrow({ where: { id } })).materialsReadiness;

// ─────────────────────────── E1 / E4 — estoque livre e consolidação ───────────────────────────

describe('E1/E4 — estoque livre desconta da sugestão e o material é consolidado entre OS', () => {
  it('exemplo aprovado: necessidade 15, livre 8, em compra 4 → sugestão 3 (antes: 11)', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const stock = await stockOf(admin, 8);
    const a = await stapleOs(admin, 'Cliente OS A', 10);
    const b = await stapleOs(admin, 'Cliente OS B', 5);
    // 4 comprados (confirmados) para a OS A, ainda não recebidos.
    await stockPurchase(
      admin,
      supplier.id,
      [{ materialRequirementId: a.reqs[0]!.id, quantity: 4 }],
      4,
      {
        stockItemId: stock.id,
      },
    );

    const g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toMatchObject({
      sourcing: 'ESTOQUE',
      need: 15,
      freeStock: 8,
      awaiting: 4,
      inPurchase: 4,
      shortfall: 11,
      suggestion: 3,
      stockItem: { id: stock.id },
    });
    // Duas OS na MESMA linha consolidada (E4), cada uma com a sua falta.
    expect(g.rows.map((r) => [r.serviceOrder.code, r.pendingToBuy]).sort()).toEqual(
      [
        [a.so.code, 6],
        [b.so.code, 5],
      ].sort(),
    );
    // Contraprova (E1/E4): a fórmula antiga somava 6 + 5 = 11 a comprar, sem descontar o livre.
    const legacy = (await Promise.all(g.rows.map(legacyPendingToBuy))).reduce((s, x) => s + x, 0);
    expect(legacy).toBe(11);
    expect(g.suggestion).toBeLessThan(legacy);

    // V1: o estoque livre NÃO foi reservado nem movimentado.
    const item = await db().stockItem.findUniqueOrThrow({ where: { id: stock.id } });
    expect(Number(item.reserved)).toBe(0);
    expect(await db().stockReservation.count()).toBe(0);
    expect(await persistedReadiness(b.so.id)).toBe('AGUARDANDO_COMPRA');
  });

  it('1. sem estoque: sugestão = falta (material sem catálogo também)', async () => {
    const admin = await loginAdmin(app);
    await stapleOs(admin, 'Cliente Sem Estoque', 7);
    const g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toMatchObject({
      need: 7,
      freeStock: 0,
      shortfall: 7,
      suggestion: 7,
      stockItem: null,
    });
  });

  it('2/3. duas OS, estoque para uma mas não para duas: sugestão só da diferença, nada reservado', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockOf(admin, 6);
    const a = await stapleOs(admin, 'Cliente Dois A', 5);
    await stapleOs(admin, 'Cliente Dois B', 5);
    const g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toMatchObject({ need: 10, freeStock: 6, shortfall: 10, suggestion: 4 });
    expect(g.rows).toHaveLength(2);
    // Reservar é a ação explícita que liga o livre a UMA OS.
    await reserve(admin, {
      stockItemId: stock.id,
      serviceOrderId: a.so.id,
      materialRequirementId: a.reqs[0]!.id,
      quantity: 5,
    });
    const after = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(after).toMatchObject({ freeStock: 1, shortfall: 5, suggestion: 4 });
    expect(after.rows).toHaveLength(1); // A está coberta
    expect(await persistedReadiness(a.so.id)).toBe('COMPLETO');
  });

  it('4. reserva de OUTRA OS não é livre', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockOf(admin, 8);
    const c = await stapleOs(admin, 'Cliente Dona da Reserva', 8);
    await reserve(admin, {
      stockItemId: stock.id,
      serviceOrderId: c.so.id,
      materialRequirementId: c.reqs[0]!.id,
      quantity: 8,
    });
    const a = await stapleOs(admin, 'Cliente Precisa', 6);
    const g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toMatchObject({ freeStock: 0, shortfall: 6, suggestion: 6 });
    expect(g.rows.map((r) => r.serviceOrder.id)).toEqual([a.so.id]);
  });

  it('10/11. estoque livre e compra de estoque pendente sem destino descontam só a sugestão', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const stock = await stockOf(admin, 2);
    const a = await stapleOs(admin, 'Cliente Pendente', 10);
    // Reposição do estoque: 3 em compra, sem OS de destino (confirmado) + 1 em rascunho (D10).
    await stockPurchase(admin, supplier.id, [], 3, { stockItemId: stock.id });
    await stockPurchase(admin, supplier.id, [], 1, { stockItemId: stock.id, confirm: false });
    const g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toMatchObject({ freeStock: 2, freePending: 4, shortfall: 10, suggestion: 4 });
    // A falta da OS não muda: nada daquilo é dela até reservar/alocar.
    expect((await needOf(admin, a.reqs[0]!.id)).pendingToBuy).toBe(10);
  });
});

// ─────────────────────────── E2 / E3 — reservas contam uma única vez ───────────────────────────

describe('E2/E3 — reserva manual cobre a necessidade (com ou sem requirementId)', () => {
  it('8. E2: reserva manual 8 de 10 + compra de 2 → falta 0 (antes: 2 para sempre)', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const stock = await stockOf(admin, 8);
    const a = await stapleOs(admin, 'Cliente E2', 10);
    const req = a.reqs[0]!.id;
    await reserve(admin, {
      stockItemId: stock.id,
      serviceOrderId: a.so.id,
      materialRequirementId: req,
      quantity: 8,
    });
    expect((await needOf(admin, req)).pendingToBuy).toBe(2);
    await stockPurchase(admin, supplier.id, [{ materialRequirementId: req, quantity: 2 }], 2, {
      stockItemId: stock.id,
    });
    const n = await needOf(admin, req);
    expect(n).toMatchObject({ pendingToBuy: 0, covered: 8, awaiting: 2 });
    // Contraprova: a fórmula antiga continuava mostrando 2 a comprar.
    expect(await legacyPendingToBuy(n)).toBe(2);
    // E o servidor recusa comprar de novo o que já está coberto (antes aceitava até o aprovado).
    const again = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'ESTOQUE',
          stockItemId: stock.id,
          allocations: [{ materialRequirementId: req, quantity: 1 }],
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/acima da necessidade aprovada.*falta 0/);
    expect(await persistedReadiness(a.so.id)).toBe('PARCIALMENTE_DISPONIVEL');
  });

  it('9. E3: reserva SEM requirementId é atribuída pela especificação e atualiza a prontidão', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockOf(admin, 10);
    const a = await stapleOs(admin, 'Cliente E3', 10);
    const req = a.reqs[0]!.id;
    expect(await persistedReadiness(a.so.id)).toBe('AGUARDANDO_COMPRA');
    await reserve(admin, { stockItemId: stock.id, serviceOrderId: a.so.id, quantity: 8 });
    const n = await needOf(admin, req);
    expect(n).toMatchObject({ covered: 8, reserved: 8, pendingToBuy: 2 });
    // Contraprova: antes a reserva sem vínculo era ignorada (10 a comprar).
    expect(await legacyPendingToBuy(n)).toBe(10);
    // 23. materialsReadiness gravado acompanha a cobertura real.
    expect(await persistedReadiness(a.so.id)).toBe('PARCIALMENTE_DISPONIVEL');
    await reserve(admin, { stockItemId: stock.id, serviceOrderId: a.so.id, quantity: 2 });
    expect(await persistedReadiness(a.so.id)).toBe('COMPLETO');
    expect((await readiness(admin, a.so.id)).state).toBe('COMPLETO');
    // Reserva excedente sem vínculo não "cobre" outra necessidade nem passa da aprovada.
    expect((await needOf(admin, req)).covered).toBe(10);
  });

  it('14. recebido que virou reserva não conta duas vezes (parcial e total)', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await stapleOs(admin, 'Cliente Recebe Estoque', 10);
    const req = a.reqs[0]!.id;
    const po = await stockPurchase(
      admin,
      supplier.id,
      [{ materialRequirementId: req, quantity: 10 }],
      10,
    );
    const itemId = po.items[0].id;
    expect((await receive(admin, po.id, [ok(itemId, 6)])).status).toBe(201);
    let n = await needOf(admin, req);
    expect(n).toMatchObject({ reserved: 6, covered: 6, awaiting: 4, pendingToBuy: 0 });
    expect(n.covered + n.awaiting).toBe(n.need);
    let g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toMatchObject({
      covered: 6,
      awaiting: 4,
      inPurchase: 4,
      shortfall: 0,
      suggestion: 0,
    });
    expect((await receive(admin, po.id, [ok(itemId, 4)])).status).toBe(201);
    n = await needOf(admin, req);
    expect(n).toMatchObject({ reserved: 10, covered: 10, awaiting: 0, pendingToBuy: 0 });
    g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g).toBeUndefined(); // nada mais pendente
    expect(await persistedReadiness(a.so.id)).toBe('COMPLETO');
  });
});

// ─────────────────────────── Exclusivo, compra parcial, recebimento parcial, sobra ───────────────────────────

describe('Exclusivo (tecido): compra parcial, recebimento parcial e sobra só como sugestão', () => {
  it('5/6/12. 20 = 8 confirmados + 7 em rascunho → falta 5; prontidão aguardando recebimento ao completar', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await approvedNeeds(admin, 'Cliente Tecido', (s) => [linen(s.items[0].id, 20)]);
    const req = a.reqs[0]!.id;
    await fabricPurchase(admin, supplier.id, req, 8);
    await fabricPurchase(admin, supplier.id, req, 7, false);
    expect(await needOf(admin, req)).toMatchObject({
      pendingToBuy: 5,
      awaiting: 8,
      purchasedDraft: 7,
    });
    const g = (await groupOf(admin, 'Linho'))!;
    expect(g).toMatchObject({
      sourcing: 'EXCLUSIVO_OS',
      freeStock: null,
      need: 20,
      awaiting: 8,
      inDraft: 7,
      inPurchase: 15,
      shortfall: 5,
      suggestion: 5,
    });
    expect(await persistedReadiness(a.so.id)).toBe('AGUARDANDO_COMPRA');
    await fabricPurchase(admin, supplier.id, req, 5);
    // Rascunho não conta como comprado (8 + 5 confirmados de 20).
    expect(await persistedReadiness(a.so.id)).toBe('AGUARDANDO_COMPRA');
    const draft = await db().purchaseOrder.findFirstOrThrow({ where: { status: 'RASCUNHO' } });
    expect((await confirmPurchase(admin, draft)).status).toBe(200);
    expect(await persistedReadiness(a.so.id)).toBe('AGUARDANDO_RECEBIMENTO');
  });

  it('7. recebimento parcial: disponível 6, aguardando 4, nada a comprar', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await approvedNeeds(admin, 'Cliente Parcial', (s) => [linen(s.items[0].id, 10)]);
    const req = a.reqs[0]!.id;
    const po = await fabricPurchase(admin, supplier.id, req, 10);
    expect((await receive(admin, po.id, [ok(po.items[0].id, 6)])).status).toBe(201);
    expect(await needOf(admin, req)).toMatchObject({ covered: 6, awaiting: 4, pendingToBuy: 0 });
    expect(await persistedReadiness(a.so.id)).toBe('PARCIALMENTE_DISPONIVEL');
  });

  it('13. sobra compatível aparece como sugestão, não desconta e não é transferida sozinha', async () => {
    const admin = await loginAdmin(app);
    const origin = await approvedNeeds(admin, 'Cliente Origem Sobra', (s) => [
      linen(s.items[0].id, 2),
    ]);
    const leftover = await admin.post('/api/v1/material-leftovers', {
      serviceOrderId: origin.so.id,
      kind: 'TECIDO',
      description: 'Linho',
      color: 'Bege',
      quantity: 8,
      unit: 'METRO',
      location: 'Prateleira 2',
      condition: 'BOA',
      reusable: true,
    });
    expect(leftover.status, JSON.stringify(leftover.body)).toBe(201);
    const a = await approvedNeeds(admin, 'Cliente Usa Sobra', (s) => [linen(s.items[0].id, 10)]);
    const req = a.reqs[0]!.id;
    const g = (await shortages(admin)).find(
      (x) => x.description === 'Linho' && x.rows.some((r) => r.requirementId === req),
    )!;
    expect(g.leftovers.map((l) => [l.id, l.quantity])).toEqual([[leftover.body.id, 8]]);
    // Não desconta: falta e sugestão continuam cheias; a sobra continua intacta na origem.
    expect((await needOf(admin, req)).pendingToBuy).toBe(10);
    const l = await db().materialLeftover.findUniqueOrThrow({ where: { id: leftover.body.id } });
    expect([l.status, Number(l.quantity)]).toEqual(['DISPONIVEL', 8]);
    // Depois da decisão humana (transferência autorizada), a falta cai.
    const t = await post(admin, `/api/v1/material-leftovers/${leftover.body.id}/transfer`, {
      targetServiceOrderId: a.so.id,
      targetRequirementId: req,
      quantity: 8,
      reason: 'Conferido: mesma cor e tonalidade',
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(await needOf(admin, req)).toMatchObject({ covered: 8, pendingToBuy: 2 });
  });
});

// ─────────────────────────── V4 — recusa: repor / não repor ───────────────────────────

describe('V4 — quantidade recusada exige decisão explícita', () => {
  async function rejected(admin: Client, name: string) {
    const supplier = await createSupplier(admin, `Fornecedor ${name}`);
    const a = await approvedNeeds(admin, name, (s) => [linen(s.items[0].id, 10)]);
    const req = a.reqs[0]!.id;
    const po = await fabricPurchase(admin, supplier.id, req, 10);
    const rc = await receive(admin, po.id, [
      {
        purchaseOrderItemId: po.items[0].id,
        acceptedQuantity: 6,
        rejectedQuantity: 4,
        specConfirmed: true,
        issue: 'DANIFICADO',
        issueNote: 'Rolo rasgado',
      },
    ]);
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    return { a, req, po, lineId: rc.body.lines[0].id as string };
  }
  const decide = async (c: Client, poId: string, lineId: string, decision: string) => {
    const po = (await c.get(`/api/v1/purchase-orders/${poId}`)).body;
    return post(c, `/api/v1/material-receipts/lines/${lineId}/rejection-decision`, {
      decision,
      version: po.version,
    });
  };

  it('sem decisão nada é presumido: divergência visível, saldo ainda esperado', async () => {
    const admin = await loginAdmin(app);
    const { a, req, po } = await rejected(admin, 'Cliente Sem Decisão');
    expect(await persistedReadiness(a.so.id)).toBe('COM_DIVERGENCIA');
    expect(await needOf(admin, req)).toMatchObject({
      divergence: true,
      awaiting: 4,
      pendingToBuy: 0,
    });
    const dto = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    expect(dto.hasIssues).toBe(true);
    expect(dto.receipts[0].lines[0]).toMatchObject({
      rejectionPending: true,
      rejectionDecision: null,
    });
    expect(dto.can.decideRejection).toBe(true);
  });

  it('15. REPOR: saldo continua aguardando o fornecedor; a divergência sai', async () => {
    const admin = await loginAdmin(app);
    const { a, req, po, lineId } = await rejected(admin, 'Cliente Repor');
    const r = await decide(admin, po.id, lineId, 'REPOR');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lines[0]).toMatchObject({ rejectionDecision: 'REPOR', rejectionPending: false });
    expect(await needOf(admin, req)).toMatchObject({
      divergence: false,
      awaiting: 4,
      pendingToBuy: 0,
    });
    const item = await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: po.items[0].id } });
    expect(Number(item.closedQuantity)).toBe(0);
    expect(await persistedReadiness(a.so.id)).toBe('PARCIALMENTE_DISPONIVEL');
    const dto = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    expect(dto).toMatchObject({ status: 'PARCIALMENTE_RECEBIDO', hasIssues: false });
    // Decidir de novo: recusado.
    expect((await decide(admin, po.id, lineId, 'NAO_REPOR')).status).toBe(409);
  });

  it('16. NÃO REPOR: encerra só o recusado e devolve para A comprar; recebido preservado', async () => {
    const admin = await loginAdmin(app);
    const { a, req, po, lineId } = await rejected(admin, 'Cliente Não Repor');
    const r = await decide(admin, po.id, lineId, 'NAO_REPOR');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const item = await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: po.items[0].id } });
    expect([Number(item.receivedQuantity), Number(item.closedQuantity)]).toEqual([6, 4]);
    expect(await needOf(admin, req)).toMatchObject({
      divergence: false,
      covered: 6,
      awaiting: 0,
      pendingToBuy: 4,
    });
    expect((await groupOf(admin, 'Linho'))!.suggestion).toBe(4);
    expect(await persistedReadiness(a.so.id)).toBe('PARCIALMENTE_DISPONIVEL');
    const dto = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    expect(dto.status).toBe('RECEBIDO');
    expect(dto.history.map((h: { kind: string }) => h.kind)).toContain('RECUSA_NAO_REPOR');
    // Custo do recebido continua (6 × preço), nada estornado.
    const result = (await admin.get(`/api/v1/finance/service-orders/${a.so.id}`)).body;
    expect(result.materials.consumedCents).toBe(6 * 4500);
  });

  it('só o gestor de compras decide; tablet não decide nem vê A comprar (V9)', async () => {
    const admin = await loginAdmin(app);
    const { po, lineId } = await rejected(admin, 'Cliente Permissão');
    const buyer = await panelUserWith(app, admin, 'comprador', [
      'compras.ver',
      'compras.gerenciar',
    ]);
    expect((await decide(buyer, po.id, lineId, 'REPOR')).status).toBe(403);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Thiago',
      pin: '505050',
    });
    expect((await tablet.get('/api/v1/purchasing/shortages')).status).toBe(403);
    expect(
      (
        await post(tablet, `/api/v1/material-receipts/lines/${lineId}/rejection-decision`, {
          decision: 'REPOR',
          version: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(tablet, '/api/v1/stock-reservations', {
          stockItemId: po.id,
          serviceOrderId: po.id,
          quantity: 1,
        })
      ).status,
    ).toBe(403);
  });

  it('17. saldo encerrado (mecanismo existente) devolve o pendente para A comprar', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await approvedNeeds(admin, 'Cliente Encerra', (s) => [linen(s.items[0].id, 10)]);
    const req = a.reqs[0]!.id;
    const po = await fabricPurchase(admin, supplier.id, req, 10);
    expect((await receive(admin, po.id, [ok(po.items[0].id, 6)])).status).toBe(201);
    const cur = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    const c = await post(admin, `/api/v1/purchase-orders/${po.id}/close-balance`, {
      reason: 'Fornecedor sem estoque',
      version: cur.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await needOf(admin, req)).toMatchObject({ covered: 6, awaiting: 0, pendingToBuy: 4 });
  });
});

// ─────────────────────────── V5 — consumo esquecido, sem preço, CSV ───────────────────────────

describe('V5 — reserva ativa em OS entregue, custo sem preço e CSV sincronizado', () => {
  async function deliveredWithReservation(admin: Client) {
    const stock = await stockOf(admin, 5);
    const a = await stapleOs(admin, 'Cliente Entregue', 5);
    const r = await reserve(admin, {
      stockItemId: stock.id,
      serviceOrderId: a.so.id,
      materialRequirementId: a.reqs[0]!.id,
      quantity: 5,
    });
    await db().serviceOrderItem.updateMany({
      where: { serviceOrderId: a.so.id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    return { a, r, stock };
  }
  const warning = 'Material reservado ainda não teve consumo confirmado';

  it('18/19. OS entregue com reserva ativa: aviso nas reservas, na OS e no resultado; liberar resolve', async () => {
    const admin = await loginAdmin(app);
    const { a, r } = await deliveredWithReservation(admin);
    const list = (await admin.get('/api/v1/stock-reservations?status=ATIVA')).body;
    expect(list.find((x: { id: string }) => x.id === r.id).unconfirmedConsumption).toBe(true);
    expect((await readiness(admin, a.so.id)).unconfirmedConsumption).toBe(true);
    let result = (await admin.get(`/api/v1/finance/service-orders/${a.so.id}`)).body;
    expect(result.warnings.join(' ')).toContain(warning);
    expect(result.materials.consumedCents).toBe(0);
    // Nada foi consumido automaticamente.
    expect((await db().stockReservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'ATIVA',
    );

    const rel = await admin.post(`/api/v1/stock-reservations/${r.id}/release`, {
      reason: 'Não usado',
    });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect((await readiness(admin, a.so.id)).unconfirmedConsumption).toBe(false);
    result = (await admin.get(`/api/v1/finance/service-orders/${a.so.id}`)).body;
    expect(result.warnings.join(' ')).not.toContain(warning);
  });

  it('20/21. consumir resolve o aviso; material sem preço aparece como "sem preço"', async () => {
    const admin = await loginAdmin(app);
    const { a, r } = await deliveredWithReservation(admin);
    const c = await admin.post(`/api/v1/stock-reservations/${r.id}/consume`, {});
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await readiness(admin, a.so.id)).unconfirmedConsumption).toBe(false);
    const result = (await admin.get(`/api/v1/finance/service-orders/${a.so.id}`)).body;
    expect(result.warnings.join(' ')).not.toContain(warning);
    // Estoque de inventário sem preço: lançamento marcado, não um custo real de R$ 0 calado.
    expect(result.materials.unpricedLines).toBe(1);
    expect(result.materials.lines[0]).toMatchObject({ source: 'SAIDA_ESTOQUE', priced: false });
    expect(result.warnings.join(' ')).toContain('sem preço');
  });

  it('20. consumo de estoque comprado com preço vira custo da OS', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await stapleOs(admin, 'Cliente Consome', 4);
    const po = await stockPurchase(
      admin,
      supplier.id,
      [{ materialRequirementId: a.reqs[0]!.id, quantity: 4 }],
      4,
      { unitPriceCents: 250 },
    );
    expect((await receive(admin, po.id, [ok(po.items[0].id, 4)])).status).toBe(201);
    const res = await db().stockReservation.findFirstOrThrow({
      where: { serviceOrderId: a.so.id },
    });
    expect((await admin.post(`/api/v1/stock-reservations/${res.id}/consume`, {})).status).toBe(200);
    const result = (await admin.get(`/api/v1/finance/service-orders/${a.so.id}`)).body;
    expect(result.materials.consumedCents).toBe(1000);
  });

  it('22. CSV de custos sincroniza a razão antes de agregar (antes saía desatualizado)', async () => {
    const admin = await loginAdmin(app);
    const { r } = await deliveredWithReservation(admin);
    expect((await admin.post(`/api/v1/stock-reservations/${r.id}/consume`, {})).status).toBe(200);
    // Contraprova: nenhuma leitura financeira ainda — a razão está vazia.
    expect(await db().serviceOrderCost.count()).toBe(0);
    const csv = await admin.get(
      `/api/v1/finance/reports/custos?format=csv&from=${today()}&to=${today()}`,
    );
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('SAIDA_ESTOQUE');
    expect(await db().serviceOrderCost.count()).toBe(1);
    const json = (await admin.get(`/api/v1/finance/reports/custos?from=${today()}&to=${today()}`))
      .body;
    expect(json.notes.join(' ')).toContain('sem preço');
  });
});

// ─────────────────────────── Prazos / D9 / fila ───────────────────────────

describe('Integração com Prazos (MATERIAIS) e garantias D9, fila e prazo prometido', () => {
  async function planAndStart(admin: Client, so: { id: string; items: { id: string }[] }) {
    const ricardo = await userIdOf('Ricardo');
    const r = await post(admin, '/api/v1/production/plan-services', {
      entries: [
        {
          serviceOrderId: so.id,
          startDate: today(),
          pieces: so.items.map((i) => ({ serviceOrderItemId: i.id, upholstererUserId: ricardo })),
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }

  it('24–27. MATERIAIS some do risco quando resolvido; fila, D9 e prazo intactos', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockOf(admin, 10);
    const a = await stapleOs(admin, 'Cliente Prazo Material', 10);
    const promised = new Date(`${today()}T00:00:00Z`);
    await db().serviceOrder.update({ where: { id: a.so.id }, data: { promisedDate: promised } });
    await planAndStart(admin, a.so);

    const reasons = async () =>
      ((await admin.get(`/api/v1/service-orders/${a.so.id}`)).body.deadline?.reasons ??
        []) as string[];
    expect(await reasons()).toContain('MATERIAIS');
    // "Bloqueia produção" no A comprar = tarefa aguardando com bloqueio de materiais.
    const blockedTasks = await db().productionTask.count({
      where: { serviceOrderId: a.so.id, blockers: { has: 'MATERIAIS' } },
    });
    const g = (await groupOf(admin, 'Grampos 80/10'))!;
    expect(g.rows[0]!.blocksProduction).toBe(blockedTasks > 0);

    const snapshot = async () => ({
      tasks: await db().productionTask.findMany({
        where: { serviceOrderId: a.so.id },
        select: {
          id: true,
          priority: true,
          queuePosition: true,
          planId: true,
          assigneeUserId: true,
          sequence: true,
          scheduledAt: true,
        },
        orderBy: { id: 'asc' },
      }),
      os: await db().serviceOrder.findUniqueOrThrow({
        where: { id: a.so.id },
        select: { priority: true, promisedDate: true },
      }),
      plan: await db().productionPlanItem.findMany({
        where: { serviceOrderId: a.so.id },
        select: { id: true, planId: true, startDate: true, priority: true, principalUserId: true },
      }),
    });
    const before = await snapshot();

    // Resolve a falta só com a ação explícita de reservar (sem vínculo — E3).
    await reserve(admin, { stockItemId: stock.id, serviceOrderId: a.so.id, quantity: 10 });
    expect(await persistedReadiness(a.so.id)).toBe('COMPLETO');
    expect(await reasons()).not.toContain('MATERIAIS');
    // Bloqueio de materiais das tarefas reavaliado na mesma transação.
    expect(
      await db().productionTask.count({
        where: { serviceOrderId: a.so.id, blockers: { has: 'MATERIAIS' } },
      }),
    ).toBe(0);

    // 25/26/27: fila (posição, prioridade, plano, responsável), D9 e prazo prometido intactos.
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.os.promisedDate?.toISOString()).toBe(promised.toISOString());
  });
});
