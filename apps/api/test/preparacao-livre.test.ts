import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabaseWithMaterialsGate } from './helpers';
import { createCustomer, createOrder, markArrived } from './commercial-helpers';
import { act, addOs, createPlan, day, publish, tabletOf, userIdOf } from './production-helpers';

/**
 * 2026-11-19 (pedido do Raphael): o dono escolhe só o tapeceiro titular. A preparação/desmontagem
 * fica livre: aparece no tablet de quem tem a competência e está disponível; o primeiro que toca
 * em Iniciar fica com ela (só ele inicia, pausa e termina) e ela some do tablet dos outros.
 * Equipe do seed: Ricardo e Márcio (tapeceiros), João (ajudante), Thiago (cabeceiras/qualidade,
 * também com as competências de ajudante).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabaseWithMaterialsGate();
});

type Task = {
  id: string;
  activity: string;
  status: string;
  assignee: { userId: string } | null;
};
type Mine = { free: Task[]; today: Task[] };
const post = (c: Client, url: string, body: unknown) =>
  c.post(url, body, { 'idempotency-key': idemKey() });
const mine = async (c: Client) => (await c.get('/api/v1/production-tasks/mine')).body as Mine;

/** Sofá em reforma, titular Ricardo, semana publicada: a desmontagem já está liberada e livre. */
async function scenario() {
  const admin = await loginAdmin(app);
  const ricardo = await userIdOf('Ricardo');
  const customer = await createCustomer(admin, {
    name: 'Cliente Livre',
    phone: null,
    allowSimilar: true,
  });
  const order = await createOrder(admin, customer, [
    { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
  ]);
  expect(
    (
      await markArrived(
        order.id,
        order.items.map((i: { id: string }) => ({ orderItemId: i.id, quantity: 1 })),
      )
    ).status,
  ).toBe(201);
  const so = await post(admin, '/api/v1/service-orders', {
    materialPurchased: true,
    orderId: order.id,
    items: order.items.map((i: { id: string }) => ({
      orderItemId: i.id,
      quantity: 1,
      description: 'Sofá 3 lugares',
      serviceType: 'REFORMA_COMPLETA',
    })),
  });
  expect(so.status).toBe(201);
  const plan = await createPlan(admin, day(-1), 'FILA_SEMANAL');
  expect(
    (
      await addOs(admin, plan.id, {
        serviceOrderId: so.body.id,
        pieces: [{ serviceOrderItemId: so.body.items[0].id, upholstererUserId: ricardo }],
      })
    ).status,
  ).toBe(201);
  const pub = await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  const desm = (pub.tasks as Task[]).find((t) => t.activity === 'DESMONTAGEM')!;
  expect(desm.assignee).toBeNull();
  expect(desm.status).toBe('LIBERADA');
  return {
    admin,
    desm,
    joao: await tabletOf(app, admin, 'João', '271828'),
    thiago: await tabletOf(app, admin, 'Thiago', '314159'),
    ricardo: await tabletOf(app, admin, 'Ricardo', '482915'),
  };
}

describe('Preparação livre para os ajudantes', () => {
  it('aparece para quem tem a competência; o primeiro que inicia fica com ela e some dos outros', async () => {
    const { admin, desm, joao, thiago, ricardo } = await scenario();
    // Aparece para os dois ajudantes disponíveis; não para o tapeceiro (sem a competência).
    expect((await mine(joao)).free.map((t) => t.id)).toEqual([desm.id]);
    expect((await mine(thiago)).free.map((t) => t.id)).toEqual([desm.id]);
    expect((await mine(ricardo)).free).toEqual([]);
    // Os dois podem abrir a ficha e iniciar.
    const detail = await joao.get(`/api/v1/production-tasks/${desm.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.can.start).toBe(true);
    expect((await ricardo.get(`/api/v1/production-tasks/${desm.id}`)).status).toBe(403);

    // Tocam em Iniciar ao mesmo tempo: só um fica com a tarefa.
    const [a, b] = await Promise.all([act(joao, desm.id, 'start'), act(thiago, desm.id, 'start')]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const loser = a.status === 200 ? b : a;
    const winnerId = await userIdOf(a.status === 200 ? 'João' : 'Thiago');
    const [winner, other] = a.status === 200 ? [joao, thiago] : [thiago, joao];
    expect(loser.body.error.message).toMatch(/já pegou esta tarefa/);
    const saved = await db().productionTask.findUniqueOrThrow({ where: { id: desm.id } });
    expect(saved.assigneeUserId).toBe(winnerId);
    expect(saved.status).toBe('EM_EXECUCAO');

    // Some do tablet do outro; ele não consegue mais abrir nem mexer.
    expect((await mine(other)).free).toEqual([]);
    const blocked = await other.get(`/api/v1/production-tasks/${desm.id}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/já pegou esta tarefa/);
    expect((await act(other, desm.id, 'complete')).status).toBe(403);

    // Só quem pegou termina; fica registrado quem fez (estatística).
    expect((await act(winner, desm.id, 'complete')).status).toBe(200);
    const done = await db().productionTask.findUniqueOrThrow({ where: { id: desm.id } });
    expect(done.completedById).toBe(winnerId);
    const started = await db().productionTaskEvent.findFirstOrThrow({
      where: { taskId: desm.id, kind: 'INICIADA' },
    });
    expect(started.actorId).toBe(winnerId);
    expect(started.note).toBe('Pegou a tarefa livre');
    // O painel mostra quem fez.
    const plan = (await admin.get(`/api/v1/production-tasks/${desm.id}`)).body as Task;
    expect(plan.assignee?.userId).toBe(winnerId);
  });

  it('quem já está com uma tarefa em andamento não vê nem pega a tarefa livre', async () => {
    const { desm, joao, thiago } = await scenario();
    // Thiago está ocupado com outra tarefa em execução.
    const busy = await db().productionTask.findFirstOrThrow({
      where: {
        serviceOrderId: (await db().productionTask.findUniqueOrThrow({ where: { id: desm.id } }))
          .serviceOrderId,
        activity: 'CORTE_TECIDO',
      },
    });
    await db().productionTask.update({
      where: { id: busy.id },
      data: { assigneeUserId: null, stepClass: 'OUTRA' },
    });
    await db().productionTask.update({
      where: { id: busy.id },
      data: {
        assigneeUserId: await userIdOf('Thiago'),
        status: 'EM_EXECUCAO',
        startedAt: new Date(),
      },
    });
    expect((await mine(thiago)).free).toEqual([]);
    const r = await act(thiago, desm.id, 'start');
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/em andamento/);
    // João, livre, continua vendo e pega normalmente.
    expect((await mine(joao)).free.map((t) => t.id)).toEqual([desm.id]);
    expect((await act(joao, desm.id, 'start')).status).toBe(200);
  });
});
