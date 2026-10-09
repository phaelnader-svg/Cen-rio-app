import { writeFileSync } from 'node:fs';
import { mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, receiptBody } from './commercial-helpers';
import { act, addOs, createPlan, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 3 — desempenho da distribuição automática (medido): 40 OS de uma cabeceira,
 * 200 tarefas geradas e atribuídas sem intervenção, painel + 4 tablets por WebSocket.
 * Só roda com DIST_PERF=1 (fora da regressão comum).
 */
const ON = Boolean(process.env.DIST_PERF);
let app: App;
const sockets: WsClient[] = [];
beforeAll(async () => {
  if (!ON) return;
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  await resetDatabase();
  setClock(() => zonedDateTime(mondayOf(today()), '09:00', 'America/Sao_Paulo'));
}, 120_000);
afterAll(async () => {
  if (!ON) return;
  setClock();
  await Promise.all(sockets.map((s) => s.close()));
  await app.close();
});

const ms = (t0: number) => Math.round(performance.now() - t0);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
async function timed<T>(fn: () => Promise<T>) {
  const t0 = performance.now();
  const r = await fn();
  return { r, ms: ms(t0) };
}

async function cabeceira(admin: Client, i: number) {
  const customer = await createCustomer(admin, {
    name: `Cliente Perf ${i}`,
    phone: null,
    allowSimilar: true,
  });
  const order = await createOrder(admin, customer, [
    { pieceType: 'CABECEIRA', description: 'Cabeceira', quantity: 1 },
  ]);
  await admin.post(
    '/api/v1/receipts',
    receiptBody(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]),
    { 'idempotency-key': idemKey() },
  );
  const so = await admin.post(
    '/api/v1/service-orders',
    {
      orderId: order.id,
      items: [
        {
          orderItemId: order.items[0].id,
          quantity: 1,
          description: 'Cabeceira',
          serviceType: 'REFORMA_COMPLETA',
        },
      ],
    },
    { 'idempotency-key': idemKey() },
  );
  return so.body as { id: string; items: { id: string }[] };
}

describe.skipIf(!ON)('Desempenho da distribuição automática', () => {
  it('40 OS / 200 tarefas / 4 tablets + gestor', async () => {
    const out: Record<string, unknown> = {};
    const admin = await loginAdmin(app);
    const ids = {
      Ricardo: await userIdOf('Ricardo'),
      Márcio: await userIdOf('Márcio'),
      João: await userIdOf('João'),
      Thiago: await userIdOf('Thiago'),
    };
    // Modelo de cabeceira sem exigência de material (para medir também a execução).
    const tpl = await admin.post('/api/v1/production-templates', {
      name: 'Cabeceira (perf)',
      pieceTypes: ['CABECEIRA'],
      steps: [
        { activity: 'PREPARACAO_MDF', name: 'Preparação do MDF', role: 'APOIO' },
        { activity: 'CORTE_ESPUMA', name: 'Corte de espuma', role: 'APOIO' },
        { activity: 'REVESTIMENTO', name: 'Revestimento', role: 'PRINCIPAL', dependsOn: [1, 2] },
        { activity: 'MONTAGEM', name: 'Montagem', role: 'PRINCIPAL', dependsOn: [3] },
        { activity: 'ACABAMENTO', name: 'Acabamento', role: 'PRINCIPAL', dependsOn: [4] },
      ],
    });
    expect(tpl.status).toBe(201);
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    let t0 = performance.now();
    const sos = [];
    for (let i = 0; i < 40; i++) sos.push(await cabeceira(admin, i + 1));
    out.criar40OS_ms = ms(t0);
    const addTimes: number[] = [];
    for (const [i, so] of sos.entries()) {
      const r = await timed(() =>
        addOs(admin, plan.id, {
          serviceOrderId: so.id,
          pieces: [
            {
              serviceOrderItemId: so.items[0]!.id,
              upholstererUserId: i % 2 ? ids['Márcio'] : ids.Ricardo,
              templateId: tpl.body.id,
            },
          ],
        }),
      );
      expect(r.r.status).toBe(201);
      addTimes.push(r.ms);
    }
    out.incluirOSComDistribuicao = { p50: pct(addTimes, 50), p95: pct(addTimes, 95), n: 40 };
    expect(await db().productionTask.count({ where: { planId: plan.id } })).toBe(200);
    expect(
      await db().productionTask.count({ where: { planId: plan.id, assigneeUserId: null } }),
    ).toBe(0);

    const distReads: number[] = [];
    for (let i = 0; i < 10; i++)
      distReads.push(
        (await timed(() => admin.get(`/api/v1/production-plans/${plan.id}/distribution`))).ms,
      );
    out.lerDistribuicao40OS = { p50: pct(distReads, 50), p95: pct(distReads, 95), n: 10 };
    const reproc: number[] = [];
    const items = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body.items as {
      id: string;
    }[];
    for (const it of items.slice(0, 10))
      reproc.push(
        (
          await timed(() =>
            admin.post(
              `/api/v1/production-plans/${plan.id}/items/${it.id}/distribute`,
              {},
              {
                'idempotency-key': idemKey(),
              },
            ),
          )
        ).ms,
      );
    out.reprocessarSemMudanca = { p50: pct(reproc, 50), p95: pct(reproc, 95), n: 10 };
    expect(await db().productionTask.count({ where: { planId: plan.id } })).toBe(200);

    const tablets: Record<string, Client> = {};
    const pins = ['482915', '591837', '602413', '713524'];
    for (const [i, n] of (['Ricardo', 'Márcio', 'João', 'Thiago'] as const).entries())
      tablets[n] = await tabletOf(app, admin, n, pins[i]!);
    sockets.push(await WsClient.connect(app, admin));
    for (const c of Object.values(tablets)) sockets.push(await WsClient.connect(app, c));
    const pub = await timed(async () =>
      publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body),
    );
    out.publicar200_ms = pub.ms;

    const queueReads: number[] = [];
    for (let i = 0; i < 20; i++) {
      const qs = await Promise.all(
        Object.values(tablets).map((c) =>
          timed(() => c.get('/api/v1/production-tasks/mine/queue')),
        ),
      );
      for (const q of qs) queueReads.push(q.ms);
    }
    out.lerFila4Tablets = {
      p50: pct(queueReads, 50),
      p95: pct(queueReads, 95),
      n: queueReads.length,
    };
    const q = async (n: string) =>
      (await tablets[n]!.get('/api/v1/production-tasks/mine/queue')).body;
    expect((await q('João')).total).toBe(80);
    expect((await q('Ricardo')).total).toBe(60);

    // João executa 10 preparações enquanto os tapeceiros e o Thiago consultam as filas.
    const actions: number[] = [];
    t0 = performance.now();
    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i++) {
          const next = (await q('João')).next;
          const s = await timed(() => act(tablets['João']!, next.id, 'start'));
          expect(s.r.status).toBe(200);
          const c = await timed(() => act(tablets['João']!, next.id, 'complete'));
          expect(c.r.status).toBe(200);
          actions.push(s.ms, c.ms);
        }
      })(),
      ...(['Ricardo', 'Márcio', 'Thiago'] as const).map(async (n) => {
        for (let i = 0; i < 10; i++) await q(n);
      }),
    ]);
    out.execucao20acoes_ms = ms(t0);
    out.acaoIniciarConcluir = { p50: pct(actions, 50), p95: pct(actions, 95), n: actions.length };
    if (process.env.DIST_PERF_OUT)
      writeFileSync(process.env.DIST_PERF_OUT, JSON.stringify(out, null, 2));
  }, 900_000);
});
