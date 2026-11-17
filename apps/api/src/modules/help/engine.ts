import { plural } from '@cenario/shared';
import {
  CANDIDATE_REASONS,
  EVENT_TYPES,
  SPECIALTY_SKILLS,
  anyPermissionAudience,
  scoreCandidate,
  taskCode,
  type CandidateEvaluation,
  type CandidateReason,
  type NotificationKind,
  type Skill,
} from '@cenario/shared';
import { loadUserPermissions } from '../../core/permissions';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { attendanceConfig, clock, dbDate, leaveOn, team } from '../attendance/common';
import { notify } from '../notifications/notify';

/**
 * Fase 8 — avaliação da equipe para reprogramações e transferências (os pedidos de ajuda saíram
 * do sistema). Regras determinísticas e auditáveis (sem IA).
 */
export const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
export const HELP_AUDIENCE = anyPermissionAudience('producao.ver', 'producao.planejar');
export const helpAudience = (...users: (string | null | undefined)[]) =>
  [HELP_AUDIENCE, ...[...new Set(users.filter(Boolean))].map((u) => `user:${u}`)].join(
    '|',
  ) as typeof HELP_AUDIENCE;

/**
 * Simplificação Fase 7: avisos acionáveis de ajuda e reprogramação vão só a quem pode decidir
 * (`producao.planejar`: atribuir ajudante, aprovar/recusar propostas) — nunca a quem só gerencia
 * a presença. Funções personalizadas seguem a mesma regra (permissão efetiva do usuário).
 */
export async function planners(db: Tx | PrismaClient) {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true } });
  const out: string[] = [];
  for (const u of users) {
    if ((await loadUserPermissions(db, u.id)).has('producao.planejar')) out.push(u.id);
  }
  return out;
}

export async function notifyPlanners(
  tx: Tx,
  actor: ActorContext,
  kind: NotificationKind,
  dedupeKey: string,
  body: string,
  taskId: string | null = null,
) {
  await notify(
    tx,
    actor,
    (await planners(tx)).map((userId) => ({
      userId,
      kind,
      dedupeKey: `${dedupeKey}:${userId}`,
      body,
      taskId,
      includeActor: true,
    })),
  );
}

/** Espera (min) a partir da qual o gestor é avisado de risco de atraso. */
export const WAIT_ALERT_MINUTES = { urgent: 5, normal: 20 };

export const PRIORITY_RANK: Record<string, number> = { BAIXA: 0, NORMAL: 1, ALTA: 2, URGENTE: 3 };
export const isImportant = (priority: string) =>
  (PRIORITY_RANK[priority] ?? 1) >= PRIORITY_RANK.ALTA!;

