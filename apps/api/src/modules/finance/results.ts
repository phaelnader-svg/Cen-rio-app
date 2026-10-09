import {
  EXPENSE_CATEGORIES,
  contributionMargin,
  laborDue,
  logisticsCostCode,
  managementResult,
  taskTimings,
  type ExpenseCategory,
  type FinanceDashboardDto,
  type LogisticsCostKind,
  type OrderResultDto,
  type ProductivityDto,
  type ProductivityRowDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { serviceOrderCode } from '../commercial/common';
import { workers } from '../production/plans';
import { dateOnly, parseDate, period, todayIso } from './common';
import { materialSummary, syncMaterialCosts } from './costs';
import { isEligible, laborInclude, refreshLaborOf, toLaborDto } from './labor';
import { serviceOrderRevenue } from './revenue';

export async function taxRate(db: Tx | PrismaClient) {
  return (await db.companySettings.findUnique({ where: { id: 1 } }))?.taxRateBps ?? null;
}

/**
 * Conclusão da OS: todas as peças ativas entregues. Data = última entrega registrada (ou, sem
 * registro de entrega, a última mudança de etapa das peças).
 */
export async function completion(db: Tx | PrismaClient, serviceOrderId: string) {
  const items = await db.serviceOrderItem.findMany({
    where: { serviceOrderId, fulfillmentStage: { notIn: ['DEVOLVIDA', 'CANCELADA'] } },
    select: { id: true, fulfillmentStage: true, updatedAt: true },
  });
  const delivered = items.length > 0 && items.every((i) => i.fulfillmentStage === 'ENTREGUE');
  if (!delivered) return { delivered: false, completedAt: null as Date | null };
  const last = await db.deliveryItem.aggregate({
    where: { serviceOrderItemId: { in: items.map((i) => i.id) }, deliveredAt: { not: null } },
    _max: { deliveredAt: true },
  });
  const fallback = new Date(Math.max(...items.map((i) => i.updatedAt.getTime())));
  return { delivered: true, completedAt: last._max.deliveredAt ?? fallback };
}

/**
 * Estimativa da equipe fixa alocada à OS: custo mensal × parcela do tempo de execução de cada
 * pessoa dedicado à OS no mês. Só existe quando há custo mensal e tempo registrado.
 */
async function fixedTeamEstimate(db: Tx | PrismaClient, serviceOrderId: string) {
  const costs = await db.teamMonthlyCost.findMany();
  if (!costs.length) return null;
  let total = 0;
  let any = false;
  for (const c of costs) {
    const start = c.month;
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const tasks = await db.productionTask.findMany({
      where: { assigneeUserId: c.userId, completedAt: { gte: start, lt: end } },
      include: { events: { select: { kind: true, createdAt: true } } },
    });
    const minutes = tasks.map((t) => ({
      so: t.serviceOrderId,
      m: taskTimings(t.events.map((e) => ({ kind: e.kind, at: e.createdAt }))).executionMinutes,
    }));
    const all = minutes.reduce((a, x) => a + x.m, 0);
    const mine = minutes.filter((x) => x.so === serviceOrderId).reduce((a, x) => a + x.m, 0);
    if (all > 0 && mine > 0) {
      any = true;
      total += Math.round((c.amountCents * mine) / all);
    }
  }
  return any ? total : null;
}

export async function orderResult(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
): Promise<OrderResultDto> {
  await syncMaterialCosts(tx, actor, serviceOrderId);
  await refreshLaborOf(tx, actor, { serviceOrderId });
  const so = await tx.serviceOrder.findUniqueOrThrow({
    where: { id: serviceOrderId },
    include: { customer: { select: { name: true } } },
  });
  const revenue = await serviceOrderRevenue(tx, serviceOrderId);
  const materials = await materialSummary(tx, serviceOrderId);
  const laborRows = await tx.productionPayable.findMany({
    where: { serviceOrderId, status: { not: 'CANCELADO' } },
    include: laborInclude,
  });
  const labor = await Promise.all(laborRows.map((p) => toLaborDto(tx, p)));
  const logistics = await tx.logisticsCostAllocation.findMany({
    where: { serviceOrderId, cost: { cancelledAt: null } },
    include: { cost: true },
  });
  const other = await tx.serviceOrderCost.aggregate({
    where: { serviceOrderId, category: 'OUTRO_VARIAVEL' },
    _sum: { amountCents: true },
  });
  const tax = await taxRate(tx);
  const logisticsCents = logistics.reduce((a, l) => a + l.amountCents, 0);
  const otherCents = other._sum.amountCents ?? 0;
  const laborForecast = laborRows.reduce((a, p) => a + laborDue(p), 0);
  const laborActual = laborRows
    .filter((p) => isEligible(p) || p.paidCents > 0)
    .reduce((a, p) => a + laborDue(p), 0);
  const col = (materialsCents: number, laborCents: number) => {
    const m = contributionMargin({
      revenueCents: revenue.revenueCents,
      materialsCents,
      laborCents,
      logisticsCents,
      otherVariableCents: otherCents,
      taxRateBps: tax,
    });
    return {
      materialsCents,
      laborCents,
      logisticsCents,
      taxCents: m.taxCents,
      otherVariableCents: otherCents,
      variableCostsCents: m.variableCostsCents,
      marginCents: m.marginCents,
      marginPct: m.marginPct,
    };
  };
  const c = await completion(tx, serviceOrderId);
  const warnings: string[] = [];
  if (!revenue.hasValue) warnings.push('O pedido não tem valor contratado: receita zerada.');
  if (tax === null) warnings.push('Alíquota de tributos estimados não configurada.');
  if (materials.unpricedLines || materials.forecastUnpriced)
    warnings.push(
      'Há materiais sem preço conhecido: o custo está subestimado até o gestor ajustar.',
    );
  if (!laborRows.length)
    warnings.push('Mão de obra por produção ainda não combinada para esta OS.');
  return {
    serviceOrderId,
    code: serviceOrderCode(so.number),
    customer: so.customer.name,
    status: so.status,
    delivered: c.delivered,
    completedAt: c.completedAt?.toISOString() ?? null,
    revenueCents: revenue.revenueCents,
    forecast: col(Math.max(materials.forecastCents, materials.consumedCents), laborForecast),
    actual: col(materials.consumedCents, laborActual),
    taxRateBps: tax,
    fixedTeamEstimateCents: await fixedTeamEstimate(tx, serviceOrderId),
    materials,
    labor,
    logistics: logistics.map((l) => ({
      id: l.cost.id,
      code: logisticsCostCode(l.cost.number),
      kind: l.cost.kind as LogisticsCostKind,
      description: l.cost.description,
      amountCents: l.amountCents,
      date: dateOnly(l.cost.date)!,
    })),
    warnings,
  };
}

/** Tipo de serviço predominante da OS (mais peças). */
export async function mainService(db: Tx | PrismaClient, serviceOrderId: string) {
  const items = await db.serviceOrderItem.findMany({ where: { serviceOrderId } });
  const m = new Map<string, number>();
  for (const i of items) m.set(i.serviceType, (m.get(i.serviceType) ?? 0) + i.quantity);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OUTRO';
}

export async function dashboard(
  tx: Tx,
  actor: ActorContext,
  q: { from?: string; to?: string },
): Promise<FinanceDashboardDto> {
  const p = period(q);
  const today = todayIso();
  // Competência: contratado no período.
  const orders = await tx.commercialOrder.findMany({
    where: { status: { not: 'CANCELADO' }, createdAt: { gte: p.fromTs, lt: p.toExclusive } },
    include: { adjustments: { select: { amountCents: true } } },
  });
  const contracted = orders.reduce(
    (a, o) =>
      a +
      (o.agreedValueCents === null
        ? 0
        : o.agreedValueCents + o.adjustments.reduce((s, x) => s + x.amountCents, 0)),
    0,
  );
  // OS: concluídas no período (margem realizada) e em andamento (estimativa).
  const sos = await tx.serviceOrder.findMany({ where: { status: 'ABERTA' }, select: { id: true } });
  let completedOrders = 0;
  let revenueCompleted = 0;
  let variableCosts = 0;
  let margin = 0;
  let inProgress = 0;
  let inProgressRevenue = 0;
  let inProgressMargin = 0;
  const services = new Map<string, { orders: number; revenueCents: number; marginCents: number }>();
  for (const s of sos) {
    const r = await orderResult(tx, actor, s.id);
    const done =
      r.completedAt &&
      r.completedAt >= p.fromTs.toISOString() &&
      r.completedAt < p.toExclusive.toISOString();
    if (r.delivered && done) {
      completedOrders += 1;
      revenueCompleted += r.revenueCents;
      variableCosts += r.actual.variableCostsCents;
      margin += r.actual.marginCents;
      const st = await mainService(tx, s.id);
      const cur = services.get(st) ?? { orders: 0, revenueCents: 0, marginCents: 0 };
      services.set(st, {
        orders: cur.orders + 1,
        revenueCents: cur.revenueCents + r.revenueCents,
        marginCents: cur.marginCents + r.actual.marginCents,
      });
    } else if (!r.delivered) {
      inProgress += 1;
      inProgressRevenue += r.revenueCents;
      inProgressMargin += r.forecast.marginCents;
    }
  }
  const expenses = await tx.operationalExpense.findMany({
    where: {
      cancelledAt: null,
      competence: { gte: parseDate(`${p.from.slice(0, 7)}-01`), lte: p.toDate },
    },
  });
  const expensesCents = expenses.reduce((a, e) => a + e.amountCents, 0);
  const team = await tx.teamMonthlyCost.aggregate({
    where: { month: { gte: parseDate(`${p.from.slice(0, 7)}-01`), lte: p.toDate } },
    _sum: { amountCents: true },
  });
  const fixedTeam = team._sum.amountCents ?? 0;
  // Caixa.
  const received = await tx.customerPayment.aggregate({
    where: { receivedAt: { gte: p.fromDate, lte: p.toDate } },
    _sum: { amountCents: true },
  });
  const paidPayables = await tx.payablePayment.aggregate({
    where: { paidAt: { gte: p.fromDate, lte: p.toDate } },
    _sum: { amountCents: true },
  });
  const paidLabor = await tx.professionalPayment.aggregate({
    where: { paidAt: { gte: p.fromDate, lte: p.toDate } },
    _sum: { amountCents: true },
  });
  // Saldos.
  const recv = await tx.customerReceivable.findMany({
    where: { status: { in: ['ABERTO', 'PARCIAL'] } },
  });
  const pays = await tx.accountPayable.findMany({
    where: { status: { in: ['ABERTO', 'PARCIAL'] } },
  });
  await refreshLaborOf(tx, actor, {});
  const labor = await tx.productionPayable.findMany({
    where: { status: { in: ['PREVISTO', 'LIBERADO', 'PAGO_PARCIAL'] } },
  });
  const receivableOpen = recv.reduce((a, r) => a + r.amountCents - r.receivedCents, 0);
  const receivableOverdue = recv
    .filter((r) => dateOnly(r.dueDate)! < today)
    .reduce((a, r) => a + r.amountCents - r.receivedCents, 0);
  const payableOpen = pays.reduce((a, r) => a + r.amountCents - r.paidCents, 0);
  const payableOverdue = pays
    .filter((r) => dateOnly(r.dueDate)! < today)
    .reduce((a, r) => a + r.amountCents - r.paidCents, 0);
  const receivedCents = received._sum.amountCents ?? 0;
  const paidPayablesCents = paidPayables._sum.amountCents ?? 0;
  const paidLaborCents = paidLabor._sum.amountCents ?? 0;
  const byCat = new Map<string, number>();
  for (const e of expenses) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amountCents);
  return {
    from: p.from,
    to: p.to,
    accrual: {
      contractedCents: contracted,
      contractedOrders: orders.length,
      completedOrders,
      revenueCompletedCents: revenueCompleted,
      variableCostsCents: variableCosts,
      contributionMarginCents: margin,
      operationalExpensesCents: expensesCents,
      fixedTeamCents: fixedTeam,
      managementResultCents: managementResult({
        contributionMarginCents: margin,
        operationalExpensesCents: expensesCents,
        fixedTeamCents: fixedTeam,
      }),
    },
    cash: {
      receivedCents,
      paidPayablesCents,
      paidLaborCents,
      netCents: receivedCents - paidPayablesCents - paidLaborCents,
    },
    open: {
      receivableCents: receivableOpen,
      receivableOverdueCents: receivableOverdue,
      payableCents: payableOpen,
      payableOverdueCents: payableOverdue,
      laborReleasedCents: labor
        .filter((l) => l.status !== 'PREVISTO')
        .reduce((a, l) => a + laborDue(l) - l.paidCents, 0),
      laborForecastCents: labor
        .filter((l) => l.status === 'PREVISTO')
        .reduce((a, l) => a + laborDue(l), 0),
    },
    inProgress: {
      orders: inProgress,
      revenueCents: inProgressRevenue,
      estimatedMarginCents: inProgressMargin,
    },
    expensesByCategory: EXPENSE_CATEGORIES.filter((c) => byCat.has(c)).map((c) => ({
      category: c as ExpenseCategory,
      amountCents: byCat.get(c)!,
    })),
    topServices: [...services.entries()]
      .map(([serviceType, v]) => ({ serviceType, ...v }))
      .sort((a, b) => b.marginCents - a.marginCents),
    notes: [
      'Competência: contratado pela data do pedido; margem das OS concluídas (todas as peças entregues) no período; despesas pelo mês de competência.',
      'Caixa: recebimentos e pagamentos registrados no período (estornos descontados).',
      'Margem de contribuição não é lucro líquido; o resultado gerencial é uma estimativa (tributos estimados, custos sem preço não entram).',
    ],
  };
}

