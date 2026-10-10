import {
  DELIVERY_ACTIVE,
  DELIVERY_STATUS_LABEL,
  EVENT_TYPES,
  FULFILLMENT_STAGE_LABEL,
  LOGISTICS_KIND_LABEL,
  READINESS_CHECK_LABEL,
  anyPermissionAudience,
  blocksShippingByDefault,
  canDeliveryTransition,
  deliveryCode,
  logisticsCode,
  regionOf,
  type AddressSnapshot,
  type DeliveryAddressDto,
  type DeliveryDto,
  type DeliveryItemStatus,
  type DeliveryStatus,
  type FulfillmentStage,
  type LogisticsJobDto,
  type LogisticsKind,
  type PickupTeam,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import {
  activeAddress,
  asSnapshot,
  dateOnly,
  parseDateOnly,
  snapshotAddress,
} from '../commercial/common';
import { notify } from '../notifications/notify';
import {
  moveItemToKey,
  notifyUsersWith,
  pieceCode,
  pieceInclude,
  readinessOfItem,
  refreshItemStage,
  usersWith,
} from './common';
import { syncTripCost } from '../finance/trip-costs';

type AddressInput = {
  street: string;
  number: string;
  complement?: string | null;
  district?: string | null;
  city: string;
  state: string;
  postalCode?: string | null;
  reference?: string | null;
};

export const DELIVERY_AUDIENCE = anyPermissionAudience('entregas.ver', 'entregas.gerenciar');
export const deliveryAudience = (...users: (string | null | undefined)[]) =>
  [DELIVERY_AUDIENCE, ...[...new Set(users.filter(Boolean))].map((u) => `user:${u}`)].join(
    '|',
  ) as typeof DELIVERY_AUDIENCE;

export const deliveryInclude = {
  customer: { select: { id: true, name: true } },
  responsible: { select: { id: true, displayName: true } },
  items: {
    include: { serviceOrderItem: { include: pieceInclude } },
    orderBy: { serviceOrderItemId: 'asc' },
  },
  events: {
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.DeliveryInclude;
export type DeliveryRow = Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>;

const addressDto = (s: AddressSnapshot | null): DeliveryAddressDto | null =>
  s
    ? {
        street: s.street,
        number: s.number,
        complement: s.complement,
        district: s.district,
        city: s.city,
        state: s.state,
        postalCode: s.postalCode,
        reference: s.reference,
      }
    : null;

export async function toDeliveryDto(db: Tx | PrismaClient, r: DeliveryRow): Promise<DeliveryDto> {
  const address = asSnapshot(r.addressSnapshot)!;
  const [openOccurrences, photos] = await Promise.all([
    db.logisticsOccurrence.count({
      where: { deliveryId: r.id, status: { in: ['ABERTA', 'EM_TRATAMENTO'] } },
    }),
    db.attachment.count({ where: { entityType: 'DELIVERY', entityId: r.id, deletedAt: null } }),
  ]);
  const items = r.items.filter((i) => i.active || r.status === 'CONCLUIDA');
  return {
    id: r.id,
    number: r.number,
    code: deliveryCode(r.number),
    status: r.status,
    provisional: r.status === 'PROVISORIA',
    customer: r.customer,
    address: addressDto(address)!,
    region: regionOf(address),
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    scheduledDate: dateOnly(r.scheduledDate)!,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    team: r.team,
    responsible: r.responsible
      ? { userId: r.responsible.id, displayName: r.responsible.displayName }
      : null,
    requiresInstallation: r.requiresInstallation,
    instructions: r.instructions,
    notes: r.notes,
    attempts: r.attempts,
    departedAt: r.departedAt?.toISOString() ?? null,
    arrivedAt: r.arrivedAt?.toISOString() ?? null,
    installedAt: r.installedAt?.toISOString() ?? null,
    installationNote: r.installationNote,
    completedAt: r.completedAt?.toISOString() ?? null,
    completionNote: r.completionNote,
    cancelReason: r.cancelReason,
    items: items.map((i) => ({
      serviceOrderItemId: i.serviceOrderItemId,
      code: pieceCode(i.serviceOrderItem),
      description: i.serviceOrderItem.description,
      pieceType: i.serviceOrderItem.pieceType,
      quantity: i.serviceOrderItem.quantity,
      stage: i.serviceOrderItem.fulfillmentStage as FulfillmentStage,
      ready: ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE', 'ENTREGUE'].includes(
        i.serviceOrderItem.fulfillmentStage,
      ),
      status: i.status as DeliveryItemStatus,
      note: i.note,
      deliveredAt: i.deliveredAt?.toISOString() ?? null,
    })),
    events: r.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      actor: e.actor?.displayName ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    openOccurrences,
    photos,
    version: r.version,
  };
}

/** Visão da logística terceirizada: nada de valores, margens ou dados comerciais. */
export function toDeliveryJob(r: DeliveryRow): LogisticsJobDto {
  return {
    id: r.id,
    kind: 'ENTREGA',
    code: deliveryCode(r.number),
    status: r.status,
    customerName: r.customer.name,
    address: addressDto(asSnapshot(r.addressSnapshot)),
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    scheduledDate: dateOnly(r.scheduledDate),
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    requiresInstallation: r.requiresInstallation,
    instructions: r.instructions,
    pieces: r.items
      .filter((i) => i.active)
      .map((i) => ({
        id: i.serviceOrderItemId,
        code: pieceCode(i.serviceOrderItem),
        description: i.serviceOrderItem.description,
        quantity: i.serviceOrderItem.quantity,
        status: i.status,
      })),
    departedAt: r.departedAt?.toISOString() ?? null,
    arrivedAt: r.arrivedAt?.toISOString() ?? null,
    installedAt: r.installedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    version: r.version,
  };
}

export async function lockDelivery(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM deliveries WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Entrega');
  return tx.delivery.findUniqueOrThrow({ where: { id }, include: deliveryInclude });
}

export async function deliveryEvent(
  tx: Tx,
  actor: ActorContext,
  deliveryId: string,
  entry: {
    kind: string;
    from?: string | null;
    to?: string | null;
    note?: string | null;
    data?: unknown;
    deviceId?: string | null;
  },
) {
  await tx.deliveryEvent.create({
    data: {
      deliveryId,
      kind: entry.kind,
      fromStatus: entry.from ?? null,
      toStatus: entry.to ?? null,
      note: entry.note?.slice(0, 1000) ?? null,
      data: (entry.data as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
      deviceId: entry.deviceId ?? null,
    },
  });
}

export async function deliveryDomainEvent(
  tx: Tx,
  actor: ActorContext,
  d: {
    id: string;
    number: number;
    status: string;
    responsibleUserId: string | null;
    version: number;
  },
) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.DELIVERY_UPDATED,
    aggregateType: 'delivery',
    aggregateId: d.id,
    payload: { id: d.id, code: deliveryCode(d.number), status: d.status, version: d.version },
    audience: deliveryAudience(d.responsibleUserId),
  });
}

