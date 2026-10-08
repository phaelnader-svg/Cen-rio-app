import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';
import {
  createMeasurement,
  fabric,
  fillAndSubmit,
  foam,
  gestorUserId,
  nextFriday,
  openServiceOrder,
} from './measurement-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  readiness,
  receive,
  staples,
} from './purchasing-helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

describe('Compras a partir de solicitações aprovadas', () => {
  it('tecido exclusivo da OS: central de compras → pedido → confirmação pelo gestor', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Compra', (s) => [
      linen(s.items[0].id),
    ]);
    const supplier = await createSupplier(admin);

    const needs = (await admin.get('/api/v1/purchasing/needs')).body;
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      kind: 'TECIDO',
      sourcing: 'EXCLUSIVO_OS',
      need: 12,
      pendingToBuy: 12,
      stage: 'APROVADO',
      serviceOrder: { code: so.code },
    });
    expect((await readiness(admin, so.id)).state).toBe('AGUARDANDO_COMPRA');

    const draft = await createPurchase(admin, {
      supplierId: supplier.id,
      expectedDate: '2030-01-10',
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
          quantity: 12.5,
          unitPriceCents: 4590,
        },
      ],
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'RASCUNHO', code: 'CP-00001', totalCents: 57375 });
    expect(draft.body.items[0]).toMatchObject({
      description: 'Linho',
      color: 'Bege',
      unit: 'METRO',
      serviceOrder: { code: so.code },
    });
    // Rascunho não conta como comprado.
    expect((await readiness(admin, so.id)).state).toBe('AGUARDANDO_COMPRA');

    const confirmed = await confirmPurchase(admin, draft.body);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('CONFIRMADO');
    expect(confirmed.body.history.map((h: { kind: string }) => h.kind)).toEqual([
      'CRIADO',
      'CONFIRMADO',
    ]);
    const r = await readiness(admin, so.id);
    expect(r.state).toBe('AGUARDANDO_RECEBIMENTO');
    expect(r.lines[0]).toMatchObject({ stage: 'COMPRADO', purchased: 12, covered: 0 });
    expect(r.canStartProduction).toBe(false);
    expect((await admin.get('/api/v1/purchasing/needs')).body).toHaveLength(0);
  });

  it('não compra sem aprovação, acima do aprovado nem tecido como estoque', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Regras', (s) => [
      linen(s.items[0].id),
    ]);
    // Previsão manual (Fase 2) não é solicitação aprovada.
    const manual = await admin.post(`/api/v1/service-orders/${so.id}/materials`, {
      kind: 'TECIDO',
      sourcing: 'EXCLUSIVO_OS',
      description: 'Linho',
      quantity: 3,
      unit: 'm',
    });
    expect(manual.status).toBe(201);
    const manualId = manual.body.materials.find(
      (x: { origin: string }) => x.origin === 'PREVISAO_MANUAL',
    ).id;
    const notApproved = await createPurchase(admin, {
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: manualId, quantity: 3 }],
          quantity: 3,
        },
      ],
    });
    expect(notApproved.status).toBe(422);
    expect(notApproved.body.error.message).toMatch(/solicitações aprovadas/);

    // Solicitação ainda em revisão também não gera compra (não há necessidade aprovada).
    const other = await openServiceOrder(admin, 'Cliente Pendente');
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: other.id,
        kind: 'ROTINA',
        assigneeUserId: await gestorUserId(),
        dueDate: nextFriday(),
      })
    ).body;
    await fillAndSubmit(admin, m, { items: [linen(other.items[0].id)] });
    const requestItem = await db().materialRequestItem.findFirstOrThrow({
      where: { request: { measurementId: m.id } },
    });
    const fromRequest = await createPurchase(admin, {
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: requestItem.id, quantity: 12 }],
          quantity: 12,
        },
      ],
    });
    expect(fromRequest.status).toBe(422);

    const tooMuch = await createPurchase(admin, {
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 13 }],
          quantity: 13,
        },
      ],
    });
    expect(tooMuch.status).toBe(409);

    const fabricToStock = await createPurchase(admin, {
      items: [
        {
          sourcing: 'ESTOQUE',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
          quantity: 12,
        },
      ],
    });
    expect(fabricToStock.status).toBe(422);
    expect(fabricToStock.body.error.message).toMatch(/nunca para o estoque comum/);

    // Confirmação exige fornecedor e preço.
    const noSupplier = (
      await createPurchase(admin, {
        items: [
          {
            sourcing: 'EXCLUSIVO_OS',
            allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
            quantity: 12,
          },
        ],
      })
    ).body;
    const refused = await confirmPurchase(admin, noSupplier);
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/fornecedor/);
  });

  it('consolida materiais comuns de várias OS preservando a origem; tecidos ficam por OS', async () => {
    const admin = await loginAdmin(app);
    const a = await approvedNeeds(admin, 'Cliente A', (s) => [
      linen(s.items[0].id),
      staples({ quantity: 2 }),
    ]);
    const b = await approvedNeeds(admin, 'Cliente B', (s) => [
      linen(s.items[0].id, 8),
      staples({ quantity: 3 }),
    ]);
    const supplier = await createSupplier(admin);
    const fabricA = a.reqs.find((r) => r.kind === 'TECIDO')!;
    const fabricB = b.reqs.find((r) => r.kind === 'TECIDO')!;
    const stA = a.reqs.find((r) => r.kind === 'OUTRO')!;
    const stB = b.reqs.find((r) => r.kind === 'OUTRO')!;

    // Tecidos iguais de OS diferentes não podem ser uma linha só.
    const mixed = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [
            { materialRequirementId: fabricA.id, quantity: 12 },
            { materialRequirementId: fabricB.id, quantity: 8 },
          ],
          quantity: 20,
          unitPriceCents: 4500,
        },
      ],
    });
    expect(mixed.status).toBe(400);

    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: fabricA.id, quantity: 12 }],
          quantity: 12,
          unitPriceCents: 4500,
        },
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: fabricB.id, quantity: 8 }],
          quantity: 8,
          unitPriceCents: 4500,
        },
        {
          sourcing: 'ESTOQUE',
          allocations: [
            { materialRequirementId: stA.id, quantity: 2 },
            { materialRequirementId: stB.id, quantity: 3 },
          ],
          quantity: 6,
          unitPriceCents: 1890,
        },
      ],
    });
    expect(po.status).toBe(201);
    const stockLine = po.body.items[2];
    expect(stockLine).toMatchObject({ sourcing: 'ESTOQUE', quantity: 6, serviceOrder: null });
    expect(stockLine.stockItem.code).toBe('MT-00001');
    expect(
      stockLine.allocations.map((x: { serviceOrder: { code: string }; quantity: number }) => [
        x.serviceOrder.code,
        x.quantity,
      ]),
    ).toEqual([
      [a.so.code, 2],
      [b.so.code, 3],
    ]);
    expect(po.body.items[0].serviceOrder.code).toBe(a.so.code);
    expect(po.body.items[1].serviceOrder.code).toBe(b.so.code);
    expect(po.body.totalCents).toBe(12 * 4500 + 8 * 4500 + 6 * 1890);
    expect(po.body.serviceOrders.map((x: { code: string }) => x.code)).toEqual([
      a.so.code,
      b.so.code,
    ]);

    const c = await confirmPurchase(admin, po.body);
    // Recebe tudo: comuns entram no estoque e são reservados automaticamente para as OS de origem.
    const tablet = (
      await setupTablet(app, admin, { name: 'Tablet Thiago', employee: 'Thiago', pin: '505050' })
    ).tablet;
    const rec = await receive(
      tablet,
      c.body.id,
      c.body.items.map((i: { id: string; quantity: number }) => ok(i.id, i.quantity)),
    );
    expect(rec.status).toBe(201);
    const stock = (await admin.get('/api/v1/stock-items')).body[0];
    expect(stock).toMatchObject({ onHand: 6, reserved: 5, available: 1 });
    const resv = (await admin.get('/api/v1/stock-reservations')).body;
    expect(
      resv
        .map((r: { serviceOrder: { code: string }; quantity: number }) => [
          r.serviceOrder.code,
          r.quantity,
        ])
        .sort(),
    ).toEqual(
      [
        [a.so.code, 2],
        [b.so.code, 3],
      ].sort(),
    );
    for (const s of [a.so, b.so]) {
      const r = await readiness(admin, s.id);
      expect(r.state).toBe('COMPLETO');
      expect(r.canStartProduction).toBe(false);
      const os = (await admin.get(`/api/v1/service-orders/${s.id}`)).body;
      expect(os.readiness).toMatchObject({
        materials: 'OK',
        materialsState: 'COMPLETO',
        canStartProduction: false,
      });
    }
    // O tecido da OS A não cobre a OS B (e vice-versa): cada um tem sua quantidade.
    const ra = await readiness(admin, a.so.id);
    expect(ra.lines.find((l: { kind: string }) => l.kind === 'TECIDO').covered).toBe(12);
    const rb = await readiness(admin, b.so.id);
    expect(rb.lines.find((l: { kind: string }) => l.kind === 'TECIDO').covered).toBe(8);
  });
});

