import {
  EVENT_TYPES,
  PICKUP_RECEIVABLE,
  anyPermissionAudience,
  type createReceiptSchema,
  type PickupStatus,
} from '@cenario/shared';
import type { Receipt, Tx } from '@cenario/db';
import type { z } from 'zod';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { lockOrder, lockOrderItems, orderCode, receiptCode } from '../commercial/common';
import { refreshOrderStatus } from '../commercial/status';
import { syncTripCost } from '../finance/trip-costs';
import { emitOrderEvent } from '../orders/routes';
import { emitPickupEvent } from '../pickups/routes';
import { reevaluateTasks, waitingTaskIds } from '../production/common';
import { autoServiceOrderForReceipt } from '../service-orders/auto';

/**
 * Serviço de domínio do recebimento de peças (Simplificação Fase 3). Uma única função atende o
 * painel (`POST /api/v1/receipts`) e a confirmação rápida dos tablets
 * (`POST /api/v1/arrivals/pickups/:id/confirm`) — não há segundo sistema de recebimentos.
 *
 * Proteções contra duplicidade: Idempotency-Key (rota) · trava do pedido e das peças · saldo
 * pendente por peça · restrição do banco (recebido ≤ quantidade) · versão da retirada esperada
 * (`expectedPickupVersion`, quando informada: confirmação feita sobre tela desatualizada é
 * recusada com 409) · OS automática única por recebimento (Fase 2).
 */
export const RECEIPT_AUDIENCE = anyPermissionAudience(
  'pedidos.ver',
  'recebimentos.registrar',
  'os.gerenciar',
);

export type NewReceiptInput = z.output<typeof createReceiptSchema>;

export interface ReceiptContext {
  employeeId: string | null;
  deviceId: string | null;
  /** Fase 3: versão da retirada vista por quem confirma (concorrência otimista). */
  expectedPickupVersion?: number;
  /** Fase 3: confirmação rápida — limita cada peça ao saldo DESTA retirada. */
  limitToPickupBalance?: boolean;
}

/** Saldo de cada peça de uma retirada = quantidade da retirada − já recebida por ela. */
export async function pickupBalance(tx: Tx, pickupId: string) {
  const items = await tx.pickupRequestItem.findMany({ where: { pickupId } });
  const lines = await tx.receiptLine.findMany({
    where: { receipt: { pickupId } },
    select: { orderItemId: true, quantity: true },
  });
  const received = new Map<string, number>();
  for (const l of lines)
    received.set(l.orderItemId, (received.get(l.orderItemId) ?? 0) + l.quantity);
  return new Map(
    items.map((i) => [i.orderItemId, Math.max(0, i.quantity - (received.get(i.orderItemId) ?? 0))]),
  );
}

