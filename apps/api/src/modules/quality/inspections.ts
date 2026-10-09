import {
  CHECK_RESULT_LABEL,
  EVENT_TYPES,
  INSPECTION_REASON_LABEL,
  checklistFor,
  canDecideInspection,
  decisionProblems,
  inspectionCode,
  taskCode,
  type CheckResult,
  type InspectionDto,
  type InspectionReason,
  type InspectionStatus,
  type Priority,
  type TaskStatus,
} from '@cenario/shared';
import { immediateAt } from '../../core/clock';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { onItemTechnicalChange } from '../../core/item-changes';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { attendanceConfig, dbDate } from '../attendance/common';
import { dateOnly } from '../commercial/common';
import { planningAction } from '../help/engine';
import { notify } from '../notifications/notify';
import { domainTaskEvent, taskEvent } from '../production/common';
import { assertWorker, reviseIfPublishedBy } from '../production/plans';
import {
  chooseInspector,
  executorsOf,
  lockItem,
  notifyUsersWith,
  pieceCode,
  pieceInclude,
  pieceRef,
  qualityAudience,
  qualityEvent,
  readinessOfItem,
  refreshItemStage,
  requiredTaskWhere,
  substituteText,
  type PieceRow,
} from './common';
import { createPackaging, invalidatePackaging, packagingTaskCancelled } from './packaging';
import { flagDeliveryForItem } from './shipping';

export interface Viewer {
  userId: string;
  isManager: boolean;
}
export async function viewerOf(db: Tx | PrismaClient, userId: string): Promise<Viewer> {
  return { userId, isManager: (await loadUserPermissions(db, userId)).has('qualidade.gerenciar') };
}

const OPEN: InspectionStatus[] = ['PENDENTE', 'EM_ANDAMENTO'];

export const inspectionInclude = {
  serviceOrderItem: { include: pieceInclude },
  inspector: { select: { id: true, displayName: true } },
  decidedBy: { select: { displayName: true } },
  items: { orderBy: { position: 'asc' } },
  tasks: {
    orderBy: { number: 'asc' },
    include: { assignee: { select: { displayName: true } } },
  },
} as const satisfies Prisma.QualityInspectionInclude;
export type InspectionRow = Prisma.QualityInspectionGetPayload<{
  include: typeof inspectionInclude;
}>;

export async function lockInspection(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM quality_inspections WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Inspeção');
  return tx.qualityInspection.findUniqueOrThrow({ where: { id }, include: inspectionInclude });
}

const taskDto = (t: {
  id: string;
  number: number;
  title: string;
  activity: string;
  status: TaskStatus;
  completedAt: Date | null;
  assignee: { displayName: string } | null;
}) => ({
  id: t.id,
  code: taskCode(t.number),
  title: t.title,
  activity: t.activity,
  status: t.status,
  assignee: t.assignee?.displayName ?? null,
  completedAt: t.completedAt?.toISOString() ?? null,
});

