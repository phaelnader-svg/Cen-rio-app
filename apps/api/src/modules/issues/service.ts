import {
  EVENT_TYPES,
  ISSUE_IMPACT_LABEL,
  ISSUE_KIND_LABEL,
  MATERIAL_UNIT_LABEL,
  blocksTaskFor,
  canTransition,
  initialIssuePriority,
  issueCode,
  q3,
  taskCode,
  type IssueImpact,
  type IssueKind,
  type IssueStatus,
  type OpenIssueInput,
  type ProposalAlternative,
  type Skill,
} from '@cenario/shared';
import { immediateAt } from '../../core/clock';
import { Prisma, type PrismaClient, type Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { attendanceConfig, clock, dbDate, team } from '../attendance/common';
import { SYSTEM, planningAction, skillsByEmployee } from '../help/engine';
import { createProposal, nextWorkingDay, obsoleteProposals } from '../help/reschedule';
import { notify, taskNotice } from '../notifications/notify';
import {
  domainTaskEvent,
  emitTaskBlocked,
  hasBlockingIssue,
  lockTasks,
  onTaskBlocked,
  reevaluateTasks,
  taskEvent,
} from '../production/common';
import { assertWorker, reviseIfPublishedBy } from '../production/plans';
import { onReadinessChanged, readinessOf } from '../purchasing/common';
import {
  OPEN_STATUSES,
  impactOf,
  isImportantPriority,
  issueDomainEvent,
  issueEvent,
  lockIssue,
  notifyIssueManagers,
  type IssueRow,
} from './common';

const WAITING = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];
const DONE = ['CONCLUIDA', 'CANCELADA', 'RASCUNHO'];
const br = (iso: string) => iso.split('-').reverse().join('/');

function assertTransition(issue: IssueRow, to: IssueStatus) {
  if (!canTransition(issue.status, to))
    throw Errors.business(
      `Ocorrência ${issueCode(issue.number)} está "${issue.status.toLowerCase().replaceAll('_', ' ')}": esta ação não se aplica.`,
    );
}

function checkVersion(issue: IssueRow, version?: number) {
  if (version !== undefined && issue.version !== version)
    throw Errors.versionConflict(issue.version);
}

// ─────────────────────────── Bloqueio da tarefa ───────────────────────────

/**
 * Bloqueio total ou "faz outra atividade": a tarefa em execução é pausada (andamento
 * preservado, marcada como impedimento); a que aguardava início é reavaliada e fica bloqueada
 * pela ocorrência. Só a etapa impedida é afetada — nunca a OS inteira.
 */
async function applyBlock(tx: Tx, actor: ActorContext, issue: IssueRow, deviceId: string | null) {
  if (!issue.blocksTask) return;
  await lockTasks(tx, [issue.taskId]);
  const t = await tx.productionTask.findUniqueOrThrow({ where: { id: issue.taskId } });
  if (t.status === 'EM_EXECUCAO') {
    const note = `Ocorrência ${issueCode(issue.number)}: ${issue.description}`.slice(0, 300);
    const u = await tx.productionTask.update({
      where: { id: t.id },
      data: {
        status: 'PAUSADA',
        pauseReason: 'OUTRO',
        pauseNote: note,
        pauseImpediment: true,
        version: { increment: 1 },
      },
    });
    await taskEvent(tx, actor, deviceId, t, {
      kind: 'PAUSADA',
      from: 'EM_EXECUCAO',
      to: 'PAUSADA',
      note,
      changes: { reason: 'OUTRO', impediment: true, issueId: issue.id },
    });
    await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PAUSED, u, {
      reason: 'OUTRO',
      impediment: true,
    });
    await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_IMPEDIMENT, u, {
      issueId: issue.id,
      note,
    });
    // Mesma regra da Fase 8: indicar/antecipar outra tarefa do mesmo funcionário.
    await emitTaskBlocked(tx, actor, u);
  } else if (WAITING.includes(t.status)) {
    await reevaluateTasks(tx, actor, [t.id]);
  }
}

/** Depois da resolução/cancelamento: reavalia a tarefa e avisa quem a executa. */
async function releaseBlock(tx: Tx, actor: ActorContext, issue: IssueRow, why: string) {
  if (!issue.blocksTask) return;
  const stillBlocked = await tx.productionIssue.count({
    where: {
      taskId: issue.taskId,
      blocksTask: true,
      status: { in: OPEN_STATUSES },
      id: { not: issue.id },
    },
  });
  await reevaluateTasks(tx, actor, [issue.taskId]);
  const t = await tx.productionTask.findUniqueOrThrow({ where: { id: issue.taskId } });
  if (stillBlocked || DONE.includes(t.status)) return;
  if (t.status === 'PAUSADA') {
    // Nunca retoma sozinha: o funcionário retoma no tablet.
    await notify(tx, actor, [
      {
        ...taskNotice(t, 'TAREFA_DESBLOQUEADA', `${why} Você pode retomar quando quiser.`)[0]!,
        dedupeKey: `DESBLOQUEADA:${issue.id}:${issue.reopenCount}`,
        includeActor: true,
      },
    ]);
  } else if (t.status === 'BLOQUEADA') {
    await notify(tx, actor, [
      {
        ...taskNotice(
          t,
          'TAREFA_DESBLOQUEADA',
          `${why} A tarefa ainda aguarda: ${t.blockers.join(', ').toLowerCase()}.`,
        )[0]!,
        dedupeKey: `DESBLOQUEADA:${issue.id}:${issue.reopenCount}`,
        includeActor: true,
      },
    ]);
  }
  // LIBERADA: o motor de liberação já avisou "Tarefa liberada".
}

