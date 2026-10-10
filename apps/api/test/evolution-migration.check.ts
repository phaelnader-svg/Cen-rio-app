import { closingWeekStart } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin } from './helpers';
import { createCustomer, createOrder, createPickup } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { addOs, createPlan, day, publish, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 8 — verificação da migração ENCADEADA (Fases 2–7) sobre um banco gerado pelo
 * código anterior à Evolução (`839770a`). Não roda na regressão comum: é chamado por
 * `scripts/test-evolution-migrations.sh` com `MIGRATION_CHECK_STEP=read|write`, sem reset.
 *  - read:  o código atual lê os dados legados sem erro e com a semântica preservada.
 *  - write: cria dados NOVOS das Fases 2–7 (fila, titular, divisão de obrigação, viagem devida,
 *           fechamento com Pix) — usados para provar que cada rollback recusa sem mutação.
 */
const STEP = process.env.MIGRATION_CHECK_STEP ?? 'read';
let app: App;
let admin: Client;
beforeAll(async () => {
  app = await createTestApp();
  admin = await loginAdmin(app);
});
afterAll(() => app.close());
const F = (p: string) => `/api/v1/finance${p}`;
const post = (p: string, b: unknown = {}) => admin.post(p, b, { 'idempotency-key': idemKey() });
const put = (p: string, b: unknown) => admin.req('PUT', p, b, { 'idempotency-key': idemKey() });

describe.runIf(STEP === 'read')('Legado migrado: leitura pelo código atual', () => {
  it('planos LEGADO preservados; telas e relatórios respondem sem erro; valores legados visíveis', async () => {
    const plans = await db().productionPlan.findMany();
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.mode === 'LEGADO')).toBe(true);
    const tasks = await db().productionTask.findMany();
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.queuePosition === null && t.stepClass === null)).toBe(true);
    const week = closingWeekStart(today());
    const paths = [
      '/api/v1/production-plans',
      `/api/v1/production-plans/${plans[0]!.id}`,
      `/api/v1/production-plans/${plans[0]!.id}/distribution`,
      `/api/v1/production-tasks/${tasks[0]!.id}`,
      '/api/v1/service-orders',
      F('/dashboard'),
      F('/labor'),
      F('/labor-reviews'),
      F(`/labor-weekly?from=${day(-60)}&to=${today()}`),
      F('/logistics-costs'),
      F(`/logistics-weekly?from=${day(-60)}&to=${today()}`),
      F('/payables'),
      F('/weekly-closings'),
      F(`/weekly-closings/${week}`),
      F(`/weekly-closings/${week}?format=csv`),
      F(`/productivity?from=${day(-60)}&to=${today()}`),
      F('/reports/margens'),
    ];
    const bad: string[] = [];
    for (const p of paths) {
      const r = await admin.get(p);
      if (r.status !== 200) bad.push(`${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    expect(bad).toEqual([]);
    // Valores legados (Fase 11) continuam no financeiro com os mesmos totais.
    const labor = (await admin.get(F('/labor'))).body as { agreedCents: number }[];
    const sum = await db().productionPayable.aggregate({
      where: { status: { not: 'CANCELADO' } },
      _sum: { agreedCents: true },
    });
    expect(labor.reduce((a, x) => a + x.agreedCents, 0)).toBe(sum._sum.agreedCents ?? 0);
    const costs = await db().logisticsCost.findMany();
    expect(costs.every((c) => c.status === 'LANCADO')).toBe(true);
  });
});

describe.runIf(STEP === 'write')('Dados novos das Fases 2–7 sobre o legado migrado', () => {
  it('fila semanal, titular por peça, divisão de obrigação, viagem devida e fechamento com Pix', async () => {
    const ids = {
      ricardo: await userIdOf('Ricardo'),
      marcio: await userIdOf('Márcio'),
      andre: await userIdOf('André'),
    };
    // Fases 2–3: plano em fila com titular por peça.
    const so = await openServiceOrder(admin, 'Cliente Migração Encadeada');
    const plan = await createPlan(admin, day(14), 'FILA_SEMANAL');
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: so.id,
          pieces: [
            { serviceOrderItemId: so.items[0].id, upholstererUserId: ids.ricardo },
            { serviceOrderItemId: so.items[1].id, upholstererUserId: ids.marcio },
          ],
        })
      ).status,
    ).toBe(201);
    await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    // Fase 5: valor por peça, substituição → revisão → divisão entre os dois.
    const mo = await post(F('/labor'), {
      professionalUserId: ids.ricardo,
      serviceOrderId: so.id,
      serviceOrderItemId: so.items[0].id,
      service: 'Mão de obra',
      agreedCents: 80000,
      eligibility: 'QUALIDADE_APROVADA',
    });
    expect(mo.status).toBe(201);
    expect(
      (
        await put(`/api/v1/service-order-items/${so.items[0].id}/upholsterer`, {
          userId: ids.marcio,
          expectedUserId: ids.ricardo,
          reason: 'Substituição (teste de migração)',
          confirm: true,
        })
      ).status,
    ).toBe(200);
    const rv = (await admin.get(F('/labor-reviews?status=ABERTA'))).body[0];
    expect(
      (
        await post(F(`/labor-reviews/${rv.id}/resolve`), {
          lines: [
            { professionalUserId: ids.ricardo, amountCents: 30000 },
            { professionalUserId: ids.marcio, amountCents: 50000 },
          ],
          reason: 'Divisão (teste de migração)',
          version: rv.version,
        })
      ).status,
    ).toBe(200);
    // Fase 6: viagem realizada com custo → obrigação do André.
    await put(F('/logistics-defaults'), {
      defaultPickupCostCents: 10000,
      defaultDeliveryCostCents: 10000,
      logisticsPayeeUserId: ids.andre,
    });
    const c = await createCustomer(admin, {
      name: 'Retirada Migração',
      phone: null,
      allowSimilar: true,
    });
    const pk = await createPickup(admin, await createOrder(admin, c), day(1));
    expect(
      (
        await put(F('/trip-costs'), {
          pickupId: pk.id,
          amountCents: 10000,
          participantUserIds: [ids.andre],
        })
      ).status,
    ).toBe(200);
    for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
      const p = (await admin.get(`/api/v1/pickups/${pk.id}`)).body;
      expect(
        (await post(`/api/v1/pickups/${pk.id}/transition`, { toStatus, version: p.version }))
          .status,
      ).toBe(200);
    }
    // Fase 7: Pix externo registrado no fechamento.
    const week = closingWeekStart(today());
    const pay = await post(F(`/weekly-closings/${week}/payments`), {
      beneficiaryUserId: ids.andre,
      category: 'LOGISTICA',
      amountCents: 4000,
      paidAt: today(),
      method: 'PIX',
      reference: 'MIGRACAO',
    });
    expect(pay.status).toBe(201);
    const split = await db().productionPayable.count({
      where: { serviceOrderItemId: so.items[0].id, status: { not: 'CANCELADO' } },
    });
    expect(split).toBe(2);
  });
});
