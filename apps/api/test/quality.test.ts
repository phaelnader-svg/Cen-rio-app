import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { grant, openServiceOrder } from './measurement-helpers';
import { panelUserWith } from './commercial-helpers';
import {
  act,
  addOs,
  createPlan,
  day,
  publish,
  tabletOf,
  today,
  uploadPhoto,
  userIdOf,
} from './production-helpers';

/**
 * Fase 10 — qualidade, correções, embalagem, expedição, entregas e logística. Dados fictícios.
 * OS com sofá (reforma completa, Ricardo) e poltronas (troca de tecido, Márcio); Thiago é o
 * inspetor; João embala. Relógio operacional fixo; tarefas liberadas desde ontem.
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';
const setClock = (hhmm: string) => setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));

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
  setClock('08:00');
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
  André: '640218',
};
const post = (c: Client, path: string, body: Record<string, unknown> = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const notices = (userId: string, kind?: string) =>
  db().notification.findMany({ where: { userId, ...(kind ? { kind } : {}) } });
const gestorId = async (admin: Client) => (await admin.get('/api/auth/me')).body.user.id as string;

type Insp = {
  id: string;
  code: string;
  status: string;
  round: number;
  reason: string;
  version: number;
  inspector: { userId: string; displayName: string } | null;
  substituteReason: string | null;
  items: { id: string; label: string; required: boolean; result: string | null }[];
  production: { title: string; status: string }[];
  can: { decide: boolean; decideReason: string | null };
  osRevision: number | null;
  itemVersion: number;
  decidedBy: string | null;
  piece: { id: string; stage: string };
  photos: number;
};

/**
 * Cenário: OS publicada com uma tarefa por peça (sofá → Ricardo; poltronas → Márcio).
 * `thiagoOnSofa` coloca o Thiago como executor do sofá (regra de autoaprovação).
 */
