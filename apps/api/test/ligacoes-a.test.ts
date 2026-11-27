import { emptyQuoteDraft } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { autoReceiveDuePickups } from '../src/modules/pickups/arrival';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, naEmpresa1, resetDatabase } from './helpers';
import { address } from './commercial-helpers';
import { day } from './production-helpers';

/**
 * Ligações entre orçamento, pedido, agendamento (Retirada / No local), OS, material e pagamento
 * (2026-11-26, pedido do Raphael): cancelar, reagendar ou mudar um deles tem de refletir em todos
 * os outros. Cada teste descreve o que DEVERIA acontecer; os que falham são erros a corrigir.
 * Dados fictícios.
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

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });

type Opts = {
  kind?: 'RETIRADA' | 'NO_LOCAL';
  pickup?: boolean;
  date?: string;
  time?: string;
  payment?: Record<string, unknown> | null;
  quoteId?: string;
  businessDays?: number;
  qty?: number;
};
async function closeService(admin: Client, o: Opts = {}) {
  const r = await post(admin, '/api/v1/services', {
    ...(o.quoteId ? { quoteId: o.quoteId } : {}),
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: `Cliente ${Math.random().toString(36).slice(2, 7)}`,
      phone: `(11) 9${Math.floor(10000000 + Math.random() * 89999999)}`,
      address: { ...address, isPrimary: true },
    },
    service: {
      contractedService: 'Reforma de sofá',
      agreedValueCents: 200000,
      promisedDate: day(30),
      ...(o.businessDays ? { deliveryBusinessDays: o.businessDays } : {}),
      items: [
        {
          pieceType: 'SOFA',
          description: 'Sofá 3 lugares',
          quantity: o.qty ?? 1,
          serviceType: 'REFORMA_COMPLETA',
          fabricName: 'Linho cinza',
        },
      ],
      ...(o.payment ? { payment: o.payment } : {}),
    },
    pickup:
      o.pickup === false
        ? null
        : {
            team: 'EQUIPE_PROPRIA',
            scheduledDate: o.date ?? day(3),
            windowStart: o.time ?? '09:00',
            ...(o.kind ? { kind: o.kind } : {}),
          },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { order: { id: string }; pickup: { id: string } | null };
}
const order = async (c: Client, id: string) => (await c.get(`/api/v1/orders/${id}`)).body;
const pickup = async (c: Client, id: string) => (await c.get(`/api/v1/pickups/${id}`)).body;
const so = async (c: Client, id: string) => (await c.get(`/api/v1/service-orders/${id}`)).body;

async function generateOs(c: Client, orderId: string, extra: Record<string, unknown> = {}) {
  const o = await order(c, orderId);
  const r = await post(c, '/api/v1/service-orders', {
    orderId,
    items: o.items.map((i: { id: string; quantity: number; description: string }) => ({
      orderItemId: i.id,
      quantity: i.quantity,
      description: i.description,
      serviceType: 'REFORMA_COMPLETA',
    })),
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; version: number; code: string };
}
async function cancelOrder(c: Client, id: string, extra: Record<string, unknown> = {}) {
  const o = await order(c, id);
  return c.post(`/api/v1/orders/${id}/cancel`, {
    reason: 'Cliente desistiu',
    version: o.version,
    ...extra,
  });
}
async function transition(c: Client, id: string, toStatus: string, note?: string) {
  const p = await pickup(c, id);
  return c.post(`/api/v1/pickups/${id}/transition`, {
    toStatus,
    version: p.version,
    ...(note ? { note } : {}),
  });
}
async function reschedule(c: Client, id: string, date: string | null, time = '10:00') {
  const p = await pickup(c, id);
  return c.put(`/api/v1/pickups/${id}`, {
    version: p.version,
    kind: p.kind,
    scheduledDate: date,
    windowStart: date ? time : null,
    windowEnd: null,
    team: p.team,
    items: p.items.map((i: { orderItemId: string; quantity: number }) => ({
      orderItemId: i.orderItemId,
      quantity: i.quantity,
    })),
  });
}
/** Roda a tarefa das 19h / 1 h depois como se fosse `at`. */
const runAuto = (at: Date) => naEmpresa1(() => autoReceiveDuePickups(db(), at));
const farFuture = () => new Date(Date.now() + 40 * 86_400_000);

