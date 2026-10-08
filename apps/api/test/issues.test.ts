import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { processHelpQueue } from '../src/modules/help/queue';
import { processIssueRisks } from '../src/modules/issues/service';
import type { Client } from './helpers';
import {
  WsClient,
  createTestApp,
  db,
  employeeByName,
  idemKey,
  loginAdmin,
  resetDatabase,
} from './helpers';
import {
  act,
  addOs,
  assign,
  createPlan,
  day,
  publish,
  serviceOrderWith,
  sofaTask,
  tabletOf,
  today,
  uploadPhoto,
  userIdOf,
} from './production-helpers';
import { confirmedFabricPurchase, createSupplier, ok, receive } from './purchasing-helpers';

/**
 * Fase 9 — central de atenção, ocorrências, delegação de soluções e integração com a
 * reprogramação. Relógio operacional fixo; tarefas programadas para ontem (liberadas).
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';
const at = (hhmm: string) => zonedDateTime(today(), hhmm, TZ);
const setClock = (hhmm: string) => setAttendanceClock(() => at(hhmm));

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

type T = {
  id: string;
  code: string;
  status: string;
  version: number;
  scheduledAt: string | null;
  scheduledDate?: string | null;
  assignee: { userId: string } | null;
  issueFor?: { id: string; code: string } | null;
  lastProgress?: { percent: number | null } | null;
  materials?: { requirementId: string; description: string }[];
};
const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
};

/**
 * Sofá publicado: Márcio é o principal (corte de tecido liberado se o material estiver
 * completo) e tem um revestimento liberado; João tem desmontagem e preparação; Thiago, uma
 * cabeceira; Ricardo, um acabamento lateral. Todos confirmam chegada às 8h30.
 */