/** Histórico de alterações do planejamento (automáticas ou aprovadas): quem, quando e por quê. */
export async function planningAction(
  tx: Tx,
  actor: ActorContext,
  entry: {
    kind: string;
    automatic: boolean;
    reason: string;
    taskId?: string | null;
    proposalId?: string | null;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.planningAction.create({
    data: {
      kind: entry.kind,
      automatic: entry.automatic,
      reason: entry.reason.slice(0, 500),
      taskId: entry.taskId ?? null,
      proposalId: entry.proposalId ?? null,
      before: (entry.before as Prisma.InputJsonValue | undefined) ?? undefined,
      after: (entry.after as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
      createdAt: clock(),
    },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.PLANNING_ACTION_RECORDED,
    aggregateType: 'planning_action',
    aggregateId: entry.taskId ?? entry.proposalId ?? 'planejamento',
    payload: { kind: entry.kind, automatic: entry.automatic },
    audience: HELP_AUDIENCE,
  });
}

export async function skillsByEmployee(db: Tx | PrismaClient) {
  const rows = await db.employeeSkill.findMany();
  const map = new Map<string, Set<Skill>>();
  for (const r of rows) {
    if (!map.has(r.employeeId)) map.set(r.employeeId, new Set());
    map.get(r.employeeId)!.add(r.skill as Skill);
  }
  return map;
}

/**
 * Avalia cada possível ajudante (equipe da presença, exceto quem pede) verificando:
 * competência, presença confirmada, trabalho externo/encerramento, tarefa em execução
 * (crítica ou não), outro apoio em andamento, tarefas prioritárias na janela do apoio,
 * tarefas urgentes liberadas aguardando, pausas e especialidade preservada.
 * Nunca considera ausente, indisponível ou sem competência como elegível.
 */
export async function evaluateCandidates(
  tx: Tx,
  req: { requesterUserId: string; skill: Skill; estimatedMinutes: number },
  now = clock(),
): Promise<{
  candidates: CandidateEvaluation[];
  interruptible: { userId: string; taskId: string }[];
}> {
  const cfg = await attendanceConfig(tx, now);
  const skills = await skillsByEmployee(tx);
  // Janela de tarefas: horário real (as tarefas são programadas no relógio do servidor).
  const taskNow = new Date();
  const windowEnd = new Date(taskNow.getTime() + req.estimatedMinutes * 60_000);
  const out: CandidateEvaluation[] = [];
  const interruptible: { userId: string; taskId: string }[] = [];
  for (const e of await team(tx)) {
    if (e.userId === req.requesterUserId) continue;
    const reasons: CandidateReason[] = [];
    const notes: string[] = [];
    const mine = skills.get(e.id) ?? new Set<Skill>();
    if (!mine.has(req.skill)) reasons.push('SEM_COMPETENCIA');
    const day = await tx.operationalAttendance.findUnique({
      where: { employeeId_date: { employeeId: e.id, date: dbDate(cfg.today) } },
    });
    if (!cfg.workingDay && !day?.arrivedAt) reasons.push('AUSENTE');
    else if (!day?.arrivedAt) {
      // Simplificação Fase 7: folga/férias planejada (sem registro do dia) = ausente.
      const leave = day ? null : await leaveOn(tx, e.id, cfg.today);
      reasons.push(
        day?.situation === 'TRABALHO_EXTERNO'
          ? 'EXTERNO'
          : day || leave
            ? 'AUSENTE'
            : 'NAO_CONFIRMOU',
      );
    } else if (day.situation === 'ENCERRADO') reasons.push('ENCERRADO');
    else if (day.situation === 'TRABALHO_EXTERNO') reasons.push('EXTERNO');
    const own = await tx.productionTask.findMany({
      where: {
        assigneeUserId: e.userId,
        status: { in: ['EM_EXECUCAO', 'PAUSADA', 'LIBERADA', 'PROGRAMADA'] },
      },
      orderBy: { number: 'asc' },
    });
    const running = own.find((t) => t.status === 'EM_EXECUCAO');
    if (running) {
      const critical = isImportant(running.priority) || Boolean(running.supportForTaskId);
      reasons.push(critical ? 'OCUPADO_CRITICO' : 'OCUPADO');
      notes.push(`Executando ${taskCode(running.number)} · ${running.title}`);
      if (!critical && reasons.length === 1)
        interruptible.push({ userId: e.userId, taskId: running.id });
    }
    const inWindow = own.filter(
      (t) =>
        (t.status === 'PROGRAMADA' || t.status === 'LIBERADA') &&
        t.scheduledAt &&
        t.scheduledAt >= taskNow &&
        t.scheduledAt <= windowEnd,
    );
    const released = own.filter((t) => t.status === 'LIBERADA' && !t.supportForTaskId);
    const urgentWaiting = released.filter((t) => t.priority === 'URGENTE');
    if (inWindow.some((t) => isImportant(t.priority)) || urgentWaiting.length) {
      if (!reasons.includes('CONFLITO_AGENDA')) reasons.push('CONFLITO_AGENDA');
      notes.push(
        urgentWaiting.length
          ? `Tarefa urgente aguardando: ${taskCode(urgentWaiting[0]!.number)}`
          : 'Tarefa prioritária programada durante o apoio',
      );
    }
    const paused = own.filter((t) => t.status === 'PAUSADA').length;
    const specialty = SPECIALTY_SKILLS.some((s) => mine.has(s));
    out.push({
      userId: e.userId,
      name: e.displayName,
      eligible: reasons.length === 0,
      reasons,
      score: scoreCandidate({
        specialty,
        tasksInWindow: inWindow.length,
        releasedWaiting: released.length,
        paused,
      }),
      notes: [
        ...notes,
        ...(specialty ? ['Especialidade preservada (cabeceiras/reparos/inspeção)'] : []),
        ...(released.length
          ? [`${plural(released.length, 'tarefa liberada', 'tarefas liberadas')} aguardando`]
          : []),
        ...(paused ? [`${plural(paused, 'tarefa pausada', 'tarefas pausadas')}`] : []),
      ],
    });
  }
  return { candidates: out, interruptible };
}

export const reasonText = (c: CandidateEvaluation) =>
  c.reasons.map((r) => CANDIDATE_REASONS[r]).join(', ');
