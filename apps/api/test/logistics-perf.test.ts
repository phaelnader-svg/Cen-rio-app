import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import {
  WsClient,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';
import { createCustomer, createOrder, createPickup } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { day, tabletOf, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 6 — desempenho dos custos de logística (medido, não estimado): 40 OS,
 * 40 entregas provisórias com custo, 40 retiradas (20 realizadas), 4 tablets conectados.
 * Só roda com LOGISTICS_PERF=1 (fora da regressão comum).
 */
const ON = Boolean(process.env.LOGISTICS_PERF);
let app: App;
const sockets: WsClient[] = [];

beforeAll(async () => {
  if (!ON) return;
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  await resetDatabase();
}, 120_000);
afterAll(async () => {
  if (!ON) return;
  await Promise.all(sockets.map((s) => s.close()));
  await app.close();
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

describe.skipIf(!ON)('Desempenho dos custos de logística', () => {
  it('40 OS / 80 viagens / 4 tablets', async () => {
    const admin = await loginAdmin(app);
    const put = (c: Client, url: string, body: unknown) =>
      c.req('PUT', url, body, { 'idempotency-key': idemKey() });
    const post = (c: Client, url: string, body: unknown) =>
      c.post(url, body, { 'idempotency-key': idemKey() });
    const andre = await userIdOf('André');
    const izaias = await userIdOf('Izaías');
    await put(admin, '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: 8000,
      defaultDeliveryCostCents: 12000,
      logisticsPayeeUserId: andre,
    });
    const tablets = [
      await tabletOf(app, admin, 'Ricardo', '482915'),
      await tabletOf(app, admin, 'João', '121212'),
      (await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' }))
        .tablet,
      (await setupTablet(app, admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '552211' }))
        .tablet,
    ];
    for (const t of tablets) sockets.push(await WsClient.connect(app, t));
    sockets.push(await WsClient.connect(app, admin));
    const deliveries: string[] = [];
    const pickups: string[] = [];
    const sos: string[] = [];
    for (let i = 0; i < 40; i++) {
      const so = await openServiceOrder(admin, `Cliente Perf Log ${i}`);
      sos.push(so.id);
      const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }))
        .customerId;
      const d = await post(admin, '/api/v1/deliveries', {
        customerId,
        scheduledDate: day(3),
        team: 'LOGISTICA_TERCEIRIZADA',
        responsibleUserId: andre,
        itemIds: so.items.map((x: { id: string }) => x.id),
        provisional: true,
        tripCost: { amountCents: 12000 + i, participantUserIds: [andre, izaias] },
      });
      expect(d.status).toBe(201);
      deliveries.push(d.body.id);
      const customer = await createCustomer(admin, {
        name: `Cliente Perf Ret ${i}`,
        phone: null,
        allowSimilar: true,
      });
      const pk = await createPickup(admin, await createOrder(admin, customer), day(2));
      await put(admin, '/api/v1/finance/trip-costs', {
        pickupId: pk.id,
        amountCents: 8000,
        participantUserIds: [andre],
      });
      pickups.push(pk.id);
    }
    const realize = async (id: string) => {
      for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
        const p = (await admin.get(`/api/v1/pickups/${id}`)).body;
        const r = await post(admin, `/api/v1/pickups/${id}/transition`, {
          toStatus,
          version: p.version,
        });
        expect(r.status).toBe(200);
      }
    };
    const transitionMs: number[] = [];
    for (const id of pickups.slice(0, 20)) {
      const t0 = performance.now();
      await realize(id);
      transitionMs.push((performance.now() - t0) / 2);
    }
    expect(await db().accountPayable.count()).toBe(20);
    const runs = 20;
    const measure = async (name: string, fn: (i: number) => Promise<{ status: number }>) => {
      const xs: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = await fn(i);
        xs.push(performance.now() - t0);
        expect(r.status, name).toBe(200);
      }
      return {
        p50: Math.round(pct(xs, 50)),
        p95: Math.round(pct(xs, 95)),
        max: Math.round(Math.max(...xs)),
      };
    };
    let version = (
      await db().logisticsCost.findFirstOrThrow({ where: { deliveryId: deliveries[0] } })
    ).version;
    const out = {
      volume: { os: 40, deliveries: 40, pickups: 40, realized: 20, tablets: 4 },
      runs,
      'POST transition (realização, constitui a obrigação)': {
        p50: Math.round(pct(transitionMs, 50)),
        p95: Math.round(pct(transitionMs, 95)),
        max: Math.round(Math.max(...transitionMs)),
      },
      'PUT /finance/trip-costs (alteração com motivo)': await measure('edit', async (i) => {
        const r = await put(admin, '/api/v1/finance/trip-costs', {
          deliveryId: deliveries[0],
          amountCents: 13000 + i,
          participantUserIds: [andre, izaias],
          reason: 'Teste de desempenho',
          version,
        });
        version += 1;
        return r;
      }),
      'GET /finance/trip-costs (retirada/entrega)': await measure('view', (i) =>
        admin.get(`/api/v1/finance/trip-costs?deliveryId=${deliveries[i % 40]}`),
      ),
      'GET /finance/logistics-costs (lista)': await measure('list', () =>
        admin.get('/api/v1/finance/logistics-costs'),
      ),
      'GET /finance/logistics-weekly (60 dias)': await measure('weekly', () =>
        admin.get(`/api/v1/finance/logistics-weekly?from=${day(-30)}&to=${day(30)}`),
      ),
      'GET /finance/service-orders/:id (resultado com rateio)': await measure('result', (i) =>
        admin.get(`/api/v1/finance/service-orders/${sos[i % 40]}`),
      ),
      'GET /logistics/jobs (celular do André)': await measure('jobs', () =>
        tablets[2]!.get('/api/v1/logistics/jobs'),
      ),
    };
    if (process.env.LOGISTICS_PERF_OUT)
      writeFileSync(process.env.LOGISTICS_PERF_OUT, JSON.stringify(out, null, 2));
  }, 900_000);
});