export async function toInspectionDto(
  db: Tx | PrismaClient,
  r: InspectionRow,
  viewer: Viewer | null,
): Promise<InspectionDto> {
  const executors = await executorsOf(db, r.serviceOrderItem);
  const production = await db.productionTask.findMany({
    where: requiredTaskWhere(r.serviceOrderItem),
    orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
    include: { assignee: { select: { displayName: true } } },
  });
  const checkers = new Map(
    (
      await db.user.findMany({
        where: { id: { in: r.items.map((i) => i.checkedById).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  const photos = await db.attachment.count({
    where: { entityType: 'QUALITY_INSPECTION', entityId: r.id, deletedAt: null },
  });
  const open = OPEN.includes(r.status);
  const inspectorExecuted = Boolean(r.inspectorUserId && executors.has(r.inspectorUserId));
  const decision = viewer
    ? canDecideInspection({
        isManager: viewer.isManager,
        isAssignedInspector: r.inspectorUserId === viewer.userId,
        executedService: executors.has(viewer.userId),
        executorAuthorized:
          Boolean(r.executorAuthorizedById) && r.inspectorUserId === viewer.userId,
      })
    : { allowed: false, reason: null };
  const mayWork = Boolean(viewer && (viewer.isManager || r.inspectorUserId === viewer.userId));
  return {
    id: r.id,
    number: r.number,
    code: inspectionCode(r.number),
    round: r.round,
    reason: r.reason as InspectionReason,
    status: r.status,
    priority: r.priority,
    dueDate: dateOnly(r.dueDate),
    piece: pieceRef(r.serviceOrderItem),
    inspector: r.inspector
      ? { userId: r.inspector.id, displayName: r.inspector.displayName }
      : null,
    substituteReason: r.substituteReason,
    inspectorExecuted,
    executorAuthorized: Boolean(r.executorAuthorizedById),
    itemVersion: r.itemVersion,
    osRevision: r.osRevision,
    startedAt: r.startedAt?.toISOString() ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy?.displayName ?? null,
    decisionNote: r.decisionNote,
    invalidatedAt: r.invalidatedAt?.toISOString() ?? null,
    invalidReason: r.invalidReason,
    items: r.items.map((i) => ({
      id: i.id,
      position: i.position,
      label: i.label,
      guidance: i.guidance,
      required: i.required,
      result: i.result as CheckResult | null,
      note: i.note,
      checkedAt: i.checkedAt?.toISOString() ?? null,
      checkedBy: i.checkedById ? (checkers.get(i.checkedById) ?? null) : null,
    })),
    corrections: r.tasks.filter((t) => t.activity === 'CORRECAO').map(taskDto),
    production: production.map(taskDto),
    photos,
    can: {
      start: open && r.status === 'PENDENTE' && mayWork,
      check: open && mayWork,
      decide: open && decision.allowed,
      decideReason: open ? decision.reason : null,
    },
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

async function inspectionEvent(
  tx: Tx,
  actor: ActorContext,
  type: (typeof EVENT_TYPES)[
    | 'INSPECTION_CREATED'
    | 'INSPECTION_UPDATED'
    | 'INSPECTION_APPROVED'
    | 'INSPECTION_REJECTED'
    | 'INSPECTION_INVALIDATED'],
  i: {
    id: string;
    number: number;
    status: string;
    serviceOrderItemId: string;
    serviceOrderId: string;
    inspectorUserId: string | null;
    version: number;
  },
) {
  await appendEvent(tx, actor, {
    type,
    aggregateType: 'quality_inspection',
    aggregateId: i.id,
    payload: {
      id: i.id,
      code: inspectionCode(i.number),
      status: i.status,
      serviceOrderItemId: i.serviceOrderItemId,
      serviceOrderId: i.serviceOrderId,
      inspectorUserId: i.inspectorUserId,
      version: i.version,
    },
    audience: qualityAudience(i.inspectorUserId),
  });
}

// ─────────────────────────── Criação ───────────────────────────

/** Checklist da peça: modelo ativo do tipo de peça, só com os itens do tipo de serviço. */
async function checklistOf(tx: Tx, item: PieceRow) {
  const templates = await tx.qualityTemplate.findMany({
    where: { active: true, pieceTypes: { has: item.pieceType } },
    include: { items: { orderBy: { position: 'asc' } } },
    orderBy: { name: 'asc' },
  });
  const template = templates[0] ?? null;
  const items = template
    ? checklistFor(template.items, item.serviceType)
    : [
        { label: 'Acabamento', guidance: null, required: true },
        { label: 'Conformidade com a OS', guidance: null, required: true },
      ];
  return {
    templateId: template?.id ?? null,
    items: items.map((i, idx) => ({
      position: idx + 1,
      label: i.label,
      guidance: i.guidance,
      required: i.required,
    })),
  };
}

export async function createInspection(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  opts: { reason: InspectionReason; previousId?: string | null; note?: string | null },
) {
  const item = await lockItem(tx, itemId);
  const open = await tx.qualityInspection.findFirst({
    where: { serviceOrderItemId: itemId, status: { in: OPEN } },
  });
  if (open) return open;
  const last = await tx.qualityInspection.aggregate({
    where: { serviceOrderItemId: itemId },
    _max: { round: true },
  });
  const round = (last._max.round ?? 0) + 1;
  const { templateId, items } = await checklistOf(tx, item);
  const who = await chooseInspector(tx, item);
  const created = await tx.qualityInspection.create({
    data: {
      serviceOrderItemId: itemId,
      serviceOrderId: item.serviceOrderId,
      templateId,
      round,
      reason: opts.reason,
      inspectorUserId: who.inspectorUserId,
      substituteReason: substituteText(who.substitute),
      priority: item.serviceOrder.priority,
      dueDate: item.serviceOrder.promisedDate,
      itemVersion: item.version,
      previousInspectionId: opts.previousId ?? null,
      items: { create: items },
    },
  });
  const code = inspectionCode(created.number);
  const label = `${code} · ${pieceCode(item)} · ${item.description} (${item.serviceOrder.customer.name})`;
  await qualityEvent(tx, actor, itemId, {
    kind: 'INSPECAO_CRIADA',
    inspectionId: created.id,
    note: `${INSPECTION_REASON_LABEL[opts.reason]} — rodada ${round}.${who.substitute ? ` ${substituteText(who.substitute)}: aguarda o gestor.` : ''}${opts.note ? ` ${opts.note}` : ''}`,
    data: { round, inspectorUserId: who.inspectorUserId, substitute: who.substitute },
  });
  await audit(tx, actor, {
    action: 'quality.inspection_created',
    entityType: 'quality_inspection',
    entityId: created.id,
    summary: `Inspeção ${code} criada (${INSPECTION_REASON_LABEL[opts.reason]}) para ${pieceCode(item)}.`,
  });
  await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_CREATED, created);
  if (who.inspectorUserId) {
    await notify(tx, actor, [
      {
        userId: who.inspectorUserId,
        kind: round > 1 ? 'NOVA_INSPECAO' : 'INSPECAO_ATRIBUIDA',
        dedupeKey: `INSPECAO:${created.id}:${who.inspectorUserId}`,
        body: `${label} — ${INSPECTION_REASON_LABEL[opts.reason]}.`,
        serviceOrderId: item.serviceOrderId,
        includeActor: true,
      },
    ]);
  } else {
    await notifyUsersWith(
      tx,
      actor,
      'qualidade.gerenciar',
      'INSPECAO_PENDENTE',
      `INSPECAO_PENDENTE:${created.id}`,
      `${label} — ${substituteText(who.substitute)}: designe um inspetor substituto ou aprove diretamente.`,
      item.serviceOrderId,
    );
  }
  await refreshItemStage(tx, actor, itemId);
  return created;
}

/**
 * Depois que uma tarefa obrigatória é encerrada: se todas as etapas obrigatórias da peça estão
 * concluídas, nasce a inspeção (uma vez). Etapa nova concluída depois da aprovação invalida a
 * aprovação (a peça mudou) e exige nova inspeção.
 */
export async function inspectIfProductionDone(tx: Tx, actor: ActorContext, itemId: string) {
  const s = await readinessOfItem(tx, itemId);
  if (s.input.cancelled || s.input.returned || s.input.delivered) return;
  const { requiredTasks, requiredTasksDone } = s.input;
  if (requiredTasks === 0 || requiredTasksDone < requiredTasks) {
    await refreshItemStage(tx, actor, itemId);
    return;
  }
  const latest = s.inspection;
  if (!latest) {
    await createInspection(tx, actor, itemId, { reason: 'PRODUCAO_CONCLUIDA' });
    return;
  }
  if (latest.status === 'APROVADA' && latest.decidedAt) {
    const after = await tx.productionTask.count({
      where: { ...requiredTaskWhere(s.item), completedAt: { gt: latest.decidedAt } },
    });
    if (after > 0) {
      await invalidateApproval(
        tx,
        actor,
        itemId,
        'Nova etapa de produção concluída depois da aprovação.',
        'PRODUCAO_CONCLUIDA',
      );
      return;
    }
  }
  await refreshItemStage(tx, actor, itemId);
}

// ─────────────────────────── Execução pelo inspetor ───────────────────────────

function checkVersion(i: { version: number }, version: number | undefined) {
  if (version !== undefined && i.version !== version) throw Errors.versionConflict(i.version);
}
function assertOpen(i: { status: InspectionStatus }) {
  if (!OPEN.includes(i.status))
    throw Errors.business(
      'Esta inspeção já foi decidida; uma nova rodada é criada quando necessário.',
    );
}
function assertMayWork(i: { inspectorUserId: string | null }, viewer: Viewer) {
  if (!viewer.isManager && i.inspectorUserId !== viewer.userId)
    throw Errors.forbidden('Esta inspeção está designada para outra pessoa.');
}

export async function startInspection(
  tx: Tx,
  actor: ActorContext,
  viewer: Viewer,
  id: string,
  version?: number,
  deviceId: string | null = null,
) {
  const i = await lockInspection(tx, id);
  if (i.status === 'EM_ANDAMENTO' && (i.inspectorUserId === viewer.userId || viewer.isManager))
    return i; // repetição
  checkVersion(i, version);
  assertOpen(i);
  assertMayWork(i, viewer);
  const u = await tx.qualityInspection.update({
    where: { id },
    data: { status: 'EM_ANDAMENTO', startedAt: new Date(), version: { increment: 1 } },
  });
  await qualityEvent(tx, actor, i.serviceOrderItemId, {
    kind: 'INSPECAO_INICIADA',
    inspectionId: id,
    deviceId,
  });
  await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_UPDATED, u);
  await refreshItemStage(tx, actor, i.serviceOrderItemId);
  return u;
}

export async function checkItem(
  tx: Tx,
  actor: ActorContext,
  viewer: Viewer,
  id: string,
  itemId: string,
  input: { result: CheckResult | null; note?: string | null },
  deviceId: string | null = null,
) {
  let i = await lockInspection(tx, id);
  assertOpen(i);
  assertMayWork(i, viewer);
  const line = i.items.find((x) => x.id === itemId);
  if (!line) throw Errors.notFound('Item do checklist');
  if (input.result === 'NAO_SE_APLICA' && line.required)
    throw Errors.business('Item obrigatório: marque como conforme ou não conforme.');
  if (line.result === input.result && (line.note ?? null) === (input.note ?? null)) return i;
  if (i.status === 'PENDENTE') {
    await startInspection(tx, actor, viewer, id, undefined, deviceId);
    i = await lockInspection(tx, id);
  }
  await tx.qualityInspectionItem.update({
    where: { id: itemId },
    data: {
      result: input.result,
      note: input.note ?? null,
      checkedAt: input.result ? new Date() : null,
      checkedById: input.result ? actor.userId : null,
    },
  });
  const u = await tx.qualityInspection.update({
    where: { id },
    data: { version: { increment: 1 } },
  });
  await qualityEvent(tx, actor, i.serviceOrderItemId, {
    kind: 'ITEM_CONFERIDO',
    inspectionId: id,
    note: `${line.label}: ${input.result ? CHECK_RESULT_LABEL[input.result] : 'conferência desfeita'}${input.note ? ` — ${input.note}` : ''}`,
    deviceId,
  });
  await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_UPDATED, u);
  return u;
}

async function assertDecider(tx: Tx, i: InspectionRow, viewer: Viewer) {
  const executors = await executorsOf(tx, i.serviceOrderItem);
  const d = canDecideInspection({
    isManager: viewer.isManager,
    isAssignedInspector: i.inspectorUserId === viewer.userId,
    executedService: executors.has(viewer.userId),
    executorAuthorized: Boolean(i.executorAuthorizedById) && i.inspectorUserId === viewer.userId,
  });
  if (!d.allowed) throw Errors.business(d.reason ?? 'Você não pode decidir esta inspeção.');
}

async function osRevisionOf(tx: Tx, serviceOrderId: string) {
  const last = await tx.serviceOrderRevision.aggregate({
    where: { serviceOrderId },
    _max: { revision: true },
  });
  return last._max.revision ?? 0;
}

export async function approveInspection(
  tx: Tx,
  actor: ActorContext,
  viewer: Viewer,
  id: string,
  input: { note?: string | null; version: number },
  deviceId: string | null = null,
) {
  const i = await lockInspection(tx, id);
  if (i.status === 'APROVADA' && i.decidedById === viewer.userId) return i; // repetição
  checkVersion(i, input.version);
  assertOpen(i);
  await assertDecider(tx, i, viewer);
  const problems = decisionProblems(
    'APROVAR',
    i.items.map((x) => ({ required: x.required, result: x.result as CheckResult | null })),
  );
  if (problems.length) throw Errors.business(problems.join(' '), { problems });
  const item = await lockItem(tx, i.serviceOrderItemId);
  const s = await readinessOfItem(tx, item.id);
  if (s.input.requiredTasksDone < s.input.requiredTasks)
    throw Errors.business('Há etapas de produção pendentes nesta peça: conclua antes de aprovar.');
  if (s.input.openCorrections > 0)
    throw Errors.business('Há correções em aberto nesta peça: conclua antes de aprovar.');
  if (item.version !== i.itemVersion)
    throw Errors.conflict(
      'A peça foi alterada tecnicamente depois que esta inspeção foi criada: é preciso uma nova inspeção.',
    );
  const now = new Date();
  const u = await tx.qualityInspection.update({
    where: { id },
    data: {
      status: 'APROVADA',
      startedAt: i.startedAt ?? now,
      decidedAt: now,
      decidedById: actor.userId,
      decidedDeviceId: deviceId,
      decisionNote: input.note ?? null,
      osRevision: await osRevisionOf(tx, i.serviceOrderId),
      version: { increment: 1 },
    },
  });
  const code = inspectionCode(i.number);
  await qualityEvent(tx, actor, item.id, {
    kind: 'APROVADA',
    inspectionId: id,
    note: input.note ?? null,
    data: { itemVersion: u.itemVersion, osRevision: u.osRevision },
    deviceId,
  });
  await audit(tx, actor, {
    action: 'quality.inspection_approved',
    entityType: 'quality_inspection',
    entityId: id,
    summary: `Inspeção ${code} aprovada (${pieceCode(item)}, versão técnica ${u.itemVersion}, revisão da OS ${u.osRevision}).`,
  });
  await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_APPROVED, u);
  await createPackaging(tx, actor, u, item);
  await refreshItemStage(tx, actor, item.id);
  return u;
}

/** Responsável padrão da correção: o principal da peça; senão, quem concluiu a última etapa. */
async function defaultCorrectionAssignee(tx: Tx, item: PieceRow) {
  const tasks = await tx.productionTask.findMany({
    where: requiredTaskWhere(item),
    orderBy: [{ completedAt: 'desc' }],
  });
  return (
    tasks.find((t) => t.role === 'PRINCIPAL' && t.assigneeUserId)?.assigneeUserId ??
    tasks.find((t) => t.assigneeUserId)?.assigneeUserId ??
    null
  );
}

export async function rejectInspection(
  tx: Tx,
  actor: ActorContext,
  viewer: Viewer,
  id: string,
  input: {
    reason: string;
    correction: {
      assigneeUserId?: string | null;
      priority?: Priority;
      dueDate?: string | null;
      instructions?: string | null;
    };
    version: number;
  },
  deviceId: string | null = null,
) {
  const i = await lockInspection(tx, id);
  if (i.status === 'REPROVADA' && i.decidedById === viewer.userId) return i; // repetição
  checkVersion(i, input.version);
  assertOpen(i);
  await assertDecider(tx, i, viewer);
  const items = i.items.map((x) => ({
    required: x.required,
    result: x.result as CheckResult | null,
  }));
  const problems = decisionProblems('REPROVAR', items, input.reason);
  if (problems.length) throw Errors.business(problems.join(' '), { problems });
  const item = await lockItem(tx, i.serviceOrderItemId);
  const assigneeUserId =
    input.correction.assigneeUserId ?? (await defaultCorrectionAssignee(tx, item));
  if (!assigneeUserId)
    throw Errors.business('Escolha quem fará a correção (a peça não tem responsável definido).');
  const worker = await assertWorker(tx, assigneeUserId, 'Responsável pela correção');
  const now = new Date();
  const u = await tx.qualityInspection.update({
    where: { id },
    data: {
      status: 'REPROVADA',
      startedAt: i.startedAt ?? now,
      decidedAt: now,
      decidedById: actor.userId,
      decidedDeviceId: deviceId,
      decisionNote: input.reason,
      version: { increment: 1 },
    },
  });
  const code = inspectionCode(i.number);
  const defects = i.items.filter((x) => x.result === 'NAO_CONFORME');
  const defectText = defects.map((d) => `${d.label}${d.note ? `: ${d.note}` : ''}`).join('; ');
  const base = await tx.productionTask.findFirst({
    where: requiredTaskWhere(item),
    orderBy: [{ completedAt: 'desc' }, { number: 'desc' }],
  });
  const priority = input.correction.priority ?? 'ALTA';
  const dueDate = input.correction.dueDate
    ? dbDate(input.correction.dueDate)
    : dbDate((await attendanceConfig(tx)).today);
  const correction = await tx.productionTask.create({
    data: {
      planId: base?.planId ?? null,
      serviceOrderId: item.serviceOrderId,
      serviceOrderItemId: item.id,
      activity: 'CORRECAO',
      role: 'PRINCIPAL',
      title: `Corrigir ${pieceCode(item)}: ${defects.map((d) => d.label).join(', ')}`.slice(0, 120),
      assigneeUserId,
      priority,
      sequence: (base?.sequence ?? 0) + 1,
      scheduledAt: immediateAt(),
      dueDate,
      instructions: [
        `Reprovada na inspeção ${code}: ${input.reason}`,
        `Defeitos: ${defectText}`,
        ...(input.correction.instructions ? [input.correction.instructions] : []),
      ]
        .join('\n')
        .slice(0, 2000),
      requiresMaterials: false,
      inspectionId: i.id,
      completionRequirement: 'OBSERVACAO',
      status: 'LIBERADA',
    },
  });
  await taskEvent(tx, actor, null, correction, {
    kind: 'LIBERADA',
    to: 'LIBERADA',
    note: `Correção da reprovação ${code}`,
  });
  await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_ASSIGNED, correction);
  await reviseIfPublishedBy(
    tx,
    actor,
    correction.planId,
    `Reprovação ${code} (${pieceCode(item)}): ${input.reason}`,
    `nova tarefa de correção ${taskCode(correction.number)} para ${worker.displayName}`,
  );
  await planningAction(tx, actor, {
    kind: 'CORRECAO_QUALIDADE',
    automatic: false,
    reason: `${code} reprovada: ${input.reason}. Correção ${taskCode(correction.number)} para ${worker.displayName} (prioridade ${priority}).`,
    taskId: correction.id,
    after: { assigneeUserId, priority, dueDate: dateOnly(dueDate) },
  });
  await qualityEvent(tx, actor, item.id, {
    kind: 'REPROVADA',
    inspectionId: id,
    note: `${input.reason} — Defeitos: ${defectText}`,
    data: {
      defects: defects.map((d) => ({ label: d.label, note: d.note })),
      correctionTaskId: correction.id,
    },
    deviceId,
  });
  await audit(tx, actor, {
    action: 'quality.inspection_rejected',
    entityType: 'quality_inspection',
    entityId: id,
    summary: `Inspeção ${code} reprovada (${pieceCode(item)}): ${input.reason}. Correção ${taskCode(correction.number)} para ${worker.displayName}.`,
  });
  await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_REJECTED, u);
  const label = `${pieceCode(item)} · ${item.description} (${item.serviceOrder.customer.name})`;
  await notify(tx, actor, [
    {
      userId: assigneeUserId,
      kind: 'CORRECAO_ATRIBUIDA',
      dedupeKey: `CORRECAO_ATRIBUIDA:${correction.id}`,
      body: `${taskCode(correction.number)} · ${label} — ${defectText}.`,
      taskId: correction.id,
      serviceOrderId: item.serviceOrderId,
      includeActor: true,
    },
  ]);
  await notifyUsersWith(
    tx,
    actor,
    'qualidade.gerenciar',
    'SERVICO_REPROVADO',
    `SERVICO_REPROVADO:${id}`,
    `${code} · ${label} reprovada: ${input.reason}. Correção com ${worker.displayName}; a embalagem fica bloqueada até nova aprovação.`,
    item.serviceOrderId,
  );
  await flagDeliveryForItem(
    tx,
    actor,
    item.id,
    `${pieceCode(item)} reprovada na inspeção ${code}.`,
    true,
  );
  await refreshItemStage(tx, actor, item.id);
  return u;
}

// ─────────────────────────── Gestor ───────────────────────────

/** Designa o inspetor (substituto). Quem executou o serviço só com autorização explícita. */
export async function assignInspector(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    inspectorUserId: string;
    reason?: string | null;
    authorizeExecutor: boolean;
    version: number;
  },
) {
  const i = await lockInspection(tx, id);
  checkVersion(i, input.version);
  assertOpen(i);
  const user = await tx.user.findUnique({
    where: { id: input.inspectorUserId },
    include: { employee: true },
  });
  if (!user?.active || user.employee?.active === false)
    throw Errors.business('Inspetor inválido ou inativo.');
  const perms = await loadUserPermissions(tx, user.id);
  if (!perms.has('qualidade.inspecionar') && !perms.has('qualidade.gerenciar'))
    throw Errors.business(
      `${user.displayName} não está autorizado a inspecionar (permissão "Inspecionar peças").`,
    );
  const executed = (await executorsOf(tx, i.serviceOrderItem)).has(user.id);
  if (executed && !input.authorizeExecutor)
    throw Errors.business(
      `${user.displayName} executou este serviço: para evitar autoaprovação, escolha outro inspetor ou autorize explicitamente (com justificativa).`,
    );
  const u = await tx.qualityInspection.update({
    where: { id },
    data: {
      inspectorUserId: user.id,
      executorAuthorizedById: executed ? actor.userId : null,
      substituteReason:
        user.id === i.inspectorUserId
          ? i.substituteReason
          : (input.reason ?? i.substituteReason ?? 'Designado pelo gestor'),
      version: { increment: 1 },
    },
  });
  const code = inspectionCode(i.number);
  await qualityEvent(tx, actor, i.serviceOrderItemId, {
    kind: 'INSPETOR_DESIGNADO',
    inspectionId: id,
    note: `${user.displayName}${executed ? ' (executor, autorizado pelo gestor)' : ''}${input.reason ? ` — ${input.reason}` : ''}`,
    data: { from: i.inspectorUserId, to: user.id, executorAuthorized: executed },
  });
  await audit(tx, actor, {
    action: executed ? 'quality.executor_authorized' : 'quality.inspector_assigned',
    entityType: 'quality_inspection',
    entityId: id,
    summary: `Inspeção ${code}: inspetor ${user.displayName}${executed ? ' (executou o serviço — autorizado pelo gestor)' : ''}.${input.reason ? ` Motivo: ${input.reason}` : ''}`,
  });
  await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_UPDATED, u);
  await notify(tx, actor, [
    {
      userId: user.id,
      kind: 'INSPECAO_ATRIBUIDA',
      dedupeKey: `INSPECAO:${id}:${user.id}`,
      body: `${code} · ${pieceCode(i.serviceOrderItem)} · ${i.serviceOrderItem.description} (${i.serviceOrderItem.serviceOrder.customer.name}).`,
      serviceOrderId: i.serviceOrderId,
      includeActor: true,
    },
  ]);
  return u;
}

