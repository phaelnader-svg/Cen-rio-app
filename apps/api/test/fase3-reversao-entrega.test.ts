import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { revertTestHooks } from '../src/modules/quality/direct-delivery-revert';
import { panelUserWith } from './commercial-helpers';
import { type Client, createTestApp, db, idemKey, resetDatabase } from './helpers';
import { pay } from './labor-helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 3 (D5) — desfazer a ÚLTIMA entrega direta, com as condições aprovadas:
 * 7 dias, `entregas.gerenciar` + `financeiro.gerenciar`, justificativa, prévia, histórico
 * preservado, auditoria destacada; bloqueios financeiros e operacionais; transação atômica,
 * revalidação na confirmação, concorrência e idempotência. Banco descartável, dados fictícios.
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());
afterEach(() => {
  setClock();
  revertTestHooks.beforeFinish = undefined;
});

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const P = (soId: string) => `/api/v1/service-orders/${soId}/direct-delivery/revert-preview`;
const R = (soId: string) => `/api/v1/service-orders/${soId}/direct-delivery/revert`;
const REASON = 'Cliente devolveu na hora: entrega marcada por engano';

type S = Awaited<ReturnType<typeof k.scenario>>;

/** OS com mão de obra "na entrega" (sofá), "na aprovação" (poltronas), cobrança na entrega. */
async function delivered(s: S) {
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
  await k.ready(s, 'sofa');
  await k.ready(s, 'poltronas');
  const d = ok(
    await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, { note: 'Cliente buscou' }),
  );
  return { laborE, laborQ, rec, deliveryId: d.deliveryId as string, orderId: order.orderId };
}
const state = async (s: S, deliveryId: string, laborIds: string[]) => ({
  delivery: await db().delivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { items: { orderBy: { serviceOrderItemId: 'asc' } } },
  }),
  stages: [await k.stage(s.sofa.id), await k.stage(s.poltronas.id)],
  labor: await db().productionPayable.findMany({
    where: { id: { in: laborIds } },
    orderBy: { id: 'asc' },
    select: { id: true, status: true, eligibleAt: true, version: true },
  }),
  audits: await db().auditLog.count({ where: { action: 'delivery.direct_reverted' } }),
});