async function scenario(
  opts: { arrive?: string[]; materials?: 'complete' | 'missing'; dueToday?: boolean } = {},
) {
  const arriving = opts.arrive ?? ['Ricardo', 'Márcio', 'João', 'Thiago'];
  const admin = await loginAdmin(app);
  const { so, reqs } = await serviceOrderWith(admin, opts.materials ?? 'complete', 'Cliente OC');
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
  };
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: ids.marcio,
      date: day(-1),
    })
  ).body;
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added, so.items[0].id, a), ids.joao);
  const extra = async (body: Record<string, unknown>) => {
    const r = await admin.post(
      `/api/v1/production-plans/${plan.id}/tasks`,
      { serviceOrderId: so.id, date: day(-1), time: '08:00', ...body },
      { 'idempotency-key': idemKey() },
    );
    if (r.status !== 201) throw new Error(`extra: ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const revestimento = await extra({
    activity: 'REVESTIMENTO',
    title: 'Revestimento do braço',
    assigneeUserId: ids.marcio,
    ...(opts.dueToday ? { dueDate: today() } : {}),
  });
  const cabeceira = await extra({
    activity: 'OUTRA',
    title: 'Cabeceira estofada',
    assigneeUserId: ids.thiago,
  });
  const lateral = await extra({
    activity: 'ACABAMENTO',
    title: 'Acabamento lateral',
    assigneeUserId: ids.ricardo,
  });
  const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
  const published = await publish(admin, draft);
  const t = (a: string) => sofaTask(published, so.items[0].id, a) as unknown as T;
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  setClock('08:30');
  for (const name of arriving) {
    const r = await tablets[name]!.post(
      '/api/v1/attendance/me/arrive',
      {},
      { 'idempotency-key': idemKey() },
    );
    if (r.status !== 200) throw new Error(`arrive: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  const reload = async (id: string) =>
    (await admin.get(`/api/v1/production-tasks/${id}`)).body as T;
  return {
    admin,
    so,
    reqs,
    plan,
    ids,
    t,
    tablets,
    reload,
    revestimento: await reload(revestimento.id),
    cabeceira: await reload(cabeceira.id),
    lateral: await reload(lateral.id),
  };
}

const openIssue = (c: Client, body: Record<string, unknown>, key = idemKey()) =>
  c.post('/api/v1/issues', body, { 'idempotency-key': key });
const post = (c: Client, path: string, body: Record<string, unknown> = {}) =>
  c.post(path, body, { 'idempotency-key': idemKey() });
const notices = async (userId: string, kind?: string) =>
  db().notification.findMany({
    where: { userId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'asc' },
  });
const gestorId = async (admin: Client) => (await admin.get('/api/auth/me')).body.user.id as string;
const assignTo = (
  admin: Client,
  issueId: string,
  assigneeUserId: string,
  extra: Record<string, unknown> = {},
) =>
  post(admin, `/api/v1/issues/${issueId}/assign`, {
    assigneeUserId,
    instructions: 'Verificar a máquina de costura do Márcio',
    ...extra,
  });

/** Márcio inicia o revestimento e registra problema técnico (máquina de costura). */
async function machineIssue(s: Awaited<ReturnType<typeof scenario>>, impact = 'IMPEDIDO') {
  await act(s.tablets.Márcio!, s.revestimento.id, 'start');
  await act(s.tablets.Márcio!, s.revestimento.id, 'progress', {
    note: 'Braço esquerdo pronto',
    percent: 40,
  });
  const r = await openIssue(s.tablets.Márcio!, {
    taskId: s.revestimento.id,
    kind: 'TECNICO',
    description: 'Máquina de costura travando a linha',
    impact,
  });
  if (r.status !== 201) throw new Error(`issue: ${JSON.stringify(r.body)}`);
  return r.body as { id: string; code: string; version: number; status: string };
}

describe('Abertura pelo tablet', () => {
  it('1. falta de material: material, quantidade e unidade; sem compra automática; só resolve com material reservado', async () => {
    const s = await scenario({ materials: 'missing' });
    const corte = s.t('CORTE_TECIDO');
    expect((await s.reload(corte.id)).status).toBe('BLOQUEADA');
    const detail = (await s.tablets.Márcio!.get(`/api/v1/production-tasks/${corte.id}`)).body as T;
    const requirementId = detail.materials![0]!.requirementId;
    const purchasesBefore = await db().purchaseOrder.count();
    const r = await openIssue(s.tablets.Márcio!, {
      taskId: corte.id,
      kind: 'MATERIAL',
      impact: 'IMPEDIDO',
      material: { requirementId, quantity: 12, unit: 'METRO' },
      description: 'Linho ainda não chegou',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: 'MATERIAL',
      status: 'ABERTA',
      blocksTask: true,
      material: { requirementId, quantity: 12, unit: 'METRO' },
      reporter: { displayName: 'Márcio' },
      task: { id: corte.id },
    });
    // Dispositivo e horário registrados automaticamente.
    const row = await db().productionIssue.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.reporterDeviceId).not.toBeNull();
    expect(row.createdAt.toISOString()).toBe(at('09:00').toISOString());
    expect(await db().purchaseOrder.count()).toBe(purchasesBefore);
    expect(await notices(await gestorId(s.admin), 'OCORRENCIA_ABERTA')).toHaveLength(1);
    // Gestor registra a decisão (comprar) e pede verificação: ainda falta → não resolve.
    await post(s.admin, `/api/v1/issues/${r.body.id}/request-verification`, {
      note: 'Compra do linho com o fornecedor',
    });
    const early = await post(s.admin, `/api/v1/issues/${r.body.id}/verify`, {
      resolved: true,
      note: 'Material comprado',
    });
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/ainda não está disponível/);
    // Material recebido e reservado para a OS: agora confirma e a tarefa é liberada.
    const supplier = await createSupplier(s.admin, 'Fornecedor OC');
    const po = await confirmedFabricPurchase(s.admin, supplier.id, s.reqs[0]!);
    await receive(s.admin, po.id, [ok(po.items[0].id, 12)]);
    const done = await post(s.admin, `/api/v1/issues/${r.body.id}/verify`, {
      resolved: true,
      note: 'Linho recebido e reservado',
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('RESOLVIDA');
    expect((await s.reload(corte.id)).status).toBe('LIBERADA');
  });

  it('1b. material recebido com a ocorrência aberta: vai para verificação (não se encerra sozinha)', async () => {
    const s = await scenario({ materials: 'missing' });
    const corte = s.t('CORTE_TECIDO');
    const detail = (await s.tablets.Márcio!.get(`/api/v1/production-tasks/${corte.id}`)).body as T;
    const r = await openIssue(s.tablets.Márcio!, {
      taskId: corte.id,
      kind: 'MATERIAL',
      impact: 'OUTRA_ATIVIDADE',
      material: { requirementId: detail.materials![0]!.requirementId, quantity: 12, unit: 'METRO' },
    });
    expect(r.body.description).toMatch(/Falta de .*12 metro/);
    const supplier = await createSupplier(s.admin, 'Fornecedor OC2');
    const po = await confirmedFabricPurchase(s.admin, supplier.id, s.reqs[0]!);
    await receive(s.admin, po.id, [ok(po.items[0].id, 12)]);
    const issue = (await s.admin.get(`/api/v1/issues/${r.body.id}`)).body;
    expect(issue.status).toBe('AGUARDANDO_VERIFICACAO');
    expect(issue.events.map((e: { kind: string }) => e.kind)).toContain('MATERIAL_DISPONIVEL');
    // A tarefa continua impedida até a confirmação.
    expect((await s.reload(corte.id)).status).toBe('BLOQUEADA');
  });

  it('2. problema técnico e 4. bloqueio total: pausa preservando o andamento, sem retomar antes da solução', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    const task = await s.reload(s.revestimento.id);
    expect(task.status).toBe('PAUSADA');
    expect(task.lastProgress?.percent).toBe(40);
    expect((task as unknown as { pauseImpediment: boolean }).pauseImpediment).toBe(true);
    const resume = await act(s.tablets.Márcio!, s.revestimento.id, 'resume');
    expect(resume.status).toBe(422);
    expect(resume.body.error.message).toMatch(/ocorrência aberta/);
    // Só a etapa é afetada: outras tarefas da OS seguem.
    expect((await s.reload(s.t('DESMONTAGEM').id)).status).toBe('LIBERADA');
    const detail = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body;
    expect(detail).toMatchObject({
      kind: 'TECNICO',
      impact: 'IMPEDIDO',
      priority: 'ALTA',
      category: 'ACAO',
    });
  });

  it('3. outro impedimento: só descrição e se consegue continuar', async () => {
    const s = await scenario();
    await act(s.tablets.Márcio!, s.revestimento.id, 'start');
    const noAnswer = await openIssue(s.tablets.Márcio!, {
      taskId: s.revestimento.id,
      kind: 'OUTRO',
      description: 'Falta espaço na bancada',
    });
    expect(noAnswer.status).toBe(400);
    const r = await openIssue(s.tablets.Márcio!, {
      taskId: s.revestimento.id,
      kind: 'OUTRO',
      description: 'Falta espaço na bancada',
      canContinue: true,
    });
    expect(r.body).toMatchObject({ impact: 'DIFICULDADE', blocksTask: false });
    const ricardo = await openIssue(s.tablets.Ricardo!, {
      taskId: s.lateral.id,
      kind: 'OUTRO',
      description: 'Sem luz na bancada',
      canContinue: false,
    });
    expect(ricardo.body).toMatchObject({ impact: 'IMPEDIDO', blocksTask: true });
    expect((await s.reload(s.lateral.id)).status).toBe('BLOQUEADA');
    expect(
      ((await s.reload(s.lateral.id)) as unknown as { blockers: string[] }).blockers,
    ).toContain('OCORRENCIA');
  });

  it('5. impacto parcial: tarefa continua ativa e o risco de prazo fica registrado', async () => {
    const s = await scenario({ dueToday: true });
    const issue = await machineIssue(s, 'DIFICULDADE');
    expect((await s.reload(s.revestimento.id)).status).toBe('EM_EXECUCAO');
    const detail = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body;
    expect(detail.blocksTask).toBe(false);
    expect(detail.deadlineRisk).toBe(true);
    expect(detail.events.map((e: { kind: string }) => e.kind)).toContain('RISCO');
    // Aberta: falta delegar (ação necessária), mesmo sem bloquear a tarefa.
    expect(detail.category).toBe('ACAO');
  });

  it('6. consegue executar outra atividade: tarefa impedida e alternativa indicada (sem iniciar)', async () => {
    const s = await scenario();
    const issue = await machineIssue(s, 'OUTRA_ATIVIDADE');
    expect(issue.status).toBe('ABERTA');
    expect((await s.reload(s.revestimento.id)).status).toBe('PAUSADA');
    const alt = await notices(s.ids.marcio, 'TAREFA_ALTERNATIVA_LIBERADA');
    expect(alt).toHaveLength(1);
    const suggested = await s.reload(alt[0]!.taskId!);
    expect(suggested.status).toBe('LIBERADA'); // indicada, nunca iniciada
  });

  it('7. ocorrência com foto (arquivo privado): quem registrou envia; outros não veem', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    const photo = await uploadPhoto(app, s.tablets.Márcio!, 'PRODUCTION_ISSUE', issue.id);
    expect(photo.status).toBe(201);
    expect((await s.admin.get(`/api/v1/issues/${issue.id}`)).body.photos).toBe(1);
    const list = (c: Client) =>
      c.get(`/api/v1/attachments?entityType=PRODUCTION_ISSUE&entityId=${issue.id}`);
    expect((await list(s.tablets.Thiago!)).status).toBe(403);
    expect((await uploadPhoto(app, s.tablets.Thiago!, 'PRODUCTION_ISSUE', issue.id)).status).toBe(
      403,
    );
    await assignTo(s.admin, issue.id, s.ids.thiago);
    // Quem resolve passa a ver a evidência.
    expect((await list(s.tablets.Thiago!)).status).toBe(200);
  });
});

