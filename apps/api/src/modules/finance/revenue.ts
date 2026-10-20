import {
  EVENT_TYPES,
  deliveryCode,
  formatCents,
  itemValuesProblem,
  orderFinancialStatus,
  receivableCode,
  receivableOverdue,
  effectiveDueDate,
  settlementProblem,
  settlementStatus,
  signedAdjustment,
  splitCents,
  unitValues,
  type AdjustmentKind,
  type DueTrigger,
  type OrderRevenueDto,
  type PaymentMethod,
  type PaymentReportDto,
  type ReceivableDto,
  type ReceivableStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { orderCode, pickupCode, serviceOrderCode } from '../commercial/common';
import { serviceStates } from '../commercial/status';
import {
  checkVersion,
  dateOnly,
  financeEvent,
  historyOf,
  localDateOf,
  lockRow,
  parseDate,
  shopTimezone,
  todayIso,
} from './common';

/**
 * Cobrança do cliente. Fontes de verdade (inalteradas):
 * - valor final = `agreed_value_cents` + Σ `commercial_adjustments`;
 * - cobranças = `customer_receivables`; caixa = `customer_payments`;
 * - Resultado da OS = receita econômica/contratual (nunca o dinheiro recebido).
 * Ordem única de bloqueio: pedido → cobranças (→ registro da equipe).
 */

const ITEM_GONE = ['DEVOLVIDA', 'CANCELADA'];

// ─────────────────────────── Receita do pedido e por OS ───────────────────────────

/**
 * Valor final do pedido = contratado + ajustes autorizados (null se não há valor contratado).
 *
 * Receita por OS:
 * - Com valores por peça (AM-2/AM-3): soma do valor das unidades efetivamente na OS. A unidade k
 *   de uma peça tem sempre o mesmo valor e as primeiras unidades vão para as primeiras peças de OS
 *   criadas — a OS que nasceu antes nunca perde receita quando outra nasce. Peça que ainda não
 *   chegou (ou devolvida/cancelada) fica sem OS: não transfere receita.
 * - Sem valores por peça: o fallback de sempre (manual se somar o total; senão proporcional às
 *   peças), identificado como ESTIMADO.
 */
export async function orderRevenue(db: Tx | PrismaClient, orderId: string) {
  const order = await db.commercialOrder.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { id: true, name: true } },
      items: { orderBy: { position: 'asc' } },
      serviceOrders: {
        where: { status: 'ABERTA' },
        include: {
          items: {
            select: {
              id: true,
              orderItemId: true,
              quantity: true,
              fulfillmentStage: true,
              createdAt: true,
            },
          },
        },
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
  const sos = order.serviceOrders;
  const itemValuesUsed =
    order.items.length > 0 && order.items.every((i) => i.agreedValueCents !== null);

  const bySo = new Map<string, number>(sos.map((s) => [s.id, 0]));
  const attributed = new Map<string, number>();
  let manual = false;
  if (itemValuesUsed) {
    for (const oi of order.items) {
      const units = unitValues(oi.agreedValueCents!, oi.quantity);
      const lines = sos
        .flatMap((s) =>
          s.items
            .filter((si) => si.orderItemId === oi.id && !ITEM_GONE.includes(si.fulfillmentStage))
            .map((si) => ({ so: s.id, si })),
        )
        .sort(
          (a, b) =>
            a.si.createdAt.getTime() - b.si.createdAt.getTime() || a.si.id.localeCompare(b.si.id),
        );
      let k = 0;
      for (const l of lines) {
        let sum = 0;
        for (let u = 0; u < l.si.quantity && k < units.length; u++, k++) sum += units[k]!;
        bySo.set(l.so, (bySo.get(l.so) ?? 0) + sum);
        attributed.set(oi.id, (attributed.get(oi.id) ?? 0) + sum);
      }
    }
  } else {
    // Fallback (Fase 11): manual se somar o total; senão proporcional às peças ativas — estimado.
    manual =
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
    sos.forEach((s, i) => bySo.set(s.id, shares[i] ?? 0));
  }
  return {
    order,
    adjustments,
    adjustmentsCents,
    finalCents,
    receivables,
    billedCents,
    receivedCents,
    manual,
    itemValuesUsed,
    /** Receita por OS estimada (sem valores por peça e sem distribuição manual). */
    estimated: !itemValuesUsed && !manual,
    pieces: order.items.map((i) => ({
      orderItemId: i.id,
      position: i.position,
      description: i.description,
      quantity: i.quantity,
      valueCents: i.agreedValueCents,
      attributedCents: itemValuesUsed ? (attributed.get(i.id) ?? 0) : 0,
      pendingCents: itemValuesUsed ? i.agreedValueCents! - (attributed.get(i.id) ?? 0) : 0,
    })),
    shares: sos.map((s) => ({ id: s.id, number: s.number, revenueCents: bySo.get(s.id) ?? 0 })),
  };
}

// ─────────────────────────── Vencimento (data ou evento) ───────────────────────────

export interface DueContext {
  timeZone: string;
  today: string;
  /** Por pedido: data local da primeira retirada realizada e da primeira entrega concluída. */
  events: Map<string, { pickup: string | null; delivery: string | null }>;
}

/** Conclusão REAL dos eventos de cada pedido (reagendamento ou tentativa frustrada não contam). */
export async function dueContext(db: Tx | PrismaClient, orderIds: string[]): Promise<DueContext> {
  const timeZone = await shopTimezone(db);
  const events = new Map<string, { pickup: string | null; delivery: string | null }>();
  const ids = [...new Set(orderIds)];
  for (const id of ids) events.set(id, { pickup: null, delivery: null });
  if (ids.length) {
    const picked = await db.pickupEvent.findMany({
      where: { toStatus: 'RETIRADA_REALIZADA', pickup: { orderId: { in: ids } } },
      select: { occurredAt: true, pickup: { select: { orderId: true } } },
    });
    for (const p of picked) {
      const d = localDateOf(p.occurredAt, timeZone);
      const cur = events.get(p.pickup.orderId)!;
      if (!cur.pickup || d < cur.pickup) cur.pickup = d;
    }
    // Gatilho ENTREGA (decisão do proprietário, Fase 8): só entrega física EFETIVA — peça do
    // pedido registrada como entregue (ou entregue com divergência) numa entrega CONCLUÍDA.
    // "Não entregue", peça retirada antes da saída, tentativa frustrada ou a simples associação
    // histórica à entrega não contam. A entrega parcial real continua valendo (regra comercial).
    const effective = {
      status: { in: ['ENTREGUE', 'DIVERGENTE'] },
      serviceOrderItem: { serviceOrder: { orderId: { in: ids } } },
    } satisfies Prisma.DeliveryItemWhereInput;
    const delivered = await db.delivery.findMany({
      where: { status: 'CONCLUIDA', completedAt: { not: null }, items: { some: effective } },
      select: {
        completedAt: true,
        items: {
          where: effective,
          select: { serviceOrderItem: { select: { serviceOrder: { select: { orderId: true } } } } },
        },
      },
    });
    for (const dl of delivered) {
      const d = localDateOf(dl.completedAt!, timeZone);
      for (const oid of new Set(dl.items.map((i) => i.serviceOrderItem.serviceOrder.orderId))) {
        const cur = events.get(oid);
        if (cur && (!cur.delivery || d < cur.delivery)) cur.delivery = d;
      }
    }
  }
  return { timeZone, today: todayIso(timeZone), events };
}

/** Vencimento efetivo e atraso de uma cobrança (derivados; nada é gravado). */
export function dueOf(
  r: {
    orderId: string;
    dueTrigger: string;
    dueDate: Date | null;
    amountCents: number;
    receivedCents: number;
    status: string;
  },
  ctx: DueContext,
) {
  const ev = ctx.events.get(r.orderId) ?? { pickup: null, delivery: null };
  const trigger = r.dueTrigger as DueTrigger;
  const effectiveDue = effectiveDueDate({
    dueTrigger: trigger,
    dueDate: dateOnly(r.dueDate),
    eventDate: trigger === 'RETIRADA' ? ev.pickup : trigger === 'ENTREGA' ? ev.delivery : null,
  });
  const openCents = Math.max(0, r.amountCents - r.receivedCents);
  return {
    effectiveDue,
    openCents,
    ...receivableOverdue({
      dueTrigger: trigger,
      effectiveDue,
      openCents,
      cancelled: r.status === 'CANCELADO',
      today: ctx.today,
    }),
  };
}

export async function orderRevenueDto(
  db: Tx | PrismaClient,
  orderId: string,
): Promise<OrderRevenueDto> {
  const r = await orderRevenue(db, orderId);
  const state = (
    await serviceStates(db, [
      {
        id: orderId,
        status: r.order.status,
        items: r.order.items.map((i) => ({
          receivedQuantity: i.receivedQuantity,
          returnedQuantity: i.returnedQuantity,
        })),
      },
    ])
  ).get(orderId)!;
  const ctx = await dueContext(db, [orderId]);
  const overdueCents = r.receivables.reduce((a, x) => {
    const d = dueOf(x, ctx);
    return a + (d.overdue ? d.openCents : 0);
  }, 0);
  return {
    orderId,
    serviceState: state.serviceState,
    returnedPieces: state.returnedPieces,
    orderCode: orderCode(r.order.number),
    customer: r.order.customer,
    contractedCents: r.order.agreedValueCents,
    adjustmentsCents: r.adjustmentsCents,
    finalCents: r.finalCents,
    billedCents: r.billedCents,
    receivedCents: r.receivedCents,
    openCents: Math.max(0, (r.finalCents ?? 0) - r.receivedCents),
    overdueCents,
    toBillCents: Math.max(0, (r.finalCents ?? 0) - r.billedCents),
    financialStatus: orderFinancialStatus({ ...r, overdueCents }),
    paymentTerms: r.order.paymentTerms,
    itemValuesUsed: r.itemValuesUsed,
    pieces: r.pieces,
    revenueEstimated: r.estimated,
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
      estimated: r.estimated,
    })),
  };
}

