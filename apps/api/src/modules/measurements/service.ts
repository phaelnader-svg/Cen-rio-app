import {
  EVENT_TYPES,
  anyPermissionAudience,
  formatServiceOrderItemCode,
  measurementCode,
  type EventAudience,
  type EventType,
  type MaterialRequestItemDto,
  type MaterialRequestItemInput,
  type MeasurementDetailDto,
  type MeasurementDto,
  type MeasurementSummaryDto,
  type Permission,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import { Errors } from '../../lib/errors';
import { dateOnly, serviceOrderCode, toCustomerSummary } from '../commercial/common';
import { refreshReadiness } from '../purchasing/common';

export const MANAGER_PERMS: Permission[] = [
  'medicoes.gerenciar',
  'materiais.ver',
  'materiais.aprovar',
];

export const summaryInclude = {
  serviceOrder: { include: { customer: true } },
  serviceOrderItem: true,
  assignee: { include: { employee: true } },
  requestedBy: { select: { displayName: true } },
  request: { include: { _count: { select: { items: true } } } },
} satisfies Prisma.MeasurementInclude;

type MeasurementWithSummary = Prisma.MeasurementGetPayload<{ include: typeof summaryInclude }>;

/** Hoje no fuso da empresa (AAAA-MM-DD). */
export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export function toSummary(m: MeasurementWithSummary, today: string): MeasurementSummaryDto {
  const due = dateOnly(m.dueDate)!;
  return {
    id: m.id,
    number: m.number,
    code: measurementCode(m.number),
    kind: m.kind,
    status: m.status,
    serviceOrder: { id: m.serviceOrderId, code: serviceOrderCode(m.serviceOrder.number) },
    customer: toCustomerSummary(m.serviceOrder.customer),
    serviceOrderItem: m.serviceOrderItem
      ? {
          id: m.serviceOrderItem.id,
          code: formatServiceOrderItemCode(m.serviceOrder.number, m.serviceOrderItem.position),
          description: m.serviceOrderItem.description,
        }
      : null,
    assignee: {
      userId: m.assigneeUserId,
      displayName: m.assignee.employee?.displayName ?? m.assignee.displayName,
      color: m.assignee.employee?.color ?? null,
    },
    requestedBy: m.requestedBy?.displayName ?? null,
    requestedAt: m.requestedAt.toISOString(),
    dueDate: due,
    overdue: (m.status === 'PENDENTE' || m.status === 'EM_ANDAMENTO') && due < today,
    reason: m.reason,
    completedAt: m.completedAt?.toISOString() ?? null,
    request: m.request
      ? {
          id: m.request.id,
          status: m.request.status,
          itemCount: m.request._count.items,
          version: m.request.version,
        }
      : null,
    version: m.version,
  };
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

export function itemToDto(
  i: Prisma.MaterialRequestItemGetPayload<{ include: { serviceOrderItem: true } }>,
  osNumber: number,
): MaterialRequestItemDto {
  return {
    id: i.id,
    serviceOrderItemId: i.serviceOrderItemId,
    itemCode: i.serviceOrderItem
      ? formatServiceOrderItemCode(osNumber, i.serviceOrderItem.position)
      : null,
    kind: i.kind,
    sourcing: i.sourcing,
    description: i.description,
    color: i.color,
    reference: i.reference,
    foamDensity: i.foamDensity,
    thicknessCm: num(i.thicknessCm),
    lengthCm: num(i.lengthCm),
    widthCm: num(i.widthCm),
    quantity: Number(i.quantity),
    unit: i.unit,
    notes: i.notes,
  };
}

export interface ActorInfo {
  userId: string;
  permissions: ReadonlySet<Permission>;
}

export function isManager(actor: ActorInfo) {
  return actor.permissions.has('medicoes.gerenciar');
}

export async function loadDetail(
  db: PrismaClient | Tx,
  id: string,
  actor: ActorInfo,
  today: string,
): Promise<MeasurementDetailDto> {
  const m = await db.measurement.findUnique({
    where: { id },
    include: {
      ...summaryInclude,
      serviceOrder: { include: { customer: true, items: { orderBy: { position: 'asc' } } } },
      pieces: { include: { serviceOrderItem: true } },
      request: {
        include: {
          _count: { select: { items: true } },
          items: { include: { serviceOrderItem: true }, orderBy: { position: 'asc' } },
        },
      },
      revisions: {
        include: { actor: { select: { displayName: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!m) throw Errors.notFound('Medição');
  const manager = isManager(actor);
  const own = m.assigneeUserId === actor.userId;
  if (
    !manager &&
    !own &&
    !actor.permissions.has('materiais.ver') &&
    !actor.permissions.has('materiais.aprovar')
  ) {
    // Executor só enxerga as medições atribuídas a ele.
    throw Errors.forbidden('Esta medição não está atribuída a você.');
  }
  const osNumber = m.serviceOrder.number;
  const active = m.status === 'PENDENTE' || m.status === 'EM_ANDAMENTO';
  const reqEditable =
    !m.request || m.request.status === 'RASCUNHO' || m.request.status === 'DEVOLVIDA';
  const canExecute = own && (manager || actor.permissions.has('medicoes.extraordinarias'));
  const targetItems = m.serviceOrderItemId
    ? m.serviceOrder.items.filter((i) => i.id === m.serviceOrderItemId)
    : m.serviceOrder.items;
  return {
    ...toSummary(m, today),
    serviceOrderInfo: {
      technicalInstructions: m.serviceOrder.technicalInstructions,
      notes: m.serviceOrder.notes,
      items: targetItems.map((i) => ({
        id: i.id,
        code: formatServiceOrderItemCode(osNumber, i.position),
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
        serviceType: i.serviceType,
        fabricName: i.fabricName,
        fabricColor: i.fabricColor,
        fabricReference: i.fabricReference,
        foamSpecs: i.foamSpecs,
        technicalNotes: i.technicalNotes,
        currentDimensions: Array.isArray(i.measurements)
          ? (i.measurements as unknown as MeasurementDto[])
          : [],
      })),
    },
    pieces: m.pieces.map((p) => ({
      serviceOrderItemId: p.serviceOrderItemId,
      itemCode: formatServiceOrderItemCode(osNumber, p.serviceOrderItem.position),
      dimensions: Array.isArray(p.dimensions) ? (p.dimensions as unknown as MeasurementDto[]) : [],
      notes: p.notes,
    })),
    notes: m.notes,
    startedAt: m.startedAt?.toISOString() ?? null,
    cancelledAt: m.cancelledAt?.toISOString() ?? null,
    cancelReason: m.cancelReason,
    items: m.request?.items.map((i) => itemToDto(i, osNumber)) ?? [],
    returnReason: m.request?.status === 'DEVOLVIDA' ? m.request.returnReason : null,
    revisions: m.revisions.map((r) => ({
      id: r.id,
      kind: r.kind,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      note: r.note,
      changes: r.changes,
      actor: r.actor?.displayName ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    can: {
      edit:
        canExecute &&
        (active || m.request?.status === 'DEVOLVIDA') &&
        reqEditable &&
        m.status !== 'CANCELADA',
      submit:
        canExecute &&
        (active || m.request?.status === 'DEVOLVIDA') &&
        reqEditable &&
        m.status !== 'CANCELADA',
      reassign: manager && active,
      cancel: manager && m.status !== 'CANCELADA' && m.request?.status !== 'APROVADA',
      review:
        actor.permissions.has('materiais.aprovar') &&
        ['ENVIADA', 'EM_REVISAO', 'APROVADA'].includes(m.request?.status ?? ''),
    },
  };
}

/** Audiência: gestão + executor(es) envolvido(s). */
export function audienceFor(...userIds: (string | null | undefined)[]): EventAudience {
  const users = [...new Set(userIds.filter(Boolean))].map((u) => `user:${u}`);
  return [anyPermissionAudience(...MANAGER_PERMS), ...users].join('|') as EventAudience;
}

export async function record(
  tx: Tx,
  request: FastifyRequest,
  m: { id: string; number: number; assigneeUserId: string },
  entry: {
    kind: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
    changes?: object | null;
    summary: string;
    event: EventType;
    extraUsers?: string[];
  },
) {
  const actor = actorFrom(request);
  await tx.measurementRevision.create({
    data: {
      measurementId: m.id,
      kind: entry.kind,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus ?? null,
      note: entry.note ?? null,
      changes: (entry.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      actorId: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: `measurement.${entry.kind.toLowerCase()}`,
    entityType: 'measurement',
    entityId: m.id,
    summary: entry.summary,
    changes: entry.changes ?? undefined,
  });
  const current = await tx.measurement.findUniqueOrThrow({
    where: { id: m.id },
    include: { request: true },
  });
  // Fase 4: medições e aprovações mudam a prontidão de materiais da OS.
  await refreshReadiness(tx, actor, [current.serviceOrderId]);
  await appendEvent(tx, actor, {
    type: entry.event,
    aggregateType: 'measurement',
    aggregateId: m.id,
    payload: {
      id: m.id,
      code: measurementCode(m.number),
      status: current.status,
      requestStatus: current.request?.status ?? null,
      assigneeUserId: current.assigneeUserId,
      serviceOrderId: current.serviceOrderId,
      version: current.version,
    },
    audience: audienceFor(current.assigneeUserId, ...(entry.extraUsers ?? [])),
  });
}

/** Bloqueia a medição (e a solicitação) para atualização consistente. */
export async function lockMeasurement(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM measurements WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Medição');
  await tx.$queryRaw`SELECT id FROM material_requests WHERE measurement_id = ${id}::uuid FOR UPDATE`;
  return tx.measurement.findUniqueOrThrow({
    where: { id },
    include: {
      request: { include: { items: { orderBy: { position: 'asc' } } } },
      serviceOrder: { include: { items: true } },
    },
  });
}

/** Valida e grava os itens da solicitação (substituição completa). */
export async function replaceItems(
  tx: Tx,
  requestId: string,
  osItemIds: Set<string>,
  items: (MaterialRequestItemInput & { quantity: number })[],
) {
  for (const it of items) {
    if (it.serviceOrderItemId && !osItemIds.has(it.serviceOrderItemId)) {
      throw Errors.validation(
        undefined,
        'O material indica uma peça que não pertence a esta medição/OS.',
      );
    }
  }
  await tx.materialRequestItem.deleteMany({ where: { requestId } });
  let position = 0;
  for (const it of items) {
    await tx.materialRequestItem.create({
      data: {
        requestId,
        position: ++position,
        serviceOrderItemId: it.serviceOrderItemId ?? null,
        kind: it.kind,
        sourcing: it.sourcing,
        description: it.description,
        color: it.color ?? null,
        reference: it.reference ?? null,
        foamDensity: it.foamDensity ?? null,
        thicknessCm: it.thicknessCm ?? null,
        lengthCm: it.lengthCm ?? null,
        widthCm: it.widthCm ?? null,
        quantity: it.quantity,
        unit: it.unit,
        notes: it.notes ?? null,
      },
    });
  }
}

/** Cópia legível dos itens para o histórico. */
export function snapshotItems(
  items: {
    kind: string;
    description: string;
    color: string | null;
    quantity: Prisma.Decimal | number;
    unit: string;
    serviceOrderItemId: string | null;
    foamDensity?: string | null;
    thicknessCm?: Prisma.Decimal | number | null;
  }[],
) {
  return items.map((i) => ({
    kind: i.kind,
    description: i.description,
    color: i.color,
    foamDensity: i.foamDensity ?? null,
    thicknessCm:
      i.thicknessCm === null || i.thicknessCm === undefined ? null : Number(i.thicknessCm),
    quantity: Number(i.quantity),
    unit: i.unit,
    serviceOrderItemId: i.serviceOrderItemId,
  }));
}

/** Usuários aptos a receber medições: ativos, com permissão de executar ou gerenciar. */
export async function eligibleAssignee(db: PrismaClient | Tx, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, include: { employee: true } });
  if (!user || !user.active || (user.employee && !user.employee.active)) return null;
  const perms = await loadUserPermissions(db, userId);
  const manager = perms.has('medicoes.gerenciar');
  if (!manager && !perms.has('medicoes.extraordinarias')) return null;
  return { user, manager };
}

export { EVENT_TYPES };
