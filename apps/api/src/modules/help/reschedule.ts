import {
  EVENT_TYPES,
  PRINCIPAL_ACTIVITIES,
  compareTasks,
  helpRequestCode,
  localParts,
  pickCandidate,
  proposalCode,
  taskCode,
  zonedDateTime,
  type ProductionActivity,
  type ProposalAction,
  type ProposalAlternative,
  type Skill,
} from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { attendanceConfig, brDate, clock, dbDate, notifyManagers } from '../attendance/common';
import { dateOnly } from '../commercial/common';
import { notify, taskNotice } from '../notifications/notify';
import {
  domainTaskEvent,
  lockTasks,
  onTaskBlocked,
  reevaluateTasks,
  taskEvent,
} from '../production/common';
import { assertWorker, reviseIfPublishedBy } from '../production/plans';
import {
  HELP_AUDIENCE,
  SYSTEM,
  assignTo,
  evaluateCandidates,
  helpDomainEvent,
  helpEvent,
  isImportant,
  planningAction,
  type HelpRow,
} from './engine';

const WAITING = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'] as const;

/** Competência necessária para assumir uma etapa de outra pessoa. */
export const ACTIVITY_SKILL: Record<ProductionActivity, Skill> = {
  DESMONTAGEM: 'DESMONTAGEM',
  PREPARACAO: 'PREPARACAO',
  PREPARACAO_MDF: 'PREPARACAO',
  CORTE_ESPUMA: 'PREPARACAO',
  APOIO: 'APOIO_GERAL',
  OUTRA: 'APOIO_GERAL',
  CORTE_TECIDO: 'CORTE_COSTURA',
  CORTE: 'CORTE_COSTURA',
  COSTURA: 'CORTE_COSTURA',
  REVESTIMENTO: 'CORTE_COSTURA',
  MONTAGEM: 'CORTE_COSTURA',
  ACABAMENTO: 'CORTE_COSTURA',
};