/** Receita atribuída a uma OS (0 se o pedido não tem valor). */
export async function serviceOrderRevenue(db: Tx | PrismaClient, serviceOrderId: string) {
  const so = await db.serviceOrder.findUniqueOrThrow({ where: { id: serviceOrderId } });
  if (so.status !== 'ABERTA') return { revenueCents: 0, hasValue: false, estimated: false };
  const r = await orderRevenue(db, so.orderId);
  return {
    revenueCents: r.shares.find((s) => s.id === serviceOrderId)?.revenueCents ?? 0,
    hasValue: r.finalCents !== null,
    estimated: r.finalCents !== null && r.estimated,
  };
}

// ─────────────────────────── Bloqueios ───────────────────────────

export const lockOrder = (tx: Tx, orderId: string) =>
  lockRow(tx, 'commercial_orders', orderId, 'Pedido');

/** Todas as cobranças do pedido, na ordem pedido → cobranças (por id, determinística). */
export async function lockOrderReceivables(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT id FROM customer_receivables WHERE order_id = ${orderId}::uuid ORDER BY id FOR UPDATE`;
}

/** Bloqueia o pedido da cobrança e, depois, a cobrança. */
async function lockReceivable(tx: Tx, id: string) {
  const r = await tx.customerReceivable.findUnique({ where: { id }, select: { orderId: true } });
  if (!r) throw Errors.notFound('Conta a receber');
  await lockOrder(tx, r.orderId);
  await lockRow(tx, 'customer_receivables', id, 'Conta a receber');
  return tx.customerReceivable.findUniqueOrThrow({ where: { id } });
}

// ─────────────────────────── Valor fechado e valores por peça ───────────────────────────

type ItemValueInput = { orderItemId: string; agreedValueCents: number }[] | null | undefined;

/**
 * Valores por peça (AM-2): todos ou nenhum, soma EXATAMENTE igual ao valor final. Validação
 * transacional no domínio (não há restrição possível entre tabelas). Com valores em uso, qualquer
 * mudança do total exige a nova distribuição (`required`). Nada é redistribuído em silêncio.
 */
export async function applyItemValues(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  values: ItemValueInput,
  finalCents: number | null,
  opts: { required: boolean; reason: string },
) {
  const items = await tx.commercialOrderItem.findMany({
    where: { orderId },
    orderBy: { position: 'asc' },
  });
  const inUse = items.length > 0 && items.every((i) => i.agreedValueCents !== null);
  if (!values) {
    if (opts.required && inUse)
      throw Errors.business(
        `Este pedido tem valor por peça: informe a nova distribuição (a soma precisa ser ${formatCents(finalCents ?? 0)}).`,
      );
    return false;
  }
  const byId = new Map(values.map((v) => [v.orderItemId, v.agreedValueCents]));
  if (
    byId.size !== values.length ||
    items.some((i) => !byId.has(i.id)) ||
    byId.size !== items.length
  )
    throw Errors.validation(undefined, 'Informe o valor de todas as peças do pedido.');
  const problem = itemValuesProblem(
    items.map((i) => byId.get(i.id)!),
    finalCents,
  );
  if (problem) throw Errors.business(problem);
  const changed = items.filter((i) => i.agreedValueCents !== byId.get(i.id));
  if (!changed.length) return false;
  for (const i of changed)
    await tx.commercialOrderItem.update({
      where: { id: i.id },
      data: { agreedValueCents: byId.get(i.id)! },
    });
  const changes = changed.map((i) => ({
    description: i.description,
    from: i.agreedValueCents,
    to: byId.get(i.id)!,
  }));
  await audit(tx, actor, {
    action: 'finance.item_values',
    entityType: 'commercial_order',
    entityId: orderId,
    summary: `Valores por peça: ${opts.reason}`,
    changes,
  });
  await financeEvent(tx, actor, {
    entityType: 'commercial_order',
    entityId: orderId,
    kind: 'VALORES_POR_PECA',
    note: opts.reason,
    data: changes,
  });
  return true;
}

/** Valor contratado inicial ou alterado diretamente (antes da primeira cobrança): evento financeiro. */
export async function recordAgreedValue(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  from: number | null,
  to: number | null,
) {
  await financeEvent(tx, actor, {
    entityType: 'commercial_order',
    entityId: orderId,
    kind: from === null && to !== null ? 'VALOR_FECHADO' : 'VALOR_ALTERADO',
    note: null,
    data: { fromCents: from, toCents: to },
  });
}

/** Lançamento do ajuste comercial (imutável) + auditoria + histórico. */
async function insertAdjustment(
  tx: Tx,
  actor: ActorContext,
  order: { id: string; number: number },
  kind: AdjustmentKind,
  amount: number,
  reason: string,
) {
  const adj = await tx.commercialAdjustment.create({
    data: { orderId: order.id, kind, amountCents: amount, reason, authorizedById: actor.userId! },
  });
  await audit(tx, actor, {
    action: 'finance.commercial_adjustment',
    entityType: 'commercial_order',
    entityId: order.id,
    summary: `${orderCode(order.number)}: ${kind.toLowerCase()} de ${(amount / 100).toFixed(2)} — ${reason}`,
    changes: { kind, amountCents: amount, reason },
  });
  await financeEvent(tx, actor, {
    entityType: 'commercial_order',
    entityId: order.id,
    kind: `AJUSTE_${kind}`,
    note: reason,
    data: { amountCents: amount },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return adj;
}

/** Ajuste do valor de uma cobrança aberta (nunca abaixo do recebido); cancela se ficar zerada. */
async function reduceReceivable(
  tx: Tx,
  actor: ActorContext,
  r: { id: string; number: number; amountCents: number; receivedCents: number },
  by: number,
  reason: string,
) {
  const next = r.amountCents - by;
  if (next < r.receivedCents)
    throw Errors.business(
      `${receivableCode(r.number)}: não é possível reduzir abaixo do já recebido (${formatCents(r.receivedCents)}).`,
    );
  if (next === 0) {
    await tx.customerReceivable.update({
      where: { id: r.id },
      data: {
        status: 'CANCELADO',
        cancelReason: reason.slice(0, 500),
        cancelledAt: new Date(),
        version: { increment: 1 },
      },
    });
  } else {
    await tx.customerReceivable.update({
      where: { id: r.id },
      data: {
        amountCents: next,
        status: receivableStatus(next, r.receivedCents),
        version: { increment: 1 },
      },
    });
  }
  await audit(tx, actor, {
    action: 'finance.receivable_reduced',
    entityType: 'customer_receivable',
    entityId: r.id,
    summary: `${receivableCode(r.number)}: valor ${formatCents(r.amountCents)} → ${formatCents(next)} — ${reason}`,
    changes: { fromCents: r.amountCents, toCents: next },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: r.id,
    kind: next === 0 ? 'CANCELADA' : 'VALOR_REDUZIDO',
    note: reason,
    data: { fromCents: r.amountCents, toCents: next },
    type: EVENT_TYPES.FINANCE_RECEIVABLE_CREATED,
    status: next === 0 ? 'CANCELADO' : receivableStatus(next, r.receivedCents),
  });
}

/**
 * AM-6: o total lançado não pode passar do novo valor final. Com redução explícita do gestor,
 * aplica exatamente as reduções informadas; sem ela, só reduz automaticamente a cobrança de
 * vencimento mais distante que esteja ABERTA, sem recebimento e sem pagamento — e só se ela
 * cobrir sozinha a diferença. Caso contrário, exige decisão explícita.
 */
async function fitReceivablesTo(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  newFinal: number,
  reductions: { receivableId: string; amountCents: number }[] | null | undefined,
  reason: string,
) {
  const open = await tx.customerReceivable.findMany({
    where: { orderId, status: { not: 'CANCELADO' } },
    include: { _count: { select: { payments: true } } },
  });
  const billed = open.reduce((a, r) => a + r.amountCents, 0);
  const needed = billed - newFinal;
  if (needed <= 0) return;
  if (reductions?.length) {
    const total = reductions.reduce((a, x) => a + x.amountCents, 0);
    if (total < needed)
      throw Errors.business(
        `As reduções informadas (${formatCents(total)}) não cobrem a diferença (${formatCents(needed)}).`,
      );
    for (const x of reductions) {
      const r = open.find((o) => o.id === x.receivableId);
      if (!r) throw Errors.validation(undefined, 'Cobrança não pertence ao pedido.');
      await reduceReceivable(tx, actor, r, x.amountCents, reason);
    }
    return;
  }
  const virgin = open
    .filter((r) => r.status === 'ABERTO' && r.receivedCents === 0 && r._count.payments === 0)
    .sort((a, b) => {
      // Vencimento mais distante: evento (sem data) é o mais distante; depois a maior data.
      const da = a.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const db_ = b.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return db_ - da || b.createdAt.getTime() - a.createdAt.getTime();
    });
  const target = virgin[0];
  if (!target || target.amountCents < needed)
    throw Errors.business(
      `O valor final ficaria abaixo do total já lançado em cobranças (diferença ${formatCents(needed)}). ` +
        'Nenhuma cobrança em aberto sem recebimento cobre a diferença: cancele/ajuste as cobranças ou use o reembolso.',
      { neededCents: needed },
    );
  await reduceReceivable(tx, actor, target, needed, reason);
}

export async function addCommercialAdjustment(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  input: {
    kind: AdjustmentKind;
    amountCents: number;
    reason: string;
    itemValues?: ItemValueInput;
    receivableReductions?: { receivableId: string; amountCents: number }[] | null;
  },
) {
  await lockOrder(tx, orderId);
  await lockOrderReceivables(tx, orderId);
  const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  if (order.agreedValueCents === null)
    throw Errors.business('Defina primeiro o valor contratado do pedido.');
  const amount = signedAdjustment(input.kind, input.amountCents);
  const current = await orderRevenue(tx, orderId);
  const newFinal = (current.finalCents ?? 0) + amount;
  if (newFinal < 0) throw Errors.business('O valor final não pode ficar negativo.');
  if (newFinal < current.receivedCents)
    throw Errors.business(
      `O valor final não pode ficar abaixo do que já foi recebido (${formatCents(current.receivedCents)}): use o reembolso.`,
    );
  const adj = await insertAdjustment(tx, actor, order, input.kind, amount, input.reason);
  await applyItemValues(tx, actor, orderId, input.itemValues, newFinal, {
    required: true,
    reason: `ajuste do pedido — ${input.reason}`,
  });
  await fitReceivablesTo(
    tx,
    actor,
    orderId,
    newFinal,
    input.receivableReductions,
    `Ajuste: ${input.reason}`,
  );
  return adj;
}

export async function setRevenueSplit(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  input: { shares: { serviceOrderId: string; revenueCents: number }[]; reason: string },
) {
  await lockOrder(tx, orderId);
  const r = await orderRevenue(tx, orderId);
  if (r.finalCents === null) throw Errors.business('O pedido não tem valor contratado.');
  if (r.itemValuesUsed)
    throw Errors.business(
      'O pedido tem valor por peça: a receita de cada OS é a soma das peças dela (altere os valores das peças).',
    );
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

export const reportInclude = {
  reportedBy: { select: { displayName: true } },
  decidedBy: { select: { displayName: true } },
  pickup: { select: { id: true, number: true } },
  delivery: { select: { id: true, number: true } },
  receivable: {
    select: {
      id: true,
      number: true,
      description: true,
      amountCents: true,
      receivedCents: true,
      expectedMethod: true,
      installments: true,
      order: { select: { id: true, number: true, customer: { select: { name: true } } } },
    },
  },
} as const satisfies Prisma.CustomerPaymentReportInclude;
export type ReportRow = Prisma.CustomerPaymentReportGetPayload<{ include: typeof reportInclude }>;

export function toPaymentReportDto(p: ReportRow): PaymentReportDto {
  return {
    id: p.id,
    receivable: {
      id: p.receivable.id,
      code: receivableCode(p.receivable.number),
      description: p.receivable.description,
      openCents: Math.max(0, p.receivable.amountCents - p.receivable.receivedCents),
    },
    order: { id: p.receivable.order.id, code: orderCode(p.receivable.order.number) },
    customerName: p.receivable.order.customer.name,
    stop: p.pickup
      ? { kind: 'RETIRADA', id: p.pickup.id, code: pickupCode(p.pickup.number) }
      : { kind: 'ENTREGA', id: p.delivery!.id, code: deliveryCode(p.delivery!.number) },
    collected: p.collected,
    method: p.method as PaymentMethod | null,
    note: p.note,
    reportedBy: p.reportedBy.displayName,
    reportedAt: p.reportedAt.toISOString(),
    status: p.status as PaymentReportDto['status'],
    paymentId: p.paymentId,
    decidedBy: p.decidedBy?.displayName ?? null,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    expectedMethod: p.receivable.expectedMethod as PaymentMethod,
    installments: p.receivable.installments,
    version: p.version,
  };
}

export const receivableInclude = {
  customer: { select: { id: true, name: true } },
  order: { select: { id: true, number: true } },
  serviceOrder: { select: { id: true, number: true } },
  payments: { orderBy: { createdAt: 'asc' } },
  reports: { include: reportInclude, orderBy: { reportedAt: 'desc' } },
} as const satisfies Prisma.CustomerReceivableInclude;
type ReceivableRow = Prisma.CustomerReceivableGetPayload<{ include: typeof receivableInclude }>;

export async function toReceivableDto(
  db: Tx | PrismaClient,
  r: ReceivableRow,
  ctx?: DueContext,
): Promise<ReceivableDto> {
  const due = ctx ?? (await dueContext(db, [r.orderId]));
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: r.payments.map((p) => p.createdById).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  const reversed = new Set(r.payments.map((p) => p.reversalOfId).filter(Boolean));
  const d = dueOf(r, due);
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
    openCents: d.openCents,
    dueDate: dateOnly(r.dueDate),
    dueTrigger: r.dueTrigger as DueTrigger,
    effectiveDueDate: d.effectiveDue,
    overdue: d.overdue,
    daysOverdue: d.daysOverdue,
    expectedMethod: r.expectedMethod as PaymentMethod,
    installments: r.installments,
    status: r.status as ReceivableStatus,
    notes: r.notes,
    cancelReason: r.cancelReason,
    payments: r.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      receivedAt: dateOnly(p.receivedAt)!,
      method: p.method as PaymentMethod,
      installments: p.installments,
      refund: p.refund,
      note: p.note,
      reversalOfId: p.reversalOfId,
      reversed: reversed.has(p.id),
      createdBy: p.createdById ? (users.get(p.createdById) ?? null) : null,
      createdAt: p.createdAt.toISOString(),
    })),
    reports: [...r.reports]
      .sort((a, b) => Number(b.status === 'PENDENTE') - Number(a.status === 'PENDENTE'))
      .map(toPaymentReportDto),
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
    dueTrigger?: DueTrigger;
    dueDate?: string | null;
    expectedMethod: PaymentMethod;
    installments?: number | null;
    notes?: string | null;
  },
) {
  await lockOrder(tx, input.orderId);
  const r = await orderRevenue(tx, input.orderId);
  if (r.order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  if (r.finalCents === null) throw Errors.business('O pedido não tem valor contratado.');
  const trigger = input.dueTrigger ?? 'DATA';
  if (trigger === 'DATA' && !input.dueDate)
    throw Errors.validation(undefined, 'Informe o vencimento.');
  if (trigger === 'RETIRADA' && r.order.customerDropOff)
    throw Errors.business('O cliente entrega as peças (sem retirada): escolha outro vencimento.');
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
      dueTrigger: trigger,
      dueDate: trigger === 'DATA' ? parseDate(input.dueDate!) : null,
      expectedMethod: input.expectedMethod,
      installments: input.installments ?? null,
      notes: input.notes ?? null,
      createdById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'finance.receivable_created',
    entityType: 'customer_receivable',
    entityId: row.id,
    summary: `${receivableCode(row.number)} lançada (${orderCode(r.order.number)}).`,
    changes: {
      amountCents: row.amountCents,
      dueTrigger: trigger,
      dueDate: dateOnly(row.dueDate),
      expectedMethod: row.expectedMethod,
      installments: row.installments,
    },
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

/** Recebimento: pedido → cobrança; nunca acima do saldo; data futura recusada (AM-12). */
export async function receivePayment(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    amountCents: number;
    receivedAt: string;
    method: PaymentMethod;
    installments?: number | null;
    note?: string | null;
    version: number;
  },
) {
  const r = await lockReceivable(tx, id);
  checkVersion(r, input.version);
  if (r.status === 'CANCELADO') throw Errors.business('Conta cancelada.');
  const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: r.orderId } });
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  const today = todayIso(await shopTimezone(tx));
  if (input.receivedAt > today) throw Errors.business('A data do recebimento não pode ser futura.');
  const problem = settlementProblem(r.amountCents, r.receivedCents, input.amountCents);
  if (problem) throw Errors.business(problem);
  const payment = await tx.customerPayment.create({
    data: {
      receivableId: id,
      amountCents: input.amountCents,
      receivedAt: parseDate(input.receivedAt),
      method: input.method,
      installments: input.installments ?? null,
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
    summary: `${receivableCode(r.number)}: recebimento de ${(input.amountCents / 100).toFixed(2)} (${input.method}${input.installments ? ` ${input.installments}×` : ''}).`,
    changes: {
      receivedCents: { from: r.receivedCents, to: received },
      status: { from: r.status, to: u.status },
    },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: id,
    kind: status === 'RECEBIDO' ? 'QUITADA' : 'RECEBIMENTO_PARCIAL',
    note: input.note ?? null,
    data: {
      amountCents: input.amountCents,
      method: input.method,
      installments: input.installments ?? null,
    },
    type: EVENT_TYPES.FINANCE_PAYMENT_RECORDED,
    status,
  });
  return { receivable: u, payment };
}

/**
 * Estorno de um recebimento (registro negativo; o original não é apagado). Corrige lançamento
 * que não deveria existir — distinto do reembolso. Confere a versão da cobrança.
 */
export async function reversePayment(
  tx: Tx,
  actor: ActorContext,
  paymentId: string,
  input: { reason: string; version: number },
) {
  const p = await tx.customerPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw Errors.notFound('Recebimento');
  const r = await lockReceivable(tx, p.receivableId);
  checkVersion(r, input.version);
  if (p.reversalOfId || p.refund || p.amountCents < 0)
    throw Errors.business('Um estorno ou reembolso não pode ser estornado.');
  if (await tx.customerPayment.findUnique({ where: { reversalOfId: p.id } }))
    throw Errors.conflict('Este recebimento já foi estornado.');
  const received = r.receivedCents - p.amountCents;
  if (received < 0)
    throw Errors.business(
      'Parte deste valor já foi reembolsada ao cliente: o estorno deixaria o recebido negativo.',
    );
  await tx.customerPayment.create({
    data: {
      receivableId: r.id,
      amountCents: -p.amountCents,
      receivedAt: parseDate(todayIso(await shopTimezone(tx))),
      method: p.method,
      note: `Estorno: ${input.reason}`.slice(0, 500),
      reversalOfId: p.id,
      createdById: actor.userId,
    },
  });
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
    summary: `${receivableCode(r.number)}: estorno de ${(p.amountCents / 100).toFixed(2)} — ${input.reason}`,
    changes: {
      receivedCents: { from: r.receivedCents, to: received },
      status: { from: r.status, to: u.status },
      reason: input.reason,
    },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: r.id,
    kind: 'ESTORNO',
    note: input.reason,
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
  const r = await lockReceivable(tx, id);
  if (r.status === 'CANCELADO') return r;
  checkVersion(r, input.version);
  if (r.receivedCents !== 0)
    throw Errors.business('Há recebimentos registrados: estorne-os antes de cancelar.');
  const u = await cancelReceivableRow(tx, actor, r, input.reason);
  return u;
}

async function cancelReceivableRow(
  tx: Tx,
  actor: ActorContext,
  r: { id: string; number: number },
  reason: string,
  kind = 'CANCELADA',
) {
  const u = await tx.customerReceivable.update({
    where: { id: r.id },
    data: {
      status: 'CANCELADO',
      cancelReason: reason.slice(0, 500),
      cancelledAt: new Date(),
      version: { increment: 1 },
    },
  });
  // Pagamento informado pela equipe e ainda pendente deixa de valer (registro preservado).
  await tx.customerPaymentReport.updateMany({
    where: { receivableId: r.id, status: 'PENDENTE' },
    data: {
      status: 'DESCARTADO',
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: `Cobrança cancelada: ${reason}`.slice(0, 500),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.receivable_cancelled',
    entityType: 'customer_receivable',
    entityId: r.id,
    summary: `${receivableCode(r.number)} cancelada: ${reason}`,
    changes: { status: { to: 'CANCELADO' }, reason },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: r.id,
    kind,
    note: reason,
    type: EVENT_TYPES.FINANCE_RECEIVABLE_CREATED,
    status: 'CANCELADO',
  });
  return u;
}

// ─────────────────────────── Reembolso (AM-7) ───────────────────────────

/**
 * Reembolso: dinheiro que entrou e saiu. Recebimentos negativos marcados `refund` (sem estorno
 * vinculado), na data real, distribuídos das cobranças mais recentes com recebido; a cobrança é
 * reduzida junto (o saldo não reaparece) e um ajuste comercial reduz o valor final. Nunca acima
 * do valor líquido recebido.
 */
export async function refundOrder(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  input: {
    amountCents: number;
    refundedAt: string;
    method: PaymentMethod;
    reason: string;
    itemValues?: ItemValueInput;
  },
  opts: { cancelling?: boolean } = {},
) {
  await lockOrder(tx, orderId);
  await lockOrderReceivables(tx, orderId);
  const order = await tx.commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  const today = todayIso(await shopTimezone(tx));
  if (input.refundedAt > today) throw Errors.business('A data do reembolso não pode ser futura.');
  const current = await orderRevenue(tx, orderId);
  if (input.amountCents > current.receivedCents)
    throw Errors.business(
      `O reembolso passa do valor líquido recebido (${formatCents(current.receivedCents)}).`,
    );
  const sources = [...current.receivables]
    .filter((r) => r.receivedCents > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let left = input.amountCents;
  for (const r of sources) {
    if (left <= 0) break;
    const t = Math.min(left, r.receivedCents);
    left -= t;
    await tx.customerPayment.create({
      data: {
        receivableId: r.id,
        amountCents: -t,
        receivedAt: parseDate(input.refundedAt),
        method: input.method,
        note: `Reembolso: ${input.reason}`.slice(0, 500),
        refund: true,
        createdById: actor.userId,
      },
    });
    const received = r.receivedCents - t;
    if (received === 0) {
      await tx.customerReceivable.update({
        where: { id: r.id },
        data: {
          receivedCents: 0,
          status: 'CANCELADO',
          cancelReason: `Reembolsada: ${input.reason}`.slice(0, 500),
          cancelledAt: new Date(),
          version: { increment: 1 },
        },
      });
    } else {
      const amount = r.amountCents - t;
      await tx.customerReceivable.update({
        where: { id: r.id },
        data: {
          amountCents: amount,
          receivedCents: received,
          status: receivableStatus(amount, received),
          version: { increment: 1 },
        },
      });
    }
    await audit(tx, actor, {
      action: 'finance.payment_refunded',
      entityType: 'customer_receivable',
      entityId: r.id,
      summary: `${receivableCode(r.number)}: reembolso de ${formatCents(t)} (${input.method}) — ${input.reason}`,
      changes: {
        refundedCents: t,
        receivedCents: { from: r.receivedCents, to: received },
        status: { from: r.status },
        method: input.method,
        reason: input.reason,
      },
    });
    await financeEvent(tx, actor, {
      entityType: 'customer_receivable',
      entityId: r.id,
      kind: 'REEMBOLSO',
      note: input.reason,
      data: { amountCents: t, method: input.method, refundedAt: input.refundedAt },
      type: EVENT_TYPES.FINANCE_PAYMENT_RECORDED,
      status: received === 0 ? 'CANCELADO' : receivableStatus(r.amountCents - t, received),
    });
  }
  const newFinal = Math.max(0, (current.finalCents ?? 0) - input.amountCents);
  await insertAdjustment(
    tx,
    actor,
    order,
    'AJUSTE',
    -input.amountCents,
    `Reembolso: ${input.reason}`,
  );
  if (!opts.cancelling)
    await applyItemValues(tx, actor, orderId, input.itemValues, newFinal, {
      required: true,
      reason: `reembolso — ${input.reason}`,
    });
  await financeEvent(tx, actor, {
    entityType: 'commercial_order',
    entityId: orderId,
    kind: 'REEMBOLSO',
    note: input.reason,
    data: { amountCents: input.amountCents, method: input.method, refundedAt: input.refundedAt },
  });
}

// ─────────────────────────── Cancelamento do pedido (AM-11) ───────────────────────────

/**
 * Finanças no cancelamento do pedido (mesma transação, pedido já bloqueado). Sem recebido:
 * cancela as cobranças abertas. Com valor líquido recebido: exige decisão explícita — reter
 * (valor comercial passa a ser o retido) e/ou reembolsar o restante. Nada é apagado.
 */
export async function cancelOrderFinance(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  reason: string,
  decision:
    | { retainedCents: number; refund?: { refundedAt: string; method: PaymentMethod } | null }
    | null
    | undefined,
) {
  await lockOrderReceivables(tx, orderId);
  const before = await orderRevenue(tx, orderId);
  const net = before.receivedCents;
  if (net > 0) {
    if (!decision)
      throw Errors.business(
        `Este pedido tem ${formatCents(net)} recebidos: informe se o valor será retido ou reembolsado.`,
        { receivedCents: net },
      );
    if (decision.retainedCents > net)
      throw Errors.business(`O valor retido não pode passar do recebido (${formatCents(net)}).`);
    const refund = net - decision.retainedCents;
    if (refund > 0) {
      if (!decision.refund)
        throw Errors.business(
          `Informe a data e a forma do reembolso de ${formatCents(refund)} (o restante do recebido).`,
        );
      await refundOrder(
        tx,
        actor,
        orderId,
        {
          amountCents: refund,
          refundedAt: decision.refund.refundedAt,
          method: decision.refund.method,
          reason: `Cancelamento do pedido: ${reason}`,
        },
        { cancelling: true },
      );
    }
    // Valor comercial passa a refletir o retido.
    const now = await orderRevenue(tx, orderId);
    const delta = decision.retainedCents - (now.finalCents ?? 0);
    if (delta !== 0)
      await insertAdjustment(
        tx,
        actor,
        before.order,
        'AJUSTE',
        delta,
        `Valor retido no cancelamento (${formatCents(decision.retainedCents)}): ${reason}`,
      );
  } else if (decision && decision.retainedCents > 0) {
    throw Errors.business('Não há valor recebido para reter.');
  }
  // Cobranças: as sem recebimento são canceladas; a parte em aberto das com recebimento é
  // encerrada (valor = recebido). Nenhuma cobrança fantasma fica aberta.
  const rows = await tx.customerReceivable.findMany({
    where: { orderId, status: { not: 'CANCELADO' } },
  });
  for (const r of rows) {
    if (r.receivedCents === 0)
      await cancelReceivableRow(
        tx,
        actor,
        r,
        `Pedido cancelado: ${reason}`,
        'CANCELADA_COM_PEDIDO',
      );
    else if (r.amountCents > r.receivedCents)
      await reduceReceivable(
        tx,
        actor,
        r,
        r.amountCents - r.receivedCents,
        `Pedido cancelado: ${reason}`,
      );
  }
  // Pagamentos informados pela equipe e ainda pendentes deixam de valer (registros preservados).
  await tx.customerPaymentReport.updateMany({
    where: { status: 'PENDENTE', receivable: { orderId } },
    data: {
      status: 'DESCARTADO',
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: `Pedido cancelado: ${reason}`.slice(0, 500),
      version: { increment: 1 },
    },
  });
  return { receivedCents: net, retainedCents: decision?.retainedCents ?? 0 };
}

// ─────────────────────────── Saldos (painel de entregas) ───────────────────────────

export async function orderBalances(db: Tx | PrismaClient, orderIds: string[]) {
  const ids = [...new Set(orderIds)];
  const ctx = await dueContext(db, ids);
  const out = [];
  for (const id of ids) {
    const r = await orderRevenue(db, id);
    let overdue = 0;
    let onDelivery = 0;
    for (const x of r.receivables) {
      const d = dueOf(x, ctx);
      if (d.overdue) overdue += d.openCents;
      if (x.dueTrigger === 'ENTREGA') onDelivery += d.openCents;
    }
    out.push({
      orderId: id,
      orderCode: orderCode(r.order.number),
      customerName: r.order.customer.name,
      finalCents: r.finalCents,
      receivedCents: r.receivedCents,
      openCents: Math.max(0, (r.finalCents ?? 0) - r.receivedCents),
      overdueCents: overdue,
      dueOnDeliveryCents: onDelivery,
    });
  }
  return out;
}
