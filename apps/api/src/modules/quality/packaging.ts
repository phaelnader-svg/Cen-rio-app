import {
  EVENT_TYPES,
  PROTECTION_LABEL,
  inspectionCode,
  packagingCode,
  pickCandidate,
  taskCode,
  type PackagingDto,
  type PackagingStatus,
  type Protection,
} from '@cenario/shared';
import { immediateAt } from '../../core/clock';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { evaluateCandidates, planningAction, reasonText, skillsByEmployee } from '../help/engine';
import { notify } from '../notifications/notify';
import { domainTaskEvent, lockTasks, taskEvent } from '../production/common';
import { assertWorker, reviseIfPublishedBy } from '../production/plans';
import {
  moveItem,
  notifyUsersWith,
  pieceCode,
  pieceInclude,
  pieceRef,
  qualityAudience,
  qualityEvent,
  refreshItemStage,
  requiredTaskWhere,
  type PieceRow,
} from './common';

export const packagingInclude = {
  serviceOrderItem: { include: pieceInclude },
  inspection: { select: { number: true, status: true } },
  assignee: { select: { id: true, displayName: true } },
  location: { select: { id: true, label: true } },
} as const satisfies Prisma.PackagingRecordInclude;
type PackagingRow = Prisma.PackagingRecordGetPayload<{ include: typeof packagingInclude }>;

export async function toPackagingDto(
  db: Tx | PrismaClient,
  r: PackagingRow,
): Promise<PackagingDto> {
  const completedBy = r.completedById
    ? await db.user.findUnique({ where: { id: r.completedById }, select: { displayName: true } })
    : null;
  return {
    id: r.id,
    number: r.number,
    code: packagingCode(r.number),
    status: r.status as PackagingStatus,
    piece: pieceRef(r.serviceOrderItem),
    inspectionCode: inspectionCode(r.inspection.number),
    assignee: r.assignee ? { userId: r.assignee.id, displayName: r.assignee.displayName } : null,
    tapeceiroAuthorized: Boolean(r.tapeceiroAuthorizedById),
    taskId: r.taskId,
    protection: r.protection as Protection | null,
    location: r.location,
    notes: r.notes,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    completedBy: completedBy?.displayName ?? null,
    invalidReason: r.invalidReason,
    version: r.version,
  };
}

export async function lockPackaging(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM packaging_records WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Embalagem');
  return tx.packagingRecord.findUniqueOrThrow({ where: { id }, include: packagingInclude });
}

async function packagingEvent(
  tx: Tx,
  actor: ActorContext,
  p: {
    id: string;
    number: number;
    status: string;
    serviceOrderItemId: string;
    assigneeUserId: string | null;
  },
) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.PACKAGING_UPDATED,
    aggregateType: 'packaging',
    aggregateId: p.id,
    payload: {
      id: p.id,
      code: packagingCode(p.number),
      status: p.status,
      serviceOrderItemId: p.serviceOrderItemId,
      assigneeUserId: p.assigneeUserId,
    },
    audience: qualityAudience(p.assigneeUserId),
  });
}

async function newPackagingTask(
  tx: Tx,
  actor: ActorContext,
  item: PieceRow,
  inspection: { id: string; number: number },
  assigneeUserId: string | null,
) {
  const base = await tx.productionTask.findFirst({
    where: requiredTaskWhere(item),
    orderBy: [{ completedAt: 'desc' }, { number: 'desc' }],
  });
  const task = await tx.productionTask.create({
    data: {
      planId: base?.planId ?? null,
      serviceOrderId: item.serviceOrderId,
      serviceOrderItemId: item.id,
      activity: 'EMBALAGEM',
      role: 'APOIO',
      title: `Embalar ${pieceCode(item)} · ${item.description}`.slice(0, 120),
      assigneeUserId,
      priority: item.serviceOrder.priority,
      sequence: (base?.sequence ?? 0) + 2,
      scheduledAt: immediateAt(),
      instructions: `Aprovada na inspeção ${inspectionCode(inspection.number)}. Ao concluir, registre a proteção usada e o local onde a peça ficou.`,
      requiresMaterials: false,
      inspectionId: inspection.id,
      status: assigneeUserId ? 'LIBERADA' : 'BLOQUEADA',
      blockers: assigneeUserId ? [] : ['SEM_RESPONSAVEL'],
    },
  });
  await taskEvent(tx, actor, null, task, {
    kind: assigneeUserId ? 'LIBERADA' : 'CRIADA',
    to: task.status,
    note: `Embalagem após a aprovação ${inspectionCode(inspection.number)}`,
  });
  await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_ASSIGNED, task);
  return task;
}

/**
 * Depois da aprovação: registro de embalagem + tarefa. Distribuição (determinística): quem tem
 * apoio geral, está presente e livre, preferindo quem não tem especialidade (João antes do
 * Thiago). Sem ninguém disponível, a tarefa aguarda o gestor (que pode autorizar o tapeceiro).
 */