/** Próximo dia útil (ISO) depois de `date`. */
export function nextWorkingDay(date: string, workingDays: number[]) {
  const d = new Date(`${date}T12:00:00Z`);
  for (let i = 0; i < 14; i += 1) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (workingDays.includes(d.getUTCDay())) return d.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────── Mudanças de tarefa (com histórico) ───────────────────────────

type TaskChange = {
  assigneeUserId?: string;
  scheduledAt?: Date;
};

/**
 * Aplica uma mudança numa tarefa que ainda não começou, com histórico na tarefa, revisão
 * da programação publicada, reavaliação da liberação e avisos. Usada pelas mudanças
 * automáticas simples e pelas aprovadas pelo gestor. O andamento nunca é tocado.
 */
export async function changeTask(
  tx: Tx,
  actor: ActorContext,
  taskId: string,
  change: TaskChange,
  reason: string,
  notice: 'REPROGRAMACAO_AUTOMATICA' | 'REPROGRAMACAO_APROVADA',
) {
  await lockTasks(tx, [taskId]);
  const t = await tx.productionTask.findUniqueOrThrow({ where: { id: taskId } });
  if (!(WAITING as readonly string[]).includes(t.status)) {
    throw Errors.business(
      `${taskCode(t.number)} já começou ou foi encerrada: a proposta precisa ser reavaliada.`,
    );
  }
  if (change.assigneeUserId) await assertWorker(tx, change.assigneeUserId);
  const updated = await tx.productionTask.update({
    where: { id: taskId },
    data: { ...change, version: { increment: 1 } },
  });
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (t.assigneeUserId !== updated.assigneeUserId)
    changes.assigneeUserId = { from: t.assigneeUserId, to: updated.assigneeUserId };
  if (t.scheduledAt?.toISOString() !== updated.scheduledAt?.toISOString())
    changes.scheduledAt = {
      from: t.scheduledAt?.toISOString() ?? null,
      to: updated.scheduledAt?.toISOString() ?? null,
    };
  await taskEvent(tx, actor, null, t, {
    kind: changes.assigneeUserId ? 'RESPONSAVEL_ALTERADO' : 'REPROGRAMADA',
    note: reason.slice(0, 500),
    changes,
  });
  await reviseIfPublishedBy(tx, actor, t.planId, reason, `alteração de ${taskCode(t.number)}`);
  await reevaluateTasks(tx, actor, [taskId]);
  const after = await tx.productionTask.findUniqueOrThrow({ where: { id: taskId } });
  await domainTaskEvent(
    tx,
    actor,
    changes.assigneeUserId
      ? EVENT_TYPES.PRODUCTION_TASK_ASSIGNED
      : EVENT_TYPES.PRODUCTION_DEPENDENCIES_UPDATED,
    after,
    { changed: Object.keys(changes) },
    [t.assigneeUserId],
  );
  const cfg = await attendanceConfig(tx);
  const when = after.scheduledAt ? localParts(after.scheduledAt, cfg.timezone) : null;
  const what = changes.assigneeUserId
    ? 'agora é sua'
    : `nova programação: ${when ? `${brDate(when.date)} às ${when.time}` : 'sem horário'}`;
  await notify(tx, actor, [
    ...taskNotice(after, notice, `${what}. ${reason}`).map((n) => ({ ...n, includeActor: true })),
    ...(changes.assigneeUserId && t.assigneeUserId
      ? taskNotice(t, 'TAREFA_REMOVIDA', 'passou para outro responsável.', t.assigneeUserId).map(
          (n) => ({ ...n, includeActor: true }),
        )
      : []),
  ]);
  return { before: t, after, changes };
}

// ─────────────────────────── Tarefa bloqueada ───────────────────────────

/**
 * Quando uma tarefa de quem está presente fica bloqueada (ou é pausada por impedimento):
 * indica outra tarefa já liberada ou antecipa a próxima tarefa pronta do mesmo
 * funcionário (mudança simples: mesmo responsável, sem bloqueio técnico, materiais e
 * dependências ok, programada para hoje — antecipar não compromete prazo nem passa à
 * frente de prioridade maior). Nunca inicia nada sozinho e não mexe no andamento.
 */
export async function suggestAlternative(
  tx: Tx,
  actor: ActorContext,
  blocked: {
    id: string;
    number: number;
    title: string;
    version: number;
    assigneeUserId: string | null;
  },
) {
  if (!blocked.assigneeUserId) return null;
  const cfg = await attendanceConfig(tx);
  const employee = await tx.employee.findUnique({ where: { userId: blocked.assigneeUserId } });
  if (!employee) return null;
  const day = await tx.operationalAttendance.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: dbDate(cfg.today) } },
  });
  if (!day?.arrivedAt || day.situation !== 'PRESENTE') return null;
  const mine = await tx.productionTask.findMany({
    where: {
      assigneeUserId: blocked.assigneeUserId,
      id: { not: blocked.id },
      status: { in: ['EM_EXECUCAO', 'LIBERADA', 'PROGRAMADA'] },
    },
  });
  if (mine.some((t) => t.status === 'EM_EXECUCAO')) return null;
  const sorted = (list: typeof mine) =>
    list
      .map((t) => ({ t, scheduledAt: t.scheduledAt?.toISOString() ?? null }))
      .sort((a, b) =>
        compareTasks(
          { ...a.t, scheduledAt: a.scheduledAt },
          { ...b.t, scheduledAt: b.scheduledAt },
        ),
      )
      .map((x) => x.t);
  const dedupeKey = `ALTERNATIVA:${blocked.id}:${blocked.version}`;
  const released = sorted(mine.filter((t) => t.status === 'LIBERADA'))[0];
  if (released) {
    await planningAction(tx, SYSTEM, {
      kind: 'ALTERNATIVA_SUGERIDA',
      automatic: true,
      reason: `${taskCode(blocked.number)} bloqueada; ${taskCode(released.number)} já está liberada para ${employee.displayName}.`,
      taskId: released.id,
    });
    await notify(tx, actor, [
      {
        userId: blocked.assigneeUserId,
        kind: 'TAREFA_ALTERNATIVA_LIBERADA',
        dedupeKey,
        body: `${taskCode(blocked.number)} · ${blocked.title} está bloqueada. Você pode seguir com ${taskCode(released.number)} · ${released.title}.`,
        taskId: released.id,
        includeActor: true,
      },
    ]);
    return released;
  }
  const endOfDay = zonedDateTime(cfg.today, '23:59', cfg.timezone);
  const next = sorted(
    mine.filter(
      (t) =>
        t.status === 'PROGRAMADA' &&
        t.blockers.length === 0 &&
        !t.blockedReason &&
        t.scheduledAt &&
        t.scheduledAt <= endOfDay,
    ),
  )[0];
  if (!next) return null;
  const now = new Date();
  const reason = `Automático: ${taskCode(blocked.number)} ficou bloqueada; ${taskCode(next.number)} antecipada para agora (mesmo funcionário, sem bloqueios, prazo preservado).`;
  const r = await changeTask(
    tx,
    SYSTEM,
    next.id,
    { scheduledAt: now },
    reason,
    'REPROGRAMACAO_AUTOMATICA',
  );
  await planningAction(tx, SYSTEM, {
    kind: 'TAREFA_ANTECIPADA',
    automatic: true,
    reason,
    taskId: next.id,
    before: { scheduledAt: r.before.scheduledAt?.toISOString() ?? null },
    after: { scheduledAt: now.toISOString() },
  });
  await notify(tx, SYSTEM, [
    {
      userId: blocked.assigneeUserId,
      kind: 'TAREFA_ALTERNATIVA_LIBERADA',
      dedupeKey,
      body: `${taskCode(blocked.number)} está bloqueada. ${taskCode(next.number)} · ${next.title} foi liberada para você começar quando quiser.`,
      taskId: next.id,
    },
  ]);
  return r.after;
}