describe('Recebimento de materiais', () => {
  async function fabricOrder() {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Receb', (s) => [linen(s.items[0].id)]);
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    return { admin, so, po, item: po.items[0] };
  }

  it('parcial, com divergência, duplicado, acima do pedido e excedente autorizado', async () => {
    const { admin, so, po, item } = await fabricOrder();
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet João',
      employee: 'João',
      pin: '121212',
    });

    // Conferência obrigatória.
    const unchecked = await receive(tablet, po.id, [
      { purchaseOrderItemId: item.id, acceptedQuantity: 5, specConfirmed: false },
    ]);
    expect(unchecked.status).toBe(400);

    const key = idemKey();
    const partial = await receive(tablet, po.id, [ok(item.id, 5)], key);
    expect(partial.status).toBe(201);
    expect(partial.body.code).toBe('RM-00001');
    // Mesmo envio repetido (rede instável): o mesmo recebimento, sem duplicar.
    const again = await receive(tablet, po.id, [ok(item.id, 5)], key);
    expect(again.body.id).toBe(partial.body.id);
    expect(await db().materialReceipt.count()).toBe(1);
    let detail = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    expect(detail.status).toBe('PARCIALMENTE_RECEBIDO');
    expect(detail.items[0]).toMatchObject({ receivedQuantity: 5, pendingQuantity: 7 });
    expect((await readiness(admin, so.id)).state).toBe('PARCIALMENTE_DISPONIVEL');

    // Rolo danificado: registrado, mas não disponível.
    const damaged = await receive(tablet, po.id, [
      {
        purchaseOrderItemId: item.id,
        acceptedQuantity: 0,
        rejectedQuantity: 7,
        specConfirmed: false,
        issue: 'DANIFICADO',
        issueNote: 'Rolo molhado',
      },
    ]);
    expect(damaged.status).toBe(201);
    detail = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    expect(detail.items[0]).toMatchObject({ receivedQuantity: 5, rejectedQuantity: 7 });
    expect(detail.hasIssues).toBe(true);
    const r = await readiness(admin, so.id);
    expect(r.state).toBe('COM_DIVERGENCIA');
    expect(r.lines[0]).toMatchObject({ covered: 5, divergence: true });
    const shortage = await db().domainEvent.findFirst({
      where: { type: 'material.shortage_detected' },
    });
    expect(shortage).not.toBeNull();

    // Acima do pedido sem autorização: recusado.
    const over = await receive(tablet, po.id, [ok(item.id, 8)]);
    expect(over.status).toBe(409);
    // Funcionário não autoriza excedente; o gestor sim, com motivo e histórico.
    expect(
      (
        await tablet.post(`/api/v1/purchase-orders/${po.id}/items/${item.id}/authorize-extra`, {
          quantity: 1,
          reason: 'Rolo maior',
          version: detail.version,
        })
      ).status,
    ).toBe(403);
    const extra = await admin.post(
      `/api/v1/purchase-orders/${po.id}/items/${item.id}/authorize-extra`,
      {
        quantity: 1,
        reason: 'Fornecedor enviou rolo de 13 m',
        version: detail.version,
      },
    );
    expect(extra.status).toBe(200);
    const full = await receive(tablet, po.id, [ok(item.id, 8)]);
    expect(full.status).toBe(201);
    detail = (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body;
    expect(detail.status).toBe('RECEBIDO');
    expect(detail.hasIssues).toBe(false);
    expect(detail.history.map((h: { kind: string }) => h.kind)).toContain('EXCEDENTE_AUTORIZADO');
    const done = await readiness(admin, so.id);
    expect(done.state).toBe('COMPLETO');
    expect(done.lines[0].covered).toBe(12);
    // Pedido recebido não aceita mais recebimento.
    expect((await receive(tablet, po.id, [ok(item.id, 1)])).status).toBe(422);
  });

  it('dois recebimentos simultâneos do mesmo saldo: só um é aceito', async () => {
    const { admin, po, item } = await fabricOrder();
    const [r1, r2] = await Promise.all([
      receive(admin, po.id, [ok(item.id, 12)]),
      receive(admin, po.id, [ok(item.id, 12)]),
    ]);
    // O segundo espera o bloqueio e encontra o pedido já recebido (422) ou sem saldo (409).
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(201);
    expect([409, 422]).toContain(statuses[1]);
    expect(await db().materialReceipt.count()).toBe(1);
    expect(Number((await db().purchaseOrderItem.findFirstOrThrow()).receivedQuantity)).toBe(12);
  });

  it('pedido em rascunho não recebe; registros de recebimento são imutáveis', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Imut', (s) => [linen(s.items[0].id)]);
    const draft = (
      await createPurchase(admin, {
        items: [
          {
            sourcing: 'EXCLUSIVO_OS',
            allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
            quantity: 12,
          },
        ],
      })
    ).body;
    expect((await receive(admin, draft.id, [ok(draft.items[0].id, 1)])).status).toBe(422);
    const supplier = await createSupplier(admin, 'Outro Fornecedor');
    await admin.post(`/api/v1/purchase-orders/${draft.id}/cancel`, {
      reason: 'Refazer',
      version: draft.version,
    });
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    await receive(admin, po.id, [ok(po.items[0].id, 4)]);
    await expect(
      db().$executeRawUnsafe('UPDATE material_receipt_lines SET accepted_quantity = 9'),
    ).rejects.toThrow();
    await expect(db().$executeRawUnsafe('DELETE FROM material_receipts')).rejects.toThrow();
  });
});

