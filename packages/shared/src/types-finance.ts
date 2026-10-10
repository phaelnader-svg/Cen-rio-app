import type { OrderServiceState } from './domain';
import type {
  AdjustmentKind,
  EligibilityRule,
  ExpenseCategory,
  FinancialStatus,
  LaborSituation,
  LaborStatus,
  LogisticsCostKind,
  PayableCategory,
  PayableStatus,
  PaymentMethod,
  ReceivableStatus,
  SplitMethod,
} from './finance-domain';

export interface FinanceEventDto {
  id: string;
  kind: string;
  note: string | null;
  actor: string | null;
  createdAt: string;
}

export interface OrderRevenueDto {
  orderId: string;
  /** Fase 12: situação do serviço; devolução não altera o valor negociado sem ajuste. */
  serviceState: OrderServiceState;
  returnedPieces: number;
  orderCode: string;
  customer: { id: string; name: string };
  contractedCents: number | null;
  adjustmentsCents: number;
  finalCents: number | null;
  billedCents: number;
  receivedCents: number;
  openCents: number;
  financialStatus: FinancialStatus;
  adjustments: {
    id: string;
    kind: AdjustmentKind;
    amountCents: number;
    reason: string;
    authorizedBy: string;
    createdAt: string;
  }[];
  serviceOrders: { id: string; code: string; revenueCents: number; manual: boolean }[];
}

