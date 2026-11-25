import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { runOfficeRound } from '../src/modules/game/office';
import { createTestApp, db, idemKey, naEmpresa1, resetDatabase } from './helpers';
import { qualityKit } from './quality-helpers';

/** Material acabando (Compras, 2026-11-25): estoque × o que as OS abertas ainda vão usar. */
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

const round = () => naEmpresa1(() => runOfficeRound(app.ctx.prisma, { force: true }));

describe('Material acabando', () => {
  it('avisa quando o estoque não dá para as OS abertas e resolve quando volta a dar', async () => {
    const s = await k.scenario();
    const hire = await s.admin.req(
      'POST',
      '/api/v1/office/hire',
      { roleKey: 'COMPRAS' },
      { 'idempotency-key': idemKey() },
    );
    expect(hire.status).toBe(201);
    const so = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    const item = await db().inventoryItem.create({
      data: { companyId: 1, name: 'Linho cinza', unit: 'm', quantity: 5 },
    });
    const mat = (quantity: number, unit: string | null = 'm') =>
      db().serviceOrderMaterial.create({
        data: {
          companyId: 1,
          serviceOrderId: so.serviceOrderId,
          description: 'Linho cinza',
          inventoryItemId: item.id,
          quantity,
          unit,
          available: true,
        },
      });
    await mat(4);
    await round();
    expect(await db().notification.count({ where: { kind: 'MATERIAL_ACABANDO' } })).toBe(0);

    await mat(3);
    // Unidade diferente não entra na conta.
    await mat(50, 'rolo');
    await round();
    await round();
    const n = await db().notification.findMany({
      where: { kind: 'MATERIAL_ACABANDO', resolvedAt: null },
    });
    expect(n.length).toBeGreaterThan(0);
    expect(new Set(n.map((x) => x.userId)).size).toBe(n.length);
    expect(n[0]!.body).toMatch(/Linho cinza: tem 5 m no estoque e as OS abertas pedem 7 m/);
    expect(n[0]!.body).toMatch(/Faltam 2 m/);

    await db().inventoryItem.update({ where: { id: item.id }, data: { quantity: 10 } });
    await round();
    expect(
      await db().notification.count({ where: { kind: 'MATERIAL_ACABANDO', resolvedAt: null } }),
    ).toBe(0);
  });
});
