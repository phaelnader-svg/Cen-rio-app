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
import { actorFrom, actorOf, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
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
import { refreshOrderStatus } from '../commercial/status';
import { PICKUP_ASSIGNMENT_DONE, resolvePickupAssignment } from '../notifications/notify';
import { emitOrderEvent } from '../orders/routes';
import { syncTripCost } from '../finance/trip-costs';
import { createPickup, setTripParticipants, validatePickupItems } from './service';

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
  request: FastifyRequest | ActorContext,
  pickupId: string,
  type: (typeof EVENT_TYPES)['PICKUP_CREATED' | 'PICKUP_UPDATED' | 'PICKUP_STATUS_CHANGED'],
) {
  const p = await tx.pickupRequest.findUniqueOrThrow({ where: { id: pickupId } });
  await appendEvent(tx, actorOf(request), {
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
      const id = await prisma.$transaction(
        async (tx) =>
          (await createPickup(tx, actorFrom(request), request.auth!.permissions, input)).id,
      );
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
      await validatePickupItems(tx, before.orderId, input.items, id);
      // Simplificação Fase 2: viagem com custo de terceirização não vira "equipe própria" sem
      // antes tratar o custo (senão o recebedor terceirizado seria credor de viagem própria).
      // Rodada 3 (F2-18): nem o inverso — o custo operacional da equipe própria não vira
      // obrigação do recebedor terceirizado por troca de equipe.
      if (input.team !== before.team) {
        const live = await tx.logisticsCost.findFirst({
          where: { pickupId: id, kind: 'RETIRADA', cancelledAt: null },
          select: { status: true },
        });
        if (live && input.team === 'EQUIPE_PROPRIA' && live.status !== 'OPERACIONAL')
          throw Errors.business(
            'Esta retirada tem custo de logística terceirizada. Ajuste o custo no financeiro antes de mudar para equipe própria.',
          );
        if (live && input.team !== 'EQUIPE_PROPRIA' && live.status === 'OPERACIONAL')
          throw Errors.business(
            'Esta retirada tem custo operacional da equipe própria. Cancele-o no financeiro antes de mudar para logística terceirizada.',
          );
      }
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
          // Outro dia (ou sem data) = sai da sequência do roteiro em que estava.
          ...(beforeDate !== (input.scheduledDate ?? null) ? { routeSequence: null } : {}),
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
      await syncTripCost(tx, actor, { pickupId: id });
      if (input.participantUserIds !== undefined) {
        const now = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
        await setTripParticipants(
          tx,
          actor,
          { pickupId: id },
          input.participantUserIds,
          now.logisticsUserId,
        );
      }
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
      if (PICKUP_ASSIGNMENT_DONE.includes(input.toStatus))
        await resolvePickupAssignment(tx, actor, id);
      await audit(tx, actor, {
        action: 'pickup.status_changed',
        entityType: 'pickup_request',
        entityId: id,
        summary: `Retirada ${pickupCode(before.number)}: ${PICKUP_STATUS_LABEL[before.status]} → ${PICKUP_STATUS_LABEL[input.toStatus]}.`,
        changes: { status: { from: before.status, to: input.toStatus }, note: input.note ?? null },
      });
      await emitPickupEvent(tx, request, id, EVENT_TYPES.PICKUP_STATUS_CHANGED);
      await syncTripCost(tx, actor, { pickupId: id }, input.note ?? undefined);
      await emitOrderEvent(tx, request, before.orderId);
    });
    return loadPickupDto(prisma, id);
  });
}
