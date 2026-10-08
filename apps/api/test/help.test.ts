import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { loadEnv } from '../src/config/env';
import { detectAbsences } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { processHelpQueue } from '../src/modules/help/queue';
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
  userIdOf,
} from './production-helpers';

/**
 * Fase 8 — distribuição automática de ajudantes e reprogramação. Relógio operacional fixo
 * (hoje, horário escolhido pelo teste); as tarefas são programadas para ontem (liberadas
 * em qualquer horário real).
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
  activity: string;
  status: string;
  version: number;
  scheduledAt: string | null;
  assignee: { userId: string } | null;
  supportFor: { id: string } | null;
};
const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
};

/**
 * Sofá publicado (materiais completos): Ricardo é o principal (corte de tecido liberado);
 * João tem desmontagem (liberada) e preparação; Márcio tem um revestimento liberado e
 * Thiago uma cabeceira liberada. Quem estiver em `arrive` confirma chegada às 8h30.
 */
async function scenario(
  opts: {
    arrive?: string[];
    materials?: 'complete' | 'missing';
    extra?: Record<string, unknown>[];
  } = {},
) {
  const arriving = opts.arrive ?? ['Ricardo', 'João', 'Thiago'];
  const admin = await loginAdmin(app);
  const { so } = await serviceOrderWith(admin, opts.materials ?? 'complete', 'Cliente Ajuda');
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
      principalUserId: ids.ricardo,
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
  const marcioTask = await extra({
    activity: 'REVESTIMENTO',
    title: 'Revestimento do braço',
    assigneeUserId: ids.marcio,
  });
  const thiagoTask = await extra({
    activity: 'OUTRA',
    title: 'Cabeceira estofada',
    assigneeUserId: ids.thiago,
  });
  const extras: T[] = [];
  for (const e of opts.extra ?? []) extras.push(await extra(e));
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
    plan,
    ids,
    t,
    main: t('CORTE_TECIDO'),
    marcioTask: await reload(marcioTask.id),
    thiagoTask: await reload(thiagoTask.id),
    extras: await Promise.all(extras.map((e) => reload(e.id))),
    tablets,
    reload,
  };
}

const ask = (c: Client, body: Record<string, unknown>, key = idemKey()) =>
  c.post('/api/v1/help-requests', body, { 'idempotency-key': key });
const notices = async (userId: string, kind?: string) =>
  db().notification.findMany({
    where: { userId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'asc' },
  });
const gestorId = async (admin: Client) => (await admin.get('/api/auth/me')).body.user.id as string;
const attendanceAction = (admin: Client, body: Record<string, unknown>) =>
  admin.post('/api/v1/attendance/actions', { date: today(), ...body });
type Candidate = { name: string; eligible: boolean; reasons: string[]; score: number };
const lastEvaluation = (h: { events: { candidates: Candidate[] | null }[] }) =>
  h.events.filter((e) => e.candidates).at(-1)!.candidates!;