// ─────────────────────────── Produtividade ───────────────────────────

/**
 * Indicadores por pessoa no período (tarefas concluídas no período). Não há ranking: os números
 * descrevem o trabalho e separam atrasos com impedimento externo (ocorrência ou pausa por
 * impedimento) dos demais.
 */
export async function productivity(
  db: Tx | PrismaClient,
  q: { from?: string; to?: string },
): Promise<ProductivityDto> {
  const p = period(q);
  const rows: ProductivityRowDto[] = [];
  for (const w of await workers(db)) {
    const tasks = await db.productionTask.findMany({
      where: {
        assigneeUserId: w.userId,
        status: 'CONCLUIDA',
        completedAt: { gte: p.fromTs, lt: p.toExclusive },
      },
      include: {
        events: { select: { kind: true, createdAt: true } },
        issues: { select: { id: true } },
      },
    });
    let exec = 0;
    let waiting = 0;
    let waitingCount = 0;
    let withDue = 0;
    let onTime = 0;
    let late = 0;
    let lateImp = 0;
    let impediments = 0;
    for (const t of tasks) {
      const tm = taskTimings(t.events.map((e) => ({ kind: e.kind, at: e.createdAt })));
      exec += tm.executionMinutes;
      if (tm.waitingMinutes !== null) {
        waiting += tm.waitingMinutes;
        waitingCount += 1;
      }
      const impPauses = await db.productionTaskEvent.count({
        where: { taskId: t.id, kind: 'PAUSADA', changes: { path: ['impediment'], equals: true } },
      });
      if (impPauses || t.issues.length) impediments += 1;
      // Prazo: data-limite da tarefa ou, sem ela, o dia em que foi programada.
      const deadline = t.dueDate
        ? dateOnly(t.dueDate)!
        : t.scheduledAt
          ? dateOnly(new Date(t.scheduledAt.getTime() - 3 * 3_600_000))!
          : null;
      if (deadline) {
        withDue += 1;
        const doneDay = dateOnly(new Date(t.completedAt!.getTime() - 3 * 3_600_000))!;
        if (doneDay <= deadline) onTime += 1;
        else {
          late += 1;
          if (t.issues.length || impPauses) lateImp += 1;
        }
      }
    }
    const issuesReported = await db.productionIssue.count({
      where: { reporterUserId: w.userId, createdAt: { gte: p.fromTs, lt: p.toExclusive } },
    });
    const main = tasks.filter((t) => !t.supportForTaskId && t.activity !== 'CORRECAO');
    const rejectedPieces = await db.qualityInspection.count({
      where: {
        status: 'REPROVADA',
        decidedAt: { gte: p.fromTs, lt: p.toExclusive },
        serviceOrderItem: {
          productionTasks: { some: { assigneeUserId: w.userId, role: 'PRINCIPAL' } },
        },
      },
    });
    rows.push({
      userId: w.userId,
      displayName: w.displayName,
      tasksCompleted: main.length,
      supportTasks: tasks.filter((t) => t.supportForTaskId).length,
      reworkTasks: tasks.filter((t) => t.activity === 'CORRECAO').length,
      executionMinutes: exec,
      avgExecutionMinutes: tasks.length ? Math.round(exec / tasks.length) : null,
      waitingMinutes: waiting,
      avgWaitingMinutes: waitingCount ? Math.round(waiting / waitingCount) : null,
      withDueDate: withDue,
      onTime,
      late,
      lateWithImpediment: lateImp,
      impediments,
      issuesReported,
      onTimePct: withDue ? Math.round((onTime / withDue) * 1000) / 10 : null,
      rejectedPieces,
    });
  }
  return {
    from: p.from,
    to: p.to,
    rows,
    notes: [
      'Indicadores descritivos, sem ranking: compare sempre com o tipo de tarefa, os apoios prestados e os impedimentos.',
      'Atrasos com impedimento externo (ocorrência registrada ou pausa por impedimento) aparecem separados.',
      'Tempo de execução exclui as pausas; espera = da liberação ao início. Prazo = data-limite da tarefa ou o dia programado.',
    ],
  };
}
