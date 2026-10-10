import {
  EXPENSE_CATEGORY_LABEL,
  LABOR_STATUS_LABEL,
  ALL_LOGISTICS_COST_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  SERVICE_TYPE_LABEL,
  csvMoney,
  expenseCode,
  formatServiceOrderItemCode,
  laborDue,
  productionPayableCode,
  receivableCode,
  type ExpenseCategory,
  type LaborStatus,
  type LogisticsCostKind,
  type PaymentMethod,
  type ServiceType,
} from '@cenario/shared';
import type { Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { orderCode, serviceOrderCode } from '../commercial/common';
import { dateOnly, parseDate, period, shopTimezone } from './common';
import { dashboard, orderResult, productivity } from './results';

/** Relatório tabular: mesmas linhas em JSON (tela) e CSV (exportação). */
export interface Report {
  title: string;
  header: string[];
  rows: (string | number | null)[][];
  notes: string[];
}

export const REPORTS = [
  'resultado-os',
  'receita',
  'custos',
  'producao',
  'despesas',
  'margens',
  'produtividade',
  'retrabalhos',
  'servicos-rentaveis',
] as const;
export type ReportKind = (typeof REPORTS)[number];

const pct = (v: number | null) => (v === null ? '' : String(v).replace('.', ','));
const ESTIMATE = 'Margem de contribuição não é lucro líquido; tributos são estimativas.';

/** OS concluídas no período (todas as peças entregues) ou ainda em andamento. */
async function resultsInPeriod(tx: Tx, actor: ActorContext, q: { from?: string; to?: string }) {
  const p = period(q, await shopTimezone(tx));
  const sos = await tx.serviceOrder.findMany({
    where: { status: 'ABERTA', createdAt: { lt: p.toExclusive } },
    orderBy: { number: 'asc' },
    select: { id: true },
  });
  const out = [];
  for (const s of sos) {
    const r = await orderResult(tx, actor, s.id);
    const done =
      r.completedAt !== null &&
      r.completedAt >= p.fromTs.toISOString() &&
      r.completedAt < p.toExclusive.toISOString();
    if (done || !r.delivered) out.push({ r, done });
  }
  return out;
}

export async function buildReport(
  tx: Tx,
  actor: ActorContext,
  kind: ReportKind,
  q: { from?: string; to?: string },
): Promise<Report> {
  const p = period(q, await shopTimezone(tx));
  switch (kind) {
    case 'resultado-os': {
      const rows = await resultsInPeriod(tx, actor, q);
      return {
        title: 'Resultado por OS',
        header: [
          'OS',
          'Cliente',
          'Situação',
          'Concluída em',
          'Receita',
          'Materiais (realizado)',
          'Mão de obra (realizado)',
          'Logística',
          'Tributos estimados',
          'Outros variáveis',
          'Margem de contribuição (realizado)',
          'Margem % (realizado)',
          'Materiais (previsto)',
          'Mão de obra (previsto)',
          'Margem de contribuição (prevista)',
          'Avisos',
        ],
        rows: rows.map(({ r }) => [
          r.code,
          r.customer,
          r.delivered ? 'Concluída' : 'Em andamento',
          r.completedAt ? r.completedAt.slice(0, 10) : '',
          csvMoney(r.revenueCents),
          csvMoney(r.actual.materialsCents),
          csvMoney(r.actual.laborCents),
          csvMoney(r.actual.logisticsCents),
          csvMoney(r.actual.taxCents),
          csvMoney(r.actual.otherVariableCents),
          csvMoney(r.actual.marginCents),
          pct(r.actual.marginPct),
          csvMoney(r.forecast.materialsCents),
          csvMoney(r.forecast.laborCents),
          csvMoney(r.forecast.marginCents),
          r.warnings.join(' | '),
        ]),
        notes: [
          'OS concluídas no período (todas as peças entregues) e OS em andamento.',
          'Realizado: custos registrados; previsto: necessidades aprovadas e valores combinados.',
          ESTIMATE,
        ],
      };
    }
    case 'margens': {
      const rows = (await resultsInPeriod(tx, actor, q)).filter((x) => x.done);
      return {
        title: 'Margens das OS concluídas',
        header: [
          'OS',
          'Cliente',
          'Concluída em',
          'Receita',
          'Custos variáveis',
          'Margem',
          'Margem %',
        ],
        rows: rows.map(({ r }) => [
          r.code,
          r.customer,
          r.completedAt!.slice(0, 10),
          csvMoney(r.revenueCents),
          csvMoney(r.actual.variableCostsCents),
          csvMoney(r.actual.marginCents),
          pct(r.actual.marginPct),
        ]),
        notes: [ESTIMATE],
      };
    }
    case 'receita': {
      const payments = await tx.customerPayment.findMany({
        where: { receivedAt: { gte: p.fromDate, lte: p.toDate } },
        include: {
          receivable: {
            include: { customer: { select: { name: true } }, order: { select: { number: true } } },
          },
        },
        orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      });
      return {
        title: 'Receita recebida no período (caixa)',
        header: ['Data', 'Conta a receber', 'Cliente', 'Pedido', 'Forma', 'Valor', 'Observação'],
        rows: payments.map((x) => [
          dateOnly(x.receivedAt),
          receivableCode(x.receivable.number),
          x.receivable.customer.name,
          orderCode(x.receivable.order.number),
          PAYMENT_METHOD_LABEL[x.method as PaymentMethod] ?? x.method,
          csvMoney(x.amountCents),
          x.reversalOfId ? `Estorno${x.note ? `: ${x.note}` : ''}` : (x.note ?? ''),
        ]),
        notes: ['Estornos aparecem como valores negativos.'],
      };
    }
    case 'custos': {
      const ledger = await tx.serviceOrderCost.groupBy({
        by: ['category', 'source'],
        where: { occurredAt: { gte: p.fromTs, lt: p.toExclusive } },
        _sum: { amountCents: true },
        _count: true,
      });
      const logistics = await tx.logisticsCost.groupBy({
        by: ['kind'],
        // Evolução Fase 6: combinado no agendamento (PREVISTO) ainda não é custo.
        where: {
          cancelledAt: null,
          status: { not: 'PREVISTO' },
          date: { gte: p.fromDate, lte: p.toDate },
        },
        _sum: { amountCents: true, adjustmentsCents: true },
        _count: true,
      });
      const labor = await tx.productionPayable.findMany({
        where: { status: { not: 'CANCELADO' }, eligibleAt: { gte: p.fromTs, lt: p.toExclusive } },
      });
      const expenses = await tx.operationalExpense.groupBy({
        by: ['category'],
        where: {
          cancelledAt: null,
          competence: { gte: parseDate(`${p.from.slice(0, 7)}-01`), lte: p.toDate },
        },
        _sum: { amountCents: true },
        _count: true,
      });
      const team = await tx.teamMonthlyCost.aggregate({
        where: { month: { gte: parseDate(`${p.from.slice(0, 7)}-01`), lte: p.toDate } },
        _sum: { amountCents: true },
        _count: true,
      });
      return {
        title: 'Custos por categoria',
        header: ['Grupo', 'Categoria', 'Lançamentos', 'Valor'],
        rows: [
          ...ledger.map((l) => [
            l.category === 'MATERIAL' ? 'Material (OS)' : 'Outros variáveis (OS)',
            l.source,
            l._count,
            csvMoney(l._sum.amountCents ?? 0),
          ]),
          ...(labor.length
            ? [
                [
                  'Mão de obra por produção',
                  'Liberada no período',
                  labor.length,
                  csvMoney(labor.reduce((a, l) => a + laborDue(l), 0)),
                ],
              ]
            : []),
          ...logistics.map((l) => [
            'Logística',
            ALL_LOGISTICS_COST_KIND_LABEL[l.kind as LogisticsCostKind] ?? l.kind,
            l._count,
            csvMoney((l._sum.amountCents ?? 0) + (l._sum.adjustmentsCents ?? 0)),
          ]),
          ...expenses.map((e) => [
            'Despesa operacional',
            EXPENSE_CATEGORY_LABEL[e.category as ExpenseCategory] ?? e.category,
            e._count,
            csvMoney(e._sum.amountCents ?? 0),
          ]),
          ...(team._count
            ? [['Equipe fixa', 'Custo mensal', team._count, csvMoney(team._sum.amountCents ?? 0)]]
            : []),
        ],
        notes: [
          'Material: lançamentos da razão de custos da OS (compras exclusivas recebidas, saídas de estoque, devoluções e sobras).',
          'Compra de estoque comum não é custo de OS até sair para a OS.',
        ],
      };
    }
    case 'producao': {
      const rows = await tx.productionPayable.findMany({
        where: { createdAt: { lt: p.toExclusive } },
        include: {
          professional: { select: { displayName: true } },
          serviceOrder: { select: { number: true } },
          item: { select: { position: true, description: true } },
          payments: true,
        },
        orderBy: { number: 'asc' },
      });
      return {
        title: 'Pagamentos por produção',
        header: [
          'Código',
          'Profissional',
          'OS',
          'Peça',
          'Serviço',
          'Valor devido',
          'Pago no período',
          'Pago total',
          'Situação',
        ],
        rows: rows.map((r) => [
          productionPayableCode(r.number),
          r.professional.displayName,
          serviceOrderCode(r.serviceOrder.number),
          r.item
            ? `${formatServiceOrderItemCode(r.serviceOrder.number, r.item.position)} ${r.item.description}`
            : 'OS inteira',
          r.service,
          csvMoney(laborDue(r)),
          csvMoney(
            r.payments
              .filter((x) => x.paidAt >= p.fromDate && x.paidAt <= p.toDate)
              .reduce((a, x) => a + x.amountCents, 0),
          ),
          csvMoney(r.paidCents),
          LABOR_STATUS_LABEL[r.status as LaborStatus] ?? r.status,
        ]),
        notes: ['Valores por produção (tapeceiros). Salários da equipe fixa não entram aqui.'],
      };
    }
    case 'despesas': {
      const rows = await tx.operationalExpense.findMany({
        where: {
          cancelledAt: null,
          competence: { gte: parseDate(`${p.from.slice(0, 7)}-01`), lte: p.toDate },
        },
        include: { payable: true },
        orderBy: [{ competence: 'asc' }, { number: 'asc' }],
      });
      return {
        title: 'Despesas operacionais',
        header: [
          'Código',
          'Competência',
          'Categoria',
          'Descrição',
          'Recorrente',
          'Valor',
          'Vencimento',
          'Situação',
        ],
        rows: rows.map((e) => [
          expenseCode(e.number),
          dateOnly(e.competence)!.slice(0, 7),
          EXPENSE_CATEGORY_LABEL[e.category as ExpenseCategory] ?? e.category,
          e.description,
          e.recurringId ? 'Sim' : 'Não',
          csvMoney(e.amountCents),
          dateOnly(e.payable?.dueDate ?? null) ?? '',
          e.payable?.status ?? '',
        ]),
        notes: ['Despesas pelo mês de competência.'],
      };
    }
    case 'produtividade': {
      const d = await productivity(tx, q);
      return {
        title: 'Produtividade por funcionário',
        header: [
          'Funcionário',
          'Tarefas concluídas',
          'Apoios',
          'Retrabalhos',
          'Execução (min)',
          'Execução média (min)',
          'Espera média (min)',
          'Com prazo',
          'No prazo',
          'Atrasadas',
          'Atrasadas com impedimento',
          'Impedimentos',
          'Ocorrências registradas',
          'Peças reprovadas',
        ],
        rows: d.rows.map((r) => [
          r.displayName,
          r.tasksCompleted,
          r.supportTasks,
          r.reworkTasks,
          r.executionMinutes,
          r.avgExecutionMinutes,
          r.avgWaitingMinutes,
          r.withDueDate,
          r.onTime,
          r.late,
          r.lateWithImpediment,
          r.impediments,
          r.issuesReported,
          r.rejectedPieces,
        ]),
        notes: d.notes,
      };
    }
    case 'retrabalhos': {
      const rejected = await tx.qualityInspection.findMany({
        where: { status: 'REPROVADA', decidedAt: { gte: p.fromTs, lt: p.toExclusive } },
        include: {
          serviceOrder: { select: { number: true } },
          serviceOrderItem: { select: { position: true, description: true } },
          tasks: {
            where: { activity: 'CORRECAO' },
            include: { assignee: { select: { displayName: true } } },
          },
        },
        orderBy: { decidedAt: 'asc' },
      });
      return {
        title: 'Retrabalhos (reprovações e correções)',
        header: [
          'Data',
          'OS',
          'Peça',
          'Rodada',
          'Motivo',
          'Correção',
          'Responsável',
          'Situação da correção',
        ],
        rows: rejected.map((i) => {
          const t = i.tasks[0];
          return [
            dateOnly(i.decidedAt),
            serviceOrderCode(i.serviceOrder.number),
            `${formatServiceOrderItemCode(i.serviceOrder.number, i.serviceOrderItem.position)} ${i.serviceOrderItem.description}`,
            i.round,
            i.decisionNote ?? '',
            t?.title ?? '',
            t?.assignee?.displayName ?? '',
            t?.status ?? '',
          ];
        }),
        notes: [
          'Retrabalho é consequência de reprovação na inspeção final; não é métrica isolada de desempenho.',
        ],
      };
    }
    case 'servicos-rentaveis': {
      const d = await dashboard(tx, actor, q);
      return {
        title: 'Serviços mais rentáveis (OS concluídas no período)',
        header: ['Serviço', 'OS', 'Receita', 'Margem de contribuição', 'Margem média por OS'],
        rows: d.topServices.map((s) => [
          SERVICE_TYPE_LABEL[s.serviceType as ServiceType] ?? s.serviceType,
          s.orders,
          csvMoney(s.revenueCents),
          csvMoney(s.marginCents),
          csvMoney(Math.round(s.marginCents / s.orders)),
        ]),
        notes: ['Serviço predominante da OS (maior quantidade de peças).', ESTIMATE],
      };
    }
    default:
      throw Errors.notFound('Relatório');
  }
}
