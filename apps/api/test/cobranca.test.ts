import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { address, createCustomer, receiptBody } from './commercial-helpers';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';
import { day, today, userIdOf } from './production-helpers';

/**
 * Cobrança / pagamento do cliente (dados fictícios; centavos). Fontes de verdade:
 * valor final = contratado + ajustes; cobranças = customer_receivables; caixa = customer_payments;
 * Resultado da OS = receita econômica (nunca o caixa). A equipe só INFORMA o pagamento da parada;
 * o escritório confirma. Cenários 1–35 do relatório e 36–47 da autorização.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const F = (p: string) => `/api/v1/finance${p}`;
const post = (c: Client, url: string, body: unknown = {}, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown) =>
  c.req('PUT', url, body, { 'idempotency-key': idemKey() });
const ok = <T>(r: { status: number; body: T }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

type Rec = {
  id: string;
  code: string;
  description: string;
  amountCents: number;
  receivedCents: number;
  openCents: number;
  dueTrigger: string;
  dueDate: string | null;
  effectiveDueDate: string | null;
  overdue: boolean;
  daysOverdue: number;
  expectedMethod: string;
  installments: number | null;
  status: string;
  version: number;
  payments: {
    id: string;
    amountCents: number;
    refund: boolean;
    method: string;
    installments: number | null;
  }[];
  reports: { id: string; status: string; version: number; collected: boolean }[];
};
type Fin = {
  finalCents: number | null;
  billedCents: number;
  receivedCents: number;
  openCents: number;
  overdueCents: number;
  toBillCents: number;
  financialStatus: string;
  itemValuesUsed: boolean;
  revenueEstimated: boolean;
  pieces: {
    orderItemId: string;
    valueCents: number | null;
    attributedCents: number;
    pendingCents: number;
  }[];
  serviceOrders: { id: string; revenueCents: number; estimated: boolean }[];
};

const fin = async (c: Client, orderId: string) => ok<Fin>(await c.get(F(`/orders/${orderId}`)));
const recs = async (c: Client, orderId: string) =>
  ok<Rec[]>(await c.get(F(`/receivables?orderId=${orderId}`))).sort((a, b) =>
    a.code.localeCompare(b.code),
  );
const rec = async (c: Client, id: string) => ok<Rec>(await c.get(F(`/receivables/${id}`)));
const pay = (
  c: Client,
  r: Rec,
  amountCents: number,
  extra: Record<string, unknown> = {},
  key = idemKey(),
) =>
  post(
    c,
    F(`/receivables/${r.id}/payments`),
    { amountCents, receivedAt: today(), method: 'PIX', version: r.version, ...extra },
    key,
  );

const ITEMS = (values?: [number, number]) => [
  {
    pieceType: 'SOFA',
    description: 'Sofá',
    quantity: 1,
    serviceType: 'REFORMA_COMPLETA',
    ...(values ? { agreedValueCents: values[0] } : {}),
  },
  {
    pieceType: 'POLTRONA',
    description: 'Poltrona',
    quantity: 1,
    serviceType: 'TROCA_DE_TECIDO',
    ...(values ? { agreedValueCents: values[1] } : {}),
  },
];

async function logistics(admin: Client) {
  const andre = await userIdOf('André');
  const r = await put(admin, F('/logistics-defaults'), {
    defaultPickupCostCents: 8000,
    defaultDeliveryCostCents: 12000,
    logisticsPayeeUserId: andre,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return andre;
}

/** Novo serviço (R$ 4.000 por padrão) com condição estruturada e, opcionalmente, retirada. */
async function service(
  admin: Client,
  o: {
    value?: number;
    payment?: Record<string, unknown> | null;
    items?: unknown[];
    pickup?: boolean;
    name?: string;
  } = {},
) {
  const customer = await createCustomer(admin, {
    name: o.name ?? `Cliente ${idemKey().slice(0, 5)}`,
    allowSimilar: true,
  });
  const r = await post(admin, '/api/v1/services', {
    customer: { mode: 'EXISTENTE', customerId: customer.id, addressId: customer.addresses[0].id },
    service: {
      contractedService: 'Reforma',
      agreedValueCents: o.value ?? 400000,
      paymentTerms: 'Combinado no orçamento',
      promisedDate: day(30),
      items: o.items ?? ITEMS(),
      payment: o.payment === undefined ? { model: 'ENTRADA_ENTREGA' } : o.payment,
    },
    pickup: o.pickup
      ? { scheduledDate: today(), windowStart: '09:00', team: 'LOGISTICA_TERCEIRIZADA' }
      : null,
  });
  const body = ok<{ order: { id: string }; pickup: { id: string } | null }>(r, 201);
  const order = ok<{
    id: string;
    version: number;
    customer: { id: string };
    items: { id: string; quantity: number }[];
  }>(await admin.get(`/api/v1/orders/${body.order.id}`));
  return { orderId: body.order.id, order, pickupId: body.pickup?.id ?? null, customer };
}

/** Chegada das peças e OS real (como na Etapa 3). */
async function arriveAndOpen(
  admin: Client,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
) {
  ok(await post(admin, '/api/v1/receipts', receiptBody(orderId, lines)), 201);
  // Novo serviço: a OS nasce automaticamente na chegada.
  const sos = await db().serviceOrder.findMany({
    where: { orderId },
    include: { items: true },
    orderBy: { number: 'desc' },
  });
  return sos[0]!;
}

const resultOf = async (c: Client, soId: string) =>
  ok<{ revenueCents: number; revenueEstimated: boolean; warnings: string[] }>(
    await c.get(F(`/service-orders/${soId}`)),
  );

/** Entrega (fato logístico registrado direto: o fluxo da entrega é coberto em quality.test). */
async function deliveryFor(
  so: { id: string; customerId: string; items: { id: string }[] },
  status: 'AGENDADA' | 'FRUSTRADA' | 'CONCLUIDA',
  responsibleUserId: string,
) {
  return db().delivery.create({
    data: {
      customerId: so.customerId,
      addressSnapshot: address,
      scheduledDate: new Date(`${today()}T00:00:00Z`),
      windowStart: '10:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId,
      status,
      completedAt: status === 'CONCLUIDA' ? new Date() : null,
      // Tentativa frustrada devolve as peças à expedição (vínculo inativo).
      items: {
        create: so.items.map((i) => ({ serviceOrderItemId: i.id, active: status !== 'FRUSTRADA' })),
      },
    },
  });
}