describe('Desfazer a entrega direta', () => {
  it('prévia, justificativa, efeitos revertidos só da entrega; histórico e auditoria; pode entregar e desfazer de novo', async () => {
    const s = await k.scenario();
    const x = await delivered(s);
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: x.laborE.id } })).status,
    ).toBe('LIBERADO');

    const pv = ok(await s.admin.get(P(s.so.id)));
    expect(pv).toMatchObject({ allowed: true, blocks: [] });
    expect(pv.delivery.id).toBe(x.deliveryId);
    expect(pv.effects.pieces).toHaveLength(2);
    expect(pv.effects.labor.map((l: J) => l.agreedCents)).toEqual([40000]);
    expect(pv.effects.receivables).toHaveLength(1);

    // Justificativa curta: recusada.
    expect(
      (await post(s.admin, R(s.so.id), { deliveryId: x.deliveryId, reason: 'curta' })).status,
    ).toBe(400);
    const r = ok(await post(s.admin, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON }));
    expect(r).toMatchObject({ reverted: true });
    expect(r.eligibility).toMatchObject({ eligible: true, delivered: false });
    expect(r.eligibility.lastReverted).toMatchObject({ id: x.deliveryId, reason: REASON });

    const st = await state(s, x.deliveryId, [x.laborE.id, x.laborQ.id]);
    // A entrega original continua registrada (CONCLUIDA), marcada como desfeita.
    expect(st.delivery).toMatchObject({
      status: 'CONCLUIDA',
      origin: 'DIRETA',
      revertReason: REASON,
    });
    expect(st.delivery.revertedAt).not.toBeNull();
    expect(st.delivery.items.every((i) => i.status === 'NAO_ENTREGUE' && !i.active)).toBe(true);
    expect(st.stages).toEqual(['PRONTA_ENTREGA', 'PRONTA_ENTREGA']);
    // Mão de obra "na entrega" volta a prevista (sem competência); a da aprovação não muda.
    const lE = st.labor.find((l) => l.id === x.laborE.id)!;
    const lQ = st.labor.find((l) => l.id === x.laborQ.id)!;
    expect(lE).toMatchObject({ status: 'PREVISTO', eligibleAt: null });
    expect(lQ.status).toBe('LIBERADO');
    // Cobrança volta a "aguardando entrega".
    expect(
      ok(await s.admin.get(`/api/v1/finance/receivables/${x.rec.id}`)).effectiveDueDate,
    ).toBeNull();
    // Auditoria destacada + evento no histórico da entrega.
    const a = await db().auditLog.findFirstOrThrow({
      where: { action: 'delivery.direct_reverted' },
    });
    expect(a.summary).toMatch(/^EXCEÇÃO: .* desfeita/);
    expect(a.summary).toContain(REASON);
    expect(
      ok(await s.admin.get('/api/audit?highlighted=1')).items.map((i: J) => i.action),
    ).toContain('delivery.direct_reverted');
    expect(
      await db().deliveryEvent.count({
        where: { deliveryId: x.deliveryId, kind: 'ENTREGA_DIRETA_DESFEITA' },
      }),
    ).toBe(1);

    // Múltiplas entregas: entrega de novo (nova entrega) e só ela pode ser desfeita.
    const again = ok(await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, {}));
    expect(again.deliveryId).not.toBe(x.deliveryId);
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    // A entrega antiga (já desfeita) não pode ser alvo.
    expect(
      (await post(s.admin, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON })).body.reverted,
    ).toBe(false);
    const pv2 = ok(await s.admin.get(P(s.so.id)));
    expect(pv2.delivery.id).toBe(again.deliveryId);
    ok(await post(s.admin, R(s.so.id), { deliveryId: again.deliveryId, reason: REASON }));
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
  });

  it('permissões: exige entregas.gerenciar E financeiro.gerenciar', async () => {
    const s = await k.scenario();
    const x = await delivered(s);
    const onlyDelivery = await panelUserWith(app, s.admin, 'so-entregas', [
      'entregas.gerenciar',
      'os.ver',
    ]);
    const onlyFinance = await panelUserWith(app, s.admin, 'so-financeiro', [
      'financeiro.gerenciar',
      'financeiro.ver',
    ]);
    for (const c of [onlyDelivery, onlyFinance]) {
      expect((await c.get(P(s.so.id))).status).toBe(403);
      expect((await post(c, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON })).status).toBe(
        403,
      );
    }
    expect(await db().delivery.count({ where: { revertedAt: { not: null } } })).toBe(0);
    const both = await panelUserWith(app, s.admin, 'ambos', [
      'entregas.gerenciar',
      'financeiro.gerenciar',
      'financeiro.ver',
      'os.ver',
    ]);
    ok(await post(both, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON }));
  });

  it('bloqueios: mão de obra paga em parte, semana conferida, cobrança paga depois, prazo de 7 dias — nada é alterado', async () => {
    const s = await k.scenario();
    const x = await delivered(s);
    const ids = [x.laborE.id, x.laborQ.id];
    const expectBlocked = async (pattern: RegExp) => {
      const before = await state(s, x.deliveryId, ids);
      const pv = ok(await s.admin.get(P(s.so.id)));
      expect(pv.allowed).toBe(false);
      expect(pv.blocks.join(' ')).toMatch(pattern);
      const r = await post(s.admin, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(await state(s, x.deliveryId, ids)).toEqual(before);
    };

    // Cobrança paga ANTES da entrega não bloqueia; depois, bloqueia.
    // (o recebimento é registrado com a data de hoje = dia da entrega → bloqueia.)
    const rec = await db().customerReceivable.findUniqueOrThrow({ where: { id: x.rec.id } });
    ok(
      await post(s.admin, `/api/v1/finance/receivables/${rec.id}/payments`, {
        amountCents: 10000,
        receivedAt: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
          new Date(),
        ),
        method: 'PIX',
        version: rec.version,
      }),
      200,
    );
    await expectBlocked(/recebeu pagamento depois da entrega/);
    // Estornado pelo fluxo normal (lançamento compensatório), deixa de bloquear.
    const paid = await db().customerReceivable.findUniqueOrThrow({
      where: { id: rec.id },
      include: { payments: true },
    });
    ok(
      await post(
        s.admin,
        `/api/v1/finance/receivables/${rec.id}/payments/${paid.payments[0]!.id}/reverse`,
        {
          reason: 'Lançado por engano',
          version: paid.version,
        },
      ),
    );
    expect(ok(await s.admin.get(P(s.so.id))).allowed).toBe(true);

    // Semana do fechamento conferida.
    const week = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: x.laborE.id } })).eligibleAt!,
    );
    const monday = (() => {
      const d = new Date(`${week}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const closing = await db().weeklyClosing.create({
      data: {
        weekStart: new Date(`${monday}T00:00:00Z`),
        status: 'CONFERIDO',
        snapshot: {},
        dueCents: 0,
        paidCents: 0,
        openCents: 0,
      },
    });
    await expectBlocked(/já foi conferido/);
    await db().weeklyClosing.update({ where: { id: closing.id }, data: { status: 'REABERTO', reopenReason: 'Reaberta para o teste' } });

    // Mão de obra paga em parte.
    await pay(s.admin, x.laborE.id, 10000);
    await expectBlocked(/já tem pagamento registrado/);
  });

  it('bloqueios operacionais: prazo de 7 dias, alteração técnica, devolução e cancelamento depois da entrega', async () => {
    const s = await k.scenario();
    const x = await delivered(s);
    // Prazo.
    setClock(() => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(ok(await s.admin.get(P(s.so.id))).blocks.join(' ')).toMatch(
      /prazo para desfazer terminou/,
    );
    expect(
      (await post(s.admin, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON })).status,
    ).toBe(422);
    setClock();
    // Alteração técnica posterior.
    const rev = await db().serviceOrderRevision.create({
      data: {
        serviceOrderId: s.so.id,
        revision: 99,
        scope: 'ITEM',
        itemId: s.sofa.id,
        changes: {},
      },
    });
    expect(ok(await s.admin.get(P(s.so.id))).blocks.join(' ')).toMatch(/alteração\(ões\) técnica/);
    await db()
      .serviceOrderRevision.delete({ where: { id: rev.id } })
      .catch(() => undefined);
    // Devolução posterior.
    const orderItem = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    await db().pieceReturn.create({
      data: {
        orderId: x.orderId,
        reason: 'Cliente devolveu',
        returnDate: new Date(),
        lines: {
          create: [
            { orderItemId: orderItem.orderItemId, quantity: 1, serviceOrderItemIds: [s.sofa.id] },
          ],
        },
      },
    });
    const pv = ok(await s.admin.get(P(s.so.id)));
    expect(pv.blocks.join(' ')).toMatch(/devolução registrada/);
    expect(await db().delivery.count({ where: { revertedAt: { not: null } } })).toBe(0);
  });

  it('entrega parcial: só as peças da última entrega direta voltam; a entrega anterior (logística) fica', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    // Sofá entregue antes por uma entrega da logística (registro já concluído).
    const customerId = await k.customerOf(s);
    const logi = await db().delivery.create({
      data: {
        origin: 'LOGISTICA',
        customerId,
        addressSnapshot: {},
        contactName: 'Cliente',
        scheduledDate: new Date(),
        team: 'EQUIPE_PROPRIA',
        requiresInstallation: false,
        status: 'CONCLUIDA',
        completedAt: new Date(Date.now() - 60_000),
        items: {
          create: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE', deliveredAt: new Date() }],
        },
      },
    });
    await db().serviceOrderItem.update({
      where: { id: s.sofa.id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    const d = ok(await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, {}));
    expect(d.deliveredItems).toBe(1);
    const pv = ok(await s.admin.get(P(s.so.id)));
    expect(pv.effects.pieces.map((p: J) => p.code)).toEqual([`${s.so.code}/2`]);
    ok(await post(s.admin, R(s.so.id), { deliveryId: d.deliveryId, reason: REASON }));
    expect(await k.stage(s.poltronas.id)).toBe('PRONTA_ENTREGA');
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    const kept = await db().deliveryItem.findFirstOrThrow({ where: { deliveryId: logi.id } });
    expect(kept).toMatchObject({ status: 'ENTREGUE', active: true });
  });

  it('concorrência e idempotência: duas confirmações simultâneas desfazem uma vez; repetir a chave repete a resposta', async () => {
    const s = await k.scenario();
    const x = await delivered(s);
    const body = { deliveryId: x.deliveryId, reason: REASON };
    const [a, b] = await Promise.all([
      post(s.admin, R(s.so.id), body),
      post(s.admin, R(s.so.id), body),
    ]);
    const results = [a, b].map((r) => ({ status: r.status, reverted: r.body.reverted }));
    expect(results.filter((r) => r.status === 200 && r.reverted === true)).toHaveLength(1);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await db().auditLog.count({ where: { action: 'delivery.direct_reverted' } })).toBe(1);
    // Mesma chave de idempotência: mesma resposta, nada novo gravado.
    const key = idemKey();
    const r1 = await post(s.admin, R(s.so.id), body, key);
    const r2 = await post(s.admin, R(s.so.id), body, key);
    expect(r2.body).toEqual(r1.body);
    expect(await db().auditLog.count({ where: { action: 'delivery.direct_reverted' } })).toBe(1);
  });

  it('falha no meio: nada é alterado (transação atômica)', async () => {
    const s = await k.scenario();
    const x = await delivered(s);
    const ids = [x.laborE.id, x.laborQ.id];
    const before = await state(s, x.deliveryId, ids);
    const moves = await db().itemLocationEvent.count();
    revertTestHooks.beforeFinish = async () => {
      throw new Error('falha simulada');
    };
    const r = await post(s.admin, R(s.so.id), { deliveryId: x.deliveryId, reason: REASON });
    expect(r.status).toBe(500);
    expect(await state(s, x.deliveryId, ids)).toEqual(before);
    expect(await db().itemLocationEvent.count()).toBe(moves);
    expect(await db().deliveryEvent.count({ where: { kind: 'ENTREGA_DIRETA_DESFEITA' } })).toBe(0);
  });
});

describe('Qualidade: gestor reprova a própria peça sem justificativa (auditado)', () => {
  it('reprovação registrada na auditoria, sem marca de autoaprovação', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await db().userPermission.create({
      data: { userId: s.ids.ricardo, permission: 'qualidade.gerenciar' },
    });
    const open = (await k.openOf(s.sofa.id))!;
    const i = await k.checkAll(s.tablets.Ricardo!, open.id, 'Costura torta');
    ok(
      await post(s.tablets.Ricardo! as Client, `/api/v1/quality/inspections/${i.id}/reject`, {
        reason: 'Costura torta no braço',
        version: i.version,
      }),
    );
    const a = await db().auditLog.findFirstOrThrow({
      where: { action: 'quality.inspection_rejected', entityId: i.id },
    });
    expect(a.actorUserId).toBe(s.ids.ricardo);
    expect(
      await db().auditLog.count({ where: { action: 'quality.inspection_self_approved' } }),
    ).toBe(0);
  });
});