// ─────────────────────────── Proposta de bloqueio ───────────────────────────

/**
 * Impedimento relevante (prazo em risco, dependentes de outras pessoas ou tarefa importante):
 * proposta BLOQUEIO ao gestor — aguardar a solução ou reprogramar a tarefa e as dependentes.
 * Uma por ocorrência (e por reabertura); perde o efeito quando a ocorrência é encerrada.
 */
export async function proposeBlock(tx: Tx, actor: ActorContext, issue: IssueRow) {
  if (!issue.blocksTask || !(OPEN_STATUSES as string[]).includes(issue.status)) return null;
  const impact = await impactOf(tx, issue.taskId);
  const task = await tx.productionTask.findUniqueOrThrow({ where: { id: issue.taskId } });
  const relevant =
    impact.deadlineRisk || impact.people.length > 0 || isImportantPriority(task.priority);
  if (!relevant) return null;
  const cfg = await attendanceConfig(tx);
  const settings = await tx.companySettings.findUnique({ where: { id: 1 } });
  const nextDay = nextWorkingDay(cfg.today, settings?.workingDays ?? [1, 2, 3, 4, 5]);
  const code = issueCode(issue.number);
  const waitingDeps = impact.dependents.filter((d) => WAITING.includes(d.status));
  const alternatives: ProposalAlternative[] = [
    {
      id: 'AGUARDAR',
      title: `Aguardar a solução de ${code}`,
      actions: [],
      impacts: [
        `${impact.task.code} segue parada até a resolução confirmada.`,
        ...(impact.people.length
          ? [`Dependentes de ${impact.people.join(', ')} continuam aguardando.`]
          : []),
        ...impact.reasons,
      ],
      critical: impact.deadlineRisk,
      recommended: !impact.deadlineRisk,
    },
  ];
  const reschedule = [
    ...(WAITING.includes(task.status) ? [{ id: task.id, code: impact.task.code }] : []),
    ...waitingDeps.map((d) => ({ id: d.id, code: d.code })),
  ];
  if (reschedule.length) {
    alternatives.push({
      id: 'ADIAR',
      title: `Reprogramar ${reschedule.length} tarefa(s) para ${br(nextDay)} às ${cfg.workdayStart}`,
      actions: reschedule.map((r) => ({
        type: 'RESCHEDULE' as const,
        taskId: r.id,
        toDate: nextDay,
        toTime: cfg.workdayStart,
      })),
      impacts: [
        `${reschedule.map((r) => r.code).join(', ')} vão para ${br(nextDay)}.`,
        ...(impact.deadlineRisk
          ? ['Prazo interno ou entrega ao cliente pode ser comprometido.']
          : []),
      ],
      critical: true,
      recommended: impact.deadlineRisk,
    });
  }
  const recommended = alternatives.find((a) => a.recommended) ?? alternatives[0]!;
  return createProposal(tx, actor, {
    kind: 'BLOQUEIO',
    critical: impact.deadlineRisk || isImportantPriority(task.priority),
    situation:
      `${ISSUE_KIND_LABEL[issue.kind as IssueKind]} em ${impact.task.code} · ${impact.task.title} (${code}): ${issue.description}`.slice(
        0,
        500,
      ),
    problem: `${impact.task.code} está impedida${impact.dependents.length ? ` e ${impact.dependents.length} tarefa(s) dependem dela` : ''}${impact.deadlineRisk ? ' — prazo em risco' : ''}.`,
    affectedTaskIds: [issue.taskId, ...impact.dependents.map((d) => d.id)],
    alternatives,
    proposedAlternativeId: recommended.id,
    dedupeKey: `BLOQUEIO:${issue.id}:${issue.reopenCount}`,
    issueId: issue.id,
  });
}

/**
 * Tarefa bloqueada sem ocorrência (gestor, materiais) com prazo em risco e sem alternativa
 * para o funcionário: proposta BLOQUEIO para o gestor decidir (uma por tarefa e versão).
 */
onTaskBlocked(async (tx, actor, blocked) => {
  // A ocorrência já trata (proposta própria).
  if (blocked.blockers.includes('OCORRENCIA') || (await hasBlockingIssue(tx, blocked.id))) return;
  const impact = await impactOf(tx, blocked.id);
  if (!impact.deadlineRisk) return;
  const pending = await tx.rescheduleProposal.count({
    where: { kind: 'BLOQUEIO', status: 'PENDENTE', affectedTaskIds: { has: blocked.id } },
  });
  if (pending) return;
  const cfg = await attendanceConfig(tx);
  const settings = await tx.companySettings.findUnique({ where: { id: 1 } });
  const nextDay = nextWorkingDay(cfg.today, settings?.workingDays ?? [1, 2, 3, 4, 5]);
  const waitingDeps = impact.dependents.filter((d) => WAITING.includes(d.status));
  await createProposal(tx, actor, {
    kind: 'BLOQUEIO',
    critical: true,
    situation: `${impact.task.code} · ${impact.task.title} ficou bloqueada (${blocked.blockers.join(', ').toLowerCase()}).`,
    problem: `Tarefa bloqueada com prazo em risco: ${impact.reasons.join(' ')}`.slice(0, 500),
    affectedTaskIds: [blocked.id, ...impact.dependents.map((d) => d.id)],
    alternatives: [
      {
        id: 'AGUARDAR',
        title: 'Aguardar o desbloqueio',
        actions: [],
        impacts: impact.reasons,
        critical: true,
        recommended: false,
      },
      {
        id: 'ADIAR',
        title: `Reprogramar para ${br(nextDay)} às ${cfg.workdayStart}`,
        actions: [blocked.id, ...waitingDeps.map((d) => d.id)].map((taskId) => ({
          type: 'RESCHEDULE' as const,
          taskId,
          toDate: nextDay,
          toTime: cfg.workdayStart,
        })),
        impacts: [
          `${impact.task.code} e ${waitingDeps.length} dependente(s) vão para ${br(nextDay)}.`,
        ],
        critical: true,
        recommended: true,
      },
    ],
    proposedAlternativeId: 'ADIAR',
    dedupeKey: `BLOQUEIO_TAREFA:${blocked.id}:${blocked.version}`,
  });
});