const moneyKeys = (v: unknown, path = ''): string[] => {
  if (Array.isArray(v)) return v.flatMap((x, i) => moneyKeys(x, `${path}[${i}]`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => [
      ...(/cents$|price|revenue|margin|cost|valor|preco|amount|salary|payable/i.test(k)
        ? [`${path}.${k}`]
        : []),
      ...moneyKeys(x, `${path}.${k}`),
    ]);
  return [];
};

// ───────────────────────────────────────────────────────────────────────────

describe('Condição estruturada no Novo serviço (AM-1)', () => {
  it('1–4, 11: R$ 4.000 50/50 → entrada (data) + saldo na entrega (sem data); parcial e quitação da entrada', async () => {
    const admin = await loginAdmin(app);
    const { orderId } = await service(admin);
    const [entry, balance] = await recs(admin, orderId);
    expect(entry).toMatchObject({
      description: 'Entrada',
      amountCents: 200000,
      dueTrigger: 'DATA',
      dueDate: today(),
      expectedMethod: 'PIX',
      status: 'ABERTO',
    });
    expect(balance).toMatchObject({
      description: 'Saldo na entrega',
      amountCents: 200000,
      dueTrigger: 'ENTREGA',
      dueDate: null,
      effectiveDueDate: null,
      overdue: false,
    });
    // 3/11. Entrada parcial (R$ 1.500 de R$ 2.000): PARCIAL, faltam R$ 500 — fato preservado.
    let e = ok<Rec>(await pay(admin, entry!, 150000));
    expect(e).toMatchObject({ status: 'PARCIAL', receivedCents: 150000, openCents: 50000 });
    e = ok<Rec>(await pay(admin, e, 50000));
    expect(e).toMatchObject({ status: 'RECEBIDO', openCents: 0 });
    expect(e.payments.map((p) => p.amountCents)).toEqual([150000, 50000]);
    const f = await fin(admin, orderId);
    expect(f).toMatchObject({
      finalCents: 400000,
      receivedCents: 200000,
      openCents: 200000,
      overdueCents: 0,
      financialStatus: 'PARCIAL',
    });
  });

  it('5, 6, 33: 100% Pix; cartão 100% 5× = UMA cobrança com parcelas (sem gateway; parcelas só no cartão)', async () => {
    const admin = await loginAdmin(app);
    const pix = await service(admin, { payment: { model: 'PIX_100' } });
    expect(await recs(admin, pix.orderId)).toMatchObject([
      { amountCents: 400000, expectedMethod: 'PIX', dueTrigger: 'DATA', installments: null },
    ]);
    const card = await service(admin, { payment: { model: 'CARTAO_100', installments: 5 } });
    const [r] = await recs(admin, card.orderId);
    expect(r).toMatchObject({
      amountCents: 400000,
      expectedMethod: 'CARTAO_CREDITO',
      installments: 5,
    });
    expect(await db().customerReceivable.count({ where: { orderId: card.orderId } })).toBe(1);
    // Parcelas em Pix: recusado na validação.
    expect((await pay(admin, r!, 400000, { method: 'PIX', installments: 5 })).status).toBe(400);
    const paid = ok<Rec>(
      await pay(admin, r!, 400000, { method: 'CARTAO_CREDITO', installments: 5 }),
    );
    expect(paid.payments[0]).toMatchObject({ method: 'CARTAO_CREDITO', installments: 5 });
    expect(paid.status).toBe('RECEBIDO');
    // Nada de bandeira, NSU, autorização ou taxa: as colunas não existem.
    const cols = Object.keys((await db().customerPayment.findFirstOrThrow()) as object);
    expect(cols.some((k) => /nsu|brand|bandeira|autoriza|fee|taxa/i.test(k))).toBe(false);
  });

  it('modelo sem valor é recusado; retirada exige retirada; Manual não gera cobrança; pedido nunca pela metade', async () => {
    const admin = await loginAdmin(app);
    const before = await db().commercialOrder.count();
    const drop = await post(admin, '/api/v1/services', {
      customer: {
        mode: 'EXISTENTE',
        customerId: (await createCustomer(admin, { allowSimilar: true })).id,
      },
      service: {
        contractedService: 'Reforma',
        agreedValueCents: 400000,
        promisedDate: day(30),
        items: ITEMS(),
        payment: { model: 'CARTAO_RETIRADA', installments: 10 },
      },
      pickup: null,
    });
    expect(drop.status).toBe(422);
    // Falhou na geração das cobranças: nada foi criado (mesma transação).
    expect(await db().commercialOrder.count()).toBe(before);
    const manual = await service(admin, { payment: { model: 'MANUAL' } });
    expect(await recs(admin, manual.orderId)).toEqual([]);
  });
});

describe('Retirada com cartão, instrução de pagamento e registro da equipe (AM-8/AM-9)', () => {
  it('7, 18–19, 34, 35, 43–45: só o responsável vê; equipe informa; escritório confirma uma vez; instrução some quitada', async () => {
    const admin = await loginAdmin(app);
    const andreId = await logistics(admin);
    const { orderId, pickupId } = await service(admin, {
      payment: { model: 'CARTAO_RETIRADA', installments: 10 },
      pickup: true,
    });
    expect(pickupId).toBeTruthy();
    const pk = await db().pickupRequest.findUniqueOrThrow({ where: { id: pickupId! } });
    expect(pk.logisticsUserId).toBe(andreId);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const izaias = (
      await setupTablet(app, admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '552211' })
    ).tablet;
    await db().logisticsTripParticipant.create({
      data: { pickupId: pickupId!, userId: await userIdOf('Izaías') },
    });

    const jobOf = async (c: Client) =>
      ok<{ id: string; paymentInstruction: Record<string, unknown> | null }[]>(
        await c.get('/api/v1/logistics/jobs'),
      ).find((j) => j.id === pickupId);
    const j = await jobOf(andre);
    expect(j!.paymentInstruction).toMatchObject({
      action: 'PAGAMENTO_NA_RETIRADA',
      amountCents: 400000,
      method: 'CARTAO_CREDITO',
      installments: 10,
      reported: false,
    });
    // 35. Allowlist: o único valor do JSON da equipe é a instrução da própria parada.
    const jobs = ok<unknown[]>(await andre.get('/api/v1/logistics/jobs'));
    expect(moneyKeys(jobs).every((k) => /\.paymentInstruction\.amountCents$/.test(k))).toBe(true);
    expect(JSON.stringify(jobs)).not.toMatch(/agreedValue|finalCents|receivedCents|margin|cost/i);
    // 44. Participante (não responsável) não recebe a instrução.
    const iz = await jobOf(izaias);
    expect(iz?.paymentInstruction ?? null).toBeNull();
    expect(moneyKeys(ok(await izaias.get('/api/v1/logistics/jobs')))).toEqual([]);
    // Roteiro da equipe: a mesma regra.
    const route = ok<{ stops: { job: { id: string; paymentInstruction: unknown } }[] }>(
      await andre.get(`/api/v1/logistics/route?date=${today()}`),
    );
    expect(route.stops.find((s) => s.job.id === pickupId)!.job.paymentInstruction).toMatchObject({
      amountCents: 400000,
    });
    // 34. Equipe sem acesso ao financeiro.
    for (const path of [
      F('/payment-reports'),
      F(`/orders/${orderId}`),
      F('/receivables'),
      F('/balances'),
    ])
      expect((await andre.get(path)).status, path).toBe(403);

    // Retirada realizada: a cobrança vence (evento real) — Central acusa retirado com saldo.
    const v1 = (await db().pickupRequest.findUniqueOrThrow({ where: { id: pickupId! } })).version;
    const s1 = ok<unknown>(
      await post(andre, `/api/v1/logistics/pickups/${pickupId}/step`, {
        step: 'SAIDA',
        version: v1,
      }),
    );
    void s1;
    const v2 = (await db().pickupRequest.findUniqueOrThrow({ where: { id: pickupId! } })).version;
    ok(
      await post(andre, `/api/v1/logistics/pickups/${pickupId}/step`, {
        step: 'RETIRADA_REALIZADA',
        version: v2,
      }),
    );
    const [r] = await recs(admin, orderId);
    expect(r).toMatchObject({ effectiveDueDate: today(), overdue: true, daysOverdue: 0 });
    const att = ok<{ items: { key: string; category: string; title: string }[] }>(
      await admin.get('/api/v1/attention'),
    );
    expect(att.items.find((i) => i.key === `COBRANCA:VENCIDA:${r!.id}`)).toMatchObject({
      category: 'CRITICO',
    });

    // A equipe informa: registro operacional, nenhum recebimento.
    const key = idemKey();
    const body = {
      receivableId: r!.id,
      collected: true,
      method: 'CARTAO_CREDITO',
      note: 'Passou 10×',
    };
    const rep1 = await post(
      andre,
      `/api/v1/logistics/pickups/${pickupId}/payment-report`,
      body,
      key,
    );
    expect(rep1.status, JSON.stringify(rep1.body)).toBe(200);
    // 43. Repetição com a mesma chave: mesma resposta; com outra chave: recusado (409).
    const rep2 = await post(
      andre,
      `/api/v1/logistics/pickups/${pickupId}/payment-report`,
      body,
      key,
    );
    expect(rep2.body).toEqual(rep1.body);
    expect(
      (await post(andre, `/api/v1/logistics/pickups/${pickupId}/payment-report`, body)).status,
    ).toBe(409);
    expect(await db().customerPayment.count()).toBe(0);
    expect(await db().customerPaymentReport.count()).toBe(1);
    // Izaías não pode informar (não é o responsável).
    expect(
      (await post(izaias, `/api/v1/logistics/pickups/${pickupId}/payment-report`, body)).status,
    ).toBe(422);
    expect((await jobOf(andre))!.paymentInstruction).toMatchObject({ reported: true });

    // Escritório vê e confirma; dupla confirmação impossível.
    const reports = ok<{ id: string; version: number; status: string }[]>(
      await admin.get(F('/payment-reports')),
    );
    expect(reports).toHaveLength(1);
    const att2 = ok<{ items: { key: string }[] }>(await admin.get('/api/v1/attention'));
    expect(att2.items.some((i) => i.key === `COBRANCA:INFORMADO:${reports[0]!.id}`)).toBe(true);
    const confirmBody = {
      amountCents: 400000,
      receivedAt: today(),
      method: 'CARTAO_CREDITO',
      installments: 10,
      version: reports[0]!.version,
    };
    const [c1, c2] = await Promise.all([
      post(admin, F(`/payment-reports/${reports[0]!.id}/confirm`), confirmBody),
      post(admin, F(`/payment-reports/${reports[0]!.id}/confirm`), confirmBody),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([200, 409]);
    expect(await db().customerPayment.count()).toBe(1);
    const paid = await rec(admin, r!.id);
    expect(paid).toMatchObject({ status: 'RECEBIDO', overdue: false });
    expect(paid.payments[0]).toMatchObject({ installments: 10, method: 'CARTAO_CREDITO' });
    // 45. Quitada: a instrução some do tablet.
    expect((await jobOf(andre))!.paymentInstruction).toBeNull();
  });
});

describe('Saldo na entrega (AM-4/AM-5)', () => {
  it('8, 24–26, 42: frustrada não vence; concluída sem pagamento vence e a Central acusa; equipe informa, escritório confirma', async () => {
    const admin = await loginAdmin(app);
    const andreId = await logistics(admin);
    const { orderId, order } = await service(admin);
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const [entry, balance] = await recs(admin, orderId);
    ok(await pay(admin, entry!, 200000));
    // 42. Entrega frustrada: nada vence.
    await deliveryFor(so, 'FRUSTRADA', andreId);
    expect(await rec(admin, balance!.id)).toMatchObject({ overdue: false, effectiveDueDate: null });
    // 24. Entrega agendada com saldo: aviso (saldo por entrega) e Central (entrega próxima).
    const scheduled = await deliveryFor(so, 'AGENDADA', andreId);
    const balances = ok<{ openCents: number; dueOnDeliveryCents: number }[]>(
      await admin.get(F(`/balances?deliveryId=${scheduled.id}`)),
    );
    expect(balances).toMatchObject([{ openCents: 200000, dueOnDeliveryCents: 200000 }]);
    const att = ok<{ items: { key: string; category: string }[] }>(
      await admin.get('/api/v1/attention'),
    );
    expect(att.items.find((i) => i.key === `COBRANCA:ENTREGA:${scheduled.id}`)).toMatchObject({
      category: 'ACAO',
    });
    // Instrução para o responsável na entrega.
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const job = ok<
      { id: string; paymentInstruction: { action: string; amountCents: number } | null }[]
    >(await andre.get('/api/v1/logistics/jobs')).find((x) => x.id === scheduled.id);
    expect(job!.paymentInstruction).toMatchObject({
      action: 'PAGAMENTO_NA_ENTREGA',
      amountCents: 200000,
    });
    // 26. Concluída sem pagamento: vence; Central "entregue com saldo" (crítico); não bloqueia nada.
    // Conclusão como no fluxo real: cada peça registrada como entregue (Fase 8: o gatilho ENTREGA
    // exige peça efetivamente entregue numa entrega concluída).
    await db().deliveryItem.updateMany({
      where: { deliveryId: scheduled.id },
      data: { status: 'ENTREGUE', deliveredAt: new Date() },
    });
    await db().delivery.update({
      where: { id: scheduled.id },
      data: { status: 'CONCLUIDA', completedAt: new Date() },
    });
    const due = await rec(admin, balance!.id);
    expect(due).toMatchObject({ overdue: true, effectiveDueDate: today() });
    const f = await fin(admin, orderId);
    expect(f).toMatchObject({ overdueCents: 200000, financialStatus: 'VENCIDO' });
    const att2 = ok<{ items: { key: string; category: string; title: string }[] }>(
      await admin.get('/api/v1/attention'),
    );
    expect(att2.items.find((i) => i.key === `COBRANCA:VENCIDA:${balance!.id}`)).toMatchObject({
      category: 'CRITICO',
      title: expect.stringContaining('ENTREGUE COM SALDO'),
    });
    // Inadimplência: filtro de vencidas.
    const overdue = ok<Rec[]>(await admin.get(F('/receivables?overdue=1')));
    expect(overdue.map((x) => x.id)).toEqual([balance!.id]);
    // 8. Pagamento na entrega: equipe informa Pix; escritório confirma.
    ok(
      await post(andre, `/api/v1/logistics/deliveries/${scheduled.id}/payment-report`, {
        receivableId: balance!.id,
        collected: true,
        method: 'PIX',
      }),
    );
    const [report] = ok<{ id: string; version: number }[]>(await admin.get(F('/payment-reports')));
    ok(
      await post(admin, F(`/payment-reports/${report!.id}/confirm`), {
        amountCents: 200000,
        receivedAt: today(),
        method: 'PIX',
        version: report!.version,
      }),
    );
    expect(await fin(admin, orderId)).toMatchObject({
      financialStatus: 'QUITADO',
      overdueCents: 0,
      openCents: 0,
    });
  });

  it('25: "não houve pagamento" informado fica para o escritório descartar; descarte duplo é recusado', async () => {
    const admin = await loginAdmin(app);
    const andreId = await logistics(admin);
    const { orderId, order } = await service(admin);
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const d = await deliveryFor(so, 'AGENDADA', andreId);
    const [, balance] = await recs(admin, orderId);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    ok(
      await post(andre, `/api/v1/logistics/deliveries/${d.id}/payment-report`, {
        receivableId: balance!.id,
        collected: false,
      }),
    );
    const r = await rec(admin, balance!.id);
    expect(r.reports).toMatchObject([{ status: 'PENDENTE', collected: false }]);
    const body = { reason: 'Cliente pagará por Pix amanhã', version: r.reports[0]!.version };
    const [a, b] = await Promise.all([
      post(admin, F(`/payment-reports/${r.reports[0]!.id}/discard`), body),
      post(admin, F(`/payment-reports/${r.reports[0]!.id}/discard`), body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db().customerPayment.count()).toBe(0);
  });
});

describe('Pagamentos (parcial, vários, a maior, data futura, estorno)', () => {
  it('9, 10, 12, 46: Pix + dinheiro + cartão; acima do saldo bloqueado com o saldo; data futura recusada; passada aceita', async () => {
    const admin = await loginAdmin(app);
    const { orderId } = await service(admin);
    let [entry, balance] = await recs(admin, orderId);
    entry = ok<Rec>(await pay(admin, entry!, 100000, { method: 'PIX' }));
    entry = ok<Rec>(await pay(admin, entry, 100000, { method: 'DINHEIRO' }));
    expect(entry).toMatchObject({ status: 'RECEBIDO', receivedCents: 200000 });
    // 12. Acima do saldo: bloqueado, mensagem com o saldo disponível.
    const over = await pay(admin, balance!, 200001, { method: 'CARTAO_CREDITO', installments: 3 });
    expect(over.status).toBe(422);
    expect(JSON.stringify(over.body)).toMatch(/2\.000,00/);
    // 46. Data futura recusada; 29/30: data passada (semana já conferida) aceita.
    expect((await pay(admin, balance!, 1000, { receivedAt: day(1) })).status).toBe(422);
    balance = ok<Rec>(
      await pay(admin, balance!, 200000, {
        method: 'CARTAO_CREDITO',
        installments: 3,
        receivedAt: day(-10),
      }),
    );
    const all = await db().customerPayment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(all.map((p) => [p.method, p.amountCents])).toEqual([
      ['PIX', 100000],
      ['DINHEIRO', 100000],
      ['CARTAO_CREDITO', 200000],
    ]);
    expect(await fin(admin, orderId)).toMatchObject({
      financialStatus: 'QUITADO',
      receivedCents: 400000,
    });
  });

  it('estorno: versão conferida, fuso da oficina, nunca deixa o recebido negativo após reembolso', async () => {
    const admin = await loginAdmin(app);
    const { orderId } = await service(admin, { payment: { model: 'PIX_100' } });
    let [r] = await recs(admin, orderId);
    r = ok<Rec>(await pay(admin, r!, 400000));
    const payId = r.payments[0]!.id;
    // Reembolso parcial de R$ 500 sobre o mesmo recebimento.
    ok(
      await post(admin, F(`/orders/${orderId}/refunds`), {
        amountCents: 50000,
        refundedAt: today(),
        method: 'PIX',
        reason: 'Desconto pós-venda devolvido',
      }),
    );
    r = await rec(admin, r.id);
    const rev = await post(admin, F(`/receivables/${r.id}/payments/${payId}/reverse`), {
      reason: 'Erro',
      version: r.version,
    });
    expect(rev.status).toBe(422);
    expect(JSON.stringify(rev.body)).toMatch(/reembolsada/);
  });
});

describe('Alteração de valor (AM-6, AM-13)', () => {
  it('13, 15: edição direta antes da primeira cobrança (com evento); depois, só ajuste; 4.000 → 4.500 libera saldo a lançar', async () => {
    const admin = await loginAdmin(app);
    const { orderId, order } = await service(admin, { payment: { model: 'MANUAL' } });
    const full = ok<
      Record<string, unknown> & { version: number; items: Record<string, unknown>[] }
    >(await admin.get(`/api/v1/orders/${orderId}`));
    const body = (value: number, version: number) => ({
      contractedService: 'Reforma',
      agreedValueCents: value,
      items: full.items.map((i) => ({
        id: i.id,
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
      })),
      version,
    });
    const edited = ok<{ version: number }>(
      await put(admin, `/api/v1/orders/${orderId}`, body(410000, full.version)),
    );
    const events = await db().financialEvent.findMany({ where: { entityId: orderId } });
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['VALOR_FECHADO', 'VALOR_ALTERADO']),
    );
    ok(
      await post(admin, F('/receivables'), {
        orderId,
        description: 'Entrada',
        amountCents: 200000,
        dueDate: today(),
        expectedMethod: 'PIX',
      }),
      201,
    );
    const blocked = await put(admin, `/api/v1/orders/${orderId}`, body(450000, edited.version));
    expect(blocked.status).toBe(422);
    expect(JSON.stringify(blocked.body)).toMatch(/ajuste comercial/);
    // 13. Acréscimo por ajuste: 4.100 → 4.500.
    ok(
      await post(admin, F(`/orders/${orderId}/adjustments`), {
        kind: 'ACRESCIMO',
        amountCents: 40000,
        reason: 'Cliente incluiu almofadas',
      }),
    );
    expect(await fin(admin, orderId)).toMatchObject({ finalCents: 450000, toBillCents: 250000 });
    void order;
  });

  it('14, 41: desconto 4.000 → 3.800 reduz a cobrança aberta mais distante; com parcial exige decisão explícita; desconto × pagamento concorrentes', async () => {
    const admin = await loginAdmin(app);
    const { orderId } = await service(admin);
    const [entry, balance] = await recs(admin, orderId);
    ok(await pay(admin, entry!, 200000));
    ok(
      await post(admin, F(`/orders/${orderId}/adjustments`), {
        kind: 'DESCONTO',
        amountCents: 20000,
        reason: 'Desconto à vista',
      }),
    );
    expect(await rec(admin, balance!.id)).toMatchObject({ amountCents: 180000, status: 'ABERTO' });
    expect(await fin(admin, orderId)).toMatchObject({ finalCents: 380000, billedCents: 380000 });
    // Saldo agora parcial: nova redução não é automática.
    let b = ok<Rec>(await pay(admin, await rec(admin, balance!.id), 100000));
    const refused = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'DESCONTO',
      amountCents: 10000,
      reason: 'Mais desconto',
    });
    expect(refused.status).toBe(422);
    expect(await db().commercialAdjustment.count({ where: { orderId } })).toBe(1);
    ok(
      await post(admin, F(`/orders/${orderId}/adjustments`), {
        kind: 'DESCONTO',
        amountCents: 10000,
        reason: 'Mais desconto (decisão do gestor)',
        receivableReductions: [{ receivableId: balance!.id, amountCents: 10000 }],
      }),
    );
    b = await rec(admin, balance!.id);
    expect(b).toMatchObject({ amountCents: 170000, receivedCents: 100000, status: 'PARCIAL' });
    // Abaixo do recebido: exige reembolso.
    expect(
      (
        await post(admin, F(`/orders/${orderId}/adjustments`), {
          kind: 'DESCONTO',
          amountCents: 80000,
          reason: 'Demais',
        })
      ).status,
    ).toBe(422);
    // 41. Desconto × pagamento simultâneos: serializados (pedido → cobrança), invariantes preservados.
    const [d1, p1] = await Promise.all([
      post(admin, F(`/orders/${orderId}/adjustments`), {
        kind: 'DESCONTO',
        amountCents: 50000,
        reason: 'Corrida',
        receivableReductions: [{ receivableId: balance!.id, amountCents: 50000 }],
      }),
      pay(admin, b, 70000),
    ]);
    expect([200, 422, 409]).toContain(d1.status);
    expect([200, 409, 422]).toContain(p1.status);
    const f = await fin(admin, orderId);
    expect(f.billedCents).toBeLessThanOrEqual(f.finalCents!);
    expect(f.receivedCents).toBeLessThanOrEqual(f.finalCents!);
    const rows = await db().customerReceivable.findMany({ where: { orderId } });
    for (const x of rows) expect(x.receivedCents).toBeLessThanOrEqual(x.amountCents);
  });
});

