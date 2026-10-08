import {
  EVENT_TYPES,
  TASK_WAITING,
  anyPermissionAudience,
  evaluateRelease,
  formatServiceOrderItemCode,
  localParts,
  taskCode,
  type EventType,
  type ProductionTaskDto,
  type TaskRefDto,
  type TaskStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { onReadinessChanged, readinessOf } from '../purchasing/common';

// ─────────────────────────── Acesso ───────────────────────────

export const PLAN = { session: 'WEB', permissions: ['producao.planejar'] } as const;
export const VIEW = {
  session: 'WEB',
  anyPermissions: ['producao.ver', 'producao.planejar'],
} as const;
export const EXECUTE = { session: 'any', permissions: ['producao.executar'] } as const;
export const READ_TASK = {
  session: 'any',
  anyPermissions: ['producao.ver', 'producao.planejar', 'producao.executar'],
} as const;

export const MANAGEMENT = anyPermissionAudience('producao.ver', 'producao.planejar');
export const audienceFor = (...userIds: (string | null | undefined)[]) =>
  [MANAGEMENT, ...[...new Set(userIds.filter(Boolean))].map((u) => `user:${u}`)].join(
    '|',
  ) as typeof MANAGEMENT;

export const canManage = (request: FastifyRequest) =>
  request.auth?.permissions.has('producao.planejar') ?? false;
export const canViewAll = (request: FastifyRequest) =>
  canManage(request) || (request.auth?.permissions.has('producao.ver') ?? false);

export async function company(db: Tx | PrismaClient) {
  const c = await db.companySettings.findUnique({ where: { id: 1 } });
  return {
    timezone: c?.timezone ?? 'America/Sao_Paulo',
    workdayStart: c?.workdayStart ?? '08:30',
    planningWeekday: c?.planningWeekday ?? 5,
  };
}

// ─────────────────────────── DTO ───────────────────────────

const refSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  assignee: { select: { displayName: true } },
} as const;

export const taskInclude = {
  plan: { select: { id: true, weekStart: true, status: true } },
  serviceOrder: {
    select: {
      id: true,
      number: true,
      promisedDate: true,
      status: true,
      customer: { select: { name: true } },
    },
  },
  serviceOrderItem: { select: { id: true, position: true, description: true } },
  assignee: { select: { id: true, displayName: true, employee: { select: { color: true } } } },
  dependsOn: { include: { dependsOn: { select: refSelect } } },
  dependents: { include: { task: { select: refSelect } } },
} as const;
export type TaskRow = Prisma.ProductionTaskGetPayload<{ include: typeof taskInclude }>;

const toRef = (t: {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  assignee: { displayName: string } | null;
}): TaskRefDto => ({
  id: t.id,
  code: taskCode(t.number),
  title: t.title,
  status: t.status,
  assignee: t.assignee?.displayName ?? null,
});

export function toTaskDto(t: TaskRow, timeZone: string): ProductionTaskDto {
  const local = t.scheduledAt ? localParts(t.scheduledAt, timeZone) : null;
  return {
    id: t.id,
    number: t.number,
    code: taskCode(t.number),
    plan: t.plan
      ? { id: t.plan.id, weekStart: dateOnly(t.plan.weekStart)!, status: t.plan.status }
      : null,
    serviceOrder: {
      id: t.serviceOrder.id,
      code: serviceOrderCode(t.serviceOrder.number),
      promisedDate: dateOnly(t.serviceOrder.promisedDate),
    },
    customerName: t.serviceOrder.customer.name,
    serviceOrderItem: t.serviceOrderItem
      ? {
          id: t.serviceOrderItem.id,
          code: formatServiceOrderItemCode(t.serviceOrder.number, t.serviceOrderItem.position),
          description: t.serviceOrderItem.description,
        }
      : null,
    activity: t.activity,
    title: t.title,
    role: t.role,
    assignee: t.assignee
      ? {
          userId: t.assignee.id,
          displayName: t.assignee.displayName,
          color: t.assignee.employee?.color ?? '#1d4a45',
        }
      : null,
    priority: t.priority,
    sequence: t.sequence,
    scheduledAt: t.scheduledAt?.toISOString() ?? null,
    scheduledDate: local?.date ?? null,
    scheduledTime: local?.time ?? null,
    dueDate: dateOnly(t.dueDate),
    instructions: t.instructions,
    requiresMaterials: t.requiresMaterials,
    status: t.status,
    blockers: t.blockers as ProductionTaskDto['blockers'],
    blockedReason: t.blockedReason,
    dependsOn: t.dependsOn.map((d) => toRef(d.dependsOn)),
    dependents: t.dependents.map((d) => toRef(d.task)),
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    pauseReason: t.pauseReason,
    pauseNote: t.pauseNote,
    lastProgress:
      t.progressNote && t.progressAt
        ? { note: t.progressNote, percent: t.progressPercent, at: t.progressAt.toISOString() }
        : null,
    version: t.version,
  };
}

