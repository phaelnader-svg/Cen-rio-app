import {
  EVENT_TYPES,
  formatServiceOrderItemCode,
  laborDue,
  laborEligible,
  laborStatus,
  productionPayableCode,
  settlementProblem,
  type EligibilityRule,
  type LaborPayableDto,
  type LaborStatus,
  type MyProductionDto,
  type PaymentMethod,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { workers } from '../production/plans';
import { checkVersion, dateOnly, financeEvent, historyOf, lockRow, parseDate } from './common';

export const laborInclude = {
  professional: { select: { id: true, displayName: true } },
  serviceOrder: {
    select: {
      id: true,
      number: true,
      status: true,
      items: { select: { id: true, fulfillmentStage: true } },
    },
  },
  item: { select: { id: true, position: true, description: true, fulfillmentStage: true } },
  adjustments: {
    include: { authorizedBy: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  },
  payments: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.ProductionPayableInclude;
type LaborRow = Prisma.ProductionPayableGetPayload<{ include: typeof laborInclude }>;

/** Peças cobertas: a peça indicada ou todas as peças não devolvidas da OS. */
function coveredStages(p: LaborRow) {
  if (p.item) return [p.item.fulfillmentStage];
  return p.serviceOrder.items
    .map((i) => i.fulfillmentStage)
    .filter((s) => s !== 'DEVOLVIDA' && s !== 'CANCELADA');
}
/**
 * Elegível quando as peças atingem a condição. Uma vez atingida (eligibleAt), continua devida
 * (Fase 12): invalidação de aprovação, devolução ou cancelamento posteriores não "desfazem" um
 * valor já devido em silêncio — o gestor revisa e ajusta com justificativa.
 */
export const isEligible = (p: LaborRow) =>
  p.eligibleAt !== null || laborEligible(p.eligibility as EligibilityRule, coveredStages(p));

export async function toLaborDto(db: Tx | PrismaClient, p: LaborRow): Promise<LaborPayableDto> {
  const due = laborDue(p);
  return {
    id: p.id,
    number: p.number,
    code: productionPayableCode(p.number),
    professional: { userId: p.professional.id, displayName: p.professional.displayName },
    serviceOrder: { id: p.serviceOrder.id, code: serviceOrderCode(p.serviceOrder.number) },
    piece: p.item
      ? {
          id: p.item.id,
          code: formatServiceOrderItemCode(p.serviceOrder.number, p.item.position),
          description: p.item.description,
          stage: p.item.fulfillmentStage,
        }
      : null,
    service: p.service,
    agreedCents: p.agreedCents,
    adjustmentsCents: p.adjustmentsCents,
    dueCents: due,
    paidCents: p.paidCents,
    openCents: Math.max(0, due - p.paidCents),
    eligibility: p.eligibility as EligibilityRule,
    eligible: isEligible(p),
    status: p.status as LaborStatus,
    eligibleAt: p.eligibleAt?.toISOString() ?? null,
    notes: p.notes,
    withdrawn:
      p.status !== 'CANCELADO' &&
      (p.serviceOrder.status === 'CANCELADA' || p.item?.fulfillmentStage === 'DEVOLVIDA'),
    adjustments: p.adjustments.map((a) => ({
      id: a.id,
      amountCents: a.amountCents,
      reason: a.reason,
      authorizedBy: a.authorizedBy.displayName,
      createdAt: a.createdAt.toISOString(),
    })),
    payments: p.payments.map((x) => ({
      id: x.id,
      amountCents: x.amountCents,
      paidAt: dateOnly(x.paidAt)!,
      method: x.method as PaymentMethod,
      note: x.note,
      early: Boolean(x.earlyReason),
    })),
    history: await historyOf(db, 'production_payable', p.id),
    version: p.version,
  };
}

/**
 * Recalcula a situação (prevista → liberada quando a condição é atingida; nunca pela simples
 * conclusão de uma tarefa). Grava a mudança uma única vez, com histórico.
 */
export async function refreshLabor(tx: Tx, actor: ActorContext, id: string) {
  const p = await tx.productionPayable.findUniqueOrThrow({ where: { id }, include: laborInclude });
  const eligible = isEligible(p);
  const status = laborStatus({ ...p, eligible, cancelled: p.status === 'CANCELADO' });
  if (status === p.status) return p;
  const u = await tx.productionPayable.update({
    where: { id },
    data: {
      status,
      eligibleAt: eligible ? (p.eligibleAt ?? new Date()) : p.eligibleAt,
      version: { increment: 1 },
    },
    include: laborInclude,
  });
  if (status === 'LIBERADO')
    await financeEvent(tx, actor, {
      entityType: 'production_payable',
      entityId: id,
      kind: 'LIBERADO',
      note: `Condição atingida: ${p.eligibility}`,
      type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
      status,
    });
  return u;
}

export async function refreshLaborOf(
  tx: Tx,
  actor: ActorContext,
  where: Prisma.ProductionPayableWhereInput,
) {
  const rows = await tx.productionPayable.findMany({
    where: { ...where, status: { in: ['PREVISTO', 'LIBERADO'] } },
    select: { id: true },
  });
  for (const r of rows) await refreshLabor(tx, actor, r.id);
}

export async function createLabor(
  tx: Tx,
  actor: ActorContext,
  input: {
    professionalUserId: string;
    serviceOrderId: string;
    serviceOrderItemId?: string | null;
    service: string;
    agreedCents: number;
    eligibility: EligibilityRule;
    notes?: string | null;
  },
) {
  const worker = (await workers(tx)).find((w) => w.userId === input.professionalUserId);
  if (!worker?.isTapeceiro)
    throw Errors.business(
      'Pagamento por produção é só para o tapeceiro principal (equipe de remuneração fixa usa "Custos de equipe").',
    );
  await lockRow(tx, 'service_orders', input.serviceOrderId, 'Ordem de serviço');
  const so = await tx.serviceOrder.findUniqueOrThrow({
    where: { id: input.serviceOrderId },
    include: { items: true },
  });
  if (so.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
  if (input.serviceOrderItemId && !so.items.some((i) => i.id === input.serviceOrderItemId))
    throw Errors.business('A peça não pertence a esta OS.');
  const dup = await tx.productionPayable.findFirst({
    where: {
      serviceOrderId: so.id,
      serviceOrderItemId: input.serviceOrderItemId ?? null,
      status: { not: 'CANCELADO' },
    },
    include: { professional: { select: { displayName: true } } },
  });
  if (dup)
    throw Errors.conflict(
      `Já existe mão de obra combinada para esta ${input.serviceOrderItemId ? 'peça' : 'OS'} (${productionPayableCode(dup.number)}, ${dup.professional.displayName}). Cada peça tem um único tapeceiro principal.`,
    );
  if (!input.serviceOrderItemId) {
    const perPiece = await tx.productionPayable.count({
      where: {
        serviceOrderId: so.id,
        serviceOrderItemId: { not: null },
        status: { not: 'CANCELADO' },
      },
    });
    if (perPiece) throw Errors.conflict('Esta OS já tem valores por peça: lance por peça.');
  } else {
    const whole = await tx.productionPayable.count({
      where: { serviceOrderId: so.id, serviceOrderItemId: null, status: { not: 'CANCELADO' } },
    });
    if (whole) throw Errors.conflict('Esta OS já tem valor combinado para a OS inteira.');
  }
  const row = await tx.productionPayable.create({
    data: {
      professionalUserId: worker.userId,
      serviceOrderId: so.id,
      serviceOrderItemId: input.serviceOrderItemId ?? null,
      service: input.service,
      agreedCents: input.agreedCents,
      eligibility: input.eligibility,
      notes: input.notes ?? null,
      createdById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'finance.labor_created',
    entityType: 'production_payable',
    entityId: row.id,
    summary: `${productionPayableCode(row.number)}: ${worker.displayName}, ${serviceOrderCode(so.number)} — ${input.service}.`,
  });
  await financeEvent(tx, actor, {
    entityType: 'production_payable',
    entityId: row.id,
    kind: 'COMBINADO',
    note: `${worker.displayName}: ${input.service}`,
    data: { agreedCents: input.agreedCents, eligibility: input.eligibility },
    type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
    status: row.status,
  });
  await refreshLabor(tx, actor, row.id);
  return row;
}

export async function adjustLabor(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { amountCents: number; reason: string; version: number },
) {
  await lockRow(tx, 'production_payables', id, 'Mão de obra');
  const p = await tx.productionPayable.findUniqueOrThrow({ where: { id } });
  checkVersion(p, input.version);
  if (p.status === 'CANCELADO' || p.status === 'PAGO')
    throw Errors.business('Mão de obra encerrada não pode ser ajustada.');
  const next = p.adjustmentsCents + input.amountCents;
  if (p.agreedCents + next < p.paidCents)
    throw Errors.business('O valor devido não pode ficar abaixo do que já foi pago.');
  await tx.financialAdjustment.create({
    data: {
      productionPayableId: id,
      amountCents: input.amountCents,
      reason: input.reason,
      authorizedById: actor.userId!,
    },
  });
  await tx.productionPayable.update({
    where: { id },
    data: { adjustmentsCents: next, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'finance.labor_adjusted',
    entityType: 'production_payable',
    entityId: id,
    summary: `${productionPayableCode(p.number)}: ajuste de ${(input.amountCents / 100).toFixed(2)} — ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'production_payable',
    entityId: id,
    kind: 'AJUSTE',
    note: input.reason,
    data: { amountCents: input.amountCents },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return refreshLabor(tx, actor, id);
}

/**
 * Registra o pagamento (nenhuma transferência é feita). Antes da condição de elegibilidade só
 * com justificativa explícita; nunca acima do valor devido (impede pagamento em dobro).
 */
export async function payLabor(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: {
    amountCents: number;
    paidAt: string;
    method: PaymentMethod;
    note?: string | null;
    earlyReason?: string | null;
    version: number;
  },
) {
  await lockRow(tx, 'production_payables', id, 'Mão de obra');
  await refreshLabor(tx, actor, id);
  const p = await tx.productionPayable.findUniqueOrThrow({ where: { id }, include: laborInclude });
  checkVersion(p, input.version);
  if (p.status === 'CANCELADO') throw Errors.business('Mão de obra cancelada.');
  const eligible = isEligible(p);
  if (!eligible && !(input.earlyReason && input.earlyReason.length >= 3))
    throw Errors.business(
      'A condição para pagamento ainda não foi atingida. Para antecipar, informe a justificativa.',
    );
  const problem = settlementProblem(laborDue(p), p.paidCents, input.amountCents);
  if (problem) throw Errors.business(problem);
  await tx.professionalPayment.create({
    data: {
      productionPayableId: id,
      amountCents: input.amountCents,
      paidAt: parseDate(input.paidAt),
      method: input.method,
      note: input.note ?? null,
      earlyReason: eligible ? null : input.earlyReason!,
      createdById: actor.userId,
    },
  });
  const paid = p.paidCents + input.amountCents;
  await tx.productionPayable.update({
    where: { id },
    data: {
      paidCents: paid,
      status: laborStatus({ ...p, paidCents: paid, eligible, cancelled: false }),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.labor_paid',
    entityType: 'production_payable',
    entityId: id,
    summary: `${productionPayableCode(p.number)}: pagamento de ${(input.amountCents / 100).toFixed(2)} a ${p.professional.displayName}${eligible ? '' : ` (antecipado: ${input.earlyReason})`}.`,
  });
  await financeEvent(tx, actor, {
    entityType: 'production_payable',
    entityId: id,
    kind: eligible ? 'PAGAMENTO' : 'PAGAMENTO_ANTECIPADO',
    note: input.note ?? input.earlyReason ?? null,
    data: { amountCents: input.amountCents, method: input.method },
    type: EVENT_TYPES.FINANCE_PAYABLE_PAID,
  });
  return tx.productionPayable.findUniqueOrThrow({ where: { id } });
}

export async function cancelLabor(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  await lockRow(tx, 'production_payables', id, 'Mão de obra');
  const p = await tx.productionPayable.findUniqueOrThrow({ where: { id } });
  if (p.status === 'CANCELADO') return p;
  checkVersion(p, input.version);
  if (p.paidCents > 0) throw Errors.business('Há pagamentos registrados: não pode ser cancelada.');
  const u = await tx.productionPayable.update({
    where: { id },
    data: { status: 'CANCELADO', cancelReason: input.reason, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'finance.labor_cancelled',
    entityType: 'production_payable',
    entityId: id,
    summary: `${productionPayableCode(p.number)} cancelada: ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'production_payable',
    entityId: id,
    kind: 'CANCELADO',
    note: input.reason,
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return u;
}

/** Os próprios valores de produção (Ricardo, Márcio) — nunca os de outra pessoa. */
export async function myProduction(
  db: Tx | PrismaClient,
  userId: string,
): Promise<MyProductionDto> {
  const rows = await db.productionPayable.findMany({
    where: { professionalUserId: userId, status: { not: 'CANCELADO' } },
    include: laborInclude,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const items = rows.map((p) => {
    const eligible = isEligible(p);
    const status = laborStatus({ ...p, eligible, cancelled: false });
    return {
      id: p.id,
      code: productionPayableCode(p.number),
      serviceOrder: serviceOrderCode(p.serviceOrder.number),
      piece: p.item ? formatServiceOrderItemCode(p.serviceOrder.number, p.item.position) : null,
      service: p.service,
      dueCents: laborDue(p),
      paidCents: p.paidCents,
      status,
      eligibility: p.eligibility as EligibilityRule,
      payments: p.payments.map((x) => ({
        amountCents: x.amountCents,
        paidAt: dateOnly(x.paidAt)!,
      })),
    };
  });
  return {
    items,
    totals: {
      dueCents: items.reduce((a, i) => a + i.dueCents, 0),
      paidCents: items.reduce((a, i) => a + i.paidCents, 0),
      releasedOpenCents: items
        .filter((i) => i.status === 'LIBERADO' || i.status === 'PAGO_PARCIAL')
        .reduce((a, i) => a + i.dueCents - i.paidCents, 0),
      forecastCents: items
        .filter((i) => i.status === 'PREVISTO')
        .reduce((a, i) => a + i.dueCents, 0),
    },
  };
}