async function scenario(
  opts: { arrive?: string[]; thiagoOnSofa?: boolean; absent?: string[] } = {},
) {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(admin, 'Cliente Qualidade');
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
    andre: await userIdOf('André'),
    izaias: await userIdOf('Izaías'),
    gestor: await gestorId(admin),
  };
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: ids.ricardo,
      date: day(-1),
    })
  ).body as { tasks: { id: string; serviceOrder: { id: string } }[] };
  for (const t of added.tasks.filter((x) => x.serviceOrder.id === so.id))
    await post(admin, `/api/v1/production-tasks/${t.id}/cancel`, { reason: 'Fora do teste' });
  const task = async (body: Record<string, unknown>) => {
    const r = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      date: day(-1),
      time: '08:00',
      ...body,
    });
    if (r.status !== 201) throw new Error(`task: ${JSON.stringify(r.body)}`);
    return r.body as { id: string; version: number };
  };
  const sofa = so.items[0]!;
  const poltronas = so.items[1]!;
  const sofaTask = await task({
    activity: 'REVESTIMENTO',
    title: 'Revestimento do sofá',
    serviceOrderItemId: sofa.id,
    role: 'PRINCIPAL',
    assigneeUserId: opts.thiagoOnSofa ? ids.thiago : ids.ricardo,
  });
  const poltronaTask = await task({
    activity: 'ACABAMENTO',
    title: 'Acabamento das poltronas',
    serviceOrderItemId: poltronas.id,
    role: 'PRINCIPAL',
    assigneeUserId: ids.marcio,
  });
  await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  for (const name of opts.absent ?? []) {
    const e = await db().employee.findFirstOrThrow({ where: { displayName: name } });
    const r = await admin.post('/api/v1/attendance/actions', {
      employeeId: e.id,
      date: today(),
      action: 'FOLGA',
      reason: 'Folga combinada',
    });
    if (r.status !== 200) throw new Error(`folga: ${JSON.stringify(r.body)}`);
  }
  setClock('08:30');
  for (const name of opts.arrive ?? ['Ricardo', 'Márcio', 'João', 'Thiago']) {
    if (opts.absent?.includes(name)) continue;
    const r = await post(tablets[name]!, '/api/v1/attendance/me/arrive');
    if (r.status !== 200) throw new Error(`arrive: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  return { admin, so, sofa, poltronas, ids, tablets, sofaTask, poltronaTask, plan };
}
type S = Awaited<ReturnType<typeof scenario>>;

async function finish(c: Client, taskId: string, note = 'Serviço concluído') {
  const s = await act(c, taskId, 'start');
  if (s.status !== 200) throw new Error(`start: ${JSON.stringify(s.body)}`);
  const r = await act(c, taskId, 'complete', { note });
  if (r.status !== 200) throw new Error(`complete: ${JSON.stringify(r.body)}`);
  return r.body;
}
const inspectionsOf = async (c: Client, query = '') =>
  (await c.get(`/api/v1/quality/inspections${query}`)).body as Insp[];
const inspection = async (c: Client, id: string) =>
  (await c.get(`/api/v1/quality/inspections/${id}`)).body as Insp;
const openOf = async (itemId: string) =>
  db().qualityInspection.findFirstOrThrow({
    where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
  });
const stage = async (itemId: string) =>
  (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: itemId } })).fulfillmentStage;

/** Confere todos os itens como conformes. */
async function checkAll(c: Client, i: Insp, except: Record<string, string> = {}) {
  for (const it of i.items) {
    const bad = except[it.label];
    const r = await c.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
      result: bad ? 'NAO_CONFORME' : 'OK',
      note: bad ?? null,
    });
    if (r.status !== 200) throw new Error(`check: ${JSON.stringify(r.body)}`);
  }
  return inspection(c, i.id);
}
async function approve(c: Client, i: Insp, key = idemKey()) {
  const cur = await inspection(c, i.id);
  return post(c, `/api/v1/quality/inspections/${i.id}/approve`, { version: cur.version }, key);
}

/** Sofá produzido e aprovado pelo Thiago (embalagem liberada). */
async function approvedSofa(s: S) {
  await finish(s.tablets.Ricardo!, s.sofaTask.id);
  const [i] = await inspectionsOf(s.tablets.Thiago!);
  await checkAll(s.tablets.Thiago!, i!);
  const r = await approve(s.tablets.Thiago!, i!);
  if (r.status !== 200) throw new Error(`approve: ${JSON.stringify(r.body)}`);
  return r.body as Insp;
}
type Pack = {
  id: string;
  status: string;
  version: number;
  assignee: { displayName: string } | null;
  taskId: string;
};
const packagingOf = async (itemId: string) =>
  db().packagingRecord.findFirst({
    where: { serviceOrderItemId: itemId },
    orderBy: { createdAt: 'desc' },
  });
const locationId = async (key: string) =>
  (await db().itemLocation.findUniqueOrThrow({ where: { key } })).id;

/** Sofá embalado pelo João → pronto para entrega. */
async function readySofa(s: S) {
  await approvedSofa(s);
  const p = (await packagingOf(s.sofa.id))!;
  const r = await post(s.tablets.João!, `/api/v1/packaging/${p.id}/complete`, {
    protection: 'PLASTICO_BOLHA',
    locationId: await locationId('EXPEDICAO'),
    notes: 'Pés embalados à parte',
    version: p.version,
  });
  if (r.status !== 200) throw new Error(`pack: ${JSON.stringify(r.body)}`);
  return r.body as Pack;
}

async function schedule(s: S, body: Record<string, unknown> = {}) {
  return post(s.admin, '/api/v1/deliveries', {
    customerId: (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } })).customerId,
    scheduledDate: day(1),
    windowStart: '09:00',
    windowEnd: '12:00',
    team: 'LOGISTICA_TERCEIRIZADA',
    responsibleUserId: s.ids.andre,
    itemIds: [s.sofa.id],
    instructions: 'Portaria: avisar o zelador',
    ...body,
  });
}
async function andreTablet(s: S) {
  return (
    await setupTablet(app, s.admin, { name: 'Celular André', employee: 'André', pin: PINS.André! })
  ).tablet;
}
type Job = { id: string; code: string; status: string; version: number };
// ───────────────────────────────────────────────────────────────────────────

describe('Inspeção e responsabilidade', () => {
  it('1. a inspeção nasce quando a produção obrigatória da peça termina (e só dela)', async () => {
    const s = await scenario();
    expect(await db().qualityInspection.count()).toBe(0);
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const created = await db().qualityInspection.findMany();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      serviceOrderItemId: s.sofa.id,
      status: 'PENDENTE',
      round: 1,
      reason: 'PRODUCAO_CONCLUIDA',
      inspectorUserId: s.ids.thiago,
    });
    expect(await stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    expect(await stage(s.poltronas.id)).toBe('EM_PRODUCAO');
    expect(await notices(s.ids.thiago, 'INSPECAO_ATRIBUIDA')).toHaveLength(1);
    // Concluir de novo (repetição) não cria outra inspeção.
    await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'Serviço concluído' });
    expect(await db().qualityInspection.count()).toBe(1);
  });

  it('2. Thiago inspeciona no tablet: OS, peça, checklist, histórico de produção; aprova com registro', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const list = await inspectionsOf(s.tablets.Thiago!);
    expect(list).toHaveLength(1);
    const i = list[0]!;
    expect(i.piece.id).toBe(s.sofa.id);
    expect(i.production.map((t) => t.title)).toEqual(['Revestimento do sofá']);
    expect(JSON.stringify(i)).not.toMatch(/R\$|Cents|valor/i);
    expect(i.can.decide).toBe(true);
    const started = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/start`, {
      version: i.version,
    });
    expect(started.body.status).toBe('EM_ANDAMENTO');
    const photo = await uploadPhoto(app, s.tablets.Thiago!, 'QUALITY_INSPECTION', i.id);
    expect(photo.status).toBe(201);
    await checkAll(s.tablets.Thiago!, i);
    const r = await approve(s.tablets.Thiago!, i);
    expect(r.status).toBe(200);
    const row = await db().qualityInspection.findUniqueOrThrow({ where: { id: i.id } });
    expect(row).toMatchObject({ status: 'APROVADA', decidedById: s.ids.thiago, itemVersion: 1 });
    expect(row.decidedAt).not.toBeNull();
    expect(row.decidedDeviceId).not.toBeNull();
    expect(row.osRevision).not.toBeNull();
    expect((await inspection(s.tablets.Thiago!, i.id)).photos).toBe(1);
    // Outro funcionário não vê a inspeção.
    expect((await s.tablets.Ricardo!.get('/api/v1/quality/inspections')).status).toBe(403);
  });

  it('3. Thiago ausente: a inspeção aguarda o gestor, que designa um substituto autorizado', async () => {
    const s = await scenario({ absent: ['Thiago'] });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const row = await openOf(s.sofa.id);
    expect(row.inspectorUserId).toBeNull();
    expect(row.substituteReason).toMatch(/ausente/i);
    expect(await notices(s.ids.gestor, 'INSPECAO_PENDENTE')).toHaveLength(1);
    const attention = (await s.admin.get('/api/v1/attention?type=QUALIDADE')).body;
    expect(
      attention.items.some((x: { key: string }) => x.key === `QUALIDADE:inspecao:${row.id}`),
    ).toBe(true);
    // João ainda não tem autorização para inspecionar.
    const denied = await post(s.admin, `/api/v1/quality/inspections/${row.id}/assign`, {
      inspectorUserId: s.ids.joao,
      version: row.version,
    });
    expect(denied.status).toBe(422);
    await grant(s.admin, 'João', ['qualidade.inspecionar']);
    const assigned = await post(s.admin, `/api/v1/quality/inspections/${row.id}/assign`, {
      inspectorUserId: s.ids.joao,
      reason: 'Thiago de folga',
      version: row.version,
    });
    expect(assigned.status).toBe(200);
    expect(await notices(s.ids.joao, 'INSPECAO_ATRIBUIDA')).toHaveLength(1);
    // O tablet do João precisa de nova sessão para receber a permissão nova.
    const joao = (
      await setupTablet(app, s.admin, { name: 'Tablet João 2', employee: 'João', pin: '343434' })
    ).tablet;
    const i = (await inspectionsOf(joao))[0]!;
    await checkAll(joao, i);
    expect((await approve(joao, i)).status).toBe(200);
    // O gestor também aprova diretamente (outra peça, sem substituto).
    await finish(s.tablets.Márcio!, s.poltronaTask.id);
    const p = await openOf(s.poltronas.id);
    const pi = await inspection(s.admin, p.id);
    await checkAll(s.admin, pi);
    expect((await approve(s.admin, pi)).status).toBe(200);
  });

  it('4. Thiago executou o serviço: não se autoaprova sem autorização específica do gestor', async () => {
    const s = await scenario({ thiagoOnSofa: true });
    await finish(s.tablets.Thiago!, s.sofaTask.id);
    const row = await openOf(s.sofa.id);
    expect(row.inspectorUserId).toBeNull();
    expect(row.substituteReason).toMatch(/executou/i);
    const plain = await post(s.admin, `/api/v1/quality/inspections/${row.id}/assign`, {
      inspectorUserId: s.ids.thiago,
      version: row.version,
    });
    expect(plain.status).toBe(422);
    expect(plain.body.error.message).toMatch(/autoaprova/);
    const auth = await post(s.admin, `/api/v1/quality/inspections/${row.id}/assign`, {
      inspectorUserId: s.ids.thiago,
      authorizeExecutor: true,
      reason: 'Único inspetor hoje; conferido por foto',
      version: row.version,
    });
    expect(auth.status).toBe(200);
    expect(auth.body).toMatchObject({ inspectorExecuted: true, executorAuthorized: true });
    const i = await inspection(s.tablets.Thiago!, row.id);
    expect(i.can.decide).toBe(true);
    await checkAll(s.tablets.Thiago!, i);
    expect((await approve(s.tablets.Thiago!, i)).status).toBe(200);
    const log = await db().auditLog.findFirst({ where: { action: 'quality.executor_authorized' } });
    expect(log?.summary).toMatch(/autorizado pelo gestor/);
  });

  it('5. checklist por tipo de peça e de serviço (sem itens irrelevantes); modelo configurável', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await finish(s.tablets.Márcio!, s.poltronaTask.id);
    const sofa = await inspection(s.admin, (await openOf(s.sofa.id)).id);
    expect(sofa.items.map((i) => i.label)).toEqual([
      'Estrutura',
      'Fixações',
      'Espumas',
      'Conforto',
      'Costuras',
      'Revestimento',
      'Acabamento',
      'Limpeza',
      'Conformidade com a OS',
    ]);
    // Poltronas, troca de tecido: sem estrutura nem espumas.
    const polt = await inspection(s.admin, (await openOf(s.poltronas.id)).id);
    expect(polt.items.map((i) => i.label)).toEqual([
      'Estabilidade',
      'Costuras',
      'Acabamento',
      'Limpeza',
    ]);
    const templates = (await s.admin.get('/api/v1/quality/templates')).body as {
      id: string;
      name: string;
      version: number;
      pieceTypes: string[];
    }[];
    expect(templates.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Sofás', 'Cabeceiras', 'Cadeiras e poltronas']),
    );
    const cad = templates.find((t) => t.name === 'Cadeiras e poltronas')!;
    const upd = await s.admin.put(`/api/v1/quality/templates/${cad.id}`, {
      name: cad.name,
      pieceTypes: cad.pieceTypes,
      items: [{ label: 'Acabamento' }, { label: 'Etiqueta do cliente', required: false }],
      version: cad.version,
    });
    expect(upd.status).toBe(200);
    // A inspeção já criada guarda a própria cópia do checklist.
    expect((await inspection(s.admin, polt.id)).items).toHaveLength(4);
    expect((await s.tablets.Thiago!.get('/api/v1/quality/templates')).status).toBe(403);
  });

  it('6. aprovação exige o checklist completo e conforme', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = (await inspectionsOf(s.tablets.Thiago!))[0]!;
    const early = await approve(s.tablets.Thiago!, i);
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/obrigatórios/);
    const na = await s.tablets.Thiago!.put(
      `/api/v1/quality/inspections/${i.id}/items/${i.items[0]!.id}`,
      {
        result: 'NAO_SE_APLICA',
      },
    );
    expect(na.status).toBe(422);
    const withDefect = await checkAll(s.tablets.Thiago!, i, { Costuras: 'Ponto solto no braço' });
    expect((await approve(s.tablets.Thiago!, withDefect)).status).toBe(422);
    await checkAll(s.tablets.Thiago!, i);
    const ok = await approve(s.tablets.Thiago!, i);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APROVADA', decidedBy: 'Thiago' });
    expect(await stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM');
  });
});

