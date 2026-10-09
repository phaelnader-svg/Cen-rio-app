import {
  EVENT_TYPES,
  orderFinancialStatus,
  receivableCode,
  settlementProblem,
  settlementStatus,
  signedAdjustment,
  splitCents,
  type AdjustmentKind,
  type OrderRevenueDto,
  type PaymentMethod,
  type ReceivableDto,
  type ReceivableStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { orderCode, serviceOrderCode } from '../commercial/common';
import {
  checkVersion,
  dateOnly,
  financeEvent,
  historyOf,
  lockRow,
  parseDate,
  todayIso,
} from './common';

// ─────────────────────────── Receita do pedido e por OS ───────────────────────────

/** Valor final do pedido = contratado + ajustes autorizados (null se não há valor contratado). */
export async function orderRevenue(db: Tx | PrismaClient, orderId: string) {
  const order = await db.commercialOrder.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { id: true, name: true } },
      serviceOrders: {
        where: { status: 'ABERTA' },
        include: { items: { select: { quantity: true, fulfillmentStage: true } } },
        orderBy: { number: 'asc' },
      },
    },
  });
  if (!order) throw Errors.notFound('Pedido');
  const adjustments = await db.commercialAdjustment.findMany({
    where: { orderId },
    include: { authorizedBy: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const adjustmentsCents = adjustments.reduce((a, x) => a + x.amountCents, 0);
  const finalCents =
    order.agreedValueCents === null ? null : Math.max(0, order.agreedValueCents + adjustmentsCents);
  const receivables = await db.customerReceivable.findMany({
    where: { orderId, status: { not: 'CANCELADO' } },
  });
  const billedCents = receivables.reduce((a, r) => a + r.amountCents, 0);
  const receivedCents = receivables.reduce((a, r) => a + r.receivedCents, 0);
  // Receita por OS: valores definidos pelo gestor (se somam o valor final) ou proporcional às peças.
  const sos = order.serviceOrders;
  const manual =
    finalCents !== null &&
    sos.length > 0 &&
    sos.every((s) => s.revenueCents !== null) &&
    sos.reduce((a, s) => a + (s.revenueCents ?? 0), 0) === finalCents;
  const weights = sos.map((s) =>
    s.items.filter((i) => i.fulfillmentStage !== 'DEVOLVIDA').reduce((a, i) => a + i.quantity, 0),
  );
  const shares = manual
    ? sos.map((s) => s.revenueCents ?? 0)
    : splitCents(finalCents ?? 0, weights.some((w) => w > 0) ? weights : sos.map(() => 1));
  return {
    order,
    adjustments,
    adjustmentsCents,
    finalCents,
    billedCents,
    receivedCents,
    manual,
    shares: sos.map((s, i) => ({ id: s.id, number: s.number, revenueCents: shares[i] ?? 0 })),
  };
}

export async function orderRevenueDto(
  db: Tx | PrismaClient,
  orderId: string,
): Promise<OrderRevenueDto> {
  const r = await orderRevenue(db, orderId);
  return {
    orderId,
    orderCode: orderCode(r.order.number),
    customer: r.order.customer,
    contractedCents: r.order.agreedValueCents,
    adjustmentsCents: r.adjustmentsCents,
    finalCents: r.finalCents,
    billedCents: r.billedCents,
    receivedCents: r.receivedCents,
    openCents: Math.max(0, (r.finalCents ?? 0) - r.receivedCents),
    financialStatus: orderFinancialStatus(r),
    adjustments: r.adjustments.map((a) => ({
      id: a.id,
      kind: a.kind as AdjustmentKind,
      amountCents: a.amountCents,
      reason: a.reason,
      authorizedBy: a.authorizedBy.displayName,
      createdAt: a.createdAt.toISOString(),
    })),
    serviceOrders: r.shares.map((s) => ({
      id: s.id,
      code: serviceOrderCode(s.number),
      revenueCents: s.revenueCents,
      manual: r.manual,
    })),
  };
}

/** Receita atribuída a uma OS (0 se o pedido não tem valor). */
export async function serviceOrderRevenue(db: Tx | PrismaClient, serviceOrderId: string) {
  const so = await db.serviceOrder.findUniqueOrThrow({ where: { id: serviceOrderId } });
  if (so.status !== 'ABERTA') return { revenueCents: 0, hasValue: false };
  const r = await orderRevenue(db, so.orderId);
  return {
    revenueCents: r.shares.find((s) => s.id === serviceOrderId)?.revenueCents ?? 0,
    hasValue: r.finalCents !== null,
  };
}

export async function addCommercialAdjustment(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  input: { kind: AdjustmentKind; amountCents: number; reason: string },
) {
  await lockRow(tx, 'commercial_orders', orderId, 'Pedido');
  const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  if (order.agreedValueCents === null)
    throw Errors.business('Defina primeiro o valor contratado do pedido.');
  const amount = signedAdjustment(input.kind, input.amountCents);
  const current = await orderRevenue(tx, orderId);
  if ((current.finalCents ?? 0) + amount < current.receivedCents)
    throw Errors.business('O valor final não pode ficar abaixo do que já foi recebido.');
  if ((current.finalCents ?? 0) + amount < 0)
    throw Errors.business('O valor final não pode ficar negativo.');
  const adj = await tx.commercialAdjustment.create({
    data: {
      orderId,
      kind: input.kind,
      amountCents: amount,
      reason: input.reason,
      authorizedById: actor.userId!,
    },
  });
  await audit(tx, actor, {
    action: 'finance.commercial_adjustment',
    entityType: 'commercial_order',
    entityId: orderId,
    summary: `${orderCode(order.number)}: ${input.kind.toLowerCase()} de ${(amount / 100).toFixed(2)} — ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'commercial_order',
    entityId: orderId,
    kind: `AJUSTE_${input.kind}`,
    note: input.reason,
    data: { amountCents: amount },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return adj;
}

export async function setRevenueSplit(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  input: { shares: { serviceOrderId: string; revenueCents: number }[]; reason: string },
) {
  await lockRow(tx, 'commercial_orders', orderId, 'Pedido');
  const r = await orderRevenue(tx, orderId);
  if (r.finalCents === null) throw Errors.business('O pedido não tem valor contratado.');
  const ids = new Set(r.shares.map((s) => s.id));
  if (input.shares.length !== ids.size || input.shares.some((s) => !ids.has(s.serviceOrderId)))
    throw Errors.business('Informe o valor de todas as OS ativas do pedido.');
  const total = input.shares.reduce((a, s) => a + s.revenueCents, 0);
  if (total !== r.finalCents)
    throw Errors.business(
      `A soma (${(total / 100).toFixed(2)}) precisa ser igual ao valor final do pedido.`,
    );
  for (const s of input.shares)
    await tx.serviceOrder.update({
      where: { id: s.serviceOrderId },
      data: { revenueCents: s.revenueCents },
    });
  await audit(tx, actor, {
    action: 'finance.revenue_split',
    entityType: 'commercial_order',
    entityId: orderId,
    summary: `Receita do pedido ${orderCode(r.order.number)} distribuída entre as OS: ${input.reason}`,
    changes: input.shares,
  });
  await financeEvent(tx, actor, {
    entityType: 'commercial_order',
    entityId: orderId,
    kind: 'RECEITA_DISTRIBUIDA',
    note: input.reason,
    data: input.shares,
  });
}

// ─────────────────────────── Contas a receber ───────────────────────────

export const receivableInclude = {
  customer: { select: { id: true, name: true } },
  order: { select: { id: true, number: true } },
  serviceOrder: { select: { id: true, number: true } },
  payments: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.CustomerReceivableInclude;
type ReceivableRow = Prisma.CustomerReceivableGetPayload<{ include: typeof receivableInclude }>;

export async function toReceivableDto(
  db: Tx | PrismaClient,
  r: ReceivableRow,
): Promise<ReceivableDto> {
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: r.payments.map((p) => p.createdById).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  const reversed = new Set(r.payments.map((p) => p.reversalOfId).filter(Boolean));
  const due = dateOnly(r.dueDate)!;
  const open = Math.max(0, r.amountCents - r.receivedCents);
  return {
    id: r.id,
    number: r.number,
    code: receivableCode(r.number),
    customer: r.customer,
    order: { id: r.order.id, code: orderCode(r.order.number) },
    serviceOrder: r.serviceOrder
      ? { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) }
      : null,
    description: r.description,
    amountCents: r.amountCents,
    receivedCents: r.receivedCents,
    openCents: open,
    dueDate: due,
    overdue: open > 0 && r.status !== 'CANCELADO' && due < todayIso(),
    expectedMethod: r.expectedMethod as PaymentMethod,
    status: r.status as ReceivableStatus,
    notes: r.notes,
    cancelReason: r.cancelReason,
    payments: r.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      receivedAt: dateOnly(p.receivedAt)!,
      method: p.method as PaymentMethod,
      note: p.note,
      reversalOfId: p.reversalOfId,
      reversed: reversed.has(p.id),
      createdBy: p.createdById ? (users.get(p.createdById) ?? null) : null,
      createdAt: p.createdAt.toISOString(),
    })),
    history: await historyOf(db, 'customer_receivable', r.id),
    version: r.version,
  };
}

const receivableStatus = (amount: number, received: number): ReceivableStatus => {
  const s = settlementStatus(amount, received);
  return s === 'QUITADO' ? 'RECEBIDO' : s;
};

export async function createReceivable(
  tx: Tx,
  actor: ActorContext,
  input: {
    orderId: string;
    serviceOrderId?: string | null;
    description: string;
    amountCents: number;
    dueDate: string;
    expectedMethod: PaymentMethod;
    notes?: string | null;
  },
) {
  await lockRow(tx, 'commercial_orders', input.orderId, 'Pedido');
  const r = await orderRevenue(tx, input.orderId);
  if (r.order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  if (r.finalCents === null) throw Errors.business('O pedido não tem valor contratado.');
  if (r.billedCents + input.amountCents > r.finalCents)
    throw Errors.business(
      `As cobranças passariam do valor final do pedido (saldo a lançar: ${((r.finalCents - r.billedCents) / 100).toFixed(2)}).`,
    );
  if (input.serviceOrderId && !r.shares.some((s) => s.id === input.serviceOrderId))
    throw Errors.business('A OS não pertence a este pedido.');
  const row = await tx.customerReceivable.create({
    data: {
      customerId: r.order.customerId,
      orderId: input.orderId,
      serviceOrderId: input.serviceOrderId ?? null,
      description: input.description,
      amountCents: input.amountCents,
      dueDate: parseDate(input.dueDate),
      expectedMethod: input.expectedMethod,
      notes: input.notes ?? null,
      createdById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'finance.receivable_created',
    entityType: 'customer_receivable',
    entityId: row.id,
    summary: `${receivableCode(row.number)} lançada (${orderCode(r.order.number)}).`,
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: row.id,
    kind: 'LANCADA',
    note: input.description,
    type: EVENT_TYPES.FINANCE_RECEIVABLE_CREATED,
    status: row.status,
  });
  return row;
}

export async function receivePayment(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    amountCents: number;
    receivedAt: string;
    method: PaymentMethod;
    note?: string | null;
    version: number;
  },
) {
  await lockRow(tx, 'customer_receivables', id, 'Conta a receber');
  const r = await tx.customerReceivable.findUniqueOrThrow({ where: { id } });
  checkVersion(r, input.version);
  if (r.status === 'CANCELADO') throw Errors.business('Conta cancelada.');
  const problem = settlementProblem(r.amountCents, r.receivedCents, input.amountCents);
  if (problem) throw Errors.business(problem);
  await tx.customerPayment.create({
    data: {
      receivableId: id,
      amountCents: input.amountCents,
      receivedAt: parseDate(input.receivedAt),
      method: input.method,
      note: input.note ?? null,
      createdById: actor.userId,
    },
  });
  const received = r.receivedCents + input.amountCents;
  const status = receivableStatus(r.amountCents, received);
  const u = await tx.customerReceivable.update({
    where: { id },
    data: { receivedCents: received, status, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'finance.payment_recorded',
    entityType: 'customer_receivable',
    entityId: id,
    summary: `${receivableCode(r.number)}: recebimento de ${(input.amountCents / 100).toFixed(2)} (${input.method}).`,
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: id,
    kind: status === 'RECEBIDO' ? 'QUITADA' : 'RECEBIMENTO_PARCIAL',
    note: input.note ?? null,
    data: { amountCents: input.amountCents, method: input.method },
    type: EVENT_TYPES.FINANCE_PAYMENT_RECORDED,
    status,
  });
  return u;
}

/** Estorno de um recebimento (registro negativo; o original não é apagado). */
export async function reversePayment(
  tx: Tx,
  actor: ActorContext,
  paymentId: string,
  reason: string,
) {
  const p = await tx.customerPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw Errors.notFound('Recebimento');
  await lockRow(tx, 'customer_receivables', p.receivableId, 'Conta a receber');
  if (p.reversalOfId || p.amountCents < 0)
    throw Errors.business('Um estorno não pode ser estornado.');
  if (await tx.customerPayment.findUnique({ where: { reversalOfId: p.id } }))
    throw Errors.conflict('Este recebimento já foi estornado.');
  const r = await tx.customerReceivable.findUniqueOrThrow({ where: { id: p.receivableId } });
  await tx.customerPayment.create({
    data: {
      receivableId: r.id,
      amountCents: -p.amountCents,
      receivedAt: parseDate(todayIso()),
      method: p.method,
      note: `Estorno: ${reason}`.slice(0, 500),
      reversalOfId: p.id,
      createdById: actor.userId,
    },
  });
  const received = r.receivedCents - p.amountCents;
  const u = await tx.customerReceivable.update({
    where: { id: r.id },
    data: {
      receivedCents: received,
      status: receivableStatus(r.amountCents, received),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.payment_reversed',
    entityType: 'customer_receivable',
    entityId: r.id,
    summary: `${receivableCode(r.number)}: estorno de ${(p.amountCents / 100).toFixed(2)} — ${reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: r.id,
    kind: 'ESTORNO',
    note: reason,
    data: { paymentId: p.id, amountCents: p.amountCents },
    type: EVENT_TYPES.FINANCE_PAYMENT_RECORDED,
    status: u.status,
  });
  return u;
}

export async function cancelReceivable(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  await lockRow(tx, 'customer_receivables', id, 'Conta a receber');
  const r = await tx.customerReceivable.findUniqueOrThrow({ where: { id } });
  if (r.status === 'CANCELADO') return r;
  checkVersion(r, input.version);
  if (r.receivedCents !== 0)
    throw Errors.business('Há recebimentos registrados: estorne-os antes de cancelar.');
  const u = await tx.customerReceivable.update({
    where: { id },
    data: {
      status: 'CANCELADO',
      cancelReason: input.reason,
      cancelledAt: new Date(),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.receivable_cancelled',
    entityType: 'customer_receivable',
    entityId: id,
    summary: `${receivableCode(r.number)} cancelada: ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: id,
    kind: 'CANCELADA',
    note: input.reason,
    type: EVENT_TYPES.FINANCE_RECEIVABLE_CREATED,
    status: 'CANCELADO',
  });
  return u;
}
