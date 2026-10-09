import {
  EVENT_TYPES,
  deliveryCode,
  expenseCode,
  logisticsCostCode,
  payableCode,
  recurringDueDate,
  settlementProblem,
  settlementStatus,
  splitCents,
  type ExpenseCategory,
  type ExpenseDto,
  type LogisticsCostDto,
  type LogisticsCostKind,
  type PayableCategory,
  type PayableDto,
  type PayableStatus,
  type PaymentMethod,
  type SplitMethod,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { pickupCode, serviceOrderCode } from '../commercial/common';
import {
  checkVersion,
  dateOnly,
  financeEvent,
  historyOf,
  lockRow,
  parseDate,
  todayIso,
} from './common';

// ─────────────────────────── Contas a pagar ───────────────────────────

export const payableInclude = {
  supplier: { select: { id: true, name: true } },
  payments: { orderBy: { createdAt: 'asc' } },
  expense: { select: { id: true, number: true } },
  logisticsCost: { select: { id: true, number: true } },
} as const satisfies Prisma.AccountPayableInclude;
type PayableRow = Prisma.AccountPayableGetPayload<{ include: typeof payableInclude }>;

export async function toPayableDto(db: Tx | PrismaClient, p: PayableRow): Promise<PayableDto> {
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: p.payments.map((x) => x.createdById).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  const due = dateOnly(p.dueDate)!;
  const open = Math.max(0, p.amountCents - p.paidCents);
  return {
    id: p.id,
    number: p.number,
    code: payableCode(p.number),
    beneficiary: p.beneficiary,
    supplier: p.supplier,
    category: p.category as PayableCategory,
    description: p.description,
    amountCents: p.amountCents,
    paidCents: p.paidCents,
    openCents: open,
    dueDate: due,
    overdue: open > 0 && p.status !== 'CANCELADO' && due < todayIso(),
    status: p.status as PayableStatus,
    notes: p.notes,
    origin: p.expense
      ? { kind: 'DESPESA', id: p.expense.id, code: expenseCode(p.expense.number) }
      : p.logisticsCost
        ? {
            kind: 'LOGISTICA',
            id: p.logisticsCost.id,
            code: logisticsCostCode(p.logisticsCost.number),
          }
        : null,
    payments: p.payments.map((x) => ({
      id: x.id,
      amountCents: x.amountCents,
      paidAt: dateOnly(x.paidAt)!,
      method: x.method as PaymentMethod,
      note: x.note,
      createdBy: x.createdById ? (users.get(x.createdById) ?? null) : null,
    })),
    history: await historyOf(db, 'account_payable', p.id),
    attachments: await db.attachment.count({
      where: { entityType: 'FINANCE_PAYABLE', entityId: p.id, deletedAt: null },
    }),
    version: p.version,
  };
}

export async function createPayable(
  tx: Tx,
  actor: ActorContext,
  input: {
    beneficiary: string;
    supplierId?: string | null;
    category: PayableCategory;
    description: string;
    amountCents: number;
    dueDate: string;
    notes?: string | null;
  },
) {
  if (input.supplierId && !(await tx.supplier.count({ where: { id: input.supplierId } })))
    throw Errors.business('Fornecedor inválido.');
  const p = await tx.accountPayable.create({
    data: {
      beneficiary: input.beneficiary,
      supplierId: input.supplierId ?? null,
      category: input.category,
      description: input.description,
      amountCents: input.amountCents,
      dueDate: parseDate(input.dueDate),
      notes: input.notes ?? null,
      createdById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'finance.payable_created',
    entityType: 'account_payable',
    entityId: p.id,
    summary: `${payableCode(p.number)}: ${input.beneficiary} — ${input.description}.`,
  });
  await financeEvent(tx, actor, {
    entityType: 'account_payable',
    entityId: p.id,
    kind: 'LANCADA',
    note: input.description,
    type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
    status: p.status,
  });
  return p;
}

export async function payPayable(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    amountCents: number;
    paidAt: string;
    method: PaymentMethod;
    note?: string | null;
    version: number;
  },
) {
  await lockRow(tx, 'account_payables', id, 'Conta a pagar');
  const p = await tx.accountPayable.findUniqueOrThrow({ where: { id } });
  checkVersion(p, input.version);
  if (p.status === 'CANCELADO') throw Errors.business('Conta cancelada.');
  const problem = settlementProblem(p.amountCents, p.paidCents, input.amountCents);
  if (problem) throw Errors.business(problem);
  await tx.payablePayment.create({
    data: {
      payableId: id,
      amountCents: input.amountCents,
      paidAt: parseDate(input.paidAt),
      method: input.method,
      note: input.note ?? null,
      createdById: actor.userId,
    },
  });
  const paid = p.paidCents + input.amountCents;
  const s = settlementStatus(p.amountCents, paid);
  const status = s === 'QUITADO' ? 'PAGO' : s;
  const u = await tx.accountPayable.update({
    where: { id },
    data: { paidCents: paid, status, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'finance.payable_paid',
    entityType: 'account_payable',
    entityId: id,
    summary: `${payableCode(p.number)}: pagamento registrado de ${(input.amountCents / 100).toFixed(2)} (${input.method}).`,
  });
  await financeEvent(tx, actor, {
    entityType: 'account_payable',
    entityId: id,
    kind: status === 'PAGO' ? 'QUITADA' : 'PAGAMENTO_PARCIAL',
    note: input.note ?? null,
    data: { amountCents: input.amountCents, method: input.method },
    type: EVENT_TYPES.FINANCE_PAYABLE_PAID,
    status,
  });
  return u;
}

export async function cancelPayable(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version?: number },
) {
  await lockRow(tx, 'account_payables', id, 'Conta a pagar');
  const p = await tx.accountPayable.findUniqueOrThrow({ where: { id } });
  if (p.status === 'CANCELADO') return p;
  if (input.version !== undefined) checkVersion(p, input.version);
  if (p.paidCents > 0) throw Errors.business('Há pagamentos registrados: não pode ser cancelada.');
  const u = await tx.accountPayable.update({
    where: { id },
    data: {
      status: 'CANCELADO',
      cancelReason: input.reason,
      cancelledAt: new Date(),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.payable_cancelled',
    entityType: 'account_payable',
    entityId: id,
    summary: `${payableCode(p.number)} cancelada: ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'account_payable',
    entityId: id,
    kind: 'CANCELADA',
    note: input.reason,
    type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
    status: 'CANCELADO',
  });
  return u;
}

// ─────────────────────────── Despesas operacionais ───────────────────────────

export const expenseInclude = {
  payable: { select: { id: true, number: true, status: true, dueDate: true } },
} as const satisfies Prisma.OperationalExpenseInclude;

export function toExpenseDto(
  e: Prisma.OperationalExpenseGetPayload<{ include: typeof expenseInclude }>,
): ExpenseDto {
  return {
    id: e.id,
    number: e.number,
    code: expenseCode(e.number),
    category: e.category as ExpenseCategory,
    description: e.description,
    amountCents: e.amountCents,
    competence: dateOnly(e.competence)!.slice(0, 7),
    recurring: Boolean(e.recurringId),
    payable: e.payable
      ? {
          id: e.payable.id,
          code: payableCode(e.payable.number),
          status: e.payable.status as PayableStatus,
          dueDate: dateOnly(e.payable.dueDate)!,
        }
      : null,
    cancelled: Boolean(e.cancelledAt),
    version: e.version,
  };
}

/** Despesa por competência + a conta a pagar correspondente (uma só obrigação, sem duplicar). */
export async function createExpense(
  tx: Tx,
  actor: ActorContext,
  input: {
    category: ExpenseCategory;
    description: string;
    amountCents: number;
    competence: string;
    dueDate: string;
    beneficiary: string;
    recurringId?: string | null;
  },
) {
  const payable = await createPayable(tx, actor, {
    beneficiary: input.beneficiary,
    category: input.category,
    description: input.description,
    amountCents: input.amountCents,
    dueDate: input.dueDate,
  });
  const e = await tx.operationalExpense.create({
    data: {
      category: input.category,
      description: input.description,
      amountCents: input.amountCents,
      competence: parseDate(`${input.competence.slice(0, 7)}-01`),
      recurringId: input.recurringId ?? null,
      payableId: payable.id,
      createdById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'finance.expense_created',
    entityType: 'operational_expense',
    entityId: e.id,
    summary: `${expenseCode(e.number)}: ${input.description} (${input.competence.slice(0, 7)}).`,
  });
  await financeEvent(tx, actor, {
    entityType: 'operational_expense',
    entityId: e.id,
    kind: input.recurringId ? 'GERADA_RECORRENCIA' : 'LANCADA',
    note: input.description,
    type: EVENT_TYPES.FINANCE_EXPENSE_CREATED,
  });
  return e;
}

/** Gera as despesas recorrentes do mês (idempotente: uma por modelo e competência). */
export async function generateRecurring(tx: Tx, actor: ActorContext, month: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recurring-expenses'))`;
  const first = parseDate(`${month}-01`);
  const templates = await tx.recurringExpense.findMany({
    where: {
      active: true,
      startMonth: { lte: first },
      OR: [{ endMonth: null }, { endMonth: { gte: first } }],
    },
  });
  let created = 0;
  for (const t of templates) {
    const exists = await tx.operationalExpense.findUnique({
      where: { recurringId_competence: { recurringId: t.id, competence: first } },
    });
    if (exists) continue;
    await createExpense(tx, actor, {
      category: t.category as ExpenseCategory,
      description: t.description,
      amountCents: t.amountCents,
      competence: month,
      dueDate: recurringDueDate(`${month}-01`, t.dayOfMonth),
      beneficiary: t.beneficiary ?? t.description,
      recurringId: t.id,
    });
    created += 1;
  }
  return { created, templates: templates.length };
}

export async function cancelExpense(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  await lockRow(tx, 'operational_expenses', id, 'Despesa');
  const e = await tx.operationalExpense.findUniqueOrThrow({ where: { id } });
  if (e.cancelledAt) return e;
  checkVersion(e, input.version);
  if (e.payableId) await cancelPayable(tx, actor, e.payableId, { reason: input.reason });
  const u = await tx.operationalExpense.update({
    where: { id },
    data: { cancelledAt: new Date(), cancelReason: input.reason, version: { increment: 1 } },
  });
  await financeEvent(tx, actor, {
    entityType: 'operational_expense',
    entityId: id,
    kind: 'CANCELADA',
    note: input.reason,
    type: EVENT_TYPES.FINANCE_EXPENSE_CREATED,
  });
  return u;
}

// ─────────────────────────── Logística ───────────────────────────

export const logisticsInclude = {
  delivery: { select: { id: true, number: true } },
  pickup: { select: { id: true, number: true } },
  payable: { select: { id: true, number: true, status: true } },
  allocations: { include: { serviceOrder: { select: { number: true } } } },
} as const satisfies Prisma.LogisticsCostInclude;

export function toLogisticsDto(
  c: Prisma.LogisticsCostGetPayload<{ include: typeof logisticsInclude }>,
): LogisticsCostDto {
  return {
    id: c.id,
    number: c.number,
    code: logisticsCostCode(c.number),
    kind: c.kind as LogisticsCostKind,
    description: c.description,
    amountCents: c.amountCents,
    date: dateOnly(c.date)!,
    delivery: c.delivery ? { id: c.delivery.id, code: deliveryCode(c.delivery.number) } : null,
    pickup: c.pickup ? { id: c.pickup.id, code: pickupCode(c.pickup.number) } : null,
    beneficiary: c.beneficiary,
    splitMethod: c.splitMethod as SplitMethod,
    splitNote: c.splitNote,
    allocations: c.allocations.map((a) => ({
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
  };
}

/**
 * Um custo por viagem, rateado entre as OS atendidas (igual, por peça ou manual) — a soma do
 * rateio é sempre o valor total, então uma viagem com várias OS nunca é contada duas vezes.
 */
export async function createLogisticsCost(
  tx: Tx,
  actor: ActorContext,
  input: {
    kind: LogisticsCostKind;
    description: string;
    amountCents: number;
    date: string;
    deliveryId?: string | null;
    pickupId?: string | null;
    beneficiary?: string | null;
    splitMethod: SplitMethod;
    splitNote?: string | null;
    allocations: { serviceOrderId: string; amountCents?: number }[];
    payableDueDate?: string | null;
  },
) {
  const sos = await tx.serviceOrder.findMany({
    where: { id: { in: input.allocations.map((a) => a.serviceOrderId) } },
    include: { items: { select: { id: true, quantity: true } } },
  });
  if (sos.length !== input.allocations.length) throw Errors.business('OS inválida no rateio.');
  if (input.deliveryId && !(await tx.delivery.count({ where: { id: input.deliveryId } })))
    throw Errors.business('Entrega inválida.');
  if (input.pickupId && !(await tx.pickupRequest.count({ where: { id: input.pickupId } })))
    throw Errors.business('Retirada inválida.');
  // Evita lançar duas vezes o mesmo custo da mesma viagem.
  if (input.deliveryId || input.pickupId) {
    const dup = await tx.logisticsCost.findFirst({
      where: {
        kind: input.kind,
        cancelledAt: null,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : { pickupId: input.pickupId }),
      },
    });
    if (dup)
      throw Errors.conflict(
        `Já existe custo de ${input.kind.toLowerCase()} para esta ${input.deliveryId ? 'entrega' : 'retirada'} (${logisticsCostCode(dup.number)}).`,
      );
  }
  let pieces = sos.map((s) => s.items.reduce((a, i) => a + i.quantity, 0));
  if (input.deliveryId && input.splitMethod === 'POR_PECA') {
    const di = await tx.deliveryItem.findMany({
      where: { deliveryId: input.deliveryId, active: true },
      include: { serviceOrderItem: { select: { serviceOrderId: true, quantity: true } } },
    });
    if (di.length)
      pieces = sos.map((s) =>
        di
          .filter((x) => x.serviceOrderItem.serviceOrderId === s.id)
          .reduce((a, x) => a + x.serviceOrderItem.quantity, 0),
      );
  }
  const ordered = input.allocations.map((a) => sos.find((s) => s.id === a.serviceOrderId)!);
  const amounts =
    input.splitMethod === 'MANUAL'
      ? input.allocations.map((a) => a.amountCents ?? 0)
      : splitCents(
          input.amountCents,
          input.splitMethod === 'IGUAL'
            ? ordered.map(() => 1)
            : ordered.map((s) => pieces[sos.indexOf(s)] ?? 0),
        );
  if (amounts.reduce((a, b) => a + b, 0) !== input.amountCents)
    throw Errors.business('A soma do rateio precisa ser igual ao valor total.');
  const payable = input.payableDueDate
    ? await createPayable(tx, actor, {
        beneficiary: input.beneficiary!,
        category: 'LOGISTICA',
        description: input.description,
        amountCents: input.amountCents,
        dueDate: input.payableDueDate,
      })
    : null;
  const c = await tx.logisticsCost.create({
    data: {
      kind: input.kind,
      description: input.description,
      amountCents: input.amountCents,
      date: parseDate(input.date),
      deliveryId: input.deliveryId ?? null,
      pickupId: input.pickupId ?? null,
      beneficiary: input.beneficiary ?? null,
      splitMethod: input.splitMethod,
      splitNote: input.splitNote ?? null,
      payableId: payable?.id ?? null,
      createdById: actor.userId,
      allocations: {
        create: ordered.map((s, i) => ({ serviceOrderId: s.id, amountCents: amounts[i]! })),
      },
    },
  });
  await audit(tx, actor, {
    action: 'finance.logistics_cost_created',
    entityType: 'logistics_cost',
    entityId: c.id,
    summary: `${logisticsCostCode(c.number)}: ${input.description} rateado entre ${ordered.length} OS (${input.splitMethod}).`,
    changes: {
      allocations: ordered.map((s, i) => ({
        os: serviceOrderCode(s.number),
        amountCents: amounts[i],
      })),
    },
  });
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: c.id,
    kind: 'LANCADO',
    note: input.splitNote ?? null,
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return c;
}

export async function cancelLogisticsCost(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  await lockRow(tx, 'logistics_costs', id, 'Custo de logística');
  const c = await tx.logisticsCost.findUniqueOrThrow({ where: { id } });
  if (c.cancelledAt) return c;
  checkVersion(c, input.version);
  if (c.payableId) await cancelPayable(tx, actor, c.payableId, { reason: input.reason });
  const u = await tx.logisticsCost.update({
    where: { id },
    data: { cancelledAt: new Date(), cancelReason: input.reason, version: { increment: 1 } },
  });
  await financeEvent(tx, actor, {
    entityType: 'logistics_cost',
    entityId: id,
    kind: 'CANCELADO',
    note: input.reason,
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return u;
}

// ─────────────────────────── Equipe de remuneração fixa ───────────────────────────

/** Custo mensal (João, Thiago). Não gera pagamento por produção nem descontos automáticos. */
export async function upsertTeamCost(
  tx: Tx,
  actor: ActorContext,
  input: { userId: string; month: string; amountCents: number; notes?: string | null },
) {
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    include: { employee: true },
  });
  if (!user?.employee) throw Errors.business('Funcionário inválido.');
  const month = parseDate(`${input.month}-01`);
  const row = await tx.teamMonthlyCost.upsert({
    where: { userId_month: { userId: user.id, month } },
    create: {
      userId: user.id,
      month,
      amountCents: input.amountCents,
      notes: input.notes ?? null,
      createdById: actor.userId,
    },
    update: {
      amountCents: input.amountCents,
      notes: input.notes ?? null,
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.team_cost',
    entityType: 'team_monthly_cost',
    entityId: row.id,
    summary: `Custo de equipe de ${user.displayName} em ${input.month} registrado.`,
  });
  await financeEvent(tx, actor, {
    entityType: 'team_monthly_cost',
    entityId: row.id,
    kind: 'REGISTRADO',
    data: { amountCents: input.amountCents },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return row;
}
