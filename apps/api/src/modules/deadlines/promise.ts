/**
 * Prazo combinado em dias úteis (2026-11-18): o pedido guarda quantos dias úteis foram
 * combinados e a data é contada do dia da retirada. Se a retirada muda de dia antes de a OS
 * existir, a data do prazo acompanha. Depois da OS gerada, o prazo dela só muda pelo gestor.
 */
import { addBusinessDays } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { dbDate } from '../attendance/common';
import { dateOnly } from '../commercial/common';
import { deadlineCalendar } from './service';

export async function followPickupDate(tx: Tx, orderId: string, pickupDate: string | null) {
  if (!pickupDate) return null;
  const o = await tx.commercialOrder.findUnique({
    where: { id: orderId },
    select: {
      deliveryBusinessDays: true,
      promisedDate: true,
      status: true,
      serviceOrders: { where: { status: { not: 'CANCELADA' } }, select: { id: true }, take: 1 },
    },
  });
  if (!o?.deliveryBusinessDays || o.status === 'CANCELADO' || o.serviceOrders.length) return null;
  const cal = await deadlineCalendar(tx);
  const next = addBusinessDays(pickupDate, o.deliveryBusinessDays, cal.workingDays);
  if (next === dateOnly(o.promisedDate)) return null;
  await tx.commercialOrder.update({
    where: { id: orderId },
    data: { promisedDate: dbDate(next), version: { increment: 1 } },
  });
  return next;
}
