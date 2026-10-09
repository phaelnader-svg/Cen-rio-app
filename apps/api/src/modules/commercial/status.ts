import { orderServiceState, type OrderServiceState } from '@cenario/shared';
import type { CommercialOrderStatus, PrismaClient, Tx } from '@cenario/db';

/** Situações de retirada que ainda "reservam" peças (não recebidas nem canceladas). */
export const ACTIVE_PICKUP_STATUSES = [
  'AGUARDANDO_AGENDAMENTO',
  'AGENDADA',
  'EM_EXECUCAO',
  'RETIRADA_REALIZADA',
  'COM_OCORRENCIA',
] as const;

const SCHEDULED_PICKUP_STATUSES = [
  'AGENDADA',
  'EM_EXECUCAO',
  'RETIRADA_REALIZADA',
  'COM_OCORRENCIA',
] as const;

/**
 * Recalcula a situação do pedido a partir das peças recebidas e das retiradas.
 * A situação é derivada (não editável manualmente), exceto o cancelamento.
 */
export async function refreshOrderStatus(tx: Tx, orderId: string): Promise<CommercialOrderStatus> {
  const order = await tx.commercialOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { select: { quantity: true, receivedQuantity: true } } },
  });
  if (order.status === 'CANCELADO') return order.status;
  const total = order.items.reduce((a, i) => a + i.quantity, 0);
  const received = order.items.reduce((a, i) => a + i.receivedQuantity, 0);
  let next: CommercialOrderStatus;
  if (total > 0 && received >= total) next = 'RECEBIDO';
  else if (received > 0) next = 'RECEBIDO_PARCIAL';
  else {
    const scheduled = await tx.pickupRequest.count({
      where: { orderId, status: { in: [...SCHEDULED_PICKUP_STATUSES] } },
    });
    next = scheduled > 0 ? 'RETIRADA_AGENDADA' : 'AGUARDANDO_RETIRADA';
  }
  if (next !== order.status) {
    await tx.commercialOrder.update({ where: { id: orderId }, data: { status: next } });
  }
  return next;
}

/** Quantidades por item do pedido: em retiradas ativas e já alocadas em OS ativas. */
export async function itemAllocations(tx: Tx, orderId: string) {
  const [pickupRows, osRows] = await Promise.all([
    tx.pickupRequestItem.groupBy({
      by: ['orderItemId'],
      where: { pickup: { orderId, status: { in: [...ACTIVE_PICKUP_STATUSES] } } },
      _sum: { quantity: true },
    }),
    tx.serviceOrderItem.groupBy({
      by: ['orderItemId'],
      // Fase 10: peças devolvidas ao cliente deixam de ocupar a OS.
      where: {
        serviceOrder: { orderId, status: 'ABERTA' },
        fulfillmentStage: { not: 'DEVOLVIDA' },
      },
      _sum: { quantity: true },
    }),
  ]);
  const inPickups = new Map(pickupRows.map((r) => [r.orderItemId, r._sum.quantity ?? 0]));
  const inServiceOrders = new Map(osRows.map((r) => [r.orderItemId, r._sum.quantity ?? 0]));
  return {
    inPickups: (id: string) => inPickups.get(id) ?? 0,
    inServiceOrders: (id: string) => inServiceOrders.get(id) ?? 0,
  };
}

/**
 * Fase 12 — situação do serviço de cada pedido (devolução parcial/total, concluído, cancelado),
 * derivada das peças recebidas/devolvidas e das etapas das peças das OS ativas.
 */
export async function serviceStates(
  db: Tx | PrismaClient,
  orders: {
    id: string;
    status: CommercialOrderStatus;
    items: { receivedQuantity: number; returnedQuantity: number }[];
  }[],
): Promise<Map<string, { returnedPieces: number; serviceState: OrderServiceState }>> {
  const pieces = await db.serviceOrderItem.findMany({
    where: { serviceOrder: { orderId: { in: orders.map((o) => o.id) }, status: 'ABERTA' } },
    select: { quantity: true, fulfillmentStage: true, serviceOrder: { select: { orderId: true } } },
  });
  const out = new Map<string, { returnedPieces: number; serviceState: OrderServiceState }>();
  for (const o of orders) {
    const mine = pieces.filter(
      (p) =>
        p.serviceOrder.orderId === o.id &&
        p.fulfillmentStage !== 'DEVOLVIDA' &&
        p.fulfillmentStage !== 'CANCELADA',
    );
    const returnedPieces = o.items.reduce((a, i) => a + i.returnedQuantity, 0);
    out.set(o.id, {
      returnedPieces,
      serviceState: orderServiceState({
        cancelled: o.status === 'CANCELADO',
        receivedPieces: o.items.reduce((a, i) => a + i.receivedQuantity, 0),
        returnedPieces,
        activePieces: mine.reduce((a, p) => a + p.quantity, 0),
        deliveredPieces: mine
          .filter((p) => p.fulfillmentStage === 'ENTREGUE')
          .reduce((a, p) => a + p.quantity, 0),
      }),
    });
  }
  return out;
}
