import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { refreshOperationalAlerts } from '../src/modules/management/today';
import { createTestApp, db, idemKey, resetDatabase } from './helpers';
import { pay } from './labor-helpers';
import { day, uploadPhoto } from './production-helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Preparação da homologação integrada — SEMENTE do banco representativo para o teste da versão
 * de retorno (3e0d2d0 + migrations das Fases 2 e 3). Roda com o código INTEGRADO sobre um banco
 * LOCAL descartável (TEST_DATABASE_URL) e grava os identificadores em RB_OUT. Nunca aponte para
 * um banco real. Dados fictícios.
 *
 * Dados criados:
 *  - Fase 2: foto anexada à OS (tratada), material na lista simples (faltando);
 *  - Fase 3: embalagem DESLIGADA; duas peças aprovadas sem embalagem; entrega direta feita e
 *    DESFEITA (peças voltam a prontas, não entregues); mão de obra "na entrega" (volta a prevista)
 *    e "na aprovação" (liberada e PAGA, lançamento independente); cobrança "na entrega";
 *  - Fase 4: prazo vencido + material faltante → avisos internos dos tipos novos.
 */
const STEP = process.env.RB_STEP ?? 'seed';
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());

const ok = (r: { status: number; body: J }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as J;
};

describe.runIf(STEP === 'seed')('Banco representativo das Fases 2, 3 e 4', () => {
  it('cria os dados e grava os identificadores', async () => {
    await resetDatabase();
    const s = await k.scenario();
    // Fase 3: embalagem desligada.
    const mods = ok(await s.admin.get('/api/company/modules')) as J[];
    const emb = mods.find((m) => m.key === 'embalagem');
    ok(
      await s.admin.req(
        'PUT',
        '/api/company/modules/embalagem',
        { enabled: false, version: emb.version },
        { 'idempotency-key': idemKey() },
      ),
    );
    // Financeiro: mão de obra na entrega e na aprovação; cobrança na entrega.
    const laborE = ok(
      await post(s.admin, '/api/v1/finance/labor', {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        service: 'Reforma do sofá',
        agreedCents: 40000,
        eligibility: 'ENTREGA_CONCLUIDA',
      }),
      201,
    );
    const laborQ = ok(
      await post(s.admin, '/api/v1/finance/labor', {
        professionalUserId: s.ids.marcio,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.poltronas.id,
        service: 'Poltronas',
        agreedCents: 30000,
        eligibility: 'QUALIDADE_APROVADA',
      }),
      201,
    );
    const order = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const rec = ok(
      await post(s.admin, '/api/v1/finance/receivables', {
        orderId: order.orderId,
        description: 'Saldo na entrega',
        amountCents: 100000,
        dueTrigger: 'ENTREGA',
        expectedMethod: 'PIX',
      }),
      201,
    );
    // Produção + aprovação SEM embalagem.
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.approveOpen(s, s.sofa.id);
    await k.finish(s.tablets['Márcio']!, s.poltronaTask.id);
    await k.approveOpen(s, s.poltronas.id);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    // Pagamento parcial da mão de obra da aprovação (independente da entrega).
    await pay(s.admin, laborQ.id, 10000);
    // Entrega direta e reversão.
    const d = ok(
      await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, { note: 'Retirou' }),
    );
    ok(
      await post(s.admin, `/api/v1/service-orders/${s.so.id}/direct-delivery/revert`, {
        deliveryId: d.deliveryId,
        reason: 'Entrega marcada por engano no teste de retorno',
      }),
    );
    // Fase 2: foto e material faltando.
    const photo = await uploadPhoto(app, s.admin, 'SERVICE_ORDER', s.so.id);
    expect(photo.status, JSON.stringify(photo.body)).toBe(201);
    await post(s.admin, `/api/v1/service-orders/${s.so.id}/material-list`, {
      description: 'Espuma D33 (teste de retorno)',
    });
    // Fase 4: prazo vencido e material faltante → avisos internos.
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    // Tarefa futura em aberto, para o alerta de material (produção nos próximos dias).
    await s
      .task({
        activity: 'ACABAMENTO',
        title: 'Ajuste final',
        serviceOrderItemId: s.sofa.id,
        role: 'APOIO',
        assigneeUserId: s.ids.ricardo,
        date: day(1),
      })
      .catch(() => null);
    await refreshOperationalAlerts(app.ctx.prisma);
    const kinds = await db().notification.groupBy({
      by: ['kind'],
      where: {
        resolvedAt: null,
        kind: { in: ['PRAZO_EM_RISCO', 'MATERIAL_FALTANTE', 'PECA_PRONTA_SEM_ENTREGA'] },
      },
      _count: true,
    });
    expect(kinds.length).toBeGreaterThan(0);
    const out = {
      serviceOrderId: s.so.id,
      sofaId: s.sofa.id,
      poltronasId: s.poltronas.id,
      deliveryId: d.deliveryId,
      laborE: laborE.id,
      laborQ: laborQ.id,
      receivableId: rec.id,
      attachmentId: photo.body.id,
      alertKinds: kinds.map((x) => x.kind),
    };
    writeFileSync(process.env.RB_OUT ?? '/tmp/rb-ids.json', JSON.stringify(out, null, 2));
  });
});
