/**
 * Fluxo da OS (2026-11-18): a peça da retirada passa a "na tapeçaria" (Recebida na oficina)
 * sozinha, 1 hora depois do horário agendado — ou à mão, pelo botão do pedido. Sem horário na
 * retirada, vale 18h do dia agendado. Retirada cancelada, com ocorrência ou ainda sem data não
 * muda sozinha. Idempotente: cada retirada só é recebida uma vez.
 */
import { PICKUP_STATUS_LABEL, EVENT_TYPES, zonedDateTime } from '@cenario/shared';
import type { PickupStatus, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import type { ActorContext } from '../../core/types';
import { dateOnly, lockOrder, pickupCode } from '../commercial/common';
import { refreshOrderStatus } from '../commercial/status';
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
    },
  });
  await markPickupArrived(tx, pickupId);
  await refreshOrderStatus(tx, before.orderId);
  await resolvePickupAssignment(tx, actor, pickupId);
  await audit(tx, actor, {
    action: 'pickup.status_changed',
    entityType: 'pickup_request',
    entityId: pickupId,
    summary: `Retirada ${pickupCode(before.number)}: ${PICKUP_STATUS_LABEL[before.status]} → ${PICKUP_STATUS_LABEL.RECEBIDA_NA_OFICINA} (${note}).`,
    changes: { status: { from: before.status, to: 'RECEBIDA_NA_OFICINA' }, note },
  });
  await emitPickupEvent(tx, actor, pickupId, EVENT_TYPES.PICKUP_STATUS_CHANGED);
  await syncTripCost(tx, actor, { pickupId }, note);
  return true;
}

/** Quando a retirada passa sozinha para "na tapeçaria" (null = sem data). */
export function autoArrivalAt(
  p: { scheduledDate: Date | null; windowStart: string | null },
  timezone: string,
): Date | null {
  const day = dateOnly(p.scheduledDate);
  if (!day) return null;
  const at = zonedDateTime(day, p.windowStart ?? PICKUP_DEFAULT_TIME, timezone);
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
    select: { id: true, orderId: true, scheduledDate: true, windowStart: true },
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
        'automático, 1 hora depois do horário agendado',
      );
      if (ok) await emitOrderEvent(tx, SYSTEM, p.orderId);
      return ok;
    });
    if (done) received++;
  }
  return received;
}