describe('Delegação e resolução', () => {
  it('8. delegação ao Thiago (com competência) e 21. revisão da programação', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    const before = (await s.admin.get(`/api/v1/production-plans/${s.plan.id}`)).body.revisions
      .length;
    const r = await assignTo(s.admin, issue.id, s.ids.thiago, { requiredSkill: 'REPARO' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ATRIBUIDA', assignee: { displayName: 'Thiago' } });
    const mine = (await s.tablets.Thiago!.get('/api/v1/production-tasks/mine')).body.today as T[];
    const action = mine.find((x) => x.issueFor?.id === issue.id)!;
    expect(action).toMatchObject({ status: 'LIBERADA' });
    expect((await notices(s.ids.thiago, 'OCORRENCIA_ATRIBUIDA'))[0]?.body).toMatch(
      /Verificar a máquina de costura do Márcio/,
    );
    // A tarefa original não muda de dono.
    expect((await s.reload(s.revestimento.id)).assignee?.userId).toBe(s.ids.marcio);
    // Revisão da programação: versão anterior preservada, motivo, responsável e impacto.
    const plan = (await s.admin.get(`/api/v1/production-plans/${s.plan.id}`)).body;
    expect(plan.revisions.length).toBe(before + 1);
    expect(plan.revisions[0].reason).toMatch(/Resolução de OC-00001 atribuída a Thiago.*Impacto/);
    expect(plan.revisions[0].createdBy).toBe('Gestor Teste');
  });

  it('9. delegação ao João: sem competência é recusada; ausente é recusado; conflito exige confirmação', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    const issue = await machineIssue(s);
    const noSkill = await assignTo(s.admin, issue.id, s.ids.joao, { requiredSkill: 'REPARO' });
    expect(noSkill.status).toBe(422);
    expect(noSkill.body.error.message).toMatch(/competência/);
    const ricardo = await employeeByName('Ricardo');
    await s.admin.post('/api/v1/attendance/actions', {
      date: today(),
      employeeId: ricardo.id,
      action: 'FOLGA',
      reason: 'Folga combinada',
    });
    expect((await assignTo(s.admin, issue.id, s.ids.ricardo)).status).toBe(422);
    // João ocupado: precisa de confirmação explícita, e o impacto fica registrado.
    await act(s.tablets.João!, s.t('DESMONTAGEM').id, 'start');
    const conflict = await assignTo(s.admin, issue.id, s.ids.joao, {
      instructions: 'Trazer a máquina reserva para o Márcio',
    });
    expect(conflict.status).toBe(409);
    const okAssign = await assignTo(s.admin, issue.id, s.ids.joao, {
      instructions: 'Trazer a máquina reserva para o Márcio',
      confirmConflict: true,
    });
    expect(okAssign.status).toBe(200);
    const ev = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body.events.at(-1);
    expect(ev).toMatchObject({ kind: 'ATRIBUIDA' });
    expect(
      await db().planningAction.count({
        where: { kind: 'RESOLUCAO_ATRIBUIDA', reason: { contains: 'Conflito aprovado' } },
      }),
    ).toBe(1);
  });

  it('10. tarefa de resolução: iniciar, andamento e concluir com resultado (11. sem resolver sozinho)', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    await assignTo(s.admin, issue.id, s.ids.thiago);
    let d = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body;
    const actionId = d.actionTask.id as string;
    await act(s.tablets.Thiago!, actionId, 'start');
    d = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body;
    expect(d.status).toBe('EM_RESOLUCAO');
    await act(s.tablets.Thiago!, actionId, 'progress', { note: 'Troquei a agulha', percent: 50 });
    // Concluir exige o resultado.
    expect((await act(s.tablets.Thiago!, actionId, 'complete', {})).status).toBe(422);
    const done = await act(s.tablets.Thiago!, actionId, 'complete', {
      note: 'Agulha e tensão ajustadas',
    });
    expect(done.status).toBe(200);
    d = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body;
    // Concluir a ação NÃO encerra a ocorrência.
    expect(d.status).toBe('AGUARDANDO_VERIFICACAO');
    expect(d.resultNote).toBe('Agulha e tensão ajustadas');
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['INICIADA', 'ANDAMENTO', 'SOLUCAO_CONCLUIDA']),
    );
    expect(await notices(await gestorId(s.admin), 'VERIFICACAO_NECESSARIA')).toHaveLength(1);
    expect(await notices(s.ids.marcio, 'SOLUCAO_CONCLUIDA')).toHaveLength(1);
    expect((await s.reload(s.revestimento.id)).status).toBe('PAUSADA');
  });

  it('11. conclusão sem resolução: verificação recusada volta para aberta; tarefa segue impedida', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    await assignTo(s.admin, issue.id, s.ids.thiago);
    const actionId = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body.actionTask.id;
    await act(s.tablets.Thiago!, actionId, 'start');
    await act(s.tablets.Thiago!, actionId, 'complete', { note: 'Lubrifiquei' });
    const no = await post(s.admin, `/api/v1/issues/${issue.id}/verify`, {
      resolved: false,
      note: 'Continua travando',
    });
    expect(no.body.status).toBe('ABERTA');
    expect((await act(s.tablets.Márcio!, s.revestimento.id, 'resume')).status).toBe(422);
    expect((await notices(s.ids.thiago, 'OCORRENCIA_REABERTA'))[0]?.body).toMatch(
      /Continua travando/,
    );
    // Pode ser delegada de novo.
    expect((await assignTo(s.admin, issue.id, s.ids.thiago)).body.status).toBe('ATRIBUIDA');
  });

  it('12. confirmação da solução: tarefa desbloqueada (sem retomar sozinha) e funcionário avisado', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    await assignTo(s.admin, issue.id, s.ids.thiago);
    const actionId = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body.actionTask.id;
    await act(s.tablets.Thiago!, actionId, 'start');
    await act(s.tablets.Thiago!, actionId, 'complete', { note: 'Peça trocada' });
    const yes = await post(s.admin, `/api/v1/issues/${issue.id}/verify`, {
      resolved: true,
      note: 'Testada com o Márcio',
    });
    expect(yes.body).toMatchObject({ status: 'RESOLVIDA', resolvedBy: 'Gestor Teste' });
    expect((await s.reload(s.revestimento.id)).status).toBe('PAUSADA');
    expect(await notices(s.ids.marcio, 'OCORRENCIA_RESOLVIDA')).toHaveLength(1);
    expect((await notices(s.ids.marcio, 'TAREFA_DESBLOQUEADA'))[0]?.body).toMatch(/retomar/);
    expect((await act(s.tablets.Márcio!, s.revestimento.id, 'resume')).status).toBe(200);
    expect((await s.reload(s.revestimento.id)).lastProgress?.percent).toBe(40);
  });

  it('13. reabertura auditável (com motivo): tarefa volta a ser impedida', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    await post(s.admin, `/api/v1/issues/${issue.id}/request-verification`, {
      note: 'Gestor ajustou',
    });
    await post(s.admin, `/api/v1/issues/${issue.id}/verify`, { resolved: true, note: 'Conferido' });
    await act(s.tablets.Márcio!, s.revestimento.id, 'resume');
    expect((await post(s.admin, `/api/v1/issues/${issue.id}/reopen`, {})).status).toBe(400);
    const r = await post(s.admin, `/api/v1/issues/${issue.id}/reopen`, { note: 'Voltou a travar' });
    expect(r.body).toMatchObject({ status: 'ABERTA', reopenCount: 1 });
    expect((await s.reload(s.revestimento.id)).status).toBe('PAUSADA');
    expect(await db().auditLog.count({ where: { action: 'issue.reopened' } })).toBe(1);
    // Histórico imutável e sem exclusão.
    await expect(db().productionIssueEvent.deleteMany({})).rejects.toThrow();
    await expect(db().productionIssue.deleteMany({})).rejects.toThrow();
  });

  it('14. cancelamento: quem registrou só a própria e aberta; gestor com motivo cancela a ação', async () => {
    const s = await scenario();
    await act(s.tablets.Márcio!, s.revestimento.id, 'start');
    const mistake = (
      await openIssue(s.tablets.Márcio!, {
        taskId: s.revestimento.id,
        kind: 'OUTRO',
        description: 'Registrado por engano',
        canContinue: false,
      })
    ).body;
    const own = await post(s.tablets.Márcio!, `/api/v1/issues/${mistake.id}/cancel`, {
      note: 'Foi engano',
    });
    expect(own.body.status).toBe('CANCELADA');
    expect(await notices(s.ids.marcio, 'TAREFA_DESBLOQUEADA')).toHaveLength(1);
    await act(s.tablets.Márcio!, s.revestimento.id, 'resume');
    const issue = await openIssue(s.tablets.Márcio!, {
      taskId: s.revestimento.id,
      kind: 'TECNICO',
      description: 'Máquina parou',
      impact: 'IMPEDIDO',
    });
    await assignTo(s.admin, issue.body.id, s.ids.thiago);
    expect(
      (await post(s.tablets.Márcio!, `/api/v1/issues/${issue.body.id}/cancel`, { note: 'x x x' }))
        .status,
    ).toBe(403);
    expect((await post(s.admin, `/api/v1/issues/${issue.body.id}/cancel`, {})).status).toBe(400);
    const g = await post(s.admin, `/api/v1/issues/${issue.body.id}/cancel`, {
      note: 'Máquina substituída por outra',
    });
    expect(g.body.status).toBe('CANCELADA');
    const action = await db().productionTask.findFirstOrThrow({
      where: { issueId: issue.body.id },
    });
    expect(action.status).toBe('CANCELADA');
    expect(await notices(s.ids.thiago, 'OCORRENCIA_CANCELADA')).toHaveLength(1);
  });
});

