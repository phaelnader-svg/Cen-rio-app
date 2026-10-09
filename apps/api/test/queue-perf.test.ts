import { writeFileSync } from 'node:fs';
import { mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { act, addOs, createPlan, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 2 — desempenho da fila semanal (medido, não estimado): 40 OS, 200 tarefas,
 * 4 tablets e o painel conectados. Só roda com QUEUE_PERF=1 (fora da regressão comum).
 */
const ON = Boolean(process.env.QUEUE_PERF);
let app: App;
const sockets: WsClient[] = [];

beforeAll(async () => {
  if (!ON) return;
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setClock(() => zonedDateTime(mondayOf(today()), '09:00', 'America/Sao_Paulo'));
}, 120_000);
afterAll(async () => {
  if (!ON) return;
  setClock();
  await Promise.all(sockets.map((s) => s.close()));
  await app.close();
});

const ms = (t0: number) => Math.round(performance.now() - t0);
async function timed<T>(fn: () => Promise<T>) {
  const t0 = performance.now();
  const r = await fn();
  return { r, ms: ms(t0) };
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

describe.skipIf(!ON)('Desempenho da fila semanal', () => {
  it('40 OS / 200 tarefas / 4 tablets + painel', async () => {
    const out: Record<string, unknown> = {};
    const admin = await loginAdmin(app);
    const names = ['Ricardo', 'Márcio', 'João', 'Thiago'] as const;
    const ids = Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await userIdOf(n)] as const)),
    ) as Record<(typeof names)[number], string>;
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    let t0 = performance.now();
    const sos = [];
    for (let i = 0; i < 40; i++) sos.push(await openServiceOrder(admin, `Cliente Perf ${i + 1}`));
    out.criar40OS_ms = ms(t0);
    t0 = performance.now();
    for (const [i, so] of sos.entries()) {
      expect(
        (
          await addOs(admin, plan.id, {
            serviceOrderId: so.id,
            principalUserId: i % 2 ? ids['Márcio'] : ids.Ricardo,
            generate: false,
          })
        ).status,
      ).toBe(201);
      for (let k = 0; k < 5; k++) {
        const r = await admin.post(
          `/api/v1/production-plans/${plan.id}/tasks`,
          {
            serviceOrderId: so.id,
            activity: 'OUTRA',
            title: `OS ${i + 1} etapa ${k + 1}`,
            assigneeUserId: ids[names[(i * 5 + k) % 4]!],
          },
          { 'idempotency-key': idemKey() },
        );
        expect(r.status).toBe(201);
      }
    }
    out.criar200Tarefas_ms = ms(t0);
    const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(draft.tasks).toHaveLength(200);

    // Painel + 4 tablets conectados por WebSocket.
    const tablets: Record<string, Client> = {};
    const pins = ['482915', '591837', '602413', '713524'];
    for (const [i, n] of names.entries()) tablets[n] = await tabletOf(app, admin, n, pins[i]!);
    const panelWs = await WsClient.connect(app, admin);
    sockets.push(panelWs);
    for (const n of names) sockets.push(await WsClient.connect(app, tablets[n]!));

    const pub = await timed(() => publish(admin, draft));
    out.publicar200_ms = pub.ms;
    expect(pub.r.tasks.filter((t: { status: string }) => t.status === 'LIBERADA')).toHaveLength(
      200,
    );

    // Leituras: plano completo (painel), quadro, fila de cada tablet (20 repetições).
    const planReads: number[] = [];
    const boardReads: number[] = [];
    const queueReads: number[] = [];
    for (let i = 0; i < 20; i++) {
      planReads.push((await timed(() => admin.get(`/api/v1/production-plans/${plan.id}`))).ms);
      boardReads.push((await timed(() => admin.get('/api/v1/production-board'))).ms);
      const qs = await Promise.all(
        names.map((n) => timed(() => tablets[n]!.get('/api/v1/production-tasks/mine/queue'))),
      );
      for (const q of qs) {
        expect(q.r.body.total).toBe(50);
        queueReads.push(q.ms);
      }
    }
    out.lerPlano = { p50: pct(planReads, 50), p95: pct(planReads, 95) };
    out.lerQuadro = { p50: pct(boardReads, 50), p95: pct(boardReads, 95) };
    out.lerFila4Tablets = {
      p50: pct(queueReads, 50),
      p95: pct(queueReads, 95),
      n: queueReads.length,
    };

    // Execução simultânea: os 4 tablets iniciam e concluem 10 tarefas cada, em paralelo.
    const actions: number[] = [];
    let wsLag = 0;
    t0 = performance.now();
    await Promise.all(
      names.map(async (n) => {
        for (let i = 0; i < 10; i++) {
          const q = (await tablets[n]!.get('/api/v1/production-tasks/mine/queue')).body;
          const s = await timed(() => act(tablets[n]!, q.next.id, 'start'));
          expect(s.r.status).toBe(200);
          const c = await timed(() => act(tablets[n]!, q.next.id, 'complete'));
          expect(c.r.status).toBe(200);
          actions.push(s.ms, c.ms);
        }
      }),
    );
    out.execucao80acoes_ms = ms(t0);
    out.acaoIniciarConcluir = { p50: pct(actions, 50), p95: pct(actions, 95), n: actions.length };
    expect(await db().productionTask.count({ where: { status: 'CONCLUIDA' } })).toBe(40);
    expect(await db().productionTask.count({ where: { status: 'EM_EXECUCAO' } })).toBe(0);

    // Reordenação de uma fila com 40 tarefas abertas e latência do aviso ao tablet.
    const p = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    const q = (await tablets['João']!.get('/api/v1/production-tasks/mine/queue')).body;
    const order = q.items.map((e: { task: { id: string } }) => e.task.id).reverse();
    const before = sockets[3]!.events('production.queue_reordered').length;
    const ws0 = performance.now();
    const re = await timed(() =>
      admin.req(
        'PUT',
        `/api/v1/production-plans/${plan.id}/queue`,
        { userId: ids['João'], taskIds: order, version: p.version, reason: 'Teste de desempenho' },
        { 'idempotency-key': idemKey() },
      ),
    );
    expect(re.r.status).toBe(200);
    await sockets[3]!.waitFor(
      () => sockets[3]!.events('production.queue_reordered').length > before,
      10_000,
    );
    wsLag = ms(ws0);
    out.reordenar40_ms = re.ms;
    out.reordenarAteAvisoNoTablet_ms = wsLag;
    if (process.env.QUEUE_PERF_OUT)
      writeFileSync(process.env.QUEUE_PERF_OUT, JSON.stringify(out, null, 2));
  }, 600_000);
});
