import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, markArrived } from './commercial-helpers';

/**
 * Semana da produção (Gerente, 2026-11-25): a OS com material comprado ganha a proposta de
 * início e tapeceiro de cada peça; aprovar planeja em rascunho; no nível 4 o Gerente faz sozinho.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));
const round = async (c: Client) => ok(await send(c, 'POST', '/api/v1/office/round', {}));

async function serviceOrder(admin: Client, materialPurchased: boolean) {
  const customer = await createCustomer(admin, { name: 'Cliente Semana', phone: null });
  const order = await createOrder(admin, customer, [
    { pieceType: 'SOFA', description: 'Sofá', quantity: 1 },
  ]);
  const rec = await markArrived(
    order.id,
    order.items.map((i: { id: string }) => ({ orderItemId: i.id, quantity: 1 })),
  );
  expect(rec.status).toBe(201);
  return ok<{ id: string; items: { id: string }[] }>(
    await send(admin, 'POST', '/api/v1/service-orders', {
      materialPurchased,
      orderId: order.id,
      items: order.items.map((i: { id: string }) => ({
        orderItemId: i.id,
        quantity: 1,
        description: 'Sofá',
        serviceType: 'REFORMA_COMPLETA',
      })),
    }),
    201,
  );
}

async function withManager(materialPurchased = true) {
  const admin = await loginAdmin(app);
  const so = await serviceOrder(admin, materialPurchased);
  ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'GERENTE' }), 201);
  return { admin, so };
}

describe('Semana da produção', () => {
  it('propõe o início e o tapeceiro; aprovar planeja a OS em rascunho', async () => {
    const { admin, so } = await withManager();
    await round(admin);
    const p = (await overview(admin)).pending.find((x) => x.task === 'PLANEJAR_OS')!;
    expect(p, JSON.stringify((await overview(admin)).pending.map((x) => x.title))).toBeTruthy();
    expect(p.title).toMatch(/^Encaixar OS-\S+ na semana \(começa \d{2}\/\d{2}\)$/);
    expect(p.detail).toMatch(/Quem fica com cada peça/);
    const entry = p.payload.entry as { pieces: { serviceOrderItemId: string }[] };
    expect(entry.pieces.map((x) => x.serviceOrderItemId)).toEqual([so.items[0]!.id]);

    const d = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    expect(d.payload.planId).toBeTruthy();
    expect(d.payload.tasksCreated).toBeGreaterThan(0);
    const tasks = await db().productionTask.findMany({ where: { serviceOrderId: so.id } });
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.status === 'RASCUNHO')).toBe(true);
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: so.items[0]!.id } });
    expect(item.upholstererUserId).toBeTruthy();
  });

  it('material não comprado: avisa o motivo e continua pedindo', async () => {
    const { admin } = await withManager(false);
    await round(admin);
    const p = (await overview(admin)).pending.find((x) => x.task === 'PLANEJAR_OS')!;
    expect(p.payload.planProblem).toMatch(/material ainda não foi comprado/);
    expect(p.payload.entry).toBeUndefined();
  });

  it('nível 4: o Gerente encaixa sozinho e fica registrado', async () => {
    const { admin, so } = await withManager();
    const g = (await overview(admin)).agents.find((a) => a.roleKey === 'GERENTE')!;
    ok(
      await send(admin, 'PUT', '/api/v1/office/tasks', {
        agentId: g.agentId,
        task: 'PLANEJAR_OS',
        setting: { nivel: 4 },
      }),
    );
    const r = await round(admin);
    expect(r.doneAlone).toBeGreaterThan(0);
    expect(await db().productionTask.count({ where: { serviceOrderId: so.id } })).toBeGreaterThan(
      0,
    );
    expect((await overview(admin)).pending.filter((x) => x.task === 'PLANEJAR_OS')).toHaveLength(0);
  });
});