describe('Solicitar ajudante', () => {
  it('1. solicitação normal: duração sugerida, tarefa de apoio vinculada, histórico e avisos', async () => {
    const s = await scenario();
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      code: 'AJ-00001',
      status: 'ATRIBUIDA',
      estimatedMinutes: 20,
      urgent: false,
      requester: { displayName: 'Ricardo' },
      helper: { displayName: 'João' },
      task: { id: s.main.id },
    });
    expect(r.body.events.map((e: { kind: string }) => e.kind)).toEqual(['SOLICITADA', 'ATRIBUIDA']);
    // Tarefa de apoio separada, na mesma OS, ligada à principal e já liberada para o João.
    const support = await s.reload(r.body.supportTask.id);
    expect(support).toMatchObject({
      status: 'LIBERADA',
      activity: 'APOIO',
      assignee: { userId: s.ids.joao },
      supportFor: { id: s.main.id },
    });
    expect((support as unknown as { estimatedMinutes: number }).estimatedMinutes).toBe(20);
    expect((await notices(s.ids.joao, 'AJUDA_ATRIBUIDA'))[0]?.body).toMatch(
      /Ricardo precisa de ajuda: Parafusar estrutura \(20 min\)/,
    );
    expect((await notices(s.ids.ricardo)).map((n) => n.kind)).toEqual(
      expect.arrayContaining(['AJUDA_SOLICITADA', 'AJUDA_ATRIBUIDA']),
    );
    const actions = await db().planningAction.findMany({ where: { helpRequestId: r.body.id } });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'AJUDA_ATRIBUIDA', automatic: true }),
    ]);
    // Duração ajustável e observação opcional.
    const other = await ask(s.tablets.Márcio!, {
      taskId: s.marcioTask.id,
      kind: 'MOVIMENTAR',
      estimatedMinutes: 45,
      note: 'Sofá de 3 lugares',
    });
    expect(other.body).toMatchObject({ estimatedMinutes: 45, note: 'Sofá de 3 lugares' });
    // A principal continua com o Ricardo, sem mudança de status.
    expect((await s.reload(s.main.id)).status).toBe('LIBERADA');
  });

  it('2. urgente: exige justificativa, prioridade urgente e alerta ao gestor', async () => {
    const s = await scenario();
    const noWhy = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'MOVIMENTAR',
      urgent: true,
    });
    expect(noWhy.status).toBe(400);
    const r = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'MOVIMENTAR',
      urgent: true,
      justification: 'Sofá pesado apoiado só de um lado',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ urgent: true, status: 'ATRIBUIDA' });
    expect(
      (await s.reload(r.body.supportTask.id)) as unknown as { priority: string },
    ).toMatchObject({ priority: 'URGENTE' });
    const gestor = await notices(await gestorId(s.admin), 'AJUDA_SOLICITADA');
    expect(gestor).toHaveLength(1);
    expect(gestor[0]!.body).toMatch(/Sofá pesado/);
    expect(
      await db().auditLog.count({
        where: { action: 'help.requested_urgent', entityId: r.body.id },
      }),
    ).toBe(1);
  });

  it('2b. urgente sem ninguém livre: vai ao gestor (nada é interrompido sem aprovação)', async () => {
    const s = await scenario();
    await act(s.tablets.João!, s.t('DESMONTAGEM').id, 'start');
    await act(s.tablets.Thiago!, s.thiagoTask.id, 'start');
    const r = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'POSICIONAR',
      urgent: true,
      justification: 'Peça escorregando',
    });
    expect(r.body.status).toBe('ESCALADA');
    expect((await s.reload(s.t('DESMONTAGEM').id)).status).toBe('EM_EXECUCAO');
    const proposals = (await s.admin.get('/api/v1/reschedule-proposals?status=PENDENTE')).body;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'AJUDA_URGENTE', critical: true });
    expect(proposals[0].alternatives.map((a: { id: string }) => a.id)).toEqual([
      'INTERROMPER_1',
      'INTERROMPER_2',
      'AGUARDAR',
    ]);
    // A fila não volta a escalar o mesmo pedido.
    await processHelpQueue(db());
    expect(await db().rescheduleProposal.count()).toBe(1);
    // Aprovação: a tarefa do João é pausada (andamento preservado) e o apoio é atribuído.
    const ok = await s.admin.post(
      `/api/v1/reschedule-proposals/${proposals[0].id}/approve`,
      { alternativeId: 'INTERROMPER_1', version: proposals[0].version },
      { 'idempotency-key': idemKey() },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APROVADA');
    const desmontagem = (await s.reload(s.t('DESMONTAGEM').id)) as unknown as {
      status: string;
      pauseReason: string;
    };
    expect(desmontagem).toMatchObject({ status: 'PAUSADA', pauseReason: 'INTERRUPCAO_PROGRAMADA' });
    const help = (await s.tablets.Ricardo!.get(`/api/v1/help-requests/${r.body.id}`)).body;
    expect(help).toMatchObject({ status: 'ATRIBUIDA', helper: { displayName: 'João' } });
  });
});