describe('Estorno auditável', () => {
  it('estorna por lançamento compensatório, respeitando reservas; só o gestor autoriza', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Estorno', () => [
      staples({ quantity: 6 }),
    ]);
    const supplier = await createSupplier(admin);
    const po = (
      await createPurchase(admin, {
        supplierId: supplier.id,
        items: [
          {
            sourcing: 'ESTOQUE',
            allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 6 }],
            quantity: 10,
            unitPriceCents: 1890,
          },
        ],
      })
    ).body;
    const c = (await confirmPurchase(admin, po)).body;
    const rec = (await receive(admin, c.id, [ok(c.items[0].id, 10)])).body;
    const lineId = rec.lines[0].id;
    let stock = (await admin.get('/api/v1/stock-items')).body[0];
    expect(stock).toMatchObject({ onHand: 10, reserved: 6, available: 4 });

    const stocker = await panelUserWith(app, admin, 'estoquista', [
      'estoque.ver',
      'estoque.gerenciar',
    ]);
    const denied = await stocker.post(
      `/api/v1/material-receipts/lines/${lineId}/reverse`,
      { quantity: 2, reason: 'Contagem errada' },
      { 'idempotency-key': idemKey() },
    );
    expect(denied.status).toBe(403);

    // Estornar 5 deixaria o físico (5) abaixo do reservado (6): bloqueado.
    const blocked = await admin.post(
      `/api/v1/material-receipts/lines/${lineId}/reverse`,
      { quantity: 5, reason: 'Contagem errada' },
      { 'idempotency-key': idemKey() },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/reservado/);

    const reversed = await admin.post(
      `/api/v1/material-receipts/lines/${lineId}/reverse`,
      { quantity: 4, reason: 'Quatro embalagens eram de outro pedido' },
      { 'idempotency-key': idemKey() },
    );
    expect(reversed.status).toBe(200);
    expect(reversed.body.lines[0]).toMatchObject({ acceptedQuantity: 10, reversedQuantity: 4 });
    expect(reversed.body.lines[0].reversals[0].reason).toMatch(/outro pedido/);
    stock = (await admin.get('/api/v1/stock-items')).body[0];
    expect(stock).toMatchObject({ onHand: 6, reserved: 6, available: 0 });
    const detail = (await admin.get(`/api/v1/purchase-orders/${c.id}`)).body;
    expect(detail.status).toBe('PARCIALMENTE_RECEBIDO');
    expect(detail.items[0].receivedQuantity).toBe(6);
    const reversal = await db().materialReceiptReversal.findFirstOrThrow();
    expect(reversal.impact).toMatchObject({
      stockBefore: { onHand: 10, reserved: 6 },
      statusAfter: 'PARCIALMENTE_RECEBIDO',
    });
    const movements = (await admin.get('/api/v1/stock-movements')).body;
    expect(movements.map((m: { type: string; quantity: number }) => [m.type, m.quantity])).toEqual([
      ['ESTORNO_RECEBIMENTO', -4],
      ['ENTRADA_COMPRA', 10],
    ]);
    expect(await db().auditLog.count({ where: { action: 'material_receipt.reversed' } })).toBe(1);
    // Não estorna mais do que foi recebido.
    const tooMuch = await admin.post(
      `/api/v1/material-receipts/lines/${lineId}/reverse`,
      { quantity: 7, reason: 'Teste' },
      { 'idempotency-key': idemKey() },
    );
    expect(tooMuch.status).toBe(422);
    expect((await readiness(admin, so.id)).state).toBe('COMPLETO');
  });
});

