import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, panelUserWith, markArrived } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { userIdOf, today } from './production-helpers';
import { finish, post, prepareCompany, workshop } from './audit-helpers';

/**
 * Fase 12 — correção das pendências antigas:
 * A. reservas de OS parcialmente devolvidas; B. valores de produção de peças devolvidas;
 * C. devolução (inclusive de peças avulsas) com destino e histórico; D. situação comercial;
 * E. encerramento do saldo de compras parcialmente recebidas.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});

const orderItemOf = async (soItemId: string) =>
  (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: soItemId } })).orderItemId;
const orderOf = async (soId: string) =>
  (await db().serviceOrder.findUniqueOrThrow({ where: { id: soId } })).orderId;

/** Registra e confirma a devolução de peças de OS (inteiras) ou de quantidades avulsas. */
async function returnPieces(
  admin: Client,
  orderId: string,
  lines: { orderItemId: string; quantity: number; serviceOrderItemIds?: string[] }[],
  destination = 'Entregue no endereço do cliente',
) {
  const r = await post(admin, '/api/v1/returns', {
    orderId,
    reason: 'Cliente desistiu do serviço',
    returnDate: today(),
    destination,
    lines: lines.map((l) => ({ serviceOrderItemIds: [], ...l })),
  });
  if (r.status !== 201) throw new Error(`return: ${JSON.stringify(r.body)}`);
  const c = await post(admin, `/api/v1/returns/${r.body.id}/confirm`, {
    note: 'Cliente recebeu as peças',
    version: r.body.version,
  });
  if (c.status !== 200) throw new Error(`confirm: ${JSON.stringify(c.body)}`);
  return (await admin.get(`/api/v1/returns/${r.body.id}`)).body;
}

async function labor(admin: Client, body: Record<string, unknown>) {
  const r = await post(admin, '/api/v1/finance/labor', {
    service: 'Serviço combinado',
    agreedCents: 50000,
    eligibility: 'PRODUCAO_CONCLUIDA',
    ...body,
  });
  if (r.status !== 201) throw new Error(`labor: ${JSON.stringify(r.body)}`);
  return r.body as { id: string; code: string };
}

describe('B. Valores de produção de peças devolvidas', () => {
  it('peça devolvida sem execução: valor previsto cancelado com justificativa; outras peças intactas', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Sem Execução');
    const ricardo = await labor(admin, {
      professionalUserId: await userIdOf('Ricardo'),
      serviceOrderId: so.id,
      serviceOrderItemId: so.items[0].id,
    });
    const marcio = await labor(admin, {
      professionalUserId: await userIdOf('Márcio'),
      serviceOrderId: so.id,
      serviceOrderItemId: so.items[1].id,
    });
    await returnPieces(admin, await orderOf(so.id), [
      {
        orderItemId: await orderItemOf(so.items[1].id),
        quantity: 2,
        serviceOrderItemIds: [so.items[1].id],
      },
    ]);
    const m = await db().productionPayable.findUniqueOrThrow({ where: { id: marcio.id } });
    expect(m).toMatchObject({ status: 'CANCELADO', paidCents: 0, agreedCents: 50000 });
    expect(m.cancelReason).toMatch(/Sem execução/);
    expect(
      await db().financialEvent.count({
        where: { entityId: marcio.id, kind: 'CANCELADO_DEVOLUCAO' },
      }),
    ).toBe(1);
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: ricardo.id } })).status,
    ).toBe('PREVISTO');
  });

  it('peça devolvida com trabalho executado: nada apagado nem descontado; gestor avisado; valor devido continua devido', async () => {
    const s = await workshop(app, 'Cliente Executado');
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
    });
    await finish(s.tablets['João']!, s.prep.id);
    await finish(s.tablets['Márcio']!, s.poltronaTask.id);
    const before = (await s.admin.get(`/api/v1/finance/labor/${mo.id}`)).body;
    expect(before.status).toBe('LIBERADO');
    await returnPieces(s.admin, await orderOf(s.so.id), [
      {
        orderItemId: await orderItemOf(s.poltronas.id),
        quantity: 2,
        serviceOrderItemIds: [s.poltronas.id],
      },
    ]);
    const after = (await s.admin.get(`/api/v1/finance/labor/${mo.id}`)).body;
    // Continua liberado (a condição já tinha sido atingida) e marcado para revisão.
    expect(after).toMatchObject({
      status: 'LIBERADO',
      dueCents: 50000,
      paidCents: 0,
      withdrawn: true,
    });
    expect(after.history.map((h: { kind: string }) => h.kind)).toContain('REVISAO_DEVOLUCAO');
    const gestor = (await s.admin.get('/api/auth/me')).body.user.id as string;
    expect(
      await db().notification.count({ where: { userId: gestor, kind: 'REVISAO_DEVOLUCAO' } }),
    ).toBe(1);
    // Ajuste só com justificativa (e nunca automático).
    const adj = await post(s.admin, `/api/v1/finance/labor/${mo.id}/adjustments`, {
      amountCents: -20000,
      reason: 'Acordo: metade do serviço feito antes da desistência',
      version: after.version,
    });
    expect(adj.status).toBe(200);
    expect(adj.body.dueCents).toBe(30000);
  });

  it('devolução total cancela a OS: valores sem execução cancelados pelo mesmo critério', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Devolução Total');
    const whole = await labor(admin, {
      professionalUserId: await userIdOf('Ricardo'),
      serviceOrderId: so.id,
    });
    await returnPieces(admin, await orderOf(so.id), [
      {
        orderItemId: await orderItemOf(so.items[0].id),
        quantity: 1,
        serviceOrderItemIds: [so.items[0].id],
      },
      {
        orderItemId: await orderItemOf(so.items[1].id),
        quantity: 2,
        serviceOrderItemIds: [so.items[1].id],
      },
    ]);
    expect((await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).status).toBe(
      'CANCELADA',
    );
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: whole.id } })).status,
    ).toBe('CANCELADO');
  });
});