describe('Motor de distribuição', () => {
  it('3. só João disponível: João é escolhido', async () => {
    const s = await scenario({ arrive: ['Ricardo', 'João'] });
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'OUTRO' });
    expect(r.body.helper.displayName).toBe('João');
  });

  it('4. só Thiago disponível: Thiago é escolhido; motivo do João registrado', async () => {
    const s = await scenario({ arrive: ['Ricardo', 'Thiago'] });
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'AUXILIAR_MONTAGEM' });
    expect(r.body.helper.displayName).toBe('Thiago');
    const detail = (await s.admin.get(`/api/v1/help-requests/${r.body.id}`)).body;
    const ev = lastEvaluation(detail);
    expect(ev.find((c) => c.name === 'João')).toMatchObject({
      eligible: false,
      reasons: ['NAO_CONFIRMOU'],
    });
    // Tapeceiros sem competência de apoio nunca são escolhidos.
    expect(ev.find((c) => c.name === 'Márcio')?.reasons).toContain('SEM_COMPETENCIA');
  });

  it('5. ambos disponíveis: menor impacto; empate preserva o Thiago (prefere o João)', async () => {
    const s = await scenario();
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(r.body.helper.displayName).toBe('João');
    const ev = lastEvaluation((await s.admin.get(`/api/v1/help-requests/${r.body.id}`)).body);
    const joao = ev.find((c) => c.name === 'João')!;
    const thiago = ev.find((c) => c.name === 'Thiago')!;
    expect(joao.eligible && thiago.eligible).toBe(true);
    expect(thiago.score).toBeGreaterThan(joao.score);
    // Determinístico: o mesmo cenário gera a mesma pontuação.
    expect(joao.score).toBe(3); // tarefa liberada aguardando
    expect(thiago.score).toBe(13); // especialidade preservada + tarefa liberada
  });

  it('6. ambos ocupados: fica na fila, avisa uma vez e atribui quando alguém termina', async () => {
    const s = await scenario();
    await act(s.tablets.João!, s.t('DESMONTAGEM').id, 'start');
    await act(s.tablets.Thiago!, s.thiagoTask.id, 'start');
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(r.body.status).toBe('PENDENTE');
    expect(r.body.events.map((e: { kind: string }) => e.kind)).toContain('EM_ESPERA');
    await processHelpQueue(db());
    await processHelpQueue(db());
    expect(await notices(s.ids.ricardo, 'AJUDA_EM_ESPERA')).toHaveLength(1);
    // Risco de atraso: alerta único ao gestor depois de 20 min.
    setClock('09:25');
    await processHelpQueue(db());
    await processHelpQueue(db());
    expect(await notices(await gestorId(s.admin), 'AJUDA_EM_ESPERA')).toHaveLength(1);
    // O Thiago termina: a fila é reavaliada e o pedido é atribuído a ele.
    await act(s.tablets.Thiago!, s.thiagoTask.id, 'complete');
    const after = (await s.tablets.Ricardo!.get(`/api/v1/help-requests/${r.body.id}`)).body;
    expect(after).toMatchObject({ status: 'ATRIBUIDA', helper: { displayName: 'Thiago' } });
  });

  it('7. funcionário ausente nunca é escolhido', async () => {
    const s = await scenario({ arrive: ['Ricardo', 'Thiago'] });
    const joao = await employeeByName('João');
    expect(
      (
        await attendanceAction(s.admin, {
          employeeId: joao.id,
          action: 'FOLGA',
          reason: 'Folga combinada',
        })
      ).status,
    ).toBe(200);
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(r.body.helper.displayName).toBe('Thiago');
    const ev = lastEvaluation((await s.admin.get(`/api/v1/help-requests/${r.body.id}`)).body);
    expect(ev.find((c) => c.name === 'João')?.reasons).toEqual(['AUSENTE']);
  });

  it('8. sem competência: gestor ajusta competências; ninguém capacitado → fila', async () => {
    const s = await scenario();
    const joao = await employeeByName('João');
    const thiago = await employeeByName('Thiago');
    const skills = (await s.admin.get('/api/v1/skills')).body as {
      employeeId: string;
      skills: string[];
    }[];
    expect(skills.find((x) => x.employeeId === joao.id)?.skills).toContain('PARAFUSAR');
    const without = (list: string[]) => list.filter((k) => k !== 'PARAFUSAR');
    await s.admin.put(`/api/v1/employees/${joao.id}/skills`, {
      skills: without(skills.find((x) => x.employeeId === joao.id)!.skills),
    });
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(r.body.helper.displayName).toBe('Thiago');
    await s.admin.put(`/api/v1/employees/${thiago.id}/skills`, {
      skills: without(skills.find((x) => x.employeeId === thiago.id)!.skills),
    });
    const m = await ask(s.tablets.Márcio!, { taskId: s.marcioTask.id, kind: 'PARAFUSAR' });
    expect(m.body.status).toBe('PENDENTE');
    const ev = lastEvaluation((await s.admin.get(`/api/v1/help-requests/${m.body.id}`)).body);
    expect(ev.find((c) => c.name === 'João')?.reasons).toContain('SEM_COMPETENCIA');
    expect(await db().auditLog.count({ where: { action: 'help.skills_changed' } })).toBe(2);
  });

  it('9. solicitações simultâneas nunca recebem o mesmo ajudante', async () => {
    const s = await scenario({ arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const [a, b] = await Promise.all([
      ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'MOVIMENTAR' }),
      ask(s.tablets.Márcio!, { taskId: s.marcioTask.id, kind: 'MOVIMENTAR' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const helpers = [a.body.helper?.displayName, b.body.helper?.displayName].sort();
    expect(helpers).toEqual(['João', 'Thiago']);
  });
});

describe('Ciclo do apoio', () => {
  it('10. cancelamento: pendente e atribuída; apoio iniciado não pode ser cancelado', async () => {
    const s = await scenario({ arrive: ['Ricardo', 'Márcio', 'João'] });
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'MOVIMENTAR' });
    expect(r.body.status).toBe('ATRIBUIDA');
    // Outra pessoa não cancela o pedido do Ricardo.
    const other = await s.tablets.Márcio!.post(
      `/api/v1/help-requests/${r.body.id}/cancel`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(other.status).toBe(403);
    const c = await s.tablets.Ricardo!.post(
      `/api/v1/help-requests/${r.body.id}/cancel`,
      { reason: 'Consegui sozinho' },
      { 'idempotency-key': idemKey() },
    );
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('CANCELADA');
    expect((await s.reload(r.body.supportTask.id)).status).toBe('CANCELADA');
    expect((await notices(s.ids.joao, 'AJUDA_CANCELADA'))[0]?.body).toMatch(
      /não é mais necessário/,
    );
    // Novo pedido, iniciado pelo João: não pode mais ser cancelado.
    const again = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'MOVIMENTAR' });
    expect(again.status).toBe(201);
    await act(s.tablets.João!, again.body.supportTask.id, 'start');
    const late = await s.tablets.Ricardo!.post(
      `/api/v1/help-requests/${again.body.id}/cancel`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(late.status).toBe(422);
  });

  it('11. conclusão do apoio pelo ajudante no tablet', async () => {
    const s = await scenario();
    await act(s.tablets.Ricardo!, s.main.id, 'start');
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    const supportId = r.body.supportTask.id as string;
    // O apoio aparece no "Meu dia" do João.
    const mine = (await s.tablets.João!.get('/api/v1/production-tasks/mine')).body.today as T[];
    expect(mine.find((x) => x.id === supportId)?.supportFor?.id).toBe(s.main.id);
    expect((await act(s.tablets.João!, supportId, 'start')).status).toBe(200);
    let h = (await s.tablets.Ricardo!.get(`/api/v1/help-requests/${r.body.id}`)).body;
    expect(h.status).toBe('EM_EXECUCAO');
    expect((await act(s.tablets.João!, supportId, 'complete')).status).toBe(200);
    h = (await s.tablets.Ricardo!.get(`/api/v1/help-requests/${r.body.id}`)).body;
    expect(h.status).toBe('CONCLUIDA');
    expect((await notices(s.ids.ricardo, 'AJUDA_CONCLUIDA'))[0]?.body).toMatch(
      /João concluiu o apoio.*Sua tarefa continua com você/,
    );
  });

  it('12. a tarefa principal permanece independente (trabalho simultâneo na mesma OS)', async () => {
    const s = await scenario();
    await act(s.tablets.Ricardo!, s.main.id, 'start');
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'AUXILIAR_MONTAGEM' });
    const supportId = r.body.supportTask.id as string;
    await act(s.tablets.João!, supportId, 'start');
    expect((await s.reload(s.main.id)).status).toBe('EM_EXECUCAO');
    expect((await s.reload(supportId)).status).toBe('EM_EXECUCAO');
    await act(s.tablets.João!, supportId, 'complete');
    // Concluir o apoio não conclui a principal.
    expect((await s.reload(s.main.id)).status).toBe('EM_EXECUCAO');
    // Tarefa de apoio não aceita pedido de ajuda.
    expect((await ask(s.tablets.João!, { taskId: supportId, kind: 'OUTRO' })).status).toBe(403);
    // A principal conclui normalmente depois; um pedido ainda não iniciado é cancelado.
    const pending = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'MOVIMENTAR' });
    expect(pending.status).toBe(201);
    expect((await act(s.tablets.Ricardo!, s.main.id, 'complete')).status).toBe(200);
    const closed = (await s.admin.get(`/api/v1/help-requests/${pending.body.id}`)).body;
    expect(closed.status).toBe('CANCELADA');
  });
});