describe('Valor por peça e receita por OS (AM-2/AM-3)', () => {
  it('16–18, 36–38: sofá 3.000 + poltrona 1.000; soma diferente recusada; chegada parcial estável', async () => {
    const admin = await loginAdmin(app);
    // 38. Soma diferente do valor fechado: recusada (nada criado).
    const before = await db().commercialOrder.count();
    const customer = await createCustomer(admin, { allowSimilar: true });
    const bad = await post(admin, '/api/v1/services', {
      customer: { mode: 'EXISTENTE', customerId: customer.id, addressId: customer.addresses[0].id },
      service: {
        contractedService: 'Reforma',
        agreedValueCents: 400000,
        promisedDate: day(30),
        items: ITEMS([300000, 90000]),
      },
      pickup: null,
    });
    expect(bad.status).toBe(422);
    const partial = await post(admin, '/api/v1/services', {
      customer: { mode: 'EXISTENTE', customerId: customer.id, addressId: customer.addresses[0].id },
      service: {
        contractedService: 'Reforma',
        agreedValueCents: 400000,
        promisedDate: day(30),
        items: [ITEMS([300000, 100000])[0], ITEMS()[1]],
      },
      pickup: null,
    });
    expect(partial.status).toBe(422);
    expect(await db().commercialOrder.count()).toBe(before);

    const { orderId, order } = await service(admin, { items: ITEMS([300000, 100000]) });
    const [sofa, armchair] = order.items;
    // 36. Só o sofá chegou: OS do sofá = 3.000 (não 4.000).
    const so1 = await arriveAndOpen(admin, orderId, [{ orderItemId: sofa!.id, quantity: 1 }]);
    let r1 = await resultOf(admin, so1.id);
    expect(r1).toMatchObject({ revenueCents: 300000, revenueEstimated: false });
    let f = await fin(admin, orderId);
    expect(f.pieces.find((p) => p.orderItemId === armchair!.id)).toMatchObject({
      pendingCents: 100000,
      attributedCents: 0,
    });
    // 37. A poltrona chega depois: OS do sofá continua 3.000; OS da poltrona = 1.000.
    const so2 = await arriveAndOpen(admin, orderId, [{ orderItemId: armchair!.id, quantity: 1 }]);
    expect(so2.id).not.toBe(so1.id);
    r1 = await resultOf(admin, so1.id);
    expect(r1.revenueCents).toBe(300000);
    expect((await resultOf(admin, so2.id)).revenueCents).toBe(100000);
    f = await fin(admin, orderId);
    expect(f.itemValuesUsed).toBe(true);
    expect(f.serviceOrders.map((s) => s.revenueCents).sort()).toEqual([100000, 300000]);
    // A entrada paga no pedido não duplica receita em nenhuma OS (caixa ≠ receita).
    const [entry] = await recs(admin, orderId);
    ok(await pay(admin, entry!, 200000));
    expect((await resultOf(admin, so1.id)).revenueCents).toBe(300000);
    // Distribuição manual não se aplica a pedido com valor por peça.
    expect(
      (
        await put(admin, F(`/orders/${orderId}/revenue-split`), {
          shares: [{ serviceOrderId: so1.id, revenueCents: 1 }],
          reason: 'Teste',
        })
      ).status,
    ).toBe(422);
  });

  it('39, 19: ajuste exige redistribuição coerente; peça cancelada/devolvida não transfere receita', async () => {
    const admin = await loginAdmin(app);
    const { orderId, order } = await service(admin, {
      items: ITEMS([300000, 100000]),
      payment: { model: 'MANUAL' },
    });
    const [sofa, armchair] = order.items;
    const noDist = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'ACRESCIMO',
      amountCents: 50000,
      reason: 'Almofadas',
    });
    expect(noDist.status).toBe(422);
    expect(JSON.stringify(noDist.body)).toMatch(/valor por peça/);
    const wrong = await post(admin, F(`/orders/${orderId}/adjustments`), {
      kind: 'ACRESCIMO',
      amountCents: 50000,
      reason: 'Almofadas',
      itemValues: [
        { orderItemId: sofa!.id, agreedValueCents: 300000 },
        { orderItemId: armchair!.id, agreedValueCents: 100000 },
      ],
    });
    expect(wrong.status).toBe(422);
    expect(await db().commercialAdjustment.count()).toBe(0);
    ok(
      await post(admin, F(`/orders/${orderId}/adjustments`), {
        kind: 'ACRESCIMO',
        amountCents: 50000,
        reason: 'Almofadas',
        itemValues: [
          { orderItemId: sofa!.id, agreedValueCents: 350000 },
          { orderItemId: armchair!.id, agreedValueCents: 100000 },
        ],
      }),
    );
    expect((await fin(admin, orderId)).pieces.map((p) => p.valueCents)).toEqual([350000, 100000]);
    // 19. Duas peças em OS; a poltrona é cancelada na OS: a receita dela não passa para o sofá.
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const armItem = so.items.find((i) => i.orderItemId === armchair!.id)!;
    await db().serviceOrderItem.update({
      where: { id: armItem.id },
      data: { fulfillmentStage: 'CANCELADA' },
    });
    const r = await resultOf(admin, so.id);
    expect(r.revenueCents).toBe(350000);
    expect(
      (await fin(admin, orderId)).pieces.find((p) => p.orderItemId === armchair!.id),
    ).toMatchObject({ pendingCents: 100000 });
  });

  it('sem valores por peça: fallback preservado e sinalizado como estimado', async () => {
    const admin = await loginAdmin(app);
    const { orderId, order } = await service(admin, { payment: { model: 'MANUAL' } });
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const r = await resultOf(admin, so.id);
    expect(r).toMatchObject({ revenueCents: 400000, revenueEstimated: true });
    expect(r.warnings.join(' ')).toMatch(/Receita estimada/);
  });
});

