import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, naEmpresa1, resetDatabase } from './helpers';
import {
  address,
  createCustomer,
  createOrder,
  generateOsFromOrder,
  markArrived,
  panelUserWith,
} from './commercial-helpers';
import { day } from './production-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Ajustes do Raphael (2026-11-18):
 *  A. Novo serviço: à vista = 50% na retirada + 50% na entrega; parcelado com a taxa da
 *     maquininha da Base de dados do orçamento.
 *  B. Financeiro: Despesas (tudo que saiu) e Receitas (tudo que entrou), com lançamentos avulsos.
 *  C. Retrabalhos: pedido próprio sem cobrança, marcado em pedido/OS, estatística e cancelamento.
 *  D. Página da OS para a oficina (sem valores) e acesso só de quem tem tarefa nela.
 *  E. Resumo da semana e gráficos do Início.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
});

const post = (c: Client, path: string, body: unknown = {}) =>
  c.post(path, body, { 'idempotency-key': idemKey() });

function service(payment: object, withPickup = true, n = 1) {
  return {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: `Cliente Fictício Ajustes ${n}`,
      phone: `(11) 97777-123${n}`,
      address: { ...address, isPrimary: true },
    },
    service: {
      contractedService: 'Reforma completa',
      agreedValueCents: 100001,
      deliveryBusinessDays: 10,
      promisedDate: day(20),
      items: [
        {
          pieceType: 'SOFA',
          description: 'Sofá 3 lugares',
          quantity: 1,
          serviceType: 'REFORMA_COMPLETA',
        },
      ],
      payment,
    },
    pickup: withPickup
      ? { scheduledDate: day(2), windowStart: '09:30', team: 'LOGISTICA_TERCEIRIZADA' }
      : null,
  };
}

