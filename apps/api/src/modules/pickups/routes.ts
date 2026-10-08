import {
  EVENT_TYPES,
  PICKUP_STATUS_LABEL,
  PICKUP_TRANSITIONS,
  anyPermissionAudience,
  createPickupSchema,
  pickupQuerySchema,
  pickupTransitionSchema,
  updatePickupSchema,
  type PickupDto,
  type PickupStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  activeAddress,
  asSnapshot,
  dateOnly,
  lockOrder,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  pickupCode,
  snapshotAddress,
  toCustomerSummary,
} from '../commercial/common';
import { itemAllocations, refreshOrderStatus } from '../commercial/status';
import { emitOrderEvent } from '../orders/routes';

const VIEW = { session: 'WEB', permissions: ['retiradas.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['retiradas.gerenciar'] } as const;
export const PICKUP_AUDIENCE = anyPermissionAudience('retiradas.ver', 'recebimentos.registrar');
const EDITABLE: PickupStatus[] = ['AGUARDANDO_AGENDAMENTO', 'AGENDADA', 'COM_OCORRENCIA'];

const fullInclude = {
  order: { include: { customer: true } },
  items: { include: { orderItem: true }, orderBy: { orderItem: { position: 'asc' as const } } },
  events: {
    include: { recordedBy: { select: { displayName: true } } },
    orderBy: { occurredAt: 'asc' as const },
  },
} satisfies Prisma.PickupRequestInclude;

export async function loadPickupDto(db: PrismaClient | Tx, id: string): Promise<PickupDto> {
  const p = await db.pickupRequest.findUnique({ where: { id }, include: fullInclude });
  if (!p) throw Errors.notFound('Retirada');
  return {
    id: p.id,
    number: p.number,
    code: pickupCode(p.number),
    status: p.status,
    order: {
      id: p.orderId,
      code: orderCode(p.order.number),
      contractedService: p.order.contractedService,
    },
    customer: {
      ...toCustomerSummary(p.order.customer),
      // Contato necessário para a operação de retirada.
      phone: p.order.customer.phone,
      whatsapp: p.order.customer.whatsapp,
    },
    address: asSnapshot(p.addressSnapshot),
    scheduledDate: dateOnly(p.scheduledDate),
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    team: p.team,
    teamNotes: p.teamNotes,
    instructions: p.instructions,
    externalReference: p.externalReference,
    items: p.items.map((i) => ({
      orderItemId: i.orderItemId,
      pieceType: i.orderItem.pieceType,
      description: i.orderItem.description,
      quantity: i.quantity,
    })),
    events: p.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      source: e.source,
      recordedBy: e.recordedBy?.displayName ?? null,
      occurredAt: e.occurredAt.toISOString(),
    })),
    allowedTransitions: [...PICKUP_TRANSITIONS[p.status]],
    version: p.version,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function emitPickupEvent(
  tx: Tx,
  request: FastifyRequest,
  pickupId: string,
  type: (typeof EVENT_TYPES)['PICKUP_CREATED' | 'PICKUP_UPDATED' | 'PICKUP_STATUS_CHANGED'],
) {
  const p = await tx.pickupRequest.findUniqueOrThrow({ where: { id: pickupId } });
  await appendEvent(tx, actorFrom(request), {
    type,
    aggregateType: 'pickup_request',
    aggregateId: pickupId,
    payload: {
      id: pickupId,
      code: pickupCode(p.number),
      orderId: p.orderId,
      status: p.status,
      scheduledDate: dateOnly(p.scheduledDate),
      version: p.version,
    },
    audience: PICKUP_AUDIENCE,
  });
}

/** Valida as peças da retirada contra o que ainda falta retirar/receber. */
async function validateItems(
  tx: Tx,
  orderId: string,
  items: { orderItemId: string; quantity: number }[],
  currentPickupId?: string,
) {
  const orderItems = await tx.commercialOrderItem.findMany({ where: { orderId } });
  const alloc = await itemAllocations(tx, orderId);
  const current = currentPickupId
    ? new Map(
        (await tx.pickupRequestItem.findMany({ where: { pickupId: currentPickupId } })).map((i) => [
          i.orderItemId,
          i.quantity,
        ]),
      )
    : new Map<string, number>();
  const seen = new Set<string>();
  for (const it of items) {
    const oi = orderItems.find((o) => o.id === it.orderItemId);
    if (!oi) throw Errors.validation(undefined, 'Peça não pertence a este pedido.');
    if (seen.has(it.orderItemId)) throw Errors.validation(undefined, 'Peça repetida na retirada.');
    seen.add(it.orderItemId);
    const reservedElsewhere = alloc.inPickups(oi.id) - (current.get(oi.id) ?? 0);
    const available = oi.quantity - oi.receivedQuantity - reservedElsewhere;
    if (it.quantity > available) {
      throw Errors.business(
        `"${oi.description}": ${available} peça(s) disponível(is) para retirada (já recebidas ou em outra retirada).`,
      );
    }
  }
}

export async function pickupRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/pickups', { config: { access: VIEW } }, async (request) => {
    const q = pickupQuerySchema.parse(request.query);
    const rows = await prisma.pickupRequest.findMany({
      where: {
        ...(q.status?.length ? { status: { in: q.status } } : {}),
        ...(q.orderId ? { orderId: q.orderId } : {}),
        ...(q.from || q.to
          ? {
              scheduledDate: {
                ...(q.from ? { gte: parseDateOnly(q.from)! } : {}),
                ...(q.to ? { lte: parseDateOnly(q.to)! } : {}),
              },
            }
          : {}),
      },
      select: { id: true },
      orderBy: [
        { scheduledDate: { sort: 'asc', nulls: 'first' } },
        { windowStart: 'asc' },
        { createdAt: 'asc' },
      ],
      take: q.limit,
    });
    return Promise.all(rows.map((r) => loadPickupDto(prisma, r.id)));
  });

  app.get('/api/v1/pickups/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadPickupDto(prisma, id);
  });

  app.post(
    '/api/v1/pickups',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createPickupSchema.parse(request.body);
      const id = await prisma.$transaction(async (tx) => {
        if (!(await lockOrder(tx, input.orderId))) throw Errors.notFound('Pedido');
        await lockOrderItems(tx, input.orderId);
        const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: input.orderId } });
        if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
        if (order.status === 'RECEBIDO')
          throw Errors.business('Todas as peças deste pedido já foram recebidas.');
        await validateItems(tx, order.id, input.items);
        const address = input.addressId
          ? await activeAddress(tx, order.customerId, input.addressId)
          : null;
        const snapshot = address
          ? snapshotAddress(address)
          : asSnapshot(order.pickupAddressSnapshot);
        if (!snapshot) throw Errors.validation(undefined, 'Informe o endereço da retirada.');
        const status: PickupStatus = input.scheduledDate ? 'AGENDADA' : 'AGUARDANDO_AGENDAMENTO';
        const actor = actorFrom(request);
        const pickup = await tx.pickupRequest.create({
          data: {
            orderId: order.id,
            addressId: address?.id ?? order.pickupAddressId,
            addressSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            scheduledDate: parseDateOnly(input.scheduledDate),
            windowStart: input.windowStart ?? null,
            windowEnd: input.windowEnd ?? null,
            team: input.team,
            teamNotes: input.teamNotes ?? null,
            instructions: input.instructions ?? null,
            externalReference: input.externalReference ?? null,
            status,
            createdById: actor.userId,
            items: {
              create: input.items.map((i) => ({
                orderItemId: i.orderItemId,
                quantity: i.quantity,
              })),
            },
            events: {
              create: [
                {
                  kind: 'SOLICITADA',
                  toStatus: 'AGUARDANDO_AGENDAMENTO',
                  recordedById: actor.userId,
                },
                ...(status === 'AGENDADA'
                  ? [
                      {
                        kind: 'AGENDADA',
                        fromStatus: 'AGUARDANDO_AGENDAMENTO' as const,
                        toStatus: 'AGENDADA' as const,
                        note: `${input.scheduledDate}${input.windowStart ? ` ${input.windowStart}–${input.windowEnd ?? ''}` : ''}`,
                        recordedById: actor.userId,
                      },
                    ]
                  : []),
              ],
            },
          },
        });
        await refreshOrderStatus(tx, order.id);
        await audit(tx, actor, {
          action: 'pickup.created',
          entityType: 'pickup_request',
          entityId: pickup.id,
          summary: `Retirada ${pickupCode(pickup.number)} solicitada para o pedido ${orderCode(order.number)}.`,
          changes: { status, scheduledDate: input.scheduledDate ?? null, team: input.team },
        });
        await emitPickupEvent(tx, request, pickup.id, EVENT_TYPES.PICKUP_CREATED);
        await emitOrderEvent(tx, request, order.id);
        return pickup.id;
      });
      return reply.status(201).send(await loadPickupDto(prisma, id));
    },
  );

  /** Edita dados, peças ou agenda (reagendamento fica registrado na linha do tempo). */
  app.put('/api/v1/pickups/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updatePickupSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const current = await tx.pickupRequest.findUnique({ where: { id } });
      if (!current) throw Errors.notFound('Retirada');
      await lockOrder(tx, current.orderId);
      await lockOrderItems(tx, current.orderId);
      const before = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (!EDITABLE.includes(before.status)) {
        throw Errors.business(
          `Retirada "${PICKUP_STATUS_LABEL[before.status]}" não pode ser alterada.`,
        );
      }
      await validateItems(tx, before.orderId, input.items, id);
      const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: before.orderId } });
      const address =
        input.addressId && input.addressId !== before.addressId
          ? await activeAddress(tx, order.customerId, input.addressId)
          : null;

      const beforeDate = dateOnly(before.scheduledDate);
      const scheduleChanged =
        beforeDate !== (input.scheduledDate ?? null) ||
        before.windowStart !== (input.windowStart ?? null) ||
        before.windowEnd !== (input.windowEnd ?? null);
      let status = before.status;
      if (input.scheduledDate && before.status === 'AGUARDANDO_AGENDAMENTO') status = 'AGENDADA';
      if (!input.scheduledDate && before.status === 'AGENDADA') status = 'AGUARDANDO_AGENDAMENTO';

      const actor = actorFrom(request);
      await tx.pickupRequestItem.deleteMany({ where: { pickupId: id } });
      await tx.pickupRequest.update({
        where: { id, version: input.version },
        data: {
          ...(address
            ? {
                addressId: address.id,
                addressSnapshot: snapshotAddress(address) as unknown as Prisma.InputJsonValue,
              }
            : {}),
          scheduledDate: parseDateOnly(input.scheduledDate),
          windowStart: input.windowStart ?? null,
          windowEnd: input.windowEnd ?? null,
          team: input.team,
          teamNotes: input.teamNotes ?? null,
          instructions: input.instructions ?? null,
          externalReference: input.externalReference ?? null,
          status,
          version: { increment: 1 },
          items: {
            create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
          },
        },
      });
      if (scheduleChanged || status !== before.status) {
        await tx.pickupEvent.create({
          data: {
            pickupId: id,
            kind: !beforeDate ? 'AGENDADA' : input.scheduledDate ? 'REAGENDADA' : 'AGENDA_REMOVIDA',
            fromStatus: before.status,
            toStatus: status,
            note: input.scheduledDate
              ? `${beforeDate ?? 'sem data'} → ${input.scheduledDate}${input.windowStart ? ` ${input.windowStart}–${input.windowEnd ?? ''}` : ''}`
              : null,
            recordedById: actor.userId,
          },
        });
      } else {
        await tx.pickupEvent.create({
          data: { pickupId: id, kind: 'DADOS_ALTERADOS', recordedById: actor.userId },
        });
      }
      await refreshOrderStatus(tx, before.orderId);
      await audit(tx, actor, {
        action: 'pickup.updated',
        entityType: 'pickup_request',
        entityId: id,
        summary: `Retirada ${pickupCode(before.number)} alterada${scheduleChanged ? ' (agenda)' : ''}.`,
        changes: {
          ...(scheduleChanged
            ? {
                schedule: {
                  from: [beforeDate, before.windowStart, before.windowEnd],
                  to: [
                    input.scheduledDate ?? null,
                    input.windowStart ?? null,
                    input.windowEnd ?? null,
                  ],
                },
              }
            : {}),
          ...(status !== before.status ? { status: { from: before.status, to: status } } : {}),
        },
      });
      await emitPickupEvent(
        tx,
        request,
        id,
        status !== before.status ? EVENT_TYPES.PICKUP_STATUS_CHANGED : EVENT_TYPES.PICKUP_UPDATED,
      );
      await emitOrderEvent(tx, request, before.orderId);
    });
    return loadPickupDto(prisma, id);
  });

  /**
   * Registro manual do andamento (confirmações da logística nesta fase).
   * "Recebida na oficina" só é atingida pelo registro de recebimento físico.
   */
  app.post('/api/v1/pickups/:id/transition', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = pickupTransitionSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const current = await tx.pickupRequest.findUnique({ where: { id } });
      if (!current) throw Errors.notFound('Retirada');
      await lockOrder(tx, current.orderId);
      const before = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (!PICKUP_TRANSITIONS[before.status].includes(input.toStatus)) {
        throw Errors.business(
          `Não é possível passar de "${PICKUP_STATUS_LABEL[before.status]}" para "${PICKUP_STATUS_LABEL[input.toStatus]}".`,
        );
      }
      if (
        (input.toStatus === 'AGENDADA' || input.toStatus === 'EM_EXECUCAO') &&
        !before.scheduledDate
      ) {
        throw Errors.business('Defina a data da retirada antes.');
      }
      if ((input.toStatus === 'COM_OCORRENCIA' || input.toStatus === 'CANCELADA') && !input.note) {
        throw Errors.validation(
          [{ path: 'note', message: 'Descreva o motivo.' }],
          'Descreva o motivo.',
        );
      }
      const actor = actorFrom(request);
      await tx.pickupRequest.update({
        where: { id, version: input.version },
        data: { status: input.toStatus, version: { increment: 1 } },
      });
      await tx.pickupEvent.create({
        data: {
          pickupId: id,
          kind: input.toStatus,
          fromStatus: before.status,
          toStatus: input.toStatus,
          note: input.note ?? null,
          recordedById: actor.userId,
        },
      });
      await refreshOrderStatus(tx, before.orderId);
      await audit(tx, actor, {
        action: 'pickup.status_changed',
        entityType: 'pickup_request',
        entityId: id,
        summary: `Retirada ${pickupCode(before.number)}: ${PICKUP_STATUS_LABEL[before.status]} → ${PICKUP_STATUS_LABEL[input.toStatus]}.`,
        changes: { status: { from: before.status, to: input.toStatus }, note: input.note ?? null },
      });
      await emitPickupEvent(tx, request, id, EVENT_TYPES.PICKUP_STATUS_CHANGED);
      await emitOrderEvent(tx, request, before.orderId);
    });
    return loadPickupDto(prisma, id);
  });
}
