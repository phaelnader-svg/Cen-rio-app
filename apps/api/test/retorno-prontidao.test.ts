import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { refreshOperationalAlerts } from '../src/modules/management/today';
import { panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, resetDatabase } from './helpers';
import { moneyKeys } from './labor-helpers';
import { day } from './production-helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Homologação integrada — prontidão para voltar à versão de retorno (somente leitura): lista as
 * peças aprovadas sem embalagem e ainda não entregues (bloqueiam o retorno) e os avisos da Fase 4
 * que o retorno encerrará. Banco descartável, dados fictícios.
 */
const URL = '/api/v1/system/rollback-readiness';
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

async function packagingOff(admin: J) {
  const m = ((await admin.get('/api/company/modules')).body as J[]).find(
    (x) => x.key === 'embalagem',
  );
  const r = await admin.req(
    'PUT',
    '/api/company/modules/embalagem',
    { enabled: false, version: m.version },
    { 'idempotency-key': idemKey() },
  );
  expect(r.status).toBe(200);
}

describe('Prontidão para o retorno de versão', () => {
  it('sem dados das Fases 3/4: pronto, nada a listar', async () => {
    const s = await k.scenario();
    const r = await s.admin.get(URL);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ready: true,
      incompatiblePieces: [],
      openPhase4Alerts: { total: 0 },
    });
  });

  it('peça aprovada sem embalagem e não entregue bloqueia; entregue, libera — sem mudar dados', async () => {
    const s = await k.scenario();
    await packagingOff(s.admin);
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.approveOpen(s, s.sofa.id);
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    await refreshOperationalAlerts(app.ctx.prisma);

    const before = JSON.stringify(
      await Promise.all([
        db().serviceOrderItem.findMany({ orderBy: { id: 'asc' } }),
        db().notification.findMany({ orderBy: { id: 'asc' } }),
        db().productionPayable.findMany({ orderBy: { id: 'asc' } }),
      ]),
    );
    const r = (await s.admin.get(URL)).body as J;
    expect(r.ready).toBe(false);
    expect(r.incompatiblePieces).toHaveLength(1);
    expect(r.incompatiblePieces[0]).toMatchObject({
      itemId: s.sofa.id,
      code: 'OS-00001/1',
      serviceOrderId: s.so.id,
      stage: 'PRONTA_ENTREGA',
    });
    expect(r.openPhase4Alerts.total).toBeGreaterThan(0);
    expect(r.openPhase4Alerts.byKind.PRAZO_EM_RISCO).toBeGreaterThan(0);
    expect(r.instructions).toMatch(/BLOQUEADO/);
    expect(moneyKeys(r)).toEqual([]);
    // A consulta não altera nada.
    expect(
      JSON.stringify(
        await Promise.all([
          db().serviceOrderItem.findMany({ orderBy: { id: 'asc' } }),
          db().notification.findMany({ orderBy: { id: 'asc' } }),
          db().productionPayable.findMany({ orderBy: { id: 'asc' } }),
        ]),
      ),
    ).toBe(before);

    // Poltronas também aprovadas sem embalagem; entrega direta das duas → nada pendente.
    await k.finish(s.tablets['Márcio']!, s.poltronaTask.id);
    await k.approveOpen(s, s.poltronas.id);
    expect(((await s.admin.get(URL)).body as J).incompatiblePieces).toHaveLength(2);
    const d = await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, {});
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(((await s.admin.get(URL)).body as J).ready).toBe(true);

    // Desfazer a entrega devolve as peças à situação incompatível.
    const rv = await post(s.admin, `/api/v1/service-orders/${s.so.id}/direct-delivery/revert`, {
      deliveryId: d.body.deliveryId,
      reason: 'Teste da prontidão para o retorno',
    });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(((await s.admin.get(URL)).body as J).incompatiblePieces).toHaveLength(2);
  });

  it('nova rodada depois da aprovação sem embalagem (reprovada em correção) não bloqueia', async () => {
    const s = await k.scenario();
    await packagingOff(s.admin);
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.approveOpen(s, s.sofa.id);
    const last = await db().qualityInspection.findFirstOrThrow({
      where: { serviceOrderItemId: s.sofa.id },
      orderBy: { round: 'desc' },
    });
    // Rodada seguinte aberta (ex.: correção pedida depois): a última inspeção já não é a aprovada.
    await db().qualityInspection.create({
      data: {
        serviceOrderItemId: s.sofa.id,
        serviceOrderId: s.so.id,
        round: last.round + 1,
        reason: last.reason,
        itemVersion: last.itemVersion,
        status: 'PENDENTE',
        previousInspectionId: last.id,
      },
    });
    expect(await db().qualityInspection.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
      2,
    );
    expect(((await s.admin.get(URL)).body as J).incompatiblePieces).toHaveLength(0);
  });

  it('só quem configura a empresa consulta', async () => {
    const s = await k.scenario();
    const u = await panelUserWith(app, s.admin, 'naoconfig', ['os.ver', 'entregas.gerenciar']);
    expect((await u.get(URL)).status).toBe(403);
  });
});