describe('Impactos, propostas e reprogramação', () => {
  it('15. impacto nas dependências e 16. proposta de bloqueio (sem duplicar; perde o efeito ao resolver)', async () => {
    const s = await scenario();
    const desm = s.t('DESMONTAGEM');
    await act(s.tablets.João!, desm.id, 'start');
    const r = await openIssue(s.tablets.João!, {
      taskId: desm.id,
      kind: 'TECNICO',
      description: 'Parafusos espanados na estrutura',
      impact: 'IMPEDIDO',
    });
    const impacts = (await s.admin.get(`/api/v1/issues/${r.body.id}/impacts`)).body;
    const codes = impacts.dependents.map((d: { code: string }) => d.code);
    expect(codes).toEqual(expect.arrayContaining([s.t('PREPARACAO').code, s.t('MONTAGEM').code]));
    expect(impacts.people).toContain('Márcio');
    const proposals = await db().rescheduleProposal.findMany({ where: { kind: 'BLOQUEIO' } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ issueId: r.body.id, status: 'PENDENTE' });
    await processIssueRisks(db());
    expect(await db().rescheduleProposal.count({ where: { kind: 'BLOQUEIO' } })).toBe(1);
    // Dependentes continuam bloqueadas (não liberadas indevidamente).
    expect((await s.reload(s.t('PREPARACAO').id)).status).toBe('BLOQUEADA');
    await post(s.admin, `/api/v1/issues/${r.body.id}/request-verification`, {
      note: 'Parafusos trocados',
    });
    await post(s.admin, `/api/v1/issues/${r.body.id}/verify`, {
      resolved: true,
      note: 'Conferido',
    });
    const after = await db().rescheduleProposal.findFirstOrThrow({ where: { kind: 'BLOQUEIO' } });
    expect(after.status).toBe('OBSOLETA');
  });

  it('17. proposta de conflito: falta de ajudante com risco de atraso (pedido segue na fila)', async () => {
    const s = await scenario();
    await act(s.tablets.João!, s.t('DESMONTAGEM').id, 'start');
    await act(s.tablets.Thiago!, s.cabeceira.id, 'start');
    await act(s.tablets.Márcio!, s.revestimento.id, 'start');
    const h = await post(s.tablets.Márcio!, '/api/v1/help-requests', {
      taskId: s.revestimento.id,
      kind: 'MOVIMENTAR',
    });
    expect(h.body.status).toBe('PENDENTE');
    setClock('09:25');
    await processHelpQueue(db());
    await processHelpQueue(db());
    const conflict = await db().rescheduleProposal.findMany({ where: { kind: 'CONFLITO' } });
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.problem).toMatch(/Falta de ajudante com risco de atraso/);
    expect((await db().helpRequest.findUniqueOrThrow({ where: { id: h.body.id } })).status).toBe(
      'PENDENTE',
    );
    // Thiago termina: atribuição automática e a proposta perde o efeito.
    await act(s.tablets.Thiago!, s.cabeceira.id, 'complete');
    expect((await db().helpRequest.findUniqueOrThrow({ where: { id: h.body.id } })).status).toBe(
      'ATRIBUIDA',
    );
    expect(
      (await db().rescheduleProposal.findFirstOrThrow({ where: { kind: 'CONFLITO' } })).status,
    ).toBe('OBSOLETA');
  });

  it('18. reprogramação simples durante o impedimento: alternativa indicada, nada iniciado', async () => {
    const s = await scenario();
    await machineIssue(s);
    const sugg = await db().planningAction.findMany({ where: { kind: 'ALTERNATIVA_SUGERIDA' } });
    expect(sugg).toHaveLength(1);
    expect(sugg[0]!.automatic).toBe(true);
    const mine = (await s.tablets.Márcio!.get('/api/v1/production-tasks/mine')).body.today as T[];
    expect(mine.filter((x) => x.status === 'EM_EXECUCAO')).toHaveLength(0);
    const alt = (await s.tablets.Márcio!.get('/api/v1/production-tasks/alternatives')).body as T[];
    expect(alt.length).toBeGreaterThan(0);
  });

  it('19. aprovação crítica: proposta de bloqueio com prazo em risco reprograma após aprovação', async () => {
    const s = await scenario({ dueToday: true });
    // Revestimento (prazo hoje) impedido antes de começar.
    const r = await openIssue(s.tablets.Márcio!, {
      taskId: s.revestimento.id,
      kind: 'TECNICO',
      description: 'Bancada quebrada',
      impact: 'IMPEDIDO',
    });
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals?status=PENDENTE')).body;
    expect(p).toMatchObject({ kind: 'BLOQUEIO', critical: true, proposedAlternativeId: 'ADIAR' });
    // Nada aplicado antes da aprovação.
    expect((await s.reload(s.revestimento.id)).scheduledDate).toBe(day(-1));
    const ap = await post(s.admin, `/api/v1/reschedule-proposals/${p.id}/approve`, {
      version: p.version,
    });
    expect(ap.body.status).toBe('APROVADA');
    expect((await s.reload(s.revestimento.id)).scheduledDate).not.toBe(day(-1));
    expect(r.status).toBe(201);
  });

  it('20. escolha manual de ajudante: impossível recusada, conflito com aprovação explícita', async () => {
    const s = await scenario({ arrive: ['Márcio', 'Thiago'] });
    await act(s.tablets.Thiago!, s.cabeceira.id, 'start');
    await act(s.tablets.Márcio!, s.revestimento.id, 'start');
    const h = await post(s.tablets.Márcio!, '/api/v1/help-requests', {
      taskId: s.revestimento.id,
      kind: 'PARAFUSAR',
    });
    expect(h.body.status).toBe('PENDENTE');
    const cands = (await s.admin.get(`/api/v1/help-requests/${h.body.id}/candidates`)).body;
    expect(cands.candidates.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['João', 'Thiago']),
    );
    const joao = await post(s.admin, `/api/v1/help-requests/${h.body.id}/assign`, {
      helperUserId: s.ids.joao,
    });
    expect(joao.status).toBe(422); // não confirmou chegada: impossível
    const thiago = await post(s.admin, `/api/v1/help-requests/${h.body.id}/assign`, {
      helperUserId: s.ids.thiago,
    });
    expect(thiago.status).toBe(409);
    const confirmed = await post(s.admin, `/api/v1/help-requests/${h.body.id}/assign`, {
      helperUserId: s.ids.thiago,
      confirmConflict: true,
      note: 'Cabeceira pode esperar 20 min',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: 'ATRIBUIDA',
      helper: { displayName: 'Thiago' },
    });
    const ev = confirmed.body.events.at(-1);
    expect(ev.note).toMatch(/Manual: gestor escolheu Thiago\. Conflito aprovado/);
    expect(ev.candidates).not.toBeNull();
    const action = await db().planningAction.findFirstOrThrow({
      where: { kind: 'AJUDA_ATRIBUIDA' },
    });
    expect(action.automatic).toBe(false);
    // Apoio entra na programação publicada como revisão (Fase 9).
    const plan = (await s.admin.get(`/api/v1/production-plans/${s.plan.id}`)).body;
    expect(plan.revisions[0].reason).toMatch(/Apoio AJ-00001 de Thiago para Márcio/);
  });
});