// ─────────────────────────── Bloqueios e histórico ───────────────────────────

export async function lockTasks(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await tx.$queryRaw`SELECT id FROM production_tasks WHERE id = ${id}::uuid FOR UPDATE`;
  }
}

export async function lockPlan(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM production_plans WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Planejamento');
  return tx.productionPlan.findUniqueOrThrow({ where: { id } });
}

export async function taskEvent(
  tx: Tx,
  actor: ActorContext,
  deviceId: string | null,
  task: { id: string },
  entry: {
    kind: string;
    from?: string | null;
    to?: string | null;
    note?: string | null;
    changes?: object;
  },
) {
  await tx.productionTaskEvent.create({
    data: {
      taskId: task.id,
      kind: entry.kind,
      fromStatus: entry.from ?? null,
      toStatus: entry.to ?? null,
      note: entry.note ?? null,
      changes: (entry.changes as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
      deviceId,
    },
  });
}

export async function domainTaskEvent(
  tx: Tx,
  actor: ActorContext,
  type: EventType,
  task: {
    id: string;
    number: number;
    status: string;
    assigneeUserId: string | null;
    serviceOrderId: string;
  },
  extra: Record<string, unknown> = {},
  extraUsers: (string | null)[] = [],
) {
  await appendEvent(tx, actor, {
    type,
    aggregateType: 'production_task',
    aggregateId: task.id,
    payload: {
      id: task.id,
      code: taskCode(task.number),
      status: task.status,
      serviceOrderId: task.serviceOrderId,
      assigneeUserId: task.assigneeUserId,
      ...extra,
    } as Prisma.InputJsonValue,
    audience: audienceFor(task.assigneeUserId, ...extraUsers),
  });
}

// ─────────────────────────── Liberação ───────────────────────────

/**
 * Reavalia (com bloqueio) as tarefas que aguardam início e grava a transição
 * Bloqueada ⇄ Programada ⇄ Liberada quando muda, com histórico e evento. É a
 * única forma de uma tarefa ficar "Liberada": nenhuma mensagem do cliente ou
 * evento fora de ordem libera tarefas — tudo é recalculado do banco aqui.
 */
export async function reevaluateTasks(
  tx: Tx,
  actor: ActorContext,
  taskIds: string[],
  now = new Date(),
) {
  if (!taskIds.length) return;
  await lockTasks(tx, taskIds);
  const materials = new Map<string, boolean>();
  for (const id of [...new Set(taskIds)].sort()) {
    const t = await tx.productionTask.findUnique({
      where: { id },
      include: {
        plan: { select: { status: true } },
        serviceOrder: {
          select: {
            status: true,
            items: { select: { id: true, orderItem: { select: { receivedQuantity: true } } } },
          },
        },
        dependsOn: { include: { dependsOn: { select: { status: true } } } },
      },
    });
    if (!t || !(TASK_WAITING as readonly string[]).includes(t.status)) continue;
    let materialsReady = true;
    if (t.requiresMaterials) {
      if (!materials.has(t.serviceOrderId)) {
        materials.set(
          t.serviceOrderId,
          (await readinessOf(tx, t.serviceOrderId)).state === 'COMPLETO',
        );
      }
      materialsReady = materials.get(t.serviceOrderId)!;
    }
    const items = t.serviceOrderItemId
      ? t.serviceOrder.items.filter((i) => i.id === t.serviceOrderItemId)
      : t.serviceOrder.items;
    const result = evaluateRelease({
      osActive: t.serviceOrder.status === 'ABERTA',
      pieceReceived: items.length > 0 && items.every((i) => i.orderItem.receivedQuantity > 0),
      published: t.plan?.status === 'PUBLICADO',
      assigned: Boolean(t.assigneeUserId),
      // Etapa cancelada (não aplicável) não segura as seguintes.
      dependenciesDone: t.dependsOn.every(
        (d) => d.dependsOn.status === 'CONCLUIDA' || d.dependsOn.status === 'CANCELADA',
      ),
      materialsReady,
      requiresMaterials: t.requiresMaterials,
      manuallyBlocked: Boolean(t.blockedReason),
      scheduledAt: t.scheduledAt,
      now,
    });
    const sameBlockers =
      result.blockers.length === t.blockers.length &&
      result.blockers.every((b) => t.blockers.includes(b));
    if (result.status === t.status && sameBlockers) continue;
    const updated = await tx.productionTask.update({
      where: { id },
      data: { status: result.status, blockers: result.blockers, version: { increment: 1 } },
    });
    if (result.status === t.status) continue;
    await taskEvent(tx, actor, null, t, {
      kind:
        result.status === 'LIBERADA'
          ? 'LIBERADA'
          : result.status === 'BLOQUEADA'
            ? 'BLOQUEADA'
            : 'PROGRAMADA',
      from: t.status,
      to: result.status,
      changes: { blockers: result.blockers },
    });
    await domainTaskEvent(
      tx,
      actor,
      result.status === 'LIBERADA'
        ? EVENT_TYPES.PRODUCTION_TASK_RELEASED
        : result.status === 'BLOQUEADA'
          ? EVENT_TYPES.PRODUCTION_TASK_BLOCKED
          : EVENT_TYPES.PRODUCTION_DEPENDENCIES_UPDATED,
      updated,
      { from: t.status, blockers: result.blockers },
    );
  }
}

/** Tarefas que aguardam início de uma OS (para reavaliar após mudanças na OS/materiais). */
export async function waitingTaskIds(
  tx: Tx | PrismaClient,
  where: Prisma.ProductionTaskWhereInput,
) {
  const rows = await tx.productionTask.findMany({
    where: { ...where, status: { in: [...TASK_WAITING] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// Mudança de prontidão de materiais (Fase 4) reavalia as tarefas que exigem materiais.
onReadinessChanged(async (tx, actor, serviceOrderId) => {
  await reevaluateTasks(
    tx,
    actor,
    await waitingTaskIds(tx, { serviceOrderId, requiresMaterials: true }),
  );
});

/**
 * Libera as tarefas cujo horário programado chegou (executado periodicamente e
 * idempotente: tarefas já liberadas não geram novos eventos).
 */
export async function releaseDueTasks(prisma: PrismaClient, now = new Date()) {
  const due = await prisma.productionTask.findMany({
    where: { status: 'PROGRAMADA', scheduledAt: { lte: now } },
    select: { id: true },
    take: 500,
  });
  if (!due.length) return 0;
  const system: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
  await prisma.$transaction(async (tx) => {
    await reevaluateTasks(
      tx,
      system,
      due.map((d) => d.id),
      now,
    );
    await audit(tx, system, {
      action: 'production.release_tick',
      entityType: 'production_task',
      summary: `${due.length} tarefa(s) reavaliada(s) pelo horário programado.`,
    });
  });
  return due.length;
}