describe('Reprogramação', () => {
  it('13. reprogramação simples automática (ausência confirmada → apoio redistribuído)', async () => {
    const s = await scenario({ arrive: ['Ricardo', 'Thiago'] });
    const joao = await employeeByName('João');
    const r = await attendanceAction(s.admin, {
      employeeId: joao.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Avisou que não vem',
    });
    expect(r.status).toBe(200);
    // Desmontagem e preparação (apoio, prioridade normal, sem prazo hoje): para o Thiago.
    for (const a of ['DESMONTAGEM', 'PREPARACAO'])
      expect((await s.reload(s.t(a).id)).assignee?.userId).toBe(s.ids.thiago);
    const auto = await db().planningAction.findMany({ where: { kind: 'TAREFA_REATRIBUIDA' } });
    expect(auto).toHaveLength(2);
    expect(auto.every((x) => x.automatic && x.reason.startsWith('Automático'))).toBe(true);
    expect(await notices(s.ids.thiago, 'REPROGRAMACAO_AUTOMATICA')).toHaveLength(2);
    // Revisão da programação publicada com o motivo.
    const plan = (await s.admin.get(`/api/v1/production-plans/${s.plan.id}`)).body;
    expect(plan.revisions[0].reason).toMatch(/Automático: ausência confirmada de João/);
    // Nada sobra para decidir: nenhuma proposta.
    expect(await db().rescheduleProposal.count()).toBe(0);
  });

  it('14. reprogramação crítica (tapeceiro principal ausente) vai ao gestor e nada muda antes', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    const ricardo = await employeeByName('Ricardo');
    await attendanceAction(s.admin, {
      employeeId: ricardo.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Consulta médica',
    });
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals?status=PENDENTE')).body;
    expect(p).toMatchObject({ kind: 'AUSENCIA', critical: true, proposedAlternativeId: 'ADIAR' });
    expect(p.situation).toMatch(/Ricardo: ausência confirmada/);
    expect(p.alternatives.map((a: { id: string }) => a.id)).toEqual([
      'TROCAR_PRINCIPAL',
      'ADIAR',
      'AGUARDAR',
    ]);
    expect(p.alternatives[0]).toMatchObject({ critical: true, title: /Márcio/ });
    expect(p.affectedTasks.length).toBeGreaterThanOrEqual(4);
    // Nada foi aplicado.
    expect((await s.reload(s.main.id)).assignee?.userId).toBe(s.ids.ricardo);
    expect(await notices(await gestorId(s.admin), 'REPROGRAMACAO_PENDENTE')).toHaveLength(1);
  });

  it('15. aprovação do gestor (com ajuste) aplica, registra e avisa', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    const ricardo = await employeeByName('Ricardo');
    await attendanceAction(s.admin, {
      employeeId: ricardo.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Consulta médica',
    });
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals?status=PENDENTE')).body;
    const target = day(3);
    const adjust = await s.admin.post(
      `/api/v1/reschedule-proposals/${p.id}/adjust`,
      {
        alternativeId: 'ADIAR',
        overrides: [{ taskId: s.main.id, toDate: target, toTime: '10:00' }],
        note: 'Corte fica para quando o Ricardo voltar',
        version: p.version,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(adjust.status).toBe(200);
    expect(adjust.body).toMatchObject({ status: 'AJUSTADA', chosenAlternativeId: 'ADIAR' });
    const main = await s.reload(s.main.id);
    expect(main.status).toBe('PROGRAMADA');
    expect((main as unknown as { scheduledDate: string }).scheduledDate).toBe(target);
    const history = (await s.admin.get('/api/v1/planning-actions')).body as {
      kind: string;
      automatic: boolean;
      actor: string;
    }[];
    expect(history.find((h) => h.kind === 'PROPOSTA_APROVADA')).toMatchObject({
      automatic: false,
      actor: 'Gestor Teste',
    });
    expect(await notices(s.ids.ricardo, 'REPROGRAMACAO_APROVADA')).not.toHaveLength(0);
    // Já decidida: nova decisão é recusada.
    const again = await s.admin.post(
      `/api/v1/reschedule-proposals/${p.id}/approve`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(again.status).toBe(422);
  });

  it('16. rejeição: nada é aplicado e o pedido urgente volta para a fila', async () => {
    const s = await scenario();
    await act(s.tablets.João!, s.t('DESMONTAGEM').id, 'start');
    await act(s.tablets.Thiago!, s.thiagoTask.id, 'start');
    const r = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'MOVIMENTAR',
      urgent: true,
      justification: 'Mover para a mesa agora',
    });
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals?status=PENDENTE')).body;
    const noReason = await s.admin.post(
      `/api/v1/reschedule-proposals/${p.id}/reject`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(noReason.status).toBe(400);
    const rej = await s.admin.post(
      `/api/v1/reschedule-proposals/${p.id}/reject`,
      { note: 'Termina a desmontagem primeiro' },
      { 'idempotency-key': idemKey() },
    );
    expect(rej.body.status).toBe('REJEITADA');
    expect((await s.reload(s.t('DESMONTAGEM').id)).status).toBe('EM_EXECUCAO');
    const h = (await s.tablets.Ricardo!.get(`/api/v1/help-requests/${r.body.id}`)).body;
    expect(h.status).toBe('PENDENTE');
    expect((await notices(s.ids.ricardo, 'REPROGRAMACAO_REJEITADA'))[0]?.body).toMatch(
      /Termina a desmontagem/,
    );
  });
});

