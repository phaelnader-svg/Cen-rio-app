import {
  CANDIDATE_REASONS,
  EVENT_TYPES,
  HELP_KIND_LABEL,
  SPECIALTY_SKILLS,
  anyPermissionAudience,
  helpRequestCode,
  scoreCandidate,
  taskCode,
  type CandidateEvaluation,
  type CandidateReason,
  type EventType,
  type HelpKind,
  type Skill,
} from '@cenario/shared';
import { now as clockNow } from '../../core/clock';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { attendanceConfig, clock, dbDate, team } from '../attendance/common';
import { notify } from '../notifications/notify';
import { domainTaskEvent, taskEvent } from '../production/common';
import { reviseIfPublishedBy } from '../production/plans';

/**
 * Fase 8 — motor de distribuição de ajudantes. Regras determinísticas e auditáveis
 * (sem IA): cada tentativa grava os candidatos avaliados, os motivos de exclusão e a
 * pontuação usada na escolha.
 */
export const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
export const HELP_AUDIENCE = anyPermissionAudience('producao.ver', 'producao.planejar');
export const helpAudience = (...users: (string | null | undefined)[]) =>
  [HELP_AUDIENCE, ...[...new Set(users.filter(Boolean))].map((u) => `user:${u}`)].join(
    '|',
  ) as typeof HELP_AUDIENCE;

/** Espera (min) a partir da qual o gestor é avisado de risco de atraso. */
export const WAIT_ALERT_MINUTES = { urgent: 5, normal: 20 };

export const PRIORITY_RANK: Record<string, number> = { BAIXA: 0, NORMAL: 1, ALTA: 2, URGENTE: 3 };
export const isImportant = (priority: string) =>
  (PRIORITY_RANK[priority] ?? 1) >= PRIORITY_RANK.ALTA!;

export type HelpRow = Prisma.HelpRequestGetPayload<object>;

export async function helpEvent(
  tx: Tx,
  actor: ActorContext,
  req: { id: string },
  entry: {
    kind: string;
    from?: string | null;
    to?: string | null;
    note?: string | null;
    evaluation?: unknown;
  },
) {
  await tx.helpRequestEvent.create({
    data: {
      helpRequestId: req.id,
      kind: entry.kind,
      fromStatus: entry.from ?? null,
      toStatus: entry.to ?? null,
      note: entry.note?.slice(0, 500) ?? null,
      evaluation: (entry.evaluation as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
      createdAt: clock(),
    },
  });
}

export async function helpDomainEvent(tx: Tx, actor: ActorContext, type: EventType, req: HelpRow) {
  await appendEvent(tx, actor, {
    type,
    aggregateType: 'help_request',
    aggregateId: req.id,
    payload: {
      id: req.id,
      code: helpRequestCode(req.number),
      status: req.status,
      taskId: req.taskId,
      supportTaskId: req.supportTaskId,
      urgent: req.urgent,
    },
    audience: helpAudience(req.requesterUserId, req.helperUserId),
  });
}

/** Histórico de alterações do planejamento (automáticas ou aprovadas): quem, quando e por quê. */
export async function planningAction(
  tx: Tx,
  actor: ActorContext,
  entry: {
    kind: string;
    automatic: boolean;
    reason: string;
    taskId?: string | null;
    helpRequestId?: string | null;
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
      helpRequestId: entry.helpRequestId ?? null,
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
    aggregateId: entry.taskId ?? entry.helpRequestId ?? entry.proposalId ?? 'planejamento',
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
      reasons.push(
        day?.situation === 'TRABALHO_EXTERNO' ? 'EXTERNO' : day ? 'AUSENTE' : 'NAO_CONFIRMOU',
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
    const helping = await tx.helpRequest.count({
      where: { helperUserId: e.userId, status: { in: ['ATRIBUIDA', 'EM_EXECUCAO'] } },
    });
    if (running) {
      const critical = isImportant(running.priority) || Boolean(running.supportForTaskId);
      reasons.push(critical ? 'OCUPADO_CRITICO' : 'OCUPADO');
      notes.push(`Executando ${taskCode(running.number)} · ${running.title}`);
      if (!critical && !helping && reasons.length === 1)
        interruptible.push({ userId: e.userId, taskId: running.id });
    } else if (helping) {
      reasons.push('OCUPADO');
      notes.push('Já atribuído a outro apoio');
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
        ...(released.length ? [`${released.length} tarefa(s) liberada(s) aguardando`] : []),
        ...(paused ? [`${paused} tarefa(s) pausada(s)`] : []),
      ],
    });
  }
  return { candidates: out, interruptible };
}

export const reasonText = (c: CandidateEvaluation) =>
  c.reasons.map((r) => CANDIDATE_REASONS[r]).join(', ');

