import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { ActorContext } from '../src/core/types';
import { reevaluateTasks, waitingTaskIds } from '../src/modules/production/common';
import { registerReceipt } from '../src/modules/receipts/service';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, receiptBody } from './commercial-helpers';
import { today, userIdOf } from './production-helpers';

/**
 * Simplificação Fase 3 — requisito original CA3-10 (plano da Fase 1): "tarefas reavaliadas após a
 * chegada". O evento é o registro do recebimento (`registerReceipt`, usado pela confirmação no
 * tablet e pelo recebimento no painel). Com a OS gerada na chegada (D1), a tarefa só pode estar
 * esperando a peça quando a OS é anterior à chegada — dado legado, reproduzido aqui ajustando a
 * quantidade recebida no banco (a API atual não permite criar essa situação).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDatabase());

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });

/**
 * Pedido antigo (OS manual) com 2 sofás iguais: 1 recebido, OS desse 1, planejado e publicado.
 * Depois, o "legado": a quantidade recebida volta a 0 (OS registrada antes da chegada) e as
 * tarefas são reavaliadas → ficam bloqueadas por "peça não recebida".
 */
async function legacyOsWaitingForPiece(admin: Client) {
  const customer = await createCustomer(admin, {
    name: 'Cliente Legado',
    phone: null,
    allowSimilar: true,
  });
  const order = await createOrder(admin, customer, [
    { pieceType: 'SOFA', description: 'Sofá', quantity: 2 },
  ]);
  const item = order.items[0] as { id: string };
  const first = await post(
    admin,
    '/api/v1/receipts',
    receiptBody(order.id, [{ orderItemId: item.id, quantity: 1 }]),
  );
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const so = await post(admin, '/api/v1/service-orders', {
    orderId: order.id,
    items: [
      { orderItemId: item.id, quantity: 1, description: 'Sofá', serviceType: 'REFORMA_COMPLETA' },
    ],
  });
  expect(so.status, JSON.stringify(so.body)).toBe(201);
  const soItem = (so.body.items as { id: string }[])[0]!;
  const planned = await post(admin, '/api/v1/production/plan-services', {
    entries: [
      {
        serviceOrderId: so.body.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: soItem.id, upholstererUserId: await userIdOf('Ricardo') }],
      },
    ],
  });
  expect(planned.status, JSON.stringify(planned.body)).toBe(201);
  const planId = planned.body.planned[0].planId as string;
  const plan = (await admin.get(`/api/v1/production-plans/${planId}`)).body as { version: number };
  expect(
    (await post(admin, `/api/v1/production-plans/${planId}/publish`, { version: plan.version }))
      .status,
  ).toBe(200);
  // Situação legada: OS existente, peça ainda não recebida.
  await db().commercialOrderItem.update({ where: { id: item.id }, data: { receivedQuantity: 0 } });
  await db().$transaction(async (tx) =>
    reevaluateTasks(tx, SYSTEM, await waitingTaskIds(tx, { serviceOrderId: so.body.id })),
  );
  const tasks = await tasksOf(so.body.id);
  expect(tasks.length).toBeGreaterThan(0);
  expect(
    tasks.every((t) => t.status === 'BLOQUEADA' && t.blockers.includes('PECA_NAO_RECEBIDA')),
  ).toBe(true);
  return { orderId: order.id as string, itemId: item.id, soId: so.body.id as string };
}

const tasksOf = (soId: string) =>
  db().productionTask.findMany({
    where: { serviceOrderId: soId, status: { not: 'CANCELADA' } },
    orderBy: { sequence: 'asc' },
  });
const releaseEvents = (soId: string) =>
  db().productionTaskEvent.count({ where: { task: { serviceOrderId: soId }, kind: 'LIBERADA' } });