onTaskBlocked(async (tx, actor, blocked) => {
  await suggestAlternative(tx, actor, blocked);
});

// ─────────────────────────── Propostas ───────────────────────────

export async function createProposal(
  tx: Tx,
  actor: ActorContext,
  p: {
    kind: string;
    critical: boolean;
    situation: string;
    problem: string;
    affectedTaskIds: string[];
    alternatives: ProposalAlternative[];
    proposedAlternativeId: string;
    dedupeKey: string;
    attendanceId?: string | null;
    helpRequestId?: string | null;
    issueId?: string | null;
  },
) {
  const created = await tx.rescheduleProposal.createMany({
    data: [
      {
        kind: p.kind,
        critical: p.critical,
        situation: p.situation.slice(0, 500),
        problem: p.problem.slice(0, 500),
        affectedTaskIds: [...new Set(p.affectedTaskIds)],
        alternatives: p.alternatives as unknown as Prisma.InputJsonValue,
        proposedAlternativeId: p.proposedAlternativeId,
        dedupeKey: p.dedupeKey,
        attendanceId: p.attendanceId ?? null,
        helpRequestId: p.helpRequestId ?? null,
        issueId: p.issueId ?? null,
        createdAt: clock(),
      },
    ],
    skipDuplicates: true,
  });
  if (!created.count) return null; // já existe proposta para este fato
  const proposal = await tx.rescheduleProposal.findUniqueOrThrow({
    where: { dedupeKey: p.dedupeKey },
  });
  const code = proposalCode(proposal.number);
  await planningAction(tx, actor, {
    kind: 'PROPOSTA_CRIADA',
    automatic: true,
    reason: `${code}: ${p.problem}`,
    proposalId: proposal.id,
    helpRequestId: p.helpRequestId ?? null,
  });
  await audit(tx, actor, {
    action: 'reschedule.proposed',
    entityType: 'reschedule_proposal',
    entityId: proposal.id,
    summary: `${code} aguardando decisão do gestor: ${p.problem}`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.RESCHEDULE_PROPOSED,
    aggregateType: 'reschedule_proposal',
    aggregateId: proposal.id,
    payload: { id: proposal.id, code, kind: p.kind, critical: p.critical },
    audience: HELP_AUDIENCE,
  });
  await notifyManagers(
    tx,
    actor,
    'REPROGRAMACAO_PENDENTE',
    `PROPOSTA:${proposal.id}`,
    `${code} — ${p.problem} Escolha uma alternativa em Reprogramação.`,
  );
  return proposal;
}