describe('A. forma de pagamento do Novo serviço', () => {
  it('à vista: metade na retirada e metade na entrega (sem retirada, a primeira vence hoje)', async () => {
    const admin = await loginAdmin(app);
    const r = await post(
      admin,
      '/api/v1/services',
      service({ model: 'METADE_RETIRADA_ENTREGA', entryMethod: 'PIX', balanceMethod: 'PIX' }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const recv = await db().customerReceivable.findMany({
      where: { orderId: r.body.order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(recv.map((x) => [x.amountCents, x.dueTrigger])).toEqual([
      [50001, 'RETIRADA'],
      [50000, 'ENTREGA'],
    ]);

    const r2 = await post(
      admin,
      '/api/v1/services',
      service({ model: 'METADE_RETIRADA_ENTREGA', entryMethod: 'DINHEIRO' }, false, 2),
    );
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const recv2 = await db().customerReceivable.findMany({
      where: { orderId: r2.body.order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(recv2.map((x) => [x.dueTrigger, x.expectedMethod])).toEqual([
      ['DATA', 'DINHEIRO'],
      ['ENTREGA', 'DINHEIRO'],
    ]);
    expect(recv2[0]!.dueDate).not.toBeNull();
  });

  it('as taxas da maquininha da Base de dados chegam ao Novo serviço', async () => {
    const admin = await loginAdmin(app);
    await naEmpresa1(() =>
      db().quoteCatalogItem.createMany({
        data: [
          { kind: 'TAXA_MAQUINA', name: '3X', rateBps: 520 },
          { kind: 'TAXA_MAQUINA', name: '10x', rateBps: 1290 },
          { kind: 'TAXA_MAQUINA', name: 'À vista', rateBps: 100 },
        ],
      }),
    );
    const d = await admin.get('/api/v1/services/new-defaults');
    expect(d.status).toBe(200);
    expect(d.body.cardFees).toEqual([
      { installments: 3, rateBps: 520 },
      { installments: 10, rateBps: 1290 },
    ]);
    // Parcelado na retirada: uma cobrança no cartão, na retirada.
    const r = await post(
      admin,
      '/api/v1/services',
      service({ model: 'CARTAO_RETIRADA', installments: 3 }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const recv = await db().customerReceivable.findMany({ where: { orderId: r.body.order.id } });
    expect(recv).toHaveLength(1);
    expect(recv[0]).toMatchObject({ dueTrigger: 'RETIRADA', installments: 3 });
  });
});

describe('B. Receitas e Despesas', () => {
  it('despesa avulsa vira conta paga; receita avulsa entra e sai do total ao cancelar', async () => {
    const admin = await loginAdmin(app);
    const today = day(0);
    const e = await post(admin, '/api/v1/finance/cash-out', {
      date: today,
      description: 'Compra de grampos',
      beneficiary: 'Loja do Bairro',
      category: 'MATERIAL',
      amountCents: 4590,
      method: 'PIX',
    });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    const out = (await admin.get(`/api/v1/finance/cash-out?from=${today}&to=${today}`)).body as J;
    const line = out.lines.find((l: J) => l.description === 'Compra de grampos');
    expect(line).toMatchObject({
      source: 'DESPESA_AVULSA',
      amountCents: 4590,
      party: 'Loja do Bairro',
    });
    expect(out.totalCents).toBeGreaterThanOrEqual(4590);
    const payable = await db().accountPayable.findFirstOrThrow({
      where: { description: 'Compra de grampos' },
    });
    expect(payable).toMatchObject({ status: 'PAGO', paidCents: 4590 });

    const rv = await post(admin, '/api/v1/finance/cash-in', {
      date: today,
      description: 'Venda de sobra de tecido',
      category: 'Venda de material',
      amountCents: 12000,
      method: 'DINHEIRO',
    });
    expect(rv.status, JSON.stringify(rv.body)).toBe(201);
    const inn = (await admin.get(`/api/v1/finance/cash-in?from=${today}&to=${today}`)).body as J;
    const rev = inn.lines.find((l: J) => l.source === 'RECEITA_AVULSA');
    expect(rev).toMatchObject({ amountCents: 12000, manual: true, cancelled: false });
    expect(inn.totalCents).toBe(12000);

    const c = await admin.post(`/api/v1/finance/cash-in/${rev.id}/cancel`, {
      reason: 'Lançada errado',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const after = (await admin.get(`/api/v1/finance/cash-in?from=${today}&to=${today}`)).body as J;
    expect(after.totalCents).toBe(0);
    expect(after.lines[0].cancelled).toBe(true);
  });

  it('sem financeiro.gerenciar não lança; sem financeiro.ver não consulta', async () => {
    const admin = await loginAdmin(app);
    const viewer = await panelUserWith(app, admin, 'leitor', ['financeiro.ver']);
    expect((await viewer.get('/api/v1/finance/cash-in')).status).toBe(200);
    const denied = await post(viewer, '/api/v1/finance/cash-in', {
      date: day(0),
      description: 'Teste',
      category: 'Outros',
      amountCents: 100,
      method: 'PIX',
    });
    expect(denied.status).toBe(403);
    const none = await panelUserWith(app, admin, 'sem', ['pedidos.ver']);
    expect((await none.get('/api/v1/finance/cash-out')).status).toBe(403);
  });
});

describe('C. Retrabalhos', () => {
  it('cadastra o retrabalho como pedido sem cobrança, marca o pedido e entra na estatística', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    const cand = await admin.get('/api/v1/reworks/candidates?q=');
    expect(cand.status).toBe(200);
    expect(cand.body.map((c: J) => c.id)).toContain(order.id);

    const r = await post(admin, '/api/v1/reworks', {
      originalOrderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      reason: 'Costura do braço abriu',
      cause: 'ERRO_EXECUCAO',
      deliveryBusinessDays: 5,
      pickup: null,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      code: 'RT-00001',
      stage: 'AGUARDANDO_PECAS',
      cause: 'ERRO_EXECUCAO',
    });
    const reworkOrder = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: true },
    });
    expect(reworkOrder.agreedValueCents).toBeNull();
    expect(reworkOrder.items.map((i) => [i.description, i.quantity])).toEqual([
      ['Sofá 3 lugares', 1],
    ]);
    expect(await db().customerReceivable.count({ where: { orderId: reworkOrder.id } })).toBe(0);

    // O pedido do retrabalho aparece marcado na lista de pedidos.
    const orders = (await admin.get('/api/v1/orders')).body as J;
    const mine = (orders.items ?? orders).find((o: J) => o.id === reworkOrder.id);
    expect(mine.rework).toEqual({ id: r.body.id, code: 'RT-00001' });

    // Pedido de retrabalho não pode virar outro retrabalho.
    const again = await post(admin, '/api/v1/reworks', {
      originalOrderId: reworkOrder.id,
      items: [{ orderItemId: reworkOrder.items[0]!.id, quantity: 1 }],
      reason: 'De novo',
      cause: 'OUTRO',
      deliveryBusinessDays: 5,
    });
    expect(again.status).toBe(422);

    const stats = await admin.get(`/api/v1/reworks/stats?from=${day(-1)}&to=${day(1)}`);
    expect(stats.status).toBe(200);
    expect(stats.body.count).toBe(1);
    expect(stats.body.byCause).toEqual([{ cause: 'ERRO_EXECUCAO', count: 1 }]);
    expect(stats.body.cost.totalCents).toBe(0);

    // Gerar a OS do retrabalho quando as peças chegarem: a OS sai marcada.
    await markArrived(reworkOrder.id, [{ orderItemId: reworkOrder.items[0]!.id, quantity: 1 }]);
    const list = (await admin.get('/api/v1/reworks')).body as J[];
    expect(list[0]).toMatchObject({ stage: 'NA_OFICINA', canGenerateOs: true });
    const so = await generateOsFromOrder(admin, reworkOrder.id);
    const sos = (await admin.get(`/api/v1/service-orders?orderId=${reworkOrder.id}`)).body as J;
    expect((sos.items ?? sos)[0].rework).toEqual({ id: r.body.id, code: 'RT-00001' });
    expect(so).toBeTruthy();

    // Com OS ativa, não cancela.
    const cancel = await admin.post(`/api/v1/reworks/${r.body.id}/cancel`, {
      version: r.body.version,
      reason: 'Cliente desistiu',
    });
    expect(cancel.status).toBe(422);
  });

  it('cancela o retrabalho antes de as peças chegarem', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    const r = await post(admin, '/api/v1/reworks', {
      originalOrderId: order.id,
      items: [{ orderItemId: order.items[1].id, quantity: 2 }],
      reason: 'Tecido manchou',
      cause: 'DEFEITO_MATERIAL',
      deliveryBusinessDays: 3,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = await admin.post(`/api/v1/reworks/${r.body.id}/cancel`, {
      version: r.body.version,
      reason: 'Resolvido na casa do cliente',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const o = await db().commercialOrder.findUniqueOrThrow({ where: { id: r.body.order.id } });
    expect(o.status).toBe('CANCELADO');
    const stats = await admin.get(`/api/v1/reworks/stats?from=${day(-1)}&to=${day(1)}`);
    expect(stats.body.count).toBe(0);
  });
});

describe('D. página da OS', () => {
  it('mostra os detalhes sem valores; quem não tem tarefa na OS não abre', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    await markArrived(
      order.id,
      order.items.map((i: J) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const so = await generateOsFromOrder(admin, order.id);
    const s = await admin.get(`/api/v1/service-orders/${so.id}/sheet`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ code: so.code, customerName: customer.name, rework: null });
    expect(s.body.items).toHaveLength(2);
    expect(JSON.stringify(s.body)).not.toMatch(/Cents/);

    const worker = await panelUserWith(app, admin, 'tapeceiro', ['producao.executar']);
    expect((await worker.get(`/api/v1/service-orders/${so.id}/sheet`)).status).toBe(403);
  });
});

describe('E. Resumo da semana e gráficos', () => {
  it('traz os números novos e os três gráficos para quem pode ver', async () => {
    const admin = await loginAdmin(app);
    const w = await admin.get('/api/v1/management/week');
    expect(w.status).toBe(200);
    expect(w.body.money).toMatchObject({ paidCents: 0, billsDueCount: 0 });
    expect(w.body.production).toMatchObject({ lateOs: 0, reworks: 0 });
    expect(w.body.pickups).toMatchObject({ done: 0 });

    const c = await admin.get('/api/v1/management/charts');
    expect(c.status).toBe(200);
    expect(c.body.cash).toHaveLength(8);
    expect(c.body.stages.map((x: J) => x.key)).toEqual([
      'retirada',
      'oficina',
      'producao',
      'qualidade',
      'entrega',
    ]);
    expect(c.body.quotes).toHaveLength(6);

    const sales = await panelUserWith(app, admin, 'vendas', ['pedidos.ver']);
    const c2 = await sales.get('/api/v1/management/charts');
    expect(c2.status).toBe(200);
    expect(c2.body.cash).toBeNull();
    expect(c2.body.stages).not.toBeNull();
  });
});