describe('Reprovação, correção e reinspeção', () => {
  it('7. reprovação exige motivo e defeito; cria a correção; nunca é apagada nem alterada', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = (await inspectionsOf(s.tablets.Thiago!))[0]!;
    const cur = await checkAll(s.tablets.Thiago!, i);
    const noReason = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/reject`, {
      version: cur.version,
    });
    expect(noReason.status).toBe(400);
    const noDefect = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/reject`, {
      reason: 'Acabamento ruim',
      version: cur.version,
    });
    expect(noDefect.status).toBe(422);
    const bad = await checkAll(s.tablets.Thiago!, i, { Costuras: 'Ponto solto no braço esquerdo' });
    const revisionBefore = (
      await db().productionPlan.findUniqueOrThrow({ where: { id: s.plan.id } })
    ).revision;
    const r = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/reject`, {
      reason: 'Costura do braço com ponto solto',
      version: bad.version,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REPROVADA');
    expect(r.body.corrections).toHaveLength(1);
    const correction = await db().productionTask.findFirstOrThrow({
      where: { activity: 'CORRECAO' },
    });
    expect(correction).toMatchObject({
      assigneeUserId: s.ids.ricardo,
      priority: 'ALTA',
      inspectionId: i.id,
      status: 'LIBERADA',
    });
    expect(await notices(s.ids.ricardo, 'CORRECAO_ATRIBUIDA')).toHaveLength(1);
    expect(await notices(s.ids.gestor, 'SERVICO_REPROVADO')).toHaveLength(1);
    expect(await stage(s.sofa.id)).toBe('EM_CORRECAO');
    // Embalagem bloqueada: nada de registro de embalagem.
    expect(await db().packagingRecord.count()).toBe(0);
    // Histórico imutável: a decisão não muda e nada é apagado.
    await expect(
      db().qualityInspection.update({ where: { id: i.id }, data: { status: 'APROVADA' } }),
    ).rejects.toThrow();
    await expect(db().qualityInspection.delete({ where: { id: i.id } })).rejects.toThrow();
    await expect(db().qualityEvent.deleteMany({})).rejects.toThrow();
    // Programação revisada (reavaliação do cronograma) com motivo.
    const plan = await db().productionPlan.findUniqueOrThrow({ where: { id: s.plan.id } });
    expect(plan.revision).toBeGreaterThan(revisionBefore);
  });

  it('8. o tapeceiro vê os defeitos e conclui a correção (com observação obrigatória)', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = (await inspectionsOf(s.tablets.Thiago!))[0]!;
    const bad = await checkAll(s.tablets.Thiago!, i, { Costuras: 'Ponto solto' });
    await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/reject`, {
      reason: 'Refazer a costura',
      version: bad.version,
    });
    const c = await db().productionTask.findFirstOrThrow({ where: { activity: 'CORRECAO' } });
    const detail = (await s.tablets.Ricardo!.get(`/api/v1/production-tasks/${c.id}`)).body;
    expect(detail.qualityFor).toMatchObject({
      kind: 'CORRECAO',
      note: 'Refazer a costura',
      defects: [{ label: 'Costuras', note: 'Ponto solto' }],
    });
    await act(s.tablets.Ricardo!, c.id, 'start');
    const noNote = await act(s.tablets.Ricardo!, c.id, 'complete', {});
    expect(noNote.status).toBe(422);
    await act(s.tablets.Ricardo!, c.id, 'complete', { note: 'Costura refeita' });
    expect((await db().productionTask.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(
      'CONCLUIDA',
    );
  });

  it('9. após a correção, nova inspeção obrigatória — nunca aprovação automática', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = (await inspectionsOf(s.tablets.Thiago!))[0]!;
    const bad = await checkAll(s.tablets.Thiago!, i, { Costuras: 'Ponto solto' });
    await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/reject`, {
      reason: 'Refazer a costura',
      version: bad.version,
    });
    const c = await db().productionTask.findFirstOrThrow({ where: { activity: 'CORRECAO' } });
    await finish(s.tablets.Ricardo!, c.id, 'Costura refeita');
    const rounds = await db().qualityInspection.findMany({ orderBy: { round: 'asc' } });
    expect(rounds.map((r) => [r.round, r.status, r.reason])).toEqual([
      [1, 'REPROVADA', 'PRODUCAO_CONCLUIDA'],
      [2, 'PENDENTE', 'CORRECAO_CONCLUIDA'],
    ]);
    expect(rounds[1]!.previousInspectionId).toBe(i.id);
    expect(await db().packagingRecord.count()).toBe(0);
    expect(await stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    expect(await notices(s.ids.thiago, 'NOVA_INSPECAO')).toHaveLength(1);
    expect(await notices(s.ids.gestor, 'CORRECAO_CONCLUIDA')).toHaveLength(1);
    const second = await inspection(s.tablets.Thiago!, rounds[1]!.id);
    expect(second.items.every((x) => x.result === null)).toBe(true);
    await checkAll(s.tablets.Thiago!, second);
    expect((await approve(s.tablets.Thiago!, second)).status).toBe(200);
    expect(await stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM');
  });

  it('10. alteração técnica após a aprovação invalida a aprovação e exige reverificação', async () => {
    const s = await scenario();
    await approvedSofa(s);
    const pack = (await packagingOf(s.sofa.id))!;
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    const upd = await s.admin.put(`/api/v1/service-orders/${s.so.id}/items/${s.sofa.id}`, {
      serviceType: item.serviceType,
      description: item.description,
      fabricName: 'Linho cru',
      fabricColor: 'Areia',
      reason: 'Cliente trocou a cor do tecido',
      version: item.version,
    });
    expect(upd.status).toBe(200);
    const rounds = await db().qualityInspection.findMany({ orderBy: { round: 'asc' } });
    expect(rounds.map((r) => [r.round, r.status, r.reason])).toEqual([
      [1, 'INVALIDADA', 'PRODUCAO_CONCLUIDA'],
      [2, 'PENDENTE', 'ALTERACAO_TECNICA'],
    ]);
    expect(rounds[0]!.invalidReason).toMatch(/Alteração técnica/);
    expect(rounds[1]!.itemVersion).toBe(item.version + 1);
    const p = await db().packagingRecord.findUniqueOrThrow({ where: { id: pack.id } });
    expect(p.status).toBe('INVALIDADA');
    const t = await db().productionTask.findUniqueOrThrow({ where: { id: pack.taskId! } });
    expect(t.status).toBe('CANCELADA');
    expect(await stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    expect(await notices(s.ids.gestor, 'APROVACAO_INVALIDADA')).toHaveLength(1);
    // A aprovação antiga não libera a peça alterada.
    const done = await post(s.tablets.João!, `/api/v1/packaging/${p.id}/complete`, {
      protection: 'MANTA',
      locationId: await locationId('EXPEDICAO'),
      version: p.version,
    });
    expect(done.status).toBe(422);
    const history = (await s.admin.get(`/api/v1/pieces/${s.sofa.id}`)).body.history as {
      kind: string;
    }[];
    expect(history.map((h) => h.kind)).toEqual(
      expect.arrayContaining([
        'APROVADA',
        'APROVACAO_INVALIDADA',
        'EMBALAGEM_INVALIDADA',
        'INSPECAO_CRIADA',
      ]),
    );
  });
});

describe('Embalagem e pronto para entrega', () => {
  it('11. embalagem bloqueada antes da aprovação (sem registro, sem tarefa avulsa, sem conclusão genérica)', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    expect(await db().packagingRecord.count()).toBe(0);
    const avulsa = await post(s.admin, `/api/v1/production-plans/${s.plan.id}/tasks`, {
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      activity: 'EMBALAGEM',
      assigneeUserId: s.ids.joao,
      reason: 'Tentativa',
    });
    expect(avulsa.status).toBe(400);
    const i = (await inspectionsOf(s.tablets.Thiago!))[0]!;
    await checkAll(s.tablets.Thiago!, i);
    expect((await approve(s.tablets.Thiago!, i)).status).toBe(200);
    const p = (await packagingOf(s.sofa.id))!;
    await act(s.tablets.João!, p.taskId!, 'start');
    const generic = await act(s.tablets.João!, p.taskId!, 'complete', { note: 'Embalado' });
    expect(generic.status).toBe(422);
    expect(generic.body.error.message).toMatch(/tela de embalagem/);
  });

  it('12. embalagem vai para o João (disponível); ocupado → Thiago; tapeceiro só com autorização', async () => {
    const s = await scenario();
    await approvedSofa(s);
    const p = (await packagingOf(s.sofa.id))!;
    expect(p.assigneeUserId).toBe(s.ids.joao);
    expect(await notices(s.ids.joao, 'EMBALAGEM_LIBERADA')).toHaveLength(1);
    const joaoPack = (await s.tablets.João!.get('/api/v1/packaging')).body as Pack[];
    expect(joaoPack.map((x) => x.id)).toEqual([p.id]);
    await act(s.tablets.João!, p.taskId!, 'start');
    // João agora está ocupado: a embalagem das poltronas vai para o Thiago.
    await finish(s.tablets.Márcio!, s.poltronaTask.id);
    const pi = await inspection(s.tablets.Thiago!, (await openOf(s.poltronas.id)).id);
    await checkAll(s.tablets.Thiago!, pi);
    await approve(s.tablets.Thiago!, pi);
    const p2 = (await packagingOf(s.poltronas.id))!;
    expect(p2.assigneeUserId).toBe(s.ids.thiago);
    // Gestor redistribui ao tapeceiro: só com autorização explícita.
    const deny = await post(s.admin, `/api/v1/packaging/${p2.id}/assign`, {
      assigneeUserId: s.ids.marcio,
      version: p2.version,
    });
    expect(deny.status).toBe(422);
    const okAssign = await post(s.admin, `/api/v1/packaging/${p2.id}/assign`, {
      assigneeUserId: s.ids.marcio,
      authorizeTapeceiro: true,
      version: p2.version,
    });
    expect(okAssign.status).toBe(200);
    expect(okAssign.body).toMatchObject({
      assignee: { displayName: 'Márcio' },
      tapeceiroAuthorized: true,
    });
    // João conclui a embalagem do sofá com proteção e local.
    const done = await post(s.tablets.João!, `/api/v1/packaging/${p.id}/complete`, {
      protection: 'MANTA',
      locationId: await locationId('EXPEDICAO'),
      notes: 'Almofadas em saco separado',
      version: (await db().packagingRecord.findUniqueOrThrow({ where: { id: p.id } })).version,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'CONCLUIDA',
      protection: 'MANTA',
      location: { label: 'Expedição' },
    });
    expect((await db().productionTask.findUniqueOrThrow({ where: { id: p.taskId! } })).status).toBe(
      'CONCLUIDA',
    );
    const item = await db().serviceOrderItem.findUniqueOrThrow({
      where: { id: s.sofa.id },
      include: { currentLocation: true },
    });
    expect(item.currentLocation?.key).toBe('EXPEDICAO');
  });

  it('13. pronto para entrega exige as cinco condições; avisa o gestor uma vez; não agenda sozinho', async () => {
    const s = await scenario();
    await readySofa(s);
    expect(await stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const piece = (await s.admin.get(`/api/v1/pieces/${s.sofa.id}`)).body;
    expect(piece.readiness).toEqual({ ready: true, missing: [] });
    expect(piece.labelPayload).toBe(`CENARIO:PECA:${piece.code}`);
    expect(await notices(s.ids.gestor, 'PRONTO_ENTREGA')).toHaveLength(1);
    expect(await db().delivery.count()).toBe(0);
    const polt = (await s.admin.get(`/api/v1/pieces/${s.poltronas.id}`)).body;
    expect(polt.readiness.missing).toEqual(['TAREFAS', 'INSPECAO', 'EMBALAGEM']);
    // Leitura da etiqueta (QR/código) encontra a peça.
    const byLabel = await s.tablets.João!.get(
      `/api/v1/pieces/by-label?code=${encodeURIComponent(piece.labelPayload)}`,
    );
    expect(byLabel.body.id).toBe(s.sofa.id);
    // Movimentação de localização opcional, com histórico.
    const moved = await post(s.tablets.João!, `/api/v1/pieces/${s.sofa.id}/move`, {
      locationId: await locationId('AREA_TESTES'),
      note: 'Conferência final',
    });
    expect(moved.body.location.label).toBe('Área de testes');
    expect(await db().itemLocationEvent.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
      2,
    );
  });
});

describe('Agendamento, logística e entrega', () => {
  it('14. só o gestor agenda; definitivo só com peça liberada; provisório sem confirmação', async () => {
    const s = await scenario();
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const early = await schedule(s, { customerId });
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/pré-agendamento provisório/);
    const pre = await schedule(s, { customerId, provisional: true });
    expect(pre.status).toBe(201);
    expect(pre.body).toMatchObject({ status: 'PROVISORIA', provisional: true });
    expect(await notices(s.ids.andre, 'ENTREGA_ATRIBUIDA')).toHaveLength(0);
    const andre = await andreTablet(s);
    expect(((await andre.get('/api/v1/logistics/jobs')).body as Job[]).length).toBe(0);
    expect((await post(andre, '/api/v1/deliveries', { customerId })).status).toBe(403);
    expect((await post(s.tablets.Thiago!, '/api/v1/deliveries', { customerId })).status).toBe(403);
    const confirmEarly = await post(s.admin, `/api/v1/deliveries/${pre.body.id}/confirm`, {
      version: pre.body.version,
    });
    expect(confirmEarly.status).toBe(422);
    await readySofa(s);
    const d = (await s.admin.get(`/api/v1/deliveries/${pre.body.id}`)).body;
    const confirmed = await post(s.admin, `/api/v1/deliveries/${d.id}/confirm`, {
      version: d.version,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('AGENDADA');
    expect(await stage(s.sofa.id)).toBe('ENTREGA_AGENDADA');
    expect(await notices(s.ids.andre, 'ENTREGA_ATRIBUIDA')).toHaveLength(1);
  });

  it('15. logística terceirizada vê só as próprias entregas, sem valores comerciais', async () => {
    const s = await scenario();
    await readySofa(s);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const d = (await schedule(s, { customerId })).body;
    const andre = await andreTablet(s);
    const jobs = (await andre.get('/api/v1/logistics/jobs')).body as Job[];
    expect(jobs.map((j) => j.id)).toEqual([d.id]);
    const text = JSON.stringify(jobs);
    expect(text).toMatch(/Portaria: avisar o zelador/);
    expect(text).not.toMatch(/agreedValue|Cents|paymentTerms|R\$|margem/i);
    expect((await andre.get('/api/v1/deliveries')).status).toBe(403);
    expect((await andre.get('/api/v1/orders')).status).toBe(403);
    expect((await andre.get('/api/v1/production-plans')).status).toBe(403);
    // Izaías (outro terceirizado) não executa a entrega do André.
    const izaias = (
      await setupTablet(app, s.admin, { name: 'Celular Izaías', employee: 'Izaías', pin: '555123' })
    ).tablet;
    expect(((await izaias.get('/api/v1/logistics/jobs')).body as Job[]).length).toBe(0);
    const steal = await post(izaias, `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
    expect(steal.status).toBe(403);
    // André e Izaías não entram na equipe de produção nem na presença.
    const workers = (await s.admin.get('/api/v1/production/workers')).body as {
      displayName: string;
    }[];
    expect(workers.map((w) => w.displayName)).not.toContain('André');
    const people = (await s.admin.get('/api/v1/logistics/people')).body as {
      displayName: string;
      team: string;
    }[];
    expect(people.find((p) => p.displayName === 'André')?.team).toBe('LOGISTICA_TERCEIRIZADA');
  });

  it('16. entrega: saída, chegada, peça a peça e conclusão — nunca "entregue" só porque saiu', async () => {
    const s = await scenario();
    await readySofa(s);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const d = (await schedule(s, { customerId })).body;
    const andre = await andreTablet(s);
    const dep = await post(andre, `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
    expect(dep.status).toBe(200);
    expect(await stage(s.sofa.id)).toBe('EM_TRANSPORTE');
    const early = await post(andre, `/api/v1/deliveries/${d.id}/complete`, {
      version: dep.body.version,
    });
    expect(early.status).toBe(422);
    const arr = await post(andre, `/api/v1/deliveries/${d.id}/arrive`, {
      version: dep.body.version,
    });
    const items = await post(andre, `/api/v1/deliveries/${d.id}/items`, {
      items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
      version: arr.body.version,
    });
    expect(items.status).toBe(200);
    const photo = await uploadPhoto(app, andre, 'DELIVERY', d.id);
    expect(photo.status).toBe(201);
    const done = await post(andre, `/api/v1/deliveries/${d.id}/complete`, {
      note: 'Recebido pela cliente',
      version: items.body.version,
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('CONCLUIDA');
    expect(await stage(s.sofa.id)).toBe('ENTREGUE');
    expect(await notices(s.ids.gestor, 'ENTREGA_CONCLUIDA')).toHaveLength(1);
    const full = (await s.admin.get(`/api/v1/deliveries/${d.id}`)).body;
    expect(full.events.map((e: { kind: string }) => e.kind)).toEqual([
      'AGENDADA',
      'SAIDA',
      'CHEGADA',
      'PECA_ENTREGUE',
      'CONCLUIDA',
    ]);
    expect(full.photos).toBe(1);
  });

  it('17. instalação registrada antes da conclusão; incompleta vira ocorrência', async () => {
    const s = await scenario();
    await readySofa(s);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const d = (await schedule(s, { customerId, requiresInstallation: true })).body;
    const andre = await andreTablet(s);
    let v = (await post(andre, `/api/v1/deliveries/${d.id}/depart`, { version: d.version })).body
      .version;
    v = (await post(andre, `/api/v1/deliveries/${d.id}/arrive`, { version: v })).body.version;
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    const noInstall = await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v });
    expect(noInstall.status).toBe(422);
    const inst = await post(andre, `/api/v1/deliveries/${d.id}/install`, {
      note: 'Falta um suporte de parede',
      complete: false,
      version: v,
    });
    expect(inst.status).toBe(200);
    expect(await db().logisticsOccurrence.count({ where: { kind: 'INSTALACAO_INCOMPLETA' } })).toBe(
      1,
    );
    const inst2 = await post(andre, `/api/v1/deliveries/${d.id}/install`, {
      note: 'Instalada com suporte reserva',
      version: inst.body.version,
    });
    expect(inst2.body.installedAt).not.toBeNull();
    const done = await post(andre, `/api/v1/deliveries/${d.id}/complete`, {
      version: inst2.body.version,
    });
    expect(done.status).toBe(200);
  });

  it('18. entrega frustrada: tentativa registrada, ocorrência aberta, peça volta à expedição; gestor reagenda', async () => {
    const s = await scenario();
    await readySofa(s);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const d = (await schedule(s, { customerId })).body;
    const andre = await andreTablet(s);
    const dep = await post(andre, `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
    const arr = await post(andre, `/api/v1/deliveries/${d.id}/arrive`, {
      version: dep.body.version,
    });
    const fr = await post(andre, `/api/v1/deliveries/${d.id}/frustrate`, {
      kind: 'CLIENTE_INDISPONIVEL',
      reason: 'Ninguém em casa; vizinho sem autorização',
      version: arr.body.version,
    });
    expect(fr.status).toBe(200);
    const row = await db().delivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'FRUSTRADA', attempts: 1, completedAt: null });
    expect(await stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const item = await db().serviceOrderItem.findUniqueOrThrow({
      where: { id: s.sofa.id },
      include: { currentLocation: true },
    });
    expect(item.currentLocation?.key).toBe('EXPEDICAO');
    expect(
      await db().logisticsOccurrence.count({
        where: { deliveryId: d.id, kind: 'CLIENTE_INDISPONIVEL' },
      }),
    ).toBe(1);
    const full = (await s.admin.get(`/api/v1/deliveries/${d.id}`)).body;
    const again = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(3),
      windowStart: '14:00',
      windowEnd: '17:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      itemIds: [s.sofa.id],
      reason: 'Cliente pediu à tarde',
      version: full.version,
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'AGENDADA', attempts: 1 });
    expect(await stage(s.sofa.id)).toBe('ENTREGA_AGENDADA');
  });

  it('19. ocorrência logística: bloqueia a expedição, aparece na central, tem responsável e histórico', async () => {
    const s = await scenario();
    await readySofa(s);
    const o = await post(s.admin, '/api/v1/logistics-occurrences', {
      kind: 'PECA_DANIFICADA',
      description: 'Pé quebrado ao mover na expedição',
      serviceOrderItemId: s.sofa.id,
    });
    expect(o.status).toBe(201);
    expect(o.body).toMatchObject({ blocksShipping: true, status: 'ABERTA' });
    expect(await stage(s.sofa.id)).toBe('BLOQUEIO_EXPEDICAO');
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    expect((await schedule(s, { customerId })).status).toBe(422);
    const att = (await s.admin.get('/api/v1/attention?type=LOGISTICA')).body;
    const item = att.items.find(
      (x: { key: string }) => x.key === `LOGISTICA:ocorrencia:${o.body.id}`,
    );
    expect(item.category).toBe('CRITICO');
    const asg = await post(s.admin, `/api/v1/logistics-occurrences/${o.body.id}/assign`, {
      responsibleUserId: s.ids.thiago,
      note: 'Trocar o pé',
      version: o.body.version,
    });
    expect(asg.body.status).toBe('EM_TRATAMENTO');
    expect(await notices(s.ids.thiago, 'OCORRENCIA_LOGISTICA')).toHaveLength(1);
    const res = await post(
      s.tablets.Thiago!,
      `/api/v1/logistics-occurrences/${o.body.id}/resolve`,
      {
        resolution: 'Pé substituído e conferido',
        version: asg.body.version,
      },
    );
    expect(res.status).toBe(403); // Thiago não tem permissão de entregas
    const res2 = await post(s.admin, `/api/v1/logistics-occurrences/${o.body.id}/resolve`, {
      resolution: 'Pé substituído e conferido',
      version: asg.body.version,
    });
    expect(res2.body.status).toBe('RESOLVIDA');
    expect(res2.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'ABERTA',
      'ATRIBUIDA',
      'RESOLVIDA',
    ]);
    expect(await stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    await expect(db().logisticsOccurrence.delete({ where: { id: o.body.id } })).rejects.toThrow();
  });
});

