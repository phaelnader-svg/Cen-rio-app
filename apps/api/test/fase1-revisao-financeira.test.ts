import { mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { type Client, createTestApp, db, resetDatabase } from './helpers';
import { today, uploadPhoto } from './production-helpers';
import { post, qualityKit } from './quality-helpers';

/** Respostas JSON livres nos testes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 1 — revisão final de integridade financeira (banco descartável, dados
 * fictícios):
 *  A. custo de material quando coexistem compra formal e custo informado na lista da OS:
 *     conciliação EXPLÍCITA (vincular ao registro formal ou marcar como distinto), nunca deduzida
 *     por valores iguais; lançamentos existentes nunca mudam (só compensações novas);
 *  B. entrega direta: mesmos efeitos financeiros da entrega pela logística, sem duplicar cobrança
 *     nem mão de obra, sem tocar peças já entregues.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const k = qualityKit(() => app);

beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ));
});
afterEach(() => setAttendanceClock());

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const result = async (c: Client, soId: string) =>
  ok(await c.get(`/api/v1/finance/service-orders/${soId}`));

describe('B. Entrega direta — efeitos financeiros equivalentes, sem duplicidade', () => {
  const D = (soId: string) => `/api/v1/service-orders/${soId}/deliver`;

  /** Cenário com saldo "na entrega" e mão de obra liberada só na entrega concluída. */
  async function withFinance() {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const order = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const rec = ok(
      await post(s.admin, '/api/v1/finance/receivables', {
        orderId: order.orderId,
        description: 'Saldo na entrega',
        amountCents: 150000,
        dueTrigger: 'ENTREGA',
        expectedMethod: 'PIX',
      }),
      201,
    );
    const labor = ok(
      await post(s.admin, '/api/v1/finance/labor', {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        service: 'Reforma do sofá',
        agreedCents: 80000,
        eligibility: 'ENTREGA_CONCLUIDA',
      }),
      201,
    );
    expect(labor.status).toBe('PREVISTO');
    return { s, rec, labor };
  }
  /** O que a entrega muda no financeiro (para comparar os dois caminhos). */
  async function effects(s: J, recId: string, laborId: string) {
    const rec = ok(await s.admin.get(`/api/v1/finance/receivables/${recId}`));
    const labor = await db().productionPayable.findUniqueOrThrow({ where: { id: laborId } });
    const res = await result(s.admin, s.so.id);
    return {
      due: rec.effectiveDueDate,
      receivables: await db().customerReceivable.count(),
      laborStatus: labor.status,
      laborEligible: labor.eligibleAt !== null,
      payables: await db().productionPayable.count(),
      delivered: res.delivered,
      completed: res.completedAt !== null,
      logisticsCosts: await db().logisticsCost.count(),
      accountsPayable: await db().accountPayable.count(),
    };
  }
  const EXPECTED = {
    due: today(),
    receivables: 1,
    laborStatus: 'LIBERADO',
    laborEligible: true,
    payables: 1,
    delivered: true,
    completed: true,
    accountsPayable: 0,
  };

  it('pela logística (referência): saldo vence, mão de obra liberada, OS concluída', async () => {
    const { s, rec, labor } = await withFinance();
    const d = ok(
      await k.schedule(s, {
        itemIds: [s.sofa.id, s.poltronas.id],
        scheduledDate: today(),
        team: 'EQUIPE_PROPRIA',
      }),
      201,
    );
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const items = ok(
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [
          { serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' },
          { serviceOrderItemId: s.poltronas.id, status: 'ENTREGUE' },
        ],
        version: v,
      }),
    );
    expect((await uploadPhoto(app, andre, 'DELIVERY', d.id)).status).toBe(201);
    ok(await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: items.version }));
    expect(await effects(s, rec.id, labor.id)).toMatchObject(EXPECTED);
    // Controle positivo: a viagem da logística SEM custo vira pendência do fechamento (a entrega
    // direta não — ver o teste seguinte e o da Fase 1).
    const closing = ok(await s.admin.get(`/api/v1/finance/weekly-closings/${mondayOf(today())}`));
    expect(JSON.stringify(closing)).toMatch(new RegExp(`Entrega ${d.code} realizada sem custo`));
  });

  it('pela OS (direta): os MESMOS efeitos; sem frete; repetir e concorrer não duplicam nada', async () => {
    const { s, rec, labor } = await withFinance();
    const before = await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } });
    expect(before.eligibleAt).toBeNull();
    // Três requisições simultâneas.
    const rs = await Promise.all([1, 2, 3].map(() => post(s.admin, D(s.so.id))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.body.created)).toHaveLength(1);
    const e = await effects(s, rec.id, labor.id);
    expect(e).toMatchObject({ ...EXPECTED, logisticsCosts: 0 });
    // Data de conclusão = momento da entrega registrada.
    const d = await db().delivery.findFirstOrThrow({ where: { origin: 'DIRETA' } });
    const res = await result(s.admin, s.so.id);
    expect(res.completedAt).toBe(d.completedAt!.toISOString());
    // Nada duplicado: uma entrega, uma cobrança, uma mão de obra, uma liberação registrada.
    const releasedAt = (await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } }))
      .eligibleAt;
    const again = ok(await post(s.admin, D(s.so.id)));
    expect(again.created).toBe(false);
    expect(await effects(s, rec.id, labor.id)).toEqual(e);
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } })).eligibleAt,
    ).toEqual(releasedAt);
    expect(await db().delivery.count()).toBe(1);
    const closing = ok(await s.admin.get(`/api/v1/finance/weekly-closings/${mondayOf(today())}`));
    // A única entrega da semana é a direta: nenhuma pendência de custo de viagem.
    expect(JSON.stringify(closing)).not.toMatch(/Entrega EN-\d+ realizada sem custo/);
  });

  it('peça já entregue pela logística não é tocada: a direta entrega só as pendentes', async () => {
    const { s, rec, labor } = await withFinance();
    // Sofá entregue pela logística.
    const d = ok(
      await k.schedule(s, { itemIds: [s.sofa.id], scheduledDate: today(), team: 'EQUIPE_PROPRIA' }),
      201,
    );
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const items = ok(
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      }),
    );
    expect((await uploadPhoto(app, andre, 'DELIVERY', d.id)).status).toBe(201);
    ok(await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: items.version }));
    const sofaBefore = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    const sofaItemBefore = await db().deliveryItem.findFirstOrThrow({
      where: { serviceOrderItemId: s.sofa.id },
    });
    const sofaEvents = await db().qualityEvent.count({ where: { serviceOrderItemId: s.sofa.id } });
    // Mão de obra do sofá já liberada pela entrega da logística.
    const laborAfterLogistics = await db().productionPayable.findUniqueOrThrow({
      where: { id: labor.id },
    });
    expect(laborAfterLogistics.status).toBe('LIBERADO');

    const r = ok(await post(s.admin, D(s.so.id)));
    expect(r).toMatchObject({ created: true, deliveredItems: 1 });
    const direct = await db().delivery.findUniqueOrThrow({
      where: { id: r.deliveryId },
      include: { items: true },
    });
    expect(direct.items.map((i) => i.serviceOrderItemId)).toEqual([s.poltronas.id]);
    // Sofá intacto: mesma linha de entrega, mesma data, nenhuma etapa/evento novo.
    expect(await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } })).toEqual(
      sofaBefore,
    );
    expect(await db().deliveryItem.findMany({ where: { serviceOrderItemId: s.sofa.id } })).toEqual([
      sofaItemBefore,
    ]);
    expect(await db().qualityEvent.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
      sofaEvents,
    );
    // Mão de obra não muda de novo (mesma liberação), saldo vence uma vez.
    expect(await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } })).toEqual(
      laborAfterLogistics,
    );
    expect(await effects(s, rec.id, labor.id)).toMatchObject({ ...EXPECTED });
  });
});
