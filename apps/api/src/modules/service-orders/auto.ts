import type { ServiceOrder, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { orderCode, receiptCode } from '../commercial/common';
import { itemAllocations } from '../commercial/status';
import { createServiceOrder, type NewServiceOrderInput } from './service';

/** A geração automática não concede titular nem mão de obra: nenhuma permissão extra é usada. */
const NO_EXTRA_PERMISSIONS = { has: () => false };

/**
 * Simplificação Fase 2 (decisão D1): a OS nasce AUTOMATICAMENTE quando a chegada física das
 * peças é confirmada — nunca no fechamento comercial. Regra determinística e idempotente:
 *
 * - só para pedidos do fluxo "Novo serviço" (`auto_service_order`); pedidos antigos seguem o
 *   fluxo anterior (OS criada manualmente);
 * - UMA OS por recebimento, contendo SOMENTE as peças desse recebimento ainda sem OS
 *   (quantidade = min(recebida nesta linha, recebida − devolvida − já em OS));
 * - repetir a chamada para o mesmo recebimento devolve a OS já gerada (índice único
 *   `service_orders.source_receipt_id` garante no banco);
 * - recebimento parcial: só as peças que chegaram entram; as ausentes continuam no pedido e
 *   ganham a própria OS quando chegarem (novo recebimento → nova OS);
 * - peça já incluída manualmente em outra OS não é duplicada;
 * - sem titular, sem mão de obra, sem planejamento, sem tarefas: a OS fica disponível para o
 *   planejamento (Fase 4). A receita continua a do pedido (rateio proporcional existente).
 *
 * Deve ser chamada DENTRO da transação do recebimento, com o pedido e as peças já travados.
 */
export async function autoServiceOrderForReceipt(
  tx: Tx,
  actor: ActorContext,
  receiptId: string,
): Promise<ServiceOrder | null> {
  const receipt = await tx.receipt.findUniqueOrThrow({
    where: { id: receiptId },
    include: { lines: true, order: { include: { items: true } } },
  });
  const order = receipt.order;
  if (!order.autoServiceOrder || order.status === 'CANCELADO') return null;
  const existing = await tx.serviceOrder.findUnique({ where: { sourceReceiptId: receipt.id } });
  if (existing) return existing;

  const alloc = await itemAllocations(tx, order.id);
  const items: NewServiceOrderInput['items'] = [];
  // Ordem determinística: a mesma das peças no serviço fechado.
  for (const oi of [...order.items].sort((a, b) => a.position - b.position)) {
    const line = receipt.lines.find((l) => l.orderItemId === oi.id);
    if (!line) continue;
    const free = oi.receivedQuantity - oi.returnedQuantity - alloc.inServiceOrders(oi.id);
    const quantity = Math.min(line.quantity, free);
    if (quantity <= 0) continue;
    items.push({
      orderItemId: oi.id,
      quantity,
      serviceType: oi.serviceType ?? 'OUTRO',
      description: oi.description,
      fabricName: oi.fabricName,
      fabricColor: oi.fabricColor,
      fabricReference: oi.fabricReference,
      foamSpecs: null,
      technicalNotes: oi.technicalNotes ?? oi.notes,
    });
  }
  if (!items.length) return null;

  const rc = receiptCode(receipt.number);
  return createServiceOrder(
    tx,
    actor,
    NO_EXTRA_PERMISSIONS,
    {
      orderId: order.id,
      technicalInstructions: order.technicalNotes,
      notes: `Gerada automaticamente na chegada das peças (${rc}).`,
      promisedDate: order.promisedDate ? order.promisedDate.toISOString().slice(0, 10) : null,
      priority: 'NORMAL',
      technicalLeadId: null,
      items,
    },
    {
      sourceReceiptId: receipt.id,
      locked: true,
      summary: (code) =>
        `OS ${code} gerada automaticamente pelo recebimento ${rc} do pedido ${orderCode(order.number)}.`,
    },
  );
}