/** Propostas BLOQUEIO que perderam o sentido (ocorrência encerrada ou tarefa liberada). */
export async function revalidateBlockProposals(tx: Tx, actor: ActorContext) {
  const pending = await tx.rescheduleProposal.findMany({
    where: { kind: 'BLOQUEIO', status: 'PENDENTE' },
  });
  for (const p of pending) {
    if (p.issueId) {
      const issue = await tx.productionIssue.findUnique({ where: { id: p.issueId } });
      if (issue && !(OPEN_STATUSES as string[]).includes(issue.status))
        await obsoleteProposals(tx, actor, { id: p.id }, `${issueCode(issue.number)} encerrada.`);
      continue;
    }
    const taskId = p.affectedTaskIds[0];
    const t = taskId ? await tx.productionTask.findUnique({ where: { id: taskId } }) : null;
    if (!t || t.status !== 'BLOQUEADA')
      await obsoleteProposals(tx, actor, { id: p.id }, 'A tarefa não está mais bloqueada.');
  }
}

// ─────────────────────────── Abertura ───────────────────────────

export async function openIssue(
  tx: Tx,
  actor: ActorContext,
  deviceId: string | null,
  userId: string,
  input: OpenIssueInput & { impact?: IssueImpact },
) {
  await lockTasks(tx, [input.taskId]);
  const task = await tx.productionTask.findUnique({
    where: { id: input.taskId },
    include: { serviceOrder: { select: { status: true } } },
  });
  if (!task) throw Errors.notFound('Tarefa');
  if (task.assigneeUserId !== userId)
    throw Errors.forbidden('Só é possível registrar problemas nas próprias tarefas.');
  if (DONE.includes(task.status)) throw Errors.business('Esta tarefa já foi encerrada.');
  if (task.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
  const kind = input.kind as IssueKind;
  const impact: IssueImpact =
    kind === 'OUTRO' ? (input.canContinue ? 'DIFICULDADE' : 'IMPEDIDO') : input.impact!;
  // Material: da OS (necessidade aprovada), do estoque ou descrito.
  let material: {
    requirementId: string | null;
    stockItemId: string | null;
    description: string;
    quantity: number;
    unit: string;
  } | null = null;
  if (kind === 'MATERIAL' && input.material) {
    const m = input.material;
    let description = m.description ?? '';
    if (m.requirementId) {
      const req = await tx.materialRequirement.findUnique({ where: { id: m.requirementId } });
      if (!req || req.serviceOrderId !== task.serviceOrderId)
        throw Errors.business('O material escolhido não pertence a esta OS.');
      description = description || req.description;
    }
    if (m.stockItemId) {
      const item = await tx.stockItem.findUnique({ where: { id: m.stockItemId } });
      if (!item?.active) throw Errors.business('Material de estoque inexistente ou inativo.');
      description = description || item.description;
    }
    material = {
      requirementId: m.requirementId ?? null,
      stockItemId: m.stockItemId ?? null,
      description: description.slice(0, 200),
      quantity: q3(m.quantity),
      unit: m.unit,
    };
  }
  const description =
    input.description ??
    (material
      ? `Falta de ${material.description}: ${material.quantity} ${MATERIAL_UNIT_LABEL[material.unit as keyof typeof MATERIAL_UNIT_LABEL].toLowerCase()}`
      : '');
  // Sem duplicar: mesma tarefa, mesmo tipo (e mesmo material) ainda aberta.
  const dup = await tx.productionIssue.findFirst({
    where: {
      taskId: task.id,
      kind,
      status: { in: OPEN_STATUSES },
      ...(material?.requirementId ? { materialRequirementId: material.requirementId } : {}),
      ...(kind !== 'MATERIAL' ? { reporterUserId: userId } : {}),
    },
  });
  if (
    dup &&
    (kind !== 'MATERIAL' ||
      material?.requirementId ||
      dup.materialDescription === material?.description)
  )
    throw Errors.conflict(
      `Já existe uma ocorrência aberta para esta tarefa (${issueCode(dup.number)}).`,
      { issueId: dup.id },
    );
  const issue = await tx.productionIssue.create({
    data: {
      kind,
      impact,
      blocksTask: blocksTaskFor(impact),
      priority: initialIssuePriority(impact, task.priority),
      description,
      taskId: task.id,
      serviceOrderId: task.serviceOrderId,
      reporterUserId: userId,
      reporterDeviceId: deviceId,
      materialRequirementId: material?.requirementId ?? null,
      stockItemId: material?.stockItemId ?? null,
      materialDescription: material?.description ?? null,
      materialQuantity: material ? new Prisma.Decimal(material.quantity) : null,
      materialUnit: (material?.unit as never) ?? null,
      createdAt: clock(),
    },
  });
  const code = issueCode(issue.number);
  const impactData = await impactOf(tx, task.id);
  await issueEvent(tx, actor, issue, {
    kind: 'ABERTA',
    to: 'ABERTA',
    note: `${ISSUE_KIND_LABEL[kind]} — ${ISSUE_IMPACT_LABEL[impact]}: ${description}`,
    data: {
      taskStatus: task.status,
      affected: impactData.dependents.map((d) => d.code),
      deadlineRisk: impactData.reasons,
    },
    deviceId,
  });
  await audit(tx, actor, {
    action: 'issue.opened',
    entityType: 'production_issue',
    entityId: issue.id,
    summary: `${code}: ${ISSUE_KIND_LABEL[kind]} em ${taskCode(task.number)} (${ISSUE_IMPACT_LABEL[impact].toLowerCase()}).`,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_OPENED, issue);
  await applyBlock(tx, actor, issue, deviceId);
  if (!issue.blocksTask && impactData.deadlineRisk) {
    await issueEvent(tx, actor, issue, {
      kind: 'RISCO',
      note: `Continua com dificuldade, mas há risco de prazo: ${impactData.reasons.join(' ')}`,
    });
  }
  const reporter = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  await notifyIssueManagers(
    tx,
    actor,
    'OCORRENCIA_ABERTA',
    `OCORRENCIA_ABERTA:${issue.id}`,
    `${code} — ${reporter.displayName}: ${ISSUE_KIND_LABEL[kind]} em ${taskCode(task.number)} · ${task.title} (${ISSUE_IMPACT_LABEL[impact].toLowerCase()}). ${description}`,
    issue,
  );
  await proposeBlock(tx, actor, issue);
  return issue;
}

// ─────────────────────────── Delegação ───────────────────────────

const ABSENT = [
  'AUSENCIA_PRESUMIDA',
  'AUSENCIA_CONFIRMADA',
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
];

/**
 * Valida quem vai resolver: precisa executar tarefas, ter a competência exigida (quando
 * houver) e estar na oficina. Conflitos de agenda exigem confirmação explícita do gestor.
 */
export async function checkSolver(
  tx: Tx,
  userId: string,
  requiredSkill: Skill | null | undefined,
): Promise<{ name: string; conflicts: string[] }> {
  const w = await assertWorker(tx, userId, 'Responsável pela solução');
  const perms = await loadUserPermissions(tx, userId);
  const isManager = perms.has('ocorrencias.gerenciar');
  const conflicts: string[] = [];
  const members = await team(tx);
  const employee = members.find((e) => e.userId === userId);
  if (employee && !isManager) {
    if (requiredSkill) {
      const skills = (await skillsByEmployee(tx)).get(employee.id);
      if (!skills?.has(requiredSkill))
        throw Errors.business(`${w.displayName} não tem a competência exigida para esta solução.`);
    }
    const cfg = await attendanceConfig(tx);
    const day = await tx.operationalAttendance.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: dbDate(cfg.today) } },
    });
    if (
      day &&
      !day.arrivedAt &&
      (ABSENT.includes(day.situation) || day.situation === 'TRABALHO_EXTERNO')
    )
      throw Errors.business(`${w.displayName} não está na oficina hoje.`);
    if (day?.situation === 'ENCERRADO')
      throw Errors.business(`${w.displayName} já encerrou o expediente.`);
    if (day?.situation === 'TRABALHO_EXTERNO')
      throw Errors.business(`${w.displayName} está em atividade externa.`);
    if (!day?.arrivedAt) conflicts.push(`${w.displayName} ainda não confirmou chegada hoje.`);
  }
  const running = await tx.productionTask.findFirst({
    where: { assigneeUserId: userId, status: 'EM_EXECUCAO' },
  });
  if (running)
    conflicts.push(
      `${w.displayName} está executando ${taskCode(running.number)} · ${running.title}${isImportantPriority(running.priority) ? ' (prioridade alta)' : ''}.`,
    );
  const now = new Date();
  const soon = await tx.productionTask.findFirst({
    where: {
      assigneeUserId: userId,
      status: { in: ['LIBERADA', 'PROGRAMADA'] },
      priority: { in: ['ALTA', 'URGENTE'] },
      scheduledAt: { gte: now, lte: new Date(now.getTime() + 2 * 3_600_000) },
    },
  });
  if (soon)
    conflicts.push(
      `${w.displayName} tem ${taskCode(soon.number)} (prioritária) programada para as próximas 2 h.`,
    );
  return { name: w.displayName, conflicts };
}