/**
 * Peça de uma entrega deixou de estar liberada (reprovada, aprovação invalidada, bloqueio):
 * a entrega confirmada volta a provisória (o gestor decide) e o histórico registra o motivo.
 */
export async function flagDeliveryForItem(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  note: string,
  demote: boolean,
) {
  const di = await tx.deliveryItem.findFirst({
    where: { serviceOrderItemId: itemId, active: true },
    include: { delivery: true },
  });
  if (!di || !DELIVERY_ACTIVE.includes(di.delivery.status)) return;
  const d = await lockDelivery(tx, di.deliveryId);
  if (demote && d.status === 'AGENDADA') {
    const u = await tx.delivery.update({
      where: { id: d.id },
      data: { status: 'PROVISORIA', version: { increment: 1 } },
    });
    await deliveryEvent(tx, actor, d.id, {
      kind: 'VOLTOU_PROVISORIA',
      from: 'AGENDADA',
      to: 'PROVISORIA',
      note: `${note} A entrega volta a provisória até a peça ser liberada de novo.`,
    });
    await deliveryDomainEvent(tx, actor, u);
    await notifyUsersWith(
      tx,
      actor,
      'entregas.gerenciar',
      'OCORRENCIA_LOGISTICA',
      `ENTREGA_PROVISORIA:${d.id}:${u.version}`,
      `${deliveryCode(d.number)} (${d.customer.name}) voltou a provisória: ${note}`,
    );
  } else {
    await deliveryEvent(tx, actor, d.id, { kind: 'PECA_ALTERADA', note });
  }
}

// ─────────────────────────── Agenda (gestor) ───────────────────────────

async function assertResponsible(tx: Tx, userId: string | null | undefined, team: PickupTeam) {
  if (!userId) return null;
  const user = await tx.user.findUnique({ where: { id: userId }, include: { employee: true } });
  if (!user?.active || !user.employee?.active) throw Errors.business('Responsável inválido.');
  const perms = await loadUserPermissions(tx, userId);
  if (team === 'LOGISTICA_TERCEIRIZADA' && !perms.has('logistica.executar'))
    throw Errors.business(
      `${user.displayName} não é da logística terceirizada (permissão de executar retiradas e entregas).`,
    );
  if (!perms.has('logistica.executar') && !perms.has('producao.executar'))
    throw Errors.business(`${user.displayName} não executa entregas.`);
  return user;
}