export interface CustomerPaymentDto {
  id: string;
  amountCents: number;
  receivedAt: string;
  method: PaymentMethod;
  note: string | null;
  reversalOfId: string | null;
  reversed: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface ReceivableDto {
  id: string;
  number: number;
  code: string;
  customer: { id: string; name: string };
  order: { id: string; code: string };
  serviceOrder: { id: string; code: string } | null;
  description: string;
  amountCents: number;
  receivedCents: number;
  openCents: number;
  dueDate: string;
  overdue: boolean;
  expectedMethod: PaymentMethod;
  status: ReceivableStatus;
  notes: string | null;
  cancelReason: string | null;
  payments: CustomerPaymentDto[];
  history: FinanceEventDto[];
  version: number;
}

export interface PayablePaymentDto {
  id: string;
  amountCents: number;
  paidAt: string;
  method: PaymentMethod;
  note: string | null;
  createdBy: string | null;
}

export interface PayableDto {
  id: string;
  number: number;
  code: string;
  beneficiary: string;
  supplier: { id: string; name: string } | null;
  category: PayableCategory;
  description: string;
  amountCents: number;
  paidCents: number;
  openCents: number;
  dueDate: string;
  overdue: boolean;
  status: PayableStatus;
  notes: string | null;
  origin: { kind: 'DESPESA' | 'LOGISTICA'; id: string; code: string } | null;
  payments: PayablePaymentDto[];
  history: FinanceEventDto[];
  attachments: number;
  version: number;
}

export interface LaborPayableDto {
  id: string;
  number: number;
  code: string;
  professional: { userId: string; displayName: string };
  serviceOrder: { id: string; code: string };
  piece: { id: string; code: string; description: string; stage: string } | null;
  service: string;
  agreedCents: number;
  adjustmentsCents: number;
  dueCents: number;
  paidCents: number;
  openCents: number;
  eligibility: EligibilityRule;
  eligible: boolean;
  status: LaborStatus;
  eligibleAt: string | null;
  notes: string | null;
  /** Fase 12: peça devolvida ou OS cancelada com valor ainda ativo — revisar. */
  withdrawn: boolean;
  /** Evolução Fase 5: situação exibida e revisão financeira aberta no escopo. */
  situation: LaborSituation;
  review: { id: string; code: string } | null;
  /** Mão de obra da OS inteira com peças de titulares diferentes: ratear exige revisão. */
  needsPieceReview: boolean;
  adjustments: {
    id: string;
    amountCents: number;
    reason: string;
    authorizedBy: string;
    createdAt: string;
  }[];
  payments: {
    id: string;
    amountCents: number;
    paidAt: string;
    method: PaymentMethod;
    note: string | null;
    early: boolean;
  }[];
  history: FinanceEventDto[];
  version: number;
}

export interface MaterialCostLineDto {
  id: string;
  source: string;
  description: string;
  quantity: number | null;
  unitCostCents: number | null;
  amountCents: number;
  priced: boolean;
  occurredAt: string;
  note: string | null;
}

export interface MaterialCostSummaryDto {
  /** Necessidades aprovadas × preço conhecido (estimativa). */
  forecastCents: number;
  forecastUnpriced: number;
  /** Compras exclusivas da OS (pedido confirmado), recebidas ou não. */
  purchasedCents: number;
  /** Reservas ativas de estoque comum ao custo médio atual. */
  reservedCents: number;
  /** Destinado/consumido: razão de custos (compras exclusivas recebidas, saídas, sobras). */
  consumedCents: number;
  unpricedLines: number;
  lines: MaterialCostLineDto[];
}

export interface OrderResultDto {
  serviceOrderId: string;
  code: string;
  customer: string;
  status: string;
  delivered: boolean;
  completedAt: string | null;
  revenueCents: number;
  /** Previsto (estimado) × realizado (registrado). */
  forecast: ResultColumns;
  actual: ResultColumns;
  taxRateBps: number | null;
  /** Equipe de remuneração fixa alocada por tempo (estimativa, fora da margem de contribuição). */
  fixedTeamEstimateCents: number | null;
  materials: MaterialCostSummaryDto;
  labor: LaborPayableDto[];
  logistics: {
    id: string;
    code: string;
    kind: LogisticsCostKind;
    description: string;
    amountCents: number;
    date: string;
  }[];
  warnings: string[];
}

export interface ResultColumns {
  materialsCents: number;
  laborCents: number;
  logisticsCents: number;
  taxCents: number;
  otherVariableCents: number;
  variableCostsCents: number;
  marginCents: number;
  marginPct: number | null;
}

export interface TeamCostDto {
  id: string;
  user: { userId: string; displayName: string };
  month: string;
  amountCents: number;
  notes: string | null;
  version: number;
}

export interface LogisticsCostDto {
  id: string;
  number: number;
  code: string;
  kind: LogisticsCostKind;
  description: string;
  amountCents: number;
  date: string;
  delivery: { id: string; code: string } | null;
  pickup: { id: string; code: string } | null;
  beneficiary: string | null;
  splitMethod: SplitMethod;
  splitNote: string | null;
  allocations: { serviceOrderId: string; code: string; amountCents: number }[];
  payable: { id: string; code: string; status: PayableStatus } | null;
  cancelled: boolean;
  cancelReason: string | null;
  version: number;
}

export interface ExpenseDto {
  id: string;
  number: number;
  code: string;
  category: ExpenseCategory;
  description: string;
  amountCents: number;
  competence: string;
  recurring: boolean;
  payable: { id: string; code: string; status: PayableStatus; dueDate: string } | null;
  cancelled: boolean;
  version: number;
}

export interface RecurringExpenseDto {
  id: string;
  category: ExpenseCategory;
  description: string;
  amountCents: number;
  dayOfMonth: number;
  beneficiary: string | null;
  startMonth: string;
  endMonth: string | null;
  active: boolean;
  version: number;
}

export interface FinanceDashboardDto {
  from: string;
  to: string;
  /** Competência: contratado no período, custos e margens das OS concluídas, despesas do mês. */
  accrual: {
    contractedCents: number;
    contractedOrders: number;
    completedOrders: number;
    revenueCompletedCents: number;
    variableCostsCents: number;
    contributionMarginCents: number;
    operationalExpensesCents: number;
    fixedTeamCents: number;
    managementResultCents: number;
  };
  /** Caixa: o que entrou e saiu de fato no período. */
  cash: {
    receivedCents: number;
    paidPayablesCents: number;
    paidLaborCents: number;
    netCents: number;
  };
  /** Saldos na data de hoje. */
  open: {
    receivableCents: number;
    receivableOverdueCents: number;
    payableCents: number;
    payableOverdueCents: number;
    laborReleasedCents: number;
    laborForecastCents: number;
  };
  inProgress: { orders: number; revenueCents: number; estimatedMarginCents: number };
  expensesByCategory: { category: ExpenseCategory; amountCents: number }[];
  topServices: { serviceType: string; orders: number; revenueCents: number; marginCents: number }[];
  notes: string[];
}

export interface ProductivityRowDto {
  userId: string;
  displayName: string;
  tasksCompleted: number;
  supportTasks: number;
  reworkTasks: number;
  executionMinutes: number;
  avgExecutionMinutes: number | null;
  waitingMinutes: number;
  avgWaitingMinutes: number | null;
  withDueDate: number;
  onTime: number;
  late: number;
  lateWithImpediment: number;
  impediments: number;
  issuesReported: number;
  onTimePct: number | null;
  /** Peças em que foi o principal e que foram reprovadas na inspeção. */
  rejectedPieces: number;
}

export interface ProductivityDto {
  from: string;
  to: string;
  rows: ProductivityRowDto[];
  notes: string[];
}

/** Visão do próprio profissional (Ricardo, Márcio), só se autorizado pelo gestor. */
export interface MyProductionDto {
  items: {
    id: string;
    code: string;
    serviceOrder: string;
    piece: string | null;
    service: string;
    dueCents: number;
    paidCents: number;
    status: LaborStatus;
    situation: LaborSituation;
    eligibility: EligibilityRule;
    payments: { amountCents: number; paidAt: string }[];
  }[];
  totals: { dueCents: number; paidCents: number; releasedOpenCents: number; forecastCents: number };
}

// ─────────────────────────── Evolução Fase 5 ───────────────────────────

export interface LaborReviewDto {
  id: string;
  code: string;
  status: 'ABERTA' | 'RESOLVIDA';
  serviceOrder: { id: string; code: string };
  piece: { id: string; code: string } | null;
  reason: string;
  /** Obrigações no escopo (valor devido e pago por profissional). */
  lines: { professionalUserId: string; displayName: string; dueCents: number; paidCents: number }[];
  resolution:
    | {
        professionalUserId: string;
        beforeCents: number;
        afterCents: number;
        paidCents: number;
        payableId: string | null;
      }[]
    | null;
  resolutionNote: string | null;
  openedBy: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  version: number;
}

/** Mão de obra por peça da OS (gestor). Sem valor combinado ≠ R$ 0. */
export interface ServiceOrderLaborDto {
  serviceOrder: { id: string; code: string };
  pieces: {
    id: string;
    code: string;
    description: string;
    stage: string;
    upholsterer: { userId: string; displayName: string } | null;
    payables: LaborPayableDto[];
    /** Há titular e nenhuma obrigação viva para ele. */
    missingValue: boolean;
    openReview: { id: string; code: string } | null;
  }[];
  /** Obrigações da OS inteira (legado). */
  wholeOrder: LaborPayableDto[];
  openReviews: LaborReviewDto[];
}

/** Base do fechamento semanal (Fase 7): por profissional e semana (segunda). */
export interface LaborWeeklyDto {
  from: string;
  to: string;
  rows: {
    professionalUserId: string;
    displayName: string;
    weekStart: string;
    /** Combinado no período (data de criação da obrigação). */
    agreedCents: number;
    /** Liberado no período (data de liberação = eligibleAt). */
    releasedCents: number;
    /** Pago no período (data do pagamento). */
    paidCents: number;
  }[];
  /** Saldo atual por profissional (liberado e não pago), independente do período. */
  openByProfessional: { professionalUserId: string; displayName: string; openCents: number }[];
}