async function cancelActionTask(tx: Tx, actor: ActorContext, issue: IssueRow, reason: string) {
  if (!issue.actionTaskId) return;
  await lockTasks(tx, [issue.actionTaskId]);
  const t = await tx.productionTask.findUniqueOrThrow({ where: { id: issue.actionTaskId } });
  if (DONE.includes(t.status)) return;
  const u = await tx.productionTask.update({
    where: { id: t.id },
    data: {
      status: 'CANCELADA',
      cancelReason: reason,
      pauseImpediment: false,
      version: { increment: 1 },
    },
  });
  await taskEvent(tx, actor, null, t, {
    kind: 'CANCELADA',
    from: t.status,
    to: 'CANCELADA',
    note: reason,
  });
  await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, u);
  await notify(tx, actor, taskNotice(u, 'TAREFA_CANCELADA', reason));
}

export async function assignIssue(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    assigneeUserId: string;
    instructions: string;
    dueAt?: string | null;
    priority?: 'BAIXA' | 'NORMAL' | 'ALTA' | 'URGENTE';
    requiredSkill?: Skill | null;
    confirmConflict?: boolean;
    version?: number;
  },
) {
  const issue = await lockIssue(tx, id);
  checkVersion(issue, input.version);
  assertTransition(issue, 'ATRIBUIDA');
  if (issue.status === 'AGUARDANDO_VERIFICACAO')
    throw Errors.business(
      'A solução aguarda verificação: confirme ou recuse antes de delegar de novo.',
    );
  const solver = await checkSolver(tx, input.assigneeUserId, input.requiredSkill);
  if (solver.conflicts.length && !input.confirmConflict) {
    throw Errors.conflict(
      `Conflito de agenda: ${solver.conflicts.join(' ')} Confirme para atribuir mesmo assim.`,
      { conflicts: solver.conflicts },
    );
  }
  const code = issueCode(issue.number);
  await cancelActionTask(tx, actor, issue, `Solução de ${code} delegada novamente.`);
  const task = await tx.productionTask.findUniqueOrThrow({
    where: { id: issue.taskId },
    include: { assignee: { select: { displayName: true } } },
  });
  const reporter = await tx.user.findUniqueOrThrow({ where: { id: issue.reporterUserId } });
  const now = clock();
  const dueAt = input.dueAt
    ? new Date(input.dueAt)
    : new Date(now.getTime() + (issue.blocksTask ? 2 : 8) * 3_600_000);
  const priority = input.priority ?? issue.priority;
  const action = await tx.productionTask.create({
    data: {
      planId: task.planId,
      serviceOrderId: task.serviceOrderId,
      serviceOrderItemId: task.serviceOrderItemId,
      activity: 'OUTRA',
      role: 'APOIO',
      title: `Resolver ${code}: ${input.instructions}`.slice(0, 120),
      assigneeUserId: input.assigneeUserId,
      priority,
      sequence: task.sequence,
      scheduledAt: immediateAt(),
      dueDate: dbDate((await attendanceConfig(tx, dueAt)).today),
      instructions: [
        input.instructions,
        `Problema (${ISSUE_KIND_LABEL[issue.kind as IssueKind]}, registrado por ${reporter.displayName} em ${taskCode(task.number)}): ${issue.description}`,
      ].join('\n'),
      requiresMaterials: false,
      issueId: issue.id,
      completionRequirement: 'OBSERVACAO',
      status: 'LIBERADA',
    },
  });
  await taskEvent(tx, actor, null, action, {
    kind: 'LIBERADA',
    to: 'LIBERADA',
    note: `Resolução de ${code} (${taskCode(task.number)})`,
  });
  await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_ASSIGNED, action, {}, [
    issue.reporterUserId,
  ]);
  const impactText = solver.conflicts.length
    ? `Conflito aprovado pelo gestor: ${solver.conflicts.join(' ')}`
    : `${solver.name} sem conflito de agenda.`;
  await reviseIfPublishedBy(
    tx,
    actor,
    task.planId,
    `Resolução de ${code} atribuída a ${solver.name}: ${input.instructions}. Impacto: ${impactText}`,
    `nova tarefa de resolução ${taskCode(action.number)}`,
  );
  const updated = await tx.productionIssue.update({
    where: { id: issue.id },
    data: {
      status: 'ATRIBUIDA',
      assigneeUserId: input.assigneeUserId,
      actionTaskId: action.id,
      requiredSkill: input.requiredSkill ?? null,
      dueAt,
      priority,
      riskAlertedAt: null,
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, actor, issue, {
    kind: 'ATRIBUIDA',
    from: issue.status,
    to: 'ATRIBUIDA',
    note: `${solver.name}: ${input.instructions}`,
    data: { actionTaskId: action.id, dueAt: dueAt.toISOString(), conflicts: solver.conflicts },
  });
  await planningAction(tx, actor, {
    kind: 'RESOLUCAO_ATRIBUIDA',
    automatic: false,
    reason: `${code}: ${solver.name} — ${input.instructions}. ${impactText}`,
    taskId: action.id,
    after: { assigneeUserId: input.assigneeUserId, conflicts: solver.conflicts },
  });
  await audit(tx, actor, {
    action: 'issue.assigned',
    entityType: 'production_issue',
    entityId: issue.id,
    summary: `${code} delegada a ${solver.name}: ${input.instructions}.${solver.conflicts.length ? ` ${impactText}` : ''}`,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_ASSIGNED, updated);
  await notify(tx, actor, [
    {
      userId: input.assigneeUserId,
      kind: 'OCORRENCIA_ATRIBUIDA',
      dedupeKey: `OCORRENCIA_ATRIBUIDA:${issue.id}:${action.id}`,
      body: `${code}: ${input.instructions} (${reporter.displayName}, ${taskCode(task.number)}).`,
      taskId: action.id,
      serviceOrderId: task.serviceOrderId,
      includeActor: true,
    },
  ]);
  return updated;
}

// ─────────────────────────── Tarefa de resolução (tablet) ───────────────────────────

async function issueOfAction(tx: Tx, actionTaskId: string) {
  const r = await tx.productionIssue.findUnique({ where: { actionTaskId } });
  return r ? lockIssue(tx, r.id) : null;
}

export async function actionStarted(tx: Tx, actor: ActorContext, actionTaskId: string) {
  const issue = await issueOfAction(tx, actionTaskId);
  if (!issue || issue.status !== 'ATRIBUIDA') return;
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: { status: 'EM_RESOLUCAO', version: { increment: 1 } },
  });
  await issueEvent(tx, actor, issue, { kind: 'INICIADA', from: 'ATRIBUIDA', to: 'EM_RESOLUCAO' });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_UPDATED, u);
}