describe('Devolução e cancelamento', () => {
  it('20. devolução de peças ao cliente: motivo, responsável, data e confirmação; recebimento preservado', async () => {
    const s = await scenario();
    const order = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const oiPolt = (
      await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.poltronas.id } })
    ).orderItemId;
    const receiptsBefore = await db().receiptLine.findMany();
    const r = await post(s.admin, '/api/v1/returns', {
      orderId: order.orderId,
      reason: 'Cliente desistiu da reforma das poltronas',
      returnDate: today(),
      lines: [{ orderItemId: oiPolt, quantity: 2, serviceOrderItemIds: [s.poltronas.id] }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'REGISTRADA', responsible: { userId: s.ids.gestor } });
    const dup = await post(s.admin, '/api/v1/returns', {
      orderId: order.orderId,
      reason: 'Duplicada',
      returnDate: today(),
      lines: [{ orderItemId: oiPolt, quantity: 2, serviceOrderItemIds: [s.poltronas.id] }],
    });
    expect(dup.status).toBe(409);
    const c = await post(s.admin, `/api/v1/returns/${r.body.id}/confirm`, {
      note: 'Retirado pelo filho da cliente',
      version: r.body.version,
    });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('CONFIRMADA');
    expect(await stage(s.poltronas.id)).toBe('DEVOLVIDA');
    expect(
      (await db().productionTask.findUniqueOrThrow({ where: { id: s.poltronaTask.id } })).status,
    ).toBe('CANCELADA');
    expect(
      (await db().commercialOrderItem.findUniqueOrThrow({ where: { id: oiPolt } }))
        .returnedQuantity,
    ).toBe(2);
    expect(await db().receiptLine.findMany()).toEqual(receiptsBefore);
    // A OS segue ativa para o sofá.
    expect((await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } })).status).toBe(
      'ABERTA',
    );
    await expect(db().pieceReturn.delete({ where: { id: r.body.id } })).rejects.toThrow();
  });

  it('21. cancelamento: OS cancelada limpa inspeções, embalagens e entregas; correção auditável do recebimento', async () => {
    const s = await scenario();
    await approvedSofa(s);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const pre = (await schedule(s, { customerId, provisional: true })).body;
    const so = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const cancel = await s.admin.post(`/api/v1/service-orders/${s.so.id}/cancel`, {
      reason: 'Cliente cancelou o serviço',
      version: so.version,
    });
    expect(cancel.status).toBe(200);
    const pack = (await packagingOf(s.sofa.id))!;
    expect(pack.status).toBe('CANCELADA');
    expect((await db().delivery.findUniqueOrThrow({ where: { id: pre.id } })).status).toBe(
      'CANCELADA',
    );
    expect(await stage(s.sofa.id)).toBe('CANCELADA');
    expect(await stage(s.poltronas.id)).toBe('CANCELADA');
    expect(
      await db().productionTask.count({
        where: { serviceOrderId: s.so.id, status: { notIn: ['CONCLUIDA', 'CANCELADA'] } },
      }),
    ).toBe(0);
    // Peças voltaram a ficar livres: a correção do recebimento é permitida, com histórico.
    const line = await db().receiptLine.findFirstOrThrow({
      where: {
        orderItemId: (
          await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.poltronas.id } })
        ).orderItemId,
      },
    });
    const corr = await post(s.admin, `/api/v1/receipt-lines/${line.id}/corrections`, {
      newQuantity: 1,
      reason: 'Contagem errada: veio só uma poltrona',
    });
    expect(corr.status).toBe(201);
    expect(corr.body).toMatchObject({ previousQuantity: 2, newQuantity: 1 });
    expect((await db().receiptLine.findUniqueOrThrow({ where: { id: line.id } })).quantity).toBe(2);
    expect(
      (await db().commercialOrderItem.findUniqueOrThrow({ where: { id: line.orderItemId } }))
        .receivedQuantity,
    ).toBe(1);
    const list = (await s.admin.get(`/api/v1/receipts/${line.receiptId}/corrections`)).body;
    expect(list).toHaveLength(1);
    await expect(db().receiptCorrection.deleteMany({})).rejects.toThrow();
  });

  it('21b. correção de recebimento recusada quando deixaria peça em OS sem cobertura', async () => {
    const s = await scenario();
    const line = await db().receiptLine.findFirstOrThrow({
      where: {
        orderItemId: (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } }))
          .orderItemId,
      },
    });
    const r = await post(s.admin, `/api/v1/receipt-lines/${line.id}/corrections`, {
      newQuantity: 0,
      reason: 'Tentativa de zerar o recebimento',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/OS ativa/);
  });
});