export async function registerReceipt(
  tx: Tx,
  actor: ActorContext,
  ctx: ReceiptContext,
  input: NewReceiptInput,
): Promise<Receipt> {
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (!(await lockOrder(tx, input.orderId))) throw Errors.notFound('Pedido');
  await lockOrderItems(tx, input.orderId);
  const order = await tx.commercialOrder.findUniqueOrThrow({
    where: { id: input.orderId },
    include: { items: true },
  });
  if (order.status === 'CANCELADO')
    throw Errors.business('Pedido cancelado não pode receber peças.');

  let pickup = null;
  if (input.origin === 'RETIRADA') {
    pickup = await tx.pickupRequest.findFirst({
      where: { id: input.pickupId!, orderId: order.id },
    });
    if (!pickup) throw Errors.validation(undefined, 'Retirada não pertence a este pedido.');
    if (ctx.expectedPickupVersion !== undefined && pickup.version !== ctx.expectedPickupVersion)
      throw Errors.conflict(
        'Este recebimento já foi atualizado. Confira o saldo atual antes de confirmar.',
        {
          currentVersion: pickup.version,
        },
      );
    if (!(PICKUP_RECEIVABLE as readonly string[]).includes(pickup.status)) {
      throw Errors.conflict(
        pickup.status === 'RECEBIDA_NA_OFICINA'
          ? 'Esta retirada já teve o recebimento registrado.'
          : 'Esta retirada não está em situação de recebimento.',
      );
    }
  }
  const balance = pickup && ctx.limitToPickupBalance ? await pickupBalance(tx, pickup.id) : null;

  const seen = new Set<string>();
  for (const line of input.lines) {
    const item = order.items.find((i) => i.id === line.orderItemId);
    if (!item) throw Errors.validation(undefined, 'Peça não pertence a este pedido.');
    if (seen.has(item.id)) throw Errors.validation(undefined, 'Peça repetida no recebimento.');
    seen.add(item.id);
    const pending = Math.min(
      item.quantity - item.receivedQuantity,
      balance ? (balance.get(item.id) ?? 0) : Number.POSITIVE_INFINITY,
    );
    if (line.quantity > pending) {
      throw Errors.conflict(
        pending === 0
          ? `"${item.description}" já foi totalmente recebida.`
          : `"${item.description}": só ${pending} peça(s) pendente(s) de recebimento.`,
        { orderItemId: item.id, pending },
      );
    }
  }

  let receivedByEmployeeId = input.receivedByEmployeeId ?? ctx.employeeId;
  if (input.receivedByEmployeeId) {
    const e = await tx.employee.findUnique({ where: { id: input.receivedByEmployeeId } });
    if (!e || !e.active)
      throw Errors.validation(undefined, 'Responsável pelo recebimento inválido.');
    receivedByEmployeeId = e.id;
  }

  const receipt = await tx.receipt.create({
    data: {
      orderId: order.id,
      pickupId: pickup?.id ?? null,
      origin: input.origin,
      receivedAt,
      receivedByEmployeeId,
      registeredById: actor.userId,
      deviceId: ctx.deviceId,
      divergences: input.divergences ?? null,
      notes: input.notes ?? null,
      lines: {
        create: input.lines.map((l) => ({
          orderItemId: l.orderItemId,
          quantity: l.quantity,
          condition: l.condition,
          conditionNotes: l.conditionNotes ?? null,
          location: l.location,
        })),
      },
    },
  });
  for (const l of input.lines) {
    await tx.commercialOrderItem.update({
      where: { id: l.orderItemId },
      data: { receivedQuantity: { increment: l.quantity } },
    });
  }
  if (pickup) {
    // Fase 3: a retirada só fica "recebida na oficina" quando TODAS as peças dela chegaram. Na
    // chegada parcial a coleta obviamente aconteceu (vai a "retirada realizada", o custo da
    // viagem segue a regra da Fase 6) e o saldo continua aguardando chegada.
    const left = [...(await pickupBalance(tx, pickup.id)).values()].reduce((a, b) => a + b, 0);
    const toStatus: PickupStatus = left === 0 ? 'RECEBIDA_NA_OFICINA' : 'RETIRADA_REALIZADA';
    await tx.pickupRequest.update({
      where: { id: pickup.id },
      data: { status: toStatus, version: { increment: 1 } },
    });
    await tx.pickupEvent.create({
      data: {
        pickupId: pickup.id,
        kind: left === 0 ? 'RECEBIDA_NA_OFICINA' : 'RECEBIMENTO_PARCIAL',
        fromStatus: pickup.status,
        toStatus,
        note: `Recebimento ${receiptCode(receipt.number)}${left ? ` · ${left} peça(s) ainda aguardando chegada` : ''}`,
        source: 'SISTEMA',
        recordedById: actor.userId,
      },
    });
    await syncTripCost(tx, actor, { pickupId: pickup.id });
  }
  const status = await refreshOrderStatus(tx, order.id);
  // Simplificação Fase 2 (D1): pedido do Novo serviço → a OS das peças que chegaram nasce aqui,
  // na MESMA transação (falhou a OS, nada do recebimento é gravado).
  const generated = await autoServiceOrderForReceipt(tx, actor, receipt.id);
  // Simplificação Fase 3 (plano CA3-10): a chegada reavalia as tarefas que aguardam início nas
  // OS abertas com estas peças (ex.: OS anterior à chegada, de dados legados, bloqueada por
  // "peça não recebida"). Mesma transação do recebimento (falhou, nada muda); idempotente:
  // sem mudança de situação nada é gravado; nunca cria tarefa nem inicia trabalho.
  const taskStatusChanges = await reevaluateTasks(
    tx,
    actor,
    await waitingTaskIds(tx, {
      serviceOrder: {
        status: 'ABERTA',
        items: { some: { orderItemId: { in: input.lines.map((l) => l.orderItemId) } } },
      },
    }),
  );
  const total = input.lines.reduce((a, l) => a + l.quantity, 0);
  await audit(tx, actor, {
    action: 'receipt.registered',
    entityType: 'receipt',
    entityId: receipt.id,
    summary: `Recebimento ${receiptCode(receipt.number)}: ${total} peça(s) do pedido ${orderCode(order.number)}${
      status === 'RECEBIDO_PARCIAL' ? ' (parcial)' : ''
    }.`,
    changes: {
      lines: input.lines.map((l) => ({
        orderItemId: l.orderItemId,
        quantity: l.quantity,
        condition: l.condition,
      })),
      divergences: input.divergences ?? null,
      ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
      ...(generated ? { generatedServiceOrderId: generated.id } : {}),
      ...(taskStatusChanges ? { taskStatusChanges } : {}),
    },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.RECEIPT_REGISTERED,
    aggregateType: 'receipt',
    aggregateId: receipt.id,
    payload: {
      id: receipt.id,
      code: receiptCode(receipt.number),
      orderId: order.id,
      pickupId: pickup?.id ?? null,
      pieces: total,
      orderStatus: status,
      serviceOrderId: generated?.id ?? null,
    },
    audience: RECEIPT_AUDIENCE,
  });
  if (pickup) await emitPickupEvent(tx, actor, pickup.id, EVENT_TYPES.PICKUP_STATUS_CHANGED);
  await emitOrderEvent(tx, actor, order.id);
  return receipt;
}