/**
 * Alteração técnica relevante: a aprovação anterior deixa de valer (fica no histórico como
 * "invalidada"), a embalagem é invalidada e nasce uma nova inspeção. Uma inspeção ainda aberta
 * é cancelada e recriada com a versão nova. Reprovada: a próxima rodada já usará a versão nova.
 */
export async function invalidateApproval(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  reason: string,
  newReason: InspectionReason = 'ALTERACAO_TECNICA',
) {
  const latest = await tx.qualityInspection.findFirst({
    where: { serviceOrderItemId: itemId, status: { not: 'CANCELADA' } },
    orderBy: { round: 'desc' },
  });
  if (!latest) return;
  if (latest.status === 'REPROVADA' || latest.status === 'INVALIDADA') return;
  const i = await lockInspection(tx, latest.id);
  const code = inspectionCode(i.number);
  const now = new Date();
  if (i.status === 'APROVADA') {
    const u = await tx.qualityInspection.update({
      where: { id: i.id },
      data: {
        status: 'INVALIDADA',
        invalidatedAt: now,
        invalidReason: reason.slice(0, 500),
        version: { increment: 1 },
      },
    });
    await invalidatePackaging(tx, actor, i.id, `Aprovação ${code} invalidada: ${reason}`);
    await qualityEvent(tx, actor, itemId, {
      kind: 'APROVACAO_INVALIDADA',
      inspectionId: i.id,
      note: reason,
    });
    await audit(tx, actor, {
      action: 'quality.approval_invalidated',
      entityType: 'quality_inspection',
      entityId: i.id,
      summary: `Aprovação ${code} (${pieceCode(i.serviceOrderItem)}) invalidada: ${reason}`,
    });
    await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_INVALIDATED, u);
    await notifyUsersWith(
      tx,
      actor,
      'qualidade.gerenciar',
      'APROVACAO_INVALIDADA',
      `APROVACAO_INVALIDADA:${i.id}`,
      `${code} · ${pieceCode(i.serviceOrderItem)}: ${reason} Nova inspeção necessária; a peça não pode ser entregue até ser aprovada de novo.`,
      i.serviceOrderId,
    );
    await flagDeliveryForItem(
      tx,
      actor,
      itemId,
      `${pieceCode(i.serviceOrderItem)}: aprovação invalidada (${reason}).`,
      true,
    );
  } else {
    const u = await tx.qualityInspection.update({
      where: { id: i.id },
      data: {
        status: 'CANCELADA',
        invalidatedAt: now,
        invalidReason: reason.slice(0, 500),
        version: { increment: 1 },
      },
    });
    await qualityEvent(tx, actor, itemId, {
      kind: 'INSPECAO_SUBSTITUIDA',
      inspectionId: i.id,
      note: reason,
    });
    await inspectionEvent(tx, actor, EVENT_TYPES.INSPECTION_INVALIDATED, u);
  }
  // Só reinspeciona se a produção obrigatória continua concluída.
  const s = await readinessOfItem(tx, itemId);
  if (s.input.requiredTasks > 0 && s.input.requiredTasksDone === s.input.requiredTasks)
    await createInspection(tx, actor, itemId, {
      reason: newReason,
      previousId: i.id,
      note: reason,
    });
  else await refreshItemStage(tx, actor, itemId);
}

