/**
 * Evolução, Fase 6 — custos de retirada e entrega.
 *
 * Fonte única de verdade: `logistics_costs` (um custo por viagem e tipo, índice único da Fase 11)
 * + `logistics_cost_allocations` (rateio por revisão, imutável) + `account_payables` (obrigação,
 * criada só quando o valor é devido) + `payable_payments`/`payable_payment_reversals`.
 *
 * - O gestor combina **um valor total por viagem** no agendamento (padrão sugerido, editável).
 * - O recebedor é **único** (configuração explícita da empresa — André); participantes (André,
 *   Izaías) são registrados como execução, nunca como credores.
 * - Agendar não cria obrigação; a realização (retirada realizada/recebida, entrega concluída)
 *   constitui o valor devido uma única vez. Cancelar antes da realização cancela o combinado.
 * - Tentativa frustrada só gera valor com taxa autorizada pelo gestor (custo próprio).
 * - Depois de devido, correções são ajustes/estornos auditáveis, nunca sobrescrita.
 */
import {
  ALL_LOGISTICS_COST_KIND_LABEL,
  EVENT_TYPES,
  TRIP_FEE_KIND,
  deliveryCode,
  logisticsCostCode,
  mondayOf,
  payableCode,
  settlementStatus,
  splitCents,
  tripAllocation,
  tripCostSituation,
  zonedDateTime,
  type LogisticsCostDto,
  type LogisticsCostStatus,
  type LogisticsDefaultsDto,
  type LogisticsWeeklyDto,
  type PayableStatus,
  type SplitMethod,
  type TripCostViewDto,
  idSchema,
  logisticsDefaultsSchema,
  logisticsWeeklyQuerySchema,
  reversePayablePaymentSchema,
  tripAdjustmentSchema,
  tripCostSchema,
  tripFeeSchema,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { pickupCode, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { notifyUsersWith } from '../quality/common';
import {
  FIN_ADJUST,
  FIN_MANAGE,
  FIN_VIEW,
  checkVersion,
  dateOnly,
  financeEvent,
  historyOf,
  lockRow,
  parseDate,
  todayIso,
} from './common';
import { payableInclude, toPayableDto } from './payables';

type Db = Tx | PrismaClient;
export type TripRef = { pickupId?: string | null; deliveryId?: string | null };

const TRIP_KINDS = ['RETIRADA', 'ENTREGA'] as const;
const PICKUP_DONE = ['RETIRADA_REALIZADA', 'RECEBIDA_NA_OFICINA'];
const PICKUP_FRUSTRATED = ['COM_OCORRENCIA'];
const DELIVERY_FRUSTRATED = ['FRUSTRADA'];

export const tripCostInclude = {
  delivery: { select: { id: true, number: true } },
  pickup: { select: { id: true, number: true } },
  payable: { select: { id: true, number: true, status: true, paidCents: true, amountCents: true } },
  allocations: { include: { serviceOrder: { select: { number: true } } } },
  payee: { select: { id: true, displayName: true } },
  participants: { include: { user: { select: { id: true, displayName: true } } } },
  adjustments: {
    include: { authorizedBy: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.LogisticsCostInclude;
type CostRow = Prisma.LogisticsCostGetPayload<{ include: typeof tripCostInclude }>;

export async function toTripCostDto(db: Db, c: CostRow): Promise<LogisticsCostDto> {
  const due = c.amountCents + c.adjustmentsCents;
  const paid = c.payable?.paidCents ?? 0;
  const status = c.status as LogisticsCostStatus;
  return {
    id: c.id,
    number: c.number,
    code: logisticsCostCode(c.number),
    kind: c.kind as LogisticsCostDto['kind'],
    description: c.description,
    amountCents: c.amountCents,
    date: dateOnly(c.date)!,
    delivery: c.delivery ? { id: c.delivery.id, code: deliveryCode(c.delivery.number) } : null,
    pickup: c.pickup ? { id: c.pickup.id, code: pickupCode(c.pickup.number) } : null,
    beneficiary: c.beneficiary,
    splitMethod: c.splitMethod as SplitMethod,
    splitNote: c.splitNote,
    allocations: c.allocations
      .filter((a) => a.revision === c.allocationRevision)
      .map((a) => ({
        serviceOrderId: a.serviceOrderId,
        code: serviceOrderCode(a.serviceOrder.number),
        amountCents: a.amountCents,
      })),
    payable: c.payable
      ? {
          id: c.payable.id,
          code: payableCode(c.payable.number),
          status: c.payable.status as PayableStatus,
        }
      : null,
    cancelled: Boolean(c.cancelledAt),
    cancelReason: c.cancelReason,
    version: c.version,
    status,
    situation: tripCostSituation({ status, payable: c.payable }),
    payee: c.payee ? { userId: c.payee.id, displayName: c.payee.displayName } : null,
    participants: c.participants.map((p) => ({
      userId: p.user.id,
      displayName: p.user.displayName,
    })),
    adjustmentsCents: c.adjustmentsCents,
    dueCents: status === 'DEVIDO' || status === 'LANCADO' ? due : 0,
    paidCents: paid,
    openCents: c.payable && c.payable.status !== 'CANCELADO' ? Math.max(0, due - paid) : 0,
    dueAt: c.dueAt?.toISOString() ?? null,
    pendingReason: c.pendingReason,
    allocationMode: c.allocationMode as LogisticsCostDto['allocationMode'],
    adjustments: c.adjustments.map((a) => ({
      id: a.id,
      amountCents: a.amountCents,
      reason: a.reason,
      authorizedBy: a.authorizedBy.displayName,
      createdAt: a.createdAt.toISOString(),
    })),
    history: await historyOf(db, 'logistics_cost', c.id),
  };
}

export const loadTripCost = async (db: Db, id: string) =>
  toTripCostDto(
    db,
    await db.logisticsCost.findUniqueOrThrow({ where: { id }, include: tripCostInclude }),
  );

// ─────────────────────────── Padrões e recebedor ───────────────────────────

/** Recebedor configurado e se está apto (usuário e cadastro de funcionário ativos). */
async function configuredPayee(db: Db) {
  const s = await db.companySettings.findUnique({
    where: { id: 1 },
    include: { logisticsPayee: { include: { employee: { select: { active: true } } } } },
  });
  const u = s?.logisticsPayee;
  return {
    settings: s,
    payee: u
      ? {
          userId: u.id,
          displayName: u.displayName,
          active: u.active && u.employee?.active !== false,
        }
      : null,
  };
}

/** Pessoas que podem participar de viagens: ativos com permissão de execução logística. */
async function logisticsPeople(db: Db) {
  const rows = await db.user.findMany({
    where: {
      active: true,
      employee: { active: true },
      OR: [
        {
          roles: {
            some: { role: { permissions: { some: { permission: 'logistica.executar' } } } },
          },
        },
        { permissions: { some: { permission: 'logistica.executar' } } },
      ],
    },
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' },
  });
  return rows.map((u) => ({ userId: u.id, displayName: u.displayName }));
}

export async function logisticsDefaults(db: Db): Promise<LogisticsDefaultsDto> {
  const { settings, payee } = await configuredPayee(db);
  return {
    defaultPickupCostCents: settings?.defaultPickupCostCents ?? null,
    defaultDeliveryCostCents: settings?.defaultDeliveryCostCents ?? null,
    payee,
    people: await logisticsPeople(db),
  };
}

export async function setLogisticsDefaults(
  tx: Tx,
  actor: ActorContext,
  input: z.output<typeof logisticsDefaultsSchema>,
) {
  if (input.logisticsPayeeUserId) {
    const u = await tx.user.findUnique({
      where: { id: input.logisticsPayeeUserId },
      include: { employee: true },
    });
    if (!u?.active || !u.employee?.active)
      throw Errors.business('O recebedor precisa ser um funcionário ativo.');
  }
  const before = await tx.companySettings.findUniqueOrThrow({ where: { id: 1 } });
  await tx.companySettings.update({
    where: { id: 1 },
    data: {
      defaultPickupCostCents: input.defaultPickupCostCents,
      defaultDeliveryCostCents: input.defaultDeliveryCostCents,
      logisticsPayeeUserId: input.logisticsPayeeUserId,
      updatedById: actor.userId,
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.logistics_defaults',
    entityType: 'company_settings',
    entityId: '00000000-0000-0000-0000-000000000001',
    summary:
      'Padrões de custo da logística e recebedor alterados (viagens já registradas não mudam).',
    changes: {
      defaultPickupCostCents: {
        from: before.defaultPickupCostCents,
        to: input.defaultPickupCostCents,
      },
      defaultDeliveryCostCents: {
        from: before.defaultDeliveryCostCents,
        to: input.defaultDeliveryCostCents,
      },
      logisticsPayeeUserId: { from: before.logisticsPayeeUserId, to: input.logisticsPayeeUserId },
    },
  });
}

// ─────────────────────────── Viagem ───────────────────────────

type Trip = {
  kind: 'RETIRADA' | 'ENTREGA';
  id: string;
  number: number;
  code: string;
  status: string;
  date: Date | null;
  done: boolean;
  cancelled: boolean;
  frustrated: boolean;
};

async function loadTrip(db: Db, ref: TripRef, lock = false): Promise<Trip> {
  if (ref.pickupId) {
    if (lock) await lockRow(db as Tx, 'pickup_requests', ref.pickupId, 'Retirada');
    const p = await db.pickupRequest.findUnique({ where: { id: ref.pickupId } });
    if (!p) throw Errors.notFound('Retirada');
    return {
      kind: 'RETIRADA',
      id: p.id,
      number: p.number,
      code: pickupCode(p.number),
      status: p.status,
      date: p.scheduledDate,
      done: PICKUP_DONE.includes(p.status),
      cancelled: p.status === 'CANCELADA',
      frustrated: PICKUP_FRUSTRATED.includes(p.status),
    };
  }
  if (!ref.deliveryId) throw Errors.business('Informe a retirada ou a entrega.');
  if (lock) await lockRow(db as Tx, 'deliveries', ref.deliveryId, 'Entrega');
  const d = await db.delivery.findUnique({ where: { id: ref.deliveryId } });
  if (!d) throw Errors.notFound('Entrega');
  return {
    kind: 'ENTREGA',
    id: d.id,
    number: d.number,
    code: deliveryCode(d.number),
    status: d.status,
    date: d.scheduledDate,
    done: d.status === 'CONCLUIDA',
    cancelled: d.status === 'CANCELADA',
    frustrated: DELIVERY_FRUSTRATED.includes(d.status),
  };
}

const tripWhere = (t: Trip) => (t.kind === 'RETIRADA' ? { pickupId: t.id } : { deliveryId: t.id });

/** OS atendidas pela viagem: peças ativas da entrega / OS do pedido da retirada. */
async function tripServiceOrders(db: Db, t: Trip) {
  if (t.kind === 'ENTREGA') {
    const items = await db.deliveryItem.findMany({
      where: { deliveryId: t.id, active: true },
      include: {
        serviceOrderItem: { select: { serviceOrder: { select: { id: true, number: true } } } },
      },
    });
    const m = new Map(
      items.map((i) => [i.serviceOrderItem.serviceOrder.id, i.serviceOrderItem.serviceOrder]),
    );
    return [...m.values()].sort((a, b) => a.number - b.number);
  }
  const p = await db.pickupRequest.findUniqueOrThrow({ where: { id: t.id } });
  return db.serviceOrder.findMany({
    where: { orderId: p.orderId, status: { not: 'CANCELADA' } },
    select: { id: true, number: true },
    orderBy: { number: 'asc' },
  });
}

const liveTripCost = (db: Db, t: Trip) =>
  db.logisticsCost.findFirst({
    where: { ...tripWhere(t), kind: t.kind, cancelledAt: null },
    include: tripCostInclude,
  });

/**
 * Grava um novo rateio (nova revisão) se ele mudou. Os rateios anteriores ficam como histórico
 * (são imutáveis); só a revisão vigente conta na margem das OS.
 */
async function reallocate(
  tx: Tx,
  actor: ActorContext,
  c: {
    id: string;
    allocationRevision: number;
    allocationMode: string;
    amountCents: number;
    adjustmentsCents: number;
  },
  serviceOrderIds: string[] | null,
  reason: string,
  trip: Trip | null,
) {
  const total = c.amountCents + c.adjustmentsCents;
  const current = await tx.logisticsCostAllocation.findMany({
    where: { logisticsCostId: c.id, revision: c.allocationRevision },
    include: { serviceOrder: { select: { number: true } } },
  });
  let next: { serviceOrderId: string; amountCents: number }[];
  if (c.allocationMode === 'MANUAL') {
    // Legado (rateio manual): proporcional ao rateio vigente.
    const parts = splitCents(
      total,
      current.map((a) => a.amountCents),
    );
    next = current.map((a, i) => ({ serviceOrderId: a.serviceOrderId, amountCents: parts[i]! }));
  } else {
    const ids =
      serviceOrderIds ??
      (c.allocationMode === 'ESCOLHIDA'
        ? current.map((a) => a.serviceOrderId)
        : trip
          ? (await tripServiceOrders(tx, trip)).map((s) => s.id)
          : current.map((a) => a.serviceOrderId));
    const sos = await tx.serviceOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, number: true },
    });
    if (sos.length !== ids.length) throw Errors.business('OS inválida no rateio.');
    next = tripAllocation(total, sos);
  }
  const same =
    next.length === current.length &&
    next.every((n) =>
      current.some((x) => x.serviceOrderId === n.serviceOrderId && x.amountCents === n.amountCents),
    );
  if (same) return;
  const revision = c.allocationRevision + 1;
  if (next.length)
    await tx.logisticsCostAllocation.createMany({
      data: next.map((n) => ({ logisticsCostId: c.id, revision, ...n })),
    });
  await tx.logisticsCost.update({ where: { id: c.id }, data: { allocationRevision: revision } });
  const sos = await tx.serviceOrder.findMany({
    where: { id: { in: next.map((n) => n.serviceOrderId) } },
    select: { id: true, number: true },
  });
  const label = (id: string) => serviceOrderCode(sos.find((s) => s.id === id)?.number ?? 0);
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: c.id,
    kind: 'RATEIO',
    note: reason,
    data: {
      revision,
      before: current.map((a) => ({
        os: serviceOrderCode(a.serviceOrder.number),
        amountCents: a.amountCents,
      })),
      after: next.map((n) => ({ os: label(n.serviceOrderId), amountCents: n.amountCents })),
    },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
}

async function setParticipants(tx: Tx, costId: string, userIds: string[]) {
  if (userIds.length) {
    const ok = await tx.user.count({
      where: { id: { in: userIds }, active: true, employee: { active: true } },
    });
    if (ok !== userIds.length) throw Errors.business('Participante inválido ou inativo.');
  }
  const before = await tx.logisticsCostParticipant.findMany({ where: { logisticsCostId: costId } });
  const same = before.length === userIds.length && before.every((b) => userIds.includes(b.userId));
  if (same) return false;
  await tx.logisticsCostParticipant.deleteMany({ where: { logisticsCostId: costId } });
  if (userIds.length)
    await tx.logisticsCostParticipant.createMany({
      data: userIds.map((userId) => ({ logisticsCostId: costId, userId })),
    });
  return true;
}

/**
 * Combina (ou altera, antes da realização) o valor total da viagem. Reagendar não passa por
 * aqui: o custo pertence à viagem e continua único (índice do banco por viagem e tipo).
 */
export async function upsertTripCost(
  tx: Tx,
  actor: ActorContext,
  input: z.output<typeof tripCostSchema>,
) {
  const trip = await loadTrip(tx, input, true);
  if (trip.cancelled) throw Errors.business(`${trip.code} cancelada: não recebe custo.`);
  const existing = await liveTripCost(tx, trip);
  if (!existing && (await tx.logisticsFreeTrip.count({ where: tripWhere(trip) })))
    throw Errors.business(`${trip.code} foi confirmada como gratuita: não recebe custo.`);
  const mode = input.serviceOrderIds?.length ? 'ESCOLHIDA' : 'AUTO';
  if (!existing) {
    const c = await tx.logisticsCost.create({
      data: {
        kind: trip.kind,
        description: `${trip.kind === 'RETIRADA' ? 'Retirada' : 'Entrega'} ${trip.code}`,
        amountCents: input.amountCents,
        date: trip.date ?? parseDate(todayIso()),
        ...tripWhere(trip),
        splitMethod: 'IGUAL',
        splitNote: mode === 'ESCOLHIDA' ? 'OS escolhidas pelo gestor' : 'OS da viagem',
        status: 'PREVISTO',
        allocationMode: mode,
        allocationRevision: 0,
        createdById: actor.userId,
      },
    });
    await setParticipants(tx, c.id, input.participantUserIds);
    await reallocate(
      tx,
      actor,
      c,
      input.serviceOrderIds?.length ? input.serviceOrderIds : null,
      'Rateio inicial',
      trip,
    );
    await audit(tx, actor, {
      action: 'finance.trip_cost_agreed',
      entityType: 'logistics_cost',
      entityId: c.id,
      summary: `${logisticsCostCode(c.number)}: custo total de ${trip.code} combinado (${(input.amountCents / 100).toFixed(2)}).`,
      changes: { amountCents: input.amountCents, participants: input.participantUserIds },
    });
    await financeEvent(tx, actor, {
      entityType: 'logistics_cost',
      entityId: c.id,
      kind: 'COMBINADO',
      note: `Agendamento de ${trip.code}`,
      data: { amountCents: input.amountCents },
      type: EVENT_TYPES.FINANCE_COST_UPDATED,
    });
    if (trip.done) await constituteTripCost(tx, actor, c.id);
    return c.id;
  }
  // Alteração: motivo + versão; depois de devido, só ajuste.
  if (input.version === undefined) throw Errors.versionConflict(existing.version);
  checkVersion(existing, input.version);
  if (!input.reason || input.reason.trim().length < 3)
    throw Errors.validation(
      [{ path: 'reason', message: 'Informe o motivo da alteração.' }],
      'Informe o motivo da alteração.',
    );
  if (existing.status !== 'PREVISTO')
    throw Errors.business(
      'O valor já é devido: corrija com um ajuste justificado (o combinado fica como histórico).',
    );
  await lockRow(tx, 'logistics_costs', existing.id, 'Custo de logística');
  const changedParticipants = await setParticipants(tx, existing.id, input.participantUserIds);
  const u = await tx.logisticsCost.update({
    where: { id: existing.id },
    data: {
      amountCents: input.amountCents,
      allocationMode: mode,
      splitNote: mode === 'ESCOLHIDA' ? 'OS escolhidas pelo gestor' : 'OS da viagem',
      version: { increment: 1 },
    },
  });
  await reallocate(
    tx,
    actor,
    u,
    input.serviceOrderIds?.length ? input.serviceOrderIds : null,
    input.reason,
    trip,
  );
  await audit(tx, actor, {
    action: 'finance.trip_cost_changed',
    entityType: 'logistics_cost',
    entityId: existing.id,
    summary: `${logisticsCostCode(existing.number)}: custo de ${trip.code} alterado. Motivo: ${input.reason}`,
    changes: {
      amountCents: { from: existing.amountCents, to: input.amountCents },
      ...(changedParticipants
        ? {
            participants: {
              from: existing.participants.map((p) => p.userId),
              to: input.participantUserIds,
            },
          }
        : {}),
    },
  });
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: existing.id,
    kind: 'VALOR_ALTERADO',
    note: input.reason,
    data: { fromCents: existing.amountCents, toCents: input.amountCents },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return existing.id;
}

/** Cria a conta a pagar do recebedor (uma vez). Sem recebedor ativo: pendência, nunca outro. */
async function createObligation(
  tx: Tx,
  actor: ActorContext,
  c: {
    id: string;
    number: number;
    description: string;
    amountCents: number;
    adjustmentsCents: number;
    pendingReason: string | null;
  },
) {
  const { payee } = await configuredPayee(tx);
  if (!payee?.active) {
    if (c.pendingReason !== 'RECEBEDOR_AUSENTE') {
      await tx.logisticsCost.update({
        where: { id: c.id },
        data: { pendingReason: 'RECEBEDOR_AUSENTE', version: { increment: 1 } },
      });
      await financeEvent(tx, actor, {
        entityType: 'logistics_cost',
        entityId: c.id,
        kind: 'PENDENTE_RECEBEDOR',
        note: payee ? `${payee.displayName} está inativo.` : 'Nenhum recebedor configurado.',
        type: EVENT_TYPES.FINANCE_COST_UPDATED,
      });
      await notifyUsersWith(
        tx,
        actor,
        'financeiro.gerenciar',
        'OCORRENCIA_LOGISTICA',
        `LOGISTICA_SEM_RECEBEDOR:${c.id}`,
        `${logisticsCostCode(c.number)}: valor devido sem recebedor ativo — configure o recebedor da logística (nenhuma conta a pagar foi criada).`,
      );
    }
    return null;
  }
  const p = await tx.accountPayable.create({
    data: {
      beneficiary: payee.displayName,
      category: 'LOGISTICA',
      description: c.description,
      amountCents: c.amountCents + c.adjustmentsCents,
      dueDate: parseDate(todayIso()),
      createdById: actor.userId,
    },
  });
  await tx.logisticsCost.update({
    where: { id: c.id },
    data: { payableId: p.id, payeeUserId: payee.userId, pendingReason: null },
  });
  await financeEvent(tx, actor, {
    entityType: 'account_payable',
    entityId: p.id,
    kind: 'CRIADA',
    note: `${logisticsCostCode(c.number)} — recebedor ${payee.displayName}`,
    type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
    status: 'ABERTO',
  });
  return p;
}

/** Realização da viagem: o combinado vira devido (uma única vez) e gera a obrigação. */
export async function constituteTripCost(tx: Tx, actor: ActorContext, costId: string) {
  await lockRow(tx, 'logistics_costs', costId, 'Custo de logística');
  const c = await tx.logisticsCost.findUniqueOrThrow({ where: { id: costId } });
  if (c.status === 'DEVIDO') {
    // Recebedor configurado depois: completa a obrigação pendente.
    if (!c.payableId) await createObligation(tx, actor, c);
    return;
  }
  if (c.status !== 'PREVISTO') return;
  const u = await tx.logisticsCost.update({
    where: { id: costId },
    data: { status: 'DEVIDO', dueAt: new Date(), version: { increment: 1 } },
  });
  const trip = await loadTrip(tx, { pickupId: c.pickupId, deliveryId: c.deliveryId });
  if (u.allocationMode === 'AUTO')
    await reallocate(tx, actor, u, null, `Rateio na realização de ${trip.code}`, trip);
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: costId,
    kind: 'DEVIDO',
    note: `${trip.code} realizada`,
    data: { dueCents: c.amountCents + c.adjustmentsCents },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  await audit(tx, actor, {
    action: 'finance.trip_cost_due',
    entityType: 'logistics_cost',
    entityId: costId,
    summary: `${logisticsCostCode(c.number)}: ${trip.code} realizada — valor devido constituído.`,
  });
  await createObligation(tx, actor, u);
}

/**
 * Chamado depois de qualquer mudança da viagem (status, peças, OS): realização constitui o
 * devido; cancelamento antes da realização cancela o combinado; mudança de OS refaz o rateio
 * automático. Idempotente.
 */
export async function syncTripCost(tx: Tx, actor: ActorContext, ref: TripRef, reason?: string) {
  const trip = await loadTrip(tx, ref);
  const c = await liveTripCost(tx, trip);
  if (!c) return;
  if (trip.done) return constituteTripCost(tx, actor, c.id);
  if (trip.cancelled && c.status === 'PREVISTO') {
    await lockRow(tx, 'logistics_costs', c.id, 'Custo de logística');
    await tx.logisticsCost.update({
      where: { id: c.id },
      data: {
        status: 'CANCELADO',
        cancelledAt: new Date(),
        cancelReason:
          `${trip.code} cancelada antes da realização${reason ? `: ${reason}` : ''}`.slice(0, 500),
        version: { increment: 1 },
      },
    });
    await financeEvent(tx, actor, {
      entityType: 'logistics_cost',
      entityId: c.id,
      kind: 'CANCELADO',
      note: `${trip.code} cancelada antes da realização — nada devido.`,
      type: EVENT_TYPES.FINANCE_COST_UPDATED,
    });
    return;
  }
  if (c.status === 'PREVISTO' && c.allocationMode === 'AUTO')
    await reallocate(tx, actor, c, null, reason ?? `OS de ${trip.code} alteradas`, trip);
}

/** OS criada para um pedido com retirada: entra no rateio automático (pagamento intocado). */
export async function syncPickupCostsOfOrder(tx: Tx, actor: ActorContext, orderId: string) {
  const costs = await tx.logisticsCost.findMany({
    where: { pickup: { orderId }, kind: 'RETIRADA', cancelledAt: null, allocationMode: 'AUTO' },
  });
  for (const c of costs) {
    const trip = await loadTrip(tx, { pickupId: c.pickupId });
    await reallocate(tx, actor, c, null, 'OS criada para o pedido da retirada', trip);
  }
}

/** Taxa de tentativa frustrada: autorização explícita; custo próprio; nunca simula realização. */
export async function addTripFee(
  tx: Tx,
  actor: ActorContext,
  ref: TripRef,
  input: z.output<typeof tripFeeSchema>,
) {
  const trip = await loadTrip(tx, ref, true);
  if (!trip.frustrated)
    throw Errors.business(
      `Taxa só para tentativa frustrada (${trip.code} está ${trip.status.toLowerCase().replace(/_/g, ' ')}).`,
    );
  const { payee } = await configuredPayee(tx);
  if (!payee?.active)
    throw Errors.business('Configure um recebedor ativo da logística antes de autorizar a taxa.');
  const fee = await tx.logisticsCost.findFirst({
    where: { ...tripWhere(trip), kind: TRIP_FEE_KIND, cancelledAt: null },
  });
  if (fee) {
    // Nova tentativa frustrada da mesma viagem: soma à taxa existente como ajuste autorizado.
    await adjustTripCost(tx, actor, fee.id, {
      amountCents: input.amountCents,
      reason: `Nova tentativa frustrada: ${input.reason}`,
      version: fee.version,
    });
    return fee.id;
  }
  const trip0 = await liveTripCost(tx, trip);
  const sos = await tripServiceOrders(tx, trip);
  const c = await tx.logisticsCost.create({
    data: {
      kind: TRIP_FEE_KIND,
      description: `Tentativa frustrada — ${trip.code}`,
      amountCents: input.amountCents,
      date: parseDate(todayIso()),
      ...tripWhere(trip),
      splitMethod: 'IGUAL',
      splitNote: input.reason,
      status: 'DEVIDO',
      dueAt: new Date(),
      allocationMode: 'AUTO',
      allocationRevision: 0,
      createdById: actor.userId,
    },
  });
  if (trip0)
    await setParticipants(
      tx,
      c.id,
      trip0.participants.map((p) => p.userId),
    );
  await reallocate(
    tx,
    actor,
    c,
    sos.map((s) => s.id),
    'Rateio da taxa',
    trip,
  );
  await audit(tx, actor, {
    action: 'finance.trip_fee_authorized',
    entityType: 'logistics_cost',
    entityId: c.id,
    summary: `${logisticsCostCode(c.number)}: taxa de tentativa frustrada de ${trip.code} autorizada (${(input.amountCents / 100).toFixed(2)}). Justificativa: ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: c.id,
    kind: 'TAXA_AUTORIZADA',
    note: input.reason,
    data: { amountCents: input.amountCents },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  await createObligation(tx, actor, { ...c, pendingReason: null });
  return c.id;
}

/** Ajuste do valor devido (com sinal): nunca abaixo do pago; refaz o rateio; auditado. */
export async function adjustTripCost(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.output<typeof tripAdjustmentSchema>,
) {
  await lockRow(tx, 'logistics_costs', id, 'Custo de logística');
  const c = await tx.logisticsCost.findUniqueOrThrow({ where: { id } });
  checkVersion(c, input.version);
  if (c.status === 'PREVISTO')
    throw Errors.business('Ainda não é devido: altere o valor combinado (com motivo).');
  if (c.status === 'CANCELADO') throw Errors.business('Custo cancelado.');
  const payable = c.payableId
    ? await tx.accountPayable.findUniqueOrThrow({ where: { id: c.payableId } })
    : null;
  if (c.payableId) await lockRow(tx, 'account_payables', c.payableId, 'Conta a pagar');
  if (payable?.status === 'CANCELADO') throw Errors.business('A conta a pagar foi cancelada.');
  const before = c.amountCents + c.adjustmentsCents;
  const after = before + input.amountCents;
  if (after <= 0) throw Errors.business('O valor devido precisa continuar maior que zero.');
  if (payable && after < payable.paidCents)
    throw Errors.business(
      `O valor devido não pode ficar abaixo do já pago (${(payable.paidCents / 100).toFixed(2)}): estorne o pagamento antes.`,
    );
  await tx.logisticsCostAdjustment.create({
    data: {
      logisticsCostId: id,
      amountCents: input.amountCents,
      reason: input.reason,
      authorizedById: actor.userId!,
    },
  });
  const u = await tx.logisticsCost.update({
    where: { id },
    data: { adjustmentsCents: { increment: input.amountCents }, version: { increment: 1 } },
  });
  if (payable) {
    const s = settlementStatus(after, payable.paidCents);
    await tx.accountPayable.update({
      where: { id: payable.id },
      data: {
        amountCents: after,
        status: s === 'QUITADO' ? 'PAGO' : s,
        version: { increment: 1 },
      },
    });
    await financeEvent(tx, actor, {
      entityType: 'account_payable',
      entityId: payable.id,
      kind: 'AJUSTE',
      note: input.reason,
      data: { fromCents: before, toCents: after },
      type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
      status: s === 'QUITADO' ? 'PAGO' : s,
    });
  }
  const trip =
    c.pickupId || c.deliveryId
      ? await loadTrip(tx, { pickupId: c.pickupId, deliveryId: c.deliveryId })
      : null;
  await reallocate(tx, actor, u, null, `Ajuste: ${input.reason}`, trip);
  await audit(tx, actor, {
    action: 'finance.trip_cost_adjusted',
    entityType: 'logistics_cost',
    entityId: id,
    summary: `${logisticsCostCode(c.number)}: ajuste de ${(input.amountCents / 100).toFixed(2)}. Motivo: ${input.reason}`,
    changes: { dueCents: { from: before, to: after } },
  });
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: id,
    kind: 'AJUSTE',
    note: input.reason,
    data: { amountCents: input.amountCents, fromCents: before, toCents: after },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
}

/** Estorno de pagamento de conta a pagar: o pagamento original permanece; o saldo volta. */
export async function reversePayablePayment(
  tx: Tx,
  actor: ActorContext,
  paymentId: string,
  input: { reason: string; version: number },
) {
  const pay = await tx.payablePayment.findUnique({ where: { id: paymentId } });
  if (!pay) throw Errors.notFound('Pagamento');
  await lockRow(tx, 'account_payables', pay.payableId, 'Conta a pagar');
  const p = await tx.accountPayable.findUniqueOrThrow({ where: { id: pay.payableId } });
  checkVersion(p, input.version);
  if (await tx.payablePaymentReversal.findUnique({ where: { paymentId } }))
    throw Errors.conflict('Este pagamento já foi estornado.');
  await tx.payablePaymentReversal.create({
    data: { paymentId, reason: input.reason, createdById: actor.userId },
  });
  const paid = p.paidCents - pay.amountCents;
  const s = settlementStatus(p.amountCents, paid);
  const status = s === 'QUITADO' ? 'PAGO' : s;
  await tx.accountPayable.update({
    where: { id: p.id },
    data: { paidCents: paid, status, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'finance.payable_payment_reversed',
    entityType: 'account_payable',
    entityId: p.id,
    summary: `${payableCode(p.number)}: estorno de ${(pay.amountCents / 100).toFixed(2)} — ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'account_payable',
    entityId: p.id,
    kind: 'ESTORNO',
    note: input.reason,
    data: { paymentId, amountCents: pay.amountCents },
    type: EVENT_TYPES.FINANCE_PAYABLE_PAID,
    status,
  });
}

// ─────────────────────────── Consultas ───────────────────────────

export async function tripCostView(db: Db, ref: TripRef): Promise<TripCostViewDto> {
  const trip = await loadTrip(db, ref);
  const { settings, payee } = await configuredPayee(db);
  const costs = await db.logisticsCost.findMany({
    where: { ...tripWhere(trip), kind: { in: [trip.kind, TRIP_FEE_KIND] } },
    include: tripCostInclude,
    orderBy: { number: 'asc' },
  });
  const live = costs.find((c) => c.kind === trip.kind && !c.cancelledAt) ?? null;
  const sos = await tripServiceOrders(db, trip);
  const free = await db.logisticsFreeTrip.findFirst({ where: tripWhere(trip) });
  return {
    freeConfirmed: free ? { reason: free.reason, at: free.createdAt.toISOString() } : null,
    trip: { kind: trip.kind, id: trip.id, code: trip.code, status: trip.status },
    cost: live ? await toTripCostDto(db, live) : null,
    fees: await Promise.all(
      costs.filter((c) => c.kind === TRIP_FEE_KIND).map((c) => toTripCostDto(db, c)),
    ),
    suggestedCents:
      trip.kind === 'RETIRADA'
        ? (settings?.defaultPickupCostCents ?? null)
        : (settings?.defaultDeliveryCostCents ?? null),
    payee,
    serviceOrders: sos.map((s) => ({ id: s.id, code: serviceOrderCode(s.number) })),
  };
}

/**
 * Base do fechamento semanal (Fase 7): valores DEVIDOS por recebedor e semana. Regra: a semana é
 * a do **fato gerador** (realização da viagem ou autorização da taxa — `due_at`), no fuso da
 * oficina; semana de segunda a domingo. Agendamento não entra (nada devido). Pago e saldo são os
 * da conta a pagar no momento da consulta.
 */
export async function logisticsWeekly(
  db: Db,
  from: string,
  to: string,
  payeeUserId?: string,
): Promise<LogisticsWeeklyDto> {
  const tz =
    (await db.companySettings.findUnique({ where: { id: 1 } }))?.timezone ?? 'America/Sao_Paulo';
  const start = zonedDateTime(from, '00:00', tz);
  const endDay = new Date(`${to}T12:00:00Z`);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const end = zonedDateTime(endDay.toISOString().slice(0, 10), '00:00', tz);
  const rows = await db.logisticsCost.findMany({
    where: {
      status: 'DEVIDO',
      dueAt: { gte: start, lt: end },
      ...(payeeUserId ? { payeeUserId } : {}),
    },
    include: tripCostInclude,
    orderBy: [{ dueAt: 'asc' }, { number: 'asc' }],
  });
  const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const items = rows.map((c) => {
    const due = c.amountCents + c.adjustmentsCents;
    const paid = c.payable?.paidCents ?? 0;
    const factDate = local(c.dueAt!);
    return {
      costId: c.id,
      code: logisticsCostCode(c.number),
      kind:
        ALL_LOGISTICS_COST_KIND_LABEL[c.kind as keyof typeof ALL_LOGISTICS_COST_KIND_LABEL] ??
        c.kind,
      payee: c.payee ? { userId: c.payee.id, displayName: c.payee.displayName } : null,
      trip: c.pickup
        ? { kind: 'RETIRADA' as const, id: c.pickup.id, code: pickupCode(c.pickup.number) }
        : c.delivery
          ? { kind: 'ENTREGA' as const, id: c.delivery.id, code: deliveryCode(c.delivery.number) }
          : null,
      serviceOrders: c.allocations
        .filter((a) => a.revision === c.allocationRevision)
        .map((a) => ({
          id: a.serviceOrderId,
          code: serviceOrderCode(a.serviceOrder.number),
          amountCents: a.amountCents,
        })),
      agreedCents: c.amountCents,
      adjustmentsCents: c.adjustmentsCents,
      dueCents: due,
      paidCents: paid,
      openCents: c.payable ? Math.max(0, due - paid) : due,
      factDate,
      weekStart: mondayOf(factDate),
      situation: tripCostSituation({ status: 'DEVIDO', payable: c.payable }),
    };
  });
  const weeks = new Map<string, LogisticsWeeklyDto['weeks'][number]>();
  for (const i of items) {
    const k = `${i.payee?.userId ?? '-'}|${i.weekStart}`;
    const w = weeks.get(k) ?? {
      payeeUserId: i.payee?.userId ?? null,
      displayName: i.payee?.displayName ?? 'Sem recebedor (pendente)',
      weekStart: i.weekStart,
      dueCents: 0,
      paidCents: 0,
      openCents: 0,
      items: 0,
    };
    w.dueCents += i.dueCents;
    w.paidCents += i.paidCents;
    w.openCents += i.openCents;
    w.items += 1;
    weeks.set(k, w);
  }
  return {
    from,
    to,
    timezone: tz,
    items,
    weeks: [...weeks.values()].sort(
      (a, b) =>
        a.weekStart.localeCompare(b.weekStart) || a.displayName.localeCompare(b.displayName),
    ),
  };
}

export { TRIP_KINDS };

// ─────────────────────────── Rotas ───────────────────────────

export async function tripCostRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn, { timeout: 30_000 });
  const tripQuery = z
    .object({ pickupId: idSchema.optional(), deliveryId: idSchema.optional() })
    .refine(
      (q) => Boolean(q.pickupId) !== Boolean(q.deliveryId),
      'Informe a retirada ou a entrega.',
    );

  app.get('/api/v1/finance/logistics-defaults', { config: { access: FIN_VIEW } }, () =>
    logisticsDefaults(prisma),
  );
  app.put(
    '/api/v1/finance/logistics-defaults',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const input = logisticsDefaultsSchema.parse(request.body);
      await tx((t) => setLogisticsDefaults(t, actorFrom(request), input));
      return logisticsDefaults(prisma);
    },
  );

  app.get('/api/v1/finance/trip-costs', { config: { access: FIN_VIEW } }, (request) =>
    tripCostView(prisma, tripQuery.parse(request.query)),
  );
  app.put(
    '/api/v1/finance/trip-costs',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const input = tripCostSchema.parse(request.body);
      await tx((t) => upsertTripCost(t, actorFrom(request), input));
      return tripCostView(prisma, input);
    },
  );
  app.post(
    '/api/v1/finance/trip-costs/fee',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const ref = tripQuery.parse(request.body);
      const input = tripFeeSchema.parse(request.body);
      await tx((t) => addTripFee(t, actorFrom(request), ref, input));
      return tripCostView(prisma, ref);
    },
  );
  app.post(
    '/api/v1/finance/logistics-costs/:id/adjustments',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = tripAdjustmentSchema.parse(request.body);
      await tx((t) => adjustTripCost(t, actorFrom(request), id, input));
      return loadTripCost(prisma, id);
    },
  );
  app.post(
    '/api/v1/finance/logistics-costs/:id/constitute',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await tx(async (t) => {
        // Só completa a obrigação de um custo já DEVIDO (viagem realizada sem recebedor):
        // nunca transforma um combinado (agendado) em devido.
        const c = await t.logisticsCost.findUnique({ where: { id } });
        if (!c) throw Errors.notFound('Custo de logística');
        if (c.status !== 'DEVIDO')
          throw Errors.business('Só um custo já devido (viagem realizada) gera conta a pagar.');
        await constituteTripCost(t, actorFrom(request), id);
      });
      return loadTripCost(prisma, id);
    },
  );
  app.post(
    '/api/v1/finance/payables/:id/payments/:paymentId/reverse',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id, paymentId } = z
        .object({ id: idSchema, paymentId: idSchema })
        .parse(request.params);
      const input = reversePayablePaymentSchema.parse(request.body);
      await tx(async (t) => {
        const pay = await t.payablePayment.findUnique({ where: { id: paymentId } });
        if (!pay || pay.payableId !== id) throw Errors.notFound('Pagamento');
        await reversePayablePayment(t, actorFrom(request), paymentId, input);
      });
      return toPayableDto(
        prisma,
        await prisma.accountPayable.findUniqueOrThrow({ where: { id }, include: payableInclude }),
      );
    },
  );
  app.get('/api/v1/finance/logistics-weekly', { config: { access: FIN_VIEW } }, (request) => {
    const q = logisticsWeeklyQuerySchema.parse(request.query);
    return logisticsWeekly(prisma, q.from, q.to, q.payeeUserId);
  });
}