/** Ajuda urgente sem ninguém livre: propõe ao gestor interromper uma tarefa não crítica. */
export async function proposeUrgentInterruption(
  tx: Tx,
  actor: ActorContext,
  req: HelpRow,
  interruptible: { userId: string; taskId: string }[],
  evaluation: unknown,
  /** Fase 9: pedido normal esperando além do limite → proposta de CONFLITO (risco de atraso). */
  mode: 'URGENTE' | 'ATRASO' = 'URGENTE',
) {
  const late = mode === 'ATRASO';
  const tasks = await tx.productionTask.findMany({
    where: { id: { in: interruptible.map((i) => i.taskId) } },
    include: { assignee: { select: { displayName: true } } },
  });
  const requester = await tx.user.findUniqueOrThrow({ where: { id: req.requesterUserId } });
  const sorted = tasks.sort((a, b) =>
    (a.assignee?.displayName ?? '').localeCompare(b.assignee?.displayName ?? '', 'pt-BR'),
  );
  const alternatives: ProposalAlternative[] = [
    ...sorted.map((t, i) => ({
      id: `INTERROMPER_${i + 1}`,
      title: `Pausar ${taskCode(t.number)} de ${t.assignee?.displayName} para ajudar ${requester.displayName}`,
      actions: [
        {
          type: 'INTERRUPT_FOR_HELP' as const,
          taskId: t.id,
          toUserId: t.assigneeUserId,
          helpRequestId: req.id,
        },
      ],
      impacts: [
        `${taskCode(t.number)} · ${t.title} (${t.assignee?.displayName}) é pausada como "interrupção programada" durante o apoio (${req.estimatedMinutes} min); o andamento é preservado.`,
      ],
      critical: true,
      recommended: i === 0,
    })),
    {
      id: 'AGUARDAR',
      title: 'Manter na fila até alguém ficar livre',
      actions: [],
      impacts: [
        `${requester.displayName} continua aguardando ajuda${late ? ' — a tarefa pode atrasar' : ''}.`,
      ],
      critical: false,
      recommended: false,
    },
  ];
  const waited = Math.floor((clock().getTime() - req.createdAt.getTime()) / 60_000);
  const proposal = await createProposal(tx, actor, {
    kind: late ? 'CONFLITO' : 'AJUDA_URGENTE',
    critical: true,
    situation: late
      ? `${requester.displayName} aguarda ajudante há ${waited} min (${helpRequestCode(req.number)}).`
      : `${requester.displayName} pediu ajuda urgente (${helpRequestCode(req.number)}): ${req.justification ?? ''}`,
    problem: late
      ? `Falta de ajudante com risco de atraso para ${requester.displayName}; atender exige interromper uma tarefa em andamento.`
      : `Nenhum ajudante livre para a ajuda urgente de ${requester.displayName}; atender exige interromper uma tarefa em andamento.`,
    affectedTaskIds: [req.taskId, ...sorted.map((t) => t.id)],
    alternatives,
    proposedAlternativeId: alternatives[0]!.id,
    dedupeKey: late ? `CONFLITO_AJUDA:${req.id}` : `AJUDA_URGENTE:${req.id}`,
    helpRequestId: req.id,
  });
  if (late) {
    // O pedido continua na fila: se alguém ficar livre antes, é atribuído e a proposta perde o efeito.
    await helpEvent(tx, actor, req, {
      kind: 'CONFLITO_PROPOSTO',
      note: `Espera além do limite: ${proposal ? proposalCode(proposal.number) : 'proposta'} enviada ao gestor (nada foi interrompido).`,
      evaluation,
    });
    await planningAction(tx, actor, {
      kind: 'PROPOSTA_CRIADA',
      automatic: true,
      reason: `${helpRequestCode(req.number)} com risco de atraso: proposta de conflito ao gestor.`,
      helpRequestId: req.id,
      proposalId: proposal?.id ?? null,
    });
    return req;
  }
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: { status: 'ESCALADA', escalatedAt: clock(), version: { increment: 1 } },
  });
  await helpEvent(tx, actor, req, {
    kind: 'ESCALADA',
    from: req.status,
    to: 'ESCALADA',
    note: 'Urgente sem ajudante livre: encaminhada ao gestor (nada foi interrompido).',
    evaluation,
  });
  await planningAction(tx, actor, {
    kind: 'AJUDA_ESCALADA',
    automatic: true,
    reason: `${helpRequestCode(req.number)} urgente encaminhada ao gestor${proposal ? ` (${proposalCode(proposal.number)})` : ''}.`,
    helpRequestId: req.id,
    proposalId: proposal?.id ?? null,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_ESCALATED, u);
  await notify(tx, actor, [
    {
      userId: req.requesterUserId,
      kind: 'AJUDA_EM_ESPERA',
      dedupeKey: `AJUDA_ESCALADA:${req.id}`,
      body: `Ninguém está livre agora. Seu pedido urgente ${helpRequestCode(req.number)} foi encaminhado ao gestor para decidir.`,
      taskId: req.taskId,
      includeActor: true,
    },
  ]);
  return u;
}

/** Candidatos (presentes, livres e capacitados) para assumir uma etapa. */
async function candidatesFor(tx: Tx, excludeUserId: string, skill: Skill, minutes = 60) {
  return evaluateCandidates(tx, {
    requesterUserId: excludeUserId,
    skill,
    estimatedMinutes: minutes,
  });
}

/**
 * Análise de ausência (integração com a Fase 7). Presumida: só propõe — nenhuma tarefa é
 * transferida. Confirmada: executa apenas as mudanças simples (tarefa de apoio, prioridade
 * até normal, sem prazo hoje, sem bloqueio técnico, para alguém presente, livre e
 * capacitado) e propõe o restante ao gestor. Uma proposta por pessoa e situação.
 */