describe('Cancelamento e reembolso (AM-7, AM-11)', () => {
  it('20, 47: pedido cancelado sem pagamento não deixa cobrança aberta', async () => {
    const admin = await loginAdmin(app);
    const { orderId, order } = await service(admin);
    ok(
      await post(admin, `/api/v1/orders/${orderId}/cancel`, {
        reason: 'Cliente desistiu',
        version: order.version,
      }),
    );
    const rows = await db().customerReceivable.findMany({ where: { orderId } });
    expect(rows.map((r) => r.status)).toEqual(['CANCELADO', 'CANCELADO']);
    const att = ok<{ items: { type: string }[] }>(await admin.get('/api/v1/attention'));
    expect(att.items.filter((i) => i.type === 'COBRANCA')).toEqual([]);
  });

  it('21: cancelado depois da entrada exige decisão; reter integral ou reter parte e reembolsar o resto', async () => {
    const admin = await loginAdmin(app);
    const a = await service(admin);
    const [entry] = await recs(admin, a.orderId);
    ok(await pay(admin, entry!, 200000));
    const noDecision = await post(admin, `/api/v1/orders/${a.orderId}/cancel`, {
      reason: 'Desistiu',
      version: a.order.version,
    });
    expect(noDecision.status).toBe(422);
    expect(
      (await db().commercialOrder.findUniqueOrThrow({ where: { id: a.orderId } })).status,
    ).not.toBe('CANCELADO');
    ok(
      await post(admin, `/api/v1/orders/${a.orderId}/cancel`, {
        reason: 'Desistiu',
        version: a.order.version,
        finance: { retainedCents: 200000 },
      }),
    );
    let rows = await db().customerReceivable.findMany({
      where: { orderId: a.orderId },
      orderBy: { number: 'asc' },
    });
    expect(rows.map((r) => [r.status, r.amountCents, r.receivedCents])).toEqual([
      ['RECEBIDO', 200000, 200000],
      ['CANCELADO', 200000, 0],
    ]);
    let f = await fin(admin, a.orderId);
    expect(f).toMatchObject({ finalCents: 200000, receivedCents: 200000, openCents: 0 });

    // Reter R$ 500 e reembolsar R$ 1.500.
    const b = await service(admin);
    const [eb] = await recs(admin, b.orderId);
    ok(await pay(admin, eb!, 200000));
    ok(
      await post(admin, `/api/v1/orders/${b.orderId}/cancel`, {
        reason: 'Desistiu',
        version: b.order.version,
        finance: { retainedCents: 50000, refund: { refundedAt: today(), method: 'PIX' } },
      }),
    );
    f = await fin(admin, b.orderId);
    expect(f).toMatchObject({ finalCents: 50000, receivedCents: 50000, openCents: 0 });
    const refunds = await db().customerPayment.findMany({
      where: { refund: true, receivable: { orderId: b.orderId } },
    });
    expect(refunds.map((r) => r.amountCents)).toEqual([-150000]);
    expect(refunds[0]!.reversalOfId).toBeNull();
    rows = await db().customerReceivable.findMany({
      where: { orderId: b.orderId, status: { in: ['ABERTO', 'PARCIAL'] } },
    });
    expect(rows).toEqual([]);
  });

  it('22, 40: reembolso parcial (saldo não reaparece); nunca acima do recebido; concorrente determinístico', async () => {
    const admin = await loginAdmin(app);
    const { orderId } = await service(admin);
    const [entry] = await recs(admin, orderId);
    ok(await pay(admin, entry!, 200000));
    ok(
      await post(admin, F(`/orders/${orderId}/refunds`), {
        amountCents: 50000,
        refundedAt: today(),
        method: 'PIX',
        reason: 'Devolução parcial combinada',
      }),
    );
    let f = await fin(admin, orderId);
    expect(f).toMatchObject({ finalCents: 350000, receivedCents: 150000, openCents: 200000 });
    expect(await rec(admin, entry!.id)).toMatchObject({
      amountCents: 150000,
      receivedCents: 150000,
      status: 'RECEBIDO',
    });
    expect(
      (
        await post(admin, F(`/orders/${orderId}/refunds`), {
          amountCents: 150001,
          refundedAt: today(),
          method: 'PIX',
          reason: 'Demais',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(admin, F(`/orders/${orderId}/refunds`), {
          amountCents: 100,
          refundedAt: day(1),
          method: 'PIX',
          reason: 'Futuro',
        })
      ).status,
    ).toBe(422);
    // 40. Dois reembolsos de R$ 1.000 em paralelo sobre R$ 1.500: só um passa.
    const body = { amountCents: 100000, refundedAt: today(), method: 'PIX', reason: 'Paralelo' };
    const [a, b] = await Promise.all([
      post(admin, F(`/orders/${orderId}/refunds`), body),
      post(admin, F(`/orders/${orderId}/refunds`), body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    f = await fin(admin, orderId);
    expect(f).toMatchObject({ receivedCents: 50000, finalCents: 250000 });
    // Histórico preservado: recebimento original, reembolsos marcados, nada apagado.
    const pays = await db().customerPayment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(pays.map((p) => [p.amountCents, p.refund])).toEqual([
      [200000, false],
      [-50000, true],
      [-100000, true],
    ]);
    await expect(db().customerPayment.deleteMany()).rejects.toThrow();
  });

  it('23: OS cancelada — receita da OS zera; cobranças continuam do pedido', async () => {
    const admin = await loginAdmin(app);
    const { orderId, order } = await service(admin, { items: ITEMS([300000, 100000]) });
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    ok(
      await post(admin, `/api/v1/service-orders/${so.id}/cancel`, {
        reason: 'Cliente desistiu da OS',
        version: so.version,
      }),
    );
    expect((await resultOf(admin, so.id)).revenueCents).toBe(0);
    expect((await recs(admin, orderId)).map((r) => r.status)).toEqual(['ABERTO', 'ABERTO']);
  });
});

describe('Concorrência e idempotência', () => {
  it('27, 28: dois usuários baixando a mesma cobrança; repetição da baixa; cobranças diferentes do mesmo pedido', async () => {
    const admin = await loginAdmin(app);
    const other = await loginAdmin(app);
    const { orderId } = await service(admin);
    const [entry, balance] = await recs(admin, orderId);
    const [a, b] = await Promise.all([pay(admin, entry!, 200000), pay(other, entry!, 200000)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const key = idemKey();
    const r1 = await pay(admin, balance!, 50000, {}, key);
    const r2 = await pay(admin, balance!, 50000, {}, key);
    expect(r2.body).toEqual(r1.body);
    expect(await db().customerPayment.count()).toBe(2);
    // Cobranças diferentes do mesmo pedido em paralelo: ambas passam (serializadas).
    const c = await service(admin);
    const [e2, b2] = await recs(admin, c.orderId);
    const [x, y] = await Promise.all([pay(admin, e2!, 100000), pay(admin, b2!, 100000)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect((await fin(admin, c.orderId)).receivedCents).toBe(200000);
  });

  it('pagamento × cancelamento, pagamento × edição direta, cancelamento × confirmação da equipe: sem deadlock nem cobrança fantasma', async () => {
    const admin = await loginAdmin(app);
    // Pagamento × cancelamento.
    const a = await service(admin);
    const [ea] = await recs(admin, a.orderId);
    const [p, c] = await Promise.all([
      pay(admin, ea!, 200000),
      post(admin, `/api/v1/orders/${a.orderId}/cancel`, {
        reason: 'Corrida',
        version: a.order.version,
      }),
    ]);
    const order = await db().commercialOrder.findUniqueOrThrow({ where: { id: a.orderId } });
    if (order.status === 'CANCELADO') {
      expect(c.status).toBe(200);
      // A cobrança foi cancelada junto (versão nova): recusa determinística.
      expect([409, 422]).toContain(p.status);
      expect(
        await db().customerReceivable.count({
          where: { orderId: a.orderId, status: { in: ['ABERTO', 'PARCIAL'] } },
        }),
      ).toBe(0);
    } else {
      expect(p.status).toBe(200);
      expect(c.status).toBe(422); // exige decisão (havia recebido)
    }
    // Pagamento × edição direta do valor (pedido manual com uma cobrança).
    const b = await service(admin, { payment: { model: 'PIX_100' } });
    const full = ok<{ version: number; items: Record<string, unknown>[] }>(
      await admin.get(`/api/v1/orders/${b.orderId}`),
    );
    const [rb] = await recs(admin, b.orderId);
    const [pp, ed] = await Promise.all([
      pay(admin, rb!, 400000),
      put(admin, `/api/v1/orders/${b.orderId}`, {
        contractedService: 'Reforma',
        agreedValueCents: 300000,
        items: full.items.map((i) => ({
          id: i.id,
          pieceType: i.pieceType,
          description: i.description,
          quantity: i.quantity,
        })),
        version: full.version,
      }),
    ]);
    expect(pp.status).toBe(200);
    expect(ed.status).toBe(422);
    expect((await fin(admin, b.orderId)).finalCents).toBe(400000);
    // Cancelamento × confirmação da equipe.
    const andreId = await logistics(admin);
    const d = await service(admin);
    const so = await arriveAndOpen(
      admin,
      d.orderId,
      d.order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    void so;
    const del = await db().delivery.create({
      data: {
        customerId: d.customer.id,
        addressSnapshot: address,
        scheduledDate: new Date(`${today()}T00:00:00Z`),
        status: 'AGENDADA',
        responsibleUserId: andreId,
        items: { create: so.items.map((i) => ({ serviceOrderItemId: i.id })) },
      },
    });
    const [, balance] = await recs(admin, d.orderId);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    ok(
      await post(andre, `/api/v1/logistics/deliveries/${del.id}/payment-report`, {
        receivableId: balance!.id,
        collected: true,
        method: 'PIX',
      }),
    );
    const [rep] = ok<{ id: string; version: number }[]>(await admin.get(F('/payment-reports')));
    // Peças recebidas: o pedido não pode ser cancelado (regra existente) → só a confirmação passa.
    const [conf, canc] = await Promise.all([
      post(admin, F(`/payment-reports/${rep!.id}/confirm`), {
        amountCents: 200000,
        receivedAt: today(),
        method: 'PIX',
        version: rep!.version,
      }),
      post(admin, `/api/v1/orders/${d.orderId}/cancel`, {
        reason: 'Corrida',
        version: d.order.version,
      }),
    ]);
    expect(conf.status).toBe(200);
    expect(canc.status).not.toBe(200);
    expect(await db().customerPayment.count({ where: { receivableId: balance!.id } })).toBe(1);
  });

  it('reembolso × pagamento simultâneos: serializados, sem deadlock; recebido nunca negativo nem acima do valor', async () => {
    const admin = await loginAdmin(app);
    for (let round = 0; round < 3; round++) {
      const { orderId } = await service(admin);
      const [entry, balance] = await recs(admin, orderId);
      ok(await pay(admin, entry!, 200000));
      const [rf, pb] = await Promise.all([
        post(admin, F(`/orders/${orderId}/refunds`), {
          amountCents: 100000,
          refundedAt: today(),
          method: 'PIX',
          reason: 'Corrida',
        }),
        pay(admin, balance!, 200000),
      ]);
      expect(rf.status, JSON.stringify(rf.body)).toBe(200);
      expect([200, 409]).toContain(pb.status);
      const f = await fin(admin, orderId);
      expect(f.finalCents).toBe(300000);
      expect(f.receivedCents).toBe(pb.status === 200 ? 300000 : 100000);
      for (const x of await db().customerReceivable.findMany({ where: { orderId } }))
        expect(x.receivedCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('cancelamento sem peças × confirmação: o registro pendente é descartado junto, confirmação recusada', async () => {
    const admin = await loginAdmin(app);
    const andreId = await logistics(admin);
    const { orderId, pickupId, order } = await service(admin, {
      payment: { model: 'CARTAO_RETIRADA', installments: 2 },
      pickup: true,
    });
    expect(
      (await db().pickupRequest.findUniqueOrThrow({ where: { id: pickupId! } })).logisticsUserId,
    ).toBe(andreId);
    const andre = (
      await setupTablet(app, admin, { name: 'Celular André', employee: 'André', pin: '640218' })
    ).tablet;
    const [r] = await recs(admin, orderId);
    ok(
      await post(andre, `/api/v1/logistics/pickups/${pickupId}/payment-report`, {
        receivableId: r!.id,
        collected: false,
      }),
    );
    const [rep] = ok<{ id: string; version: number }[]>(await admin.get(F('/payment-reports')));
    ok(
      await post(admin, `/api/v1/orders/${orderId}/cancel`, {
        reason: 'Desistiu',
        version: order.version,
      }),
    );
    expect(
      (await db().customerPaymentReport.findUniqueOrThrow({ where: { id: rep!.id } })).status,
    ).toBe('DESCARTADO');
    expect(
      (
        await post(admin, F(`/payment-reports/${rep!.id}/confirm`), {
          amountCents: 1000,
          receivedAt: today(),
          method: 'PIX',
          version: rep!.version,
        })
      ).status,
    ).toBe(409);
  });
});

describe('Receita × caixa, quitação antecipada e fechamento semanal', () => {
  it('31, 32, 29, 30: Resultado usa receita econômica (não caixa); quitado antes da chegada; fechamento intacto', async () => {
    const admin = await loginAdmin(app);
    const { orderId, order } = await service(admin, {
      payment: { model: 'PIX_100' },
      items: ITEMS([300000, 100000]),
    });
    const [r] = await recs(admin, orderId);
    // 32. Quitado antes da chegada.
    ok(await pay(admin, r!, 400000, { receivedAt: day(-3) }));
    expect(await fin(admin, orderId)).toMatchObject({ financialStatus: 'QUITADO' });
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    // 31. Receita da OS = contratada, independentemente do caixa.
    expect((await resultOf(admin, so.id)).revenueCents).toBe(400000);
    // 29/30. Fechamento semanal não envolve clientes: as linhas continuam só de pagar.
    const monday = (() => {
      const d = new Date(`${today()}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const closing = await admin.get(F(`/weekly-closings/${monday}`));
    expect(closing.status).toBe(200);
    expect(JSON.stringify(closing.body)).not.toMatch(/RC-\d|customer_receivable/);
  });
});

/**
 * Fase 8 (decisão do proprietário): o gatilho ENTREGA só considera peça EFETIVAMENTE entregue
 * (registrada como entregue/entregue com divergência) numa entrega CONCLUÍDA. Associação
 * histórica, "não entregue", peça retirada antes da saída e tentativa frustrada não contam.
 * A entrega parcial REAL continua vencendo o saldo (regra comercial atual, inalterada).
 */
describe('Gatilho ENTREGA — só entrega física efetiva (Fase 8)', () => {
  type Line = { status: 'ENTREGUE' | 'DIVERGENTE' | 'NAO_ENTREGUE' | 'PENDENTE'; active: boolean };
  /** Entrega com o estado final de cada peça (como a conclusão/edição real deixa). */
  async function deliveryWith(
    so: { customerId: string; items: { id: string }[] },
    status: 'CONCLUIDA' | 'FRUSTRADA' | 'AGENDADA',
    lines: Line[],
    responsibleUserId: string,
  ) {
    return db().delivery.create({
      data: {
        customerId: so.customerId,
        addressSnapshot: address,
        scheduledDate: new Date(`${today()}T00:00:00Z`),
        windowStart: '10:00',
        team: 'LOGISTICA_TERCEIRIZADA',
        responsibleUserId,
        status,
        completedAt: status === 'CONCLUIDA' ? new Date() : null,
        items: {
          create: lines.map((l, n) => ({
            serviceOrderItemId: so.items[n]!.id,
            status: l.status,
            active: l.active,
            deliveredAt: ['ENTREGUE', 'DIVERGENTE'].includes(l.status) ? new Date() : null,
          })),
        },
      },
    });
  }
  async function setup() {
    const admin = await loginAdmin(app);
    const andreId = await logistics(admin);
    const { orderId, order } = await service(admin);
    const so = await arriveAndOpen(
      admin,
      orderId,
      order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const [entry, balance] = await recs(admin, orderId);
    ok(await pay(admin, entry!, 200000));
    return { admin, andreId, orderId, so, balance: balance! };
  }
  const critical = async (admin: Client, receivableId: string) =>
    ok<{ items: { key: string; category: string; title: string }[] }>(
      await admin.get('/api/v1/attention'),
    ).items.find((i) => i.key === `COBRANCA:VENCIDA:${receivableId}`);

  it('A, E. concluída com as peças do pedido "não entregue": não vence e a Central não acusa', async () => {
    const t = await setup();
    await deliveryWith(
      t.so,
      'CONCLUIDA',
      [
        { status: 'NAO_ENTREGUE', active: false },
        { status: 'NAO_ENTREGUE', active: false },
      ],
      t.andreId,
    );
    expect(await rec(t.admin, t.balance.id)).toMatchObject({
      overdue: false,
      effectiveDueDate: null,
    });
    expect(await critical(t.admin, t.balance.id)).toBeUndefined();
  });

  it('B. peças retiradas da entrega antes da saída: a conclusão da entrega não vence o saldo', async () => {
    const t = await setup();
    await deliveryWith(
      t.so,
      'CONCLUIDA',
      [
        { status: 'PENDENTE', active: false },
        { status: 'PENDENTE', active: false },
      ],
      t.andreId,
    );
    expect(await rec(t.admin, t.balance.id)).toMatchObject({
      overdue: false,
      effectiveDueDate: null,
    });
  });

  it('C, G. tentativa frustrada e tentativa anterior não entregue não fazem a peça parecer entregue', async () => {
    const t = await setup();
    // Tentativa 1: concluída sem as peças deste pedido; tentativa 2: frustrada; atual: agendada.
    await deliveryWith(
      t.so,
      'CONCLUIDA',
      [
        { status: 'NAO_ENTREGUE', active: false },
        { status: 'NAO_ENTREGUE', active: false },
      ],
      t.andreId,
    );
    await deliveryWith(
      t.so,
      'FRUSTRADA',
      [
        { status: 'PENDENTE', active: false },
        { status: 'PENDENTE', active: false },
      ],
      t.andreId,
    );
    await deliveryWith(
      t.so,
      'AGENDADA',
      [
        { status: 'PENDENTE', active: true },
        { status: 'PENDENTE', active: true },
      ],
      t.andreId,
    );
    expect(await rec(t.admin, t.balance.id)).toMatchObject({
      overdue: false,
      effectiveDueDate: null,
    });
    expect(await critical(t.admin, t.balance.id)).toBeUndefined();
  });

  it('D, F. entrega parcial REAL (uma peça entregue, outra não): vence pela regra atual e a Central acusa', async () => {
    const t = await setup();
    await deliveryWith(
      t.so,
      'CONCLUIDA',
      [
        { status: 'ENTREGUE', active: true },
        { status: 'NAO_ENTREGUE', active: false },
      ],
      t.andreId,
    );
    expect(await rec(t.admin, t.balance.id)).toMatchObject({
      overdue: true,
      effectiveDueDate: today(),
    });
    expect(await critical(t.admin, t.balance.id)).toMatchObject({
      category: 'CRITICO',
      title: expect.stringContaining('ENTREGUE COM SALDO'),
    });
    // Entregue com divergência também é entrega física efetiva.
    const t2 = await setup();
    await deliveryWith(
      t2.so,
      'CONCLUIDA',
      [
        { status: 'DIVERGENTE', active: true },
        { status: 'PENDENTE', active: false },
      ],
      t2.andreId,
    );
    expect(await rec(t2.admin, t2.balance.id)).toMatchObject({ overdue: true });
  });

  it('idempotência: consultar de novo não cria cobrança nem muda o vencimento', async () => {
    const t = await setup();
    await deliveryWith(
      t.so,
      'CONCLUIDA',
      [
        { status: 'ENTREGUE', active: true },
        { status: 'ENTREGUE', active: true },
      ],
      t.andreId,
    );
    const before = await db().customerReceivable.count({ where: { orderId: t.orderId } });
    const a = await rec(t.admin, t.balance.id);
    const b = await rec(t.admin, t.balance.id);
    expect(a.effectiveDueDate).toBe(b.effectiveDueDate);
    await critical(t.admin, t.balance.id);
    expect(await db().customerReceivable.count({ where: { orderId: t.orderId } })).toBe(before);
  });
});
