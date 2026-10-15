import {
  EVENT_TYPES,
  anyPermissionAudience,
  cancelOrderSchema,
  createOrderSchema,
  orderPlannedIntentSchema,
  orderQuerySchema,
  updateOrderPromisedDateSchema,
  updateOrderSchema,
  type OrderDto,
  type OrderPromisedDateChangeDto,
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
import { actorFrom, actorOf, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  activeAddress,
  asSnapshot,
  can,
  dateOnly,
  lockOrder,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  snapshotAddress,
  toCustomerSummary,
} from '../commercial/common';
import {
  ACTIVE_PICKUP_STATUSES,
  itemAllocations,
  refreshOrderStatus,
  serviceStates,
} from '../commercial/status';
import { syncTripCost } from '../finance/trip-costs';
import { assertIntentEligible, canPlanLabor, canPlanUpholsterer } from './planned-intent';
import { createOrder } from './service';
import { orderDeadlines, serviceDeadlines } from '../deadlines/service';
import { changeServiceOrderPromisedDate } from '../service-orders/routes';

const PROMISED_ACTION = 'order.promised_date_changed';
const br = (d: string | null) => (d ? d.split('-').reverse().join('/') : 'sem prazo');

const VIEW = { session: 'WEB', permissions: ['pedidos.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['pedidos.gerenciar'] } as const;
export const ORDER_AUDIENCE = anyPermissionAudience(
  'pedidos.ver',
  'recebimentos.registrar',
  'os.gerenciar',
);

type OrderFull = CommercialOrder & {
  customer: Customer;
  items: (CommercialOrderItem & { plannedUpholsterer: { displayName: string } | null })[];
  createdBy: { displayName: string } | null;
};

const fullInclude = {
  customer: true,
  items: {
    orderBy: { position: 'asc' as const },
    include: { plannedUpholsterer: { select: { displayName: true } } },
  },
  createdBy: { select: { displayName: true } },
} satisfies Prisma.CommercialOrderInclude;

function toSummary(
  o: CommercialOrder & {
    customer: Customer;
    items: Pick<CommercialOrderItem, 'quantity' | 'receivedQuantity' | 'returnedQuantity'>[];
  },
  state: { returnedPieces: number; serviceState: OrderSummaryDto['serviceState'] },
): OrderSummaryDto {
  return {
    id: o.id,
    number: o.number,
    code: orderCode(o.number),
    status: o.status,
    customerDropOff: o.customerDropOff,
    customer: toCustomerSummary(o.customer),
    contractedService: o.contractedService,
    totalPieces: o.items.reduce((a, i) => a + i.quantity, 0),
    receivedPieces: o.items.reduce((a, i) => a + i.receivedQuantity, 0),
    returnedPieces: state.returnedPieces,
    serviceState: state.serviceState,
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
  const plannedLaborVisible = can(request, 'financeiro.ver');
  return {
    ...toSummary(o, (await serviceStates(db, [o])).get(o.id)!),
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
      returnedQuantity: i.returnedQuantity,
      plannedUpholsterer:
        i.plannedUpholstererUserId && i.plannedUpholsterer
          ? { userId: i.plannedUpholstererUserId, displayName: i.plannedUpholsterer.displayName }
          : null,
      plannedLaborUnitCents: plannedLaborVisible ? i.plannedLaborUnitCents : null,
    })),
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    createdBy: o.createdBy?.displayName ?? null,
    autoServiceOrder: o.autoServiceOrder,
    promisedDate: o.promisedDate ? o.promisedDate.toISOString().slice(0, 10) : null,
    deadline: (await orderDeadlines(db, { id }))[0]?.state ?? null,
    promisedDateHistory: (
      await db.auditLog.findMany({
        where: { entityType: 'commercial_order', entityId: id, action: PROMISED_ACTION },
        include: { actor: { select: { displayName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    ).map((a): OrderPromisedDateChangeDto => {
      const c = (a.changes ?? {}) as {
        promisedDate?: { from: string | null; to: string | null };
        reason?: string;
        appliedToServiceOrders?: string[];
      };
      return {
        from: c.promisedDate?.from ?? null,
        to: c.promisedDate?.to ?? null,
        reason: c.reason ?? '',
        appliedTo: c.appliedToServiceOrders ?? [],
        by: a.actor?.displayName ?? null,
        at: a.createdAt.toISOString(),
      };
    }),
    technicalNotes: o.technicalNotes,
    plannedLaborVisible,
    version: o.version,
    updatedAt: o.updatedAt.toISOString(),
  };
}

export async function emitOrderEvent(
  tx: Tx,
  request: FastifyRequest | ActorContext,
  orderId: string,
  type: (typeof EVENT_TYPES)[
    | 'ORDER_CREATED'
    | 'ORDER_UPDATED'
    | 'ORDER_CANCELLED'] = EVENT_TYPES.ORDER_UPDATED,
) {
  const o = await tx.commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
  await appendEvent(tx, actorOf(request), {
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
        include: {
          customer: true,
          items: { select: { quantity: true, receivedQuantity: true, returnedQuantity: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
    ]);
    const states = await serviceStates(prisma, rows);
    return {
      items: rows.map((r) => toSummary(r, states.get(r.id)!)),
      total,
    } satisfies PageDto<OrderSummaryDto>;
  });

  app.get('/api/v1/orders/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadOrderDto(prisma, request, id);
  });

  /**
   * Estabilização da Fase 2: alterar o titular / a mão de obra PREVISTOS depois do fechamento.
   * Vale só para as OS geradas a partir de agora (OS e mão de obra já geradas não mudam — para
   * elas, use a troca de titular e a revisão financeira). Sem `financeiro.ver` a mão de obra
   * prevista não é vista nem alterada (fica preservada).
   */
  app.put(
    '/api/v1/orders/:id/planned-intent',
    // Como o PUT do pedido: a versão (CAS) impede aplicar duas vezes a mesma alteração.
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = orderPlannedIntentSchema.parse(request.body);
      const perms = request.auth!.permissions;
      const laborVisible = perms.has('financeiro.ver');
      await prisma.$transaction(async (tx) => {
        if (!(await lockOrder(tx, id))) throw Errors.notFound('Pedido');
        await lockOrderItems(tx, id);
        const before = await tx.commercialOrder.findUniqueOrThrow({
          where: { id },
          include: { items: true },
        });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        if (before.status === 'CANCELADO')
          throw Errors.business('Pedido cancelado não pode ser alterado.');
        if (!before.autoServiceOrder)
          throw Errors.business(
            'Titular e mão de obra previstos valem para serviços com OS gerada na chegada. Neste pedido, defina-os na OS.',
          );
        const changes: {
          id: string;
          description: string;
          owner: { from: string | null; to: string | null };
          labor: { from: number | null; to: number | null };
        }[] = [];
        for (const it of input.items) {
          const old = before.items.find((i) => i.id === it.orderItemId);
          if (!old) throw Errors.validation(undefined, 'Item não pertence ao pedido.');
          const owner = it.plannedUpholstererUserId;
          const labor = laborVisible ? it.plannedLaborUnitCents : old.plannedLaborUnitCents;
          if (owner === old.plannedUpholstererUserId && labor === old.plannedLaborUnitCents)
            continue;
          if (labor && !owner)
            throw Errors.business(
              `"${old.description}" tem mão de obra prevista: ela é do titular — remova-a antes de tirar o titular.`,
            );
          changes.push({
            id: old.id,
            description: old.description,
            owner: { from: old.plannedUpholstererUserId, to: owner },
            labor: { from: old.plannedLaborUnitCents, to: labor },
          });
        }
        if (!changes.length) return;
        if (changes.some((c) => c.owner.from !== c.owner.to) && !canPlanUpholsterer(perms))
          throw Errors.forbidden(
            'Definir o tapeceiro titular exige a permissão de planejar a produção.',
          );
        // A mão de obra prevista é do titular: mudá-la, ou mudar o titular de quem a tem, é
        // decisão financeira.
        if (
          changes.some(
            (c) => c.labor.from !== c.labor.to || (c.labor.to && c.owner.from !== c.owner.to),
          ) &&
          !canPlanLabor(perms)
        )
          throw Errors.forbidden(
            'Combinar a mão de obra exige a permissão de gerenciar o financeiro.',
          );
        await assertIntentEligible(
          tx,
          changes.map((c) => ({
            description: c.description,
            plannedUpholstererUserId: c.owner.to,
            plannedLaborUnitCents: c.labor.to,
          })),
        );
        for (const c of changes)
          await tx.commercialOrderItem.update({
            where: { id: c.id },
            data: { plannedUpholstererUserId: c.owner.to, plannedLaborUnitCents: c.labor.to },
          });
        const after = await tx.commercialOrder.update({
          where: { id, version: input.version },
          data: { version: { increment: 1 } },
        });
        await audit(tx, actorFrom(request), {
          action: 'order.planned_intent_updated',
          entityType: 'commercial_order',
          entityId: id,
          summary: `Pedido ${orderCode(after.number)}: titular/mão de obra previstos alterados (valem para as OS geradas a partir de agora).`,
          changes: {
            items: changes.map((c) => ({
              description: c.description,
              plannedUpholstererUserId: c.owner,
              ...(c.labor.from !== c.labor.to ? { plannedLaborUnitCents: c.labor } : {}),
            })),
          },
        });
        await emitOrderEvent(tx, request, id);
      });
      return loadOrderDto(prisma, request, id);
    },
  );

  app.post(
    '/api/v1/orders',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createOrderSchema.parse(request.body);
      const id = await prisma.$transaction(
        async (tx) =>
          (await createOrder(tx, actorFrom(request), request.auth!.permissions, input)).id,
      );
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

  /**
   * Prazos e serviços em risco: altera o prazo prometido do PEDIDO (promessa vigente para as
   * peças/OS que ainda vão nascer), com motivo, auditoria (prazo anterior, novo, autor, data e
   * motivo) e versão. As OS existentes só mudam se o usuário responder SIM a "Aplicar este novo
   * prazo também às OS abertas deste pedido?" — e então só as abertas com peça por entregar, pela
   * regra central de alteração de prazo da OS. Nada de fila, prioridade, D9 ou planejamento.
   */
  app.put(
    '/api/v1/orders/:id/promised-date',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = updateOrderPromisedDateSchema.parse(request.body);
      // Alterar OS exige a permissão de OS (não amplia acesso de quem só gerencia pedidos).
      if (input.applyToServiceOrders && !can(request, 'os.gerenciar'))
        throw Errors.forbidden('Sem permissão para alterar o prazo das OS.');
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        if (!(await lockOrder(tx, id))) throw Errors.notFound('Pedido');
        const before = await tx.commercialOrder.findUniqueOrThrow({ where: { id } });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        if (before.status === 'CANCELADO')
          throw Errors.business('Pedido cancelado não pode ser alterado.');
        const from = dateOnly(before.promisedDate);
        if (from === input.promisedDate && !input.applyToServiceOrders)
          throw Errors.business('O prazo informado é igual ao atual.');
        await tx.commercialOrder.update({
          where: { id, version: input.version },
          data: { promisedDate: parseDateOnly(input.promisedDate), version: { increment: 1 } },
        });
        const code = orderCode(before.number);
        const applied: string[] = [];
        if (input.applyToServiceOrders) {
          const open = await tx.serviceOrder.findMany({
            where: { orderId: id, status: 'ABERTA' },
            select: { id: true },
            orderBy: { number: 'asc' },
          });
          // Pertinentes: abertas com peça ativa ainda por entregar (entregue/encerrada não muda).
          const states = await serviceDeadlines(tx, { id: { in: open.map((o) => o.id) } });
          for (const so of open) {
            if (states.get(so.id)?.state === 'ENCERRADA') continue;
            const changed = await changeServiceOrderPromisedDate(
              tx,
              actor,
              so.id,
              input.promisedDate,
              input.reason,
              `prazo do pedido ${code}`,
            );
            if (changed) applied.push(changed);
          }
        }
        await audit(tx, actor, {
          action: PROMISED_ACTION,
          entityType: 'commercial_order',
          entityId: id,
          summary: `Pedido ${code}: prazo prometido ${br(from)} → ${br(input.promisedDate)}${
            applied.length ? ` (também em ${applied.join(', ')})` : ''
          }.`,
          changes: {
            promisedDate: { from, to: input.promisedDate },
            reason: input.reason,
            appliedToServiceOrders: applied,
          },
        });
        await emitOrderEvent(tx, request, id);
      });
      return loadOrderDto(prisma, request, id);
    },
  );

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
          await syncTripCost(tx, actor, { pickupId: p.id }, `pedido cancelado: ${input.reason}`);
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