describe('C. Devolução pelo painel (inclusive peças avulsas) com destino e histórico', () => {
  it('peças recebidas fora de OS: devolução com destino, responsável e histórico consultável', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin, { name: 'Cliente Avulso' });
    const order = await createOrder(admin, customer);
    const rec = await markArrived(
      order.id,
      order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    );
    expect(rec.status).toBe(201);
    const chairs = order.items.find((i: { pieceType: string }) => i.pieceType === 'CADEIRA');
    const office = await panelUserWith(app, admin, 'so-pedidos', ['pedidos.ver']);
    const denied = await post(office, '/api/v1/returns', {
      orderId: order.id,
      reason: 'x',
      returnDate: today(),
      lines: [{ orderItemId: chairs.id, quantity: 2 }],
    });
    expect(denied.status).toBe(403);
    const ret = await returnPieces(
      admin,
      order.id,
      [{ orderItemId: chairs.id, quantity: 2 }],
      'Retirada pelo cliente na oficina',
    );
    expect(ret).toMatchObject({
      status: 'CONFIRMADA',
      destination: 'Retirada pelo cliente na oficina',
    });
    expect(ret.history.map((h: { action: string }) => h.action)).toEqual([
      'return.registered',
      'return.confirmed',
    ]);
    expect(
      (await db().commercialOrderItem.findUniqueOrThrow({ where: { id: chairs.id } }))
        .returnedQuantity,
    ).toBe(2);
    // Não dá para devolver mais do que foi recebido e não está em OS.
    const tooMany = await post(admin, '/api/v1/returns', {
      orderId: order.id,
      reason: 'Mais cadeiras',
      returnDate: today(),
      lines: [{ orderItemId: chairs.id, quantity: 5 }],
    });
    expect(tooMany.status).toBe(422);
  });
});

describe('D. Situação comercial de pedidos com devolução', () => {
  it('parcial, total, concluído e cancelado — sem alterar o valor negociado', async () => {
    const admin = await loginAdmin(app);
    const a = await openServiceOrder(admin, 'Cliente Parcial');
    const orderA = await orderOf(a.id);
    await returnPieces(admin, orderA, [
      {
        orderItemId: await orderItemOf(a.items[1].id),
        quantity: 2,
        serviceOrderItemIds: [a.items[1].id],
      },
    ]);
    let o = (await admin.get(`/api/v1/orders/${orderA}`)).body;
    expect(o).toMatchObject({
      serviceState: 'DEVOLUCAO_PARCIAL',
      returnedPieces: 2,
      agreedValueCents: 350000,
    });
    // A peça restante entregue → serviço concluído (a devolução continua registrada).
    await db().serviceOrderItem.update({
      where: { id: a.items[0].id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    o = (await admin.get(`/api/v1/orders/${orderA}`)).body;
    expect(o).toMatchObject({ serviceState: 'SERVICO_CONCLUIDO', returnedPieces: 2 });
    // Valor final só muda com ajuste explícito: aparece como aviso no financeiro.
    const fin = (await admin.get(`/api/v1/finance/orders/${orderA}`)).body;
    expect(fin.finalCents).toBe(350000);

    const b = await openServiceOrder(admin, 'Cliente Total');
    const orderB = await orderOf(b.id);
    await returnPieces(admin, orderB, [
      {
        orderItemId: await orderItemOf(b.items[0].id),
        quantity: 1,
        serviceOrderItemIds: [b.items[0].id],
      },
      {
        orderItemId: await orderItemOf(b.items[1].id),
        quantity: 2,
        serviceOrderItemIds: [b.items[1].id],
      },
    ]);
    expect((await admin.get(`/api/v1/orders/${orderB}`)).body.serviceState).toBe('DEVOLUCAO_TOTAL');

    const customer = await createCustomer(admin, { name: 'Cliente Cancelado' });
    const c = await createOrder(admin, customer);
    const cancel = await admin.post(
      `/api/v1/orders/${c.id}/cancel`,
      { reason: 'Cliente desistiu antes da retirada', version: c.version },
      { 'idempotency-key': idemKey() },
    );
    expect(cancel.status).toBe(200);
    const list = (await admin.get('/api/v1/orders?limit=50')).body.items as {
      id: string;
      serviceState: string;
    }[];
    expect(list.find((x) => x.id === c.id)!.serviceState).toBe('SERVICO_CANCELADO');
    expect(list.find((x) => x.id === orderB)!.serviceState).toBe('DEVOLUCAO_TOTAL');
  });
});
