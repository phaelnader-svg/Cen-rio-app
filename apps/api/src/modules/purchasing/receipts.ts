import {
  EVENT_TYPES,
  PURCHASE_ORDER_RECEIVABLE,
  materialReceiptCode,
  materialReceiptSchema,
  purchaseOrderCode,
  q3,
  reverseReceiptSchema,
  unitError,
  type PendingMaterialReceiptDto,
} from '@cenario/shared';
import type { PurchaseOrderStatus, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import {
  ANY_EMPLOYEE,
  MANAGEMENT_AUDIENCE,
  STOCK_AUTHORIZE,
  changeStock,
  lockRows,
  lockStockItem,
  num,
  poHistory,
  refreshReadiness,
  specOf,
} from './common';
import {
  lockPurchaseOrder,
  poServiceOrderIds,
  receiptInclude,
  toReceiptDto,
} from './purchase-orders';

const EPS = 1e-6;

const RECEIPT_VIEW = {
  session: 'WEB',
  anyPermissions: ['compras.ver', 'estoque.ver', 'estoque.gerenciar', 'estoque.autorizar'],
} as const;

/** Situação do pedido a partir do recebido líquido de cada item. */
function statusFromItems(
  items: { quantity: unknown; receivedQuantity: unknown }[],
): PurchaseOrderStatus {
  const all = items.every(
    (i) => num(i.receivedQuantity as never) + EPS >= num(i.quantity as never),
  );
  if (all) return 'RECEBIDO';
  return items.some((i) => num(i.receivedQuantity as never) > 0)
    ? 'PARCIALMENTE_RECEBIDO'
    : 'CONFIRMADO';
}

/**
 * Reserva automaticamente, para as OS de origem de uma compra consolidada, o que
 * acabou de entrar no estoque (na ordem das origens), sem ultrapassar a
 * necessidade de cada OS nem o saldo disponível.
 */
async function autoReserve(
  tx: Tx,
  actor: ActorContext,
  stock: Awaited<ReturnType<typeof lockStockItem>>,
  allocations: {
    materialRequirementId: string;
    serviceOrderId: string;
    quantity: unknown;
    createdAt: Date;
  }[],
) {
  const reserved: { reservationId: string; serviceOrderId: string; quantity: number }[] = [];
  const ordered = [...allocations].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const a of ordered) {
    const req = await tx.materialRequirement.findUnique({
      where: { id: a.materialRequirementId },
      include: {
        reservations: { where: { status: { in: ['ATIVA', 'CONSUMIDA'] } } },
        transfersIn: true,
        serviceOrder: { select: { status: true } },
      },
    });
    if (!req || req.serviceOrder.status !== 'ABERTA') continue;
    const have =
      req.reservations.reduce((s, r) => s + num(r.quantity), 0) +
      req.transfersIn.reduce((s, t) => s + num(t.quantity), 0);
    const available = num(stock.onHand) - num(stock.reserved);
    const qty = q3(Math.min(num(req.quantity) - have, num(a.quantity as never), available));
    if (qty <= 0) continue;
    if (unitError(stock.kind, stock.unit, qty)) continue;
    const r = await tx.stockReservation.create({
      data: {
        stockItemId: stock.id,
        serviceOrderId: a.serviceOrderId,
        materialRequirementId: req.id,
        quantity: qty,
        notes: 'Reserva automática no recebimento da compra',
        createdById: actor.userId,
      },
    });
    await changeStock(tx, actor, stock, { reserved: qty });
    reserved.push({ reservationId: r.id, serviceOrderId: a.serviceOrderId, quantity: qty });
  }
  return reserved;
}

