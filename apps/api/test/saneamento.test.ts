import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  closingWeekStart,
  compareQueue,
  mondayOf,
  SIMPLIFIED_PRODUCTION_TEMPLATES,
  zonedDateTime,
} from '@cenario/shared';
import type { ProductionActivity } from '@cenario/db';
import { runSeed } from '@cenario/db/seed';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock as setCoreClock } from '../src/core/clock';
import { detectAbsences } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, employeeByName, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  createCustomer,
  createOrder,
  createPickup,
  panelUserWith,
  receiptBody,
} from './commercial-helpers';
import { addOs, createPlan, day, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Saneamento funcional — regressão das quatro causas raiz (referência homologada 406fde7):
 *  A. Novo serviço: o tipo de serviço é de cada peça (antes, um tipo único para todas).
 *  B. Ausência: só o trabalho que dependia da pessoa no dia (antes, no modo fila, toda tarefa
 *     sem horário entrava — a fila inteira, de todas as semanas).
 *  C. Prioridade: uma só, a do serviço (OS ↔ planejamento ↔ tarefas não iniciadas), sem
 *     quebrar a D9 nem a ordem manual; o prazo prometido não reordena nada.
 *  D. Viagem sem custo: confirmação pela tela do fechamento (rota existente), com repetição e
 *     concorrência tratadas.
 * Equipe do seed: Ricardo e Márcio (tapeceiros), João (preparação), Thiago; André (logística).
 */
let app: App;
const TZ = 'America/Sao_Paulo';
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
  setCoreClock();
  setAttendanceClock();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(() => {
  setCoreClock();
  setAttendanceClock();
});

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function team() {
  return {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
  };
}

/** OS com as peças recebidas (OS manual, como nos testes do pré-planejamento). */
async function os(
  admin: Client,
  name: string,
  pieces: { pieceType: string; description: string; serviceType?: string }[] = [
    { pieceType: 'SOFA', description: 'Sofá' },
  ],
) {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(
    admin,
    customer,
    pieces.map((p) => ({ pieceType: p.pieceType, description: p.description, quantity: 1 })),
  );
  const rec = await post(
    admin,
    '/api/v1/receipts',
    receiptBody(
      order.id,
      order.items.map((i: { id: string }) => ({ orderItemId: i.id, quantity: 1 })),
    ),
  );
  expect(rec.status).toBe(201);
  const so = await post(admin, '/api/v1/service-orders', {
    orderId: order.id,
    items: order.items.map((i: { id: string }, k: number) => ({
      orderItemId: i.id,
      quantity: 1,
      description: pieces[k]!.description,
      serviceType: pieces[k]!.serviceType ?? 'REFORMA_COMPLETA',
    })),
  });
  expect(so.status, JSON.stringify(so.body)).toBe(201);
  return so.body as { id: string; code: string; items: { id: string; position: number }[] };
}

/** Planeja a OS (fila semanal) com Ricardo de titular; devolve o id do plano da semana. */
async function plan(
  admin: Client,
  so: { id: string; items: { id: string }[] },
  startDate: string,
  owner: string,
  priority?: string,
) {
  const r = await post(admin, '/api/v1/production/plan-services', {
    entries: [
      {
        serviceOrderId: so.id,
        startDate,
        ...(priority ? { priority } : {}),
        pieces: so.items.map((i) => ({ serviceOrderItemId: i.id, upholstererUserId: owner })),
      },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.planned[0].planId as string;
}
const planDto = async (admin: Client, id: string) =>
  (await admin.get(`/api/v1/production-plans/${id}`)).body as {
    id: string;
    version: number;
    status: string;
    revision: number;
    items: { id: string; serviceOrder: { id: string }; version: number; priority: string }[];
  };
async function publishWeek(admin: Client, planId: string) {
  const p = await planDto(admin, planId);
  const r = await post(admin, `/api/v1/production-plans/${planId}/publish`, {
    version: p.version,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const tasksOf = (soId: string) =>
  db().productionTask.findMany({
    where: { serviceOrderId: soId, status: { not: 'CANCELADA' } },
    orderBy: { sequence: 'asc' },
  });

// ───────────────────────────── A ─────────────────────────────

describe('A. Novo serviço: tipo de serviço por peça', () => {
  // Modelos simplificados (Reforma completa de sofá) entram pelos MESMOS comandos da migration.
  const migrationInserts = readFileSync(
    resolve(
      __dirname,
      '../../../packages/db/prisma/migrations/20261230000000_modelos_simplificados/migration.sql',
    ),
    'utf8',
  )
    .replace(/--.*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('INSERT'));
  const REFORMA = SIMPLIFIED_PRODUCTION_TEMPLATES[0]!.id;
  beforeEach(async () => {
    for (const st of migrationInserts) await db().$executeRawUnsafe(st);
    await runSeed({ withTeam: true, log: () => undefined });
  });

  let phone = 0;
  const customer = (name: string) => ({
    mode: 'NOVO',
    kind: 'PF',
    name,
    phone: `(11) 9888${++phone}-77${String(phone).padStart(2, '0')}`,
  });
  const service = (items: Record<string, unknown>[]) => ({
    contractedService: 'Serviços combinados',
    agreedValueCents: 300000,
    paymentTerms: 'A combinar',
    promisedDate: day(30),
    items,
  });
  /** Novo serviço sem retirada (o cliente traz as peças) + chegada → OS automática. */
  async function newService(admin: Client, name: string, items: Record<string, unknown>[]) {
    const r = await post(admin, '/api/v1/services', {
      customer: customer(name),
      service: service(items),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const order = await db().commercialOrder.findUniqueOrThrow({
      where: { id: r.body.order.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    const rec = await post(admin, '/api/v1/receipts', {
      orderId: order.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      lines: order.items.map((i) => ({
        orderItemId: i.id,
        quantity: i.quantity,
        condition: 'BOA',
        location: 'Área de recebimento',
      })),
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const so = await db().serviceOrder.findUniqueOrThrow({
      where: { id: rec.body.generatedServiceOrder.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    return { order, so };
  }

  it('tipos diferentes por peça: pedido, OS e modelo de produção de cada peça', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const { order, so } = await newService(admin, 'Cliente Tipos Diferentes', [
      {
        pieceType: 'SOFA',
        description: 'Sofá 3 lugares',
        quantity: 1,
        serviceType: 'REFORMA_COMPLETA',
      },
      {
        pieceType: 'SOFA',
        description: 'Sofá 2 lugares',
        quantity: 1,
        serviceType: 'TROCA_DE_TECIDO',
      },
      { pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1, serviceType: 'REPARO' },
    ]);
    expect(order.items.map((i) => i.serviceType)).toEqual([
      'REFORMA_COMPLETA',
      'TROCA_DE_TECIDO',
      'REPARO',
    ]);
    expect(so.items.map((i) => i.serviceType)).toEqual([
      'REFORMA_COMPLETA',
      'TROCA_DE_TECIDO',
      'REPARO',
    ]);
    // Descrição padrão do serviço continua a informada (nada inventado no servidor).
    expect(order.contractedService).toBe('Serviços combinados');
    // O planejamento escolhe o modelo pela peça: Reforma completa → modelo simplificado;
    // troca de tecido e reparo → modelos gerais (antigos).
    const pipeline = (await admin.get('/api/v1/production/pipeline')).body as {
      items: {
        serviceOrder: { id: string };
        pieces: { id: string; template: string | null }[];
      }[];
    };
    const entry = pipeline.items.find((i) => i.serviceOrder.id === so.id)!;
    const tpl = (itemId: string) => entry.pieces.find((x) => x.id === itemId)?.template;
    expect(tpl(so.items[0]!.id)).toBe(SIMPLIFIED_PRODUCTION_TEMPLATES[0]!.name);
    expect(tpl(so.items[1]!.id)).toBe('Reforma de sofá');
    expect(tpl(so.items[2]!.id)).toBe('Cadeira ou poltrona');
    await plan(admin, { id: so.id, items: so.items }, today(), p.ricardo);
    const byItem = async (itemId: string) =>
      db().productionTask.findMany({ where: { serviceOrderItemId: itemId } });
    const reforma = await byItem(so.items[0]!.id);
    expect(reforma.length).toBe(3);
    expect(reforma.every((t) => t.templateId === REFORMA)).toBe(true);
    const troca = await byItem(so.items[1]!.id);
    expect(troca.length).toBeGreaterThan(3);
    expect(troca.every((t) => t.templateId && t.templateId !== REFORMA)).toBe(true);
    const reparo = await byItem(so.items[2]!.id);
    expect(reparo.length).toBeGreaterThan(0);
    expect(reparo.every((t) => t.templateId !== REFORMA)).toBe(true);
  });

  it('uma peça e várias do mesmo tipo: cada item grava o seu tipo', async () => {
    const admin = await loginAdmin(app);
    const one = await newService(admin, 'Cliente Uma Peça', [
      { pieceType: 'CADEIRA', description: 'Cadeira', quantity: 1, serviceType: 'REPARO' },
    ]);
    expect(one.so.items.map((i) => i.serviceType)).toEqual(['REPARO']);
    const same = await newService(admin, 'Cliente Mesmo Tipo', [
      {
        pieceType: 'CADEIRA',
        description: 'Cadeiras',
        quantity: 4,
        serviceType: 'TROCA_DE_TECIDO',
      },
      {
        pieceType: 'POLTRONA',
        description: 'Poltrona',
        quantity: 1,
        serviceType: 'TROCA_DE_TECIDO',
      },
    ]);
    expect(same.order.items.map((i) => [i.quantity, i.serviceType])).toEqual([
      [4, 'TROCA_DE_TECIDO'],
      [1, 'TROCA_DE_TECIDO'],
    ]);
    expect(same.so.items.map((i) => [i.quantity, i.serviceType])).toEqual([
      [4, 'TROCA_DE_TECIDO'],
      [1, 'TROCA_DE_TECIDO'],
    ]);
  });

  it('atomicidade e idempotência: peça sem tipo recusa tudo; repetição não duplica', async () => {
    const admin = await loginAdmin(app);
    const before = await db().commercialOrder.count();
    const bad = await post(admin, '/api/v1/services', {
      customer: customer('Cliente Sem Tipo'),
      service: service([
        { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        { pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1 },
      ]),
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('items.1.serviceType');
    expect(await db().commercialOrder.count()).toBe(before);
    expect(await db().customer.count({ where: { name: 'Cliente Sem Tipo' } })).toBe(0);
    const key = idemKey();
    const body = {
      customer: customer('Cliente Repetição'),
      service: service([
        { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        { pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1, serviceType: 'REPARO' },
      ]),
    };
    const [r1, r2] = await Promise.all([
      post(admin, '/api/v1/services', body, key),
      post(admin, '/api/v1/services', body, key),
    ]);
    const r3 = await post(admin, '/api/v1/services', body, key);
    const ok = [r1, r2, r3].filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.order.id)).size).toBe(1);
    expect(await db().commercialOrder.count()).toBe(before + 1);
    const items = await db().commercialOrderItem.findMany({
      where: { orderId: ok[0]!.body.order.id },
      orderBy: { position: 'asc' },
    });
    expect(items.map((i) => i.serviceType)).toEqual(['REFORMA_COMPLETA', 'REPARO']);
  });
});

// ───────────────────────────── B ─────────────────────────────

describe('B. Ausência: só o trabalho do dia (modo fila)', () => {
  const PINS: Record<string, string> = {
    Ricardo: '482915',
    Márcio: '736152',
    Thiago: '271828',
    João: '121212',
  };
  const at = (hhmm: string) => zonedDateTime(today(), hhmm, TZ);
  const clock = (hhmm: string) => setAttendanceClock(() => at(hhmm));
  beforeEach(async () => {
    await db().companySettings.update({
      where: { id: 1 },
      data: {
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        arrivalWindowStart: '07:00',
        workdayStart: '08:30',
        arrivalAlertAt: '09:30',
        workdayEnd: '18:00',
        lateAlertMinutes: 15,
      },
    });
    clock('08:00');
  });

  /**
   * Três OS nesta semana (início hoje) e uma na semana seguinte, todas com Ricardo de titular;
   * João fica com desmontagem e preparação de cada uma (modelo geral do sofá). Tudo publicado.
   * A fila do João: OS1 desmontagem (destaque, liberada), OS1 preparação (aguarda), OS2…, OS3…
   * e as da semana seguinte (programadas).
   */
  async function queueScenario(arrive: string[]) {
    const admin = await loginAdmin(app);
    const p = await team();
    const sos = [];
    for (const n of [1, 2, 3]) sos.push(await os(admin, `Cliente Fila ${n}`));
    const week = await plan(admin, sos[0]!, today(), p.ricardo);
    await plan(admin, sos[1]!, today(), p.ricardo);
    await plan(admin, sos[2]!, today(), p.ricardo);
    const nextSo = await os(admin, 'Cliente Semana Seguinte');
    const nextWeek = await plan(admin, nextSo, mondayOf(plusDays(today(), 7)), p.ricardo);
    await publishWeek(admin, week);
    await publishWeek(admin, nextWeek);
    const tablets: Record<string, Client> = {};
    for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'])
      tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
    clock('08:30');
    for (const name of arrive) {
      const r = await post(tablets[name]!, '/api/v1/attendance/me/arrive', {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    clock('09:00');
    const task = async (soId: string, activity: ProductionActivity) =>
      db().productionTask.findFirstOrThrow({ where: { serviceOrderId: soId, activity } });
    return { admin, p, sos, nextSo, week, nextWeek, tablets, task };
  }
  const confirmAbsence = async (admin: Client, name: string) => {
    const e = await employeeByName(name);
    const r = await admin.post('/api/v1/attendance/actions', {
      date: today(),
      employeeId: e.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Avisou que não vem',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const proposals = async (admin: Client) =>
    (await admin.get('/api/v1/reschedule-proposals')).body as {
      kind: string;
      status: string;
      affectedTasks: { id: string }[];
      alternatives: { id: string; actions: { taskId: string }[] }[];
    }[];
  const assignees = async (ids: string[]) =>
    (
      await db().productionTask.findMany({
        where: { id: { in: ids } },
        select: { id: true, assigneeUserId: true, scheduledAt: true, status: true },
      })
    ).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  it('profissional presente: nada é analisado nem alterado', async () => {
    const s = await queueScenario(['Ricardo', 'Márcio', 'João', 'Thiago']);
    clock('09:31');
    await detectAbsences(db());
    expect(await proposals(s.admin)).toEqual([]);
    expect(await db().planningAction.count()).toBe(0);
  });

  it('ausência confirmada (apoio): só o destaque da fila muda; resto da fila e semana seguinte intactos', async () => {
    const s = await queueScenario(['Ricardo', 'Márcio', 'Thiago']);
    const head = await s.task(s.sos[0]!.id, 'DESMONTAGEM');
    expect(head.status).toBe('LIBERADA');
    expect(head.scheduledAt).toBeNull();
    const rest = [
      (await s.task(s.sos[0]!.id, 'PREPARACAO')).id,
      (await s.task(s.sos[1]!.id, 'DESMONTAGEM')).id,
      (await s.task(s.sos[1]!.id, 'PREPARACAO')).id,
      (await s.task(s.sos[2]!.id, 'DESMONTAGEM')).id,
      (await s.task(s.sos[2]!.id, 'PREPARACAO')).id,
      (await s.task(s.nextSo.id, 'DESMONTAGEM')).id,
      (await s.task(s.nextSo.id, 'PREPARACAO')).id,
    ];
    const ricardoTasks = (
      await db().productionTask.findMany({ where: { assigneeUserId: s.p.ricardo } })
    ).map((t) => t.id);
    await confirmAbsence(s.admin, 'João');
    // A tarefa que o João pegaria agora (apoio simples) vai para quem está presente e capacitado.
    const moved = (await assignees([head.id]))[0]!;
    expect(moved.assigneeUserId).not.toBe(s.p.joao);
    expect(moved.assigneeUserId).not.toBeNull();
    expect(moved.scheduledAt).toBeNull();
    const actions = await db().planningAction.findMany({ where: { kind: 'TAREFA_REATRIBUIDA' } });
    expect(actions.map((a) => a.taskId)).toEqual([head.id]);
    // Nenhuma proposta em massa: nada mais dependia do João hoje.
    expect(await proposals(s.admin)).toEqual([]);
    // O restante da fila (inclusive a semana seguinte) segue com o João, sem horário.
    for (const t of await assignees(rest)) {
      expect(t.assigneeUserId).toBe(s.p.joao);
      expect(t.scheduledAt).toBeNull();
    }
    // Tarefas de outro profissional não são tocadas.
    const after = await db().productionTask.findMany({ where: { id: { in: ricardoTasks } } });
    expect(after.every((t) => t.assigneeUserId === s.p.ricardo && t.scheduledAt === null)).toBe(
      true,
    );
  });

  it('prazo interno até hoje, apoio de ontem e múltiplas tarefas: entram só as do dia', async () => {
    const s = await queueScenario(['Ricardo', 'Márcio', 'Thiago']);
    const head = await s.task(s.sos[0]!.id, 'DESMONTAGEM');
    // Tarefa da fila com prazo interno hoje (não é o destaque): depende do João hoje.
    const dueToday = await s.task(s.sos[2]!.id, 'DESMONTAGEM');
    await db().productionTask.update({
      where: { id: dueToday.id },
      data: { dueDate: new Date(`${today()}T00:00:00Z`) },
    });
    // Apoio (ajuda) de ontem ainda não concluído, do João: tem horário → entra.
    const supportOf = await s.task(s.sos[1]!.id, 'CORTE_TECIDO');
    const helpTask = await db().productionTask.create({
      data: {
        planId: s.week,
        serviceOrderId: s.sos[1]!.id,
        activity: 'APOIO',
        role: 'APOIO',
        title: 'Apoio: parafusar estrutura',
        status: 'LIBERADA',
        priority: 'NORMAL',
        assigneeUserId: s.p.joao,
        supportForTaskId: supportOf.id,
        scheduledAt: zonedDateTime(day(-1), '14:00', TZ),
        sequence: 99,
      },
    });
    expect(helpTask.queueExclusive).toBe(false);
    const untouched = [
      (await s.task(s.sos[1]!.id, 'DESMONTAGEM')).id,
      (await s.task(s.nextSo.id, 'DESMONTAGEM')).id,
    ];
    await confirmAbsence(s.admin, 'João');
    const auto = (
      await db().planningAction.findMany({ where: { kind: 'TAREFA_REATRIBUIDA' } })
    ).map((a) => a.taskId);
    // Destaque e apoio (simples): automáticos. Prazo hoje: vai ao gestor (não é simples).
    expect(auto.sort()).toEqual([head.id, helpTask.id].sort());
    const list = await proposals(s.admin);
    expect(list).toHaveLength(1);
    expect(list[0]!.affectedTasks.map((t) => t.id)).toEqual([dueToday.id]);
    for (const alt of list[0]!.alternatives)
      for (const a of alt.actions ?? []) expect(a.taskId).toBe(dueToday.id);
    for (const t of await assignees(untouched)) expect(t.assigneeUserId).toBe(s.p.joao);
  });

  it('concluída e cancelada não contam: o destaque passa à próxima tarefa executável', async () => {
    const s = await queueScenario(['Ricardo', 'Márcio', 'Thiago']);
    const first = await s.task(s.sos[0]!.id, 'DESMONTAGEM');
    await db().productionTask.update({
      where: { id: first.id },
      data: { status: 'CONCLUIDA', startedAt: new Date(), completedAt: new Date() },
    });
    await db().productionTask.updateMany({
      where: { serviceOrderId: s.sos[1]!.id, assigneeUserId: s.p.joao },
      data: { status: 'CANCELADA', cancelReason: 'Peça retirada pelo cliente' },
    });
    const third = await s.task(s.sos[2]!.id, 'DESMONTAGEM');
    await confirmAbsence(s.admin, 'João');
    const auto = (
      await db().planningAction.findMany({ where: { kind: 'TAREFA_REATRIBUIDA' } })
    ).map((a) => a.taskId);
    expect(auto).toEqual([third.id]);
    expect((await assignees([first.id]))[0]!.assigneeUserId).toBe(s.p.joao);
    expect(await proposals(s.admin)).toEqual([]);
  });

  it('titular ausente: proposta só com a tarefa de hoje; bloqueadas e futuras ficam fora', async () => {
    const s = await queueScenario(['Márcio', 'João', 'Thiago']);
    // Atalho de dados: preparação da OS1 pronta → corte da OS1 liberado (destaque do Ricardo).
    await db().productionTask.updateMany({
      where: { serviceOrderId: s.sos[0]!.id, assigneeUserId: s.p.joao },
      data: { status: 'CONCLUIDA', startedAt: new Date(), completedAt: new Date() },
    });
    const corte = await s.task(s.sos[0]!.id, 'CORTE_TECIDO');
    await db().productionTask.update({
      where: { id: corte.id },
      data: { status: 'LIBERADA', blockers: [] },
    });
    const others = (
      await db().productionTask.findMany({
        where: { assigneeUserId: s.p.ricardo, id: { not: corte.id } },
      })
    ).map((t) => t.id);
    expect(others.length).toBeGreaterThan(10);
    await confirmAbsence(s.admin, 'Ricardo');
    const list = await proposals(s.admin);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'AUSENCIA', status: 'PENDENTE' });
    expect(list[0]!.affectedTasks.map((t) => t.id)).toEqual([corte.id]);
    const ids = list[0]!.alternatives.flatMap((a) => (a.actions ?? []).map((x) => x.taskId));
    expect(new Set(ids)).toEqual(new Set([corte.id]));
    // Nada aplicado antes da decisão do gestor; tarefa principal nunca muda sozinha.
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_REATRIBUIDA' } })).toBe(0);
    for (const t of await assignees([corte.id, ...others])) {
      expect(t.assigneeUserId).toBe(s.p.ricardo);
      expect(t.scheduledAt).toBeNull();
    }
  });

  it('ausência sem tarefa afetada (Márcio) e ausência presumida na fila: nada em massa', async () => {
    const s = await queueScenario(['Ricardo', 'Thiago']);
    await confirmAbsence(s.admin, 'Márcio');
    expect(await proposals(s.admin)).toEqual([]);
    expect(await db().planningAction.count()).toBe(0);
    // João não chegou: ausência presumida às 9h30 só sugere; nunca altera a fila.
    clock('09:31');
    await detectAbsences(db());
    await detectAbsences(db());
    const list = await proposals(s.admin);
    expect(list.length).toBeLessThanOrEqual(1);
    for (const p of list) expect(p.affectedTasks.length).toBeLessThanOrEqual(1);
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_REATRIBUIDA' } })).toBe(0);
    const joao = await db().productionTask.findMany({ where: { assigneeUserId: s.p.joao } });
    expect(joao.length).toBe(8);
    expect(joao.every((t) => t.scheduledAt === null)).toBe(true);
  });
});

// ───────────────────────────── C ─────────────────────────────

describe('C. Prioridade única do serviço; prazo não reordena; D9 preservada', () => {
  const base = () => mondayOf(plusDays(today(), 7));
  async function orderOf(userId: string, planId: string) {
    const rows = await db().productionTask.findMany({
      where: {
        planId,
        assigneeUserId: userId,
        supportForTaskId: null,
        status: { notIn: ['CONCLUIDA', 'CANCELADA'] },
      },
      select: {
        id: true,
        serviceOrderId: true,
        priority: true,
        queuePosition: true,
        sequence: true,
        number: true,
      },
    });
    const sorted = [...rows].sort((a, b) =>
      compareQueue({ ...a, weekStart: null }, { ...b, weekStart: null }),
    );
    return {
      services: [...new Set(sorted.map((t) => t.serviceOrderId))],
      taskIds: sorted.map((t) => t.id),
      positions: sorted.map((t) => t.queuePosition),
    };
  }
  const contiguous = (positions: (number | null)[]) =>
    expect(positions).toEqual(positions.map((_, i) => i + 1));
  const soOf = (id: string) => db().serviceOrder.findUniqueOrThrow({ where: { id } });
  const itemOf = (planId: string, soId: string) =>
    db().productionPlanItem.findUniqueOrThrow({
      where: { planId_serviceOrderId: { planId, serviceOrderId: soId } },
    });
  async function editOs(admin: Client, id: string, patch: Record<string, unknown>) {
    const cur = await soOf(id);
    return put(admin, `/api/v1/service-orders/${id}`, {
      priority: cur.priority,
      promisedDate: cur.promisedDate?.toISOString().slice(0, 10) ?? null,
      technicalInstructions: cur.technicalInstructions ?? undefined,
      notes: cur.notes ?? undefined,
      version: cur.version,
      ...patch,
    });
  }
  async function three(admin: Client) {
    const p = await team();
    const a = await os(admin, 'Cliente A Segunda');
    const b = await os(admin, 'Cliente B Terça');
    const c = await os(admin, 'Cliente C Quarta');
    const planId = await plan(admin, a, base(), p.ricardo);
    await plan(admin, b, plusDays(base(), 1), p.ricardo);
    await plan(admin, c, plusDays(base(), 2), p.ricardo);
    return { p, a, b, c, planId };
  }

  it('criação: OS e planejamento nascem com a mesma prioridade; planejar com outra atualiza a OS', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const a = await os(admin, 'Cliente Normal');
    const planId = await plan(admin, a, base(), p.ricardo);
    expect((await soOf(a.id)).priority).toBe('NORMAL');
    expect((await itemOf(planId, a.id)).priority).toBe('NORMAL');
    const b = await os(admin, 'Cliente Urgente no Planejamento');
    await plan(admin, b, base(), p.ricardo, 'URGENTE');
    expect((await soOf(b.id)).priority).toBe('URGENTE');
    expect((await itemOf(planId, b.id)).priority).toBe('URGENTE');
    expect((await tasksOf(b.id)).every((t) => t.priority === 'URGENTE')).toBe(true);
    // Mesma regra ao incluir a OS numa semana pela tela do planejamento semanal.
    const c = await os(admin, 'Cliente Alta na Semana');
    const week = await createPlan(admin, plusDays(today(), 14), 'FILA_SEMANAL');
    const added = await addOs(admin, week.id, {
      serviceOrderId: c.id,
      priority: 'ALTA',
      pieces: [{ serviceOrderItemId: c.items[0]!.id, upholstererUserId: p.ricardo }],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await soOf(c.id)).priority).toBe('ALTA');
    expect((await itemOf(week.id, c.id)).priority).toBe('ALTA');
  });

  it('OS em "A planejar": mudar na OS vale como padrão do planejamento', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const a = await os(admin, 'Cliente A Planejar');
    expect((await editOs(admin, a.id, { priority: 'ALTA' })).status).toBe(200);
    expect(await db().productionPlanItem.count({ where: { serviceOrderId: a.id } })).toBe(0);
    const planId = await plan(admin, a, base(), p.ricardo);
    expect((await itemOf(planId, a.id)).priority).toBe('ALTA');
    expect((await tasksOf(a.id)).every((t) => t.priority === 'ALTA')).toBe(true);
  });

  it('OS já planejada (rascunho): prioridade na OS → item, tarefas e posição só desta OS (D9)', async () => {
    const admin = await loginAdmin(app);
    const { p, a, b, c, planId } = await three(admin);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([a.id, b.id, c.id]);
    const r = await editOs(admin, c.id, { priority: 'URGENTE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await itemOf(planId, c.id)).priority).toBe('URGENTE');
    expect((await tasksOf(c.id)).every((t) => t.priority === 'URGENTE')).toBe(true);
    const o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([c.id, a.id, b.id]);
    contiguous(o.positions);
    // As outras OS não mudaram de prioridade.
    expect((await itemOf(planId, a.id)).priority).toBe('NORMAL');
    expect((await tasksOf(b.id)).every((t) => t.priority === 'NORMAL')).toBe(true);
  });

  it('semana publicada: mudar na OS exige motivo e registra revisão; ordem manual das demais preservada', async () => {
    const admin = await loginAdmin(app);
    const { p, a, b, c, planId } = await three(admin);
    await publishWeek(admin, planId);
    // Gestor reordena manualmente: B, C, A.
    const now = await orderOf(p.ricardo, planId);
    const so = new Map(
      (
        await db().productionTask.findMany({
          where: { id: { in: now.taskIds } },
          select: { id: true, serviceOrderId: true },
        })
      ).map((t) => [t.id, t.serviceOrderId]),
    );
    const by = (id: string) => now.taskIds.filter((t) => so.get(t) === id);
    const r = await put(admin, `/api/v1/production-plans/${planId}/queue`, {
      userId: p.ricardo,
      taskIds: [...by(b.id), ...by(c.id), ...by(a.id)],
      version: (await planDto(admin, planId)).version,
      reason: 'Ordem combinada com a equipe',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([b.id, c.id, a.id]);
    const rev = (await planDto(admin, planId)).revision;
    // Sem motivo: recusado e nada muda (nem a OS).
    const noReason = await editOs(admin, a.id, { priority: 'ALTA' });
    expect(noReason.status).toBe(400);
    expect((await soOf(a.id)).priority).toBe('NORMAL');
    expect((await itemOf(planId, a.id)).priority).toBe('NORMAL');
    // Com motivo: A (ALTA) vai à frente da faixa; B e C mantêm a ordem manual entre si.
    const ok = await editOs(admin, a.id, {
      priority: 'ALTA',
      reason: 'Cliente antecipou a viagem',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([a.id, b.id, c.id]);
    contiguous(o.positions);
    expect((await planDto(admin, planId)).revision).toBe(rev + 1);
    expect((await tasksOf(a.id)).every((t) => t.priority === 'ALTA')).toBe(true);
    // Mesma prioridade de novo: nada a revisar.
    expect((await editOs(admin, a.id, { priority: 'ALTA', reason: 'Sem mudança' })).status).toBe(
      200,
    );
    expect((await planDto(admin, planId)).revision).toBe(rev + 1);
  });

  it('alteração de prazo prometido não reordena a fila nem muda prioridade', async () => {
    const admin = await loginAdmin(app);
    const { p, a, b, c, planId } = await three(admin);
    await publishWeek(admin, planId);
    const before = await orderOf(p.ricardo, planId);
    const rev = (await planDto(admin, planId)).revision;
    const r = await editOs(admin, c.id, { promisedDate: day(1) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await orderOf(p.ricardo, planId);
    expect(after).toEqual(before);
    expect(after.services).toEqual([a.id, b.id, c.id]);
    expect((await itemOf(planId, c.id)).priority).toBe('NORMAL');
    expect((await planDto(admin, planId)).revision).toBe(rev);
  });

  it('reprogramação (mesma semana e troca de semana) e item do planejamento: a OS acompanha', async () => {
    const admin = await loginAdmin(app);
    const { a, b, planId } = await three(admin);
    const pipelineEntry = async (soId: string) =>
      (
        (await admin.get('/api/v1/production/pipeline')).body as {
          items: {
            serviceOrder: { id: string };
            plan: { itemId: string; version: number } | null;
          }[];
        }
      ).items.find((i) => i.serviceOrder.id === soId)!;
    // Reprogramar só a prioridade (mesma semana).
    let e = await pipelineEntry(a.id);
    let r = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      priority: 'ALTA',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await soOf(a.id)).priority).toBe('ALTA');
    expect((await tasksOf(a.id)).every((t) => t.priority === 'ALTA')).toBe(true);
    // Virada de semana com nova prioridade: OS acompanha; posição pela data na semana destino.
    e = await pipelineEntry(b.id);
    const next = plusDays(base(), 7);
    r = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      startDate: plusDays(next, 1),
      priority: 'URGENTE',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await soOf(b.id)).priority).toBe('URGENTE');
    const moved = await db().productionPlanItem.findFirstOrThrow({
      where: { serviceOrderId: b.id },
    });
    expect(moved.planId).not.toBe(planId);
    expect(moved.priority).toBe('URGENTE');
    expect((await tasksOf(b.id)).every((t) => t.priority === 'URGENTE')).toBe(true);
    // Item do planejamento (tela da semana): todas as tarefas não iniciadas + OS.
    const item = await itemOf(planId, a.id);
    r = await put(admin, `/api/v1/production-plans/${planId}/items/${item.id}`, {
      priority: 'BAIXA',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await soOf(a.id)).priority).toBe('BAIXA');
    expect((await itemOf(planId, a.id)).priority).toBe('BAIXA');
    expect((await tasksOf(a.id)).every((t) => t.priority === 'BAIXA')).toBe(true);
  });

  it('tarefa iniciada não muda de prioridade; dados antigos divergentes não são reescritos sem ação', async () => {
    const admin = await loginAdmin(app);
    const { p, a, planId } = await three(admin);
    await publishWeek(admin, planId);
    const [first, ...others] = await tasksOf(a.id);
    // Atalho de dados: primeira etapa já em execução (início antes da mudança).
    await db().productionTask.update({
      where: { id: first!.id },
      data: { status: 'EM_EXECUCAO', startedAt: new Date() },
    });
    // Dado antigo: item do planejamento divergente da OS (antes do saneamento).
    await db().productionPlanItem.update({
      where: { id: (await itemOf(planId, a.id)).id },
      data: { priority: 'BAIXA' },
    });
    expect((await soOf(a.id)).priority).toBe('NORMAL');
    // Leitura não altera nada.
    await admin.get('/api/v1/production/pipeline');
    await admin.get(`/api/v1/production-plans/${planId}`);
    expect((await itemOf(planId, a.id)).priority).toBe('BAIXA');
    // Mudança explícita na OS alinha tudo, menos a tarefa já iniciada.
    const cur = await soOf(a.id);
    const r = await put(admin, `/api/v1/service-orders/${a.id}`, {
      priority: 'ALTA',
      version: cur.version,
      reason: 'Prioridade revista',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await itemOf(planId, a.id)).priority).toBe('ALTA');
    const after = await db().productionTask.findMany({
      where: { id: { in: [first!.id, ...others.map((t) => t.id)] } },
    });
    expect(after.find((t) => t.id === first!.id)!.priority).toBe('NORMAL');
    expect(
      after
        .filter((t) => t.id !== first!.id && t.assigneeUserId === p.ricardo)
        .every((t) => t.priority === 'ALTA'),
    ).toBe(true);
  });

  it('D9 (regressão): datas definem a posição inicial; nova OS entra pela data sem desfazer a ordem manual', async () => {
    const admin = await loginAdmin(app);
    const { p, a, b, c, planId } = await three(admin);
    const now = await orderOf(p.ricardo, planId);
    const so = new Map(
      (
        await db().productionTask.findMany({
          where: { id: { in: now.taskIds } },
          select: { id: true, serviceOrderId: true },
        })
      ).map((t) => [t.id, t.serviceOrderId]),
    );
    const by = (id: string) => now.taskIds.filter((t) => so.get(t) === id);
    // Manual: C, A, B.
    const r = await put(admin, `/api/v1/production-plans/${planId}/queue`, {
      userId: p.ricardo,
      taskIds: [...by(c.id), ...by(a.id), ...by(b.id)],
      version: (await planDto(admin, planId)).version,
    });
    expect(r.status).toBe(200);
    // Mudança de prioridade de C para a mesma faixa (NORMAL → NORMAL): nada se move.
    expect((await editOs(admin, c.id, { priority: 'NORMAL' })).status).toBe(200);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([c.id, a.id, b.id]);
    // Nova OS na segunda: entra depois da última com data ≤ segunda (A); ordem manual preservada.
    const d = await os(admin, 'Cliente D Segunda');
    await plan(admin, d, base(), p.ricardo);
    let o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([c.id, a.id, d.id, b.id]);
    contiguous(o.positions);
    // Outra na terça (mesma data de B): quem veio antes fica antes — entra depois de B.
    const e = await os(admin, 'Cliente E Terça');
    await plan(admin, e, plusDays(base(), 1), p.ricardo);
    o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([c.id, a.id, d.id, b.id, e.id]);
    contiguous(o.positions);
  });
});

// ───────────────────────────── D ─────────────────────────────

describe('D. Confirmar viagem sem custo (tela do fechamento)', () => {
  const F = (path: string) => `/api/v1/finance${path}`;
  async function realizedPickup(admin: Client, name: string) {
    const andre = await userIdOf('André');
    await put(admin, F('/logistics-defaults'), {
      defaultPickupCostCents: null,
      defaultDeliveryCostCents: null,
      logisticsPayeeUserId: andre,
    });
    const c = await createCustomer(admin, { name, phone: null, allowSimilar: true });
    const pk = await createPickup(admin, await createOrder(admin, c), day(1));
    for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
      const cur = (await admin.get(`/api/v1/pickups/${pk.id}`)).body;
      const r = await post(admin, `/api/v1/pickups/${pk.id}/transition`, {
        toStatus,
        version: cur.version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    return pk as { id: string; code: string };
  }
  const closing = async (admin: Client, week: string) =>
    (await admin.get(F(`/weekly-closings/${week}`))).body as {
      version: number;
      pendencies: { kind: string; blocking: boolean; ref: { kind: string; id: string } | null }[];
    };

  it('permissão, confirmação, repetição, concorrência e conferência depois', async () => {
    const admin = await loginAdmin(app);
    const pk = await realizedPickup(admin, 'Cliente Viagem Grátis');
    const week = closingWeekStart(today());
    let d = await closing(admin, week);
    const pend = d.pendencies.find((p) => p.kind === 'CUSTO_NAO_INFORMADO');
    expect(pend).toMatchObject({ blocking: true, ref: { kind: 'pickup', id: pk.id } });
    // Quem só vê o financeiro não confirma.
    const viewer = await panelUserWith(app, admin, 'fin-ver', ['financeiro.ver']);
    const denied = await post(viewer, F('/trip-costs/free'), {
      pickupId: pk.id,
      reason: 'Cortesia',
    });
    expect(denied.status).toBe(403);
    // Motivo é obrigatório.
    expect((await post(admin, F('/trip-costs/free'), { pickupId: pk.id })).status).toBe(400);
    // Duas confirmações simultâneas (dois gestores): uma vale; a outra recebe conflito claro.
    const [r1, r2] = await Promise.all([
      post(admin, F('/trip-costs/free'), { pickupId: pk.id, reason: 'Cortesia combinada' }),
      post(admin, F('/trip-costs/free'), { pickupId: pk.id, reason: 'Cortesia combinada' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await db().logisticsFreeTrip.count({ where: { pickupId: pk.id } })).toBe(1);
    // Repetição depois (tela desatualizada): mensagem clara, nada duplicado.
    const again = await post(admin, F('/trip-costs/free'), {
      pickupId: pk.id,
      reason: 'De novo',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('Esta viagem já foi confirmada como sem custo.');
    // Mesma chave (duplo clique / resposta perdida): devolve a mesma resposta, sem duplicar.
    const key = idemKey();
    const pk2 = await realizedPickup(admin, 'Cliente Viagem Grátis 2');
    const k1 = await post(
      admin,
      F('/trip-costs/free'),
      { pickupId: pk2.id, reason: 'Brinde' },
      key,
    );
    const k2 = await post(
      admin,
      F('/trip-costs/free'),
      { pickupId: pk2.id, reason: 'Brinde' },
      key,
    );
    expect(k1.status).toBe(200);
    expect(k2.status).toBe(200);
    expect(await db().logisticsFreeTrip.count({ where: { pickupId: pk2.id } })).toBe(1);
    // Auditoria existente da rota.
    expect(await db().auditLog.count({ where: { action: 'finance.trip_free_confirmed' } })).toBe(2);
    // Pendência sumiu: a semana pode ser conferida depois; nenhuma obrigação foi criada.
    d = await closing(admin, week);
    expect(d.pendencies.filter((p) => p.kind === 'CUSTO_NAO_INFORMADO')).toEqual([]);
    expect(await db().accountPayable.count()).toBe(0);
    const conf = await post(admin, F(`/weekly-closings/${week}/confirm`), { version: d.version });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  });
});