export async function analyzeAbsence(
  tx: Tx,
  actor: ActorContext,
  attendanceId: string,
  mode: 'PRESUMIDA' | 'CONFIRMADA',
) {
  const att = await tx.operationalAttendance.findUniqueOrThrow({
    where: { id: attendanceId },
    include: { employee: true },
  });
  const cfg = await attendanceConfig(tx);
  const settings = await tx.companySettings.findUnique({ where: { id: 1 } });
  const userId = att.employee.userId;
  const name = att.employee.displayName;
  const endOfDay = zonedDateTime(cfg.today, '23:59', cfg.timezone);
  const own = await tx.productionTask.findMany({
    where: {
      assigneeUserId: userId,
      status: { in: [...WAITING] },
      OR: [{ scheduledAt: { lte: endOfDay } }, { scheduledAt: null }],
    },
    include: { serviceOrder: { select: { promisedDate: true } } },
    orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }],
  });
  if (!own.length) return null;
  const isPrincipal = (t: (typeof own)[number]) =>
    t.role === 'PRINCIPAL' || PRINCIPAL_ACTIVITIES.includes(t.activity);
  const remaining: typeof own = [];
  // 1) Mudanças simples automáticas (somente ausência confirmada).
  for (const t of own) {
    const simple =
      mode === 'CONFIRMADA' &&
      !isPrincipal(t) &&
      !isImportant(t.priority) &&
      (!t.dueDate || dateOnly(t.dueDate)! > cfg.today) &&
      !t.blockedReason &&
      t.blockers.every((b) => b === 'DEPENDENCIAS' || b === 'HORARIO');
    if (!simple) {
      remaining.push(t);
      continue;
    }
    const { candidates } = await candidatesFor(tx, userId, ACTIVITY_SKILL[t.activity]);
    const best = pickCandidate(candidates);
    if (!best) {
      remaining.push(t);
      continue;
    }
    const reason = `Automático: ausência confirmada de ${name}; ${taskCode(t.number)} (prioridade ${t.priority.toLowerCase()}, sem prazo hoje) passa para ${best.name}, presente, livre e capacitado.`;
    await changeTask(
      tx,
      SYSTEM,
      t.id,
      { assigneeUserId: best.userId },
      reason,
      'REPROGRAMACAO_AUTOMATICA',
    );
    await planningAction(tx, SYSTEM, {
      kind: 'TAREFA_REATRIBUIDA',
      automatic: true,
      reason,
      taskId: t.id,
      before: { assigneeUserId: userId },
      after: { assigneeUserId: best.userId },
    });
  }
  if (!remaining.length) return null;

  // 2) Alternativas para o restante (decisão do gestor).
  const impacts = await tx.attendanceImpact.findMany({
    where: { attendanceId, kind: 'DEPENDENTE_AFETADA' },
    select: { taskId: true },
  });
  const tomorrow = nextWorkingDay(cfg.today, settings?.workingDays ?? [1, 2, 3, 4, 5]);
  const support = remaining.filter((t) => !isPrincipal(t));
  const principal = remaining.filter(isPrincipal);
  const alternatives: ProposalAlternative[] = [];
  const reassign: ProposalAction[] = [];
  const reassignImpacts: string[] = [];
  for (const t of support) {
    const { candidates } = await candidatesFor(tx, userId, ACTIVITY_SKILL[t.activity]);
    const best = pickCandidate(candidates);
    if (best) {
      reassign.push({ type: 'REASSIGN', taskId: t.id, toUserId: best.userId });
      reassignImpacts.push(`${taskCode(t.number)} · ${t.title} → ${best.name}`);
    }
  }
  if (reassign.length) {
    alternatives.push({
      id: 'REDISTRIBUIR',
      title: `Redistribuir ${reassign.length} tarefa(s) para quem está presente e capacitado`,
      actions: reassign,
      impacts: [
        ...reassignImpacts,
        ...(principal.length
          ? [`${principal.length} tarefa(s) do tapeceiro principal continuam aguardando.`]
          : []),
      ],
      critical: support.some((t) => isImportant(t.priority)),
      recommended: mode === 'CONFIRMADA',
    });
  }
  if (principal.length) {
    // Outro tapeceiro presente (mesmo ocupado: a troca é decisão do gestor).
    const tapeceiros = (await candidatesFor(tx, userId, 'CORTE_COSTURA', 30)).candidates.filter(
      (c) => c.reasons.every((r) => r === 'OCUPADO' || r === 'CONFLITO_AGENDA'),
    );
    const other = tapeceiros.sort(
      (a, b) => a.score - b.score || a.name.localeCompare(b.name, 'pt-BR'),
    )[0];
    if (other) {
      alternatives.push({
        id: 'TROCAR_PRINCIPAL',
        title: `Trocar o tapeceiro principal para ${other.name}`,
        actions: principal.map((t) => ({
          type: 'CHANGE_PRINCIPAL' as const,
          taskId: t.id,
          toUserId: other.userId,
        })),
        impacts: [
          `${principal.length} tarefa(s) de tapeceiro passam para ${other.name}, que já tem a própria programação.`,
          'Troca de tapeceiro principal: decisão crítica.',
        ],
        critical: true,
        recommended: false,
      });
    }
  }
  const late = remaining.filter((t) => t.dueDate && dateOnly(t.dueDate)! < tomorrow);
  const promised = remaining.filter(
    (t) => t.serviceOrder.promisedDate && dateOnly(t.serviceOrder.promisedDate)! <= tomorrow,
  );
  alternatives.push({
    id: 'ADIAR',
    title: `Reprogramar para ${brDate(tomorrow)} às ${cfg.workdayStart}`,
    actions: remaining.map((t) => ({
      type: 'RESCHEDULE' as const,
      taskId: t.id,
      toDate: tomorrow,
      toTime: cfg.workdayStart,
    })),
    impacts: [
      `${remaining.length} tarefa(s) de ${name} vão para ${brDate(tomorrow)}.`,
      ...(late.length
        ? [`Prazo interno comprometido: ${late.map((t) => taskCode(t.number)).join(', ')}.`]
        : []),
      ...(promised.length ? ['Afeta OS com entrega prometida ao cliente até esse dia.'] : []),
      ...(impacts.length ? [`${impacts.length} tarefa(s) dependente(s) também atrasam.`] : []),
    ],
    critical: late.length > 0 || promised.length > 0,
    recommended: mode === 'CONFIRMADA' && !reassign.length,
  });
  alternatives.push({
    id: 'AGUARDAR',
    title: mode === 'PRESUMIDA' ? 'Aguardar a chegada (nada muda agora)' : 'Manter como está',
    actions: [],
    impacts: [
      `${remaining.length} tarefa(s) seguem com ${name}; dependentes continuam aguardando.`,
    ],
    critical: false,
    recommended: mode === 'PRESUMIDA',
  });
  const recommended =
    alternatives.find((a) => a.recommended) ?? alternatives[alternatives.length - 1]!;
  return createProposal(tx, actor, {
    kind: 'AUSENCIA',
    critical:
      principal.length > 0 ||
      late.length > 0 ||
      promised.length > 0 ||
      remaining.some((t) => isImportant(t.priority)),
    situation: `${name}: ausência ${mode === 'PRESUMIDA' ? 'presumida (sem confirmação de chegada)' : 'confirmada pelo gestor'} em ${brDate(cfg.today)}.`,
    problem: `${remaining.length} tarefa(s) de ${name} e ${impacts.length} dependente(s) afetada(s) hoje.`,
    affectedTaskIds: [...remaining.map((t) => t.id), ...impacts.map((i) => i.taskId)],
    alternatives,
    proposedAlternativeId: recommended.id,
    dedupeKey: `AUSENCIA:${attendanceId}:${mode}`,
    attendanceId,
  });
}