export async function materialReceiptRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Pedidos aguardando chegada — para qualquer funcionário, sem preços. */
  app.get('/api/v1/material-receipts/pending', { config: { access: ANY_EMPLOYEE } }, async () => {
    const rows = await prisma.purchaseOrder.findMany({
      where: { status: { in: [...PURCHASE_ORDER_RECEIVABLE] } },
      include: {
        supplier: { select: { name: true } },
        items: {
          orderBy: { position: 'asc' },
          include: {
            serviceOrder: { select: { id: true, number: true } },
            allocations: {
              include: {
                serviceOrder: { select: { number: true } },
                requirement: { include: { serviceOrderItem: { select: { position: true } } } },
              },
            },
          },
        },
      },
      orderBy: [{ expectedDate: 'asc' }, { number: 'asc' }],
    });
    return rows.map(
      (po): PendingMaterialReceiptDto => ({
        id: po.id,
        code: purchaseOrderCode(po.number),
        status: po.status,
        supplierName: po.supplier?.name ?? null,
        expectedDate: dateOnly(po.expectedDate),
        items: po.items.map((i) => ({
          id: i.id,
          ...specOf(i, i.unit),
          sourcing: i.sourcing,
          quantity: num(i.quantity),
          receivedQuantity: num(i.receivedQuantity),
          remaining: Math.max(
            0,
            q3(num(i.quantity) + num(i.extraAuthorized) - num(i.receivedQuantity)),
          ),
          serviceOrder: i.serviceOrder
            ? { id: i.serviceOrder.id, code: serviceOrderCode(i.serviceOrder.number) }
            : null,
          destinations: [
            ...new Set(i.allocations.map((a) => serviceOrderCode(a.serviceOrder.number))),
          ],
        })),
      }),
    );
  });

  app.get('/api/v1/material-receipts', { config: { access: RECEIPT_VIEW } }, async (request) => {
    const q = z
      .object({
        purchaseOrderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    const rows = await prisma.materialReceipt.findMany({
      where: q.purchaseOrderId ? { purchaseOrderId: q.purchaseOrderId } : {},
      include: receiptInclude,
      orderBy: { number: 'desc' },
      take: q.limit,
    });
    return rows.map(toReceiptDto);
  });

  app.get(
    '/api/v1/material-receipts/:id',
    { config: { access: RECEIPT_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const r = await prisma.materialReceipt.findUnique({ where: { id }, include: receiptInclude });
      if (!r) throw Errors.notFound('Recebimento de material');
      return toReceiptDto(r);
    },
  );

  /**
   * Registra a chegada conferida. Só o recebido CONFORME entra no estoque/OS;
   * o que chega com problema fica registrado como divergência e não fica disponível.
   */
  app.post(
    '/api/v1/material-receipts',
    { config: { access: ANY_EMPLOYEE, idempotent: true } },
    async (request, reply) => {
      const input = materialReceiptSchema.parse(request.body);
      const actor = actorFrom(request);
      const receiptId = await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, input.purchaseOrderId);
        if (!(PURCHASE_ORDER_RECEIVABLE as readonly string[]).includes(po.status)) {
          throw Errors.business(
            po.status === 'RASCUNHO'
              ? 'Pedido ainda não confirmado pelo gestor.'
              : 'Este pedido não está aguardando recebimento.',
          );
        }
        await lockRows(
          tx,
          'purchase_order_items',
          po.items.map((i) => i.id),
        );
        const items = new Map(
          (
            await tx.purchaseOrderItem.findMany({
              where: { purchaseOrderId: po.id },
              include: { allocations: true },
            })
          ).map((i) => [i.id, i]),
        );
        const seen = new Set<string>();
        for (const [idx, l] of input.lines.entries()) {
          const item = items.get(l.purchaseOrderItemId);
          if (!item)
            throw Errors.validation(
              [{ path: `lines.${idx}`, message: 'Item não pertence ao pedido.' }],
              'Item não pertence ao pedido.',
            );
          if (seen.has(item.id))
            throw Errors.validation(undefined, 'Item repetido no recebimento.');
          seen.add(item.id);
          for (const v of [l.acceptedQuantity, l.rejectedQuantity ?? 0]) {
            const err = v > 0 ? unitError(item.kind, item.unit, v) : null;
            if (err) throw Errors.validation([{ path: `lines.${idx}`, message: err }], err);
          }
          const limit = num(item.quantity) + num(item.extraAuthorized);
          if (num(item.receivedQuantity) + l.acceptedQuantity > limit + EPS) {
            throw Errors.conflict(
              `Item ${item.position} (${item.description}): recebimento acima do pedido ` +
                `(pedido ${limit}, já recebido ${num(item.receivedQuantity)}). ` +
                'O gestor precisa autorizar o excedente antes.',
            );
          }
        }

        const receipt = await tx.materialReceipt.create({
          data: {
            purchaseOrderId: po.id,
            receivedById: actor.userId!,
            deviceId: request.auth?.deviceId ?? null,
            notes: input.notes ?? null,
          },
        });
        const affected = new Set(poServiceOrderIds(po));
        const reservations: { reservationId: string; serviceOrderId: string; quantity: number }[] =
          [];
        let issues = 0;
        for (const l of input.lines) {
          const item = items.get(l.purchaseOrderItemId)!;
          const line = await tx.materialReceiptLine.create({
            data: {
              receiptId: receipt.id,
              purchaseOrderItemId: item.id,
              acceptedQuantity: l.acceptedQuantity,
              rejectedQuantity: l.rejectedQuantity ?? 0,
              specConfirmed: l.specConfirmed,
              issue: l.issue ?? null,
              issueNote: l.issueNote ?? null,
            },
          });
          if (l.issue) issues++;
          if (l.acceptedQuantity <= 0) continue;
          await tx.purchaseOrderItem.update({
            where: { id: item.id },
            data: { receivedQuantity: q3(num(item.receivedQuantity) + l.acceptedQuantity) },
          });
          item.receivedQuantity = q3(num(item.receivedQuantity) + l.acceptedQuantity) as never;
          if (item.sourcing === 'ESTOQUE' && item.stockItemId) {
            const stock = await lockStockItem(tx, item.stockItemId);
            await changeStock(tx, actor, stock, {
              onHand: l.acceptedQuantity,
              movement: {
                type: 'ENTRADA_COMPRA',
                materialReceiptLineId: line.id,
                reason: `${materialReceiptCode(receipt.number)} / ${purchaseOrderCode(po.number)}`,
              },
            });
            reservations.push(...(await autoReserve(tx, actor, stock, item.allocations)));
          }
        }
        const status = statusFromItems([...items.values()]);
        if (status !== po.status) {
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { status, version: { increment: 1 } },
          });
        }
        await poHistory(tx, actor, po.id, {
          kind: 'RECEBIMENTO',
          summary: `${materialReceiptCode(receipt.number)}: material do pedido ${purchaseOrderCode(po.number)} recebido${issues ? ` com ${issues} divergência(s)` : ''}.`,
          changes: {
            receipt: materialReceiptCode(receipt.number),
            lines: input.lines.map((l) => ({
              item: items.get(l.purchaseOrderItemId)!.position,
              accepted: l.acceptedQuantity,
              rejected: l.rejectedQuantity ?? 0,
              issue: l.issue ?? null,
            })),
            status,
          },
        });
        await refreshReadiness(tx, actor, [...affected]);
        for (const r of reservations) {
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.STOCK_RESERVED,
            aggregateType: 'stock_reservation',
            aggregateId: r.reservationId,
            payload: {
              id: r.reservationId,
              serviceOrderId: r.serviceOrderId,
              quantity: r.quantity,
            },
            audience: MANAGEMENT_AUDIENCE,
          });
        }
        if (issues) {
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.MATERIAL_SHORTAGE_DETECTED,
            aggregateType: 'purchase_order',
            aggregateId: po.id,
            payload: {
              reason: 'DIVERGENCIA_RECEBIMENTO',
              purchaseOrderId: po.id,
              code: purchaseOrderCode(po.number),
              receipt: materialReceiptCode(receipt.number),
              serviceOrderIds: [...affected],
            },
            audience: MANAGEMENT_AUDIENCE,
          });
        }
        await appendEvent(tx, actor, {
          type:
            status === 'RECEBIDO'
              ? EVENT_TYPES.MATERIAL_RECEIVED
              : EVENT_TYPES.MATERIAL_PARTIALLY_RECEIVED,
          aggregateType: 'purchase_order',
          aggregateId: po.id,
          payload: {
            id: po.id,
            code: purchaseOrderCode(po.number),
            receiptId: receipt.id,
            receipt: materialReceiptCode(receipt.number),
            status,
            issues,
          },
          audience: 'all',
        });
        return receipt.id;
      });
      const r = await prisma.materialReceipt.findUniqueOrThrow({
        where: { id: receiptId },
        include: receiptInclude,
      });
      return reply.status(201).send(toReceiptDto(r));
    },
  );

  /**
   * Estorno (lançamento compensatório) de parte do recebido conforme. Nunca altera
   * o recebimento original; registra motivo, responsável e impacto no estoque.
   * Bloqueado se deixaria o estoque negativo ou abaixo do que já está reservado.
   */
  app.post(
    '/api/v1/material-receipts/lines/:id/reverse',
    { config: { access: STOCK_AUTHORIZE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = reverseReceiptSchema.parse(request.body);
      const actor = actorFrom(request);
      const receiptId = await prisma.$transaction(async (tx) => {
        const found = await tx.materialReceiptLine.findUnique({
          where: { id },
          include: { receipt: true },
        });
        if (!found) throw Errors.notFound('Linha de recebimento');
        const po = await lockPurchaseOrder(tx, found.receipt.purchaseOrderId);
        await lockRows(tx, 'purchase_order_items', [found.purchaseOrderItemId]);
        const line = await tx.materialReceiptLine.findUniqueOrThrow({
          where: { id },
          include: { reversals: true, item: true, receipt: true },
        });
        const item = line.item;
        const already = line.reversals.reduce((s, r) => s + num(r.quantity), 0);
        const reversible = q3(num(line.acceptedQuantity) - already);
        if (input.quantity > reversible + EPS) {
          throw Errors.business(`Só é possível estornar até ${reversible} desta linha.`);
        }
        const err = unitError(item.kind, item.unit, input.quantity);
        if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
        const newReceived = q3(num(item.receivedQuantity) - input.quantity);
        if (newReceived < 0) throw Errors.conflict('Estorno deixaria o recebido negativo.');

        const impact: Record<string, unknown> = {
          purchaseOrder: purchaseOrderCode(po.number),
          receipt: materialReceiptCode(line.receipt.number),
          itemReceivedBefore: num(item.receivedQuantity),
          itemReceivedAfter: newReceived,
        };
        if (item.sourcing === 'ESTOQUE' && item.stockItemId) {
          const stock = await lockStockItem(tx, item.stockItemId);
          impact.stockBefore = { onHand: num(stock.onHand), reserved: num(stock.reserved) };
          if (num(stock.onHand) - input.quantity < num(stock.reserved) - EPS) {
            throw Errors.conflict(
              'O estorno deixaria o estoque abaixo do que está reservado para OS. ' +
                'Libere as reservas necessárias antes de estornar.',
              { onHand: num(stock.onHand), reserved: num(stock.reserved) },
            );
          }
          const after = await changeStock(tx, actor, stock, {
            onHand: -input.quantity,
            movement: {
              type: 'ESTORNO_RECEBIMENTO',
              materialReceiptLineId: line.id,
              reason: input.reason,
            },
          });
          impact.stockAfter = after;
        } else {
          impact.serviceOrder = item.serviceOrderId;
        }
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { receivedQuantity: newReceived },
        });
        const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
        const status = statusFromItems(items);
        impact.statusBefore = po.status;
        impact.statusAfter = status;
        if (status !== po.status) {
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { status, version: { increment: 1 } },
          });
        }
        await tx.materialReceiptReversal.create({
          data: {
            receiptLineId: line.id,
            quantity: input.quantity,
            reason: input.reason,
            authorizedById: actor.userId!,
            impact: impact as never,
          },
        });
        await poHistory(tx, actor, po.id, {
          kind: 'ESTORNO',
          note: input.reason,
          summary: `Estorno de ${input.quantity} do recebimento ${materialReceiptCode(line.receipt.number)} (${purchaseOrderCode(po.number)}).`,
          changes: impact,
        });
        await audit(tx, actor, {
          action: 'material_receipt.reversed',
          entityType: 'material_receipt',
          entityId: line.receiptId,
          summary: `Recebimento ${materialReceiptCode(line.receipt.number)} estornado em ${input.quantity}: ${input.reason}`,
          changes: impact,
        });
        await refreshReadiness(tx, actor, poServiceOrderIds(po));
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.MATERIAL_RECEIPT_REVERSED,
          aggregateType: 'purchase_order',
          aggregateId: po.id,
          payload: {
            id: po.id,
            code: purchaseOrderCode(po.number),
            receiptId: line.receiptId,
            lineId: line.id,
            quantity: input.quantity,
            status,
          },
          audience: 'all',
        });
        return line.receiptId;
      });
      const r = await prisma.materialReceipt.findUniqueOrThrow({
        where: { id: receiptId },
        include: receiptInclude,
      });
      return toReceiptDto(r);
    },
  );
}
