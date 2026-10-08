import {
  EVENT_TYPES,
  LOGISTICS_KIND_LABEL,
  anyPermissionAudience,
  deliveryCode,
  logisticsCode,
  type LogisticsKind,
  type LogisticsOccurrenceDto,
  type LogisticsStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { pickupCode } from '../commercial/common';
import { notify } from '../notifications/notify';
import { pieceCode, pieceInclude, refreshItemStage } from './common';

export const occurrenceInclude = {
  delivery: { select: { id: true, number: true } },
  pickup: { select: { id: true, number: true } },
  item: { include: pieceInclude },
  responsible: { select: { id: true, displayName: true } },
  reportedBy: { select: { displayName: true } },
  events: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.LogisticsOccurrenceInclude;
type OccurrenceRow = Prisma.LogisticsOccurrenceGetPayload<{ include: typeof occurrenceInclude }>;

export async function toOccurrenceDto(
  db: Tx | PrismaClient,
  r: OccurrenceRow,
): Promise<LogisticsOccurrenceDto> {
  const actors = new Map(
    (
      await db.user.findMany({
        where: { id: { in: r.events.map((e) => e.actorId).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  return {
    id: r.id,
    number: r.number,
    code: logisticsCode(r.number),
    kind: r.kind as LogisticsKind,
    status: r.status as LogisticsStatus,
    description: r.description,
    blocksShipping: r.blocksShipping,
    delivery: r.delivery ? { id: r.delivery.id, code: deliveryCode(r.delivery.number) } : null,
    pickup: r.pickup ? { id: r.pickup.id, code: pickupCode(r.pickup.number) } : null,
    piece: r.item
      ? { id: r.item.id, code: pieceCode(r.item), description: r.item.description }
      : null,
    responsible: r.responsible
      ? { userId: r.responsible.id, displayName: r.responsible.displayName }
      : null,
    reportedBy: r.reportedBy?.displayName ?? null,
    resolution: r.resolution,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    events: r.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      actor: e.actorId ? (actors.get(e.actorId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
    })),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function lockOccurrence(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM logistics_occurrences WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Ocorrência logística');
  return tx.logisticsOccurrence.findUniqueOrThrow({ where: { id }, include: occurrenceInclude });
}

async function affectedItems(
  tx: Tx,
  o: { serviceOrderItemId: string | null; deliveryId: string | null },
) {
  if (o.serviceOrderItemId) return [o.serviceOrderItemId];
  if (!o.deliveryId) return [];
  return (
    await tx.deliveryItem.findMany({
      where: { deliveryId: o.deliveryId, active: true },
      select: { serviceOrderItemId: true },
    })
  ).map((x) => x.serviceOrderItemId);
}

async function changed(
  tx: Tx,
  actor: ActorContext,
  o: OccurrenceRow,
  to: LogisticsStatus,
  data: Prisma.LogisticsOccurrenceUpdateInput,
  note: string | null,
  kind: string,
) {
  const u = await tx.logisticsOccurrence.update({
    where: { id: o.id },
    data: { ...data, status: to, version: { increment: 1 } },
  });
  await tx.logisticsOccurrenceEvent.create({
    data: {
      occurrenceId: o.id,
      kind,
      fromStatus: o.status,
      toStatus: to,
      note,
      actorId: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: `logistics.occurrence_${kind.toLowerCase()}`,
    entityType: 'logistics_occurrence',
    entityId: o.id,
    summary: `${logisticsCode(o.number)} (${LOGISTICS_KIND_LABEL[o.kind as LogisticsKind]}): ${kind.toLowerCase()}${note ? ` — ${note}` : ''}.`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.LOGISTICS_OCCURRENCE_UPDATED,
    aggregateType: 'logistics_occurrence',
    aggregateId: o.id,
    payload: { id: o.id, code: logisticsCode(o.number), status: to, kind: o.kind },
    audience: anyPermissionAudience('entregas.ver', 'entregas.gerenciar', 'ocorrencias.ver'),
  });
  for (const itemId of await affectedItems(tx, o)) await refreshItemStage(tx, actor, itemId);
  return u;
}

export async function assignOccurrence(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { responsibleUserId: string; note?: string | null; version: number },
) {
  const o = await lockOccurrence(tx, id);
  if (o.version !== input.version) throw Errors.versionConflict(o.version);
  if (o.status !== 'ABERTA' && o.status !== 'EM_TRATAMENTO')
    throw Errors.business('Ocorrência encerrada.');
  const user = await tx.user.findUnique({ where: { id: input.responsibleUserId } });
  if (!user?.active) throw Errors.business('Responsável inválido.');
  const u = await changed(
    tx,
    actor,
    o,
    'EM_TRATAMENTO',
    { responsible: { connect: { id: user.id } } },
    `${user.displayName}${input.note ? `: ${input.note}` : ''}`,
    'ATRIBUIDA',
  );
  await notify(tx, actor, [
    {
      userId: user.id,
      kind: 'OCORRENCIA_LOGISTICA',
      dedupeKey: `OCORRENCIA_LOGISTICA:${o.id}:${user.id}`,
      body: `${logisticsCode(o.number)} · ${LOGISTICS_KIND_LABEL[o.kind as LogisticsKind]}: ${o.description}${input.note ? ` — ${input.note}` : ''}`,
    },
  ]);
  return u;
}

export async function resolveOccurrence(
  tx: Tx,
  actor: ActorContext,
  viewer: { userId: string; isManager: boolean },
  id: string,
  input: { resolution: string; version: number },
) {
  const o = await lockOccurrence(tx, id);
  if (o.status === 'RESOLVIDA') return o;
  if (o.version !== input.version) throw Errors.versionConflict(o.version);
  if (!viewer.isManager && o.responsibleUserId !== viewer.userId)
    throw Errors.forbidden('Só o gestor ou o responsável encerram a ocorrência.');
  if (o.status === 'CANCELADA') throw Errors.business('Ocorrência cancelada.');
  return changed(
    tx,
    actor,
    o,
    'RESOLVIDA',
    { resolution: input.resolution, resolvedAt: new Date(), resolvedById: actor.userId },
    input.resolution,
    'RESOLVIDA',
  );
}

export async function cancelOccurrence(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  const o = await lockOccurrence(tx, id);
  if (o.status === 'CANCELADA') return o;
  if (o.version !== input.version) throw Errors.versionConflict(o.version);
  if (o.status === 'RESOLVIDA') throw Errors.business('Ocorrência já resolvida.');
  return changed(
    tx,
    actor,
    o,
    'CANCELADA',
    { cancelReason: input.reason },
    input.reason,
    'CANCELADA',
  );
}