describe('Segurança, concorrência e sincronização', () => {
  it('22. permissões: tapeceiro, inspetor, logística e consulta não fazem o que não podem', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const row = await openOf(s.sofa.id);
    expect((await s.tablets.Ricardo!.get(`/api/v1/quality/inspections/${row.id}`)).status).toBe(
      403,
    );
    expect(
      (
        await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${row.id}/assign`, {
          inspectorUserId: s.ids.thiago,
          version: row.version,
        })
      ).status,
    ).toBe(403);
    const andre = await andreTablet(s);
    expect((await andre.get('/api/v1/quality/inspections')).status).toBe(403);
    const viewer = await panelUserWith(app, s.admin, 'consulta', ['entregas.ver']);
    expect((await viewer.get('/api/v1/deliveries')).status).toBe(200);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    expect(
      (
        await post(viewer, '/api/v1/deliveries', {
          customerId,
          scheduledDate: day(1),
          itemIds: [s.sofa.id],
          provisional: true,
        })
      ).status,
    ).toBe(403);
    expect((await post(viewer, '/api/v1/returns', {})).status).toBe(403);
    // Tablet não recebe dados comerciais nas inspeções.
    const i = (await inspectionsOf(s.tablets.Thiago!))[0]!;
    expect(JSON.stringify(i)).not.toMatch(/agreedValue|R\$/);
  });

  it('23. concorrência: duas decisões simultâneas e a mesma peça em duas entregas', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = await checkAll(s.tablets.Thiago!, (await inspectionsOf(s.tablets.Thiago!))[0]!);
    const [a, b] = await Promise.all([
      post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/approve`, {
        version: i.version,
      }),
      post(s.admin, `/api/v1/quality/inspections/${i.id}/approve`, { version: i.version }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db().packagingRecord.count()).toBe(1);
    const p = (await packagingOf(s.sofa.id))!;
    await post(s.tablets.João!, `/api/v1/packaging/${p.id}/complete`, {
      protection: 'MANTA',
      locationId: await locationId('EXPEDICAO'),
      version: p.version,
    });
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const [d1, d2] = await Promise.all([schedule(s, { customerId }), schedule(s, { customerId })]);
    expect([d1.status, d2.status].sort()).toEqual([201, 409]);
    expect(await db().deliveryItem.count({ where: { active: true } })).toBe(1);
  });

  it('24. idempotência: repetir aprovação, embalagem e saída não duplica nada', async () => {
    const s = await scenario();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = await checkAll(s.tablets.Thiago!, (await inspectionsOf(s.tablets.Thiago!))[0]!);
    const key = idemKey();
    const a = await post(
      s.tablets.Thiago!,
      `/api/v1/quality/inspections/${i.id}/approve`,
      { version: i.version },
      key,
    );
    const b = await post(
      s.tablets.Thiago!,
      `/api/v1/quality/inspections/${i.id}/approve`,
      { version: i.version },
      key,
    );
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const c = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/approve`, {
      version: i.version,
    });
    expect(c.status).toBe(200); // repetição pelo mesmo inspetor: sem efeito
    expect(await db().packagingRecord.count()).toBe(1);
    expect(await db().qualityEvent.count({ where: { kind: 'APROVADA' } })).toBe(1);
    const p = (await packagingOf(s.sofa.id))!;
    const body = {
      protection: 'MANTA',
      locationId: await locationId('EXPEDICAO'),
      version: p.version,
    };
    await post(s.tablets.João!, `/api/v1/packaging/${p.id}/complete`, body);
    const again = await post(s.tablets.João!, `/api/v1/packaging/${p.id}/complete`, body);
    expect(again.status).toBe(200);
    expect(await db().qualityEvent.count({ where: { kind: 'EMBALADA' } })).toBe(1);
    expect(await notices(s.ids.gestor, 'PRONTO_ENTREGA')).toHaveLength(1);
    const customerId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } }))
      .customerId;
    const d = (await schedule(s, { customerId })).body;
    const andre = await andreTablet(s);
    await post(andre, `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
    const dep2 = await post(andre, `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
    expect(dep2.status).toBe(200);
    expect(await db().deliveryEvent.count({ where: { deliveryId: d.id, kind: 'SAIDA' } })).toBe(1);
  });

  it('25. sincronização em tempo real e 26. reconexão recupera inspeções e avisos', async () => {
    const s = await scenario();
    const wAdmin = track(await WsClient.connect(app, s.admin));
    const wThiago = track(await WsClient.connect(app, s.tablets.Thiago!));
    const wMarcio = track(await WsClient.connect(app, s.tablets.Márcio!));
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await wThiago.waitFor(
      (m) => m.kind === 'event' && m.event.type === 'quality.inspection_created',
    );
    await wAdmin.waitFor((m) => m.kind === 'event' && m.event.type === 'item.stage_changed');
    expect(wMarcio.events('quality.inspection_created')).toHaveLength(0);
    const lastSeq = (wThiago.events().at(-1)?.seq as string | undefined) ?? '0';
    await wThiago.close();
    // Enquanto o tablet do Thiago está offline, a correção termina e nasce a 2ª rodada.
    const i = (await inspectionsOf(s.admin))[0]!;
    const bad = await checkAll(s.admin, i, { Limpeza: 'Resíduo de cola' });
    await post(s.admin, `/api/v1/quality/inspections/${i.id}/reject`, {
      reason: 'Limpar a cola',
      version: bad.version,
    });
    const c = await db().productionTask.findFirstOrThrow({ where: { activity: 'CORRECAO' } });
    await finish(s.tablets.Ricardo!, c.id, 'Limpo');
    const back = track(await WsClient.connect(app, s.tablets.Thiago!, String(lastSeq)));
    await back.waitFor((m) => m.kind === 'replay.done');
    expect(back.events('quality.inspection_created').length).toBeGreaterThanOrEqual(1);
    expect(
      back
        .events('notification.created')
        .some((e: { payload: { kind: string } }) => e.payload.kind === 'NOVA_INSPECAO'),
    ).toBe(true);
  });

  it('27. regressão: apoio e resolução de ocorrência não criam inspeção; fluxo das fases anteriores segue', async () => {
    const s = await scenario();
    await act(s.tablets.Ricardo!, s.sofaTask.id, 'start');
    const issue = await post(s.tablets.Ricardo!, '/api/v1/issues', {
      taskId: s.sofaTask.id,
      kind: 'TECNICO',
      description: 'Grampeador pneumático sem pressão',
      impact: 'IMPEDIDO',
    });
    expect(issue.status).toBe(201);
    const asg = await post(s.admin, `/api/v1/issues/${issue.body.id}/assign`, {
      assigneeUserId: s.ids.joao,
      instructions: 'Trocar a mangueira do compressor',
    });
    expect(asg.status).toBe(200);
    const action = await db().productionTask.findFirstOrThrow({
      where: { issueId: issue.body.id },
    });
    await finish(s.tablets.João!, action.id, 'Mangueira trocada');
    expect(await db().qualityInspection.count()).toBe(0);
    const v = (await s.admin.get(`/api/v1/issues/${issue.body.id}`)).body;
    await post(s.admin, `/api/v1/issues/${issue.body.id}/verify`, {
      resolved: true,
      note: 'Testado',
      version: v.version,
    });
    await act(s.tablets.Ricardo!, s.sofaTask.id, 'resume');
    await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'Concluído' });
    expect(await db().qualityInspection.count()).toBe(1);
  });
});