async function savedQuote(c: Client) {
  const settings = (await c.get('/api/v1/quotes/settings')).body;
  if (settings.taxRateBps === null)
    await c.req('PATCH', '/api/v1/quotes/settings', { version: settings.version, taxRateBps: 600 });
  const r = await post(c, '/api/v1/quotes', {
    ...emptyQuoteDraft(),
    customerName: 'Maria Orçamento',
    phone: '12999990000',
    service: 'Reforma de Sofá',
    profitCents: 100000,
    validityDays: 15,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; version: number; totalCents: number };
}

describe('1. Cancelar o pedido', () => {
  it('1.1 com retirada agendada: retirada, cobranças e custo da viagem cancelados; agenda e roteiro limpos', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { payment: { model: 'ENTRADA_ENTREGA' } });
    const r = await cancelOrder(admin, res.order.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('CANCELADO');
    const p = await pickup(admin, res.pickup!.id);
    expect.soft(p.status, 'retirada cancelada junto').toBe('CANCELADA');
    const recs = await db().customerReceivable.findMany({ where: { orderId: res.order.id } });
    expect
      .soft(
        recs.every((x) => x.status === 'CANCELADO'),
        'cobranças canceladas',
      )
      .toBe(true);
    const route = (await admin.get(`/api/v1/logistics/route?date=${day(3)}`)).body;
    expect.soft(JSON.stringify(route), 'roteiro do dia sem a retirada').not.toContain(p.code);
    // Tempo real: as telas abertas (agenda, celular) precisam receber o aviso da retirada.
    const ev = await db().domainEvent.findMany({
      where: { aggregateType: 'pickup_request', aggregateId: res.pickup!.id },
      orderBy: { seq: 'asc' },
    });
    expect
      .soft(
        ev.some((e) => (e.payload as { status?: string }).status === 'CANCELADA'),
        'evento de tempo real da retirada cancelada (agenda/celular abertos se atualizam)',
      )
      .toBe(true);
  });

  it('1.2 pedido de orçamento: cancelado, o orçamento não fica preso (pode virar serviço de novo)', async () => {
    const admin = await loginAdmin(app);
    const q = await savedQuote(admin);
    const res = await closeService(admin, { quoteId: q.id });
    expect((await admin.get(`/api/v1/quotes/${q.id}`)).body.orderId).toBe(res.order.id);
    expect((await cancelOrder(admin, res.order.id)).status).toBe(200);
    const after = (await admin.get(`/api/v1/quotes/${q.id}`)).body;
    // Esperado: orçamento solto do pedido cancelado (volta a poder fechar serviço / ser recusado).
    expect.soft(after.orderId, 'orçamento continua ligado ao pedido cancelado').toBeNull();
    const again = await post(admin, '/api/v1/services', {
      quoteId: q.id,
      customer: { mode: 'NOVO', kind: 'PF', name: 'Maria de Novo', phone: '(12) 99999-1111' },
      service: {
        contractedService: 'Reforma de Sofá',
        agreedValueCents: q.totalCents,
        promisedDate: day(20),
        items: [
          { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        ],
      },
      pickup: null,
    });
    expect.soft(again.status, 'fechar serviço de novo a partir do mesmo orçamento').toBe(201);
  });

  it('1.3 "No local" com OS já aberta: OS, tarefas e lista Comprar limpas', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { kind: 'NO_LOCAL' });
    const os = await generateOs(admin, res.order.id, {
      materials: [{ description: 'Tecido linho', quantity: 5, unit: 'm' }],
    });
    const toBuyBefore = (await admin.get('/api/v1/os-materials/to-buy')).body;
    expect(JSON.stringify(toBuyBefore)).toContain('Tecido linho');
    expect((await cancelOrder(admin, res.order.id)).status).toBe(200);
    expect.soft((await so(admin, os.id)).status).toBe('CANCELADA');
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('CANCELADA');
    const toBuy = (await admin.get('/api/v1/os-materials/to-buy')).body;
    expect
      .soft(JSON.stringify(toBuy), 'Comprar sem material da OS cancelada')
      .not.toContain('Tecido linho');
  });

  it('1.4 peça "chegou" sozinha sem a retirada acontecer: desfaz e aí sim cancela o pedido', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(-1) });
    await runAuto(new Date());
    expect((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
    // Raphael: depois da retirada feita o cliente não cancela — o pedido recusa.
    expect((await cancelOrder(admin, res.order.id)).status).toBe(422);
    const undo = await transition(admin, res.pickup!.id, 'COM_OCORRENCIA', 'Cliente não estava');
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect((await order(admin, res.order.id)).receivedPieces).toBe(0);
    const r = await cancelOrder(admin, res.order.id);
    expect.soft(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('1.4b "a retirada não aconteceu" com a peça já numa OS: pede para cancelar a OS antes', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(-1) });
    await runAuto(new Date());
    await generateOs(admin, res.order.id);
    const undo = await transition(admin, res.pickup!.id, 'COM_OCORRENCIA', 'Não foi feita');
    expect(undo.status).toBe(422);
    expect(JSON.stringify(undo.body)).toContain('Cancele a OS');
    expect((await order(admin, res.order.id)).receivedPieces).toBe(1);
  });

  it('1.5 cancelar o pedido com pagamento recebido exige decidir reembolso/retenção (nada se perde)', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { payment: { model: 'PIX_100' } });
    const [rc] = await db().customerReceivable.findMany({ where: { orderId: res.order.id } });
    const pay = await post(admin, `/api/v1/finance/receivables/${rc!.id}/payments`, {
      amountCents: 50000,
      receivedAt: day(0),
      method: 'PIX',
      version: rc!.version,
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    const semDecisao = await cancelOrder(admin, res.order.id);
    expect.soft(semDecisao.status, 'sem decidir o dinheiro recebido: recusa').toBe(422);
    const r = await cancelOrder(admin, res.order.id, {
      finance: { retainedCents: 0, refund: { refundedAt: day(0), method: 'PIX' } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fin = (await admin.get(`/api/v1/finance/orders/${res.order.id}`)).body;
    expect.soft(fin.receivedCents, 'recebido líquido após reembolso').toBe(0);
  });
});

describe('2. Retirada: cancelar, reagendar, não aconteceu', () => {
  it('2.1 cancelar só a retirada: pedido volta a "aguardando retirada" e sai da agenda/roteiro', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const r = await transition(admin, res.pickup!.id, 'CANCELADA', 'Cliente vai trazer');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = await order(admin, res.order.id);
    expect.soft(o.status).toBe('AGUARDANDO_RETIRADA');
    const route = (await admin.get(`/api/v1/logistics/route?date=${day(3)}`)).body;
    expect.soft(JSON.stringify(route)).not.toContain(r.body.code);
    // E a peça não "chega" sozinha depois.
    await runAuto(farFuture());
    expect.soft((await order(admin, res.order.id)).receivedPieces).toBe(0);
  });

  it('2.2 reagendar a retirada: prazo em dias úteis acompanha, peça chega no NOVO horário', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(3), businessDays: 10 });
    const before = await order(admin, res.order.id);
    const r = await reschedule(admin, res.pickup!.id, day(8));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await order(admin, res.order.id);
    expect.soft(after.promisedDate > before.promisedDate, 'prazo andou junto').toBe(true);
    // Não chega no dia antigo…
    await runAuto(new Date(Date.parse(`${day(4)}T12:00:00Z`)));
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('AGENDADA');
    // …chega no novo.
    await runAuto(new Date(Date.parse(`${day(9)}T12:00:00Z`)));
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
  });

  it('2.3 retirada "chegou" sozinha mas NÃO aconteceu: dá para desfazer e reagendar', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, {
      date: day(-1),
      payment: { model: 'METADE_RETIRADA_ENTREGA' },
    });
    await runAuto(new Date());
    const p = await pickup(admin, res.pickup!.id);
    expect(p.status).toBe('RECEBIDA_NA_OFICINA');
    expect(p.allowedTransitions).toEqual(['COM_OCORRENCIA']);
    const undo = await transition(admin, res.pickup!.id, 'COM_OCORRENCIA', 'Cliente não estava');
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body.status).toBe('COM_OCORRENCIA');
    expect(undo.body.events.at(-1)).toMatchObject({ kind: 'NAO_ACONTECEU' });
    const o = await order(admin, res.order.id);
    expect.soft(o.receivedPieces, 'peça sai da tapeçaria').toBe(0);
    // a cobrança "na retirada" deixa de contar como retirada feita
    const rc = (await db().customerReceivable.findMany({ where: { orderId: res.order.id } })).find(
      (x) => x.dueTrigger === 'RETIRADA',
    )!;
    expect
      .soft((await admin.get(`/api/v1/finance/receivables/${rc.id}`)).body.effectiveDueDate)
      .toBeNull();
    const re = await reschedule(admin, res.pickup!.id, day(5));
    expect.soft(re.status, JSON.stringify(re.body)).toBe(200);
    expect.soft(re.body.status).toBe('AGENDADA');
    expect.soft((await order(admin, res.order.id)).status).toBe('RETIRADA_AGENDADA');
    // e volta a chegar sozinha no novo dia
    await runAuto(farFuture());
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
  });

  it('2.4 retirada com ocorrência (cliente não estava) não chega sozinha e pode ser reagendada', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(3) });
    expect(
      (await transition(admin, res.pickup!.id, 'COM_OCORRENCIA', 'Ninguém em casa')).status,
    ).toBe(200);
    await runAuto(farFuture());
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('COM_OCORRENCIA');
    const re = await reschedule(admin, res.pickup!.id, day(6));
    expect.soft(re.status, JSON.stringify(re.body)).toBe(200);
    const st = (await pickup(admin, res.pickup!.id)).status;
    expect.soft(st, 'reagendada volta para "Agendada"').toBe('AGENDADA');
    expect.soft((await order(admin, res.order.id)).status).toBe('RETIRADA_AGENDADA');
  });

  it('2.5 tirar a data da retirada: pedido deixa de "Retirada agendada"', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const r = await reschedule(admin, res.pickup!.id, null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect.soft(r.body.status).toBe('AGUARDANDO_AGENDAMENTO');
    expect.soft((await order(admin, res.order.id)).status).toBe('AGUARDANDO_RETIRADA');
  });

  it('2.6 "Peça chegou" no pedido com retirada futura: retirada encerrada, sem chegar duas vezes', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { qty: 2 });
    const o = await order(admin, res.order.id);
    const r = await post(admin, `/api/v1/orders/${res.order.id}/arrived`, { version: o.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect.soft(r.body.receivedPieces).toBe(2);
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
    await runAuto(farFuture());
    expect.soft((await order(admin, res.order.id)).receivedPieces, 'não soma de novo').toBe(2);
  });

  it('2.7 entrada "na retirada": vence quando a peça chega (automático ou pelo botão)', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, {
      date: day(-2),
      payment: { model: 'METADE_RETIRADA_ENTREGA' },
    });
    await runAuto(new Date());
    expect((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
    const recs = await db().customerReceivable.findMany({ where: { orderId: res.order.id } });
    const entrada = recs.find((x) => x.dueTrigger === 'RETIRADA')!;
    const rc = (await admin.get(`/api/v1/finance/receivables/${entrada.id}`)).body;
    // Raphael: o Pix dos 50% costuma vir depois — vence 3 dias depois da chegada (2 dias atrás).
    expect.soft(rc.effectiveDueDate, 'entrada "na retirada" nunca vence').toBe(day(1));
    expect.soft(rc.overdue).toBe(false);
    expect.soft(rc.openCents).toBe(100000);
  });
});

