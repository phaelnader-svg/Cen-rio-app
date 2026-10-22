/**
 * Remediação pós-auditoria, Rodada 4 — PROVA (não funcionalidade).
 * IDs: F5-04, F5-10, F8-10, F8-20, F8-27b, F8-27c.
 *
 * F5-04 / F5-10: peças geradas pelos MODELOS SIMPLIFICADOS (reforma de sofá e cabeceira)
 * percorrem as tarefas reais no tablet até a inspeção de qualidade e a embalagem, com a etapa
 * gravada da peça conferida em cada transição. Os modelos entram pelos mesmos comandos da
 * migration `20261230000000_modelos_simplificados` + seed (como em modelos-simplificados.test.ts).
 * F8-10: códigos reais da peça (OS-xxxxx/n) e da retirada/entrega (RT-/EN-) em "Meus Ganhos".
 * F8-20 / F8-27b / F8-27c: negociação de valores — justificativa obrigatória, nunca abaixo do
 * pago e sem transferência de titularidade. Dados fictícios; valores em centavos.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SIMPLIFIED_PRODUCTION_TEMPLATES,
  deliveryCode,
  formatNumber,
  formatServiceOrderItemCode,
  logisticsCostCode,
  productionPayableCode,
} from '@cenario/shared';
import { runSeed } from '@cenario/db/seed';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, loginAdmin, resetDatabase, setupTablet } from './helpers';
import { createCustomer, createOrder, createPickup, receiptBody } from './commercial-helpers';
import {
  createMeasurement,
  fillAndSubmit,
  gestorUserId,
  grant,
  nextFriday,
} from './measurement-helpers';
import { confirmedFabricPurchase, createSupplier, linen, ok, receive } from './purchasing-helpers';
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
  F,
  PINS,
  finish,
  labor,
  pay,
  post,
  prepareCompany,
  put,
  row,
  scenario,
  setClock,
} from './labor-helpers';

const DB = resolve(__dirname, '../../../packages/db');
const MIGRATION = '20261230000000_modelos_simplificados';
const migrationInserts = readFileSync(
  resolve(DB, `prisma/migrations/${MIGRATION}/migration.sql`),
  'utf8',
)
  .replace(/--.*$/gm, '')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.startsWith('INSERT'));
const [REFORMA, CABECEIRA] = SIMPLIFIED_PRODUCTION_TEMPLATES.map((t) => t.id) as [string, string];

let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});
afterEach(() => setAttendanceClock());

/** Instala os modelos simplificados como na publicação (migration → seed). */
async function installSimplified() {
  expect(migrationInserts).toHaveLength(2);
  for (const st of migrationInserts) await db().$executeRawUnsafe(st);
  await runSeed({ withTeam: true, log: () => undefined });
}

// ─────────────────────────── Produção → qualidade → embalagem ───────────────────────────

/** OS aberta (peça recebida) com UMA peça, mais materiais medidos, comprados e recebidos. */
async function pieceWithMaterials(
  admin: Client,
  name: string,
  piece: { pieceType: string; serviceType: string },
) {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(admin, customer, [
    { pieceType: piece.pieceType, description: name, quantity: 1 },
  ]);
  const rec = await post(
    admin,
    '/api/v1/receipts',
    receiptBody(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]),
  );
  expect(rec.status, JSON.stringify(rec.body)).toBe(201);
  const so = await post(admin, '/api/v1/service-orders', {
    orderId: order.id,
    items: [
      {
        orderItemId: order.items[0].id,
        quantity: 1,
        description: name,
        serviceType: piece.serviceType,
      },
    ],
  });
  expect(so.status, JSON.stringify(so.body)).toBe(201);
  const item = so.body.items[0] as { id: string };
  // Materiais pelo fluxo real: medição aprovada → compra confirmada → recebimento conferido.
  const m = (
    await createMeasurement(admin, {
      serviceOrderId: so.body.id,
      kind: 'ROTINA',
      assigneeUserId: await gestorUserId(),
      dueDate: nextFriday(),
    })
  ).body;
  const sub = await fillAndSubmit(admin, m, { items: [linen(item.id)] });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const appr = await post(admin, `/api/v1/measurements/${m.id}/request/approve`, {
    version: sub.body.request.version,
  });
  expect(appr.status, JSON.stringify(appr.body)).toBe(200);
  const req = await db().materialRequirement.findFirstOrThrow({
    where: { serviceOrderId: so.body.id, origin: 'SOLICITACAO_APROVADA' },
  });
  const supplier = await createSupplier(admin, `Fornecedor ${name}`);
  const po = await confirmedFabricPurchase(admin, supplier.id, req);
  expect((await receive(admin, po.id, [ok(po.items[0].id, 12)])).status).toBe(201);
  return { soId: so.body.id as string, itemId: item.id };
}

const tasksOf = (itemId: string) =>
  db().productionTask.findMany({
    where: { serviceOrderItemId: itemId, status: { not: 'CANCELADA' }, inspectionId: null },
    orderBy: { templateStepPosition: 'asc' },
  });
const stage = async (itemId: string) =>
  (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: itemId } })).fulfillmentStage;
const inspections = (itemId: string) =>
  db().qualityInspection.findMany({ where: { serviceOrderItemId: itemId } });
