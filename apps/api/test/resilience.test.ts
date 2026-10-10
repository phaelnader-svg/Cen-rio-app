import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { act, addOs, createPlan, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 8 — resiliência a REINÍCIO da API (deploy, queda do processo): nada do que o
 * tablet precisa vive só em memória. Sessão, estado da tarefa, chave de idempotência e o feed de
 * eventos estão no PostgreSQL; após o reinício o tablet continua sem novo login, a repetição da
 * mesma requisição devolve a mesma resposta e a reconexão recupera o que perdeu.
 */
const apps: App[] = [];
const sockets: WsClient[] = [];
async function start() {
  const a = await createTestApp();
  await a.startBackground();
  await a.app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(a);
  return a;
}
beforeAll(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await Promise.all(sockets.map((s) => s.close()));
  for (const a of apps) await a.close().catch(() => undefined);
});

describe('Reinício da API (Fase 8)', () => {
  it('sessão do tablet, tarefa em execução, idempotência e eventos sobrevivem ao reinício', async () => {
    const app1 = await start();
    const admin = await loginAdmin(app1);
    const joao = await userIdOf('João');
    const so = await openServiceOrder(admin, 'Cliente Reinício');
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: so.id,
          principalUserId: await userIdOf('Ricardo'),
          generate: false,
        })
      ).status,
    ).toBe(201);
    for (const title of ['Separar grampos', 'Limpar bancada'])
      expect(
        (
          await admin.post(
            `/api/v1/production-plans/${plan.id}/tasks`,
            { serviceOrderId: so.id, activity: 'OUTRA', title, assigneeUserId: joao },
            { 'idempotency-key': idemKey() },
          )
        ).status,
      ).toBe(201);
    await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    const tablet = await tabletOf(app1, admin, 'João', '271828');
    const ws1 = await WsClient.connect(app1, tablet);
    sockets.push(ws1);
    const q = (await tablet.get('/api/v1/production-tasks/mine/queue')).body;
    const first = q.next.id as string;
    const key = idemKey();
    const started = await act(tablet, first, 'start', {}, key);
    expect(started.status).toBe(200);
    const ev = await ws1.waitFor((m) => m.event?.type === 'production.task_started');
    const lastSeq = ev.event.seq as string;
    await ws1.close();

    // Queda/reinício do processo.
    await app1.close();
    const app2 = await start();
    const t2 = new Client(app2);
    t2.cookies = new Map(tablet.cookies);
    const a2 = new Client(app2);
    a2.cookies = new Map(admin.cookies);

    // Sessão do tablet válida, sem novo login; estado preservado.
    const q2 = (await t2.get('/api/v1/production-tasks/mine/queue')).body;
    expect(q2.current.id).toBe(first);
    // Repetir a MESMA requisição (ex.: reenvio após a queda) devolve a mesma resposta.
    const again = await act(t2, first, 'start', {}, key);
    expect(again.status).toBe(started.status);
    expect(again.body.id).toBe(started.body.id);
    expect(
      await db().productionTaskEvent.count({ where: { taskId: first, kind: 'INICIADA' } }),
    ).toBe(1);
    // Evento gerado depois do reinício chega na reconexão (retomada pela sequência).
    expect((await act(t2, first, 'complete', { note: 'Pronto' })).status).toBe(200);
    const ws2 = await WsClient.connect(app2, t2, lastSeq);
    sockets.push(ws2);
    await ws2.waitFor((m) => m.kind === 'replay.done');
    expect(ws2.events('production.task_completed').map((e) => e.payload.id)).toContain(first);
    // Painel também continua autenticado.
    expect((await a2.get(`/api/v1/production-plans/${plan.id}`)).status).toBe(200);
  });
});
