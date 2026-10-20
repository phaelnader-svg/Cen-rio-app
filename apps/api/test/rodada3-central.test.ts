import { zonedDateTime, type AttentionDto, type OverviewDto } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, panelUserWith, receiptBody } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { day, today, userIdOf } from './production-helpers';
import { post, qualityKit } from './quality-helpers';

/**
 * Remediação pós-auditoria, Rodada 3 — Central de Atenção e Início (Fase 10): serviços a planejar,
 * retiradas próximas e aguardando chegada, bloqueio de produção, embalagem sem responsável,
 * divergência no recebimento de peça (F1-15a), cartões por permissão, links que abrem o item e
 * indicadores do Início pela mesma fonte da Central.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const k = qualityKit(() => app);

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
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

const attention = async (c: Client, query = '') =>
  (await c.get(`/api/v1/attention${query}`)).body as AttentionDto;
const overview = async (c: Client) =>
  (await c.get('/api/v1/management/overview')).body as OverviewDto;
const item = (a: AttentionDto, key: string) => a.items.find((i) => i.key === key);

async function pickup(admin: Client, date: string | null, logisticsUserId?: string) {
  const c = await createCustomer(admin, { name: `Cliente Retirada ${date}`, allowSimilar: true });
  const order = await createOrder(admin, c);
  const r = await admin.post(
    '/api/v1/pickups',
    {
      orderId: order.id,
      scheduledDate: date,
      windowStart: date ? '09:00' : null,
      windowEnd: date ? '12:00' : null,
      team: 'LOGISTICA_TERCEIRIZADA',
      ...(logisticsUserId ? { logisticsUserId } : {}),
      items: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    },
    { 'idempotency-key': idemKey() },
  );
  if (r.status !== 201) throw new Error(`pickup: ${JSON.stringify(r.body)}`);
  return { pickup: r.body as { id: string }, order };
}
const transition = async (admin: Client, id: string, toStatus: string) =>
  admin.post(
    `/api/v1/pickups/${id}/transition`,
    {
      toStatus,
      version: (await db().pickupRequest.findUniqueOrThrow({ where: { id } })).version,
    },
    { 'idempotency-key': idemKey() },
  );

describe('Central — o que faltava (F10-04/05/06/09/13f/13g, F1-15a)', () => {
  it('F10-04: serviço na oficina sem planejamento vira UM item "a planejar"; planejou, sai', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente A Planejar');
    const a = await attention(admin, '?type=PLANEJAMENTO');
    const it0 = item(a, 'PLANEJAMENTO:a-planejar');
    expect(it0).toMatchObject({ category: 'ACAO', link: '/painel/producao/a-planejar' });
    expect(it0!.impacts.join(' ')).toContain(so.code);
    // Início: a mesma etapa do pipeline (fonte única).
    const pipeline = (await admin.get('/api/v1/production/pipeline')).body as {
      counts: Record<string, number>;
    };
    expect((await overview(admin)).operations!.preProduction.toPlan).toBe(
      pipeline.counts.A_PLANEJAR,
    );
  });

  it('F10-05/06: retiradas dos próximos 2 dias e retirada feita aguardando chegada (Central + Início); chegou, sai', async () => {
    const admin = await loginAdmin(app);
    const andre = await userIdOf('André');
    const soon = await pickup(admin, day(1), andre);
    await pickup(admin, day(5)); // fora da janela de 2 dias
    let a = await attention(admin, '?type=LOGISTICA');
    expect(item(a, 'LOGISTICA:proximas')).toMatchObject({
      link: `/painel/roteiro?data=${today()}`,
    });
    let o = await overview(admin);
    expect(o.deliveries!.pickups).toEqual({ upcoming: 1, awaitingArrival: 0 });
    // Retirada feita: aguardando chegada na oficina.
    expect((await transition(admin, soon.pickup.id, 'EM_EXECUCAO')).status).toBe(200);
    expect((await transition(admin, soon.pickup.id, 'RETIRADA_REALIZADA')).status).toBe(200);
    a = await attention(admin, '?type=LOGISTICA');
    expect(item(a, `LOGISTICA:aguardando-chegada:${soon.pickup.id}`)).toMatchObject({
      link: `/painel/retiradas?foco=${soon.pickup.id}`,
    });
    o = await overview(admin);
    expect(o.deliveries!.pickups).toEqual({ upcoming: 0, awaitingArrival: 1 });
    // Chegou na oficina (recebimento): sai das duas.
    const r = await post(
      admin,
      '/api/v1/receipts',
      receiptBody(
        soon.order.id,
        soon.order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        soon.pickup.id,
      ),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    a = await attention(admin, '?type=LOGISTICA');
    expect(item(a, `LOGISTICA:aguardando-chegada:${soon.pickup.id}`)).toBeUndefined();
    expect((await overview(admin)).deliveries!.pickups!.awaitingArrival).toBe(0);
  });

  it('F10-09/13f/21l: tarefa BLOQUEADA com prazo distante aparece (informativo) e conta no Início', async () => {
    const s = await k.scenario();
    await db().productionTask.update({
      where: { id: s.sofaTask.id },
      data: {
        status: 'BLOQUEADA',
        blockers: ['Aguardando material'],
        dueDate: new Date(`${day(20)}T00:00:00Z`),
      },
    });
    const a = await attention(s.admin);
    expect(item(a, `PRAZO:${s.sofaTask.id}`)).toMatchObject({
      category: 'INFO',
      link: `/painel/producao/tarefas/${s.sofaTask.id}`,
    });
    expect((await overview(s.admin)).operations!.blockedTasks).toBe(1);
    // Perto do prazo, sobe de categoria; vencida, é crítica.
    await db().productionTask.update({
      where: { id: s.sofaTask.id },
      data: { dueDate: new Date(`${day(1)}T00:00:00Z`) },
    });
    expect(item(await attention(s.admin), `PRAZO:${s.sofaTask.id}`)!.category).toBe('ATENCAO');
    await db().productionTask.update({
      where: { id: s.sofaTask.id },
      data: { dueDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    expect(item(await attention(s.admin), `PRAZO:${s.sofaTask.id}`)!.category).toBe('CRITICO');
  });

  it('F10-13g: embalagem aprovada sem responsável aparece com link para ela; designada, sai', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.approveOpen(s, s.sofa.id);
    const rec = await db().packagingRecord.findFirstOrThrow({ where: { status: 'PENDENTE' } });
    // Ninguém disponível para embalar.
    await db().packagingRecord.update({ where: { id: rec.id }, data: { assigneeUserId: null } });
    const a = await attention(s.admin, '?type=QUALIDADE');
    expect(item(a, `QUALIDADE:embalagem:${rec.id}`)).toMatchObject({
      category: 'ACAO',
      link: `/painel/qualidade?tab=packaging&foco=${rec.id}`,
    });
    await db().packagingRecord.update({
      where: { id: rec.id },
      data: { assigneeUserId: s.ids.joao },
    });
    expect(item(await attention(s.admin, '?type=QUALIDADE'), `QUALIDADE:embalagem:${rec.id}`)).toBe(
      undefined,
    );
  });

  it('F1-15a: divergência no recebimento de PEÇA de cliente aparece na Central enquanto o serviço está ativo', async () => {
    const admin = await loginAdmin(app);
    const c = await createCustomer(admin, { name: 'Cliente Divergência', allowSimilar: true });
    const order = await createOrder(admin, c);
    const r = await post(admin, '/api/v1/receipts', {
      ...receiptBody(
        order.id,
        order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
      ),
      divergences: 'Braço esquerdo trincado na chegada',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = await attention(admin, '?type=RECEBIMENTO');
    expect(item(a, `RECEBIMENTO:divergencia:${r.body.id}`)).toMatchObject({
      category: 'ATENCAO',
      description: 'Braço esquerdo trincado na chegada',
      link: `/painel/pedidos/${order.id}`,
    });
    // Sem divergência: nada.
    const clean = await createOrder(admin, c);
    await post(
      admin,
      '/api/v1/receipts',
      receiptBody(
        clean.id,
        clean.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
      ),
    );
    expect((await attention(admin, '?type=RECEBIMENTO')).items).toHaveLength(1);
  });
});

describe('F10-18 — cada cartão exige a permissão do próprio domínio', () => {
  it('só "ocorrencias.ver" não vê presença, qualidade, logística, recebimento nem planejamento', async () => {
    const s = await k.scenario();
    await openServiceOrder(s.admin, 'Cliente Permissão');
    await pickup(s.admin, day(1));
    const e = await db().employee.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    await db().operationalAttendance.create({
      data: {
        employeeId: e.id,
        date: new Date(`${day(-1)}T00:00:00Z`),
        situation: 'PRESENTE',
        arrivedAt: new Date(`${day(-1)}T11:30:00Z`),
        arrivalKind: 'NO_HORARIO',
      },
    });
    const admin = await attention(s.admin);
    const types = new Set(admin.items.map((i) => i.type));
    for (const t of ['PRESENCA', 'LOGISTICA', 'PLANEJAMENTO'])
      expect(types.has(t as never)).toBe(true);
    const viewer = await panelUserWith(app, s.admin, 'central-r3', ['ocorrencias.ver']);
    const v = await attention(viewer);
    expect(
      v.items.filter((i) =>
        [
          'PRESENCA',
          'QUALIDADE',
          'LOGISTICA',
          'RECEBIMENTO',
          'PLANEJAMENTO',
          'FINANCEIRO',
        ].includes(i.type),
      ),
    ).toEqual([]);
    // Contagem coerente com o corte (nada contado que não se vê).
    expect(v.total).toBe(v.items.length);
    // Com a permissão do domínio, o cartão aparece.
    const logistics = await panelUserWith(app, s.admin, 'central-r3-log', [
      'ocorrencias.ver',
      'retiradas.ver',
    ]);
    expect((await attention(logistics)).items.some((i) => i.type === 'LOGISTICA')).toBe(true);
  });

  it('negociação de valor só para quem decide ajustes (financeiro.ajustes); o Início conta igual', async () => {
    const s = await k.scenario();
    const ricardo = await userIdOf('Ricardo');
    const p = await post(s.admin, '/api/v1/finance/labor', {
      professionalUserId: ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      service: 'Mão de obra',
      agreedCents: 50000,
    });
    await db().valueChangeRequest.create({
      data: {
        targetKind: 'PRODUCAO',
        productionPayableId: p.body.id,
        beneficiaryUserId: ricardo,
        currentCents: 50000,
        requestedCents: 60000,
        reason: 'Braço extra',
      },
    });
    const viewer = await panelUserWith(app, s.admin, 'fin-r3', [
      'ocorrencias.ver',
      'financeiro.ver',
      'os.ver',
    ]);
    expect(
      (await attention(viewer)).items.some((i) => i.key.startsWith('FINANCEIRO:negociacao')),
    ).toBe(false);
    expect((await overview(viewer)).finance!.decisions.valueRequests).toBe(0);
    expect((await overview(s.admin)).finance!.decisions.valueRequests).toBe(1);
  });
});

describe('Início — indicadores pela mesma fonte (F10-21i/k/r, F10-14)', () => {
  it('total de pendências = total da Central (mesmo recorte); pré-produção e bloqueios separados', async () => {
    const s = await k.scenario();
    await openServiceOrder(s.admin, 'Cliente Pendências');
    await pickup(s.admin, day(1));
    const a = await attention(s.admin);
    const o = await overview(s.admin);
    expect(o.attention).toEqual({
      total: a.total,
      critical: a.counts.CRITICO,
      action: a.counts.ACAO,
    });
    expect(o.operations!.preProduction).toEqual(
      expect.objectContaining({ toPlan: expect.any(Number), plannedPublished: expect.any(Number) }),
    );
    // Sem acesso à Central: null (nunca zero inventado).
    const fin = await panelUserWith(app, s.admin, 'fin-only-r3', ['financeiro.ver']);
    expect((await overview(fin)).attention).toBeNull();
  });

  it('obrigações logísticas: parte das contas a pagar que nasceu de custo de viagem (subconjunto)', async () => {
    const admin = await loginAdmin(app);
    const andre = await userIdOf('André');
    await admin.put(
      '/api/v1/finance/logistics-defaults',
      {
        defaultPickupCostCents: 10000,
        defaultDeliveryCostCents: 10000,
        logisticsPayeeUserId: andre,
      },
      { 'idempotency-key': idemKey() },
    );
    const pk = await pickup(admin, day(0), andre);
    const cost = await admin.put(
      '/api/v1/finance/trip-costs',
      { pickupId: pk.pickup.id, amountCents: 12000, participantUserIds: [andre] },
      { 'idempotency-key': idemKey() },
    );
    expect(cost.status, JSON.stringify(cost.body)).toBe(200);
    expect((await transition(admin, pk.pickup.id, 'EM_EXECUCAO')).status).toBe(200);
    expect((await transition(admin, pk.pickup.id, 'RETIRADA_REALIZADA')).status).toBe(200);
    // Conta a pagar comum (fornecedor), que não é logística.
    await db().accountPayable.create({
      data: {
        beneficiary: 'Fornecedor de tecido',
        category: 'MATERIAL',
        description: 'Tecido',
        amountCents: 30000,
        dueDate: new Date(`${day(10)}T00:00:00Z`),
      },
    });
    const o = await overview(admin);
    const logistic = await db().accountPayable.findMany({
      where: { logisticsCost: { isNot: null }, status: { in: ['ABERTO', 'PARCIAL'] } },
    });
    const expected = logistic.reduce((a, p) => a + p.amountCents - p.paidCents, 0);
    expect(expected).toBe(12000);
    expect(o.finance!.payables.logisticsOpenCents).toBe(expected);
    expect(o.finance!.payables.openCents).toBe(expected + 30000);
    expect(o.finance!.payables.logisticsOpenCents).toBeLessThanOrEqual(
      o.finance!.payables.openCents,
    );
  });

  it('F10-14: links abrem o item exato (presença, embalagem, pronta para entrega, roteiro)', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const a = await attention(s.admin);
    const ready = a.items.find(
      (i) => i.key.startsWith('QUALIDADE:pronta') || i.link?.includes('tab=ready'),
    );
    if (ready) expect(ready.link).toMatch(/\/painel\/entregas\?tab=ready&foco=/);
    for (const i of a.items) expect(i.link).toMatch(/^\/painel\//);
    // Nenhum link genérico sem destino para os tipos corrigidos.
    expect(
      a.items.filter((i) =>
        [
          '/painel/ajuda',
          '/painel/reprogramacao',
          '/painel/presenca',
          '/painel/qualidade',
        ].includes(i.link ?? ''),
      ),
    ).toEqual([]);
  });
});
