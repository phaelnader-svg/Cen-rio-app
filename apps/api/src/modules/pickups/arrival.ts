/**
 * Fluxo da OS (2026-11-18): a peça da retirada passa a "na tapeçaria" (Recebida na oficina)
 * sozinha, 1 hora depois do horário agendado — ou à mão, pelo botão do pedido. Sem horário na
 * retirada, vale 18h do dia agendado. Retirada cancelada, com ocorrência ou ainda sem data não
 * muda sozinha. Idempotente: cada retirada só é recebida uma vez.
 */
import { PICKUP_KIND_LABEL, EVENT_TYPES, pickupStatusLabel, zonedDateTime } from '@cenario/shared';
import type { PickupKind, PickupStatus, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import type { ActorContext } from '../../core/types';
import { dateOnly, lockOrder, pickupCode } from '../commercial/common';
import { itemAllocations, refreshOrderStatus } from '../commercial/status';
import { Errors } from '../../lib/errors';
import { syncTripCost } from '../finance/trip-costs';
import { shopTimezone } from '../finance/common';
import { resolvePickupAssignment } from '../notifications/notify';
import { emitOrderEvent } from '../orders/routes';
import { emitPickupEvent, markPickupArrived } from './routes';

/** Situações em que a peça ainda não chegou e a retirada segue de pé. */
export const PICKUP_ARRIVAL_PENDING: PickupStatus[] = [
  'AGUARDANDO_AGENDAMENTO',
  'AGENDADA',
  'EM_EXECUCAO',
  'RETIRADA_REALIZADA',
  'COM_OCORRENCIA',
];
/** Só estas passam sozinhas (agendada e sem ocorrência). */
const AUTO_FROM: PickupStatus[] = ['AGENDADA', 'EM_EXECUCAO', 'RETIRADA_REALIZADA'];
/** Horário considerado quando a retirada tem só o dia. */
export const PICKUP_DEFAULT_TIME = '18:00';
export const PICKUP_AUTO_ARRIVAL_MS = 60 * 60_000;

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };

/** Marca a retirada como recebida na tapeçaria (peças somadas ao pedido). O pedido já está travado. */
export async function receivePickupAtWorkshop(
  tx: Tx,
  actor: ActorContext,
  pickupId: string,
  note: string,
  /** Quando a peça chegou (automático: horário agendado + 1 h); padrão agora. */
  occurredAt?: Date,
) {
  const before = await tx.pickupRequest.findUniqueOrThrow({ where: { id: pickupId } });
  if (!PICKUP_ARRIVAL_PENDING.includes(before.status)) return false;
  await tx.pickupRequest.update({
    where: { id: pickupId },
    data: { status: 'RECEBIDA_NA_OFICINA', version: { increment: 1 } },
  });
  await tx.pickupEvent.create({
    data: {
      pickupId,
      kind: 'RECEBIDA_NA_OFICINA',
      fromStatus: before.status,
      toStatus: 'RECEBIDA_NA_OFICINA',
      note,
      recordedById: actor.userId,
      ...(occurredAt ? { occurredAt } : {}),
    },
  });
  await markPickupArrived(tx, pickupId);
  await refreshOrderStatus(tx, before.orderId);
  await resolvePickupAssignment(tx, actor, pickupId);
  await audit(tx, actor, {
    action: 'pickup.status_changed',
    entityType: 'pickup_request',
    entityId: pickupId,
    summary: `${PICKUP_KIND_LABEL[before.kind]} ${pickupCode(before.number)}: ${pickupStatusLabel(before.status, before.kind)} → ${pickupStatusLabel('RECEBIDA_NA_OFICINA', before.kind)} (${note}).`,
    changes: { status: { from: before.status, to: 'RECEBIDA_NA_OFICINA' }, note },
  });
  await emitPickupEvent(tx, actor, pickupId, EVENT_TYPES.PICKUP_STATUS_CHANGED);
  await syncTripCost(tx, actor, { pickupId }, note);
  return true;
}

/**
 * Quando a retirada passa sozinha para "na tapeçaria" (null = sem data).
 * "No local" (2026-11-25): o serviço é feito na casa do cliente e leva o dia; vira "Serviço feito"
 * 1 hora depois do fim do dia (18h) — ou do fim da janela, se for mais tarde.
 */
export function autoArrivalAt(
  p: {
    scheduledDate: Date | null;
    windowStart: string | null;
    windowEnd?: string | null;
    kind?: PickupKind;
  },
  timezone: string,
): Date | null {
  const day = dateOnly(p.scheduledDate);
  if (!day) return null;
  const time =
    p.kind === 'NO_LOCAL'
      ? [PICKUP_DEFAULT_TIME, p.windowStart ?? '', p.windowEnd ?? ''].sort().at(-1)!
      : (p.windowStart ?? PICKUP_DEFAULT_TIME);
  const at = zonedDateTime(day, time, timezone);
  return new Date(at.getTime() + PICKUP_AUTO_ARRIVAL_MS);
}