onItemTechnicalChange(async (tx, actor, change) => {
  await invalidateApproval(tx, actor, change.itemId, `Alteração técnica: ${change.summary}`);
});

/** Encerramento (conclusão ou cancelamento) de tarefa: avança o fluxo de qualidade. */
export async function qualityTaskClosed(
  tx: Tx,
  actor: ActorContext,
  taskId: string,
  status: 'CONCLUIDA' | 'CANCELADA',
) {
  const t = await tx.productionTask.findUniqueOrThrow({ where: { id: taskId } });
  if (t.supportForTaskId || t.issueId) return;
  if (t.activity === 'CORRECAO' && t.inspectionId) {
    const open = await tx.productionTask.count({
      where: {
        inspectionId: t.inspectionId,
        activity: 'CORRECAO',
        status: { notIn: ['CONCLUIDA', 'CANCELADA'] },
      },
    });
    if (open > 0) return;
    const prev = await tx.qualityInspection.findUniqueOrThrow({
      where: { id: t.inspectionId },
      include: { serviceOrderItem: { include: pieceInclude } },
    });
    await qualityEvent(tx, actor, prev.serviceOrderItemId, {
      kind: status === 'CONCLUIDA' ? 'CORRECAO_CONCLUIDA' : 'CORRECAO_CANCELADA',
      inspectionId: prev.id,
      note: `${taskCode(t.number)} · ${t.title}${t.completionNote ? ` — ${t.completionNote}` : ''}`,
    });
    await notifyUsersWith(
      tx,
      actor,
      'qualidade.gerenciar',
      'CORRECAO_CONCLUIDA',
      `CORRECAO_CONCLUIDA:${prev.id}`,
      `${pieceCode(prev.serviceOrderItem)} · correção ${status === 'CONCLUIDA' ? 'concluída' : 'encerrada'} (${taskCode(t.number)}). Nova inspeção obrigatória — nada é aprovado automaticamente.`,
      prev.serviceOrderId,
    );
    await createInspection(tx, actor, prev.serviceOrderItemId, {
      reason: 'CORRECAO_CONCLUIDA',
      previousId: prev.id,
    });
    return;
  }
  if (t.activity === 'EMBALAGEM') {
    if (status === 'CANCELADA') await packagingTaskCancelled(tx, actor, t.id);
    return;
  }
  if (t.inspectionId) return;
  const items = t.serviceOrderItemId
    ? [t.serviceOrderItemId]
    : (
        await tx.serviceOrderItem.findMany({
          where: { serviceOrderId: t.serviceOrderId },
          select: { id: true },
        })
      ).map((x) => x.id);
  for (const itemId of items) await inspectIfProductionDone(tx, actor, itemId);
}