describe('Ausências, bloqueios, materiais e dependências', () => {
  it('17. ausência presumida: só sugere (aguardar recomendado), sem transferir nada', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    setClock('09:31');
    await detectAbsences(db());
    await detectAbsences(db());
    const list = (await s.admin.get('/api/v1/reschedule-proposals')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'AUSENCIA', proposedAlternativeId: 'AGUARDAR' });
    expect(list[0].situation).toMatch(/presumida/);
    expect((await s.reload(s.main.id)).assignee?.userId).toBe(s.ids.ricardo);
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_REATRIBUIDA' } })).toBe(0);
  });

  it('18. chegada tardia torna a sugestão sem efeito e não duplica', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    setClock('09:31');
    await detectAbsences(db());
    setClock('10:05');
    await s.tablets.Ricardo!.post(
      '/api/v1/attendance/me/arrive',
      {},
      { 'idempotency-key': idemKey() },
    );
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals')).body;
    expect(p.status).toBe('OBSOLETA');
    expect(p.decisionNote).toMatch(/Ricardo chegou às 10:05/);
    await detectAbsences(db());
    expect(await db().rescheduleProposal.count()).toBe(1);
    // Aprovar uma proposta sem efeito é recusado.
    const late = await s.admin.post(
      `/api/v1/reschedule-proposals/${p.id}/approve`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(late.status).toBe(422);
  });

  it('19. tarefa bloqueada: indica outra liberada ou antecipa a próxima pronta, sem iniciar', async () => {
    const s = await scenario();
    const extra = (
      await s.admin.post(
        `/api/v1/production-plans/${s.plan.id}/tasks`,
        {
          serviceOrderId: s.so.id,
          activity: 'REVESTIMENTO',
          title: 'Revestimento para mais tarde',
          assigneeUserId: s.ids.ricardo,
          date: today(),
          time: '23:58',
          reason: 'Encaixe',
        },
        { 'idempotency-key': idemKey() },
      )
    ).body as T;
    expect(extra.status).toBe('PROGRAMADA');
    // O corte da poltrona (outra liberada do Ricardo) bloqueado: o corte do sofá é indicado.
    const mine = (await s.tablets.Ricardo!.get('/api/v1/production-tasks/mine')).body.today as T[];
    const poltrona = mine.find((x) => x.status === 'LIBERADA' && x.id !== s.main.id)!;
    await s.admin.post(`/api/v1/production-tasks/${poltrona.id}/block`, {
      reason: 'Aguardar peça',
    });
    expect((await notices(s.ids.ricardo, 'TAREFA_ALTERNATIVA_LIBERADA'))[0]?.taskId).toBe(
      s.main.id,
    );
    expect((await s.reload(s.main.id)).status).toBe('LIBERADA'); // só indicada, nada muda
    // Agora o corte do sofá: sem outra liberada, a próxima pronta de hoje é antecipada.
    const block = await s.admin.post(`/api/v1/production-tasks/${s.main.id}/block`, {
      reason: 'Tecido com defeito',
    });
    expect(block.status).toBe(200);
    const anticipated = await s.reload(extra.id);
    expect(anticipated.status).toBe('LIBERADA'); // liberada, nunca iniciada sozinha
    expect(new Date(anticipated.scheduledAt!).getTime()).toBeLessThanOrEqual(Date.now());
    const action = await db().planningAction.findFirstOrThrow({
      where: { kind: 'TAREFA_ANTECIPADA' },
    });
    expect(action).toMatchObject({ automatic: true, taskId: extra.id });
    expect((await notices(s.ids.ricardo, 'TAREFA_ALTERNATIVA_LIBERADA'))[1]?.body).toMatch(
      /Revestimento para mais tarde/,
    );
    const alternatives = (await s.tablets.Ricardo!.get('/api/v1/production-tasks/alternatives'))
      .body as T[];
    expect(alternatives.map((a) => a.id)).toEqual([extra.id]);
    // Desbloqueio e novo bloqueio: a alternativa já liberada é só indicada (nada muda).
    await s.admin.post(`/api/v1/production-tasks/${s.main.id}/unblock`, { reason: 'Ok' });
    await s.admin.post(`/api/v1/production-tasks/${s.main.id}/block`, { reason: 'De novo' });
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_ANTECIPADA' } })).toBe(1);
    expect(await db().planningAction.count({ where: { kind: 'ALTERNATIVA_SUGERIDA' } })).toBe(2);
  });

  it('19b. pausa por impedimento preserva o andamento e indica alternativa', async () => {
    const s = await scenario();
    const extra = (
      await s.admin.post(
        `/api/v1/production-plans/${s.plan.id}/tasks`,
        {
          serviceOrderId: s.so.id,
          activity: 'REVESTIMENTO',
          title: 'Revestimento liberado',
          assigneeUserId: s.ids.ricardo,
          date: day(-1),
          time: '08:00',
          reason: 'Encaixe',
        },
        { 'idempotency-key': idemKey() },
      )
    ).body as T;
    await act(s.tablets.Ricardo!, s.main.id, 'start');
    await act(s.tablets.Ricardo!, s.main.id, 'progress', { note: 'Metade', percent: 50 });
    await act(s.tablets.Ricardo!, s.main.id, 'pause', {
      reason: 'AGUARDANDO_ORIENTACAO',
      impediment: true,
      note: 'Medida divergente',
    });
    const main = (await s.reload(s.main.id)) as unknown as {
      status: string;
      lastProgress: { percent: number };
    };
    expect(main).toMatchObject({ status: 'PAUSADA', lastProgress: { percent: 50 } });
    expect((await notices(s.ids.ricardo, 'TAREFA_ALTERNATIVA_LIBERADA'))[0]?.taskId).toBe(extra.id);
    expect((await s.reload(extra.id)).status).toBe('LIBERADA');
  });

  it('20. materiais indisponíveis: sem pedido em tarefa bloqueada e sem antecipar tarefa sem material', async () => {
    const s = await scenario({ materials: 'missing' });
    expect(s.main.status).toBe('BLOQUEADA');
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(r.status).toBe(422);
    // Revestimento com material faltando, programado para hoje: não é antecipado.
    const withMaterial = (
      await s.admin.post(
        `/api/v1/production-plans/${s.plan.id}/tasks`,
        {
          serviceOrderId: s.so.id,
          activity: 'REVESTIMENTO',
          assigneeUserId: s.ids.marcio,
          date: today(),
          time: '23:58',
          requiresMaterials: true,
          reason: 'Encaixe',
        },
        { 'idempotency-key': idemKey() },
      )
    ).body as T;
    await s.admin.post(`/api/v1/production-tasks/${s.marcioTask.id}/block`, {
      reason: 'Bancada ocupada',
    });
    expect((await s.reload(withMaterial.id)).status).toBe('BLOQUEADA');
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_ANTECIPADA' } })).toBe(0);
  });

  it('21. dependências: tarefa dependente não é antecipada e aparece como afetada', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    // Bloquear o corte: a costura (depende do corte) não é antecipada.
    await s.admin.post(`/api/v1/production-tasks/${s.main.id}/block`, {
      reason: 'Aguardar cliente',
    });
    expect((await s.reload(s.t('COSTURA').id)).status).toBe('BLOQUEADA');
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_ANTECIPADA' } })).toBe(0);
    // Ausência presumida do Ricardo: as dependentes de outras pessoas entram na proposta.
    setClock('09:31');
    await detectAbsences(db());
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals')).body;
    expect(p.problem).toMatch(/dependente/);
  });
});

