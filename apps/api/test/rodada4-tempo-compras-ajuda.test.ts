import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { address } from './commercial-helpers';
import {
  act,
  addOs,
  createPlan,
  publish,
  serviceOrderWith,
  sofaTask,
  tabletOf,
  userIdOf,
} from './production-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
} from './purchasing-helpers';

/**
 * Remediação pós-auditoria, Rodada 4 — PROVAS (sem mudança de comportamento):
 *  F3-04  CA3-01: "Retirada de hoje" ANTES do horário combinado × "Retirada prevista" a partir
 *         dele (relógio controlado); fuso configurado da oficina (Manaus) × fuso fixo de SP.
 *  F3-25  "Informar problema" opcional nas PEÇAS: recebimento conclui, problema registrado e
 *         visível; sem problema, recebimento normal.
 *  F4-07d Semana/data no fuso America/Sao_Paulo na fronteira 00:00 SP × UTC (02:30Z × 03:30Z).
 *  F6-07c CA6-03: duas `POST /api/v1/purchase-orders` simultâneas cuja soma passa da necessidade.
 *  F6-08  CA6-04: cancelar pedido CONFIRMADO devolve a quantidade a "A comprar".
 *  F7-14  CA7-05: histórico de ajudas antigas preservado e visível na listagem do painel.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(async () => {
  setClock();
  await app.close();
});
beforeEach(async () => {
  setClock();
  await resetDatabase();
});
afterEach(() => {
  vi.useRealTimers();
  setClock();
});

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown) =>
  c.req('PUT', path, body, { 'idempotency-key': idemKey() });
const spDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: SP }).format(d);
const SP = 'America/Sao_Paulo';

/** Logística padrão (mesma configuração dos testes de recebimento compartilhado). */
async function logistics(admin: Client) {
  const r = await put(admin, '/api/v1/finance/logistics-defaults', {
    defaultPickupCostCents: 8000,
    defaultDeliveryCostCents: 12000,
    logisticsPayeeUserId: await userIdOf('André'),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Serviço fechado com retirada (data/horário de chegada ao cliente informados). */
async function service(
  admin: Client,
  pickup: { scheduledDate: string; windowStart: string },
  name = 'Maria Aparecida Fictícia',
) {
  const r = await post(admin, '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name,
      phone: null,
      allowSimilar: true,
      address: { ...address, isPrimary: true },
    },
    service: {
      promisedDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      contractedService: 'Reforma completa',
      agreedValueCents: 450000,
      items: [
        {
          pieceType: 'SOFA',
          description: 'Sofás iguais',
          quantity: 3,
          serviceType: 'REFORMA_COMPLETA',
        },
        {
          pieceType: 'POLTRONA',
          description: 'Poltrona',
          quantity: 1,
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    },
    pickup: { team: 'LOGISTICA_TERCEIRIZADA', ...pickup },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const order = await db().commercialOrder.findUniqueOrThrow({
    where: { id: r.body.order.id },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  return { pickupId: r.body.pickup.id as string, order };
}
type PieceCard = {
  pickupId: string;
  stage: string;
  stageLabel: string;
  version: number;
  pendingTotal: number;
};
/** Cartão da retirada na central; a leitura PRECISA dar 200 (nunca "sumir" por erro). */
async function pieceCard(c: Client, pickupId: string) {
  const r = await c.get('/api/v1/arrivals');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(Array.isArray(r.body.pieces)).toBe(true);
  return (r.body.pieces as PieceCard[]).find((p) => p.pickupId === pickupId);
}

/** Troca o fuso da oficina pela rota real de configurações (o mesmo formulário do painel). */
async function setShopTimezone(admin: Client, timezone: string) {
  const cur = (await admin.get('/api/company/settings')).body;
  const r = await admin.put('/api/company/settings', { ...cur, timezone });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.timezone).toBe(timezone);
}

// Só `Date` é simulado (temporizadores reais): o relógio operacional (core/clock) e o
// `new Date()` de `nowHm()` passam a ver o mesmo instante.
const freeze = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

describe('F3-04 / CA3-01 — aviso de retirada prevista no horário de chegada combinado', () => {
  it('antes das 10:00 (SP) "Retirada de hoje"; às 10:00 em diante "Retirada prevista"; nunca "atraso"', async () => {
    // 03/11/2026 09:00 em SP (12:00Z).
    freeze('2026-11-03T12:00:00Z');
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { pickupId } = await service(admin, {
      scheduledDate: '2026-11-03',
      windowStart: '10:00',
    });
    expect(await pieceCard(admin, pickupId)).toMatchObject({
      stage: 'RETIRADA_HOJE',
      stageLabel: 'Retirada de hoje — chegada ao cliente 10:00',
    });
    vi.setSystemTime(new Date('2026-11-03T12:59:00Z')); // 09:59 SP
    expect((await pieceCard(admin, pickupId))?.stage).toBe('RETIRADA_HOJE');
    vi.setSystemTime(new Date('2026-11-03T13:00:00Z')); // 10:00 SP — horário combinado
    const reached = await pieceCard(admin, pickupId);
    expect(reached).toMatchObject({
      stage: 'RETIRADA_PREVISTA',
      stageLabel: 'Retirada prevista — equipe no cliente a partir das 10:00',
    });
    vi.setSystemTime(new Date('2026-11-03T20:00:00Z')); // 17:00 SP — muito depois: sem "atraso"
    const late = await pieceCard(admin, pickupId);
    expect(late?.stage).toBe('RETIRADA_PREVISTA');
    expect(JSON.stringify(late)).not.toMatch(/atras/i);
  });

  it('retirada de amanhã (SP) não aparece na véspera às 23:30; aparece às 00:30 do dia', async () => {
    freeze('2026-11-04T02:30:00Z'); // 03/11 23:30 SP
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { pickupId } = await service(admin, {
      scheduledDate: '2026-11-04',
      windowStart: '08:00',
    });
    expect(await pieceCard(admin, pickupId)).toBeUndefined();
    vi.setSystemTime(new Date('2026-11-04T03:30:00Z')); // 04/11 00:30 SP
    expect(await pieceCard(admin, pickupId)).toMatchObject({
      stage: 'RETIRADA_HOJE',
      stageLabel: 'Retirada de hoje — chegada ao cliente 08:00',
    });
  });

  // Rodada 4 (F3-04): bug encontrado por este teste e corrigido — o fuso é configurável
  // (PUT /api/company/settings, campo "Fuso horário" do painel) e o aviso agora o segue.
  it('fuso da oficina Manaus — às 09:30 locais (10:30 SP) a retirada das 10:00 ainda é "de hoje"', async () => {
    freeze('2026-11-03T12:00:00Z');
    const admin = await loginAdmin(app);
    await setShopTimezone(admin, 'America/Manaus');
    await logistics(admin);
    const { pickupId } = await service(admin, {
      scheduledDate: '2026-11-03',
      windowStart: '10:00',
    });
    vi.setSystemTime(new Date('2026-11-03T13:30:00Z')); // 09:30 Manaus / 10:30 SP
    expect((await pieceCard(admin, pickupId))?.stage).toBe('RETIRADA_HOJE');
  });

  it('fuso da oficina Manaus — às 23:30 locais de 03/11 (00:30 SP de 04/11) a retirada de 04/11 ainda não é "de hoje"', async () => {
    freeze('2026-11-03T15:00:00Z');
    const admin = await loginAdmin(app);
    await setShopTimezone(admin, 'America/Manaus');
    await logistics(admin);
    const { pickupId } = await service(admin, {
      scheduledDate: '2026-11-04',
      windowStart: '08:00',
    });
    vi.setSystemTime(new Date('2026-11-04T03:30:00Z')); // 03/11 23:30 Manaus
    // Nova sessão no instante simulado (a anterior pode ter expirado no salto de horas).
    expect(await pieceCard(await loginAdmin(app), pickupId)).toBeUndefined();
  });
});

describe('F3-25 — "Informar problema" opcional nas PEÇAS do cliente', () => {
  const attention = async (c: Client) =>
    ((await c.get('/api/v1/attention?type=RECEBIMENTO')).body.items ?? []) as {
      key: string;
      description: string;
      status: string;
    }[];

  it('com problema: recebimento conclui (OS criada), divergência gravada no recebimento e na Central', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { pickupId, order } = await service(admin, {
      scheduledDate: spDate(new Date()),
      windowStart: '00:00',
    });
    const card = (await pieceCard(admin, pickupId))!;
    const note = 'Braço do sofá trincado e capa da poltrona rasgada';
    const r = await post(admin, `/api/v1/arrivals/pickups/${pickupId}/confirm`, {
      version: card.version,
      problem: { note },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'PECAS', remaining: 0 });
    expect(r.body.serviceOrder?.code).toMatch(/^OS-/);
    // Recebimento concluído normalmente: pedido recebido, retirada encerrada, aviso some.
    expect((await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'RECEBIDO',
    );
    expect((await db().pickupRequest.findUniqueOrThrow({ where: { id: pickupId } })).status).toBe(
      'RECEBIDA_NA_OFICINA',
    );
    expect(await pieceCard(admin, pickupId)).toBeUndefined();
    // O problema fica registrado no recebimento (API do painel) e em cada linha.
    const receipt = (await admin.get(`/api/v1/receipts/${r.body.receipt.id}`)).body;
    expect(receipt.divergences).toBe(note);
    expect(receipt.lines).toHaveLength(2);
    for (const l of receipt.lines)
      expect(l).toMatchObject({ condition: 'REGULAR', conditionNotes: note });
    expect(receipt.lines.reduce((a: number, l: { quantity: number }) => a + l.quantity, 0)).toBe(4);
    // Visível na Central de atenção enquanto o serviço está ativo.
    const items = await attention(admin);
    expect(
      items.find((i) => i.key === `RECEBIMENTO:divergencia:${r.body.receipt.id}`),
    ).toMatchObject({ description: note, status: 'DIVERGENCIA' });
    // Toda a quantidade foi para a OS (o problema não bloqueia nada).
    const inOs = await db().serviceOrderItem.aggregate({
      where: { serviceOrder: { orderId: order.id } },
      _sum: { quantity: true },
    });
    expect(inOs._sum.quantity).toBe(4);
  });

  it('sem problema: recebimento normal (BOA), sem divergência e nada na Central; problema curto é recusado sem efeito', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { pickupId, order } = await service(admin, {
      scheduledDate: spDate(new Date()),
      windowStart: '00:00',
    });
    const card = (await pieceCard(admin, pickupId))!;
    // "Informar problema" com texto vazio/curto é validação (400) e não registra nada.
    const bad = await post(admin, `/api/v1/arrivals/pickups/${pickupId}/confirm`, {
      version: card.version,
      problem: { note: 'x' },
    });
    expect(bad.status).toBe(400);
    expect(await db().receipt.count({ where: { orderId: order.id } })).toBe(0);
    const r = await post(admin, `/api/v1/arrivals/pickups/${pickupId}/confirm`, {
      version: card.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const receipt = (await admin.get(`/api/v1/receipts/${r.body.receipt.id}`)).body;
    expect(receipt.divergences).toBeNull();
    for (const l of receipt.lines)
      expect(l).toMatchObject({ condition: 'BOA', conditionNotes: null });
    expect(await attention(admin)).toEqual([]);
    expect((await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'RECEBIDO',
    );
  });

  it('parcial com problema: só o que chegou é recebido; o saldo continua aguardando', async () => {
    const admin = await loginAdmin(app);
    await logistics(admin);
    const { pickupId, order } = await service(admin, {
      scheduledDate: spDate(new Date()),
      windowStart: '00:00',
    });
    const card = (await pieceCard(admin, pickupId))!;
    const sofas = order.items[0]!;
    const r = await post(admin, `/api/v1/arrivals/pickups/${pickupId}/confirm`, {
      version: card.version,
      lines: [{ orderItemId: sofas.id, quantity: 2 }],
      problem: { note: 'Um dos sofás chegou com o pé quebrado' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.remaining).toBe(2);
    expect(await pieceCard(admin, pickupId)).toMatchObject({
      stage: 'CHEGOU_EM_PARTE',
      pendingTotal: 2,
    });
    const receipt = (await admin.get(`/api/v1/receipts/${r.body.receipt.id}`)).body;
    expect(receipt.divergences).toBe('Um dos sofás chegou com o pé quebrado');
    expect(receipt.lines.map((l: { quantity: number }) => l.quantity)).toEqual([2]);
  });
});

describe('F4-07d — semana/data no fuso America/Sao_Paulo (fronteira 00:00 SP × UTC)', () => {
  // 02/11/2026 02:30Z = 01/11 (domingo) 23:30 SP; 03:30Z = 02/11 (segunda) 00:30 SP.
  // Pelo UTC, os dois instantes já seriam segunda 02/11 — só o fuso de SP os separa.
  const SUN = new Date('2026-11-02T02:30:00Z');
  const MON = new Date('2026-11-02T03:30:00Z');

  it('presença "hoje", fila semanal e Meus Ganhos (currentWeekStart) seguem a data de SP', async () => {
    const admin = await loginAdmin(app);
    await db().companySettings.update({
      where: { id: 1 },
      data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
    });
    const ricardo = await userIdOf('Ricardo');
    const tablet = await tabletOf(app, admin, 'Ricardo', '482915');
    const unlockAndRead = async () => {
      const u = await post(tablet, '/api/v1/finance/my-earnings/unlock', { pin: '482915' });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      const r = await tablet.req('GET', '/api/v1/finance/my-earnings', undefined, {
        'x-earnings-unlock': u.body.unlockToken,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { weekStart: string; currentWeekStart: string };
    };

    setClock(() => SUN);
    expect((await admin.get('/api/v1/attendance/team')).body.date).toBe('2026-11-01');
    expect((await admin.get(`/api/v1/production-queue/${ricardo}`)).body.week).toEqual({
      start: '2026-10-26',
      end: '2026-11-01',
    });
    expect(await unlockAndRead()).toMatchObject({
      weekStart: '2026-10-26',
      currentWeekStart: '2026-10-26',
    });

    setClock(() => MON);
    expect((await admin.get('/api/v1/attendance/team')).body.date).toBe('2026-11-02');
    expect((await admin.get(`/api/v1/production-queue/${ricardo}`)).body.week).toEqual({
      start: '2026-11-02',
      end: '2026-11-08',
    });
    expect(await unlockAndRead()).toMatchObject({
      weekStart: '2026-11-02',
      currentWeekStart: '2026-11-02',
    });
  });

  it('planejamento: "semana de trabalho terminou" vira só no sábado 00:00 SP (sexta 23:30 SP ainda não)', async () => {
    const admin = await loginAdmin(app);
    const plan = await createPlan(admin, '2026-10-26', 'FILA_SEMANAL');
    // 31/10/2026 02:30Z = sexta 30/10 23:30 SP; 03:30Z = sábado 31/10 00:30 SP.
    setClock(() => new Date('2026-10-31T02:30:00Z'));
    expect((await admin.get(`/api/v1/production-plans/${plan.id}`)).body).toMatchObject({
      weekStart: '2026-10-26',
      weekEnded: false,
    });
    setClock(() => new Date('2026-10-31T03:30:00Z'));
    expect((await admin.get(`/api/v1/production-plans/${plan.id}`)).body.weekEnded).toBe(true);
  });

  it('contraprova: com o fuso de Manaus configurado, 03:30Z ainda é domingo — a semana segue o fuso da oficina', async () => {
    const admin = await loginAdmin(app);
    await setShopTimezone(admin, 'America/Manaus');
    const ricardo = await userIdOf('Ricardo');
    setClock(() => MON); // 01/11 23:30 em Manaus
    expect((await admin.get('/api/v1/attendance/team')).body.date).toBe('2026-11-01');
    expect((await admin.get(`/api/v1/production-queue/${ricardo}`)).body.week.start).toBe(
      '2026-10-26',
    );
    setClock(() => new Date('2026-11-02T04:30:00Z')); // 02/11 00:30 em Manaus
    expect((await admin.get('/api/v1/attendance/team')).body.date).toBe('2026-11-02');
    expect((await admin.get(`/api/v1/production-queue/${ricardo}`)).body.week.start).toBe(
      '2026-11-02',
    );
  });
});

type Need = { requirementId: string; need: number; pendingToBuy: number; purchases: unknown[] };
const needOf = async (admin: Client, reqId: string) =>
  ((await admin.get('/api/v1/purchasing/needs?pendingOnly=false')).body as Need[]).find(
    (n) => n.requirementId === reqId,
  )!;
const allocated = async (reqId: string) =>
  (
    await db().purchaseAllocation.findMany({
      where: {
        materialRequirementId: reqId,
        item: { purchaseOrder: { status: { not: 'CANCELADO' } } },
      },
    })
  ).reduce((a, x) => a + Number(x.quantity), 0);
const draftOf = (supplierId: string, reqId: string, quantity: number) => ({
  supplierId,
  expectedDate: '2030-01-10',
  items: [
    {
      sourcing: 'EXCLUSIVO_OS',
      allocations: [{ materialRequirementId: reqId, quantity }],
      quantity,
      unitPriceCents: 4500,
    },
  ],
});

describe('F6-07c / CA6-03 — compras simultâneas da mesma necessidade (soma acima da necessidade)', () => {
  it('8 + 6 simultâneos para 12 (cada uma cabe sozinha): 201 + 409; a vencedora inteira; "A comprar" coerente', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Soma', (s) => [linen(s.items[0].id, 12)]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(12);
    const results = await Promise.all(
      [8, 6].map((q) => createPurchase(admin, draftOf(supplier.id, req.id, q))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201)!;
    const loserIdx = results.findIndex((r) => r.status === 409);
    const won = [8, 6][1 - loserIdx]!;
    // A vencedora foi gravada inteira (nada truncado); a perdedora não gravou nada.
    expect(Number(winner.body.items[0].quantity)).toBe(won);
    expect(await db().purchaseOrder.count()).toBe(1);
    expect(await db().purchaseOrderItem.count()).toBe(1);
    expect(await allocated(req.id)).toBe(won);
    expect(await allocated(req.id)).toBeLessThanOrEqual(12);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(12 - won);
    // O que falta continua comprável exatamente; 1 a mais é recusado.
    expect((await createPurchase(admin, draftOf(supplier.id, req.id, 12 - won + 1))).status).toBe(
      409,
    );
    expect((await createPurchase(admin, draftOf(supplier.id, req.id, 12 - won))).status).toBe(201);
    expect(await allocated(req.id)).toBe(12);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(0);
  });

  it('5 + 7 simultâneos para 12 (soma exata): as duas passam, sem conflito falso', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Exato', (s) => [linen(s.items[0].id, 12)]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    const results = await Promise.all(
      [5, 7].map((q) => createPurchase(admin, draftOf(supplier.id, req.id, q))),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await allocated(req.id)).toBe(12);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(0);
  });

  it('quatro de 4 simultâneos para 12: exatamente três passam, uma recusada; soma alocada = 12', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Quatro', (s) => [
      linen(s.items[0].id, 12),
    ]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    const results = await Promise.all(
      [4, 4, 4, 4].map(() => createPurchase(admin, draftOf(supplier.id, req.id, 4))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409]);
    expect(await db().purchaseOrder.count()).toBe(3);
    expect(await allocated(req.id)).toBe(12);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(0);
  });
});

describe('F6-08 / CA6-04 — cancelar pedido CONFIRMADO devolve a quantidade a "A comprar"', () => {
  it('12 comprados e confirmados → "A comprar" 0; cancelado → volta a 12 e pode ser comprado de novo', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Cancela', (s) => [
      linen(s.items[0].id, 12),
    ]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    const before = await needOf(admin, req.id);
    expect(before).toMatchObject({ need: 12, pendingToBuy: 12 });
    const readinessInitial = (await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`))
      .body;
    const po = await confirmedFabricPurchase(admin, supplier.id, req);
    expect(po.status).toBe('CONFIRMADO');
    const bought = await needOf(admin, req.id);
    expect(bought.pendingToBuy).toBe(0);
    expect(bought.purchases).toHaveLength(1);
    const pendingIds = ((await admin.get('/api/v1/purchasing/needs')).body as Need[]).map(
      (n) => n.requirementId,
    );
    const readinessBefore = (await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`))
      .body;
    const cancel = await admin.post(
      `/api/v1/purchase-orders/${po.id}/cancel`,
      { reason: 'Fornecedor sem estoque', version: po.version },
      { 'idempotency-key': idemKey() },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('CANCELADO');
    const after = await needOf(admin, req.id);
    expect(after.pendingToBuy).toBe(before.pendingToBuy);
    expect(after.pendingToBuy).toBe(12);
    expect(after.purchases).toEqual([]);
    expect(await allocated(req.id)).toBe(0);
    // Lista padrão "A comprar" (só pendentes): fora enquanto comprado, de volta após cancelar.
    expect(pendingIds).not.toContain(req.id);
    const pendingNow = (await admin.get('/api/v1/purchasing/needs')).body as Need[];
    expect(pendingNow.find((n) => n.requirementId === req.id)?.pendingToBuy).toBe(12);
    // Prontidão da OS recalculada: deixa de contar com a compra cancelada.
    const readinessAfter = (await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`))
      .body;
    expect(readinessAfter.state).toBe(readinessInitial.state);
    expect(readinessAfter.state).not.toBe(readinessBefore.state);
    // Recomprar os 12 é aceito (antes do cancelamento seria 409).
    const again = await createPurchase(admin, draftOf(supplier.id, req.id, 12));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(0);
  });

  it('compra parcial de 8 confirmada → "A comprar" 4; cancelada → volta a 12; cancelar de novo é recusado', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Parcial', (s) => [
      linen(s.items[0].id, 12),
    ]);
    const supplier = await createSupplier(admin);
    const req = reqs[0]!;
    const created = await createPurchase(admin, draftOf(supplier.id, req.id, 8));
    expect(created.status).toBe(201);
    const po = (await confirmPurchase(admin, created.body)).body;
    expect(po.status).toBe('CONFIRMADO');
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(4);
    const cancel = await admin.post(
      `/api/v1/purchase-orders/${po.id}/cancel`,
      { reason: 'Preço mudou', version: po.version },
      { 'idempotency-key': idemKey() },
    );
    expect(cancel.status).toBe(200);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(12);
    const twice = await admin.post(
      `/api/v1/purchase-orders/${po.id}/cancel`,
      { reason: 'De novo', version: cancel.body.version },
      { 'idempotency-key': idemKey() },
    );
    expect(twice.status).toBe(422);
    expect((await needOf(admin, req.id)).pendingToBuy).toBe(12);
  });
});

describe('F7-14 / CA7-05 — histórico de ajudas antigas visível no painel', () => {
  const PIN_R = '482915';
  const PIN_J = '121212';
  type Help = { id: string; status: string; code: string };

  /** Ricardo com a tarefa principal liberada; João com tablet (ajudante). */
  async function helpScenario() {
    const admin = await loginAdmin(app);
    await db().companySettings.update({
      where: { id: 1 },
      data: {
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        arrivalWindowStart: '07:00',
        workdayStart: '08:30',
        arrivalAlertAt: '09:30',
        workdayEnd: '18:00',
      },
    });
    const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Ajuda Antiga');
    const ricardo = await userIdOf('Ricardo');
    const plan = await createPlan(admin);
    const yesterday = spDate(new Date(Date.now() - 86_400_000));
    const added = await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: ricardo,
      date: yesterday,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const main = sofaTask(published, so.items[0].id, 'CORTE_TECIDO');
    const r = await tabletOf(app, admin, 'Ricardo', PIN_R);
    const j = await tabletOf(app, admin, 'João', PIN_J);
    return { admin, main, r, j };
  }
  const ask = (c: Client, taskId: string) =>
    post(c, '/api/v1/help-requests', { taskId, kind: 'MOVIMENTAR' });
  const cancel = (c: Client, id: string) =>
    post(c, `/api/v1/help-requests/${id}/cancel`, { reason: 'Consegui sozinho' });

  /** Pedido concluído há 3 semanas (relógio operacional recuado): João chega, apoia e conclui. */
  async function oldConcluded(s: Awaited<ReturnType<typeof helpScenario>>) {
    const oldDay = spDate(new Date(Date.now() - 21 * 86_400_000));
    setClock(() => zonedDateTime(oldDay, '08:40', SP));
    expect((await post(s.j, '/api/v1/attendance/me/arrive')).status).toBe(200);
    setClock(() => zonedDateTime(oldDay, '09:00', SP));
    const h = await ask(s.r, s.main.id);
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(h.body.status).toBe('ATRIBUIDA');
    const support = h.body.supportTask.id as string;
    expect((await act(s.j, support, 'start')).status).toBe(200);
    setClock(() => zonedDateTime(oldDay, '09:20', SP));
    expect((await act(s.j, support, 'complete')).status).toBe(200);
    setClock(() => zonedDateTime(oldDay, '10:00', SP));
    // Cancelado no mesmo dia antigo (ninguém mais presente: fica pendente e é cancelado).
    const c = await ask(s.r, s.main.id);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    if (c.body.status === 'ATRIBUIDA' || c.body.status === 'PENDENTE')
      expect((await cancel(s.r, c.body.id)).status).toBe(200);
    setClock();
    const rows = await db().helpRequest.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((x) => x.status)).toEqual(['CONCLUIDA', 'CANCELADA']);
    expect(spDate(rows[0]!.createdAt)).toBe(oldDay);
    return { concluded: h.body as Help, cancelled: c.body as Help };
  }

  it('ajudas de semanas anteriores (concluída e cancelada) aparecem na listagem do painel e no detalhe', async () => {
    const s = await helpScenario();
    const old = await oldConcluded(s);
    // Uma recente, aberta, junto com as antigas.
    const recent = await ask(s.r, s.main.id);
    expect(recent.status).toBe(201);
    const all = (await s.admin.get('/api/v1/help-requests')).body as Help[];
    expect(all.map((h) => h.id)).toEqual(
      expect.arrayContaining([old.concluded.id, old.cancelled.id, recent.body.id]),
    );
    const done = (await s.admin.get('/api/v1/help-requests?status=CONCLUIDA')).body as Help[];
    expect(done.map((h) => h.id)).toEqual([old.concluded.id]);
    const canc = (await s.admin.get('/api/v1/help-requests?status=CANCELADA')).body as Help[];
    expect(canc.map((h) => h.id)).toEqual([old.cancelled.id]);
    const detail = (await s.admin.get(`/api/v1/help-requests/${old.concluded.id}`)).body;
    expect(detail.status).toBe('CONCLUIDA');
    expect((detail.events as { kind: string }[]).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['SOLICITADA', 'CONCLUIDA']),
    );
  });

  // Rodada 4 (F7-14): bug encontrado por este teste e corrigido — a lista tinha `take: 200` sem
  // paginação (o histórico antigo sumia). Agora `before` (instante de criação) busca a página
  // seguinte, e o painel tem "Carregar mais antigos" na aba ativa.
  it('com mais de 200 pedidos mais novos, a ajuda antiga concluída/cancelada continua acessível (paginação)', async () => {
    const s = await helpScenario();
    const old = await oldConcluded(s);
    // 200 pedidos novos pela rota real (cada um cancelado para liberar o próximo).
    for (let i = 0; i < 200; i++) {
      const h = await ask(s.r, s.main.id);
      expect(h.status, JSON.stringify(h.body)).toBe(201);
      expect((await cancel(s.r, h.body.id)).status).toBe(200);
    }
    expect(await db().helpRequest.count()).toBe(202);
    // Primeira página: limitada a 200 (como antes).
    const first = (await s.admin.get('/api/v1/help-requests?status=CANCELADA')).body as Help[];
    expect(first).toHaveLength(200);
    // Páginas por `before` (como o painel): percorre todo o histórico, sem repetir nem pular.
    const pageAll = async (status?: string) => {
      const seen: Help[] = [];
      let before = new Date(Date.now() + 86_400_000).toISOString();
      for (;;) {
        const r = await s.admin.get(
          `/api/v1/help-requests?${status ? `status=${status}&` : ''}before=${encodeURIComponent(before)}`,
        );
        expect(r.status).toBe(200);
        const page = r.body as (Help & { createdAt: string })[];
        seen.push(...page);
        if (page.length < 200) return seen;
        before = page[page.length - 1]!.createdAt;
      }
    };
    const all = await pageAll();
    expect(all).toHaveLength(202);
    expect(new Set(all.map((h) => h.id)).size).toBe(202);
    expect(all.map((h) => h.id)).toContain(old.concluded.id);
    const cancelled = await pageAll('CANCELADA');
    expect(cancelled).toHaveLength(201);
    expect(cancelled.map((h) => h.id)).toContain(old.cancelled.id);
    // Parâmetro inválido é recusado (não é ignorado em silêncio).
    expect((await s.admin.get('/api/v1/help-requests?before=ontem')).status).toBe(400);
  }, 240_000);
});