export async function actionProgress(
  tx: Tx,
  actor: ActorContext,
  actionTaskId: string,
  note: string | null,
) {
  const issue = await issueOfAction(tx, actionTaskId);
  if (!issue || !(OPEN_STATUSES as string[]).includes(issue.status)) return;
  await issueEvent(tx, actor, issue, { kind: 'ANDAMENTO', note: note ?? 'Andamento registrado.' });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_UPDATED, issue);
}

/** Concluir a ação NÃO encerra a ocorrência: vai para verificação do gestor. */
export async function actionCompleted(
  tx: Tx,
  actor: ActorContext,
  actionTaskId: string,
  result: string | null,
) {
  const issue = await issueOfAction(tx, actionTaskId);
  if (!issue || !['ATRIBUIDA', 'EM_RESOLUCAO'].includes(issue.status)) return;
  await toVerification(tx, actor, issue, result ?? 'Ação concluída.', 'SOLUCAO_CONCLUIDA');
}

async function toVerification(
  tx: Tx,
  actor: ActorContext,
  issue: IssueRow,
  result: string,
  kind: 'SOLUCAO_CONCLUIDA' | 'VERIFICACAO_SOLICITADA' | 'MATERIAL_DISPONIVEL',
) {
  const code = issueCode(issue.number);
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: {
      status: 'AGUARDANDO_VERIFICACAO',
      resultNote: result.slice(0, 1000),
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, actor, issue, {
    kind,
    from: issue.status,
    to: 'AGUARDANDO_VERIFICACAO',
    note: result,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_VERIFICATION_REQUESTED, u);
  const who = actor.userId
    ? (await tx.user.findUnique({ where: { id: actor.userId } }))?.displayName
    : 'Sistema';
  await notifyIssueManagers(
    tx,
    actor,
    'VERIFICACAO_NECESSARIA',
    `VERIFICACAO:${issue.id}:${u.version}`,
    `${code}: ${who ?? 'Sistema'} registrou a solução — ${result}. Confirme se a causa foi eliminada.`,
    issue,
    true,
  );
  if (kind === 'SOLUCAO_CONCLUIDA') {
    await notify(tx, actor, [
      {
        userId: issue.reporterUserId,
        kind: 'SOLUCAO_CONCLUIDA',
        dedupeKey: `SOLUCAO_CONCLUIDA:${issue.id}:${u.version}`,
        body: `${code}: ${who} concluiu a ação (${result}). Aguardando confirmação do gestor.`,
        taskId: issue.taskId,
      },
    ]);
  }
  return u;
}

/** Gestor (ou responsável) registra a solução sem tarefa (ex.: reservou o material). */
export async function requestVerification(
  tx: Tx,
  actor: ActorContext,
  id: string,
  note: string,
  version?: number,
) {
  const issue = await lockIssue(tx, id);
  checkVersion(issue, version);
  assertTransition(issue, 'AGUARDANDO_VERIFICACAO');
  await cancelActionTask(
    tx,
    actor,
    issue,
    `Solução de ${issueCode(issue.number)} registrada: ${note}`,
  );
  return toVerification(tx, actor, issue, note, 'VERIFICACAO_SOLICITADA');
}

export async function recordAction(tx: Tx, actor: ActorContext, id: string, note: string) {
  const issue = await lockIssue(tx, id);
  if (!(OPEN_STATUSES as string[]).includes(issue.status))
    throw Errors.business('Ocorrência encerrada: reabra para registrar ações.');
  await issueEvent(tx, actor, issue, { kind: 'ACAO', note });
  await audit(tx, actor, {
    action: 'issue.action',
    entityType: 'production_issue',
    entityId: issue.id,
    summary: `${issueCode(issue.number)}: ${note}`,
  });
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: { version: { increment: 1 } },
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_UPDATED, u);
  return u;
}