export async function createPackaging(
  tx: Tx,
  actor: ActorContext,
  inspection: { id: string; number: number },
  item: PieceRow,
) {
  const { candidates } = await evaluateCandidates(tx, {
    requesterUserId: '',
    skill: 'APOIO_GERAL',
    estimatedMinutes: 30,
  });
  const chosen = pickCandidate(candidates);
  const task = await newPackagingTask(tx, actor, item, inspection, chosen?.userId ?? null);
  const record = await tx.packagingRecord.create({
    data: {
      serviceOrderItemId: item.id,
      serviceOrderId: item.serviceOrderId,
      inspectionId: inspection.id,
      taskId: task.id,
      assigneeUserId: chosen?.userId ?? null,
    },
  });
  const code = packagingCode(record.number);
  const label = `${pieceCode(item)} · ${item.description} (${item.serviceOrder.customer.name})`;
  const why = chosen
    ? `${chosen.name} (${chosen.notes.join('; ') || 'disponível'})`
    : `ninguém disponível — ${candidates.map((c) => `${c.name}: ${reasonText(c)}`).join('; ') || 'sem equipe'}`;
  await reviseIfPublishedBy(
    tx,
    actor,
    task.planId,
    `Embalagem liberada pela aprovação ${inspectionCode(inspection.number)} (${pieceCode(item)}).`,
    `nova tarefa de embalagem ${taskCode(task.number)}`,
  );
  await planningAction(tx, actor, {
    kind: 'EMBALAGEM_DISTRIBUIDA',
    automatic: true,
    reason: `${code} · ${label}: ${why}`.slice(0, 500),
    taskId: task.id,
    after: { assigneeUserId: chosen?.userId ?? null, candidates },
  });
  await qualityEvent(tx, actor, item.id, {
    kind: 'EMBALAGEM_LIBERADA',
    inspectionId: inspection.id,
    note: `${code}: ${why}`,
  });
  await packagingEvent(tx, actor, record);
  if (chosen) {
    await notify(tx, actor, [
      {
        userId: chosen.userId,
        kind: 'EMBALAGEM_LIBERADA',
        dedupeKey: `EMBALAGEM_LIBERADA:${record.id}:${chosen.userId}`,
        body: `${taskCode(task.number)} · ${label} — aprovada pela qualidade; embale e registre o local.`,
        taskId: task.id,
        serviceOrderId: item.serviceOrderId,
        includeActor: true,
      },
    ]);
  } else {
    await notifyUsersWith(
      tx,
      actor,
      'qualidade.gerenciar',
      'EMBALAGEM_LIBERADA',
      `EMBALAGEM_LIBERADA:${record.id}`,
      `${code} · ${label} aprovada, mas ninguém está disponível para embalar: designe o responsável (o tapeceiro só com sua autorização).`,
      item.serviceOrderId,
    );
  }
  return record;
}

