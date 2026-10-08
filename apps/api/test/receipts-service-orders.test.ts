import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import {
  createCustomer,
  createOrder,
  createPickup,
  panelUserWith,
  receiptBody,
} from './commercial-helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

async function scenario() {
  const admin = await loginAdmin(app);
  const order = await createOrder(admin, await createCustomer(admin));
  const pickup = await createPickup(admin, order);
  return { admin, order, pickup, sofa: order.items[0], chairs: order.items[1] };
}

const osItem = (orderItemId: string, quantity: number, description = 'Peça') => ({
  orderItemId,
  quantity,
  description,
  serviceType: 'REFORMA_COMPLETA',
  fabricName: 'Linho',
  fabricColor: 'Areia',
  fabricReference: 'REF-TESTE-01',
  foamSpecs: 'D33',
});

describe('Recebimento físico', () => {
  it('recebimento completo pela retirada fecha a retirada e o pedido', async () => {
    const { admin, order, pickup, sofa, chairs } = await scenario();
    const r = await admin.post(
      '/api/v1/receipts',
      {
        ...receiptBody(
          order.id,
          [
            { orderItemId: sofa.id, quantity: 1 },
            { orderItemId: chairs.id, quantity: 6 },
          ],
          pickup.id,
        ),
        divergences: 'Uma cadeira com pé solto',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^RC-\d{5}$/);
    expect(r.body.receivedBy.displayName).toBe('Gestor Teste');
    expect((await admin.get(`/api/v1/orders/${order.id}`)).body.status).toBe('RECEBIDO');
    const p = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
    expect(p.status).toBe('RECEBIDA_NA_OFICINA');
    expect(p.events.at(-1).note).toContain(r.body.code);
    // Retirada já recebida não aceita novo recebimento.
    const again = await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }], pickup.id),
      { 'idempotency-key': idemKey() },
    );
    expect(again.status).toBe(409);
  });

  it('recebimentos parciais até completar o pedido; excesso é recusado', async () => {
    const { admin, order, chairs, sofa } = await scenario();
    const first = await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: chairs.id, quantity: 4 }]),
      { 'idempotency-key': idemKey() },
    );
    expect(first.status).toBe(201);
    let o = (await admin.get(`/api/v1/orders/${order.id}`)).body;
    expect(o.status).toBe('RECEBIDO_PARCIAL');
    expect(o.items[1].receivedQuantity).toBe(4);

    const tooMany = await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: chairs.id, quantity: 3 }]),
      { 'idempotency-key': idemKey() },
    );
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.details.pending).toBe(2);

    await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [
        { orderItemId: chairs.id, quantity: 2 },
        { orderItemId: sofa.id, quantity: 1 },
      ]),
      { 'idempotency-key': idemKey() },
    );
    o = (await admin.get(`/api/v1/orders/${order.id}`)).body;
    expect(o.status).toBe('RECEBIDO');
    expect((await admin.get(`/api/v1/receipts?orderId=${order.id}`)).body).toHaveLength(2);
  });

  it('duplicidade: reenvio com a mesma chave não duplica; registros simultâneos não ultrapassam o pedido', async () => {
    const { admin, order, chairs } = await scenario();
    const key = idemKey();
    const body = receiptBody(order.id, [{ orderItemId: chairs.id, quantity: 6 }]);
    const a = await admin.post('/api/v1/receipts', body, { 'idempotency-key': key });
    const b = await admin.post('/api/v1/receipts', body, { 'idempotency-key': key });
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await db().receipt.count()).toBe(1);

    // Duas pessoas registram ao mesmo tempo o mesmo sofá (chaves diferentes).
    const sofa = order.items[0];
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        admin.post(
          '/api/v1/receipts',
          receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
          {
            'idempotency-key': idemKey(),
          },
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const item = await db().commercialOrderItem.findUniqueOrThrow({ where: { id: sofa.id } });
    expect(item.receivedQuantity).toBe(1);
  });

  it('recebimentos são imutáveis no banco e validam data futura', async () => {
    const { admin, order, sofa } = await scenario();
    const future = await admin.post(
      '/api/v1/receipts',
      {
        ...receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
        receivedAt: '2099-01-01T10:00:00Z',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(future.status).toBe(400);
    const ok = await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
      {
        'idempotency-key': idemKey(),
      },
    );
    await expect(
      db().receipt.update({ where: { id: ok.body.id }, data: { notes: 'x' } }),
    ).rejects.toThrow(/somente inserção/);
  });

  it('funcionário autorizado registra recebimento pelo tablet, sem ver valores nem clientes', async () => {
    const { admin, order, chairs } = await scenario();
    const thiago = await db().employee.findFirstOrThrow({ where: { displayName: 'Thiago' } });
    const roleId = (await db().role.findUniqueOrThrow({ where: { key: 'cabeceiras_qualidade' } }))
      .id;
    const upd = await admin.put(`/api/employees/${thiago.id}`, {
      fullName: thiago.fullName,
      displayName: thiago.displayName,
      jobTitle: thiago.jobTitle,
      color: thiago.color,
      roleIds: [roleId],
      extraPermissions: ['recebimentos.registrar'],
      version: thiago.version,
    });
    expect(upd.status).toBe(200);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet Thiago',
      employee: 'Thiago',
      pin: '529174',
    });
    const pending = await tablet.get('/api/v1/receipts/pending');
    expect(pending.status).toBe(200);
    expect(JSON.stringify(pending.body)).not.toMatch(/agreedValue|paymentTerms|phone|document/);
    const r = await tablet.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: chairs.id, quantity: 2 }]),
      {
        'idempotency-key': idemKey(),
      },
    );
    expect(r.status).toBe(201);
    expect(r.body.receivedBy.displayName).toBe('Thiago');
    expect((await tablet.get(`/api/v1/orders/${order.id}`)).status).toBe(403);
    expect((await tablet.get('/api/v1/customers')).status).toBe(403);
  });
});