// ─────────────────────────── Verificação e encerramento ───────────────────────────

/** A causa material foi eliminada? (necessidade da OS coberta ou reserva ativa no estoque). */
async function materialStillMissing(tx: Tx, issue: IssueRow): Promise<string | null> {
  if (issue.kind !== 'MATERIAL') return null;
  if (issue.materialRequirementId) {
    const r = await readinessOf(tx, issue.serviceOrderId);
    const line = r.lines.find((l) => l.requirementId === issue.materialRequirementId);
    if (line && q3(line.covered) < q3(line.need))
      return `${line.description}: ${line.covered} de ${line.need} disponível/reservado para a OS.`;
  }
  if (issue.stockItemId) {
    const reserved = await tx.stockReservation.aggregate({
      where: {
        stockItemId: issue.stockItemId,
        serviceOrderId: issue.serviceOrderId,
        status: 'ATIVA',
      },
      _sum: { quantity: true },
    });
    const qty = Number(reserved._sum.quantity ?? 0);
    if (qty < Number(issue.materialQuantity ?? 0))
      return `${issue.materialDescription}: ${qty} reservado(s) para a OS, faltam ${Number(issue.materialQuantity) - qty}.`;
  }
  return null;
}

export async function verifyIssue(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { resolved: boolean; note: string; version?: number },
) {
  const issue = await lockIssue(tx, id);
  checkVersion(issue, input.version);
  if (issue.status !== 'AGUARDANDO_VERIFICACAO')
    throw Errors.business('Só ocorrências aguardando verificação podem ser confirmadas.');
  const code = issueCode(issue.number);
  if (!input.resolved) {
    const u = await tx.productionIssue.update({
      where: { id: issue.id },
      data: { status: 'ABERTA', version: { increment: 1 } },
    });
    await issueEvent(tx, actor, issue, {
      kind: 'NAO_RESOLVIDA',
      from: issue.status,
      to: 'ABERTA',
      note: input.note,
    });
    await audit(tx, actor, {
      action: 'issue.not_resolved',
      entityType: 'production_issue',
      entityId: issue.id,
      summary: `${code}: verificação recusada — ${input.note}`,
    });
    await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_UPDATED, u);
    if (issue.assigneeUserId)
      await notify(tx, actor, [
        {
          userId: issue.assigneeUserId,
          kind: 'OCORRENCIA_REABERTA',
          dedupeKey: `NAO_RESOLVIDA:${issue.id}:${u.version}`,
          body: `${code} não foi resolvida: ${input.note}`,
          taskId: issue.taskId,
        },
      ]);
    return u;
  }
  const missing = await materialStillMissing(tx, issue);
  if (missing)
    throw Errors.business(`O material ainda não está disponível e reservado: ${missing}`);
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: {
      status: 'RESOLVIDA',
      resolvedAt: clock(),
      resolvedById: actor.userId,
      resultNote: [issue.resultNote, input.note].filter(Boolean).join(' — ').slice(0, 1000),
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, actor, issue, {
    kind: 'RESOLVIDA',
    from: issue.status,
    to: 'RESOLVIDA',
    note: input.note,
  });
  await audit(tx, actor, {
    action: 'issue.resolved',
    entityType: 'production_issue',
    entityId: issue.id,
    summary: `${code} resolvida: ${input.note}`,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_RESOLVED, u);
  await obsoleteProposals(tx, actor, { issueId: issue.id }, `${code} resolvida.`);
  await releaseBlock(tx, actor, u, `${code} resolvida: ${input.note}.`);
  // Reprogramação: as dependentes são reavaliadas pelo motor (nada inicia sozinho).
  const impact = await impactOf(tx, issue.taskId);
  await reevaluateTasks(
    tx,
    actor,
    impact.dependents.map((d) => d.id),
  );
  const recipients = [
    ...new Set([issue.reporterUserId, issue.assigneeUserId].filter(Boolean)),
  ] as string[];
  await notify(
    tx,
    actor,
    recipients.map((userId) => ({
      userId,
      kind: 'OCORRENCIA_RESOLVIDA' as const,
      dedupeKey: `OCORRENCIA_RESOLVIDA:${issue.id}:${issue.reopenCount}`,
      body: `${code} resolvida: ${input.note}`,
      taskId: issue.taskId,
    })),
  );
  return u;
}