type Insp = { id: string; version: number; items: { id: string }[]; can: { decide: boolean } };
const inspection = async (c: Client, id: string) =>
  (await c.get(`/api/v1/quality/inspections/${id}`)).body as Insp;

async function setSkills(admin: Client, name: string, change: (s: string[]) => string[]) {
  const e = await db().employee.findFirstOrThrow({
    where: { displayName: name },
    include: { skills: true },
  });
  const r = await admin.put(`/api/v1/employees/${e.id}/skills`, {
    skills: change(e.skills.map((s) => s.skill)),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Inicia e conclui uma tarefa pelo tablet de quem a executa. */
async function doTask(c: Client, taskId: string) {
  const s = await act(c, taskId, 'start');
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const r = await act(c, taskId, 'complete', { note: 'Etapa concluída' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Inspetor confere todo o checklist como conforme e aprova (pelo próprio dispositivo). */
async function inspectAndApprove(c: Client, inspectionId: string) {
  let i = await inspection(c, inspectionId);
  expect(i.can.decide).toBe(true);
  const st = await post(c, `/api/v1/quality/inspections/${i.id}/start`, { version: i.version });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  expect(st.body.status).toBe('EM_ANDAMENTO');
  const row = await db().qualityInspection.findUniqueOrThrow({ where: { id: inspectionId } });
  expect(await stage(row.serviceOrderItemId)).toBe('EM_INSPECAO');
  for (const it of i.items) {
    const r = await c.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
      result: 'OK',
      note: null,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  i = await inspection(c, inspectionId);
  const r = await post(c, `/api/v1/quality/inspections/${i.id}/approve`, { version: i.version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { status: string };
}

/** Embalagem pela tela de embalagem: inicia a tarefa e conclui com proteção e local. */
async function packOnTablet(c: Client, itemId: string) {
  const p = await db().packagingRecord.findFirstOrThrow({
    where: { serviceOrderItemId: itemId },
    orderBy: { createdAt: 'desc' },
  });
  expect(p.status).toBe('PENDENTE');
  const st = await act(c, p.taskId!, 'start');
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  expect((await db().packagingRecord.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
    'EM_ANDAMENTO',
  );
  expect(await stage(itemId)).toBe('EM_EMBALAGEM');
  const loc = await db().itemLocation.findUniqueOrThrow({ where: { key: 'EXPEDICAO' } });
  const cur = await db().packagingRecord.findUniqueOrThrow({ where: { id: p.id } });
  const r = await post(c, `/api/v1/packaging/${p.id}/complete`, {
    protection: 'PLASTICO_BOLHA',
    locationId: loc.id,
    version: cur.version,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toMatchObject({ status: 'CONCLUIDA', location: { label: 'Expedição' } });
  return p;
}

/** Tablets da equipe de produção; todos chegam às 08:30 (relógio operacional fixo, 09:00). */
async function crew(admin: Client) {
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  setClock('08:30');
  for (const name of Object.keys(tablets)) {
    const r = await post(tablets[name]!, '/api/v1/attendance/me/arrive');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  setClock('09:00');
  return tablets;
}

async function team() {
  return {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
    andre: await userIdOf('André'),
    gestor: await gestorUserId(),
  };
}

/** Peça planejada (fila semanal) com o titular informado e plano publicado. */
async function planned(admin: Client, piece: { soId: string; itemId: string }, owner: string) {
  const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
  const r = await addOs(admin, plan.id, {
    serviceOrderId: piece.soId,
    pieces: [{ serviceOrderItemId: piece.itemId, upholstererUserId: owner }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  return plan;
}

/**
 * Reforma de sofá do modelo simplificado, do tablet até a embalagem (F5-04). Devolve a peça já
 * embalada (pronta para entrega). Etapas conferidas a cada transição.
 */
async function reformaToPacked(admin: Client, tablets: Record<string, Client>, name: string) {
  const p = await team();
  const piece = await pieceWithMaterials(admin, name, {
    pieceType: 'SOFA',
    serviceType: 'REFORMA_COMPLETA',
  });
  await planned(admin, piece, p.ricardo);
  const t = await tasksOf(piece.itemId);
  expect(t.map((x) => [x.activity, x.assigneeUserId, x.templateId])).toEqual([
    ['DESMONTAGEM', p.joao, REFORMA],
    ['CORTE_TECIDO', p.ricardo, REFORMA],
    ['MONTAGEM', p.ricardo, REFORMA],
  ]);
  const [desm, corte, mont] = t as [(typeof t)[0], (typeof t)[0], (typeof t)[0]];
  expect(await stage(piece.itemId)).toBe('EM_PRODUCAO');
  // Montagem depende da preparação e do corte: não começa antes.
  expect((await act(tablets.Ricardo!, mont.id, 'start')).status).not.toBe(200);
  // 1) Preparação (João).
  await doTask(tablets.João!, desm.id);
  expect(await stage(piece.itemId)).toBe('EM_PRODUCAO');
  expect(await inspections(piece.itemId)).toHaveLength(0);
  // 2) Corte e costura (titular).
  await doTask(tablets.Ricardo!, corte.id);
  expect(await stage(piece.itemId)).toBe('EM_PRODUCAO');
  expect(await inspections(piece.itemId)).toHaveLength(0);
  // 3) Montagem e acabamento (titular) → a inspeção nasce, com o Thiago (não executou).
  await doTask(tablets.Ricardo!, mont.id);
  const [insp] = await inspections(piece.itemId);
  expect(insp).toMatchObject({
    status: 'PENDENTE',
    round: 1,
    reason: 'PRODUCAO_CONCLUIDA',
    inspectorUserId: p.thiago,
    substituteReason: null,
  });
  expect(await stage(piece.itemId)).toBe('AGUARDANDO_INSPECAO');
  // Antes da aprovação não há embalagem.
  expect(await db().packagingRecord.count({ where: { serviceOrderItemId: piece.itemId } })).toBe(0);
  // 4) Inspeção no tablet do Thiago.
  const approved = await inspectAndApprove(tablets.Thiago!, insp!.id);
  expect(approved.status).toBe('APROVADA');
  expect(await db().qualityInspection.findUniqueOrThrow({ where: { id: insp!.id } })).toMatchObject(
    { status: 'APROVADA', decidedById: p.thiago },
  );
  expect(await stage(piece.itemId)).toBe('AGUARDANDO_EMBALAGEM');
  const pack = await db().packagingRecord.findFirstOrThrow({
    where: { serviceOrderItemId: piece.itemId },
  });
  expect(pack.assigneeUserId).toBe(p.joao);
  // 5) Embalagem (João).
  await packOnTablet(tablets.João!, piece.itemId);
  return { ...piece, inspectionId: insp!.id, packagingId: pack.id };
}

describe('F5-04 — reforma (modelo simplificado) até qualidade e embalagem', () => {
  beforeEach(installSimplified);

  it('F5-04: sofá em reforma completa: João prepara, titular corta/costura e monta; Thiago inspeciona e aprova; João embala — etapa da peça em cada transição', async () => {
    const admin = await loginAdmin(app);
    const tablets = await crew(admin);
    const piece = await reformaToPacked(admin, tablets, 'Cliente Reforma F5-04');
    expect(await stage(piece.itemId)).toBe('PRONTA_ENTREGA');
    const item = await db().serviceOrderItem.findUniqueOrThrow({
      where: { id: piece.itemId },
      include: { currentLocation: true },
    });
    expect(item.currentLocation?.key).toBe('EXPEDICAO');
    expect(
      await db().packagingRecord.findUniqueOrThrow({ where: { id: piece.packagingId } }),
    ).toMatchObject({ status: 'CONCLUIDA', protection: 'PLASTICO_BOLHA' });
    // Todas as tarefas do modelo e a tarefa de embalagem concluídas; nenhuma tarefa extra.
    const all = await db().productionTask.findMany({
      where: { serviceOrderItemId: piece.itemId, status: { not: 'CANCELADA' } },
    });
    expect(all.map((x) => x.activity).sort()).toEqual(
      ['CORTE_TECIDO', 'DESMONTAGEM', 'EMBALAGEM', 'MONTAGEM'].sort(),
    );
    expect(all.every((x) => x.status === 'CONCLUIDA')).toBe(true);
  });
});

describe('F5-10 — cabeceira (modelo simplificado): inspeção por habilitado e embalagem', () => {
  beforeEach(installSimplified);

  it('F5-10: Thiago titular executa as duas etapas; a inspeção cai em substituto (nunca o executor); substituto habilitado aprova; embalagem concluída', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    // D7: Thiago só é titular de tapeçaria com a competência de corte e costura.
    await setSkills(admin, 'Thiago', (s) => [...s, 'CORTE_COSTURA']);
    const tablets = await crew(admin);
    const piece = await pieceWithMaterials(admin, 'Cliente Cabeceira F5-10', {
      pieceType: 'CABECEIRA',
      serviceType: 'FABRICACAO',
    });
    await planned(admin, piece, p.thiago);
    const t = await tasksOf(piece.itemId);
    expect(t.map((x) => [x.activity, x.assigneeUserId, x.templateId])).toEqual([
      ['PREPARACAO_MDF', p.thiago, CABECEIRA],
      ['REVESTIMENTO', p.thiago, CABECEIRA],
    ]);
    await doTask(tablets.Thiago!, t[0]!.id);
    expect(await stage(piece.itemId)).toBe('EM_PRODUCAO');
    expect(await inspections(piece.itemId)).toHaveLength(0);
    await doTask(tablets.Thiago!, t[1]!.id);
    // Regra real (quality/common.ts chooseInspector): o inspetor principal executou → sem
    // inspetor; a inspeção aguarda o gestor designar substituto.
    const [row0] = await inspections(piece.itemId);
    expect(row0).toMatchObject({ status: 'PENDENTE', inspectorUserId: null });
    expect(row0!.substituteReason).toMatch(/executou/i);
    expect(await stage(piece.itemId)).toBe('AGUARDANDO_INSPECAO');
    // Thiago (executor) nem decide pelo tablet, nem pode ser designado.
    const self = await post(tablets.Thiago!, `/api/v1/quality/inspections/${row0!.id}/approve`, {
      version: row0!.version,
    });
    expect([403, 404, 422]).toContain(self.status);
    const asThiago = await post(admin, `/api/v1/quality/inspections/${row0!.id}/assign`, {
      inspectorUserId: p.thiago,
      reason: 'Único inspetor',
      version: row0!.version,
    });
    expect(asThiago.status).toBe(422);
    expect(asThiago.body.error.message).toMatch(/própria peça/);
    // João sem a permissão de inspecionar: recusado (habilitação exigida).
    const notQualified = await post(admin, `/api/v1/quality/inspections/${row0!.id}/assign`, {
      inspectorUserId: p.joao,
      reason: 'Thiago executou',
      version: row0!.version,
    });
    expect(notQualified.status).toBe(422);
    expect(
      await db().qualityInspection.findUniqueOrThrow({ where: { id: row0!.id } }),
    ).toMatchObject({ inspectorUserId: null, status: 'PENDENTE', version: row0!.version });
    // Habilitado pelo gestor: João vira o substituto.
    await grant(admin, 'João', ['qualidade.inspecionar']);
    const assigned = await post(admin, `/api/v1/quality/inspections/${row0!.id}/assign`, {
      inspectorUserId: p.joao,
      reason: 'Thiago executou a cabeceira',
      version: row0!.version,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    // Nova sessão do João para carregar a permissão nova.
    const joao = (
      await setupTablet(app, admin, { name: 'Tablet João 2', employee: 'João', pin: '343434' })
    ).tablet;
    await inspectAndApprove(joao, row0!.id);
    expect(
      await db().qualityInspection.findUniqueOrThrow({ where: { id: row0!.id } }),
    ).toMatchObject({ status: 'APROVADA', decidedById: p.joao, inspectorUserId: p.joao });
    expect(await stage(piece.itemId)).toBe('AGUARDANDO_EMBALAGEM');
    const pack = await db().packagingRecord.findFirstOrThrow({
      where: { serviceOrderItemId: piece.itemId },
    });
    expect(pack.assigneeUserId).toBe(p.joao);
    await packOnTablet(joao, piece.itemId);
    expect(await stage(piece.itemId)).toBe('PRONTA_ENTREGA');
  });

  it('F5-10: titular Ricardo — Thiago prepara (executor) e por isso também não inspeciona; o gestor (não executor) aprova; embalagem concluída', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const tablets = await crew(admin);
    const piece = await pieceWithMaterials(admin, 'Cliente Cabeceira Ricardo', {
      pieceType: 'CABECEIRA',
      serviceType: 'FABRICACAO',
    });
    await planned(admin, piece, p.ricardo);
    const t = await tasksOf(piece.itemId);
    expect(t.map((x) => [x.activity, x.assigneeUserId])).toEqual([
      ['PREPARACAO_MDF', p.thiago],
      ['REVESTIMENTO', p.ricardo],
    ]);
    // Revestimento depende da preparação.
    expect((await act(tablets.Ricardo!, t[1]!.id, 'start')).status).not.toBe(200);
    await doTask(tablets.Thiago!, t[0]!.id);
    expect(await inspections(piece.itemId)).toHaveLength(0);
    await doTask(tablets.Ricardo!, t[1]!.id);
    const [row0] = await inspections(piece.itemId);
    // Thiago executou a preparação (tarefa obrigatória da peça) → substituto obrigatório.
    expect(row0).toMatchObject({ status: 'PENDENTE', inspectorUserId: null });
    expect(row0!.substituteReason).toMatch(/executou/i);
    expect(await stage(piece.itemId)).toBe('AGUARDANDO_INSPECAO');
    await inspectAndApprove(admin, row0!.id);
    expect(
      (await db().qualityInspection.findUniqueOrThrow({ where: { id: row0!.id } })).decidedById,
    ).toBe(p.gestor);
    expect(await stage(piece.itemId)).toBe('AGUARDANDO_EMBALAGEM');
    await packOnTablet(tablets.João!, piece.itemId);
    expect(await stage(piece.itemId)).toBe('PRONTA_ENTREGA');
  });
});

// ─────────────────────────── Meus Ganhos: códigos reais (F8-10) ───────────────────────────

const unlockAndRead = async (c: Client, pin: string) => {
  const u = await post(c, F('/my-earnings/unlock'), { pin });
  expect(u.status, JSON.stringify(u.body)).toBe(200);
  const r = await c.req('GET', F('/my-earnings'), undefined, {
    'x-earnings-unlock': u.body.unlockToken,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { body: r.body, token: u.body.unlockToken as string };
};
type EarnItem = {
  id: string;
  code: string;
  category: string;
  description: string;
  serviceOrders: string[];
  piece: string | null;
};

async function setPayee(admin: Client, userId: string) {
  const r = await put(admin, F('/logistics-defaults'), {
    defaultPickupCostCents: 8000,
    defaultDeliveryCostCents: 12000,
    logisticsPayeeUserId: userId,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Retirada com custo, realizada pela logística (constitui o devido ao recebedor). */
async function realizedPickup(admin: Client, amountCents: number) {
  const customer = await createCustomer(admin, {
    name: 'Cliente Retirada F8-10',
    phone: null,
    allowSimilar: true,
  });
  const order = await createOrder(admin, customer);
  const pickup = await createPickup(admin, order, day(2));
  const tc = await put(admin, F('/trip-costs'), {
    pickupId: pickup.id,
    amountCents,
    participantUserIds: [await userIdOf('André')],
  });
  expect(tc.status, JSON.stringify(tc.body)).toBe(200);
  for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
    const cur = (await admin.get(`/api/v1/pickups/${pickup.id}`)).body;
    const r = await post(admin, `/api/v1/pickups/${pickup.id}/transition`, {
      toStatus,
      version: cur.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } });
}

describe('F8-10 — Meus Ganhos: detalhamento por peça, retirada e entrega', () => {
  beforeEach(installSimplified);

  it('F8-10: tapeceiro vê o código real da peça (OS-xxxxx/n) e da OS; logística vê "Retirada RT-…" e "Entrega EN-…" com o código LG-… da obrigação', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    await setPayee(admin, p.andre);
    const tablets = await crew(admin);
    // Peça real do modelo simplificado com mão de obra do titular.
    const customer = 'Cliente Ganhos F8-10';
    const piece = await pieceWithMaterials(admin, customer, {
      pieceType: 'SOFA',
      serviceType: 'REFORMA_COMPLETA',
    });
    // O fluxo de produção é o do F5-04, mas sobre esta OS (já com materiais).
    await planned(admin, piece, p.ricardo);
    const mo = await labor(admin, {
      professionalUserId: p.ricardo,
      serviceOrderId: piece.soId,
      serviceOrderItemId: piece.itemId,
      agreedCents: 90000,
      eligibility: 'QUALIDADE_APROVADA',
    });
    const t = await tasksOf(piece.itemId);
    await doTask(tablets.João!, t[0]!.id);
    await doTask(tablets.Ricardo!, t[1]!.id);
    await doTask(tablets.Ricardo!, t[2]!.id);
    const [insp] = await inspections(piece.itemId);
    await inspectAndApprove(tablets.Thiago!, insp!.id);
    await packOnTablet(tablets.João!, piece.itemId);
    expect(await stage(piece.itemId)).toBe('PRONTA_ENTREGA');
    // Entrega com custo, concluída pelo André no celular.
    const so = await db().serviceOrder.findUniqueOrThrow({ where: { id: piece.soId } });
    const d = await post(admin, '/api/v1/deliveries', {
      customerId: so.customerId,
      scheduledDate: day(1),
      windowStart: '10:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: p.andre,
      itemIds: [piece.itemId],
      tripCost: { amountCents: 11000, participantUserIds: [p.andre] },
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const andre = await tabletOf(app, admin, 'André', PINS.André!);
    const dep = await post(andre, `/api/v1/deliveries/${d.body.id}/depart`, {
      version: d.body.version,
    });
    expect(dep.status, JSON.stringify(dep.body)).toBe(200);
    const arr = await post(andre, `/api/v1/deliveries/${d.body.id}/arrive`, {
      version: dep.body.version,
    });
    const its = await post(andre, `/api/v1/deliveries/${d.body.id}/items`, {
      items: [{ serviceOrderItemId: piece.itemId, status: 'ENTREGUE' }],
      version: arr.body.version,
    });
    const done = await post(andre, `/api/v1/deliveries/${d.body.id}/complete`, {
      version: its.body.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await stage(piece.itemId)).toBe('ENTREGUE');
    const pickup = await realizedPickup(admin, 7000);

    // ── Tapeceiro: código da obrigação, da OS e da PEÇA (formato real). ──
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: piece.itemId } });
    const payable = await row(mo.id);
    const ric = (await unlockAndRead(tablets.Ricardo!, PINS.Ricardo!)).body;
    const mine = (ric.items as EarnItem[]).find((i) => i.id === mo.id)!;
    expect(mine).toMatchObject({
      code: productionPayableCode(payable.number),
      category: 'TAPECARIA',
      serviceOrders: [formatNumber('OS', so.number)],
      piece: formatServiceOrderItemCode(so.number, item.position),
    });
    expect(mine.code).toMatch(/^MO-\d{5}$/);
    expect(mine.piece).toMatch(/^OS-\d{5}\/1$/);
    expect(mine.piece).toBe(`${mine.serviceOrders[0]}/${item.position}`);

    // ── Logística: retirada e entrega identificadas pelo código real. ──
    const costs = await db().logisticsCost.findMany({
      where: { payeeUserId: p.andre },
      orderBy: { number: 'asc' },
    });
    expect(costs.map((c) => [c.kind, c.status])).toEqual([
      ['ENTREGA', 'DEVIDO'],
      ['RETIRADA', 'DEVIDO'],
    ]);
    const [deliveryCost, pickupCost] = costs as [(typeof costs)[0], (typeof costs)[0]];
    const delivery = await db().delivery.findUniqueOrThrow({ where: { id: d.body.id } });
    const lg = (await unlockAndRead(andre, PINS.André!)).body;
    const items = lg.items as EarnItem[];
    expect(items.map((i) => i.id).sort()).toEqual([deliveryCost.id, pickupCost.id].sort());
    const dv = items.find((i) => i.id === deliveryCost.id)!;
    const pk = items.find((i) => i.id === pickupCost.id)!;
    expect(dv).toMatchObject({
      code: logisticsCostCode(deliveryCost.number),
      category: 'LOGISTICA',
      piece: null,
    });
    expect(dv.code).toMatch(/^LG-\d{5}$/);
    expect(dv.description.startsWith(`Entrega ${deliveryCode(delivery.number)} — `)).toBe(true);
    expect(dv.description).toMatch(/^Entrega EN-\d{5} — /);
    expect(dv.serviceOrders).toEqual([formatNumber('OS', so.number)]);
    expect(pk).toMatchObject({ code: logisticsCostCode(pickupCost.number), piece: null });
    expect(pk.description.startsWith(`Retirada ${formatNumber('RT', pickup.number)} — `)).toBe(
      true,
    );
    expect(pk.description).toMatch(/^Retirada RT-\d{5} — /);
    // Privacidade cruzada: nenhum código do outro aparece.
    expect(JSON.stringify(lg)).not.toContain(mine.code);
    expect(JSON.stringify(ric)).not.toMatch(/RT-\d{5}|EN-\d{5}|LG-\d{5}/);
  });
});

// ─────────────────────────── Negociação (F8-20, F8-27b, F8-27c) ───────────────────────────

const ask = (c: Client, token: string, body: Record<string, unknown>) =>
  c.req('POST', F('/my-earnings/requests'), body, {
    'x-earnings-unlock': token,
    'idempotency-key': crypto.randomUUID(),
  });
const decide = async (
  admin: Client,
  id: string,
  action: 'approve' | 'reject',
  extra: Record<string, unknown> = {},
) => {
  const r = await db().valueChangeRequest.findUniqueOrThrow({ where: { id } });
  return post(admin, F(`/value-requests/${id}/${action}`), { version: r.version, ...extra });
};

/** Ricardo: sofá R$ 1.000 liberado; Márcio: poltronas R$ 450 previstas (não liberadas). */
async function negotiationBase() {
  const s = await scenario(app);
  const ric = await labor(s.admin, {
    professionalUserId: s.ids.ricardo,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.sofa.id,
    agreedCents: 100000,
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  const mar = await labor(s.admin, {
    professionalUserId: s.ids.marcio,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.poltronas.id,
    agreedCents: 45000,
    service: 'Troca de tecido das poltronas',
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  await finish(s.tablets.Ricardo!, s.sofaTask.id);
  return { s, ric, mar };
}
const nothingRecorded = async () => {
  expect(await db().valueChangeRequest.count()).toBe(0);
  expect(await db().financialEvent.count({ where: { kind: 'PEDIDO_ALTERACAO' } })).toBe(0);
  expect(await db().notification.count({ where: { kind: 'VALOR_SOLICITADO' } })).toBe(0);
  expect(await db().auditLog.count({ where: { action: 'finance.value_request_created' } })).toBe(0);
};

describe('F8-20 — negociação: justificativa obrigatória', () => {
  it('F8-20: pedido no tablet sem motivo, vazio, só espaços, curto (< 5 após aparar) ou longo demais → 400 e nada gravado', async () => {
    const { s, ric } = await negotiationBase();
    const { token } = await unlockAndRead(s.tablets.Ricardo!, PINS.Ricardo!);
    const base = { targetKind: 'PRODUCAO', targetId: ric.id, requestedCents: 120000 };
    for (const reason of [
      undefined,
      null,
      '',
      '     ',
      'abcd',
      '  ab  ',
      '\n\t  x \n',
      'x'.repeat(501),
    ]) {
      const body = reason === undefined ? base : { ...base, reason };
      const r = await ask(s.tablets.Ricardo!, token, body);
      expect(r.status, `reason=${JSON.stringify(reason)}`).toBe(400);
    }
    await nothingRecorded();
    expect(await row(ric.id)).toMatchObject({ agreedCents: 100000, adjustmentsCents: 0 });
    // Fronteira: 5 caracteres depois de aparar é aceito e gravado já aparado.
    const okReq = await ask(s.tablets.Ricardo!, token, { ...base, reason: '   Botão   ' });
    expect(okReq.status, JSON.stringify(okReq.body)).toBe(201);
    const saved = await db().valueChangeRequest.findUniqueOrThrow({ where: { id: okReq.body.id } });
    expect(saved.reason).toBe('Botão');
  });

  it('F8-20: recusa do gestor sem justificativa (ausente, vazia, espaços, < 3) → 400 e o pedido segue pendente; aprovação não exige nota (regra real)', async () => {
    const { s, ric, mar } = await negotiationBase();
    const { token } = await unlockAndRead(s.tablets.Ricardo!, PINS.Ricardo!);
    const r = await ask(s.tablets.Ricardo!, token, {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 130000,
      reason: 'Tecido com estampa casada',
    });
    expect(r.status).toBe(201);
    for (const extra of [{}, { note: null }, { note: '' }, { note: '    ' }, { note: 'ok' }]) {
      const res = await decide(s.admin, r.body.id, 'reject', extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const still = await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(still).toMatchObject({
      status: 'PENDENTE',
      decisionNote: null,
      decidedAt: null,
      decidedById: null,
      version: 1,
    });
    expect(await db().financialEvent.count({ where: { kind: 'RECUSADA' } })).toBe(0);
    const no = await decide(s.admin, r.body.id, 'reject', { note: 'Não' + ' combinado' });
    expect(no.status).toBe(200);
    expect(no.body).toMatchObject({ status: 'RECUSADA', decisionNote: 'Não combinado' });
    // Aprovação: a nota é opcional no código (approveSchema) — sem nota, o motivo gravado no
    // ajuste é o texto padrão "Pedido SV-… aprovado".
    const tm = (await unlockAndRead(s.tablets['Márcio']!, PINS['Márcio']!)).token;
    const m = await ask(s.tablets['Márcio']!, tm, {
      targetKind: 'PRODUCAO',
      targetId: mar.id,
      requestedCents: 50000,
      reason: 'Poltronas com mais botões',
    });
    const ap = await decide(s.admin, m.body.id, 'approve');
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
  });

  it('F8-20 (banco): reason é NOT NULL, mas NÃO há CHECK de conteúdo — o banco aceita motivo vazio e recusa sem nota de recusa (lacuna documentada, sem migration)', async () => {
    const { s, ric } = await negotiationBase();
    const cols = await db().$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'value_change_requests' AND column_name IN ('reason', 'decision_note')
      ORDER BY column_name`;
    expect(cols).toEqual([
      { column_name: 'decision_note', is_nullable: 'YES' },
      { column_name: 'reason', is_nullable: 'NO' },
    ]);
    const checks = await db().$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'value_change_requests' AND c.contype = 'c'`;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => /reason/.test(c.def))).toBe(false);
    expect(checks.some((c) => /decision_note/.test(c.def))).toBe(false);
    const insert = (reason: string | null) =>
      db().$executeRaw`
        INSERT INTO value_change_requests
          (id, target_kind, production_payable_id, beneficiary_user_id, current_cents,
           requested_cents, reason)
        VALUES (gen_random_uuid(), 'PRODUCAO', ${ric.id}::uuid, ${s.ids.ricardo}::uuid, 100000,
                120000, ${reason})`;
    // NOT NULL garante a presença.
    await expect(insert(null)).rejects.toThrow(/null value|not-null|23502/i);
    // Sem CHECK: vazio/espaços passam no banco (só a API barra). Revertido ao final.
    const ROLLBACK = new Error('rollback');
    await expect(
      db().$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO value_change_requests
            (id, target_kind, production_payable_id, beneficiary_user_id, current_cents,
             requested_cents, reason)
          VALUES (gen_random_uuid(), 'PRODUCAO', ${ric.id}::uuid, ${s.ids.ricardo}::uuid, 100000,
                  120000, '   ')`;
        const n = await tx.$executeRaw`
          UPDATE value_change_requests SET status = 'RECUSADA', decided_at = now(),
            decision_note = NULL WHERE reason = '   '`;
        expect(n).toBe(1);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(await db().valueChangeRequest.count()).toBe(0);
  });
});

describe('F8-27b — CA8-05: pedido aprovado nunca fica abaixo do já pago', () => {
  it('F8-27b: pedido abaixo do pago → aprovação recusada (422), nada aplicado, pedido pendente; pagamento e paidCents intactos; igual ao pago é aceito sem apagar pagamento', async () => {
    const { s, ric } = await negotiationBase();
    await pay(s.admin, ric.id, 40000);
    const paidBefore = await db().professionalPayment.findMany({
      where: { productionPayableId: ric.id },
      orderBy: { id: 'asc' },
    });
    expect(paidBefore.map((x) => x.amountCents)).toEqual([40000]);
    const before = await row(ric.id);
    expect(before).toMatchObject({ agreedCents: 100000, adjustmentsCents: 0, paidCents: 40000 });
    const { token } = await unlockAndRead(s.tablets.Ricardo!, PINS.Ricardo!);
    const r = await ask(s.tablets.Ricardo!, token, {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 30000,
      reason: 'Peça mais simples que o orçado',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const res = await decide(s.admin, r.body.id, 'approve', { note: 'Tentativa abaixo do pago' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/abaixo do que já foi pago/);
    expect(await row(ric.id)).toMatchObject({
      agreedCents: 100000,
      adjustmentsCents: 0,
      paidCents: 40000,
      status: before.status,
      version: before.version,
    });
    expect(await db().financialAdjustment.count({ where: { productionPayableId: ric.id } })).toBe(
      0,
    );
    const paidAfter = await db().professionalPayment.findMany({
      where: { productionPayableId: ric.id },
      orderBy: { id: 'asc' },
      include: { reversal: true },
    });
    expect(paidAfter.map((x) => [x.id, x.amountCents, x.reversal])).toEqual(
      paidBefore.map((x) => [x.id, x.amountCents, null]),
    );
    expect(
      await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r.body.id } }),
    ).toMatchObject({ status: 'PENDENTE', appliedAs: null, decidedAt: null });
    // Recusar continua possível (com motivo); depois, pedir exatamente o já pago é aceito.
    expect(
      (await decide(s.admin, r.body.id, 'reject', { note: 'Abaixo do que já foi pago' })).status,
    ).toBe(200);
    const eq = await ask(s.tablets.Ricardo!, token, {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 40000,
      reason: 'Fechar pelo que já recebi',
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    const ap = await decide(s.admin, eq.body.id, 'approve');
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.appliedAs).toBe('AJUSTE');
    expect(await row(ric.id)).toMatchObject({
      agreedCents: 100000,
      adjustmentsCents: -60000,
      paidCents: 40000,
    });
    const finalPayments = await db().professionalPayment.findMany({
      where: { productionPayableId: ric.id },
      include: { reversal: true },
    });
    expect(finalPayments.map((x) => [x.id, x.amountCents, x.reversal])).toEqual(
      paidBefore.map((x) => [x.id, x.amountCents, null]),
    );
  });
});

describe('F8-27c — CA8-05: aprovar alteração de valor não transfere titularidade', () => {
  it('F8-27c: ajuste (liberado) e valor combinado (previsto): profissional, titular da peça e a mesma linha da obrigação permanecem', async () => {
    const { s, ric, mar } = await negotiationBase();
    const snap = async () => ({
      payables: await db().productionPayable.findMany({
        orderBy: { number: 'asc' },
        select: { id: true, number: true, professionalUserId: true, serviceOrderItemId: true },
      }),
      items: await db().serviceOrderItem.findMany({
        where: { id: { in: [s.sofa.id, s.poltronas.id] } },
        orderBy: { position: 'asc' },
        select: { id: true, upholstererUserId: true, version: true },
      }),
    });
    const before = await snap();
    expect(before.items.map((i) => i.upholstererUserId)).toEqual([s.ids.ricardo, s.ids.marcio]);
    // Ricardo (liberado → AJUSTE).
    const tr = (await unlockAndRead(s.tablets.Ricardo!, PINS.Ricardo!)).token;
    const r = await ask(s.tablets.Ricardo!, tr, {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 115000,
      reason: 'Costura dupla no encosto',
    });
    const a = await decide(s.admin, r.body.id, 'approve', { note: 'Combinado' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({
      appliedAs: 'AJUSTE',
      beneficiary: { userId: s.ids.ricardo },
      target: { id: ric.id },
    });
    // Márcio (previsto, sem pagamento → VALOR_COMBINADO).
    const tm = (await unlockAndRead(s.tablets['Márcio']!, PINS['Márcio']!)).token;
    const m = await ask(s.tablets['Márcio']!, tm, {
      targetKind: 'PRODUCAO',
      targetId: mar.id,
      requestedCents: 52000,
      reason: 'Poltronas com capitonê',
    });
    const b = await decide(s.admin, m.body.id, 'approve');
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body).toMatchObject({ appliedAs: 'VALOR_COMBINADO', target: { id: mar.id } });
    const after = await snap();
    // Mesmas linhas (fonte única), mesmos profissionais e titulares; nenhuma linha nova.
    expect(after.payables).toEqual(before.payables);
    expect(after.items).toEqual(before.items);
    expect(await row(ric.id)).toMatchObject({
      professionalUserId: s.ids.ricardo,
      agreedCents: 100000,
      adjustmentsCents: 15000,
    });
    expect(await row(mar.id)).toMatchObject({
      professionalUserId: s.ids.marcio,
      agreedCents: 52000,
    });
    // Nenhuma troca de titular nem revisão financeira foi aberta.
    expect(await db().laborReview.count()).toBe(0);
    expect(await db().auditLog.count({ where: { action: { contains: 'upholsterer' } } })).toBe(0);
    // Cada profissional continua vendo só a própria linha.
    const ricView = (await unlockAndRead(s.tablets.Ricardo!, PINS.Ricardo!)).body;
    expect((ricView.items as EarnItem[]).map((i) => i.id)).toEqual([ric.id]);
    const marView = (await unlockAndRead(s.tablets['Márcio']!, PINS['Márcio']!)).body;
    expect((marView.items as EarnItem[]).map((i) => i.id)).toEqual([mar.id]);
  });

  it('F8-27c (logística): aprovar o pedido de uma viagem real não muda o recebedor nem cria outra obrigação', async () => {
    const admin = await loginAdmin(app);
    const andreId = await userIdOf('André');
    await setPayee(admin, andreId);
    const pickup = await realizedPickup(admin, 8000);
    const cost = await db().logisticsCost.findFirstOrThrow({ where: { pickupId: pickup.id } });
    expect(cost).toMatchObject({ status: 'DEVIDO', payeeUserId: andreId });
    const payablesBefore = await db().accountPayable.findMany({ select: { id: true } });
    const tab = await tabletOf(app, admin, 'André', PINS.André!);
    const { token } = await unlockAndRead(tab, PINS.André!);
    const r = await ask(tab, token, {
      targetKind: 'LOGISTICA',
      targetId: cost.id,
      requestedCents: 9500,
      reason: 'Pedágio na marginal',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ap = await decide(admin, r.body.id, 'approve');
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const after = await db().logisticsCost.findUniqueOrThrow({ where: { id: cost.id } });
    expect(after).toMatchObject({
      id: cost.id,
      payeeUserId: andreId,
      payableId: cost.payableId,
      amountCents: 8000,
      adjustmentsCents: 1500,
    });
    expect(await db().logisticsCost.count()).toBe(1);
    expect(await db().accountPayable.findMany({ select: { id: true } })).toEqual(payablesBefore);
  });
});