describe('Ordem de serviço técnica', () => {
  it('é bloqueada antes do recebimento físico', async () => {
    const { admin, order, sofa } = await scenario();
    const r = await admin.post(
      '/api/v1/service-orders',
      { orderId: order.id, items: [osItem(sofa.id, 1, 'Sofá 3 lugares')] },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('depois que a peça chegar');
    expect(await db().serviceOrder.count()).toBe(0);
  });

  it('após recebimento parcial, só as peças recebidas entram na OS; várias peças com identificação individual', async () => {
    const { admin, order, sofa, chairs } = await scenario();
    await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [
        { orderItemId: sofa.id, quantity: 1 },
        { orderItemId: chairs.id, quantity: 4 },
      ]),
      { 'idempotency-key': idemKey() },
    );
    const tooMany = await admin.post(
      '/api/v1/service-orders',
      { orderId: order.id, items: [osItem(chairs.id, 5)] },
      { 'idempotency-key': idemKey() },
    );
    expect(tooMany.status).toBe(422);

    const ricardo = await db().employee.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    const so = await admin.post(
      '/api/v1/service-orders',
      {
        orderId: order.id,
        priority: 'ALTA',
        promisedDate: '2026-11-20',
        technicalLeadId: ricardo.id,
        technicalInstructions: 'Manter costura dupla',
        items: [
          osItem(sofa.id, 1, 'Sofá 3 lugares'),
          osItem(chairs.id, 2, 'Cadeiras 1 e 2'),
          osItem(chairs.id, 2, 'Cadeiras 3 e 4'),
        ],
      },
      { 'idempotency-key': idemKey() },
    );
    expect(so.status).toBe(201);
    expect(so.body.code).toMatch(/^OS-\d{5}$/);
    expect(so.body.items.map((i: { code: string }) => i.code)).toEqual([
      `${so.body.code}/1`,
      `${so.body.code}/2`,
      `${so.body.code}/3`,
    ]);
    expect(so.body.technicalLead.displayName).toBe('Ricardo');
    expect(so.body.items[0].locations).toEqual(['Área de recebimento']);
    expect(so.body.readiness).toEqual({
      measurements: 'PENDENTE',
      technicalLead: 'OK',
      // Fase 4: prontidão de materiais calculada a partir dos registros (antes: FASE_FUTURA).
      materials: 'PENDENTE',
      materialsState: 'SEM_LEVANTAMENTO',
      scheduling: 'PENDENTE', // Fase 5: OK somente com tarefa em planejamento publicado.
      canStartProduction: false,
    });

    // As 4 cadeiras recebidas já estão em OS: nova OS para elas é recusada.
    const dup = await admin.post(
      '/api/v1/service-orders',
      { orderId: order.id, items: [osItem(chairs.id, 1)] },
      { 'idempotency-key': idemKey() },
    );
    expect(dup.status).toBe(422);
    const available = await admin.get(`/api/v1/service-orders/available?orderId=${order.id}`);
    expect(available.body.items.map((i: { available: number }) => i.available)).toEqual([0, 0]);
  });

  it('alterações técnicas, medições e materiais geram histórico numerado', async () => {
    const { admin, order, sofa } = await scenario();
    await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
      {
        'idempotency-key': idemKey(),
      },
    );
    let so = (
      await admin.post(
        '/api/v1/service-orders',
        { orderId: order.id, items: [osItem(sofa.id, 1, 'Sofá')] },
        { 'idempotency-key': idemKey() },
      )
    ).body;
    const item = so.items[0];
    const edit = await admin.put(`/api/v1/service-orders/${so.id}/items/${item.id}`, {
      serviceType: 'TROCA_DE_TECIDO',
      description: 'Sofá',
      fabricName: 'Veludo',
      fabricColor: 'Verde musgo',
      fabricReference: 'REF-TESTE-02',
      foamSpecs: 'D33',
      reason: 'Cliente trocou o tecido',
      version: item.version,
    });
    expect(edit.status).toBe(200);
    const stale = await admin.put(`/api/v1/service-orders/${so.id}/items/${item.id}`, {
      serviceType: 'REPARO',
      description: 'Sofá',
      version: item.version,
    });
    expect(stale.status).toBe(409);

    so = edit.body;
    const measured = await admin.put(
      `/api/v1/service-orders/${so.id}/items/${item.id}/measurements`,
      {
        measurements: [
          { label: 'Largura', valueCm: 210 },
          { label: 'Profundidade', valueCm: 95 },
        ],
        version: so.items[0].version,
      },
    );
    expect(measured.status).toBe(200);
    expect(measured.body.items[0].measurementKind).toMatch(/ROTINA|EXTRAORDINARIA/);
    expect(measured.body.readiness.measurements).toBe('OK');

    const fabricFromStock = await admin.post(`/api/v1/service-orders/${so.id}/materials`, {
      kind: 'TECIDO',
      description: 'Veludo verde',
      quantity: 8,
      unit: 'm',
      sourcing: 'ESTOQUE',
    });
    expect(fabricFromStock.status).toBe(400);
    const fabric = await admin.post(`/api/v1/service-orders/${so.id}/materials`, {
      kind: 'TECIDO',
      description: 'Veludo verde',
      quantity: 8,
      unit: 'm',
      sourcing: 'EXCLUSIVO_OS',
      serviceOrderItemId: item.id,
    });
    expect(fabric.status).toBe(201);
    // Material previsto não libera produção.
    expect(fabric.body.readiness.canStartProduction).toBe(false);

    const head = await admin.put(`/api/v1/service-orders/${so.id}`, {
      priority: 'URGENTE',
      promisedDate: '2026-11-30',
      technicalInstructions: 'Atenção ao acabamento',
      reason: 'Prazo combinado',
      version: fabric.body.version,
    });
    expect(head.status).toBe(200);

    const revisions = (await admin.get(`/api/v1/service-orders/${so.id}/revisions`)).body;
    expect(
      revisions.map((r: { revision: number; scope: string }) => [r.revision, r.scope]),
    ).toEqual([
      [5, 'OS'],
      [4, 'MATERIAL'],
      [3, 'MEDICAO'],
      [2, 'ITEM'],
      [1, 'CRIACAO'],
    ]);
    expect(revisions[3].changes.fabricName).toEqual({ from: 'Linho', to: 'Veludo' });
    expect(revisions[3].reason).toBe('Cliente trocou o tecido');
    expect(revisions[3].itemCode).toBe(`${so.code}/1`);
    await expect(
      db().serviceOrderRevision.deleteMany({ where: { serviceOrderId: so.id } }),
    ).rejects.toThrow(/somente inserção/);
  });

  it('cancelar a OS libera as peças para nova OS', async () => {
    const { admin, order, sofa } = await scenario();
    await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
      {
        'idempotency-key': idemKey(),
      },
    );
    const so = (
      await admin.post(
        '/api/v1/service-orders',
        { orderId: order.id, items: [osItem(sofa.id, 1)] },
        { 'idempotency-key': idemKey() },
      )
    ).body;
    const c = await admin.post(`/api/v1/service-orders/${so.id}/cancel`, {
      reason: 'Aberta por engano',
      version: so.version,
    });
    expect(c.body.status).toBe('CANCELADA');
    const again = await admin.post(
      '/api/v1/service-orders',
      { orderId: order.id, items: [osItem(sofa.id, 1)] },
      { 'idempotency-key': idemKey() },
    );
    expect(again.status).toBe(201);
  });

  it('criações simultâneas de OS para a mesma peça: apenas uma é aceita', async () => {
    const { admin, order, sofa } = await scenario();
    await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
      {
        'idempotency-key': idemKey(),
      },
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        admin.post(
          '/api/v1/service-orders',
          { orderId: order.id, items: [osItem(sofa.id, 1)] },
          { 'idempotency-key': idemKey() },
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
  });

  it('permissões: ver OS não permite alterar; medição direta só pelo gestor', async () => {
    const { admin, order, sofa } = await scenario();
    await admin.post(
      '/api/v1/receipts',
      receiptBody(order.id, [{ orderItemId: sofa.id, quantity: 1 }]),
      {
        'idempotency-key': idemKey(),
      },
    );
    const so = (
      await admin.post(
        '/api/v1/service-orders',
        { orderId: order.id, items: [osItem(sofa.id, 1)] },
        { 'idempotency-key': idemKey() },
      )
    ).body;
    const viewer = await panelUserWith(app, admin, 'tecnico', [
      'os.ver',
      'medicoes.extraordinarias',
    ]);
    expect((await viewer.get(`/api/v1/service-orders/${so.id}`)).status).toBe(200);
    expect(
      (
        await viewer.put(`/api/v1/service-orders/${so.id}`, {
          priority: 'BAIXA',
          version: so.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await viewer.post(
          '/api/v1/service-orders',
          { orderId: order.id, items: [osItem(sofa.id, 1)] },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);
    // Fase 3: o registro direto de medidas ficou exclusivo do gestor; tapeceiros
    // autorizados medem apenas pelas medições atribuídas (ver measurements.test.ts).
    const direct = await viewer.put(
      `/api/v1/service-orders/${so.id}/items/${so.items[0].id}/measurements`,
      { measurements: [{ label: 'Altura', valueCm: 80 }], version: so.items[0].version },
    );
    expect(direct.status).toBe(403);
    const m = await viewer.get(`/api/v1/service-orders/${so.id}`);
    expect(Object.keys(m.body.customer).sort()).toEqual(['id', 'kind', 'name', 'tradeName']);
  });
});
