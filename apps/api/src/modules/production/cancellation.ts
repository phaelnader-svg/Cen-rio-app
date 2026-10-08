import { EVENT_TYPES } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import {
  MANAGEMENT_AUDIENCE,
  changeStock,
  lockStockItem,
  num,
  refreshReadiness,
} from '../purchasing/common';
import { domainTaskEvent, lockTasks, taskEvent } from './common';

/**
 * Proteção mínima (pendência das Fases 2/4) ao cancelar uma OS, na mesma transação:
 * - tarefas de produção ainda não concluídas são canceladas (nenhuma execução de OS cancelada);
 * - reservas ativas de estoque voltam a ficar disponíveis (com movimentação/auditoria).
 * Compras já feitas NÃO são canceladas automaticamente: o gestor decide no pedido.
 */
export async function protectCancelledServiceOrder(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  reason: string,
) {
  const tasks = await tx.productionTask.findMany({
    where: { serviceOrderId, status: { notIn: ['CONCLUIDA', 'CANCELADA'] } },
  });
  await lockTasks(
    tx,
    tasks.map((t) => t.id),
  );
  for (const t of tasks) {
    if (t.status === 'RASCUNHO') {
      await tx.productionTask.delete({ where: { id: t.id } });
      continue;
    }
    const u = await tx.productionTask.update({
      where: { id: t.id },
      data: {
        status: 'CANCELADA',
        cancelReason: `OS cancelada: ${reason}`.slice(0, 500),
        version: { increment: 1 },
      },
    });
    await taskEvent(tx, actor, null, t, {
      kind: 'CANCELADA',
      from: t.status,
      to: 'CANCELADA',
      note: 'OS cancelada',
    });
    await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, u);
  }
  await tx.productionPlanItem.deleteMany({
    where: { serviceOrderId, plan: { status: 'RASCUNHO' } },
  });
  const reservations = await tx.stockReservation.findMany({
    where: { serviceOrderId, status: 'ATIVA' },
  });
  for (const r of reservations) {
    const stock = await lockStockItem(tx, r.stockItemId);
    await tx.stockReservation.update({
      where: { id: r.id },
      data: {
        status: 'LIBERADA',
        closedAt: new Date(),
        closedById: actor.userId,
        closeReason: 'OS cancelada',
        version: { increment: 1 },
      },
    });
    await changeStock(tx, actor, stock, { reserved: -num(r.quantity) });
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.STOCK_RELEASED,
      aggregateType: 'stock_reservation',
      aggregateId: r.id,
      payload: { id: r.id, serviceOrderId, stockItemId: r.stockItemId, quantity: num(r.quantity) },
      audience: MANAGEMENT_AUDIENCE,
    });
  }
  if (tasks.length || reservations.length) {
    await audit(tx, actor, {
      action: 'service_order.cancel_protection',
      entityType: 'service_order',
      entityId: serviceOrderId,
      summary: `OS cancelada: ${tasks.length} tarefa(s) cancelada(s) e ${reservations.length} reserva(s) liberada(s).`,
    });
  }
  await refreshReadiness(tx, actor, [serviceOrderId]);
}