export async function reopenIssue(
  tx: Tx,
  actor: ActorContext,
  id: string,
  reason: string,
  version?: number,
) {
  const issue = await lockIssue(tx, id);
  checkVersion(issue, version);
  assertTransition(issue, 'ABERTA');
  if (issue.status !== 'RESOLVIDA' && issue.status !== 'CANCELADA')
    throw Errors.business('Só ocorrências resolvidas ou canceladas podem ser reabertas.');
  const code = issueCode(issue.number);
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: {
      status: 'ABERTA',
      resolvedAt: null,
      resolvedById: null,
      cancelledAt: null,
      cancelledById: null,
      cancelReason: null,
      riskAlertedAt: null,
      reopenCount: { increment: 1 },
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, actor, issue, {
    kind: 'REABERTA',
    from: issue.status,
    to: 'ABERTA',
    note: reason,
  });
  await audit(tx, actor, {
    action: 'issue.reopened',
    entityType: 'production_issue',
    entityId: issue.id,
    summary: `${code} reaberta: ${reason}`,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_REOPENED, u);
  const task = await tx.productionTask.findUniqueOrThrow({ where: { id: issue.taskId } });
  if (!DONE.includes(task.status)) await applyBlock(tx, actor, u, null);
  await notify(tx, actor, [
    {
      userId: issue.reporterUserId,
      kind: 'OCORRENCIA_REABERTA',
      dedupeKey: `OCORRENCIA_REABERTA:${issue.id}:${u.reopenCount}`,
      body: `${code} foi reaberta: ${reason}`,
      taskId: issue.taskId,
    },
  ]);
  await proposeBlock(tx, actor, u);
  return u;
}

export async function cancelIssue(
  tx: Tx,
  actor: ActorContext,
  id: string,
  reason: string,
  version?: number,
) {
  const issue = await lockIssue(tx, id);
  checkVersion(issue, version);
  assertTransition(issue, 'CANCELADA');
  const code = issueCode(issue.number);
  await cancelActionTask(tx, actor, issue, `${code} cancelada: ${reason}`);
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: {
      status: 'CANCELADA',
      cancelledAt: clock(),
      cancelledById: actor.userId,
      cancelReason: reason.slice(0, 500),
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, actor, issue, {
    kind: 'CANCELADA',
    from: issue.status,
    to: 'CANCELADA',
    note: reason,
  });
  await audit(tx, actor, {
    action: 'issue.cancelled',
    entityType: 'production_issue',
    entityId: issue.id,
    summary: `${code} cancelada: ${reason}`,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_CANCELLED, u);
  await obsoleteProposals(tx, actor, { issueId: issue.id }, `${code} cancelada.`);
  await releaseBlock(tx, actor, u, `${code} cancelada.`);
  await notify(
    tx,
    actor,
    [...new Set([issue.reporterUserId, issue.assigneeUserId].filter(Boolean))].map((userId) => ({
      userId: userId!,
      kind: 'OCORRENCIA_CANCELADA' as const,
      dedupeKey: `OCORRENCIA_CANCELADA:${issue.id}:${issue.reopenCount}`,
      body: `${code} cancelada: ${reason}`,
      taskId: issue.taskId,
    })),
  );
  return u;
}

/** O gestor cancelou a tarefa de resolução: a ocorrência volta a aguardar delegação. */
export async function actionCancelled(
  tx: Tx,
  actor: ActorContext,
  actionTaskId: string,
  reason: string,
) {
  const issue = await issueOfAction(tx, actionTaskId);
  if (!issue || !['ATRIBUIDA', 'EM_RESOLUCAO'].includes(issue.status)) return;
  const u = await tx.productionIssue.update({
    where: { id: issue.id },
    data: { status: 'ABERTA', actionTaskId: null, version: { increment: 1 } },
  });
  await issueEvent(tx, actor, issue, {
    kind: 'ACAO_CANCELADA',
    from: issue.status,
    to: 'ABERTA',
    note: `Tarefa de resolução cancelada: ${reason}`,
  });
  await issueDomainEvent(tx, actor, EVENT_TYPES.ISSUE_UPDATED, u);
}

/** A tarefa original foi concluída/cancelada: ocorrências que só a impediam perdem o efeito? Não —
 * o gestor decide. Apenas registra no histórico para a verificação. */
export async function originalTaskClosed(
  tx: Tx,
  actor: ActorContext,
  taskId: string,
  status: string,
) {
  const open = await tx.productionIssue.findMany({
    where: { taskId, status: { in: OPEN_STATUSES } },
  });
  for (const i of open) {
    await issueEvent(tx, actor, i, {
      kind: 'TAREFA_ENCERRADA',
      note: `A tarefa de origem foi ${status === 'CONCLUIDA' ? 'concluída' : 'cancelada'}.`,
    });
  }
}

// ─────────────────────────── Rotinas ───────────────────────────

/**
 * Prazo de resolução vencido: um aviso ao gestor e ao responsável (sem repetir) e, se a
 * ocorrência impede a tarefa, proposta de bloqueio. Revalida propostas sem sentido.
 */
export async function processIssueRisks(prisma: PrismaClient, now = clock()) {
  const due = await prisma.productionIssue.findMany({
    where: {
      status: { in: ['ABERTA', 'ATRIBUIDA', 'EM_RESOLUCAO'] },
      riskAlertedAt: null,
      dueAt: { lte: new Date(now.getTime() + 15 * 60_000) },
    },
    select: { id: true },
  });
  let alerted = 0;
  for (const d of due) {
    const ok = await prisma.$transaction(async (tx) => {
      const issue = await lockIssue(tx, d.id);
      if (issue.riskAlertedAt || !issue.dueAt) return false;
      const u = await tx.productionIssue.update({
        where: { id: issue.id },
        data: { riskAlertedAt: now, version: { increment: 1 } },
      });
      const code = issueCode(issue.number);
      const late = issue.dueAt <= now;
      const note = late ? 'Prazo de resolução vencido.' : 'Prazo de resolução vence em até 15 min.';
      await issueEvent(tx, SYSTEM, issue, { kind: 'RISCO_PRAZO', note });
      await issueDomainEvent(tx, SYSTEM, EVENT_TYPES.ISSUE_RISK, u);
      const body = `${code}: ${note} ${issue.description}`.slice(0, 300);
      await notifyIssueManagers(
        tx,
        SYSTEM,
        'OCORRENCIA_PRAZO_RISCO',
        `PRAZO:${issue.id}:${issue.reopenCount}`,
        body,
        issue,
      );
      if (issue.assigneeUserId)
        await notify(tx, SYSTEM, [
          {
            userId: issue.assigneeUserId,
            kind: 'OCORRENCIA_PRAZO_RISCO',
            dedupeKey: `PRAZO:${issue.id}:${issue.reopenCount}`,
            body,
            taskId: issue.actionTaskId ?? issue.taskId,
          },
        ]);
      await proposeBlock(tx, SYSTEM, u);
      return true;
    });
    if (ok) alerted += 1;
  }
  await prisma.$transaction((tx) => revalidateBlockProposals(tx, SYSTEM));
  return alerted;
}

/**
 * Material ficou disponível/reservado para a OS: ocorrências de falta desse material (sem
 * ação em andamento) vão para verificação do gestor — não se encerram sozinhas.
 */
onReadinessChanged(async (tx, actor, serviceOrderId) => {
  const open = await tx.productionIssue.findMany({
    where: {
      serviceOrderId,
      kind: 'MATERIAL',
      status: { in: ['ABERTA', 'ATRIBUIDA'] },
      OR: [{ materialRequirementId: { not: null } }, { stockItemId: { not: null } }],
    },
  });
  for (const i of open) {
    const locked = await lockIssue(tx, i.id);
    if (!['ABERTA', 'ATRIBUIDA'].includes(locked.status)) continue;
    if (await materialStillMissing(tx, locked)) continue;
    if (locked.actionTaskId) {
      const t = await tx.productionTask.findUnique({ where: { id: locked.actionTaskId } });
      if (t && !DONE.includes(t.status)) continue;
    }
    await toVerification(
      tx,
      actor,
      locked,
      `Material disponível e reservado para a OS (${locked.materialDescription}).`,
      'MATERIAL_DISPONIVEL',
    );
  }
});