/** Tarefa periódica (por empresa): recebe as retiradas cujo horário + 1 h já passou. */
export async function autoReceiveDuePickups(prisma: PrismaClient, now = clockNow()) {
  const timezone = await shopTimezone(prisma);
  // Margem de um dia: o filtro fino (horário + 1 h no fuso da empresa) é feito abaixo.
  const candidates = await prisma.pickupRequest.findMany({
    where: {
      status: { in: AUTO_FROM },
      scheduledDate: { lte: new Date(now.getTime() + 86_400_000) },
    },
    select: {
      id: true,
      orderId: true,
      kind: true,
      scheduledDate: true,
      windowStart: true,
      windowEnd: true,
    },
    orderBy: { id: 'asc' },
    take: 500,
  });
  const due = candidates.filter((p) => {
    const at = autoArrivalAt(p, timezone);
    return at !== null && at <= now;
  });
  let received = 0;
  for (const p of due) {
    const done = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, p.orderId);
      const fresh = await tx.pickupRequest.findUniqueOrThrow({ where: { id: p.id } });
      if (!AUTO_FROM.includes(fresh.status)) return false;
      const ok = await receivePickupAtWorkshop(
        tx,
        SYSTEM,
        p.id,
        p.kind === 'NO_LOCAL'
          ? 'serviço no local: automático, no fim do dia agendado'
          : 'automático, 1 hora depois do horário agendado',
        autoArrivalAt(fresh, timezone) ?? undefined,
      );
      if (ok) await emitOrderEvent(tx, SYSTEM, p.orderId);
      return ok;
    });
    if (done) received++;
  }
  return received;
}

/**
 * 2026-11-26 (Raphael): "A retirada não aconteceu". A chegada automática (1 h depois) ou o botão
 * marcaram a peça na tapeçaria, mas a retirada não foi feita (cliente não estava, motorista não
 * foi). Tira as peças desta retirada da tapeçaria e volta a retirada para "com ocorrência", com o
 * motivo — daí ela pode ser reagendada (e volta a chegar sozinha no novo dia) ou cancelada.
 * Peça que já está numa OS (retirada) não volta: a OS tem de ser cancelada antes. No "No local" a
 * OS pode existir antes do dia, então ela fica (o serviço só não foi feito ainda).
 * O pedido já está travado (pedido + peças) pelo chamador.
 */
export async function undoPickupArrival(
  tx: Tx,
  actor: ActorContext,
  pickupId: string,
  reason: string,
) {
  const before = await tx.pickupRequest.findUniqueOrThrow({
    where: { id: pickupId },
    include: { items: { include: { orderItem: true } } },
  });
  if (before.status !== 'RECEBIDA_NA_OFICINA')
    throw Errors.business('Só a retirada marcada como "na tapeçaria" pode ser desfeita.');
  const alloc = await itemAllocations(tx, before.orderId);
  const changes: { orderItemId: string; from: number; to: number }[] = [];
  for (const i of before.items) {
    const oi = i.orderItem;
    const to = Math.max(0, oi.receivedQuantity - i.quantity);
    if (to === oi.receivedQuantity) continue;
    if (before.kind === 'RETIRADA' && alloc.inServiceOrders(oi.id) > to)
      throw Errors.business(
        `"${oi.description}" já está numa OS. Cancele a OS antes de dizer que a retirada não aconteceu.`,
      );
    changes.push({ orderItemId: oi.id, from: oi.receivedQuantity, to });
  }
  for (const c of changes)
    await tx.commercialOrderItem.update({
      where: { id: c.orderItemId },
      data: { receivedQuantity: c.to },
    });
  await tx.pickupRequest.update({
    where: { id: pickupId },
    data: { status: 'COM_OCORRENCIA', version: { increment: 1 } },
  });
  const label =
    before.kind === 'NO_LOCAL' ? 'O serviço no local não aconteceu' : 'A retirada não aconteceu';
  await tx.pickupEvent.create({
    data: {
      pickupId,
      kind: 'NAO_ACONTECEU',
      fromStatus: 'RECEBIDA_NA_OFICINA',
      toStatus: 'COM_OCORRENCIA',
      note: `${label}: ${reason}`,
      recordedById: actor.userId,
    },
  });
  await refreshOrderStatus(tx, before.orderId);
  await audit(tx, actor, {
    action: 'pickup.arrival_undone',
    entityType: 'pickup_request',
    entityId: pickupId,
    summary: `${PICKUP_KIND_LABEL[before.kind]} ${pickupCode(before.number)}: ${label.toLowerCase()} (${reason}).`,
    changes: {
      status: { from: 'RECEBIDA_NA_OFICINA', to: 'COM_OCORRENCIA' },
      items: changes,
      reason,
    },
  });
  await emitPickupEvent(tx, actor, pickupId, EVENT_TYPES.PICKUP_STATUS_CHANGED);
  await emitOrderEvent(tx, actor, before.orderId);
  return true;
}
