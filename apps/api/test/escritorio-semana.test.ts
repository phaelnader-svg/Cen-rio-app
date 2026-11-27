import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeWeekDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { runOfficeRound } from '../src/modules/game/office';
import { createTestApp, db, idemKey, naEmpresa1, resetDatabase } from './helpers';
import { qualityKit } from './quality-helpers';

/** Relatório da semana do Gerente (2026-11-25): números dos últimos 7 dias e o aviso de domingo. */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

describe('Relatório da semana', () => {
  it('mostra os 7 dias e, no domingo à tarde, avisa no sininho (uma vez)', async () => {
    const s = await k.scenario();
    const hire = await s.admin.req(
      'POST',
      '/api/v1/office/hire',
      { roleKey: 'GERENTE' },
      { 'idempotency-key': idemKey() },
    );
    expect(hire.status).toBe(201);
    const r = await s.admin.get('/api/v1/office/week');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const w = r.body as OfficeWeekDto;
    expect(w.from <= w.to).toBe(true);
    expect(typeof w.contractedCents).toBe('number');
    expect(w.nextWeek).toBeTruthy();

    // Domingo, 18:30 em São Paulo.
    const sunday = new Date('2026-11-29T21:30:00Z');
    setClock(() => sunday);
    await naEmpresa1(() => runOfficeRound(app.ctx.prisma, { at: sunday }));
    await naEmpresa1(() => runOfficeRound(app.ctx.prisma, { at: sunday }));
    const n = await db().notification.findMany({ where: { kind: 'AGENTES_SEMANA' } });
    expect(n.length).toBeGreaterThan(0);
    expect(new Set(n.map((x) => x.userId)).size).toBe(n.length);
    expect(n[0]!.body).toMatch(/^Semana: fechou/);

    // Segunda: não avisa.
    await db().notification.deleteMany({ where: { kind: 'AGENTES_SEMANA' } });
    const monday = new Date('2026-11-30T21:30:00Z');
    setClock(() => monday);
    await naEmpresa1(() => runOfficeRound(app.ctx.prisma, { at: monday }));
    expect(await db().notification.count({ where: { kind: 'AGENTES_SEMANA' } })).toBe(0);
  });
});
