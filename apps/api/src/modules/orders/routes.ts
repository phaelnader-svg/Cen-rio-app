import {
  EVENT_TYPES,
  anyPermissionAudience,
  cancelOrderSchema,
  createOrderSchema,
  orderQuerySchema,
  updateOrderSchema,
  type OrderDto,
  type OrderSummaryDto,
  type PageDto,
} from '@cenario/shared';
import type {
  CommercialOrder,
  CommercialOrderItem,
  Customer,
  Prisma,
  PrismaClient,
  Tx,
} from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  activeAddress,
  asSnapshot,
  can,
  lockOrder,
  lockOrderItems,
  orderCode,
  snapshotAddress,
  toCustomerSummary,
} from '../commercial/common';
import { ACTIVE_PICKUP_STATUSES, itemAllocations, refreshOrderStatus } from '../commercial/status';

const VIEW = { session: 'WEB', permissions: ['pedidos.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['pedidos.gerenciar'] } as const;
export const ORDER_AUDIENCE = anyPermissionAudience(
  'pedidos.ver',
  'recebimentos.registrar',
  'os.gerenciar',
);

type OrderFull = CommercialOrder & {
  customer: Customer;
  items: CommercialOrderItem[];
  createdBy: { displayName: string } | null;
};

const fullInclude = {
  customer: true,
  items: { orderBy: { position: 'asc' as const } },
  createdBy: { select: { displayName: true } },
} satisfies Prisma.CommercialOrderInclude;

function toSummary(
  o: CommercialOrder & {
    customer: Customer;
    items: Pick<CommercialOrderItem, 'quantity' | 'receivedQuantity'>[];
  },
): OrderSummaryDto {
  return {
    id: o.id,
    number: o.number,
    code: orderCode(o.number),
    status: o.status,
    customer: toCustomerSummary(o.customer),
    contractedService: o.contractedService,
    totalPieces: o.items.reduce((a, i) => a + i.quantity, 0),
    receivedPieces: o.items.reduce((a, i) => a + i.receivedQuantity, 0),
    createdAt: o.createdAt.toISOString(),
  };
}

export async function loadOrderDto(
  db: PrismaClient | Tx,
  request: FastifyRequest,
  id: string,
): Promise<OrderDto> {
  const o = (await db.commercialOrder.findUnique({
    where: { id },
    include: fullInclude,
  })) as OrderFull | null;
  if (!o) throw Errors.notFound('Pedido');
  const alloc = await itemAllocations(db as Tx, id);
  const valuesVisible = can(request, 'pedidos.valores');
  return {
    ...toSummary(o),
    pickupAddressId: o.pickupAddressId,
    pickupAddress: asSnapshot(o.pickupAddressSnapshot),
    description: o.description,
    agreedValueCents: valuesVisible ? o.agreedValueCents : null,
    paymentTerms: valuesVisible ? o.paymentTerms : null,
    valuesVisible,
    notes: o.notes,
    items: o.items.map((i) => ({
      id: i.id,
      position: i.position,
      pieceType: i.pieceType,
      description: i.description,
      quantity: i.quantity,
      notes: i.notes,
      receivedQuantity: i.receivedQuantity,
      inActivePickups: alloc.inPickups(i.id),
      inServiceOrders: alloc.inServiceOrders(i.id),
    })),
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    createdBy: o.createdBy?.displayName ?? null,
    version: o.version,
    updatedAt: o.updatedAt.toISOString(),
  };
}

export async function emitOrderEvent(
  tx: Tx,
  request: FastifyRequest,
  orderId: string,
  type: (typeof EVENT_TYPES)[
    | 'ORDER_CREATED'
    | 'ORDER_UPDATED'
    | 'ORDER_CANCELLED'] = EVENT_TYPES.ORDER_UPDATED,
) {
  const o = await tx.commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
  await appendEvent(tx, actorFrom(request), {
    type,
    aggregateType: 'commercial_order',
    aggregateId: orderId,
    payload: { id: orderId, code: orderCode(o.number), status: o.status, version: o.version },
    audience: ORDER_AUDIENCE,
  });
}

export async function orderRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/orders', { config: { access: VIEW } }, async (request) => {
    const q = orderQuerySchema.parse(request.query);
    const numberMatch = q.q?.match(/^(?:pc-?)?0*(\d{1,9})$/i);
    const where: Prisma.CommercialOrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.q
        ? {
            OR: [
              ...(numberMatch ? [{ number: Number(numberMatch[1]) }] : []),
              { customer: { name: { contains: q.q, mode: 'insensitive' } } },
              { contractedService: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.commercialOrder.count({ where }),
      prisma.commercialOrder.findMany({
        where,
        include: { customer: true, items: { select: { quantity: true, receivedQuantity: true } } },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
    ]);
    return { items: rows.map(toSummary), total } satisfies PageDto<OrderSummaryDto>;
  });

  app.get('/api/v1/orders/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadOrderDto(prisma, request, id);
  });

  app.post(
    '/api/v1/orders',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createOrderSchema.parse(request.body);
      const hasValues =
        (input.agreedValueCents !== null && input.agreedValueCents !== undefined) ||
        Boolean(input.paymentTerms);
      if (hasValues && !can(request, 'pedidos.valores')) {
        throw Errors.forbidden(
          'Você não tem permissão para informar valores e condições comerciais.',
        );
      }
      const id = await prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
        if (!customer || !customer.active)
          throw Errors.validation(undefined, 'Cliente inválido ou arquivado.');
        const address = input.pickupAddressId
          ? await activeAddress(tx, customer.id, input.pickupAddressId)
          : null;
        const actor = actorFrom(request);
        const order = await tx.commercialOrder.create({
          data: {
            customerId: customer.id,
            pickupAddressId: address?.id ?? null,
            pickupAddressSnapshot: address
              ? (snapshotAddress(address) as unknown as Prisma.InputJsonValue)
              : undefined,
            contractedService: input.contractedService,
            description: input.description ?? null,
            agreedValueCents: input.agreedValueCents ?? null,
            paymentTerms: input.paymentTerms ?? null,
            notes: input.notes ?? null,
            createdById: actor.userId,
            items: {
              create: input.items.map((i, idx) => ({
                position: idx + 1,
                pieceType: i.pieceType,
                description: i.description,
                quantity: i.quantity,
                notes: i.notes ?? null,
              })),
            },
          },
        });
        await audit(tx, actor, {
          action: 'order.created',
          entityType: 'commercial_order',
          entityId: order.id,
          summary: `Pedido ${orderCode(order.number)} criado para ${customer.name}.`,
          changes: {
            items: input.items.map((i) => `${i.quantity}× ${i.description}`),
            agreedValueCents: order.agreedValueCents,
            paymentTerms: order.paymentTerms,
          },
        });
        await emitOrderEvent(tx, request, order.id, EVENT_TYPES.ORDER_CREATED);
        return order.id;
      });
      return reply.status(201).send(await loadOrderDto(prisma, request, id));
    },
  );

  app.put('/api/v1/orders/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateOrderSchema.parse(request.body);
    const valuesAllowed = can(request, 'pedidos.valores');
    await prisma.$transaction(async (tx) => {
      if (!(await lockOrder(tx, id))) throw Errors.notFound('Pedido');
      await lockOrderItems(tx, id);
      const before = await tx.commercialOrder.findUniqueOrThrow({
        where: { id },
        include: fullInclude,
      });
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (before.status === 'CANCELADO')
        throw Errors.business('Pedido cancelado não pode ser alterado.');

      const valuesChanged =
        (input.agreedValueCents ?? null) !== before.agreedValueCents ||
        (input.paymentTerms ?? null) !== before.paymentTerms;
      // Sem permissão de valores, os valores atuais são preservados (o usuário nem os vê).
      const nextValue = valuesAllowed ? (input.agreedValueCents ?? null) : before.agreedValueCents;
      const nextTerms = valuesAllowed ? (input.paymentTerms ?? null) : before.paymentTerms;

      const address =
        input.pickupAddressId && input.pickupAddressId !== before.pickupAddressId
          ? await activeAddress(tx, before.customerId, input.pickupAddressId)
          : null;

      // Itens: atualizar, incluir e remover respeitando o que já foi retirado/recebido/alocado.
      const alloc = await itemAllocations(tx, id);
      const existing = new Map(before.items.map((i) => [i.id, i]));
      const keepIds = new Set(input.items.filter((i) => i.id).map((i) => i.id!));
      for (const i of input.items) {
        if (i.id && !existing.has(i.id))
          throw Errors.validation(undefined, 'Item não pertence ao pedido.');
      }
      for (const old of before.items) {
        if (keepIds.has(old.id)) continue;
        if (
          old.receivedQuantity > 0 ||
          alloc.inPickups(old.id) > 0 ||
          alloc.inServiceOrders(old.id) > 0
        ) {
          throw Errors.business(
            `A peça "${old.description}" já tem retirada ou recebimento e não pode ser removida.`,
          );
        }
      }
      await tx.commercialOrderItem.deleteMany({
        where: { orderId: id, id: { notIn: [...keepIds] } },
      });
      // Posições temporárias negativas evitam colisão na restrição única durante a renumeração.
      await tx.$executeRaw`UPDATE commercial_order_items SET position = -position WHERE order_id = ${id}::uuid`;
      let position = 0;
      for (const i of input.items) {
        position++;
        if (i.id) {
          const old = existing.get(i.id)!;
          const minimum = Math.max(
            old.receivedQuantity + alloc.inPickups(old.id),
            alloc.inServiceOrders(old.id),
          );
          if (i.quantity < minimum) {
            throw Errors.business(
              `A quantidade de "${i.description}" não pode ser menor que ${minimum} (já em retirada ou recebida).`,
            );
          }
          await tx.commercialOrderItem.update({
            where: { id: i.id },
            data: {
              position,
              pieceType: i.pieceType,
              description: i.description,
              quantity: i.quantity,
              notes: i.notes ?? null,
            },
          });
        } else {
          await tx.commercialOrderItem.create({
            data: {
              orderId: id,
              position,
              pieceType: i.pieceType,
              description: i.description,
              quantity: i.quantity,
              notes: i.notes ?? null,
            },
          });
        }
      }

      const after = await tx.commercialOrder.update({
        where: { id, version: input.version },
        data: {
          ...(address
            ? {
                pickupAddressId: address.id,
                pickupAddressSnapshot: snapshotAddress(address) as unknown as Prisma.InputJsonValue,
              }
            : {}),
          contractedService: input.contractedService,
          description: input.description ?? null,
          agreedValueCents: nextValue,
          paymentTerms: nextTerms,
          notes: input.notes ?? null,
          version: { increment: 1 },
        },
        include: fullInclude,
      });
      await refreshOrderStatus(tx, id);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of [
        'contractedService',
        'description',
        'notes',
        'agreedValueCents',
        'paymentTerms',
      ] as const) {
        if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
      }
      if (address)
        changes.pickupAddress = {
          from: asSnapshot(before.pickupAddressSnapshot)?.label ?? null,
          to: address.label,
        };
      const describeItems = (items: CommercialOrderItem[]) =>
        items.map((x) => `${x.quantity}× ${x.description}`);
      if (
        JSON.stringify(describeItems(before.items)) !== JSON.stringify(describeItems(after.items))
      ) {
        changes.items = { from: describeItems(before.items), to: describeItems(after.items) };
      }
      await audit(tx, actorFrom(request), {
        action: valuesAllowed && valuesChanged ? 'order.updated_with_values' : 'order.updated',
        entityType: 'commercial_order',
        entityId: id,
        summary: `Pedido ${orderCode(after.number)} alterado.`,
        changes,
      });
      await emitOrderEvent(tx, request, id);
    });
    return loadOrderDto(prisma, request, id);
  });

  app.post(
    '/api/v1/orders/:id/cancel',
    { config: { access: { session: 'WEB', permissions: ['pedidos.cancelar'] } } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelOrderSchema.parse(request.body);
      await prisma.$transaction(async (tx) => {
        if (!(await lockOrder(tx, id))) throw Errors.notFound('Pedido');
        const before = await tx.commercialOrder.findUniqueOrThrow({
          where: { id },
          include: fullInclude,
        });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        if (before.status === 'CANCELADO') throw Errors.business('O pedido já está cancelado.');
        if (before.items.some((i) => i.receivedQuantity > 0)) {
          throw Errors.business(
            'Há peças deste pedido na oficina. O cancelamento com devolução será tratado em fase futura.',
          );
        }
        const actor = actorFrom(request);
        await tx.commercialOrder.update({
          where: { id },
          data: {
            status: 'CANCELADO',
            cancelledAt: new Date(),
            cancelledById: actor.userId,
            cancelReason: input.reason,
            version: { increment: 1 },
          },
        });
        // Retiradas ainda ativas são canceladas junto, com registro na linha do tempo.
        const pickups = await tx.pickupRequest.findMany({
          where: { orderId: id, status: { in: [...ACTIVE_PICKUP_STATUSES] } },
        });
        for (const p of pickups) {
          await tx.pickupRequest.update({
            where: { id: p.id },
            data: { status: 'CANCELADA', version: { increment: 1 } },
          });
          await tx.pickupEvent.create({
            data: {
              pickupId: p.id,
              kind: 'CANCELADA',
              fromStatus: p.status,
              toStatus: 'CANCELADA',
              note: `Pedido cancelado: ${input.reason}`,
              source: 'SISTEMA',
              recordedById: actor.userId,
            },
          });
        }
        await audit(tx, actor, {
          action: 'order.cancelled',
          entityType: 'commercial_order',
          entityId: id,
          summary: `Pedido ${orderCode(before.number)} cancelado.`,
          changes: { reason: input.reason, cancelledPickups: pickups.length },
        });
        await emitOrderEvent(tx, request, id, EVENT_TYPES.ORDER_CANCELLED);
      });
      return loadOrderDto(prisma, request, id);
    },
  );
}