async function deliveryAddress(
  tx: Tx,
  customerId: string,
  input: { addressId?: string | null; address?: AddressInput | null },
): Promise<{ addressId: string | null; snapshot: AddressSnapshot }> {
  if (input.addressId) {
    const a = await activeAddress(tx, customerId, input.addressId);
    return { addressId: a.id, snapshot: snapshotAddress(a) };
  }
  if (input.address) {
    return {
      addressId: null,
      snapshot: {
        label: 'Entrega',
        street: input.address.street,
        number: input.address.number,
        complement: input.address.complement ?? null,
        district: input.address.district ?? null,
        city: input.address.city,
        state: input.address.state,
        postalCode: input.address.postalCode ?? null,
        reference: input.address.reference ?? null,
      },
    };
  }
  const primary = await tx.customerAddress.findFirst({
    where: { customerId, archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  if (!primary) throw Errors.business('Informe o endereço de entrega.');
  return { addressId: primary.id, snapshot: snapshotAddress(primary) };
}

/** Peças da entrega: do cliente, OS ativa, ainda não entregues e fora de outra entrega ativa. */
async function validatePieces(tx: Tx, customerId: string, itemIds: string[], deliveryId?: string) {
  const ids = [...new Set(itemIds)];
  for (const id of [...ids].sort())
    await tx.$queryRaw`SELECT id FROM service_order_items WHERE id = ${id}::uuid FOR UPDATE`;
  const items = await tx.serviceOrderItem.findMany({
    where: { id: { in: ids } },
    include: pieceInclude,
  });
  if (items.length !== ids.length) throw Errors.business('Peça inválida.');
  for (const i of items) {
    const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id: i.serviceOrderId } });
    if (so.customerId !== customerId) throw Errors.business(`${pieceCode(i)} é de outro cliente.`);
    if (so.status !== 'ABERTA') throw Errors.business(`${pieceCode(i)}: a OS não está ativa.`);
    if (['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'].includes(i.fulfillmentStage))
      throw Errors.business(
        `${pieceCode(i)}: ${FULFILLMENT_STAGE_LABEL[i.fulfillmentStage as FulfillmentStage].toLowerCase()}.`,
      );
    const other = await tx.deliveryItem.findFirst({
      where: {
        serviceOrderItemId: i.id,
        active: true,
        ...(deliveryId ? { deliveryId: { not: deliveryId } } : {}),
      },
      include: { delivery: { select: { number: true } } },
    });
    if (other)
      throw Errors.conflict(
        `${pieceCode(i)} já está na entrega ${deliveryCode(other.delivery.number)}.`,
      );
  }
  return items;
}

/** Confirmação definitiva só com todas as peças liberadas (pronto para entrega). */
async function assertAllReady(tx: Tx, itemIds: string[]) {
  const problems: string[] = [];
  for (const id of itemIds) {
    const r = await readinessOfItem(tx, id);
    if (!r.readiness.ready)
      problems.push(
        `${pieceCode(r.item)}: ${r.readiness.missing.map((m) => READINESS_CHECK_LABEL[m].toLowerCase()).join(', ')}`,
      );
  }
  if (problems.length)
    throw Errors.business(
      `Há peças ainda não liberadas para entrega — ${problems.join('; ')}. Use o pré-agendamento provisório (sem confirmação ao cliente).`,
      { problems },
    );
}

/** Correção global: compromisso confirmado com o cliente = data + HORÁRIO DE CHEGADA. */
function requireArrival(provisional: boolean, windowStart: string | null | undefined) {
  if (!provisional && !windowStart)
    throw Errors.validation(
      [{ path: 'windowStart', message: 'Informe o horário de chegada ao cliente.' }],
      'Informe o horário de chegada ao cliente (entrega confirmada).',
    );
}