describe('Estoque híbrido', () => {
  async function stockWith(admin: Awaited<ReturnType<typeof loginAdmin>>, qty: number) {
    const item = await admin.post('/api/v1/stock-items', {
      kind: 'ESPUMA',
      description: 'Espuma',
      foamDensity: 'D28',
      thicknessCm: 3,
      lengthCm: 200,
      widthCm: 60,
      unit: 'PLACA',
      minQuantity: 2,
    });
    expect(item.status).toBe(201);
    const adj = await admin.post(
      `/api/v1/stock-items/${item.body.id}/adjust`,
      { quantity: qty, reason: 'Inventário inicial' },
      { 'idempotency-key': idemKey() },
    );
    expect(adj.status).toBe(200);
    return adj.body;
  }

  it('reserva simultânea para duas OS não consome a mesma quantidade', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockWith(admin, 10);
    const foamReq = (s: { items: { id: string }[] }) => [
      foam({ sourcing: 'ESTOQUE', quantity: 8, serviceOrderItemId: s.items[0]!.id }),
    ];
    const a = await approvedNeeds(admin, 'Cliente R1', foamReq);
    const b = await approvedNeeds(admin, 'Cliente R2', foamReq);
    const reserve = (so: { id: string }, reqId: string) =>
      admin.post(
        '/api/v1/stock-reservations',
        { stockItemId: stock.id, serviceOrderId: so.id, materialRequirementId: reqId, quantity: 8 },
        { 'idempotency-key': idemKey() },
      );
    const [r1, r2] = await Promise.all([
      reserve(a.so, a.reqs[0]!.id),
      reserve(b.so, b.reqs[0]!.id),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const after = (await admin.get('/api/v1/stock-items')).body[0];
    expect(after).toMatchObject({ onHand: 10, reserved: 8, available: 2 });
    expect(await db().stockReservation.count()).toBe(1);
    const states = [
      (await readiness(admin, a.so.id)).state,
      (await readiness(admin, b.so.id)).state,
    ].sort();
    expect(states).toEqual(['AGUARDANDO_COMPRA', 'COMPLETO']);
  });

  it('nunca fica negativo nem abaixo do reservado; saídas e liberação de reservas', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockWith(admin, 5);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Neg', (s) => [
      foam({ sourcing: 'ESTOQUE', quantity: 4, serviceOrderItemId: s.items[0]!.id }),
    ]);
    const res = await admin.post(
      '/api/v1/stock-reservations',
      {
        stockItemId: stock.id,
        serviceOrderId: so.id,
        materialRequirementId: reqs[0]!.id,
        quantity: 4,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(res.status).toBe(201);
    // Reservar acima da necessidade aprovada: recusado.
    const over = await admin.post(
      '/api/v1/stock-reservations',
      {
        stockItemId: stock.id,
        serviceOrderId: so.id,
        materialRequirementId: reqs[0]!.id,
        quantity: 1,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(over.status).toBe(422);
    const negative = await admin.post(
      `/api/v1/stock-items/${stock.id}/adjust`,
      { quantity: -6, reason: 'Perda' },
      { 'idempotency-key': idemKey() },
    );
    expect(negative.status).toBe(409);
    const belowReserved = await admin.post(
      `/api/v1/stock-items/${stock.id}/adjust`,
      { quantity: -2, reason: 'Perda' },
      { 'idempotency-key': idemKey() },
    );
    expect(belowReserved.status).toBe(409);
    const issue = await admin.post(
      `/api/v1/stock-items/${stock.id}/issue`,
      { quantity: 2, reason: 'Uso avulso' },
      { 'idempotency-key': idemKey() },
    );
    expect(issue.status).toBe(409);
    // O banco também impede saldo negativo.
    await expect(db().$executeRawUnsafe('UPDATE stock_items SET on_hand = -1')).rejects.toThrow();

    // Entrega à OS: sai do físico e da reserva; prontidão continua completa.
    const consumed = await admin.post(`/api/v1/stock-reservations/${res.body.id}/consume`, {});
    expect(consumed.body.status).toBe('CONSUMIDA');
    let item = (await admin.get('/api/v1/stock-items')).body[0];
    expect(item).toMatchObject({ onHand: 1, reserved: 0, available: 1, belowMinimum: true });
    expect((await readiness(admin, so.id)).state).toBe('COMPLETO');
    const shortage = await db().domainEvent.count({
      where: { type: 'material.shortage_detected' },
    });
    expect(shortage).toBeGreaterThan(0);

    // Liberação devolve a quantidade à disponibilidade.
    const other = await admin.post(
      '/api/v1/stock-reservations',
      { stockItemId: stock.id, serviceOrderId: so.id, quantity: 1 },
      { 'idempotency-key': idemKey() },
    );
    const released = await admin.post(`/api/v1/stock-reservations/${other.body.id}/release`, {
      reason: 'Não será usado',
    });
    expect(released.body.status).toBe('LIBERADA');
    item = (await admin.get('/api/v1/stock-items')).body[0];
    expect(item).toMatchObject({ onHand: 1, reserved: 0 });
    const types = (await admin.get('/api/v1/stock-movements')).body.map(
      (m: { type: string }) => m.type,
    );
    expect(types).toEqual(['SAIDA_OS', 'AJUSTE_ENTRADA']);
  });

  it('cadastro de catálogo valida unidade, duplicidade e não aceita tecido', async () => {
    const admin = await loginAdmin(app);
    const fabricItem = await admin.post('/api/v1/stock-items', {
      kind: 'TECIDO',
      description: 'Linho',
      unit: 'METRO',
    });
    expect(fabricItem.status).toBe(400);
    const wrongUnit = await admin.post('/api/v1/stock-items', {
      kind: 'ESPUMA',
      description: 'Espuma',
      foamDensity: 'D33',
      thicknessCm: 5,
      unit: 'METRO',
    });
    expect(wrongUnit.status).toBe(400);
    const body = {
      kind: 'OUTRO',
      description: 'Cola de contato',
      unit: 'EMBALAGEM',
      minQuantity: 2,
    };
    expect((await admin.post('/api/v1/stock-items', body)).status).toBe(201);
    expect(
      (await admin.post('/api/v1/stock-items', { ...body, description: 'cola  de CONTATO' }))
        .status,
    ).toBe(409);
  });
});

describe('Sobras e tecido de outra OS', () => {
  it('sobra fica na OS de origem; transferência só autorizada e compatível', async () => {
    const admin = await loginAdmin(app);
    const a = await approvedNeeds(admin, 'Cliente Origem', (s) => [linen(s.items[0].id, 10)]);
    const b = await approvedNeeds(admin, 'Cliente Destino', (s) => [
      linen(s.items[0].id, 3),
      fabric({
        serviceOrderItemId: s.items[1].id,
        description: 'Veludo',
        color: 'Azul',
        quantity: 2,
      }),
    ]);
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, a.reqs[0]!);
    await receive(admin, po.id, [ok(po.items[0].id, 10)]);
    // O tecido recebido da OS A não aparece para a OS B.
    expect((await readiness(admin, b.so.id)).state).toBe('AGUARDANDO_COMPRA');

    // Tecido nunca é reservado do estoque comum para outra OS.
    const foamStock = (
      await admin.post('/api/v1/stock-items', {
        kind: 'OUTRO',
        description: 'Linho',
        unit: 'METRO',
      })
    ).body;
    const viaStock = await admin.post(
      '/api/v1/stock-reservations',
      {
        stockItemId: foamStock.id,
        serviceOrderId: b.so.id,
        materialRequirementId: b.reqs[0]!.id,
        quantity: 1,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(viaStock.status).toBe(422);

    const leftover = await admin.post('/api/v1/material-leftovers', {
      serviceOrderId: a.so.id,
      kind: 'TECIDO',
      description: 'Linho',
      color: 'Bege',
      quantity: 2.5,
      unit: 'METRO',
      location: 'Prateleira 3',
      condition: 'BOA',
      reusable: true,
    });
    expect(leftover.status).toBe(201);
    expect(leftover.body.serviceOrder.code).toBe(a.so.code);

    const stocker = await panelUserWith(app, admin, 'estoquista', [
      'estoque.ver',
      'estoque.gerenciar',
    ]);
    const denied = await stocker.post(
      `/api/v1/material-leftovers/${leftover.body.id}/transfer`,
      {
        targetServiceOrderId: b.so.id,
        targetRequirementId: b.reqs[0]!.id,
        quantity: 2,
        reason: 'Aproveitar',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(denied.status).toBe(403);

    const veludo = b.reqs.find((r) => r.description === 'Veludo')!;
    const incompatible = await admin.post(
      `/api/v1/material-leftovers/${leftover.body.id}/transfer`,
      {
        targetServiceOrderId: b.so.id,
        targetRequirementId: veludo.id,
        quantity: 2,
        reason: 'Aproveitar',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(incompatible.status).toBe(422);
    expect(incompatible.body.error.message).toMatch(/referência, cor/);

    const transfer = await admin.post(
      `/api/v1/material-leftovers/${leftover.body.id}/transfer`,
      {
        targetServiceOrderId: b.so.id,
        targetRequirementId: b.reqs[0]!.id,
        quantity: 2,
        reason: 'Sobra suficiente para a almofada',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(transfer.status).toBe(200);
    expect(transfer.body).toMatchObject({ quantity: 0.5, status: 'DISPONIVEL' });
    expect(transfer.body.transfers[0]).toMatchObject({
      quantity: 2,
      toServiceOrder: { code: b.so.code },
    });
    const rb = await readiness(admin, b.so.id);
    expect(rb.state).toBe('PARCIALMENTE_DISPONIVEL');
    expect(rb.lines.find((l: { description: string }) => l.description === 'Linho')).toMatchObject({
      transferredIn: 2,
      covered: 2,
    });
    // Origem continua com o que comprou (a sobra não reduz o que foi usado).
    expect((await readiness(admin, a.so.id)).state).toBe('COMPLETO');
    await expect(
      db().$executeRawUnsafe('DELETE FROM material_leftover_transfers'),
    ).rejects.toThrow();
  });
});

describe('Prontidão, integridade com a Fase 3 e permissões', () => {
  it('evolui só com registros reais, sem liberar produção; aprovação comprada não é reaberta', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Prontidão');
    expect((await readiness(admin, so.id)).state).toBe('SEM_LEVANTAMENTO');
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'ROTINA',
        assigneeUserId: await gestorUserId(),
        dueDate: nextFriday(),
      })
    ).body;
    expect((await readiness(admin, so.id)).state).toBe('AGUARDANDO_APROVACAO');
    const sub = await fillAndSubmit(admin, m, { items: [linen(so.items[0].id)] });
    expect((await readiness(admin, so.id)).state).toBe('AGUARDANDO_APROVACAO');
    const appr = await admin.post(
      `/api/v1/measurements/${m.id}/request/approve`,
      { version: sub.body.request.version },
      { 'idempotency-key': idemKey() },
    );
    expect((await readiness(admin, so.id)).state).toBe('AGUARDANDO_COMPRA');
    const stored = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    expect(stored.materialsReadiness).toBe('AGUARDANDO_COMPRA');

    const req = await db().materialRequirement.findFirstOrThrow({
      where: { serviceOrderId: so.id },
    });
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, req);
    // Depois de comprar, a aprovação não pode ser reaberta (as compras perderiam a origem).
    const reopen = await admin.post(`/api/v1/measurements/${m.id}/request/reopen`, {
      reason: 'Revisar',
      version: appr.body.request.version,
    });
    expect(reopen.status).toBe(422);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    expect(os.readiness).toMatchObject({ materials: 'OK', canStartProduction: false });
    // Não há rota de início de produção, e nada foi criado além do material.
    const routes = app.app.printRoutes();
    expect(routes).not.toMatch(/produc|production|start-production/i);
    const changes = await db().domainEvent.findMany({
      where: { type: 'material.readiness_changed', aggregateId: so.id },
      orderBy: { seq: 'asc' },
    });
    expect(changes.map((e) => (e.payload as { to: string }).to)).toEqual([
      'AGUARDANDO_APROVACAO',
      'AGUARDANDO_COMPRA',
      'AGUARDANDO_RECEBIMENTO',
      'COMPLETO',
    ]);
    // A OS não teve datas alteradas.
    const after = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    expect(after.promisedDate).toEqual(stored.promisedDate);
  });

  it('permissões: funcionário recebe sem ver preços; compras e estoque por permissão', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Perm', (s) => [linen(s.items[0].id)]);
    const supplier = await createSupplier(admin);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '482915',
    });

    const buyer = await panelUserWith(app, admin, 'comprador', [
      'compras.ver',
      'compras.gerenciar',
    ]);
    const draft = await createPurchase(buyer, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
          quantity: 12,
          unitPriceCents: 4500,
        },
      ],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.can).toMatchObject({ edit: true, confirm: false });
    expect((await confirmPurchase(buyer, draft.body)).status).toBe(403);
    expect((await confirmPurchase(tablet, draft.body)).status).toBe(403);
    const confirmed = (await confirmPurchase(admin, draft.body)).body;

    const viewer = await panelUserWith(app, admin, 'consulta', ['estoque.ver']);
    expect((await viewer.get('/api/v1/purchase-orders')).status).toBe(403);
    expect((await viewer.get('/api/v1/stock-items')).status).toBe(200);
    expect(
      (
        await viewer.post('/api/v1/stock-items', {
          kind: 'OUTRO',
          description: 'Cola',
          unit: 'EMBALAGEM',
        })
      ).status,
    ).toBe(403);
    expect((await tablet.get('/api/v1/suppliers')).status).toBe(403);
    expect((await tablet.get('/api/v1/purchase-orders')).status).toBe(403);
    expect(
      (
        await tablet.post(
          '/api/v1/purchase-orders',
          { items: [] },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);

    const pending = await tablet.get('/api/v1/material-receipts/pending');
    expect(pending.status).toBe(200);
    expect(pending.body[0]).toMatchObject({
      code: confirmed.code,
      items: [{ remaining: 12, description: 'Linho' }],
    });
    expect(JSON.stringify(pending.body)).not.toMatch(/Price|Cents|total/i);
    const rec = await receive(tablet, confirmed.id, [ok(confirmed.items[0].id, 12)]);
    expect(rec.status).toBe(201);
    expect(JSON.stringify(rec.body)).not.toMatch(/Price|Cents/i);
    expect(rec.body.receivedBy).toBe('Ricardo');
    expect((await db().materialReceipt.findFirstOrThrow()).deviceId).not.toBeNull();
    // Comprador sem `compras.ver`... vê preços somente com a permissão.
    const noPrices = await panelUserWith(app, admin, 'estoque2', [
      'estoque.ver',
      'estoque.autorizar',
    ]);
    const r = await noPrices.get(
      `/api/v1/service-orders/${confirmed.serviceOrders[0].id}/material-readiness`,
    );
    expect(r.status).toBe(200);
    expect(r.body.purchaseOrders[0].totalCents).toBeNull();
  });
});
