import { addWorkingDays, deadlineWindowEnd } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, panelUserWith, receiptBody } from './commercial-helpers';
import { today, userIdOf } from './production-helpers';

/**
 * Prazos e serviços em risco — regra única do estado do prazo (OS e pedido), Central de
 * atenção (PRAZO_OS / PRAZO_PEDIDO), prazo editável do pedido com "aplicar às OS abertas",
 * permissões, tempo real e a regra absoluta: PRAZO NÃO REORGANIZA A FILA (D9 intacta).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(() => setClock());

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });
const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WD = [1, 2, 3, 4, 5];
const T = () => today();
const inWindow = () => deadlineWindowEnd(T(), WD);
const outside = () => addWorkingDays(T(), 6, WD);
const yesterday = () => shift(T(), -1);

type Item = {
  key: string;
  type: string;
  category: string;
  title: string;
  description: string;
  status: string;
  impacts: string[];
  nextActions: string[];
  serviceOrder: { id: string } | null;
};
const attention = async (c: Client, qs = '') =>
  (await c.get(`/api/v1/attention${qs}`)).body as {
    counts: Record<string, number>;
    items: Item[];
  };
const deadlineItems = async (c: Client) =>
  (await attention(c)).items.filter((i) => i.type === 'PRAZO_OS' || i.type === 'PRAZO_PEDIDO');

/** OS manual com as peças recebidas (todas EM_PRODUCAO), com prazo e sem planejamento. */
async function os(
  admin: Client,
  name: string,
  promised: string | null,
  pieces = [{ pieceType: 'SOFA', description: 'Sofá' }],
) {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(
    admin,
    customer,
    pieces.map((p) => ({ ...p, quantity: 1 })),
  );
  expect(
    (
      await post(
        admin,
        '/api/v1/receipts',
        receiptBody(
          order.id,
          order.items.map((i: { id: string }) => ({ orderItemId: i.id, quantity: 1 })),
        ),
      )
    ).status,
  ).toBe(201);
  const so = await post(admin, '/api/v1/service-orders', {
    orderId: order.id,
    promisedDate: promised,
    items: order.items.map((i: { id: string }, k: number) => ({
      orderItemId: i.id,
      quantity: 1,
      description: pieces[k]!.description,
      serviceType: 'REFORMA_COMPLETA',
    })),
  });
  expect(so.status, JSON.stringify(so.body)).toBe(201);
  return so.body as { id: string; code: string; items: { id: string }[] };
}
/** Planejada (fila semanal) e com uma tarefa já concluída = planejada e iniciada. */
async function planAndStart(admin: Client, so: { id: string; items: { id: string }[] }) {
  const ricardo = await userIdOf('Ricardo');
  const r = await post(admin, '/api/v1/production/plan-services', {
    entries: [
      {
        serviceOrderId: so.id,
        startDate: T(),
        pieces: so.items.map((i) => ({ serviceOrderItemId: i.id, upholstererUserId: ricardo })),
      },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const first = await db().productionTask.findFirstOrThrow({
    where: { serviceOrderId: so.id },
    orderBy: { sequence: 'asc' },
  });
  await db().productionTask.update({
    where: { id: first.id },
    data: { status: 'CONCLUIDA', startedAt: new Date(), completedAt: new Date() },
  });
  return r.body.planned[0].planId as string;
}
const stage = (so: { items: { id: string }[] }, s: string, idx = 0) =>
  db().serviceOrderItem.update({ where: { id: so.items[idx]!.id }, data: { fulfillmentStage: s } });
const soDto = async (c: Client, id: string) => (await c.get(`/api/v1/service-orders/${id}`)).body;

// ─────────────────────────── OS: estado e Central ───────────────────────────

describe('Estado do prazo da OS na Central, na lista e no detalhe (fonte única)', () => {
  it('ATRASADO entra sem motivo; PROXIMO e NO_PRAZO não entram; SEM_PRAZO, cancelada, entregue e devolvida ficam fora', async () => {
    const admin = await loginAdmin(app);
    const late = await os(admin, 'Cliente Atrasado', yesterday());
    await planAndStart(admin, late);
    const near = await os(admin, 'Cliente Próximo', inWindow());
    await planAndStart(admin, near);
    const today0 = await os(admin, 'Cliente Hoje', T());
    await planAndStart(admin, today0);
    const far = await os(admin, 'Cliente Longe', outside());
    const none = await os(admin, 'Cliente Sem Prazo', null);
    const cancelled = await os(admin, 'Cliente Cancelada', yesterday());
    expect(
      (
        await post(admin, `/api/v1/service-orders/${cancelled.id}/cancel`, {
          reason: 'Cliente desistiu',
          version: (await soDto(admin, cancelled.id)).version,
        })
      ).status,
    ).toBe(200);
    const delivered = await os(admin, 'Cliente Entregue', yesterday());
    await stage(delivered, 'ENTREGUE');
    const returned = await os(admin, 'Cliente Devolvida', yesterday());
    await stage(returned, 'DEVOLVIDA');

    expect((await soDto(admin, late.id)).deadline).toMatchObject({
      state: 'ATRASADO',
      reasons: [],
    });
    expect((await soDto(admin, near.id)).deadline.state).toBe('PROXIMO');
    expect((await soDto(admin, today0.id)).deadline.state).toBe('PROXIMO');
    expect((await soDto(admin, far.id)).deadline.state).toBe('NO_PRAZO');
    expect((await soDto(admin, none.id)).deadline.state).toBe('SEM_PRAZO');
    expect((await soDto(admin, cancelled.id)).deadline.state).toBe('ENCERRADA');
    expect((await soDto(admin, delivered.id)).deadline.state).toBe('ENCERRADA');
    expect((await soDto(admin, returned.id)).deadline.state).toBe('ENCERRADA');

    const items = await deadlineItems(admin);
    expect(items.map((i) => i.serviceOrder?.id)).toEqual([late.id]);
    expect(items[0]).toMatchObject({
      key: `PRAZO_OS:${late.id}`,
      category: 'CRITICO',
      status: 'ATRASADO',
      impacts: [],
    });
    expect(items[0]!.title).toContain('ATRASADO');
    expect(items[0]!.nextActions[0]).toMatch(/Renegociar o prazo/);
    // Lista de OS: mesmo estado do detalhe e da Central.
    const list = (await admin.get('/api/v1/service-orders?limit=100')).body.items as {
      id: string;
      deadline: { state: string };
    }[];
    const byId = new Map(list.map((x) => [x.id, x.deadline.state]));
    expect(byId.get(late.id)).toBe('ATRASADO');
    expect(byId.get(near.id)).toBe('PROXIMO');
    expect(byId.get(none.id)).toBe('SEM_PRAZO');
  });

  it('EM_RISCO: um item por OS com os motivos agregados; cada motivo pela API', async () => {
    const admin = await loginAdmin(app);
    // Não planejada + materiais pendentes: UM item com os dois motivos.
    const a = await os(admin, 'Cliente Não Planejada', inWindow(), [
      { pieceType: 'SOFA', description: 'Sofá' },
      { pieceType: 'POLTRONA', description: 'Poltrona' },
    ]);
    await db().serviceOrder.update({
      where: { id: a.id },
      data: { materialsReadiness: 'AGUARDANDO_COMPRA' },
    });
    // Planejada, não iniciada.
    const b = await os(admin, 'Cliente Não Iniciada', inWindow());
    expect(
      (
        await post(admin, '/api/v1/production/plan-services', {
          entries: [
            {
              serviceOrderId: b.id,
              startDate: T(),
              pieces: [
                {
                  serviceOrderItemId: b.items[0]!.id,
                  upholstererUserId: await userIdOf('Ricardo'),
                },
              ],
            },
          ],
        })
      ).status,
    ).toBe(201);
    // Bloqueada (bloqueio manual do gestor numa tarefa).
    const c = await os(admin, 'Cliente Bloqueada', inWindow());
    await planAndStart(admin, c);
    const task = await db().productionTask.findFirstOrThrow({
      where: { serviceOrderId: c.id, status: { not: 'CONCLUIDA' } },
      orderBy: { sequence: 'asc' },
    });
    await db().productionTask.update({
      where: { id: task.id },
      data: { status: 'BLOQUEADA', blockers: ['BLOQUEIO'], blockedReason: 'Aguardando cliente' },
    });
    // Em correção e pronta sem entrega (convivem com os itens da qualidade/logística).
    const d = await os(admin, 'Cliente Em Correção', inWindow());
    await planAndStart(admin, d);
    await stage(d, 'EM_CORRECAO');
    const e = await os(admin, 'Cliente Pronta', inWindow());
    await planAndStart(admin, e);
    await stage(e, 'PRONTA_ENTREGA');

    const items = await deadlineItems(admin);
    const of = (so: { id: string }) => items.filter((i) => i.serviceOrder?.id === so.id);
    for (const so of [a, b, c, d, e]) expect(of(so)).toHaveLength(1);
    expect(of(a)[0]).toMatchObject({ category: 'ACAO', status: 'EM_RISCO' });
    expect(of(a)[0]!.impacts).toEqual(['Ainda não planejada', 'Materiais pendentes']);
    expect(of(a)[0]!.nextActions).toEqual([
      'Planejar a OS (Produção → A planejar)',
      'Conferir os materiais da OS',
    ]);
    expect(of(b)[0]!.impacts).toEqual(['Produção ainda não iniciada']);
    expect(of(c)[0]!.impacts).toEqual(['Produção bloqueada']);
    expect(of(d)[0]!.impacts).toEqual(['Peça em correção']);
    expect(of(e)[0]!.impacts).toEqual(['Pronta, sem entrega agendada']);
    // A ação de agendar a entrega fica só no item da LOGÍSTICA (sem repetir no item de prazo).
    expect(of(e)[0]!.nextActions).toEqual([]);
    const all = (await attention(admin)).items;
    expect(all.some((i) => i.key === `LOGISTICA:pronta:${e.items[0]!.id}`)).toBe(true);
  });

  it('entrega depois do prazo, entrega frustrada (contexto do cliente) e entrega parcial', async () => {
    const admin = await loginAdmin(app);
    const mk = async (name: string, promised: string) => {
      const so = await os(admin, name, promised, [
        { pieceType: 'SOFA', description: 'Sofá' },
        { pieceType: 'POLTRONA', description: 'Poltrona' },
      ]);
      await planAndStart(admin, so);
      return so;
    };
    const delivery = async (
      so: { id: string; items: { id: string }[] },
      status: string,
      scheduledDate: string,
      idx = 0,
    ) => {
      const s = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
      const d = await db().delivery.create({
        data: {
          customerId: s.customerId,
          addressSnapshot: {},
          scheduledDate: new Date(`${scheduledDate}T00:00:00.000Z`),
          status: status as never,
          items: { create: [{ serviceOrderItemId: so.items[idx]!.id }] },
        },
      });
      return d;
    };
    const after = await mk('Cliente Entrega Depois', inWindow());
    await stage(after, 'ENTREGA_AGENDADA', 0);
    await stage(after, 'ENTREGUE', 1);
    await delivery(after, 'AGENDADA', shift(inWindow(), 3));
    const frustrated = await mk('Cliente Frustrada', yesterday());
    await stage(frustrated, 'PRONTA_ENTREGA', 0);
    await stage(frustrated, 'ENTREGUE', 1);
    const d = await delivery(frustrated, 'FRUSTRADA', yesterday());
    await db().logisticsOccurrence.create({
      data: { kind: 'CLIENTE_INDISPONIVEL', deliveryId: d.id, description: 'Ninguém em casa' },
    });
    const items = await deadlineItems(admin);
    const of = (so: { id: string }) => items.find((i) => i.serviceOrder?.id === so.id)!;
    expect(of(after)).toMatchObject({ status: 'EM_RISCO' });
    expect(of(after).impacts).toEqual(['Entrega agendada depois do prazo']);
    // Atrasado, com a causa conhecida como contexto (continua ATRASADO).
    expect(of(frustrated)).toMatchObject({ status: 'ATRASADO', category: 'CRITICO' });
    expect(of(frustrated).impacts).toEqual(['Entrega frustrada, ainda não reagendada']);
    expect(of(frustrated).description).toContain('Cliente indisponível para entrega.');
    // Entrega parcial: a peça entregue não encerra a OS.
    expect((await soDto(admin, frustrated.id)).deadline.state).toBe('ATRASADO');
  });

  it('várias OS do mesmo pedido: um item por OS; chegada parcial herda o prazo vigente do pedido', async () => {
    const admin = await loginAdmin(app);
    const r = await post(admin, '/api/v1/services', {
      customer: { mode: 'NOVO', kind: 'PF', name: 'Cliente Duas OS', phone: '(11) 97777-1111' },
      service: {
        contractedService: 'Reforma',
        promisedDate: yesterday(),
        items: [
          { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
          { pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1, serviceType: 'REPARO' },
        ],
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    const receive = (itemId: string) =>
      post(admin, '/api/v1/receipts', {
        orderId: order.id,
        pickupId: null,
        origin: 'ENTREGUE_PELO_CLIENTE',
        lines: [{ orderItemId: itemId, quantity: 1, condition: 'BOA', location: 'Recepção' }],
      });
    expect((await receive(order.items[0]!.id)).status).toBe(201);
    // Antes da segunda chegada: um item da OS e um do pedido (peça faltando), sem confusão.
    let items = await deadlineItems(admin);
    expect(items.map((i) => i.type).sort()).toEqual(['PRAZO_OS', 'PRAZO_PEDIDO']);
    expect(items.find((i) => i.type === 'PRAZO_PEDIDO')).toMatchObject({
      key: `PRAZO_PEDIDO:${order.id}`,
      category: 'CRITICO',
      status: 'PRAZO_VENCIDO',
    });
    expect(items.find((i) => i.type === 'PRAZO_PEDIDO')!.description).toContain(
      'Peça ainda não recebida: 1× Poltrona',
    );
    expect((await receive(order.items[1]!.id)).status).toBe(201);
    items = await deadlineItems(admin);
    expect(items.filter((i) => i.type === 'PRAZO_PEDIDO')).toEqual([]);
    expect(items.filter((i) => i.type === 'PRAZO_OS')).toHaveLength(2);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it('fuso da empresa: 02h UTC ainda é "ontem" em São Paulo — prazo de hoje (local) não está vencido', async () => {
    const admin = await loginAdmin(app);
    // 02h UTC de amanhã (calendário) = 23h de hoje em São Paulo.
    const utcDay = shift(T(), 1);
    setClock(() => new Date(`${utcDay}T02:00:00Z`));
    const local = T();
    expect(local).toBe(shift(utcDay, -1));
    const so = await os(admin, 'Cliente Fuso', local);
    await planAndStart(admin, so);
    expect((await soDto(admin, so.id)).deadline.state).toBe('PROXIMO');
    expect(await deadlineItems(admin)).toEqual([]);
  });
});

// ─────────────────────────── Pedido: peças ainda não recebidas ───────────────────────────

describe('Atenção do pedido antes da OS (peças ainda não recebidas)', () => {
  it('prazo próximo com peça não recebida aparece; a chegada faz o alerta sumir; fora da janela, nada', async () => {
    const admin = await loginAdmin(app);
    const mk = async (name: string, promised: string, phone: string) => {
      const r = await post(admin, '/api/v1/services', {
        customer: { mode: 'NOVO', kind: 'PF', name, phone },
        service: {
          contractedService: 'Reforma',
          promisedDate: promised,
          items: [
            {
              pieceType: 'SOFA',
              description: 'Sofá',
              quantity: 1,
              serviceType: 'REFORMA_COMPLETA',
            },
          ],
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.order.id as string;
    };
    const near = await mk('Cliente Pedido Próximo', inWindow(), '(11) 96666-1111');
    await mk('Cliente Pedido Longe', outside(), '(11) 96666-2222');
    let items = await deadlineItems(admin);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: `PRAZO_PEDIDO:${near}`,
      type: 'PRAZO_PEDIDO',
      category: 'ACAO',
      status: 'PRAZO_PROXIMO',
      serviceOrder: null,
    });
    expect(items[0]!.title).toContain('PRAZO PRÓXIMO');
    expect(items[0]!.description).toContain('Peça ainda não recebida');
    expect((await admin.get(`/api/v1/orders/${near}`)).body.deadline).toBe('PRAZO_PROXIMO');
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: near },
      include: { items: true },
    });
    expect(
      (
        await post(admin, '/api/v1/receipts', {
          orderId: near,
          pickupId: null,
          origin: 'ENTREGUE_PELO_CLIENTE',
          lines: [
            {
              orderItemId: order.items[0]!.id,
              quantity: 1,
              condition: 'BOA',
              location: 'Recepção',
            },
          ],
        })
      ).status,
    ).toBe(201);
    items = await deadlineItems(admin);
    expect(items.filter((i) => i.type === 'PRAZO_PEDIDO')).toEqual([]);
    expect((await admin.get(`/api/v1/orders/${near}`)).body.deadline).toBeNull();
    // A OS nascida na chegada herdou o prazo vigente do pedido.
    const so = await db().serviceOrder.findFirstOrThrow({ where: { orderId: near } });
    expect(so.promisedDate?.toISOString().slice(0, 10)).toBe(inWindow());
  });

  it('Novo serviço exige o prazo prometido; nada é criado sem ele', async () => {
    const admin = await loginAdmin(app);
    const before = await db().commercialOrder.count();
    const r = await post(admin, '/api/v1/services', {
      customer: { mode: 'NOVO', kind: 'PF', name: 'Cliente Sem Prazo', phone: '(11) 95555-1111' },
      service: {
        contractedService: 'Reforma',
        items: [
          { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        ],
      },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('service.promisedDate');
    expect(await db().commercialOrder.count()).toBe(before);
  });
});

// ─────────────────────────── Prazo do pedido editável ───────────────────────────

describe('Prazo do pedido: edição com motivo, histórico e "aplicar às OS abertas?"', () => {
  /** Pedido do Novo serviço com 3 peças; as 2 primeiras chegam em chegadas separadas (2 OS). */
  async function scenario(admin: Client) {
    const r = await post(admin, '/api/v1/services', {
      customer: {
        mode: 'NOVO',
        kind: 'PF',
        name: 'Cliente Prazo Pedido',
        phone: '(11) 94444-1111',
      },
      service: {
        contractedService: 'Reforma',
        promisedDate: inWindow(),
        items: ['Sofá', 'Poltrona', 'Cadeira'].map((d) => ({
          pieceType: d === 'Sofá' ? 'SOFA' : d === 'Poltrona' ? 'POLTRONA' : 'CADEIRA',
          description: d,
          quantity: 1,
          serviceType: 'REFORMA_COMPLETA',
        })),
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.order.id as string;
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    const receive = async (k: number) => {
      const rc = await post(admin, '/api/v1/receipts', {
        orderId: id,
        pickupId: null,
        origin: 'ENTREGUE_PELO_CLIENTE',
        lines: [
          { orderItemId: order.items[k]!.id, quantity: 1, condition: 'BOA', location: 'Recepção' },
        ],
      });
      expect(rc.status, JSON.stringify(rc.body)).toBe(201);
      return rc.body.generatedServiceOrder.id as string;
    };
    const os1 = await receive(0);
    const os2 = await receive(1);
    return { id, order, receive, os1, os2 };
  }
  const change = (c: Client, id: string, body: Record<string, unknown>, key = idemKey()) =>
    put(c, `/api/v1/orders/${id}/promised-date`, body, key);
  const version = async (id: string) =>
    (await db().commercialOrder.findUniqueOrThrow({ where: { id } })).version;
  const promised = async (soId: string) =>
    (await db().serviceOrder.findUniqueOrThrow({ where: { id: soId } })).promisedDate
      ?.toISOString()
      .slice(0, 10);

  it('motivo obrigatório, versão, permissões (pedido e OS) e sem atualização silenciosa', async () => {
    const admin = await loginAdmin(app);
    const s = await scenario(admin);
    const next = outside();
    // Sem motivo / sem a resposta explícita: recusado.
    expect(
      (
        await change(admin, s.id, {
          promisedDate: next,
          applyToServiceOrders: false,
          version: await version(s.id),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await change(admin, s.id, {
          promisedDate: next,
          reason: 'Cliente pediu',
          version: await version(s.id),
        })
      ).status,
    ).toBe(400);
    // Versão antiga: 409.
    expect(
      (
        await change(admin, s.id, {
          promisedDate: next,
          reason: 'Cliente pediu',
          applyToServiceOrders: false,
          version: 999,
        })
      ).status,
    ).toBe(409);
    // Só vê pedidos: 403. Gerencia pedidos mas não OS: pode mudar o pedido, não as OS.
    const viewer = await panelUserWith(app, admin, 'ped-ver', ['pedidos.ver']);
    expect(
      (
        await change(viewer, s.id, {
          promisedDate: next,
          reason: 'Cliente pediu',
          applyToServiceOrders: false,
          version: await version(s.id),
        })
      ).status,
    ).toBe(403);
    const orders = await panelUserWith(app, admin, 'ped-ger', ['pedidos.ver', 'pedidos.gerenciar']);
    expect(
      (
        await change(orders, s.id, {
          promisedDate: next,
          reason: 'Cliente pediu',
          applyToServiceOrders: true,
          version: await version(s.id),
        })
      ).status,
    ).toBe(403);
    expect(await promised(s.os1)).toBe(inWindow());
    expect(
      (
        await change(orders, s.id, {
          promisedDate: next,
          reason: 'Cliente pediu',
          applyToServiceOrders: false,
          version: await version(s.id),
        })
      ).status,
    ).toBe(200);
    // NÃO: pedido assume o novo prazo; OS existentes mantêm os seus.
    expect(await promised(s.os1)).toBe(inWindow());
    expect(await promised(s.os2)).toBe(inWindow());
    // A OS que nasce depois herda o prazo VIGENTE do pedido (não o da OS irmã).
    const os3 = await s.receive(2);
    expect(await promised(os3)).toBe(next);
  });

  it('SIM: aplica às OS abertas pertinentes, com revisão/auditoria/histórico; repetição idempotente; fila intacta (D9)', async () => {
    const admin = await loginAdmin(app);
    const s = await scenario(admin);
    // OS 1 planejada e na fila (posições, prioridades e tarefas para conferir depois).
    const r = await post(admin, '/api/v1/production/plan-services', {
      entries: [
        {
          serviceOrderId: s.os1,
          startDate: T(),
          pieces: [
            {
              serviceOrderItemId: (
                await db().serviceOrderItem.findFirstOrThrow({ where: { serviceOrderId: s.os1 } })
              ).id,
              upholstererUserId: await userIdOf('Ricardo'),
            },
          ],
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // OS 2 já entregue: não é pertinente (não muda).
    await db().serviceOrderItem.updateMany({
      where: { serviceOrderId: s.os2 },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    const snapshot = () =>
      db().productionTask.findMany({
        where: { serviceOrderId: s.os1 },
        select: {
          id: true,
          priority: true,
          queuePosition: true,
          status: true,
          planId: true,
          version: true,
          assigneeUserId: true,
        },
        orderBy: { id: 'asc' },
      });
    const tasksBefore = await snapshot();
    const soBefore = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.os1 } });
    const planItemBefore = await db().productionPlanItem.findFirstOrThrow({
      where: { serviceOrderId: s.os1 },
    });
    const next = shift(inWindow(), 7);
    const key = idemKey();
    const body = {
      promisedDate: next,
      reason: 'Cliente viaja; combinado novo prazo',
      applyToServiceOrders: true,
      version: await version(s.id),
    };
    const first = await change(admin, s.id, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // Repetição com a mesma chave (duplo clique / resposta perdida): mesma resposta, nada duplicado.
    const again = await change(admin, s.id, body, key);
    expect(again.status).toBe(200);
    expect(await promised(s.os1)).toBe(next);
    expect(await promised(s.os2)).toBe(inWindow());
    // Histórico do pedido (auditoria): anterior, novo, motivo, autor, data e OS aplicadas.
    const logs = await db().auditLog.findMany({
      where: { entityId: s.id, action: 'order.promised_date_changed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorUserId).toBeTruthy();
    const code1 = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.os1 } })).number;
    expect(logs[0]!.changes).toMatchObject({
      promisedDate: { from: inWindow(), to: next },
      reason: 'Cliente viaja; combinado novo prazo',
      appliedToServiceOrders: [`OS-${String(code1).padStart(5, '0')}`],
    });
    const dto = (await admin.get(`/api/v1/orders/${s.id}`)).body;
    expect(dto.promisedDate).toBe(next);
    expect(dto.promisedDateHistory[0]).toMatchObject({
      from: inWindow(),
      to: next,
      reason: 'Cliente viaja; combinado novo prazo',
      by: expect.any(String),
    });
    // Revisão da OS pela regra central (mesmo histórico da edição da OS).
    const rev = await db().serviceOrderRevision.findFirstOrThrow({
      where: { serviceOrderId: s.os1, scope: 'OS' },
      orderBy: { revision: 'desc' },
    });
    expect(rev).toMatchObject({ reason: 'Cliente viaja; combinado novo prazo' });
    expect(rev.changes).toMatchObject({ promisedDate: { from: inWindow(), to: next } });
    // D9 / saneamento: nada de fila, prioridade, tarefas ou planejamento mudou.
    expect(await snapshot()).toEqual(tasksBefore);
    const soAfter = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.os1 } });
    expect(soAfter.priority).toBe(soBefore.priority);
    expect(
      await db().productionPlanItem.findFirstOrThrow({ where: { serviceOrderId: s.os1 } }),
    ).toEqual(planItemBefore);
    // Tempo real: eventos do pedido e da OS (a Central/Início e a OS se atualizam por eles).
    const events = await db().domainEvent.findMany({
      where: { aggregateId: { in: [s.id, s.os1] } },
      select: { type: true },
    });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['order.updated', 'service_order.updated']),
    );
  });

  it('consultar a Central e a OS não grava nada (estado derivado) e não mexe na fila', async () => {
    const admin = await loginAdmin(app);
    const so = await os(admin, 'Cliente Só Leitura', yesterday());
    await planAndStart(admin, so);
    const snap = async () => ({
      tasks: await db().productionTask.findMany({ orderBy: { id: 'asc' } }),
      items: await db().productionPlanItem.findMany({ orderBy: { id: 'asc' } }),
      so: await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } }),
      audits: await db().auditLog.count(),
    });
    const before = await snap();
    await attention(admin);
    await attention(admin, '?type=PRAZO_OS');
    await soDto(admin, so.id);
    await admin.get('/api/v1/service-orders');
    expect(await snap()).toEqual(before);
  });
});

// ─────────────────────────── Permissões e Início ───────────────────────────

describe('Permissões e contagens do Início (mesma fonte da Central)', () => {
  it('estado visível a quem vê OS; Central exige a permissão dela; contagens filtradas = Central', async () => {
    const admin = await loginAdmin(app);
    const late = await os(admin, 'Cliente Perm Atrasado', yesterday());
    await planAndStart(admin, late);
    const risk = await os(admin, 'Cliente Perm Risco', inWindow());
    const osViewer = await panelUserWith(app, admin, 'os-ver', ['os.ver']);
    expect((await osViewer.get(`/api/v1/service-orders/${late.id}`)).body.deadline.state).toBe(
      'ATRASADO',
    );
    expect((await osViewer.get('/api/v1/attention')).status).toBe(403);
    const central = await panelUserWith(app, admin, 'oc-ver', ['ocorrencias.ver']);
    expect((await central.get('/api/v1/attention')).status).toBe(200);
    // Início: GET /attention?type=PRAZO_OS → CRITICO = atrasados, ACAO = em risco.
    const card = await attention(admin, '?type=PRAZO_OS');
    const full = (await attention(admin)).items.filter((i) => i.type === 'PRAZO_OS');
    expect(card.counts.CRITICO).toBe(full.filter((i) => i.category === 'CRITICO').length);
    expect(card.counts.ACAO).toBe(full.filter((i) => i.category === 'ACAO').length);
    expect(card.counts).toMatchObject({ CRITICO: 1, ACAO: 1 });
    expect(card.items.map((i) => i.serviceOrder?.id).sort()).toEqual([late.id, risk.id].sort());
  });
});