export async function createDelivery(
  tx: Tx,
  actor: ActorContext,
  input: {
    customerId: string;
    addressId?: string | null;
    address?: AddressInput | null;
    contactName?: string | null;
    contactPhone?: string | null;
    scheduledDate: string;
    windowStart?: string | null;
    windowEnd?: string | null;
    team: PickupTeam;
    responsibleUserId?: string | null;
    requiresInstallation: boolean;
    instructions?: string | null;
    notes?: string | null;
    itemIds: string[];
    provisional: boolean;
  },
) {
  requireArrival(input.provisional, input.windowStart);
  const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw Errors.notFound('Cliente');
  const items = await validatePieces(tx, customer.id, input.itemIds);
  if (!input.provisional)
    await assertAllReady(
      tx,
      items.map((i) => i.id),
    );
  const responsible = await assertResponsible(tx, input.responsibleUserId, input.team);
  const { addressId, snapshot } = await deliveryAddress(tx, customer.id, input);
  const status: DeliveryStatus = input.provisional ? 'PROVISORIA' : 'AGENDADA';
  const d = await tx.delivery.create({
    data: {
      customerId: customer.id,
      addressId,
      addressSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      contactName: input.contactName ?? customer.name,
      contactPhone: input.contactPhone ?? customer.phone ?? null,
      scheduledDate: parseDateOnly(input.scheduledDate)!,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      team: input.team,
      responsibleUserId: responsible?.id ?? null,
      requiresInstallation: input.requiresInstallation,
      instructions: input.instructions ?? null,
      notes: input.notes ?? null,
      status,
      createdById: actor.userId,
      items: { create: items.map((i) => ({ serviceOrderItemId: i.id })) },
    },
  });
  const code = deliveryCode(d.number);
  const when = `${input.scheduledDate.split('-').reverse().join('/')}${input.windowStart ? ` ${input.windowStart}${input.windowEnd ? `–${input.windowEnd}` : ''}` : ''}`;
  await deliveryEvent(tx, actor, d.id, {
    kind: input.provisional ? 'PRE_AGENDADA' : 'AGENDADA',
    to: status,
    note: `${when}${responsible ? ` · ${responsible.displayName}` : ''}${input.provisional ? ' · provisória: não confirmada ao cliente' : ''}`,
    data: { items: items.map(pieceCode) },
  });
  await audit(tx, actor, {
    action: input.provisional ? 'delivery.preschedule' : 'delivery.scheduled',
    entityType: 'delivery',
    entityId: d.id,
    summary: `${code} ${input.provisional ? 'pré-agendada (provisória)' : 'agendada'} para ${when} — ${customer.name}: ${items.map(pieceCode).join(', ')}.`,
  });
  await deliveryDomainEvent(tx, actor, d);
  for (const i of items) await refreshItemStage(tx, actor, i.id);
  if (status === 'AGENDADA') await announceScheduled(tx, actor, d.id);
  return d;
}

async function announceScheduled(tx: Tx, actor: ActorContext, id: string) {
  const d = await tx.delivery.findUniqueOrThrow({ where: { id }, include: deliveryInclude });
  const when = `${dateOnly(d.scheduledDate)!.split('-').reverse().join('/')}${d.windowStart ? ` ${d.windowStart}${d.windowEnd ? `–${d.windowEnd}` : ''}` : ''}`;
  const body = `${deliveryCode(d.number)} · ${d.customer.name} · ${when} · ${d.items.filter((i) => i.active).length} peça(s).`;
  await notify(tx, actor, [
    ...(d.responsibleUserId
      ? [
          {
            userId: d.responsibleUserId,
            kind: 'ENTREGA_ATRIBUIDA' as const,
            dedupeKey: `ENTREGA_ATRIBUIDA:${d.id}:${d.version}`,
            body,
            includeActor: true,
          },
        ]
      : []),
    ...(await usersWith(tx, 'entregas.gerenciar')).map((userId) => ({
      userId,
      kind: 'ENTREGA_AGENDADA' as const,
      dedupeKey: `ENTREGA_AGENDADA:${d.id}:${d.version}:${userId}`,
      body,
    })),
  ]);
}