describe('Reavaliação das tarefas após a chegada (Fase 3, CA3-10 do plano)', () => {
  it('cenário normal: o recebimento libera a tarefa que esperava a peça, na mesma transação', async () => {
    const admin = await loginAdmin(app);
    const { orderId, itemId, soId } = await legacyOsWaitingForPiece(admin);
    const eventsBefore = await releaseEvents(soId);
    const r = await post(
      admin,
      '/api/v1/receipts',
      receiptBody(orderId, [{ orderItemId: itemId, quantity: 1 }]),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const tasks = await tasksOf(soId);
    // A primeira etapa fica liberada; as demais seguem bloqueadas SÓ pelas dependências.
    expect(tasks[0]).toMatchObject({ status: 'LIBERADA', blockers: [] });
    for (const t of tasks.slice(1)) {
      expect(t.status).toBe('BLOQUEADA');
      expect(t.blockers).not.toContain('PECA_NAO_RECEBIDA');
    }
    expect(tasks.every((t) => !t.startedAt)).toBe(true); // nada começa sozinho
    expect(await releaseEvents(soId)).toBe(eventsBefore + 1);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'receipt.registered', entityId: r.body.id },
    });
    expect((log.changes as { taskStatusChanges?: number }).taskStatusChanges).toBe(1); // só a 1ª etapa mudou de situação
  });

  it('repetição: mesma chave devolve o mesmo resultado; outro recebimento não gera transição nova', async () => {
    const admin = await loginAdmin(app);
    const { orderId, itemId, soId } = await legacyOsWaitingForPiece(admin);
    const key = idemKey();
    const body = receiptBody(orderId, [{ orderItemId: itemId, quantity: 1 }]);
    const a = await post(admin, '/api/v1/receipts', body, key);
    const b = await post(admin, '/api/v1/receipts', body, key);
    expect(a.status).toBe(201);
    expect(b.body).toEqual(a.body);
    const snapshot = (await tasksOf(soId)).map((t) => [t.id, t.status, t.version]);
    const events = await releaseEvents(soId);
    // Segundo sofá chega depois: as tarefas já estão na situação certa → nada muda.
    const c = await post(admin, '/api/v1/receipts', body);
    expect(c.status).toBe(201);
    expect((await tasksOf(soId)).map((t) => [t.id, t.status, t.version])).toEqual(snapshot);
    expect(await releaseEvents(soId)).toBe(events);
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'receipt.registered', entityId: c.body.id },
    });
    expect((log.changes as { taskStatusChanges?: number }).taskStatusChanges).toBeUndefined();
  });

  it('falha intermediária: se a transação do recebimento falha depois da reavaliação, nada muda', async () => {
    const admin = await loginAdmin(app);
    const { orderId, itemId, soId } = await legacyOsWaitingForPiece(admin);
    const before = (await tasksOf(soId)).map((t) => [t.id, t.status, t.version, t.blockers]);
    const receipts = await db().receipt.count();
    await expect(
      db().$transaction(async (tx) => {
        await registerReceipt(tx, SYSTEM, { employeeId: null, deviceId: null }, {
          orderId,
          pickupId: null,
          origin: 'ENTREGUE_PELO_CLIENTE',
          divergences: null,
          notes: null,
          receivedByEmployeeId: null,
          lines: [
            {
              orderItemId: itemId,
              quantity: 1,
              condition: 'BOA',
              conditionNotes: null,
              location: 'Área',
            },
          ],
        } as never);
        // A reavaliação já aconteceu dentro da transação…
        expect(
          (await tx.productionTask.findMany({ where: { serviceOrderId: soId } })).some(
            (t) => t.status === 'LIBERADA',
          ),
        ).toBe(true);
        throw new Error('falha simulada depois do recebimento');
      }),
    ).rejects.toThrow(/falha simulada/);
    // …e foi desfeita junto com o recebimento.
    expect((await tasksOf(soId)).map((t) => [t.id, t.status, t.version, t.blockers])).toEqual(
      before,
    );
    expect(await db().receipt.count()).toBe(receipts);
    expect(
      (await db().commercialOrderItem.findUniqueOrThrow({ where: { id: itemId } }))
        .receivedQuantity,
    ).toBe(0);
  });

  it('concorrência: dois recebimentos simultâneos liberam a tarefa uma única vez', async () => {
    const admin = await loginAdmin(app);
    const { orderId, itemId, soId } = await legacyOsWaitingForPiece(admin);
    const eventsBefore = await releaseEvents(soId);
    const body = receiptBody(orderId, [{ orderItemId: itemId, quantity: 1 }]);
    const [a, b] = await Promise.all([
      post(admin, '/api/v1/receipts', body),
      post(admin, '/api/v1/receipts', body),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]); // dois sofás, dois recebimentos legítimos
    expect(
      (await db().commercialOrderItem.findUniqueOrThrow({ where: { id: itemId } }))
        .receivedQuantity,
    ).toBe(2);
    const tasks = await tasksOf(soId);
    expect(tasks[0]!.status).toBe('LIBERADA');
    expect(await releaseEvents(soId)).toBe(eventsBefore + 1);
    // Exatamente um dos dois registros reavaliou tarefas.
    const logs = await db().auditLog.findMany({
      where: { action: 'receipt.registered', entityId: { in: [a.body.id, b.body.id] } },
    });
    expect(
      logs.filter((l) => (l.changes as { taskStatusChanges?: number }).taskStatusChanges).length,
    ).toBe(1);
  });
});