describe('3. No local', () => {
  it('3.1 reagendar o No local com OS aberta: prazo do pedido e da OS acompanham o novo dia', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { kind: 'NO_LOCAL', date: day(3) });
    const os = await generateOs(admin, res.order.id, { promisedDate: day(3) });
    const r = await reschedule(admin, res.pickup!.id, day(9));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect.soft((await order(admin, res.order.id)).promisedDate, 'prazo do pedido').toBe(day(9));
    const s = await so(admin, os.id);
    expect.soft(s.onSite?.date, 'dia do serviço na OS').toBe(day(9));
    expect.soft(s.promisedDate, 'prazo da OS (senão aparece atrasada)').toBe(day(9));
  });

  it('3.2 cancelar só o No local com OS aberta: a OS não fica com o dia do serviço cancelado', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { kind: 'NO_LOCAL', date: day(3) });
    const os = await generateOs(admin, res.order.id, { promisedDate: day(3) });
    const r = await transition(admin, res.pickup!.id, 'CANCELADA', 'Cliente remarcou sem data');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await so(admin, os.id);
    expect
      .soft(s.onSite, `OS ainda mostra o No local cancelado: ${JSON.stringify(s.onSite)}`)
      .toBeNull();
    // A Central avisa que a OS está sem dia marcado para o serviço no local.
    const central = (await admin.get('/api/v1/attention')).body;
    expect
      .soft(JSON.stringify(central), 'Central não avisa o No local sem dia')
      .toContain(`LOGISTICA:no-local-sem-dia:${os.id}`);
  });

  it('3.3 No local vira "feito" sozinho às 19h do dia, nunca antes', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { kind: 'NO_LOCAL', date: day(1), time: '08:00' });
    // 09h do dia (1 h depois do horário): ainda NÃO — No local dura o dia.
    await runAuto(new Date(Date.parse(`${day(1)}T12:00:00Z`)));
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('AGENDADA');
    await runAuto(new Date(Date.parse(`${day(1)}T22:30:00Z`)));
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
    expect.soft((await order(admin, res.order.id)).status).toBe('RECEBIDO');
  });

  it('3.4 trocar Retirada → No local depois de agendar: pedido e prazo passam a ser do No local', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(4), businessDays: 10 });
    const p = await pickup(admin, res.pickup!.id);
    const r = await admin.put(`/api/v1/pickups/${p.id}`, {
      version: p.version,
      kind: 'NO_LOCAL',
      scheduledDate: day(4),
      windowStart: '09:00',
      windowEnd: null,
      team: p.team,
      items: p.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = await order(admin, res.order.id);
    expect.soft(o.onSite).toBe(true);
    expect.soft(o.promisedDate).toBe(day(4));
  });

  it('3.5 trocar No local → Retirada com OS já aberta: OS deixa de mostrar o No local', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { kind: 'NO_LOCAL', date: day(4) });
    const os = await generateOs(admin, res.order.id);
    const p = await pickup(admin, res.pickup!.id);
    const r = await admin.put(`/api/v1/pickups/${p.id}`, {
      version: p.version,
      kind: 'RETIRADA',
      scheduledDate: day(4),
      windowStart: '09:00',
      windowEnd: null,
      team: p.team,
      items: p.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
    });
    expect.soft(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await so(admin, os.id);
    expect.soft(s.onSite ?? null).toBeNull();
  });
});