/** Chegada (ou nova análise) torna sem efeito as propostas pendentes de uma ausência. */
export async function obsoleteProposals(
  tx: Tx,
  actor: ActorContext,
  where: Prisma.RescheduleProposalWhereInput,
  reason: string,
) {
  const list = await tx.rescheduleProposal.findMany({ where: { ...where, status: 'PENDENTE' } });
  for (const p of list) {
    await tx.rescheduleProposal.update({
      where: { id: p.id },
      data: {
        status: 'OBSOLETA',
        decisionNote: reason.slice(0, 500),
        decidedAt: clock(),
        version: { increment: 1 },
      },
    });
    await planningAction(tx, actor, {
      kind: 'PROPOSTA_OBSOLETA',
      automatic: true,
      reason: `${proposalCode(p.number)}: ${reason}`,
      proposalId: p.id,
    });
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.RESCHEDULE_DECIDED,
      aggregateType: 'reschedule_proposal',
      aggregateId: p.id,
      payload: { id: p.id, status: 'OBSOLETA' },
      audience: HELP_AUDIENCE,
    });
  }
  return list.length;
}

// ─────────────────────────── Decisão do gestor ───────────────────────────

async function applyAction(tx: Tx, actor: ActorContext, a: ProposalAction, reason: string) {
  switch (a.type) {
    case 'KEEP':
      return { action: a, result: 'mantida' };
    case 'REASSIGN': {
      const t = await tx.productionTask.findUniqueOrThrow({ where: { id: a.taskId } });
      if (PRINCIPAL_ACTIVITIES.includes(t.activity)) {
        throw Errors.business(
          `${taskCode(t.number)} é etapa do tapeceiro principal: use a troca de principal.`,
        );
      }
      if (!a.toUserId) throw Errors.business('Escolha o novo responsável.');
      const r = await changeTask(
        tx,
        actor,
        a.taskId,
        { assigneeUserId: a.toUserId },
        reason,
        'REPROGRAMACAO_APROVADA',
      );
      return { action: a, result: r.changes };
    }
    case 'RESCHEDULE': {
      const cfg = await attendanceConfig(tx);
      if (!a.toDate) throw Errors.business('Escolha a nova data.');
      const at = zonedDateTime(a.toDate, a.toTime ?? cfg.workdayStart, cfg.timezone);
      const r = await changeTask(
        tx,
        actor,
        a.taskId,
        { scheduledAt: at },
        reason,
        'REPROGRAMACAO_APROVADA',
      );
      return { action: a, result: r.changes };
    }
    case 'CHANGE_PRINCIPAL': {
      if (!a.toUserId) throw Errors.business('Escolha o novo tapeceiro principal.');
      const t = await tx.productionTask.findUniqueOrThrow({ where: { id: a.taskId } });
      if (t.planId && t.assigneeUserId) {
        await tx.productionPlanItem.updateMany({
          where: {
            planId: t.planId,
            serviceOrderId: t.serviceOrderId,
            principalUserId: t.assigneeUserId,
          },
          data: { principalUserId: a.toUserId },
        });
      }
      const r = await changeTask(
        tx,
        actor,
        a.taskId,
        { assigneeUserId: a.toUserId },
        reason,
        'REPROGRAMACAO_APROVADA',
      );
      return { action: a, result: r.changes };
    }
    case 'INTERRUPT_FOR_HELP': {
      await lockTasks(tx, [a.taskId]);
      const t = await tx.productionTask.findUniqueOrThrow({ where: { id: a.taskId } });
      if (t.status !== 'EM_EXECUCAO' || t.assigneeUserId !== a.toUserId) {
        throw Errors.business(
          'A tarefa a interromper já não está em execução: a proposta precisa ser reavaliada.',
        );
      }
      const paused = await tx.productionTask.update({
        where: { id: t.id },
        data: {
          status: 'PAUSADA',
          pauseReason: 'INTERRUPCAO_PROGRAMADA',
          pauseNote: 'Interrompida para apoio urgente (aprovado pelo gestor)',
          version: { increment: 1 },
        },
      });
      await taskEvent(tx, actor, null, t, {
        kind: 'PAUSADA',
        from: 'EM_EXECUCAO',
        to: 'PAUSADA',
        note: reason.slice(0, 500),
        changes: { reason: 'INTERRUPCAO_PROGRAMADA', impediment: false },
      });
      await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PAUSED, paused, {
        reason: 'INTERRUPCAO_PROGRAMADA',
      });
      const req = await tx.helpRequest.findUniqueOrThrow({ where: { id: a.helpRequestId! } });
      if (req.status !== 'ESCALADA' && req.status !== 'PENDENTE') {
        throw Errors.business('O pedido de ajuda já foi resolvido ou cancelado.');
      }
      const helper = await tx.user.findUniqueOrThrow({ where: { id: t.assigneeUserId! } });
      await assignTo(
        tx,
        actor,
        req,
        helper.id,
        helper.displayName,
        clock(),
        null,
        `Aprovado pelo gestor: ${taskCode(t.number)} pausada para o apoio.`,
        false,
      );
      return { action: a, result: 'interrompida e apoio atribuído' };
    }
  }
}