describe('Central de atenção', () => {
  it('central: só exceções, categorias, filtros e sem duplicar o mesmo fato', async () => {
    const s = await scenario();
    // Operação normal não aparece.
    let c = (await s.admin.get('/api/v1/attention')).body;
    expect(c.items).toHaveLength(0);
    const issue = await machineIssue(s);
    c = (await s.admin.get('/api/v1/attention')).body;
    const items = c.items.filter(
      (i: { task: { id: string } | null }) => i.task?.id === s.revestimento.id,
    );
    expect(items).toHaveLength(1); // a pausa por impedimento não vira outro item
    expect(items[0]).toMatchObject({
      type: 'OCORRENCIA',
      category: 'ACAO',
      employee: { displayName: 'Márcio' },
      nextActions: ['Delegar a solução'],
    });
    await assignTo(s.admin, issue.id, s.ids.thiago);
    const bySolver = (await s.admin.get(`/api/v1/attention?solverUserId=${s.ids.thiago}`)).body;
    expect(bySolver.items).toHaveLength(1);
    expect(bySolver.items[0]).toMatchObject({
      category: 'ATENCAO',
      solver: { displayName: 'Thiago' },
    });
    expect((await s.admin.get('/api/v1/attention?category=CRITICO')).body.items).toHaveLength(0);
    expect(
      (await s.admin.get(`/api/v1/attention?employeeUserId=${s.ids.marcio}&type=OCORRENCIA`)).body
        .items,
    ).toHaveLength(1);
    // Prazo de resolução vencido: crítico e um único aviso.
    setClock('12:00');
    await processIssueRisks(db());
    await processIssueRisks(db());
    expect(await notices(await gestorId(s.admin), 'OCORRENCIA_PRAZO_RISCO')).toHaveLength(1);
    expect(await notices(s.ids.thiago, 'OCORRENCIA_PRAZO_RISCO')).toHaveLength(1);
    c = (await s.admin.get('/api/v1/attention?type=OCORRENCIA')).body;
    expect(c.items[0].category).toBe('CRITICO');
    expect(c.counts.CRITICO).toBe(1);
  });
});