export async function updateDelivery(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: Omit<Parameters<typeof createDelivery>[2], 'customerId' | 'provisional'> & {
    provisional?: boolean;
    reason: string;
    version: number;
  },
) {
  const d = await lockDelivery(tx, id);
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  if (!['PROVISORIA', 'AGENDADA', 'FRUSTRADA'].includes(d.status))
    throw Errors.business(
      `Entrega ${DELIVERY_STATUS_LABEL[d.status].toLowerCase()}: não pode ser alterada.`,
    );
  const items = await validatePieces(tx, d.customerId, input.itemIds, d.id);
  const provisional = input.provisional ?? d.status === 'PROVISORIA';
  requireArrival(provisional, input.windowStart);
  if (!provisional)
    await assertAllReady(
      tx,
      items.map((i) => i.id),
    );
  const responsible = await assertResponsible(tx, input.responsibleUserId, input.team);
  const { addressId, snapshot } = await deliveryAddress(tx, d.customerId, input);
  const status: DeliveryStatus = provisional ? 'PROVISORIA' : 'AGENDADA';
  const keep = new Set(items.map((i) => i.id));
  for (const di of d.items) {
    if (di.active && !keep.has(di.serviceOrderItemId))
      await tx.deliveryItem.update({
        where: {
          deliveryId_serviceOrderItemId: {
            deliveryId: d.id,
            serviceOrderItemId: di.serviceOrderItemId,
          },
        },
        data: { active: false },
      });
  }
  for (const i of items) {
    await tx.deliveryItem.upsert({
      where: { deliveryId_serviceOrderItemId: { deliveryId: d.id, serviceOrderItemId: i.id } },
      create: { deliveryId: d.id, serviceOrderItemId: i.id },
      update: { active: true, status: 'PENDENTE', note: null, deliveredAt: null },
    });
  }
  const u = await tx.delivery.update({
    where: { id: d.id },
    data: {
      addressId,
      addressSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      contactName: input.contactName ?? d.contactName,
      contactPhone: input.contactPhone ?? d.contactPhone,
      scheduledDate: parseDateOnly(input.scheduledDate)!,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      // Outro dia = sai da sequência do roteiro antigo (entra no fim do novo dia).
      ...(dateOnly(d.scheduledDate) !== input.scheduledDate ? { routeSequence: null } : {}),
      team: input.team,
      responsibleUserId: responsible?.id ?? null,
      requiresInstallation: input.requiresInstallation,
      instructions: input.instructions ?? null,
      notes: input.notes ?? null,
      status,
      departedAt: null,
      arrivedAt: null,
      version: { increment: 1 },
    },
  });
  const code = deliveryCode(d.number);
  await deliveryEvent(tx, actor, d.id, {
    kind: d.status === 'FRUSTRADA' ? 'REAGENDADA' : 'ALTERADA',
    from: d.status,
    to: status,
    note: `${input.reason} — ${input.scheduledDate.split('-').reverse().join('/')}${input.windowStart ? ` ${input.windowStart}` : ''}${responsible ? ` · ${responsible.displayName}` : ''}`,
  });
  await audit(tx, actor, {
    action: 'delivery.updated',
    entityType: 'delivery',
    entityId: d.id,
    summary: `${code} ${d.status === 'FRUSTRADA' ? 'reagendada' : 'alterada'}: ${input.reason}`,
  });
  await deliveryDomainEvent(tx, actor, u);
  const touched = new Set([...d.items.map((i) => i.serviceOrderItemId), ...keep]);
  for (const itemId of touched) await refreshItemStage(tx, actor, itemId);
  if (status === 'AGENDADA') await announceScheduled(tx, actor, d.id);
  await syncTripCost(tx, actor, { deliveryId: id }, input.reason);
  return u;
}

export async function confirmDelivery(tx: Tx, actor: ActorContext, id: string, version: number) {
  const d = await lockDelivery(tx, id);
  if (d.status === 'AGENDADA') return d;
  if (d.version !== version) throw Errors.versionConflict(d.version);
  if (d.status !== 'PROVISORIA')
    throw Errors.business('Só um pré-agendamento provisório pode ser confirmado.');
  if (!d.windowStart)
    throw Errors.business(
      'Informe o horário de chegada ao cliente antes de confirmar (Reagendar → Horário de chegada).',
    );
  const items = d.items.filter((i) => i.active).map((i) => i.serviceOrderItemId);
  if (!items.length) throw Errors.business('A entrega não tem peças.');
  await assertAllReady(tx, items);
  const u = await tx.delivery.update({
    where: { id },
    data: { status: 'AGENDADA', version: { increment: 1 } },
  });
  await deliveryEvent(tx, actor, id, { kind: 'CONFIRMADA', from: 'PROVISORIA', to: 'AGENDADA' });
  await audit(tx, actor, {
    action: 'delivery.confirmed',
    entityType: 'delivery',
    entityId: id,
    summary: `${deliveryCode(d.number)} confirmada pelo gestor (todas as peças liberadas).`,
  });
  await deliveryDomainEvent(tx, actor, u);
  for (const itemId of items) await refreshItemStage(tx, actor, itemId);
  await announceScheduled(tx, actor, id);
  return u;
}

export async function cancelDelivery(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  const d = await lockDelivery(tx, id);
  if (d.status === 'CANCELADA') return d;
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  if (!canDeliveryTransition(d.status, 'CANCELADA'))
    throw Errors.business('Entrega em andamento ou concluída não pode ser cancelada.');
  await tx.deliveryItem.updateMany({
    where: { deliveryId: id, active: true },
    data: { active: false },
  });
  const u = await tx.delivery.update({
    where: { id },
    data: { status: 'CANCELADA', cancelReason: input.reason, version: { increment: 1 } },
  });
  await deliveryEvent(tx, actor, id, {
    kind: 'CANCELADA',
    from: d.status,
    to: 'CANCELADA',
    note: input.reason,
  });
  await audit(tx, actor, {
    action: 'delivery.cancelled',
    entityType: 'delivery',
    entityId: id,
    summary: `${deliveryCode(d.number)} cancelada: ${input.reason}`,
  });
  await deliveryDomainEvent(tx, actor, u);
  for (const i of d.items) await refreshItemStage(tx, actor, i.serviceOrderItemId);
  await syncTripCost(tx, actor, { deliveryId: id }, input.reason);
  return u;
}