/** Gestor designa quem embala. O tapeceiro responsável só com autorização explícita. */
export async function assignPackaging(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { assigneeUserId: string; authorizeTapeceiro: boolean; version: number },
) {
  const p = await lockPackaging(tx, id);
  if (p.version !== input.version) throw Errors.versionConflict(p.version);
  if (p.status !== 'PENDENTE')
    throw Errors.business('Só é possível designar quem embala enquanto a embalagem não começou.');
  if (p.inspection.status !== 'APROVADA')
    throw Errors.business('A embalagem só existe para peças aprovadas pela qualidade.');
  const worker = await assertWorker(tx, input.assigneeUserId, 'Responsável pela embalagem');
  if (worker.isTapeceiro && !input.authorizeTapeceiro)
    throw Errors.business(
      `${worker.displayName} é tapeceiro: a embalagem pelo tapeceiro precisa da sua autorização explícita.`,
    );
  if (!worker.isTapeceiro) {
    const employee = await tx.employee.findUniqueOrThrow({ where: { userId: worker.userId } });
    if (!(await skillsByEmployee(tx)).get(employee.id)?.has('APOIO_GERAL'))
      throw Errors.business(`${worker.displayName} não tem a competência de apoio geral.`);
  }
  let taskId = p.taskId;
  const task = taskId ? await tx.productionTask.findUnique({ where: { id: taskId } }) : null;
  if (task && ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'].includes(task.status)) {
    await lockTasks(tx, [task.id]);
    const u = await tx.productionTask.update({
      where: { id: task.id },
      data: {
        assigneeUserId: worker.userId,
        status: 'LIBERADA',
        blockers: [],
        version: { increment: 1 },
      },
    });
    await taskEvent(tx, actor, null, task, {
      kind: 'REATRIBUIDA',
      from: task.status,
      to: 'LIBERADA',
      note: `Embalagem com ${worker.displayName}${worker.isTapeceiro ? ' (tapeceiro autorizado pelo gestor)' : ''}`,
    });
    await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_ASSIGNED, u, {}, [
      task.assigneeUserId,
    ]);
  } else {
    const created = await newPackagingTask(
      tx,
      actor,
      p.serviceOrderItem,
      { id: p.inspectionId, number: p.inspection.number },
      worker.userId,
    );
    taskId = created.id;
  }
  const u = await tx.packagingRecord.update({
    where: { id },
    data: {
      assigneeUserId: worker.userId,
      taskId,
      tapeceiroAuthorizedById: worker.isTapeceiro ? actor.userId : null,
      version: { increment: 1 },
    },
  });
  const code = packagingCode(p.number);
  await planningAction(tx, actor, {
    kind: 'EMBALAGEM_ATRIBUIDA',
    automatic: false,
    reason: `${code} · ${pieceCode(p.serviceOrderItem)}: ${worker.displayName}${worker.isTapeceiro ? ' (tapeceiro, autorizado)' : ''}.`,
    taskId,
    before: { assigneeUserId: p.assigneeUserId },
    after: { assigneeUserId: worker.userId },
  });
  await audit(tx, actor, {
    action: worker.isTapeceiro ? 'packaging.tapeceiro_authorized' : 'packaging.assigned',
    entityType: 'packaging',
    entityId: id,
    summary: `${code}: embalagem designada a ${worker.displayName}${worker.isTapeceiro ? ' (tapeceiro, autorizado pelo gestor)' : ''}.`,
  });
  await qualityEvent(tx, actor, p.serviceOrderItemId, {
    kind: 'EMBALAGEM_DESIGNADA',
    inspectionId: p.inspectionId,
    note: worker.displayName,
  });
  await packagingEvent(tx, actor, u);
  await notify(tx, actor, [
    {
      userId: worker.userId,
      kind: 'EMBALAGEM_LIBERADA',
      dedupeKey: `EMBALAGEM_LIBERADA:${id}:${worker.userId}`,
      body: `${pieceCode(p.serviceOrderItem)} · ${p.serviceOrderItem.description} — embale e registre o local.`,
      taskId,
      serviceOrderId: p.serviceOrderId,
      includeActor: true,
    },
  ]);
  return u;
}

/** Início da tarefa de embalagem (pelo "Iniciar" do tablet). */
export async function packagingStarted(tx: Tx, actor: ActorContext, taskId: string) {
  const p = await tx.packagingRecord.findUnique({ where: { taskId } });
  if (!p || p.status !== 'PENDENTE') return;
  const u = await tx.packagingRecord.update({
    where: { id: p.id },
    // Efeito do "Iniciar" da tarefa (não é edição do registro): a versão não muda, para não
    // invalidar a tela de conclusão que o próprio responsável já tem aberta.
    data: { status: 'EM_ANDAMENTO', startedAt: new Date() },
  });
  await packagingEvent(tx, actor, u);
  await refreshItemStage(tx, actor, p.serviceOrderItemId);
}

/**
 * Conclusão da embalagem: só depois da aprovação vigente, com proteção e local. Conclui também
 * a tarefa e registra a localização da peça.
 */