/**
 * Cria a tarefa de apoio (separada da tarefa principal, sem dependência entre elas) já
 * liberada para o ajudante e marca a solicitação como atribuída. Nada inicia sozinho:
 * o ajudante inicia e conclui o apoio no próprio tablet.
 */
export async function assignTo(
  tx: Tx,
  actor: ActorContext,
  req: HelpRow,
  helperUserId: string,
  helperName: string,
  now: Date,
  evaluation: unknown,
  note: string,
  automatic: boolean,
) {
  const task = await tx.productionTask.findUniqueOrThrow({ where: { id: req.taskId } });
  const requester = await tx.user.findUniqueOrThrow({ where: { id: req.requesterUserId } });
  const cfg = await attendanceConfig(tx, now);
  const kind = HELP_KIND_LABEL[req.kind as HelpKind];
  const support = await tx.productionTask.create({
    data: {
      planId: task.planId,
      serviceOrderId: task.serviceOrderId,
      serviceOrderItemId: task.serviceOrderItemId,
      activity: 'APOIO',
      title: `Apoio: ${kind} — ${task.title}`.slice(0, 120),
      role: 'APOIO',
      assigneeUserId: helperUserId,
      priority: req.urgent ? 'URGENTE' : task.priority,
      sequence: task.sequence,
      // Horário real: a tarefa pode ser iniciada imediatamente.
      scheduledAt: clockNow(),
      dueDate: dbDate(cfg.today),
      instructions: [
        `Apoio para ${requester.displayName} em ${taskCode(task.number)} (${helpRequestCode(req.number)}).`,
        req.note,
      ]
        .filter(Boolean)
        .join(' '),
      requiresMaterials: false,
      estimatedMinutes: req.estimatedMinutes,
      supportForTaskId: task.id,
      status: 'LIBERADA',
    },
  });
  await taskEvent(tx, actor, null, support, {
    kind: 'LIBERADA',
    to: 'LIBERADA',
    note: `Apoio a ${taskCode(task.number)} solicitado por ${requester.displayName} (${helpRequestCode(req.number)})`,
  });
  await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_ASSIGNED, support, {}, [
    req.requesterUserId,
  ]);
  // Fase 9: a tarefa de apoio entra na programação publicada como nova revisão (uma só fonte).
  await reviseIfPublishedBy(
    tx,
    actor,
    task.planId,
    `Apoio ${helpRequestCode(req.number)} de ${helperName} para ${requester.displayName} (${req.estimatedMinutes} min). Impacto: ${helperName} fica ocupado durante o apoio; ${taskCode(task.number)} segue com ${requester.displayName}.`,
    `nova tarefa de apoio ${taskCode(support.number)}`,
  );
  const updated = await tx.helpRequest.update({
    where: { id: req.id },
    data: {
      status: 'ATRIBUIDA',
      helperUserId,
      supportTaskId: support.id,
      assignedAt: now,
      version: { increment: 1 },
    },
  });
  await helpEvent(tx, actor, req, {
    kind: 'ATRIBUIDA',
    from: req.status,
    to: 'ATRIBUIDA',
    note,
    evaluation,
  });
  await planningAction(tx, actor, {
    kind: 'AJUDA_ATRIBUIDA',
    automatic,
    reason: `${helpRequestCode(req.number)}: ${note}`,
    taskId: support.id,
    helpRequestId: req.id,
    after: { helperUserId, supportTaskId: support.id },
  });
  await audit(tx, actor, {
    action: 'help.assigned',
    entityType: 'help_request',
    entityId: req.id,
    summary: `${helpRequestCode(req.number)}: apoio atribuído a ${helperName}. ${note}`,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_ASSIGNED, updated);
  await notify(tx, actor, [
    {
      userId: helperUserId,
      kind: 'AJUDA_ATRIBUIDA',
      dedupeKey: `AJUDA_ATRIBUIDA:${req.id}:${helperUserId}`,
      body: `${requester.displayName} precisa de ajuda${req.urgent ? ' agora' : ''}: ${kind} (${req.estimatedMinutes} min) — ${task.title}.`,
      taskId: support.id,
      serviceOrderId: task.serviceOrderId,
      includeActor: true,
    },
    {
      userId: req.requesterUserId,
      kind: 'AJUDA_ATRIBUIDA',
      dedupeKey: `AJUDA_ATRIBUIDA:${req.id}:${req.requesterUserId}`,
      body: `${helperName} vai ajudar: ${kind} (${helpRequestCode(req.number)}).`,
      taskId: task.id,
      serviceOrderId: task.serviceOrderId,
      includeActor: true,
    },
  ]);
  return updated;
}
