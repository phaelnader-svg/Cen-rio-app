import { EVENT_TYPES } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { MANAGEMENT_AUDIENCE, changeStock, lockStockItem, num, refreshReadiness } from './common';

/**
 * Fase 12 — reservas de material quando peças de uma OS são devolvidas sem serviço.
 *
 * - Libera só as reservas ATIVAS ligadas (pela necessidade de material) às peças devolvidas.
 * - Material já entregue à OS (reserva consumida) nunca volta sozinho ao estoque: devolução
 *   física é um ajuste de entrada explícito (com a OS), feito pelo gestor.
 * - Reservas da OS sem peça definida não são rateadas por suposição: ficam para revisão do
 *   gestor (o retorno informa quais são).
 * - Reservas de outras peças não são tocadas.
 */
export async function releaseReservationsOfItems(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  itemIds: readonly string[],
  reason: string,
) {
  if (!itemIds.length) return { released: [] as string[], review: [] as string[] };
  const active = await tx.stockReservation.findMany({
    where: { serviceOrderId, status: 'ATIVA' },
    include: { requirement: { select: { serviceOrderItemId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const released: string[] = [];
  const review: string[] = [];
  for (const r of active) {
    const itemId = r.requirement?.serviceOrderItemId ?? null;
    if (itemId === null) {
      review.push(r.id);
      continue;
    }
    if (!itemIds.includes(itemId)) continue;
    const stock = await lockStockItem(tx, r.stockItemId);
    // Relê sob bloqueio: outra transação pode ter consumido ou liberado a reserva.
    const cur = await tx.stockReservation.findUniqueOrThrow({ where: { id: r.id } });
    if (cur.status !== 'ATIVA') continue;
    await tx.stockReservation.update({
      where: { id: r.id },
      data: {
        status: 'LIBERADA',
        closedAt: new Date(),
        closedById: actor.userId,
        closeReason: reason.slice(0, 500),
        version: { increment: 1 },
      },
    });
    await changeStock(tx, actor, stock, { reserved: -num(cur.quantity) });
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.STOCK_RELEASED,
      aggregateType: 'stock_reservation',
      aggregateId: r.id,
      payload: {
        id: r.id,
        serviceOrderId,
        stockItemId: r.stockItemId,
        quantity: num(cur.quantity),
      },
      audience: MANAGEMENT_AUDIENCE,
    });
    released.push(r.id);
  }
  if (released.length || review.length) {
    await audit(tx, actor, {
      action: 'stock.released_on_return',
      entityType: 'service_order',
      entityId: serviceOrderId,
      summary: `${reason}: ${released.length} reserva(s) da(s) peça(s) devolvida(s) liberada(s); ${review.length} reserva(s) sem peça definida aguardando revisão do gestor.`,
      changes: { released, review },
    });
  }
  await refreshReadiness(tx, actor, [serviceOrderId]);
  return { released, review };
}
