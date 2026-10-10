import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { grant, openServiceOrder } from './measurement-helpers';
import { day, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 5 — desempenho das consultas de mão de obra (medido, não estimado): 60 OS,
 * 120 valores por peça, pagamentos e 20 revisões abertas. Só roda com LABOR_PERF=1.
 */
const ON = Boolean(process.env.LABOR_PERF);
let app: App;

beforeAll(async () => {
  if (!ON) return;
  app = await createTestApp();
  await app.app.ready();
  await resetDatabase();
}, 120_000);
afterAll(async () => {
  if (ON) await app.close();
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

describe.skipIf(!ON)('Desempenho da mão de obra', () => {
  it('60 OS / 120 valores / 20 revisões', async () => {
    const admin = await loginAdmin(app);
    const post = (url: string, body: unknown) =>
      admin.post(url, body, { 'idempotency-key': idemKey() });
    const ric = await userIdOf('Ricardo');
    const mar = await userIdOf('Márcio');
    const sos = [];
    for (let i = 0; i < 60; i++) sos.push(await openServiceOrder(admin, `Cliente Perf MO ${i}`));
    const sofaPay: { id: string; so: string; item: string }[] = [];
    for (const so of sos) {
      await db().serviceOrderItem.update({
        where: { id: so.items[0]!.id },
        data: { upholstererUserId: ric },
      });
      await db().serviceOrderItem.update({
        where: { id: so.items[1]!.id },
        data: { upholstererUserId: mar },
      });
      const a = await post('/api/v1/finance/labor', {
        professionalUserId: ric,
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[0]!.id,
        service: 'Sofá',
        agreedCents: 80000,
        eligibility: 'PRODUCAO_CONCLUIDA',
      });
      expect(a.status).toBe(201);
      const b = await post('/api/v1/finance/labor', {
        professionalUserId: mar,
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[1]!.id,
        service: 'Poltronas',
        agreedCents: 45000,
        eligibility: 'QUALIDADE_APROVADA',
      });
      expect(b.status).toBe(201);
      sofaPay.push({ id: a.body.id, so: so.id, item: so.items[0]!.id });
    }
    // 30 pagamentos antecipados (justificados) e 20 trocas de titular com revisão.
    for (const p of sofaPay.slice(0, 30)) {
      const cur = (await admin.get(`/api/v1/finance/labor/${p.id}`)).body;
      const r = await post(`/api/v1/finance/labor/${p.id}/payments`, {
        amountCents: 20000,
        paidAt: today(),
        method: 'PIX',
        earlyReason: 'Adiantamento (teste de desempenho)',
        version: cur.version,
      });
      expect(r.status).toBe(200);
    }
    for (const p of sofaPay.slice(20, 40)) {
      const r = await admin.req(
        'PUT',
        `/api/v1/service-order-items/${p.item}/upholsterer`,
        { userId: mar, expectedUserId: ric, reason: 'Troca de teste', confirm: true },
        { 'idempotency-key': idemKey() },
      );
      expect(r.status).toBe(200);
    }
    expect(await db().laborReview.count({ where: { status: 'ABERTA' } })).toBe(20);
    await grant(admin, 'Ricardo', ['financeiro.producao_propria']);
    const tablet = await tabletOf(app, admin, 'Ricardo', '482915');

    const runs = 20;
    const measure = async (name: string, fn: () => Promise<{ status: number }>) => {
      const xs: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = await fn();
        xs.push(performance.now() - t0);
        expect(r.status, name).toBe(200);
      }
      return {
        p50: Math.round(pct(xs, 50)),
        p95: Math.round(pct(xs, 95)),
        max: Math.round(Math.max(...xs)),
      };
    };
    const out = {
      volume: { os: 60, payables: 120, payments: 30, openReviews: 20 },
      runs,
      'GET /finance/labor (todas)': await measure('labor', () =>
        admin.get('/api/v1/finance/labor'),
      ),
      'GET /finance/service-orders/:id/labor': await measure('so-labor', () =>
        admin.get(`/api/v1/finance/service-orders/${sofaPay[25]!.so}/labor`),
      ),
      'GET /finance/labor-reviews?status=ABERTA': await measure('reviews', () =>
        admin.get('/api/v1/finance/labor-reviews?status=ABERTA'),
      ),
      'GET /finance/labor-weekly (90 dias)': await measure('weekly', () =>
        admin.get(`/api/v1/finance/labor-weekly?from=${day(-60)}&to=${day(30)}`),
      ),
      'POST /finance/my-production/unlock (tablet)': await measure('unlock', () =>
        tablet.post('/api/v1/finance/my-production/unlock', { pin: '482915' }),
      ),
    };
    if (process.env.LABOR_PERF_OUT)
      writeFileSync(process.env.LABOR_PERF_OUT, JSON.stringify(out, null, 2));
  }, 600_000);
});