/** Devolve à fila um pedido escalado (gestor rejeitou ou escolheu aguardar). */
async function backToQueue(tx: Tx, actor: ActorContext, helpRequestId: string, note: string) {
  const req = await tx.helpRequest.findUniqueOrThrow({ where: { id: helpRequestId } });
  if (req.status !== 'ESCALADA') return null;
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: { status: 'PENDENTE', version: { increment: 1 } },
  });
  await helpEvent(tx, actor, req, {
    kind: 'DEVOLVIDA_A_FILA',
    from: 'ESCALADA',
    to: 'PENDENTE',
    note,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_QUEUED, u);
  return u;
}

export async function decideProposal(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    decision: 'APROVAR' | 'REJEITAR';
    alternativeId?: string;
    overrides?: {
      taskId: string;
      toUserId?: string | null;
      toDate?: string | null;
      toTime?: string | null;
    }[];
    note?: string | null;
    version?: number;
  },
) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM reschedule_proposals WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Proposta');
  const p = await tx.rescheduleProposal.findUniqueOrThrow({ where: { id } });
  if (input.version !== undefined && p.version !== input.version)
    throw Errors.versionConflict(p.version);
  if (p.status !== 'PENDENTE') throw Errors.business('Esta proposta já foi decidida.');
  const code = proposalCode(p.number);
  const now = clock();
  if (input.decision === 'REJEITAR') {
    await tx.rescheduleProposal.update({
      where: { id },
      data: {
        status: 'REJEITADA',
        decidedById: actor.userId,
        decidedAt: now,
        decisionNote: input.note ?? null,
        version: { increment: 1 },
      },
    });
    await planningAction(tx, actor, {
      kind: 'PROPOSTA_REJEITADA',
      automatic: false,
      reason: `${code} rejeitada${input.note ? `: ${input.note}` : ''}.`,
      proposalId: id,
      helpRequestId: p.helpRequestId,
    });
    if (p.helpRequestId) {
      const back = await backToQueue(
        tx,
        actor,
        p.helpRequestId,
        input.note ?? 'Gestor manteve na fila.',
      );
      if (back) {
        await notify(tx, actor, [
          {
            userId: back.requesterUserId,
            kind: 'REPROGRAMACAO_REJEITADA',
            dedupeKey: `REJEITADA:${id}`,
            body: `O gestor não autorizou interromper outra tarefa (${code}). Seu pedido ${helpRequestCode(back.number)} segue na fila${input.note ? `: ${input.note}` : '.'}`,
            taskId: back.taskId,
          },
        ]);
      }
    }
  } else {
    const alts = p.alternatives as unknown as ProposalAlternative[];
    const alt = alts.find((a) => a.id === (input.alternativeId ?? p.proposedAlternativeId));
    if (!alt) throw Errors.business('Alternativa inexistente.');
    const overrides = new Map((input.overrides ?? []).map((o) => [o.taskId, o]));
    for (const taskId of overrides.keys()) {
      if (!alt.actions.some((a) => a.taskId === taskId))
        throw Errors.business('O ajuste só pode alterar tarefas da alternativa escolhida.');
    }
    const actions = alt.actions.map((a) => {
      const o = overrides.get(a.taskId);
      return o
        ? {
            ...a,
            toUserId: o.toUserId ?? a.toUserId,
            toDate: o.toDate ?? a.toDate,
            toTime: o.toTime ?? a.toTime,
          }
        : a;
    });
    const adjusted = alt.id !== p.proposedAlternativeId || overrides.size > 0;
    const reason = `${code} aprovada pelo gestor (${alt.title})${input.note ? `: ${input.note}` : ''}`;
    const applied = [];
    for (const a of actions) applied.push(await applyAction(tx, actor, a, reason));
    if (p.helpRequestId && alt.actions.length === 0) {
      await backToQueue(tx, actor, p.helpRequestId, reason);
    }
    await tx.rescheduleProposal.update({
      where: { id },
      data: {
        status: adjusted ? 'AJUSTADA' : 'APROVADA',
        chosenAlternativeId: alt.id,
        appliedActions: applied as unknown as Prisma.InputJsonValue,
        decidedById: actor.userId,
        decidedAt: now,
        decisionNote: input.note ?? null,
        version: { increment: 1 },
      },
    });
    await planningAction(tx, actor, {
      kind: 'PROPOSTA_APROVADA',
      automatic: false,
      reason,
      proposalId: id,
      helpRequestId: p.helpRequestId,
      after: { alternative: alt.id, actions },
    });
  }
  await audit(tx, actor, {
    action: `reschedule.${input.decision === 'APROVAR' ? 'approved' : 'rejected'}`,
    entityType: 'reschedule_proposal',
    entityId: id,
    summary: `${code} ${input.decision === 'APROVAR' ? 'aprovada' : 'rejeitada'}${input.note ? `: ${input.note}` : ''}.`,
  });
  const after = await tx.rescheduleProposal.findUniqueOrThrow({ where: { id } });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.RESCHEDULE_DECIDED,
    aggregateType: 'reschedule_proposal',
    aggregateId: id,
    payload: { id, status: after.status },
    audience: HELP_AUDIENCE,
  });
  return after;
}