// ─────────────────────────── Execução (logística ou gestor) ───────────────────────────

export interface LogisticsViewer {
  userId: string;
  isManager: boolean;
}

function assertExecutor(d: { responsibleUserId: string | null }, viewer: LogisticsViewer) {
  if (!viewer.isManager && d.responsibleUserId !== viewer.userId)
    throw Errors.forbidden('Esta entrega está atribuída a outra pessoa.');
}

async function transition(
  tx: Tx,
  actor: ActorContext,
  d: DeliveryRow,
  to: DeliveryStatus,
  data: Prisma.DeliveryUpdateInput,
  entry: { kind: string; note?: string | null; deviceId?: string | null; data?: unknown },
) {
  if (!canDeliveryTransition(d.status, to))
    throw Errors.business(
      `Não é possível passar de "${DELIVERY_STATUS_LABEL[d.status]}" para "${DELIVERY_STATUS_LABEL[to]}".`,
    );
  const u = await tx.delivery.update({
    where: { id: d.id },
    data: { ...data, status: to, version: { increment: 1 } },
  });
  await deliveryEvent(tx, actor, d.id, { ...entry, from: d.status, to });
  await deliveryDomainEvent(tx, actor, u);
  return u;
}

/** Saída para entrega: só com todas as peças liberadas e a entrega confirmada pelo gestor. */
export async function departDelivery(
  tx: Tx,
  actor: ActorContext,
  viewer: LogisticsViewer,
  id: string,
  input: { note?: string | null; version: number },
  deviceId: string | null,
) {
  const d = await lockDelivery(tx, id);
  assertExecutor(d, viewer);
  if (d.status === 'EM_TRANSPORTE') return d;
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  const items = d.items.filter((i) => i.active);
  await assertAllReady(
    tx,
    items.map((i) => i.serviceOrderItemId),
  );
  const u = await transition(
    tx,
    actor,
    d,
    'EM_TRANSPORTE',
    { departedAt: new Date(), arrivedAt: null },
    { kind: 'SAIDA', note: input.note ?? null, deviceId },
  );
  for (const i of items) {
    await moveItemToKey(
      tx,
      actor,
      i.serviceOrderItemId,
      'EM_TRANSPORTE',
      `Saída ${deliveryCode(d.number)}`,
      deviceId,
    );
    await refreshItemStage(tx, actor, i.serviceOrderItemId);
  }
  return u;
}

export async function arriveDelivery(
  tx: Tx,
  actor: ActorContext,
  viewer: LogisticsViewer,
  id: string,
  input: { note?: string | null; version: number },
  deviceId: string | null,
) {
  const d = await lockDelivery(tx, id);
  assertExecutor(d, viewer);
  if (d.status === 'NO_DESTINO') return d;
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  return transition(
    tx,
    actor,
    d,
    'NO_DESTINO',
    { arrivedAt: new Date() },
    { kind: 'CHEGADA', note: input.note ?? null, deviceId },
  );
}

export async function openOccurrence(
  tx: Tx,
  actor: ActorContext,
  input: {
    kind: LogisticsKind;
    description: string;
    deliveryId?: string | null;
    pickupId?: string | null;
    serviceOrderItemId?: string | null;
    blocksShipping?: boolean;
  },
  deviceId: string | null = null,
) {
  const blocksShipping = input.blocksShipping ?? blocksShippingByDefault(input.kind);
  const o = await tx.logisticsOccurrence.create({
    data: {
      kind: input.kind,
      description: input.description,
      deliveryId: input.deliveryId ?? null,
      pickupId: input.pickupId ?? null,
      serviceOrderItemId: input.serviceOrderItemId ?? null,
      blocksShipping,
      reportedById: actor.userId,
      deviceId,
    },
  });
  await tx.logisticsOccurrenceEvent.create({
    data: {
      occurrenceId: o.id,
      kind: 'ABERTA',
      toStatus: 'ABERTA',
      note: input.description,
      actorId: actor.userId,
    },
  });
  const code = logisticsCode(o.number);
  if (input.deliveryId)
    await deliveryEvent(tx, actor, input.deliveryId, {
      kind: 'OCORRENCIA',
      note: `${code} · ${LOGISTICS_KIND_LABEL[input.kind]}: ${input.description}`,
      deviceId,
    });
  await audit(tx, actor, {
    action: 'logistics.occurrence_opened',
    entityType: 'logistics_occurrence',
    entityId: o.id,
    summary: `${code} (${LOGISTICS_KIND_LABEL[input.kind]}) aberta: ${input.description}${blocksShipping ? ' — bloqueia a expedição' : ''}.`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.LOGISTICS_OCCURRENCE_UPDATED,
    aggregateType: 'logistics_occurrence',
    aggregateId: o.id,
    payload: { id: o.id, code, status: o.status, kind: o.kind },
    audience: anyPermissionAudience('entregas.ver', 'entregas.gerenciar', 'ocorrencias.ver'),
  });
  await notifyUsersWith(
    tx,
    actor,
    'entregas.gerenciar',
    'OCORRENCIA_LOGISTICA',
    `OCORRENCIA_LOGISTICA:${o.id}`,
    `${code} · ${LOGISTICS_KIND_LABEL[input.kind]}: ${input.description}`,
  );
  // Bloqueio de expedição afeta a etapa das peças envolvidas.
  const itemIds = input.serviceOrderItemId
    ? [input.serviceOrderItemId]
    : input.deliveryId
      ? (
          await tx.deliveryItem.findMany({
            where: { deliveryId: input.deliveryId, active: true },
            select: { serviceOrderItemId: true },
          })
        ).map((x) => x.serviceOrderItemId)
      : [];
  for (const itemId of itemIds) await refreshItemStage(tx, actor, itemId);
  return o;
}