describe('Permissões, concorrência, idempotência e tempo real', () => {
  it('22. permissões verificadas no servidor', async () => {
    const s = await scenario();
    // Ajudante não pede ajuda; ninguém pede ajuda em tarefa de outra pessoa.
    expect(
      (await ask(s.tablets.João!, { taskId: s.t('DESMONTAGEM').id, kind: 'OUTRO' })).status,
    ).toBe(403);
    expect((await ask(s.tablets.Ricardo!, { taskId: s.marcioTask.id, kind: 'OUTRO' })).status).toBe(
      403,
    );
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'OUTRO' });
    // Tablet: não vê fila, propostas, histórico nem competências; não altera competências.
    for (const url of [
      '/api/v1/help-requests',
      '/api/v1/reschedule-proposals',
      '/api/v1/planning-actions',
      '/api/v1/skills',
    ])
      expect((await s.tablets.Ricardo!.get(url)).status).toBe(403);
    const joao = await employeeByName('João');
    expect(
      (await s.tablets.Thiago!.put(`/api/v1/employees/${joao.id}/skills`, { skills: [] })).status,
    ).toBe(403);
    // Pedido de outra pessoa: só solicitante, ajudante ou gestão.
    expect((await s.tablets.Márcio!.get(`/api/v1/help-requests/${r.body.id}`)).status).toBe(403);
    const asHelper = await s.tablets.João!.get(`/api/v1/help-requests/${r.body.id}`);
    expect(asHelper.status).toBe(200);
    // No tablet, a avaliação dos colegas não é exposta.
    expect(asHelper.body.events.every((e: { candidates: unknown }) => e.candidates === null)).toBe(
      true,
    );
    // Relógio de teste não existe sem a configuração.
    expect((await s.admin.post('/api/test/clock', { now: null })).status).toBe(404);
  });

  it('23. concorrência: versão desatualizada e decisões simultâneas', async () => {
    const s = await scenario({ arrive: ['Márcio', 'João', 'Thiago'] });
    const ricardo = await employeeByName('Ricardo');
    await attendanceAction(s.admin, {
      employeeId: ricardo.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Imprevisto',
    });
    const [p] = (await s.admin.get('/api/v1/reschedule-proposals')).body;
    const stale = await s.admin.post(
      `/api/v1/reschedule-proposals/${p.id}/approve`,
      { version: p.version + 1 },
      { 'idempotency-key': idemKey() },
    );
    expect(stale.status).toBe(409);
    const [a, b] = await Promise.all([
      s.admin.post(
        `/api/v1/reschedule-proposals/${p.id}/approve`,
        { alternativeId: 'AGUARDAR' },
        { 'idempotency-key': idemKey() },
      ),
      s.admin.post(
        `/api/v1/reschedule-proposals/${p.id}/reject`,
        { note: 'Outra decisão' },
        { 'idempotency-key': idemKey() },
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(await db().planningAction.count({ where: { proposalId: p.id, automatic: false } })).toBe(
      1,
    );
  });

  it('24. idempotência e pedidos duplicados', async () => {
    const s = await scenario({ arrive: ['Ricardo'] });
    const key = idemKey();
    const a = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'MOVIMENTAR' }, key);
    const b = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'MOVIMENTAR' }, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await db().helpRequest.count()).toBe(1);
    // Outro toque (nova chave) com pedido aberto: recusado, sem duplicar.
    const dup = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(dup.status).toBe(409);
    // "Preciso de ajuda agora" sobre o pedido na fila: o mesmo pedido vira urgente.
    const urgent = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'MOVIMENTAR',
      urgent: true,
      justification: 'Ficou urgente',
    });
    expect(urgent.status).toBe(201);
    expect(urgent.body).toMatchObject({ id: a.body.id, urgent: true });
    expect(await db().helpRequest.count()).toBe(1);
  });

  it('25. sincronização em tempo real (painel e tablets) e 26. reconexão recupera os avisos', async () => {
    const s = await scenario();
    const wAdmin = track(await WsClient.connect(app, s.admin));
    const wJoao = track(await WsClient.connect(app, s.tablets.João!));
    const wThiago = track(await WsClient.connect(app, s.tablets.Thiago!));
    const r = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    await wAdmin.waitFor((m) => m.kind === 'event' && m.event.type === 'help.assigned');
    await wJoao.waitFor((m) => m.kind === 'event' && m.event.type === 'notification.created');
    await wJoao.waitFor((m) => m.kind === 'event' && m.event.type === 'help.assigned');
    // O Thiago não recebe o pedido nem o aviso do João.
    expect(wThiago.events('help.assigned')).toHaveLength(0);
    // Reconexão: o João cai, o pedido é cancelado e ao voltar recebe o que perdeu.
    const lastSeq = wJoao.events().at(-1)!.seq as string;
    await wJoao.close();
    await s.tablets.Ricardo!.post(
      `/api/v1/help-requests/${r.body.id}/cancel`,
      {},
      { 'idempotency-key': idemKey() },
    );
    const back = track(await WsClient.connect(app, s.tablets.João!, String(lastSeq)));
    await back.waitFor((m) => m.kind === 'replay.done');
    expect(back.events('help.cancelled')).toHaveLength(1);
    expect(
      back
        .events('notification.created')
        .some((e: { payload: { kind: string } }) => e.payload.kind === 'AJUDA_CANCELADA'),
    ).toBe(true);
  });
});

