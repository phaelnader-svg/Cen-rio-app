import { CONSOLIDATED_CSV_NOTE } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { STOCK_FREE_ISSUE_WARNING } from '../src/modules/purchasing/stock';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { foam } from './measurement-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  receive,
} from './purchasing-helpers';

/**
 * Remediação pós-auditoria, Rodada 3 — Compras (Fase 6): fila de recebidos por situação (F6-03),
 * compra concorrente acima da necessidade recusada (F6-07b / CA6-03), CSV bruto rotulado (F6-10),
 * rascunho envelhecido (F6-14 / D10) e saída livre que não cobre necessidade (F6-18a).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

type Row = { id: string; code: string; situation: string; pendingItems: number };
const receiving = async (admin: Client, q = '') =>
  (await admin.get(`/api/v1/purchasing/receiving${q}`)).body as Row[];
const draftOf = (supplierId: string, reqId: string, quantity: number) => ({
  supplierId,
  expectedDate: '2030-01-10',
  items: [
    {
      sourcing: 'EXCLUSIVO_OS',
      allocations: [{ materialRequirementId: reqId, quantity }],
      quantity,
      unitPriceCents: 4500,
    },
  ],
});
const allocated = async (reqId: string) =>
  (
    await db().purchaseAllocation.findMany({
      where: {
        materialRequirementId: reqId,
        item: { purchaseOrder: { status: { not: 'CANCELADO' } } },
      },
    })
  ).reduce((a, x) => a + Number(x.quantity), 0);

describe('F6-07b / CA6-03 (8D) — compras simultâneas da mesma necessidade', () => {
  it('duas compras de 12 ao mesmo tempo para 12 aprovados: uma passa, a outra é recusada; nada comprado em dobro', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Concorrência', (s) => [
      linen(s.items[0].id, 12),
    ]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    const results = await Promise.all([
      createPurchase(admin, draftOf(supplier.id, req.id, 12)),
      createPurchase(admin, draftOf(supplier.id, req.id, 12)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await allocated(req.id)).toBe(12);
    expect(await db().purchaseOrder.count()).toBe(1);
    // Depois, nem uma compra a mais (já está todo em compra).
    expect((await createPurchase(admin, draftOf(supplier.id, req.id, 1))).status).toBe(409);
    expect(await allocated(req.id)).toBe(12);
  });

  it('7 + 7 simultâneos para 12: só a primeira fica; o que falta (5) continua comprável', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Parcial', (s) => [
      linen(s.items[0].id, 12),
    ]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    const results = await Promise.all(
      [7, 7].map((q) => createPurchase(admin, draftOf(supplier.id, req.id, q))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await allocated(req.id)).toBe(7);
    const rest = await createPurchase(admin, draftOf(supplier.id, req.id, 5));
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(await allocated(req.id)).toBe(12);
    // Confirmar as duas ao mesmo tempo não muda o que foi alocado.
    const pos = await db().purchaseOrder.findMany();
    const confirmed = await Promise.all(pos.map((p) => confirmPurchase(admin, p)));
    expect(confirmed.map((c) => c.status)).toEqual([200, 200]);
    expect(await allocated(req.id)).toBe(12);
  });
});

describe('F6-03 — fila de recebidos por situação', () => {
  it('aguardando entrega → parcial → recebido; cancelado separado; rascunho fora; sem preço', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Recebidos', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    const other = await approvedNeeds(admin, 'Cliente Recebidos 2', (s) => [
      linen(s.items[0].id, 3),
    ]);
    const draft = await createPurchase(admin, draftOf(supplier.id, other.reqs[0]!.id, 3));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const situation = async () => (await receiving(admin)).find((r) => r.id === po.id)?.situation;
    expect(await situation()).toBe('AGUARDANDO_ENTREGA');
    expect((await receiving(admin)).map((r) => r.id)).not.toContain(draft.body.id);
    const itemId = po.items[0].id as string;
    expect((await receive(admin, po.id, [ok(itemId, 4)])).status).toBe(201);
    expect(await situation()).toBe('PARCIALMENTE_RECEBIDO');
    expect((await receiving(admin)).find((r) => r.id === po.id)?.pendingItems).toBe(1);
    expect((await receive(admin, po.id, [ok(itemId, 6)])).status).toBe(201);
    expect(await situation()).toBe('RECEBIDO');
    // Filtro por situação.
    expect((await receiving(admin, '?situation=RECEBIDO')).map((r) => r.id)).toEqual([po.id]);
    expect(await receiving(admin, '?situation=AGUARDANDO_ENTREGA')).toEqual([]);
    // Cancelado aparece como cancelado.
    const draft2 = (await db().purchaseOrder.findUniqueOrThrow({ where: { id: draft.body.id } }))
      .version;
    const confirmed = await confirmPurchase(admin, { id: draft.body.id, version: draft2 });
    expect(confirmed.status).toBe(200);
    const cancel = await admin.post(
      `/api/v1/purchase-orders/${draft.body.id}/cancel`,
      { reason: 'Fornecedor sem estoque', version: confirmed.body.version },
      { 'idempotency-key': idemKey() },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await receiving(admin)).find((r) => r.id === draft.body.id)?.situation).toBe(
      'CANCELADO',
    );
    // Nenhum preço na fila (é operacional).
    expect(JSON.stringify(await receiving(admin))).not.toMatch(/Cents|price|4500/i);
  });
});

describe('F6-14 (D10) — rascunho envelhecido', () => {
  it('"em rascunho há N dias" na lista e na Central a partir de 3 dias, pela data de criação', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Rascunho', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const supplier = await createSupplier(admin);
    const d = await createPurchase(admin, draftOf(supplier.id, reqs[0]!.id, 10));
    expect(d.status).toBe(201);
    const list = async () =>
      (
        (await admin.get('/api/v1/purchase-orders')).body as {
          id: string;
          draftDays: number | null;
        }[]
      ).find((p) => p.id === d.body.id)!;
    const central = async () =>
      ((await admin.get('/api/v1/attention?type=MATERIAL')).body.items as { key: string }[]).find(
        (i) => i.key === `MATERIAL:rascunho:${d.body.id}`,
      );
    expect((await list()).draftDays).toBe(0);
    expect(await central()).toBeUndefined();
    // Dois dias: ainda não alerta. Quatro dias: alerta (data canônica = criação do rascunho).
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db().purchaseOrder.update({ where: { id: d.body.id }, data: { createdAt: ago(2) } });
    expect((await list()).draftDays).toBe(2);
    expect(await central()).toBeUndefined();
    await db().purchaseOrder.update({ where: { id: d.body.id }, data: { createdAt: ago(4) } });
    expect((await list()).draftDays).toBe(4);
    expect(await central()).toMatchObject({
      category: 'ATENCAO',
      statusLabel: 'Rascunho há 4 dias',
      link: `/painel/compras/${d.body.id}`,
    });
    // Mexer no rascunho (updatedAt) não reinicia a contagem; confirmar tira o alerta.
    await db().purchaseOrder.update({ where: { id: d.body.id }, data: { notes: 'Revisado' } });
    expect((await list()).draftDays).toBe(4);
    const cur = await db().purchaseOrder.findUniqueOrThrow({ where: { id: d.body.id } });
    expect((await confirmPurchase(admin, cur)).status).toBe(200);
    expect((await list()).draftDays).toBeNull();
    expect(await central()).toBeUndefined();
  });
});

describe('F6-10 — CSV bruto rotulado', () => {
  it('cada linha do arquivo diz que é a lista BRUTA (não desconta compras) e o nome do arquivo também', async () => {
    const admin = await loginAdmin(app);
    await approvedNeeds(admin, 'Cliente CSV', (s) => [linen(s.items[0].id, 12)]);
    const csv = await app.app.inject({
      method: 'GET',
      url: '/api/v1/materials/consolidated.csv',
      headers: { cookie: admin.cookieHeader },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv; charset=utf-8');
    expect(String(csv.headers['content-disposition'])).toMatch(
      /materiais-aprovados-lista-bruta-\d{4}-\d{2}-\d{2}\.csv/,
    );
    const rows = csv.body.slice(1).split('\r\n').filter(Boolean);
    expect(rows[0]!.endsWith(';Lista')).toBe(true);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows.slice(1)) expect(r.endsWith(CONSOLIDATED_CSV_NOTE)).toBe(true);
    expect(csv.body).not.toMatch(/R\$|Cents/);
  });
});

describe('F6-18a — saída livre de estoque para uma OS', () => {
  it('avisa que não cobre a necessidade; "A comprar" e prontidão continuam iguais', async () => {
    const admin = await loginAdmin(app);
    const item = await admin.post('/api/v1/stock-items', {
      kind: 'ESPUMA',
      description: 'Espuma',
      foamDensity: 'D28',
      thicknessCm: 3,
      lengthCm: 200,
      widthCm: 60,
      unit: 'PLACA',
      minQuantity: 0,
    });
    expect(item.status).toBe(201);
    await admin.post(
      `/api/v1/stock-items/${item.body.id}/adjust`,
      { quantity: 10, reason: 'Inventário inicial' },
      { 'idempotency-key': idemKey() },
    );
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Saída Livre', (s) => [
      foam({ sourcing: 'ESTOQUE', quantity: 4, serviceOrderItemId: s.items[0]!.id }),
    ]);
    const needs = async () =>
      (
        (await admin.get('/api/v1/purchasing/needs')).body as {
          requirementId: string;
          pendingToBuy: number;
          covered: number;
        }[]
      ).find((n) => n.requirementId === reqs[0]!.id);
    const before = await needs();
    const readinessBefore = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }))
      .materialsReadiness;
    const out = await admin.post(
      `/api/v1/stock-items/${item.body.id}/issue`,
      { quantity: 4, serviceOrderId: so.id, reason: 'Retirado para a OS' },
      { 'idempotency-key': idemKey() },
    );
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.warning).toBe(STOCK_FREE_ISSUE_WARNING);
    expect(await needs()).toEqual(before);
    expect(
      (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).materialsReadiness,
    ).toBe(readinessBefore);
    expect(await db().stockReservation.count()).toBe(0);
    // Sem OS: nenhuma necessidade envolvida, sem aviso.
    const plain = await admin.post(
      `/api/v1/stock-items/${item.body.id}/issue`,
      { quantity: 1, reason: 'Amostra' },
      { 'idempotency-key': idemKey() },
    );
    expect(plain.status).toBe(200);
    expect(plain.body.warning).toBeNull();
  });
});