/** Peça a peça: entregue, entregue com divergência ou não entregue (nunca automático). */
export async function deliverItems(
  tx: Tx,
  actor: ActorContext,
  viewer: LogisticsViewer,
  id: string,
  input: {
    items: {
      serviceOrderItemId: string;
      status: 'ENTREGUE' | 'DIVERGENTE' | 'NAO_ENTREGUE';
      note?: string | null;
    }[];
    version: number;
  },
  deviceId: string | null,
) {
  const d = await lockDelivery(tx, id);
  assertExecutor(d, viewer);
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  if (d.status !== 'NO_DESTINO')
    throw Errors.business('Registre a chegada ao destino antes de confirmar as peças.');
  const now = new Date();
  for (const it of input.items) {
    const di = d.items.find((x) => x.serviceOrderItemId === it.serviceOrderItemId && x.active);
    if (!di) throw Errors.business('Peça fora desta entrega.');
    await tx.deliveryItem.update({
      where: {
        deliveryId_serviceOrderItemId: {
          deliveryId: d.id,
          serviceOrderItemId: di.serviceOrderItemId,
        },
      },
      data: {
        status: it.status,
        note: it.note ?? null,
        deliveredAt: it.status === 'NAO_ENTREGUE' ? null : now,
      },
    });
    const code = pieceCode(di.serviceOrderItem);
    await deliveryEvent(tx, actor, d.id, {
      kind: `PECA_${it.status}`,
      note: `${code}${it.note ? ` — ${it.note}` : ''}`,
      deviceId,
    });
    if (it.status !== 'NAO_ENTREGUE')
      await moveItemToKey(
        tx,
        actor,
        di.serviceOrderItemId,
        'ENTREGUE',
        `${deliveryCode(d.number)}`,
        deviceId,
      );
    if (it.status === 'DIVERGENTE')
      await openOccurrence(
        tx,
        actor,
        {
          kind: 'DIVERGENCIA',
          description: `${code}: ${it.note}`,
          deliveryId: d.id,
          serviceOrderItemId: di.serviceOrderItemId,
          blocksShipping: false,
        },
        deviceId,
      );
    await refreshItemStage(tx, actor, di.serviceOrderItemId);
  }
  const u = await tx.delivery.update({ where: { id }, data: { version: { increment: 1 } } });
  await deliveryDomainEvent(tx, actor, u);
  return u;
}

export async function installDelivery(
  tx: Tx,
  actor: ActorContext,
  viewer: LogisticsViewer,
  id: string,
  input: { note: string; complete: boolean; version: number },
  deviceId: string | null,
) {
  const d = await lockDelivery(tx, id);
  assertExecutor(d, viewer);
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  if (!d.requiresInstallation) throw Errors.business('Esta entrega não tem instalação.');
  if (d.status !== 'NO_DESTINO') throw Errors.business('A instalação é registrada no destino.');
  const u = await tx.delivery.update({
    where: { id },
    data: {
      installedAt: input.complete ? new Date() : null,
      installationNote: input.note,
      version: { increment: 1 },
    },
  });
  await deliveryEvent(tx, actor, id, {
    kind: input.complete ? 'INSTALADA' : 'INSTALACAO_INCOMPLETA',
    note: input.note,
    deviceId,
  });
  if (!input.complete)
    await openOccurrence(
      tx,
      actor,
      {
        kind: 'INSTALACAO_INCOMPLETA',
        description: input.note,
        deliveryId: id,
        blocksShipping: false,
      },
      deviceId,
    );
  await deliveryDomainEvent(tx, actor, u);
  return u;
}

/**
 * Conclusão confirmada por quem entregou: exige cada peça registrada e, se houver instalação,
 * o registro da instalação (ou a ocorrência de instalação incompleta). Peças não entregues
 * voltam para a expedição.
 */
