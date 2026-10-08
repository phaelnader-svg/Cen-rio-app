import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createCustomer, createOrder, createPickup, panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

describe('Pedido comercial', () => {
  it('cria pedido com peças, endereço copiado e número sequencial', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    expect(order.code).toMatch(/^PC-\d{5}$/);
    expect(order.status).toBe('AGUARDANDO_RETIRADA');
    expect(order.items.map((i: { quantity: number }) => i.quantity)).toEqual([1, 6]);
    expect(order.totalPieces).toBe(7);
    expect(order.agreedValueCents).toBe(350000);
    expect(order.pickupAddress.street).toBe('Rua Exemplo de Teste');

    // Alterar o endereço do cliente não muda o que foi combinado no pedido.
    await admin.put(`/api/v1/customers/${customer.id}/addresses/${customer.addresses[0].id}`, {
      label: 'Residência',
      street: 'Rua Nova',
      number: '1',
      city: 'Cidade Teste',
      state: 'SP',
    });
    expect((await admin.get(`/api/v1/orders/${order.id}`)).body.pickupAddress.street).toBe(
      'Rua Exemplo de Teste',
    );

    const second = await createOrder(admin, customer);
    expect(second.number).toBe(order.number + 1);
    const list = await admin.get('/api/v1/orders?q=' + order.code);
    expect(list.body.items.map((o: { id: string }) => o.id)).toEqual([order.id]);
  });

  it('valores negociados exigem permissão específica', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    const semValores = await panelUserWith(app, admin, 'atendente', [
      'pedidos.ver',
      'pedidos.gerenciar',
    ]);

    const view = await semValores.get(`/api/v1/orders/${order.id}`);
    expect(view.body.agreedValueCents).toBeNull();
    expect(view.body.paymentTerms).toBeNull();
    expect(view.body.valuesVisible).toBe(false);

    const create = await semValores.post(
      '/api/v1/orders',
      {
        customerId: customer.id,
        contractedService: 'Reparo',
        agreedValueCents: 100,
        items: [{ pieceType: 'PUFE', description: 'Pufe', quantity: 1 }],
      },
      { 'idempotency-key': idemKey() },
    );
    expect(create.status).toBe(403);

    // Edita sem ver valores: os valores existentes são preservados.
    const edit = await semValores.put(`/api/v1/orders/${order.id}`, {
      contractedService: 'Reforma completa (revisado)',
      agreedValueCents: null,
      paymentTerms: null,
      items: view.body.items.map((i: Record<string, unknown>) => ({
        id: i.id,
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
      })),
      version: view.body.version,
    });
    expect(edit.status).toBe(200);
    const row = await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.agreedValueCents).toBe(350000);
    expect(row.contractedService).toBe('Reforma completa (revisado)');

    // Sem permissão de cancelar.
    expect(
      (
        await semValores.post(`/api/v1/orders/${order.id}/cancel`, {
          reason: 'teste',
          version: row.version,
        })
      ).status,
    ).toBe(403);
  });

  it('cancelamento registra motivo e cancela retiradas ativas', async () => {
    const admin = await loginAdmin(app);
    const order = await createOrder(admin, await createCustomer(admin));
    const pickup = await createPickup(admin, order);
    const current = (await admin.get(`/api/v1/orders/${order.id}`)).body;
    const r = await admin.post(`/api/v1/orders/${order.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: current.version,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELADO');
    const p = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
    expect(p.status).toBe('CANCELADA');
    expect(p.events.at(-1).note).toContain('Cliente desistiu');
  });
});

describe('Solicitação de retirada', () => {
  it('solicita, agenda, executa e registra ocorrências com linha do tempo', async () => {
    const admin = await loginAdmin(app);
    const order = await createOrder(admin, await createCustomer(admin));
    const pickup = await createPickup(admin, order, null);
    expect(pickup.code).toMatch(/^RT-\d{5}$/);
    expect(pickup.status).toBe('AGUARDANDO_AGENDAMENTO');
    expect(pickup.customer.phone).toBe('11900000001');

    // Agendar pela edição
    const scheduled = await admin.put(`/api/v1/pickups/${pickup.id}`, {
      scheduledDate: '2026-10-16',
      windowStart: '14:00',
      windowEnd: '17:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      instructions: 'Interfone 12',
      items: pickup.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
      version: pickup.version,
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.status).toBe('AGENDADA');
    expect((await admin.get(`/api/v1/orders/${order.id}`)).body.status).toBe('RETIRADA_AGENDADA');

    const t = (to: string, version: number, note?: string) =>
      admin.post(`/api/v1/pickups/${pickup.id}/transition`, { toStatus: to, version, note });
    const occ = await t('COM_OCORRENCIA', scheduled.body.version);
    expect(occ.status).toBe(400); // ocorrência exige descrição
    const occ2 = await t('COM_OCORRENCIA', scheduled.body.version, 'Cliente ausente');
    expect(occ2.body.status).toBe('COM_OCORRENCIA');
    const exec = await t('EM_EXECUCAO', occ2.body.version);
    const done = await t('RETIRADA_REALIZADA', exec.body.version);
    expect(done.body.status).toBe('RETIRADA_REALIZADA');
    // "Recebida na oficina" só pelo recebimento físico.
    const manual = await t('RECEBIDA_NA_OFICINA', done.body.version);
    expect(manual.status).toBe(422);
    const invalid = await t('AGUARDANDO_AGENDAMENTO', done.body.version);
    expect(invalid.status).toBe(422);
    expect(done.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'SOLICITADA',
      'AGENDADA',
      'COM_OCORRENCIA',
      'EM_EXECUCAO',
      'RETIRADA_REALIZADA',
    ]);
  });

  it('não permite retirar mais peças do que o pedido tem disponível', async () => {
    const admin = await loginAdmin(app);
    const order = await createOrder(admin, await createCustomer(admin));
    await createPickup(admin, order);
    const again = await admin.post(
      '/api/v1/pickups',
      { orderId: order.id, items: [{ orderItemId: order.items[1].id, quantity: 1 }] },
      { 'idempotency-key': idemKey() },
    );
    expect(again.status).toBe(422);
  });

  it('agenda filtra retiradas por período', async () => {
    const admin = await loginAdmin(app);
    const c = await createCustomer(admin);
    await createPickup(admin, await createOrder(admin, c), '2026-10-12');
    await createPickup(admin, await createOrder(admin, c), '2026-10-20');
    const week = await admin.get('/api/v1/pickups?from=2026-10-12&to=2026-10-18');
    expect(week.body.map((p: { scheduledDate: string }) => p.scheduledDate)).toEqual([
      '2026-10-12',
    ]);
  });

  it('filtros com valores inválidos são rejeitados com 400 (não 500)', async () => {
    const admin = await loginAdmin(app);
    expect((await admin.get('/api/v1/orders?status=XYZ')).status).toBe(400);
    expect((await admin.get('/api/v1/pickups?status=AGENDADA,XYZ')).status).toBe(400);
    expect((await admin.get('/api/v1/service-orders?status=XYZ')).status).toBe(400);
    expect((await admin.get('/api/v1/pickups?from=2026-13-45')).status).toBe(400);
    expect((await admin.get('/api/v1/pickups?status=AGENDADA,EM_EXECUCAO')).status).toBe(200);
  });

  it('sem permissão de retiradas não há acesso à agenda', async () => {
    const admin = await loginAdmin(app);
    const u = await panelUserWith(app, admin, 'semretirada', ['pedidos.ver']);
    expect((await u.get('/api/v1/pickups')).status).toBe(403);
  });
});
