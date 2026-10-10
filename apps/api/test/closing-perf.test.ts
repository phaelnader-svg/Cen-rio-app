import { writeFileSync } from 'node:fs';
import { closingWeekStart, mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, createPickup } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { addOs, createPlan, day, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 7 — desempenho do fechamento semanal (medido, não estimado): 40 OS, 200 tarefas
 * publicadas, 80 valores de mão de obra liberados, 80 viagens devidas (40 retiradas + 40
 * entregas), 4 tablets e o painel conectados. Só roda com CLOSING_PERF=1 (fora da regressão).
 */
const ON = Boolean(process.env.CLOSING_PERF);
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

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const stats = (xs: number[]) => ({
  p50: Math.round(pct(xs, 50)),
  p95: Math.round(pct(xs, 95)),
  max: Math.round(Math.max(...xs)),
});

describe.skipIf(!ON)('Desempenho do fechamento semanal', () => {
  it('40 OS / 200 tarefas / 160 obrigações / 4 tablets + painel', async () => {
    // O limite de requisições é por sessão: a carga de preparação troca de sessão a cada 8 OS.
    let admin = await loginAdmin(app);
    const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
      c.post(url, body, { 'idempotency-key': key });
    const put = (c: Client, url: string, body: unknown) =>
      c.req('PUT', url, body, { 'idempotency-key': idemKey() });
    const names = ['Ricardo', 'Márcio', 'João', 'Thiago'] as const;
    const ids = Object.fromEntries(
      await Promise.all(
        [...names, 'André', 'Izaías'].map(async (n) => [n, await userIdOf(n)] as const),
      ),
    ) as Record<string, string>;
    await put(admin, '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: 10000,
      defaultDeliveryCostCents: 10000,
      logisticsPayeeUserId: ids['André'],
    });
    // 40 OS e 200 tarefas publicadas (carga de produção concorrente).
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    const sos = [];
    for (let i = 0; i < 40; i++) {
      if (i % 10 === 0) admin = await loginAdmin(app);
      sos.push(await openServiceOrder(admin, `Cliente Perf F7 ${i}`));
    }
    for (const [i, so] of sos.entries()) {
      if (i % 8 === 0) admin = await loginAdmin(app);
      expect(
        (
          await addOs(admin, plan.id, {
            serviceOrderId: so.id,
            principalUserId: i % 2 ? ids['Márcio'] : ids.Ricardo,
            generate: false,
          })
        ).status,
      ).toBe(201);
      for (let k = 0; k < 5; k++)
        expect(
          (
            await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
              serviceOrderId: so.id,
              activity: 'OUTRA',
              title: `OS ${i + 1} etapa ${k + 1}`,
              assigneeUserId: ids[names[(i * 5 + k) % 4]!],
            })
          ).status,
        ).toBe(201);
    }
    const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(draft.tasks).toHaveLength(200);
    await publish(admin, draft);

    // 80 valores de mão de obra (Ricardo e Márcio) liberados.
    for (const [i, so] of sos.entries()) {
      if (i % 8 === 0) admin = await loginAdmin(app);
      await db().serviceOrderItem.update({
        where: { id: so.items[0]!.id },
        data: { upholstererUserId: ids.Ricardo },
      });
      await db().serviceOrderItem.update({
        where: { id: so.items[1]!.id },
        data: { upholstererUserId: ids['Márcio'] },
      });
      for (const [k, who] of [ids.Ricardo, ids['Márcio']].entries())
        expect(
          (
            await post(admin, '/api/v1/finance/labor', {
              professionalUserId: who,
              serviceOrderId: so.id,
              serviceOrderItemId: so.items[k]!.id,
              service: 'Mão de obra',
              agreedCents: 70000 + k * 10000,
              eligibility: 'QUALIDADE_APROVADA',
            })
          ).status,
        ).toBe(201);
    }
    await db().serviceOrderItem.updateMany({
      where: { serviceOrderId: { in: sos.map((s) => s.id) } },
      data: { fulfillmentStage: 'AGUARDANDO_EMBALAGEM' },
    });
    await admin.get('/api/v1/finance/labor');

    // 40 entregas concluídas + 40 retiradas realizadas (André), cada uma uma obrigação.
    for (const [i, so] of sos.entries()) {
      if (i % 4 === 0) admin = await loginAdmin(app);
      const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }))
        .customerId;
      const d = await post(admin, '/api/v1/deliveries', {
        customerId,
        scheduledDate: day(1),
        team: 'LOGISTICA_TERCEIRIZADA',
        itemIds: so.items.map((x: { id: string }) => x.id),
        provisional: true,
      });
      expect(d.status).toBe(201);
      await db().delivery.update({
        where: { id: d.body.id },
        data: { status: 'CONCLUIDA', completedAt: new Date() },
      });
      expect(
        (
          await put(admin, '/api/v1/finance/trip-costs', {
            deliveryId: d.body.id,
            amountCents: 10000,
            participantUserIds: [ids['André'], ids['Izaías']],
          })
        ).status,
      ).toBe(200);
      const c = await createCustomer(admin, {
        name: `Retirada Perf F7 ${i}`,
        phone: null,
        allowSimilar: true,
      });
      const pk = await createPickup(admin, await createOrder(admin, c), day(1));
      await put(admin, '/api/v1/finance/trip-costs', {
        pickupId: pk.id,
        amountCents: 10000,
        participantUserIds: [ids['André']],
      });
      for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
        const p = (await admin.get(`/api/v1/pickups/${pk.id}`)).body;
        expect(
          (
            await post(admin, `/api/v1/pickups/${pk.id}/transition`, {
              toStatus,
              version: p.version,
            })
          ).status,
        ).toBe(200);
      }
    }
    expect(await db().productionPayable.count({ where: { status: 'LIBERADO' } })).toBe(80);
    expect(await db().logisticsCost.count({ where: { status: 'DEVIDO' } })).toBe(80);

    // Painel (sessão nova, só medições) + 4 tablets conectados.
    admin = await loginAdmin(app);
    const tablets: Record<string, Client> = {};
    const pins = ['482915', '591837', '602413', '713524'];
    for (const [i, n] of names.entries()) tablets[n] = await tabletOf(app, admin, n, pins[i]!);
    sockets.push(await WsClient.connect(app, admin));
    for (const n of names) sockets.push(await WsClient.connect(app, tablets[n]!));

    const WEEK = closingWeekStart(today());
    const C = `/api/v1/finance/weekly-closings/${WEEK}`;
    const first = (await admin.get(C)).body;
    expect(first.totals.weekDueCents).toBe(80 * 10000 + 40 * 70000 + 40 * 80000);
    const runs = 20;
    const read: number[] = [];
    const csv: number[] = [];
    const list: number[] = [];
    const concurrent: number[] = [];
    const queue: number[] = [];
    for (let i = 0; i < runs; i++) {
      let t0 = performance.now();
      expect((await admin.get(C)).status).toBe(200);
      read.push(performance.now() - t0);
      t0 = performance.now();
      expect((await admin.get(`${C}?format=csv`)).status).toBe(200);
      csv.push(performance.now() - t0);
      t0 = performance.now();
      expect((await admin.get('/api/v1/finance/weekly-closings')).status).toBe(200);
      list.push(performance.now() - t0);
      // Painel lendo o fechamento enquanto os 4 tablets leem a fila.
      t0 = performance.now();
      const all = await Promise.all([
        admin.get(C),
        ...names.map(async (n) => {
          const q0 = performance.now();
          const r = await tablets[n]!.get('/api/v1/production-tasks/mine/queue');
          queue.push(performance.now() - q0);
          return r;
        }),
      ]);
      concurrent.push(performance.now() - t0);
      expect(all.every((r) => r.status === 200)).toBe(true);
    }
    // 20 Pix em lote (André, R$ 150 cada: atravessa duas obrigações) e 20 de tapeçaria.
    const payMs: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = await post(admin, `${C}/payments`, {
        beneficiaryUserId: i % 2 ? ids['André'] : ids.Ricardo,
        category: i % 2 ? 'LOGISTICA' : 'TAPECARIA',
        amountCents: i % 2 ? 15000 : 105000,
        paidAt: today(),
        method: 'PIX',
        reference: `PERF-${i}`,
      });
      payMs.push(performance.now() - t0);
      expect(r.status).toBe(201);
    }
    // Conferir / reabrir em ciclo (CAS por versão).
    const confirmMs: number[] = [];
    const reopenMs: number[] = [];
    let version = (await admin.get(C)).body.version;
    for (let i = 0; i < 10; i++) {
      let t0 = performance.now();
      let r = await post(admin, `${C}/confirm`, { version, note: `Conferência ${i}` });
      confirmMs.push(performance.now() - t0);
      expect(r.status).toBe(200);
      version = r.body.version;
      t0 = performance.now();
      r = await post(admin, `${C}/reopen`, { version, reason: `Reabertura ${i}` });
      reopenMs.push(performance.now() - t0);
      expect(r.status).toBe(200);
      version = r.body.version;
    }
    const final = (await admin.get(C)).body;
    expect(final.totals.paidInWeekCents).toBe(10 * 15000 + 10 * 105000);
    const out = {
      volume: {
        os: 40,
        tasks: 200,
        laborItems: 80,
        tripObligations: 80,
        tablets: 4,
        rows: final.rows.length,
        items: final.totals.items,
      },
      runs,
      'GET fechamento da semana (painel)': stats(read),
      'GET fechamento CSV': stats(csv),
      'GET lista de fechamentos': stats(list),
      'Painel + 4 tablets simultâneos (rodada)': stats(concurrent),
      'GET fila do tablet durante o fechamento': stats(queue),
      'POST Pix em lote (baixa nas obrigações originais)': stats(payMs),
      'POST conferir': stats(confirmMs),
      'POST reabrir': stats(reopenMs),
    };
    if (process.env.CLOSING_PERF_OUT)
      writeFileSync(process.env.CLOSING_PERF_OUT, JSON.stringify(out, null, 2));
  }, 900_000);
});
