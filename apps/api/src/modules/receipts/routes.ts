import {
  EVENT_TYPES,
  PICKUP_RECEIVABLE,
  anyPermissionAudience,
  createReceiptSchema,
  type ReceiptDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams, toEmployeeSummary } from '../presenters';
import {
  lockOrder,
  lockOrderItems,
  orderCode,
  pickupCode,
  receiptCode,
  toCustomerSummary,
} from '../commercial/common';
import { refreshOrderStatus } from '../commercial/status';
import { emitOrderEvent } from '../orders/routes';
import { emitPickupEvent } from '../pickups/routes';

/** Quem registra recebimentos pode usar painel ou (futuramente) tablet. */
const REGISTER = { session: 'any', permissions: ['recebimentos.registrar'] } as const;
const VIEW = { session: 'any', anyPermissions: ['pedidos.ver', 'recebimentos.registrar'] } as const;
const AUDIENCE = anyPermissionAudience('pedidos.ver', 'recebimentos.registrar', 'os.gerenciar');
/** Tolerância para relógios de dispositivos ligeiramente adiantados. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const fullInclude = {
  order: { include: { customer: true } },
  pickup: { select: { id: true, number: true } },
  receivedBy: true,
  registeredBy: { select: { displayName: true } },
  lines: {
    include: {
      orderItem: true,
      corrections: { orderBy: { createdAt: 'desc' as const }, take: 1 },
    },
    orderBy: { orderItem: { position: 'asc' as const } },
  },
} satisfies Prisma.ReceiptInclude;

async function loadReceiptDto(db: PrismaClient | Tx, id: string): Promise<ReceiptDto> {
  const r = await db.receipt.findUnique({ where: { id }, include: fullInclude });
  if (!r) throw Errors.notFound('Recebimento');
  return {
    id: r.id,
    number: r.number,
    code: receiptCode(r.number),
    order: { id: r.orderId, code: orderCode(r.order.number) },
    customer: toCustomerSummary(r.order.customer),
    pickup: r.pickup ? { id: r.pickup.id, code: pickupCode(r.pickup.number) } : null,
    origin: r.origin,
    receivedAt: r.receivedAt.toISOString(),
    receivedBy: r.receivedBy ? toEmployeeSummary(r.receivedBy) : null,
    registeredBy: r.registeredBy?.displayName ?? null,
    divergences: r.divergences,
    notes: r.notes,
    lines: r.lines.map((l) => ({
      id: l.id,
      orderItemId: l.orderItemId,
      pieceType: l.orderItem.pieceType,
      description: l.orderItem.description,
      quantity: l.quantity,
      condition: l.condition,
      conditionNotes: l.conditionNotes,
      location: l.location,
      correctedQuantity: l.corrections[0]?.newQuantity ?? null,
    })),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function receiptRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/receipts', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({
        orderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    const rows = await prisma.receipt.findMany({
      where: q.orderId ? { orderId: q.orderId } : {},
      select: { id: true },
      orderBy: { receivedAt: 'desc' },
      take: q.limit,
    });
    return Promise.all(rows.map((r) => loadReceiptDto(prisma, r.id)));
  });

  /**
   * Pedidos com peças ainda não recebidas — apenas o necessário para a
   * conferência (sem valores nem contatos do cliente).
   */
  app.get('/api/v1/receipts/pending', { config: { access: REGISTER } }, async () => {
    const orders = await prisma.commercialOrder.findMany({
      where: { status: { not: 'CANCELADO' }, items: { some: {} } },
      include: {
        customer: true,
        items: { orderBy: { position: 'asc' } },
        pickups: {
          where: { status: { in: [...PICKUP_RECEIVABLE] } },
          include: { items: true },
          orderBy: { scheduledDate: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return orders
      .filter((o) => o.items.some((i) => i.receivedQuantity < i.quantity))
      .map((o) => ({
        id: o.id,
        code: orderCode(o.number),
        status: o.status,
        customer: toCustomerSummary(o.customer),
        items: o.items.map((i) => ({
          id: i.id,
          pieceType: i.pieceType,
          description: i.description,
          quantity: i.quantity,
          receivedQuantity: i.receivedQuantity,
          pending: i.quantity - i.receivedQuantity,
        })),
        pickups: o.pickups.map((p) => ({
          id: p.id,
          code: pickupCode(p.number),
          status: p.status,
          scheduledDate: p.scheduledDate?.toISOString().slice(0, 10) ?? null,
          items: p.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
        })),
      }));
  });

  app.get('/api/v1/receipts/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadReceiptDto(prisma, id);
  });

  /**
   * Registro do recebimento físico. Proteções contra duplicidade:
   * 1. Idempotency-Key (reenvio/duplo clique devolve o mesmo recebimento);
   * 2. bloqueio das linhas do pedido + checagem do saldo pendente por peça
   *    (recebimentos simultâneos não ultrapassam a quantidade do pedido);
   * 3. restrição no banco: recebido ≤ quantidade;
   * 4. retirada já recebida não aceita novo recebimento.
   */
  app.post(
    '/api/v1/receipts',
    { config: { access: REGISTER, idempotent: true } },
    async (request, reply) => {
      const input = createReceiptSchema.parse(request.body);
      const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
      if (receivedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
        throw Errors.validation(
          [{ path: 'receivedAt', message: 'A data de recebimento não pode estar no futuro.' }],
          'A data de recebimento não pode estar no futuro.',
        );
      }
      if (input.origin === 'RETIRADA' && !input.pickupId) {
        throw Errors.validation(
          [{ path: 'pickupId', message: 'Selecione a retirada de origem.' }],
          'Selecione a retirada de origem.',
        );
      }
      const auth = request.auth!;
      const id = await prisma.$transaction(async (tx) => {
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
          if (!(PICKUP_RECEIVABLE as readonly string[]).includes(pickup.status)) {
            throw Errors.conflict(
              pickup.status === 'RECEBIDA_NA_OFICINA'
                ? 'Esta retirada já teve o recebimento registrado.'
                : 'Esta retirada não está em situação de recebimento.',
            );
          }
        }

        const seen = new Set<string>();
        for (const line of input.lines) {
          const item = order.items.find((i) => i.id === line.orderItemId);
          if (!item) throw Errors.validation(undefined, 'Peça não pertence a este pedido.');
          if (seen.has(item.id))
            throw Errors.validation(undefined, 'Peça repetida no recebimento.');
          seen.add(item.id);
          const pending = item.quantity - item.receivedQuantity;
          if (line.quantity > pending) {
            throw Errors.conflict(
              pending === 0
                ? `"${item.description}" já foi totalmente recebida.`
                : `"${item.description}": só ${pending} peça(s) pendente(s) de recebimento.`,
              { orderItemId: item.id, pending },
            );
          }
        }

        let receivedByEmployeeId = input.receivedByEmployeeId ?? auth.employeeId;
        if (input.receivedByEmployeeId) {
          const e = await tx.employee.findUnique({ where: { id: input.receivedByEmployeeId } });
          if (!e || !e.active)
            throw Errors.validation(undefined, 'Responsável pelo recebimento inválido.');
          receivedByEmployeeId = e.id;
        }

        const actor = actorFrom(request);
        const receipt = await tx.receipt.create({
          data: {
            orderId: order.id,
            pickupId: pickup?.id ?? null,
            origin: input.origin,
            receivedAt,
            receivedByEmployeeId,
            registeredById: actor.userId,
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
          await tx.pickupRequest.update({
            where: { id: pickup.id },
            data: { status: 'RECEBIDA_NA_OFICINA', version: { increment: 1 } },
          });
          await tx.pickupEvent.create({
            data: {
              pickupId: pickup.id,
              kind: 'RECEBIDA_NA_OFICINA',
              fromStatus: pickup.status,
              toStatus: 'RECEBIDA_NA_OFICINA',
              note: `Recebimento ${receiptCode(receipt.number)}`,
              source: 'SISTEMA',
              recordedById: actor.userId,
            },
          });
        }
        const status = await refreshOrderStatus(tx, order.id);
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
          },
          audience: AUDIENCE,
        });
        if (pickup)
          await emitPickupEvent(tx, request, pickup.id, EVENT_TYPES.PICKUP_STATUS_CHANGED);
        await emitOrderEvent(tx, request, order.id);
        return receipt.id;
      });
      return reply.status(201).send(await loadReceiptDto(prisma, id));
    },
  );
}