export async function completeDelivery(
  tx: Tx,
  actor: ActorContext,
  viewer: LogisticsViewer,
  id: string,
  input: { note?: string | null; version: number },
  deviceId: string | null,
) {
  const d = await lockDelivery(tx, id);
  assertExecutor(d, viewer);
  if (d.status === 'CONCLUIDA') return d;
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  const active = d.items.filter((i) => i.active);
  if (active.some((i) => i.status === 'PENDENTE'))
    throw Errors.business('Confirme peça a peça (entregue, com divergência ou não entregue).');
  if (!active.some((i) => i.status === 'ENTREGUE' || i.status === 'DIVERGENTE'))
    throw Errors.business('Nenhuma peça foi entregue: registre a tentativa frustrada.');
  if (d.requiresInstallation && !d.installedAt) {
    const incomplete = await tx.logisticsOccurrence.count({
      where: { deliveryId: id, kind: 'INSTALACAO_INCOMPLETA' },
    });
    if (!incomplete) throw Errors.business('Registre a instalação antes de concluir.');
  }
  const notDelivered = active.filter((i) => i.status === 'NAO_ENTREGUE');
  for (const i of notDelivered) {
    await tx.deliveryItem.update({
      where: {
        deliveryId_serviceOrderItemId: { deliveryId: id, serviceOrderItemId: i.serviceOrderItemId },
      },
      data: { active: false },
    });
  }
  const u = await transition(
    tx,
    actor,
    d,
    'CONCLUIDA',
    { completedAt: new Date(), completionNote: input.note ?? null },
    { kind: 'CONCLUIDA', note: input.note ?? null, deviceId },
  );
  for (const i of notDelivered) {
    await moveItemToKey(
      tx,
      actor,
      i.serviceOrderItemId,
      'EXPEDICAO',
      `Não entregue em ${deliveryCode(d.number)}`,
      deviceId,
    );
  }
  for (const i of active) await refreshItemStage(tx, actor, i.serviceOrderItemId);
  await audit(tx, actor, {
    action: 'delivery.completed',
    entityType: 'delivery',
    entityId: id,
    summary: `${deliveryCode(d.number)} concluída (${d.customer.name}): ${active.length - notDelivered.length} entregue(s)${notDelivered.length ? `, ${notDelivered.length} não entregue(s)` : ''}.`,
  });
  await notifyUsersWith(
    tx,
    actor,
    'entregas.gerenciar',
    'ENTREGA_CONCLUIDA',
    `ENTREGA_CONCLUIDA:${id}`,
    `${deliveryCode(d.number)} · ${d.customer.name}: ${active.length - notDelivered.length} peça(s) entregue(s)${d.requiresInstallation ? (d.installedAt ? ', instalação concluída' : ', instalação incompleta') : ''}.`,
  );
  await syncTripCost(tx, actor, { deliveryId: id });
  return u;
}

/** Tentativa frustrada: nunca marca como entregue; abre ocorrência e as peças voltam à expedição. */
export async function frustrateDelivery(
  tx: Tx,
  actor: ActorContext,
  viewer: LogisticsViewer,
  id: string,
  input: { kind: LogisticsKind; reason: string; version: number },
  deviceId: string | null,
) {
  const d = await lockDelivery(tx, id);
  assertExecutor(d, viewer);
  if (d.status === 'FRUSTRADA') return d;
  if (d.version !== input.version) throw Errors.versionConflict(d.version);
  if (d.items.some((i) => i.active && (i.status === 'ENTREGUE' || i.status === 'DIVERGENTE')))
    throw Errors.business(
      'Há peças já entregues: conclua a entrega marcando as demais como não entregues.',
    );
  const u = await transition(
    tx,
    actor,
    d,
    'FRUSTRADA',
    { attempts: { increment: 1 } },
    { kind: 'FRUSTRADA', note: `${LOGISTICS_KIND_LABEL[input.kind]}: ${input.reason}`, deviceId },
  );
  for (const i of d.items.filter((x) => x.active)) {
    await tx.deliveryItem.update({
      where: {
        deliveryId_serviceOrderItemId: { deliveryId: id, serviceOrderItemId: i.serviceOrderItemId },
      },
      data: { status: 'PENDENTE', deliveredAt: null },
    });
    await moveItemToKey(
      tx,
      actor,
      i.serviceOrderItemId,
      'EXPEDICAO',
      `Retorno de ${deliveryCode(d.number)}`,
      deviceId,
    );
    await refreshItemStage(tx, actor, i.serviceOrderItemId);
  }
  await openOccurrence(
    tx,
    actor,
    { kind: input.kind, description: input.reason, deliveryId: id, blocksShipping: false },
    deviceId,
  );
  return u;
}