describe('Relógio de teste', () => {
  it('27. presença independente do horário real; impossível fora de teste', async () => {
    // A validação de ambiente recusa o relógio fora de APP_ENV=test.
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      TOKEN_HASH_SECRET: 'x'.repeat(40),
      ENABLE_TEST_CLOCK: 'true',
    };
    expect(() => loadEnv({ ...base, APP_ENV: 'development' })).toThrow(/ENABLE_TEST_CLOCK/);
    expect(() =>
      loadEnv({
        ...base,
        APP_ENV: 'production',
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        ALLOWED_ORIGINS: 'https://gestao.exemplo.com.br',
      }),
    ).toThrow(/ENABLE_TEST_CLOCK/);
    expect(loadEnv({ ...base, APP_ENV: 'test' }).ENABLE_TEST_CLOCK).toBe(true);

    const clockApp = await createTestApp({ ENABLE_TEST_CLOCK: 'true' });
    try {
      setAttendanceClock();
      const admin = await loginAdmin(clockApp);
      const ricardo = await tabletOf(clockApp, admin, 'Ricardo', '482915');
      // Só o gestor controla o relógio de teste.
      expect((await ricardo.post('/api/test/clock', { now: null })).status).toBe(403);
      const set = (hhmm: string) =>
        admin.post('/api/test/clock', { now: zonedDateTime(today(), hhmm, TZ).toISOString() });
      expect((await set('08:30')).body.controlled).toBe(true);
      const arrived = await ricardo.post(
        '/api/v1/attendance/me/arrive',
        {},
        { 'idempotency-key': idemKey() },
      );
      expect(arrived.body.day).toMatchObject({ arrivalKind: 'NO_HORARIO', lateMinutes: 0 });
      await set('09:31');
      const check = await admin.post('/api/test/attendance/check', {});
      expect(check.status).toBe(200);
      expect(check.body.flagged).toBe(3); // Márcio, Thiago e João; Ricardo chegou
      expect((await admin.post('/api/test/clock', { now: null })).body.controlled).toBe(false);
    } finally {
      setAttendanceClock();
      await clockApp.close();
    }
  });
});
