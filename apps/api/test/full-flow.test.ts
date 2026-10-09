import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
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
import { createCustomer, createOrder, createPickup, receiptBody } from './commercial-helpers';
import {
  createMeasurement,
  fabric,
  fillAndSubmit,
  gestorUserId,
  nextFriday,
} from './measurement-helpers';
import {
  act,
  addOs,
  createPlan,
  day,
  publish,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';
import {
  confirmPurchase,
  createPurchase,
  createSupplier,
  ok,
  readiness,
  receive,
  staples,
} from './purchasing-helpers';
import { PINS, decideInspection, finish, post, prepareCompany, setClock } from './audit-helpers';

/**
 * Fase 12 — fluxo completo de produção, ponta a ponta pela API real (sessões reais de painel,
 * quatro tablets e o celular da logística), do cadastro do cliente ao resultado da OS.
 * Cada passo numerado corresponde à lista da especificação da Fase 12.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  await prepareCompany();
});

const ok2 = (r: { status: number; body: unknown }, label: string, statuses = [200, 201]) => {
  if (!statuses.includes(r.status))
    throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe('Fluxo completo de produção (32 passos)', () => {
  it('do cliente ao resultado da OS, com ajuda, ocorrência, reprovação, correção, entrega e financeiro', async () => {
    const admin = await loginAdmin(app);
    const ids = {
      ricardo: await userIdOf('Ricardo'),
      marcio: await userIdOf('Márcio'),
      joao: await userIdOf('João'),
      thiago: await userIdOf('Thiago'),
      andre: await userIdOf('André'),
      gestor: await gestorUserId(),
    };
    const panelWs = await WsClient.connect(app, admin);

    // 1–3. Cliente, pedido comercial e retirada.
    const customer = await createCustomer(admin, { name: 'Cliente Fluxo Completo' });
    const order = await createOrder(admin, customer, [
      { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
      { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
    ]);
    const pickup = await createPickup(admin, order);
    // 4. Logística (André) executa a retirada atribuída.
    const assigned = ok2(
      await admin.put(`/api/v1/pickups/${pickup.id}/logistics`, {
        logisticsUserId: ids.andre,
        version: pickup.version,
      }),
      'atribuir retirada',
    );
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    void assigned;
    const pickupVersion = async () =>
      (await db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })).version;
    for (const step of ['SAIDA', 'RETIRADA_REALIZADA'])
      ok2(
        await post(andre, `/api/v1/logistics/pickups/${pickup.id}/step`, {
          step,
          version: await pickupVersion(),
        }),
        step,
      );
    // 5. Peças chegam à oficina (recebimento da retirada).
    ok2(
      await post(
        admin,
        '/api/v1/receipts',
        receiptBody(
          order.id,
          order.items.map((i: { id: string; quantity: number }) => ({
            orderItemId: i.id,
            quantity: i.quantity,
          })),
          pickup.id,
        ) as Record<string, unknown>,
      ),
      'recebimento',
    );
    // 6. OS criada.
    const so = ok2(
      await post(admin, '/api/v1/service-orders', {
        orderId: order.id,
        items: [
          {
            orderItemId: order.items[0].id,
            quantity: 1,
            description: 'Sofá 3 lugares',
            serviceType: 'REFORMA_COMPLETA',
          },
          {
            orderItemId: order.items[1].id,
            quantity: 2,
            description: 'Poltronas',
            serviceType: 'TROCA_DE_TECIDO',
          },
        ],
      }),
      'OS',
    );
    const sofa = so.items[0];
    const poltronas = so.items[1];
    // 7–8. Gestor mede (rotina de sexta) e a solicitação de material é aprovada.
    const m = ok2(
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'ROTINA',
        assigneeUserId: ids.gestor,
        dueDate: nextFriday(),
      }),
      'medição',
    );
    const sub = ok2(
      await fillAndSubmit(admin, m as never, {
        items: [
          fabric({
            serviceOrderItemId: sofa.id,
            description: 'Linho',
            color: 'Bege',
            quantity: 12,
          }),
          staples({ serviceOrderItemId: poltronas.id }),
        ],
      }),
      'enviar medição',
    );
    ok2(
      await post(admin, `/api/v1/measurements/${m.id}/request/approve`, {
        version: sub.request.version,
      }),
      'aprovar',
    );
    const reqs = await db().materialRequirement.findMany({
      where: { serviceOrderId: so.id, origin: 'SOLICITACAO_APROVADA' },
    });
    expect(reqs).toHaveLength(2);
    // 9. Compras: tecido exclusivo da OS e grampos para o estoque (reservados para a OS).
    const supplier = await createSupplier(admin);
    const linho = reqs.find((r) => r.kind === 'TECIDO')!;
    const grampo = reqs.find((r) => r.kind !== 'TECIDO')!;
    const po = ok2(
      await createPurchase(admin, {
        supplierId: supplier.id,
        expectedDate: day(2),
        items: [
          {
            sourcing: 'EXCLUSIVO_OS',
            allocations: [{ materialRequirementId: linho.id, quantity: 12 }],
            quantity: 12,
            unitPriceCents: 4500,
          },
          {
            sourcing: 'ESTOQUE',
            allocations: [{ materialRequirementId: grampo.id, quantity: 2 }],
            quantity: 4,
            unitPriceCents: 1890,
          },
        ],
      }),
      'compra',
    );
    const confirmed = ok2(await confirmPurchase(admin, po as never), 'confirmar compra');
    // 10. Funcionário (Thiago, no tablet) confirma a chegada do material.
    const thiago = await tabletOf(app, admin, 'Thiago', PINS.Thiago!);
    ok2(
      await receive(
        thiago,
        confirmed.id,
        confirmed.items.map((i: { id: string; quantity: number }) => ok(i.id, i.quantity)),
      ),
      'receber material',
    );
    // 11. Estoque e reservas atualizados; materiais disponíveis para a OS.
    const ready = await readiness(admin, so.id);
    expect(ready.state).toBe('COMPLETO');
    const reservation = await db().stockReservation.findFirstOrThrow({
      where: { serviceOrderId: so.id, status: 'ATIVA' },
    });
    // O estoque entrega à OS o material reservado (saída física, vira custo consumido).
    ok2(
      await post(admin, `/api/v1/stock-reservations/${reservation.id}/consume`),
      'entregar material',
    );

    // 12. Gestor programa a semana: preparação (João) → revestimento (Ricardo) ∥ poltronas (Márcio).
    const plan = await createPlan(admin);
    const added = (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: ids.ricardo,
        date: day(-1),
      })
    ).body as {
      tasks: { id: string }[];
    };
    for (const t of added.tasks)
      await post(admin, `/api/v1/production-tasks/${t.id}/cancel`, {
        reason: 'Programação manual',
      });
    const task = async (body: Record<string, unknown>) =>
      ok2(
        await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
          serviceOrderId: so.id,
          date: day(-1),
          time: '08:00',
          ...body,
        }),
        'tarefa',
      ) as { id: string };
    const prep = await task({
      activity: 'PREPARACAO',
      title: 'Preparação',
      serviceOrderItemId: sofa.id,
      role: 'APOIO',
      assigneeUserId: ids.joao,
    });
    const corte = await task({
      activity: 'REVESTIMENTO',
      title: 'Corte e costura do sofá',
      serviceOrderItemId: sofa.id,
      role: 'PRINCIPAL',
      assigneeUserId: ids.ricardo,
    });
    const poltrona = await task({
      activity: 'REVESTIMENTO',
      title: 'Corte e costura das poltronas',
      serviceOrderItemId: poltronas.id,
      role: 'PRINCIPAL',
      assigneeUserId: ids.marcio,
    });
    await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    // Valores de produção combinados (Fase 11) antes da execução.
    const moRicardo = ok2(
      await post(admin, '/api/v1/finance/labor', {
        professionalUserId: ids.ricardo,
        serviceOrderId: so.id,
        serviceOrderItemId: sofa.id,
        service: 'Reforma do sofá',
        agreedCents: 80000,
        eligibility: 'QUALIDADE_APROVADA',
      }),
      'MO Ricardo',
    );
    ok2(
      await post(admin, '/api/v1/finance/labor', {
        professionalUserId: ids.marcio,
        serviceOrderId: so.id,
        serviceOrderItemId: poltronas.id,
        service: 'Troca de tecido',
        agreedCents: 45000,
        eligibility: 'QUALIDADE_APROVADA',
      }),
      'MO Márcio',
    );

    // 13. Funcionários confirmam a chegada nos tablets.
    const tablets: Record<string, Client> = { Thiago: thiago };
    for (const n of ['Ricardo', 'Márcio', 'João'])
      tablets[n] = await tabletOf(app, admin, n, PINS[n]!);
    setClock('08:30');
    for (const n of Object.keys(tablets))
      ok2(await post(tablets[n]!, '/api/v1/attendance/me/arrive'), `chegada ${n}`);
    setClock('09:00');
    // 14. João inicia (e conclui) a preparação.
    await finish(tablets['João']!, prep.id);
    // 15. Ricardo e Márcio executam em paralelo.
    const parallel = await Promise.all([
      act(tablets.Ricardo!, corte.id, 'start'),
      act(tablets['Márcio']!, poltrona.id, 'start'),
    ]);
    expect(parallel.map((r) => r.status)).toEqual([200, 200]);
    // 16–17. Ricardo pede ajudante; o sistema atribui alguém disponível com a competência.
    const help = ok2(
      await post(tablets.Ricardo!, '/api/v1/help-requests', {
        taskId: corte.id,
        kind: 'PARAFUSAR',
      }),
      'ajuda',
    );
    expect(['ATRIBUIDA', 'EM_ATENDIMENTO']).toContain(help.status);
    const support = await db().productionTask.findFirstOrThrow({
      where: { supportForTaskId: corte.id },
    });
    expect([ids.joao, ids.thiago]).toContain(support.assigneeUserId);
    const helper = support.assigneeUserId === ids.joao ? tablets['João']! : tablets.Thiago!;
    await finish(helper, support.id);
    // 18. Márcio registra falta de material.
    const issue = ok2(
      await post(tablets['Márcio']!, '/api/v1/issues', {
        taskId: poltrona.id,
        kind: 'MATERIAL',
        description: 'Acabaram os grampos 80/10',
        impact: 'IMPEDIDO',
        material: { description: 'Grampos 80/10', quantity: 1, unit: 'EMBALAGEM' },
      }),
      'ocorrência',
    );
    // 19. A central de atenção recebe a ocorrência.
    const attention = (await admin.get('/api/v1/attention')).body as
      | { items?: { id?: string; refId?: string }[] }
      | unknown[];
    expect(JSON.stringify(attention)).toContain(issue.code);
    // 20. Gestor delega a solução ao Thiago.
    ok2(
      await post(admin, `/api/v1/issues/${issue.id}/assign`, {
        assigneeUserId: ids.thiago,
        instructions: 'Buscar grampos no estoque',
      }),
      'delegar',
    );
    // 21. Thiago resolve no tablet e o gestor verifica.
    const actionId = (await admin.get(`/api/v1/issues/${issue.id}`)).body.actionTask.id as string;
    await finish(tablets.Thiago!, actionId);
    const verified = ok2(
      await post(admin, `/api/v1/issues/${issue.id}/verify`, {
        resolved: true,
        note: 'Grampos entregues',
      }),
      'verificar',
    );
    expect(verified.status).toBe('RESOLVIDA');
    // 22. Produção retomada.
    ok2(await act(tablets['Márcio']!, poltrona.id, 'resume'), 'retomar');
    // 23. Etapas concluídas.
    ok2(
      await act(tablets['Márcio']!, poltrona.id, 'complete', { note: 'Poltronas prontas' }),
      'concluir poltronas',
    );
    ok2(
      await act(tablets.Ricardo!, corte.id, 'complete', { note: 'Sofá pronto' }),
      'concluir sofá',
    );
    // 24. Thiago recebe as inspeções.
    const inspections = (await tablets.Thiago!.get('/api/v1/quality/inspections')).body as {
      serviceOrderItem?: unknown;
    }[];
    expect(inspections.length).toBe(2);
    // 25. Sofá reprovado (costura) → 26. correção executada pelo Ricardo.
    await decideInspection(tablets.Thiago!, sofa.id, 'Costura do braço solta');
    const correction = await db().productionTask.findFirstOrThrow({
      where: { serviceOrderItemId: sofa.id, activity: 'CORRECAO' },
    });
    expect(correction.assigneeUserId).toBe(ids.ricardo);
    ok2(await act(tablets.Ricardo!, correction.id, 'start'), 'iniciar correção');
    ok2(
      await act(tablets.Ricardo!, correction.id, 'complete', { note: 'Costura refeita' }),
      'concluir correção',
    );
    // 27. Nova inspeção aprovada (e as poltronas aprovadas de primeira).
    await decideInspection(tablets.Thiago!, sofa.id);
    await decideInspection(tablets.Thiago!, poltronas.id);
    expect(await db().qualityInspection.count({ where: { serviceOrderItemId: sofa.id } })).toBe(2);
    // 28. Embalagem concluída (João).
    const expedicao = (await db().itemLocation.findUniqueOrThrow({ where: { key: 'EXPEDICAO' } }))
      .id;
    for (const item of [sofa.id, poltronas.id]) {
      const p = await db().packagingRecord.findFirstOrThrow({
        where: { serviceOrderItemId: item },
        orderBy: { createdAt: 'desc' },
      });
      const packer = p.assigneeUserId === ids.thiago ? tablets.Thiago! : tablets['João']!;
      ok2(
        await post(packer, `/api/v1/packaging/${p.id}/complete`, {
          protection: 'PLASTICO_BOLHA',
          locationId: expedicao,
          notes: 'Embalado',
          version: p.version,
        }),
        'embalar',
      );
    }
    const stages = await db().serviceOrderItem.findMany({ where: { serviceOrderId: so.id } });
    expect(stages.map((s) => s.fulfillmentStage)).toEqual(['PRONTA_ENTREGA', 'PRONTA_ENTREGA']);
    // 29. Gestor agenda a entrega (definitiva: todas as peças prontas).
    const delivery = ok2(
      await post(admin, '/api/v1/deliveries', {
        customerId: customer.id,
        scheduledDate: day(1),
        windowStart: '09:00',
        windowEnd: '12:00',
        team: 'LOGISTICA_TERCEIRIZADA',
        responsibleUserId: ids.andre,
        itemIds: [sofa.id, poltronas.id],
        instructions: 'Avisar o porteiro',
      }),
      'agendar entrega',
    );
    // 30. Logística entrega peça a peça.
    let dv = ok2(
      await post(andre, `/api/v1/deliveries/${delivery.id}/depart`, { version: delivery.version }),
      'saída',
    ).version;
    dv = ok2(
      await post(andre, `/api/v1/deliveries/${delivery.id}/arrive`, { version: dv }),
      'chegada',
    ).version;
    dv = ok2(
      await post(andre, `/api/v1/deliveries/${delivery.id}/items`, {
        items: [
          { serviceOrderItemId: sofa.id, status: 'ENTREGUE' },
          { serviceOrderItemId: poltronas.id, status: 'ENTREGUE' },
        ],
        version: dv,
      }),
      'peças',
    ).version;
    ok2(
      await post(andre, `/api/v1/deliveries/${delivery.id}/complete`, {
        note: 'Recebido pela cliente',
        version: dv,
      }),
      'concluir',
    );
    expect(
      (await db().serviceOrderItem.findMany({ where: { serviceOrderId: so.id } })).every(
        (i) => i.fulfillmentStage === 'ENTREGUE',
      ),
    ).toBe(true);

    // 31. Financeiro: cobrança e recebimento, frete, pagamento por produção liberado e pago.
    await admin.put('/api/v1/finance/settings', { taxRateBps: 600 });
    const rc = ok2(
      await post(admin, '/api/v1/finance/receivables', {
        orderId: order.id,
        description: 'Pagamento integral',
        amountCents: 350000,
        dueDate: today(),
        expectedMethod: 'PIX',
      }),
      'cobrança',
    );
    ok2(
      await post(admin, `/api/v1/finance/receivables/${rc.id}/payments`, {
        amountCents: 350000,
        receivedAt: today(),
        method: 'PIX',
        version: rc.version,
      }),
      'recebimento',
    );
    ok2(
      await post(admin, '/api/v1/finance/logistics-costs', {
        kind: 'ENTREGA',
        description: 'Entrega terceirizada',
        amountCents: 15000,
        date: today(),
        deliveryId: delivery.id,
        beneficiary: 'André (logística)',
        splitMethod: 'IGUAL',
        allocations: [{ serviceOrderId: so.id }],
        payableDueDate: day(7),
      }),
      'frete',
    );
    const mo = (await admin.get(`/api/v1/finance/labor/${moRicardo.id}`)).body;
    expect(mo.status).toBe('LIBERADO');
    ok2(
      await post(admin, `/api/v1/finance/labor/${mo.id}/payments`, {
        amountCents: 80000,
        paidAt: today(),
        method: 'PIX',
        version: mo.version,
      }),
      'pagar Ricardo',
    );

    // 32. Resultado da OS calculado (previsto × realizado) e no painel do período.
    const result = (await admin.get(`/api/v1/finance/service-orders/${so.id}`)).body;
    expect(result).toMatchObject({ delivered: true, revenueCents: 350000 });
    expect(result.actual).toMatchObject({
      materialsCents: 12 * 4500 + 2 * 1890,
      laborCents: 80000 + 45000,
      logisticsCents: 15000,
      taxCents: 21000,
    });
    expect(result.actual.marginCents).toBe(
      350000 - (12 * 4500 + 2 * 1890) - 125000 - 15000 - 21000,
    );
    const dash = (await admin.get('/api/v1/finance/dashboard')).body;
    expect(dash.accrual.completedOrders).toBe(1);
    expect(dash.cash.receivedCents).toBe(350000);
    // Integridade final: nenhuma tarefa concluída duas vezes, nada de estoque negativo.
    const dup = await db().$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM (SELECT task_id FROM production_task_events WHERE kind = 'CONCLUIDA' GROUP BY task_id HAVING count(*) > 1) x`,
    );
    expect(Number(dup[0]!.n)).toBe(0);
    expect(
      await db().stockItem.count({
        where: { OR: [{ onHand: { lt: 0 } }, { reserved: { lt: 0 } }] },
      }),
    ).toBe(0);
    // O painel acompanhou tudo em tempo real.
    await panelWs.waitFor((x) => x.event?.type === 'delivery.updated');
    await panelWs.close();
    void idemKey;
  });
});