describe('Permissões, concorrência, idempotência e tempo real', () => {
  it('22. permissões verificadas no servidor', async () => {
    const s = await scenario();
    // Só nas próprias tarefas.
    expect(
      (
        await openIssue(s.tablets.Márcio!, {
          taskId: s.cabeceira.id,
          kind: 'OUTRO',
          description: 'Problema alheio',
          canContinue: true,
        })
      ).status,
    ).toBe(403);
    const issue = await machineIssue(s);
    // Tablets não veem a central, não delegam, não verificam, não reabrem.
    for (const c of [s.tablets.Márcio!, s.tablets.Thiago!]) {
      expect((await c.get('/api/v1/attention')).status).toBe(403);
      expect((await c.get('/api/v1/issues')).status).toBe(403);
      expect((await assignTo(c, issue.id, s.ids.thiago)).status).toBe(403);
    }
    // Outro funcionário não vê nem encerra a ocorrência de terceiros.
    expect((await s.tablets.Ricardo!.get(`/api/v1/issues/${issue.id}`)).status).toBe(403);
    expect(
      (await post(s.tablets.Ricardo!, `/api/v1/issues/${issue.id}/cancel`, { note: 'Não é meu' }))
        .status,
    ).toBe(403);
    await assignTo(s.admin, issue.id, s.ids.thiago);
    // Quem resolve registra ação, mas não confirma a resolução.
    expect(
      (await post(s.tablets.Thiago!, `/api/v1/issues/${issue.id}/actions`, { note: 'Fui ver' }))
        .status,
    ).toBe(200);
    expect(
      (
        await post(s.tablets.Thiago!, `/api/v1/issues/${issue.id}/verify`, {
          resolved: true,
          note: 'ok ok',
        })
      ).status,
    ).toBe(403);
    // Quem registrou não registra ações nem verifica.
    expect(
      (await post(s.tablets.Márcio!, `/api/v1/issues/${issue.id}/actions`, { note: 'Tentei' }))
        .status,
    ).toBe(403);
    // O próprio Márcio acompanha a ocorrência.
    const mine = (await s.tablets.Márcio!.get('/api/v1/issues/mine')).body;
    expect(mine[0]).toMatchObject({ id: issue.id, status: 'ATRIBUIDA' });
  });

  it('23. concorrência: versão desatualizada e decisões simultâneas', async () => {
    const s = await scenario();
    const issue = await machineIssue(s);
    await post(s.admin, `/api/v1/issues/${issue.id}/request-verification`, { note: 'Ajustada' });
    const cur = (await s.admin.get(`/api/v1/issues/${issue.id}`)).body;
    const stale = await post(s.admin, `/api/v1/issues/${issue.id}/verify`, {
      resolved: true,
      note: 'Conferida',
      version: cur.version + 5,
    });
    expect(stale.status).toBe(409);
    const [a, b] = await Promise.all([
      post(s.admin, `/api/v1/issues/${issue.id}/verify`, { resolved: true, note: 'Resolvida' }),
      post(s.admin, `/api/v1/issues/${issue.id}/cancel`, { note: 'Cancelada ao mesmo tempo' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const final = await db().productionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(['RESOLVIDA', 'CANCELADA']).toContain(final.status);
  });

  it('24. idempotência e ocorrências duplicadas', async () => {
    const s = await scenario();
    await act(s.tablets.Márcio!, s.revestimento.id, 'start');
    const body = {
      taskId: s.revestimento.id,
      kind: 'TECNICO',
      description: 'Máquina travando',
      impact: 'IMPEDIDO',
    };
    const key = idemKey();
    const a = await openIssue(s.tablets.Márcio!, body, key);
    const b = await openIssue(s.tablets.Márcio!, body, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await db().productionIssue.count()).toBe(1);
    const dup = await openIssue(s.tablets.Márcio!, body);
    expect(dup.status).toBe(409);
    expect(await notices(await gestorId(s.admin), 'OCORRENCIA_ABERTA')).toHaveLength(1);
  });

  it('25. sincronização em tempo real e 26. reconexão recupera os avisos', async () => {
    const s = await scenario();
    const wAdmin = track(await WsClient.connect(app, s.admin));
    const wThiago = track(await WsClient.connect(app, s.tablets.Thiago!));
    const wJoao = track(await WsClient.connect(app, s.tablets.João!));
    const issue = await machineIssue(s);
    await wAdmin.waitFor((m) => m.kind === 'event' && m.event.type === 'issue.opened');
    // Colegas não recebem a ocorrência do Márcio.
    expect(wThiago.events('issue.opened')).toHaveLength(0);
    expect(wJoao.events('issue.opened')).toHaveLength(0);
    const lastSeq = (wThiago.events().at(-1)?.seq as string | undefined) ?? '0';
    await wThiago.close();
    await assignTo(s.admin, issue.id, s.ids.thiago);
    const back = track(await WsClient.connect(app, s.tablets.Thiago!, String(lastSeq)));
    await back.waitFor((m) => m.kind === 'replay.done');
    expect(back.events('issue.assigned')).toHaveLength(1);
    expect(
      back
        .events('notification.created')
        .some((e: { payload: { kind: string } }) => e.payload.kind === 'OCORRENCIA_ATRIBUIDA'),
    ).toBe(true);
    await wAdmin.waitFor((m) => m.kind === 'event' && m.event.type === 'issue.assigned');
  });
});