export async function completePackaging(
  tx: Tx,
  actor: ActorContext,
  viewer: { userId: string; isManager: boolean },
  id: string,
  input: { protection: Protection; locationId: string; notes?: string | null; version: number },
  deviceId: string | null = null,
) {
  const p = await lockPackaging(tx, id);
  if (p.status === 'CONCLUIDA' && p.completedById === viewer.userId) return p; // repetição
  if (p.version !== input.version) throw Errors.versionConflict(p.version);
  if (p.inspection.status !== 'APROVADA')
    throw Errors.business('A embalagem só pode ser concluída depois da aprovação da qualidade.');
  if (p.status !== 'PENDENTE' && p.status !== 'EM_ANDAMENTO')
    throw Errors.business(
      p.status === 'INVALIDADA'
        ? 'Esta embalagem foi invalidada por alteração técnica: aguarde nova aprovação.'
        : 'Esta embalagem já foi encerrada.',
    );
  if (!viewer.isManager && p.assigneeUserId !== viewer.userId)
    throw Errors.forbidden('Esta embalagem está com outra pessoa.');
  const location = await tx.itemLocation.findUnique({ where: { id: input.locationId } });
  if (!location?.active) throw Errors.business('Escolha um local ativo.');
  const now = new Date();
  if (p.taskId) {
    await lockTasks(tx, [p.taskId]);
    const t = await tx.productionTask.findUniqueOrThrow({ where: { id: p.taskId } });
    if (!['CONCLUIDA', 'CANCELADA'].includes(t.status)) {
      const u = await tx.productionTask.update({
        where: { id: t.id },
        data: {
          status: 'CONCLUIDA',
          startedAt: t.startedAt ?? now,
          completedAt: now,
          completedById: actor.userId,
          completedDeviceId: deviceId,
          completionNote: `${PROTECTION_LABEL[input.protection]} · ${location.label}${input.notes ? ` · ${input.notes}` : ''}`,
          progressPercent: 100,
          pauseImpediment: false,
          version: { increment: 1 },
        },
      });
      await taskEvent(tx, actor, deviceId, t, {
        kind: 'CONCLUIDA',
        from: t.status,
        to: 'CONCLUIDA',
        note: u.completionNote,
      });
      await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_COMPLETED, u);
    }
  }
  const u = await tx.packagingRecord.update({
    where: { id },
    data: {
      status: 'CONCLUIDA',
      protection: input.protection,
      locationId: location.id,
      notes: input.notes ?? null,
      startedAt: p.startedAt ?? now,
      completedAt: now,
      completedById: actor.userId,
      version: { increment: 1 },
    },
  });
  await moveItem(
    tx,
    actor,
    p.serviceOrderItemId,
    location.id,
    `Embalada (${packagingCode(p.number)})`,
    deviceId,
  );
  const code = packagingCode(p.number);
  await qualityEvent(tx, actor, p.serviceOrderItemId, {
    kind: 'EMBALADA',
    inspectionId: p.inspectionId,
    note: `${PROTECTION_LABEL[input.protection]} · ${location.label}${input.notes ? ` — ${input.notes}` : ''}`,
    deviceId,
  });
  await audit(tx, actor, {
    action: 'packaging.completed',
    entityType: 'packaging',
    entityId: id,
    summary: `${code} concluída (${pieceCode(p.serviceOrderItem)}): ${PROTECTION_LABEL[input.protection]}, ${location.label}.`,
  });
  await packagingEvent(tx, actor, u);
  await refreshItemStage(tx, actor, p.serviceOrderItemId);
  return u;
}

/** Aprovação invalidada → embalagem também (e a tarefa aberta é cancelada). */
export async function invalidatePackaging(
  tx: Tx,
  actor: ActorContext,
  inspectionId: string,
  reason: string,
) {
  const p = await tx.packagingRecord.findUnique({ where: { inspectionId } });
  if (!p || p.status === 'INVALIDADA' || p.status === 'CANCELADA') return;
  const locked = await lockPackaging(tx, p.id);
  const u = await tx.packagingRecord.update({
    where: { id: p.id },
    data: {
      status: 'INVALIDADA',
      invalidatedAt: new Date(),
      invalidReason: reason.slice(0, 500),
      version: { increment: 1 },
    },
  });
  if (locked.taskId) {
    await lockTasks(tx, [locked.taskId]);
    const t = await tx.productionTask.findUniqueOrThrow({ where: { id: locked.taskId } });
    if (!['CONCLUIDA', 'CANCELADA'].includes(t.status)) {
      const c = await tx.productionTask.update({
        where: { id: t.id },
        data: {
          status: 'CANCELADA',
          cancelReason: reason.slice(0, 500),
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
      await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, c);
      await notify(tx, actor, [
        {
          userId: t.assigneeUserId ?? '',
          kind: 'TAREFA_CANCELADA',
          dedupeKey: `TAREFA_CANCELADA:${t.id}`,
          body: `${taskCode(t.number)} · ${t.title} — ${reason}`,
          taskId: t.id,
          serviceOrderId: t.serviceOrderId,
        },
      ]);
    }
  }
  await qualityEvent(tx, actor, p.serviceOrderItemId, {
    kind: 'EMBALAGEM_INVALIDADA',
    inspectionId,
    note: reason,
  });
  await packagingEvent(tx, actor, u);
}

/** Gestor cancelou a tarefa de embalagem: o registro volta a aguardar um responsável. */
export async function packagingTaskCancelled(tx: Tx, actor: ActorContext, taskId: string) {
  const p = await tx.packagingRecord.findUnique({ where: { taskId } });
  if (!p || (p.status !== 'PENDENTE' && p.status !== 'EM_ANDAMENTO')) return;
  const u = await tx.packagingRecord.update({
    where: { id: p.id },
    data: {
      status: 'PENDENTE',
      taskId: null,
      assigneeUserId: null,
      startedAt: null,
      version: { increment: 1 },
    },
  });
  await qualityEvent(tx, actor, p.serviceOrderItemId, {
    kind: 'EMBALAGEM_SEM_RESPONSAVEL',
    inspectionId: p.inspectionId,
    note: 'Tarefa de embalagem cancelada: aguarda novo responsável.',
  });
  await packagingEvent(tx, actor, u);
  await refreshItemStage(tx, actor, p.serviceOrderItemId);
}
