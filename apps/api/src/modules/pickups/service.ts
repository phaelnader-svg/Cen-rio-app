import {
  EVENT_TYPES,
  type PickupStatus,
  type PickupTeam,
  type createPickupSchema,
} from '@cenario/shared';
import type { PickupRequest, Prisma, Tx } from '@cenario/db';
import type { z } from 'zod';
import { audit } from '../../core/audit';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import {
  activeAddress,
  asSnapshot,
  lockOrder,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  pickupCode,
  snapshotAddress,
} from '../commercial/common';
import { itemAllocations, refreshOrderStatus } from '../commercial/status';
import { upsertTripCost } from '../finance/trip-costs';
import { notify } from '../notifications/notify';
import { emitOrderEvent } from '../orders/routes';
import { emitPickupEvent } from './routes';

/**
 * Serviço de domínio da retirada (Simplificação Fase 2): a criação saiu da rota para ser
 * reutilizada, na MESMA transação, pelo fluxo "Novo serviço". Regras preservadas: peças contra o
 * saldo do pedido, endereço obrigatório, horário de chegada com data, responsável elegível, custo
 * da viagem só com `financeiro.gerenciar` (um custo por viagem — Fase 6).
 */
export type NewPickupInput = z.output<typeof createPickupSchema>;

/** Valida as peças da retirada contra o que ainda falta retirar/receber. */
export async function validatePickupItems(
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

/**
 * Quem pode executar uma retirada: usuário ativo, com funcionário ativo (quando houver), e com
 * permissão de executar logística OU produção (equipe própria). Mesma regra da atribuição.
 */
export async function pickupExecutorProblem(tx: Tx, userId: string): Promise<string | null> {
  const u = await tx.user.findUnique({ where: { id: userId }, include: { employee: true } });
  if (!u || !u.active || (u.employee && !u.employee.active)) return 'inativo';
  const perms = await loadUserPermissions(tx, userId);
  if (!perms.has('logistica.executar') && !perms.has('producao.executar')) return 'sem permissão';
  return null;
}

/**
 * Simplificação Fase 2: custo de viagem (Fase 6) é o valor TOTAL combinado com a logística
 * terceirizada e vira obrigação do recebedor configurado (André). Equipe própria não gera esse
 * custo — nunca credita o recebedor terceirizado por uma viagem feita pela própria equipe.
 */
export function tripCostTeamProblem(team: PickupTeam, hasTripCost: boolean): string | null {
  if (hasTripCost && team === 'EQUIPE_PROPRIA')
    return 'Equipe própria não gera custo de terceirização. Custos da equipe própria seguem os lançamentos de custos da OS.';
  return null;
}

/**
 * Simplificação Fase 3 — participantes OPERACIONAIS da viagem (retirada ou entrega): quem vai
 * junto vê a parada no próprio roteiro, com ou sem custo combinado. Não é credor e não gera
 * pagamento (o recebedor financeiro continua o configurado na Fase 6). Substitui o conjunto.
 */
export async function setTripParticipants(
  tx: Tx,
  actor: ActorContext,
  ref: { pickupId: string } | { deliveryId: string },
  userIds: string[],
  responsibleUserId?: string | null,
) {
  const unique = [...new Set(userIds)].filter((u) => u !== responsibleUserId);
  for (const userId of unique) {
    if (await pickupExecutorProblem(tx, userId))
      throw Errors.validation(
        [{ path: 'participantUserIds', message: 'Participante inválido ou inativo.' }],
        'Participante inválido ou inativo.',
      );
  }
  const where = 'pickupId' in ref ? { pickupId: ref.pickupId } : { deliveryId: ref.deliveryId };
  const before = await tx.logisticsTripParticipant.findMany({ where });
  const same = before.length === unique.length && before.every((b) => unique.includes(b.userId));
  if (same) return false;
  await tx.logisticsTripParticipant.deleteMany({ where });
  if (unique.length)
    await tx.logisticsTripParticipant.createMany({
      data: unique.map((userId) => ({ ...where, userId, createdById: actor.userId })),
    });
  return true;
}

export async function createPickup(
  tx: Tx,
  actor: ActorContext,
  perms: { has(permission: string): boolean },
  input: NewPickupInput,
): Promise<PickupRequest> {
  if (input.tripCost && !perms.has('financeiro.gerenciar'))
    throw Errors.forbidden('Informar o custo da viagem exige permissão do financeiro.');
  const teamProblem = tripCostTeamProblem(input.team, Boolean(input.tripCost));
  if (teamProblem)
    throw Errors.validation([{ path: 'tripCost', message: teamProblem }], teamProblem);
  if (!(await lockOrder(tx, input.orderId))) throw Errors.notFound('Pedido');
  await lockOrderItems(tx, input.orderId);
  const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: input.orderId } });
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  // Estabilização da Fase 2: o cliente ia entregar, mas agora haverá retirada.
  if (order.customerDropOff)
    await tx.commercialOrder.update({ where: { id: order.id }, data: { customerDropOff: false } });
  if (order.status === 'RECEBIDO')
    throw Errors.business('Todas as peças deste pedido já foram recebidas.');
  await validatePickupItems(tx, order.id, input.items);
  const address = input.addressId
    ? await activeAddress(tx, order.customerId, input.addressId)
    : null;
  const snapshot = address ? snapshotAddress(address) : asSnapshot(order.pickupAddressSnapshot);
  if (!snapshot) throw Errors.validation(undefined, 'Informe o endereço da retirada.');
  const status: PickupStatus = input.scheduledDate ? 'AGENDADA' : 'AGUARDANDO_AGENDAMENTO';
  // Correção global: responsável pela execução já na solicitação (mesma regra da atribuição).
  let executor: { id: string; displayName: string } | null = null;
  if (input.logisticsUserId) {
    if (await pickupExecutorProblem(tx, input.logisticsUserId))
      throw Errors.business('Responsável inválido para a retirada.');
    const u = await tx.user.findUniqueOrThrow({ where: { id: input.logisticsUserId } });
    executor = { id: u.id, displayName: u.displayName };
  }
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
      logisticsUserId: executor?.id ?? null,
      status,
      createdById: actor.userId,
      items: {
        create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      },
      events: {
        create: [
          { kind: 'SOLICITADA', toStatus: 'AGUARDANDO_AGENDAMENTO', recordedById: actor.userId },
          ...(status === 'AGENDADA'
            ? [
                {
                  kind: 'AGENDADA',
                  fromStatus: 'AGUARDANDO_AGENDAMENTO' as const,
                  toStatus: 'AGENDADA' as const,
                  note: `${input.scheduledDate}${input.windowStart ? ` chegada ${input.windowStart}${input.windowEnd ? `–${input.windowEnd}` : ''}` : ''}`,
                  recordedById: actor.userId,
                },
              ]
            : []),
          ...(executor
            ? [
                {
                  kind: 'RESPONSAVEL',
                  note: `Responsável: ${executor.displayName}`,
                  recordedById: actor.userId,
                },
              ]
            : []),
        ],
      },
    },
  });
  if (input.tripCost) await upsertTripCost(tx, actor, { pickupId: pickup.id, ...input.tripCost });
  // Fase 3: participação operacional estruturada (independe de haver custo).
  await setTripParticipants(
    tx,
    actor,
    { pickupId: pickup.id },
    input.participantUserIds ?? input.tripCost?.participantUserIds ?? [],
    executor?.id ?? null,
  );
  await refreshOrderStatus(tx, order.id);
  await audit(tx, actor, {
    action: 'pickup.created',
    entityType: 'pickup_request',
    entityId: pickup.id,
    summary: `Retirada ${pickupCode(pickup.number)} solicitada para o pedido ${orderCode(order.number)}.`,
    changes: { status, scheduledDate: input.scheduledDate ?? null, team: input.team },
  });
  if (executor)
    await notify(tx, actor, [
      {
        userId: executor.id,
        kind: 'ENTREGA_ATRIBUIDA',
        dedupeKey: `RETIRADA_ATRIBUIDA:${pickup.id}:${pickup.version}`,
        body: `Retirada ${pickupCode(pickup.number)}${input.scheduledDate ? ` em ${input.scheduledDate.split('-').reverse().join('/')}${input.windowStart ? `, chegada ${input.windowStart}` : ''}` : ''}.`,
        includeActor: true,
      },
    ]);
  await emitPickupEvent(tx, actor, pickup.id, EVENT_TYPES.PICKUP_CREATED);
  await emitOrderEvent(tx, actor, order.id);
  return pickup;
}