describe('4. OS', () => {
  it('4.1 cancelar a OS: peças livres para nova OS, material sai do Comprar, pedido segue', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(-1) });
    await runAuto(new Date());
    const os = await generateOs(admin, res.order.id, {
      materials: [{ description: 'Espuma D33', quantity: 2, unit: 'un' }],
    });
    const cur = await so(admin, os.id);
    const r = await admin.post(`/api/v1/service-orders/${os.id}/cancel`, {
      reason: 'Refazer a OS',
      version: cur.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const toBuy = (await admin.get('/api/v1/os-materials/to-buy')).body;
    expect.soft(JSON.stringify(toBuy)).not.toContain('Espuma D33');
    const o = await order(admin, res.order.id);
    expect.soft(o.status).not.toBe('CANCELADO');
    expect.soft(o.items[0].inServiceOrders).toBe(0);
    const again = await generateOs(admin, res.order.id);
    expect.soft(again.id).not.toBe(os.id);
  });

  it('4.2 cancelar a OS não deixa o pedido "sem OS" escondido: volta para a lista "Aguardando OS"', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(-1) });
    await runAuto(new Date());
    const os = await generateOs(admin, res.order.id);
    await admin.post(`/api/v1/service-orders/${os.id}/cancel`, {
      reason: 'Errada',
      version: (await so(admin, os.id)).version,
    });
    const list = (await admin.get('/api/v1/orders?stage=SEM_OS')).body;
    expect.soft(JSON.stringify(list)).toContain(res.order.id);
  });

  it('4.3 "Material comprado" e depois cancelar a OS: nada fica na programação', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(-1) });
    await runAuto(new Date());
    const os = await generateOs(admin, res.order.id, { materialPurchased: true });
    const board = async () => JSON.stringify((await admin.get('/api/v1/production/pipeline')).body);
    expect(await board()).toContain(os.id);
    await admin.post(`/api/v1/service-orders/${os.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: (await so(admin, os.id)).version,
    });
    expect.soft(await board(), 'OS cancelada some da fila da programação').not.toContain(os.id);
  });

  it('4.4 mudar o prazo do pedido e aplicar às OS abertas', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { date: day(-1) });
    await runAuto(new Date());
    const os = await generateOs(admin, res.order.id, { promisedDate: day(10) });
    const o = await order(admin, res.order.id);
    const r = await admin.put(
      `/api/v1/orders/${res.order.id}/promised-date`,
      {
        promisedDate: day(15),
        reason: 'Cliente pediu',
        applyToServiceOrders: true,
        version: o.version,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect.soft((await so(admin, os.id)).promisedDate).toBe(day(15));
  });
});

describe('2b. Agendar depois do fechamento', () => {
  it('2.8 cliente ia trazer, depois agenda No local: prazo do pedido vira o dia do serviço', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { pickup: false, businessDays: 10 });
    const o = await order(admin, res.order.id);
    const r = await post(admin, '/api/v1/pickups', {
      orderId: res.order.id,
      kind: 'NO_LOCAL',
      team: 'EQUIPE_PROPRIA',
      scheduledDate: day(5),
      windowStart: '09:00',
      addressId: o.pickupAddress?.id ?? undefined,
      items: o.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect
      .soft((await order(admin, res.order.id)).promisedDate, 'prazo = dia do No local')
      .toBe(day(5));
  });

  it('2.9 cliente ia trazer, depois agenda Retirada: prazo em dias úteis conta do dia da retirada', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, { pickup: false, businessDays: 10 });
    const before = await order(admin, res.order.id);
    const r = await post(admin, '/api/v1/pickups', {
      orderId: res.order.id,
      team: 'EQUIPE_PROPRIA',
      scheduledDate: day(12),
      windowStart: '09:00',
      items: before.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await order(admin, res.order.id);
    expect
      .soft(after.promisedDate > before.promisedDate, 'prazo não acompanhou a retirada')
      .toBe(true);
  });
});

describe('11. Sinal de 50% (Pix) pode vir antes, na retirada ou dias depois — nada trava', () => {
  async function sinal(c: Client, orderId: string) {
    const recs = await db().customerReceivable.findMany({
      where: { orderId },
      orderBy: { number: 'asc' },
    });
    return recs.find((x) => x.dueTrigger === 'RETIRADA')!;
  }
  const pay = (c: Client, rc: { id: string; version: number; amountCents: number }, when: string) =>
    post(c, `/api/v1/finance/receivables/${rc.id}/payments`, {
      amountCents: rc.amountCents,
      receivedAt: when,
      method: 'PIX',
      version: rc.version,
    });

  it('11.1 sem sinal pago: peça chega, gera OS, material comprado e entra na programação', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, {
      date: day(-1),
      payment: { model: 'METADE_RETIRADA_ENTREGA' },
    });
    await runAuto(new Date());
    expect((await order(admin, res.order.id)).receivedPieces).toBe(1);
    const os = await generateOs(admin, res.order.id, { materialPurchased: true });
    const pipe = JSON.stringify((await admin.get('/api/v1/production/pipeline')).body);
    expect.soft(pipe, 'OS sem sinal pago fica fora da programação').toContain(os.id);
    const rc = await sinal(admin, res.order.id);
    expect.soft(rc.status, 'sinal continua a receber').toBe('ABERTO');
  });

  it('11.2 sinal pago 3 dias depois da retirada: baixa normal, nada duplica', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, {
      date: day(-4),
      payment: { model: 'METADE_RETIRADA_ENTREGA' },
    });
    await runAuto(new Date());
    await generateOs(admin, res.order.id);
    const rc = await sinal(admin, res.order.id);
    const r = await pay(admin, rc, day(-1));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fin = (await admin.get(`/api/v1/finance/orders/${res.order.id}`)).body;
    expect.soft(fin.receivedCents).toBe(100000);
    expect.soft(fin.openCents).toBe(100000);
    expect.soft(fin.overdueCents, 'nada atrasado depois de pago').toBe(0);
  });

  it('11.3 sinal pago antes da retirada (no fechamento): a retirada segue normal', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, {
      date: day(2),
      payment: { model: 'METADE_RETIRADA_ENTREGA' },
    });
    const rc = await sinal(admin, res.order.id);
    expect((await pay(admin, rc, day(0))).status).toBe(200);
    const p = await pickup(admin, res.pickup!.id);
    expect.soft(p.status).toBe('AGENDADA');
    await runAuto(farFuture());
    expect.soft((await pickup(admin, res.pickup!.id)).status).toBe('RECEBIDA_NA_OFICINA');
    const fin = (await admin.get(`/api/v1/finance/orders/${res.order.id}`)).body;
    expect.soft(fin.receivedCents).toBe(100000);
  });
});
