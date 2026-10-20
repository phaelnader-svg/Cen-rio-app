import type { OrderServiceState } from './domain';
import type {
  AdjustmentKind,
  EligibilityRule,
  ExpenseCategory,
  FinancialStatus,
  LaborSituation,
  LaborStatus,
  LogisticsCostKind,
  LogisticsCostStatus,
  TripCostSituation,
  PayableCategory,
  PayableStatus,
  PaymentMethod,
  DueTrigger,
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
  /** Cobrança: saldo de cobranças vencidas (data passada ou evento já concluído). */
  overdueCents: number;
  /** Valor final ainda não lançado em cobranças. */
  toBillCents: number;
  financialStatus: FinancialStatus;
  paymentTerms: string | null;
  /**
   * Cobrança (AM-2/AM-3): valores por peça (todos ou nenhum). `attributedCents` = parte da peça nas
   * OS ativas; `pendingCents` = parte ainda sem OS (peça não chegou) ou devolvida/cancelada.
   */
  itemValuesUsed: boolean;
  pieces: {
    orderItemId: string;
    position: number;
    description: string;
    quantity: number;
    valueCents: number | null;
    attributedCents: number;
    pendingCents: number;
  }[];
  /** Receita das OS estimada (fallback proporcional às peças) — sem valores por peça. */
  revenueEstimated: boolean;
  adjustments: {
    id: string;
    kind: AdjustmentKind;
    amountCents: number;
    reason: string;
    authorizedBy: string;
    createdAt: string;
  }[];
  serviceOrders: {
    id: string;
    code: string;
    revenueCents: number;
    manual: boolean;
    estimated: boolean;
  }[];
}

export interface CustomerPaymentDto {
  id: string;
  amountCents: number;
  receivedAt: string;
  method: PaymentMethod;
  installments: number | null;
  /** Reembolso (dinheiro que entrou e saiu) — distinto do estorno. */
  refund: boolean;
  note: string | null;
  reversalOfId: string | null;
  reversed: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** Pagamento informado pela equipe numa parada (registro operacional; não é baixa). */
export interface PaymentReportDto {
  id: string;
  receivable: { id: string; code: string; description: string; openCents: number };
  order: { id: string; code: string };
  customerName: string;
  stop: { kind: 'RETIRADA' | 'ENTREGA'; id: string; code: string };
  collected: boolean;
  method: PaymentMethod | null;
  note: string | null;
  reportedBy: string;
  reportedAt: string;
  status: 'PENDENTE' | 'CONFIRMADO' | 'DESCARTADO';
  paymentId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Sugestão para a confirmação: forma e parcelas da cobrança. */
  expectedMethod: PaymentMethod;
  installments: number | null;
  version: number;
}

/** Saldo do cliente por pedido para o painel de entregas (só com financeiro.ver). */
export interface OrderBalanceDto {
  orderId: string;
  orderCode: string;
  customerName: string;
  finalCents: number | null;
  receivedCents: number;
  openCents: number;
  overdueCents: number;
  /** Saldo com vencimento na entrega (o que se espera coletar). */
  dueOnDeliveryCents: number;
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
  /** DATA: obrigatória; RETIRADA/ENTREGA: nula (vence na conclusão do evento). */
  dueDate: string | null;
  dueTrigger: DueTrigger;
  /** Vencimento real: a data, ou a conclusão do evento (null enquanto não aconteceu). */
  effectiveDueDate: string | null;
  overdue: boolean;
  daysOverdue: number;
  expectedMethod: PaymentMethod;
  installments: number | null;
  /** Pagamentos informados pela equipe (pendentes primeiro). */
  reports: PaymentReportDto[];
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
  /** Evolução Fase 6: estorno registrado (o pagamento original continua no histórico). */
  reversal: { reason: string; createdAt: string } | null;
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
    /** Evolução Fase 7: pagamento estornado (continua no histórico). */
    reversed: boolean;
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
  /** Reservas de estoque ativas (consumo ainda não confirmado: fora do custo realizado). */
  activeReservations: number;
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
  /**
   * Cobrança (AM-3): receita ESTIMADA (pedido sem valores por peça → distribuição proporcional).
   * Com valores por peça, a receita é a soma das peças da OS (estável).
   */
  revenueEstimated: boolean;
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
  kind: LogisticsCostKind | 'TENTATIVA_FRUSTRADA';
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
  // Evolução Fase 6.
  status: LogisticsCostStatus;
  situation: TripCostSituation;
  payee: { userId: string; displayName: string } | null;
  participants: { userId: string; displayName: string }[];
  adjustmentsCents: number;
  /** Valor devido = combinado + ajustes (só existe obrigação depois da realização). */
  dueCents: number;
  paidCents: number;
  openCents: number;
  dueAt: string | null;
  pendingReason: string | null;
  allocationMode: 'MANUAL' | 'AUTO' | 'ESCOLHIDA';
  adjustments: {
    id: string;
    amountCents: number;
    reason: string;
    authorizedBy: string;
    createdAt: string;
  }[];
  history: FinanceEventDto[];
}

/** Evolução Fase 6: valores padrão e recebedor da logística. */
export interface LogisticsDefaultsDto {
  defaultPickupCostCents: number | null;
  defaultDeliveryCostCents: number | null;
  payee: { userId: string; displayName: string; active: boolean } | null;
  /** Pessoas que podem participar de viagens (logística ativa). */
  people: { userId: string; displayName: string }[];
}

/** Evolução Fase 6: custo da viagem visto da retirada/entrega (somente financeiro). */
export interface TripCostViewDto {
  /** Evolução Fase 7: viagem sem custo confirmada como gratuita (≠ não informado). */
  freeConfirmed: { reason: string; at: string } | null;
  trip: { kind: 'RETIRADA' | 'ENTREGA'; id: string; code: string; status: string };
  cost: LogisticsCostDto | null;
  fees: LogisticsCostDto[];
  suggestedCents: number | null;
  payee: { userId: string; displayName: string; active: boolean } | null;
  /** OS que seriam rateadas automaticamente. */
  serviceOrders: { id: string; code: string }[];
}

/** Base do fechamento semanal (Fase 7): logística por recebedor e semana (segunda). */
export interface LogisticsWeeklyDto {
  from: string;
  to: string;
  timezone: string;
  items: {
    costId: string;
    code: string;
    kind: string;
    payee: { userId: string; displayName: string } | null;
    trip: { kind: 'RETIRADA' | 'ENTREGA'; id: string; code: string } | null;
    serviceOrders: { id: string; code: string; amountCents: number }[];
    agreedCents: number;
    adjustmentsCents: number;
    dueCents: number;
    paidCents: number;
    openCents: number;
    /** Fato gerador (realização ou taxa autorizada), data local da oficina. */
    factDate: string;
    weekStart: string;
    situation: TripCostSituation;
  }[];
  weeks: {
    payeeUserId: string | null;
    displayName: string;
    weekStart: string;
    dueCents: number;
    paidCents: number;
    openCents: number;
    items: number;
  }[];
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
  /** R1: o que está em revisão financeira aberta fica só em `inReviewCents` (nunca no devido). */
  totals: {
    dueCents: number;
    paidCents: number;
    releasedOpenCents: number;
    forecastCents: number;
    inReviewCents: number;
  };
}

/**
 * R1 — "Meus Ganhos" (tablet, PIN): visão do próprio profissional sobre a MESMA fonte do
 * fechamento semanal. Só a remuneração variável própria (tapeçaria por peça e logística);
 * nunca valores de outras pessoas, preço ao cliente, margem, materiais ou salário fixo.
 */
export type MyEarningsSituation =
  | 'PREVISTO'
  | 'AGUARDANDO_LIBERACAO'
  | 'EM_REVISAO'
  | 'LIBERADO'
  | 'PAGO_PARCIAL'
  | 'PAGO';
export interface MyEarningsDto {
  weekStart: string;
  weekEnd: string;
  currentWeekStart: string;
  timezone: string;
  /**
   * Totais da semana (iguais aos do fechamento para a mesma pessoa e semana). Previsto,
   * aguardando e em revisão são a situação atual e nunca entram no "a receber".
   */
  summary: {
    forecastCents: number;
    awaitingCents: number;
    inReviewCents: number;
    releasedCents: number;
    paidInWeekCents: number;
    paidAfterCents: number;
    balanceCents: number;
  };
  items: {
    id: string;
    code: string;
    category: 'TAPECARIA' | 'LOGISTICA';
    situation: MyEarningsSituation;
    /** WEEK: liberado na semana; PREVIOUS: saldo de semana anterior; FORECAST: ainda não liberado. */
    bucket: 'WEEK' | 'PREVIOUS' | 'FORECAST';
    description: string;
    serviceOrders: string[];
    piece: string | null;
    agreedCents: number;
    adjustmentsCents: number;
    totalDueCents: number;
    /** Liberado considerado nesta semana (0 se ainda não liberado). */
    dueCents: number;
    paidInWeekCents: number;
    currentOpenCents: number;
    releasedAt: string | null;
    adjustments: { amountCents: number; reason: string; date: string; afterWeek: boolean }[];
    /** R2: `administrative` = pago com liberação administrativa (sem confirmação do profissional). */
    payments: {
      amountCents: number;
      paidAt: string;
      reversed: boolean;
      administrative?: boolean;
    }[];
    /** R2: última solicitação de alteração deste item (só do próprio profissional). */
    request: OwnValueChangeDto | null;
    /** R2: pode pedir alteração agora (devido, sem revisão, sem pedido pendente, não quitado). */
    canRequest: boolean;
  }[];
  /** R2: conferência da semana pelo profissional (D13). */
  confirmation: WeekConfirmationDto;
}

/** R2 — o que o profissional confere (ou a exceção cobre) e a situação ao vivo. */
export interface WeekConfirmationDto {
  state: 'SEM_ITENS' | 'SEM_CONFIRMACAO' | 'CONFIRMADA' | 'LIBERADA_POR_EXCECAO' | 'DESATUALIZADA';
  weekStart: string;
  /** Hash do conjunto atual (enviado de volta ao confirmar). */
  currentHash: string | null;
  totalCents: number;
  lines: { code: string; kind: 'MAO_DE_OBRA' | 'LOGISTICA'; dueCents: number }[];
  latest: {
    code: string;
    kind: 'PROFISSIONAL' | 'EXCECAO_ADMINISTRATIVA';
    createdAt: string;
    /** Exceção: só a mensagem neutra (o motivo interno nunca vai ao profissional). */
    publicNote: string | null;
  } | null;
  /** Códigos cujo valor mudou desde a última confirmação/exceção. */
  changed: string[];
  /** Pedidos de alteração pendentes que impedem confirmar. */
  pendingRequests: string[];
  /**
   * Remediação F9-03/F9-06: todas as confirmações/exceções desta pessoa e semana (mais recente
   * primeiro), cada uma com o retrato que identifica o estado conferido e a validade AO VIVO:
   * VIGENTE = o retrato é o estado atual; EM_PARTE = parte das linhas mudou (pelo D13 só as linhas
   * iguais ao estado atual continuam cobertas); INVALIDA = nenhuma linha confere mais.
   */
  history: {
    code: string;
    kind: 'PROFISSIONAL' | 'EXCECAO_ADMINISTRATIVA';
    createdAt: string;
    totalCents: number;
    /** SHA-256 do retrato conferido (pessoa, semana, linhas ordenadas). */
    hash: string;
    /** Versão do fechamento semanal do gestor quando conferida (null: semana ainda não conferida, ou registro anterior a esta remediação). */
    closingVersion: number | null;
    status: 'VIGENTE' | 'EM_PARTE' | 'INVALIDA';
    /** Códigos das linhas do retrato que não conferem mais com o estado atual. */
    changed: string[];
    /** Quando uma conferência posterior registrou que este retrato deixou de valer (null se ainda não houve). */
    invalidatedAt: string | null;
    invalidatedBy: string | null;
  }[];
}

/** R2 — pedido de alteração visto pelo próprio profissional. */
export interface OwnValueChangeDto {
  id: string;
  code: string;
  status: 'PENDENTE' | 'APROVADA' | 'RECUSADA' | 'OBSOLETA';
  currentCents: number;
  requestedCents: number;
  reason: string;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** R2 — pedido de alteração na fila do gestor. */
export interface ValueChangeRequestDto extends OwnValueChangeDto {
  targetKind: 'PRODUCAO' | 'LOGISTICA';
  target: {
    id: string;
    code: string;
    description: string;
    serviceOrders: string[];
    piece: string | null;
  };
  beneficiary: { userId: string; displayName: string };
  /** Semana de competência do item (liberação/realização), se já devido. */
  weekStart: string | null;
  /** Valor devido agora (≠ currentCents → o alvo mudou: a solicitação ficou obsoleta). */
  currentNowCents: number;
  diffCents: number;
  /** Motivo de a solicitação não poder mais ser aplicada (derivado), se houver. */
  staleReason: string | null;
  appliedAs: 'VALOR_COMBINADO' | 'AJUSTE' | null;
  decidedBy: string | null;
  version: number;
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

// ─────────────────────────── Evolução Fase 7: fechamento semanal ───────────────────────────

export interface ClosingItemDto {
  /** Fonte de verdade: obrigação de produção (MO) ou custo de logística (LG). */
  kind: 'MAO_DE_OBRA' | 'LOGISTICA';
  id: string;
  code: string;
  category: 'TAPECARIA' | 'LOGISTICA';
  beneficiary: { userId: string | null; displayName: string };
  state: 'PREVISTO' | 'AGUARDANDO_QUALIDADE' | 'EM_REVISAO' | 'PENDENTE_CONFIGURACAO' | 'DEVIDO';
  bucket: 'WEEK' | 'PREVIOUS' | 'FORECAST' | null;
  description: string;
  serviceOrders: { id: string; code: string; amountCents: number | null }[];
  piece: { id: string; code: string } | null;
  /** Data local em que ficou devido (liberação/realização); null se ainda não. */
  competence: string | null;
  agreedCents: number;
  adjustmentsCents: number;
  totalDueCents: number;
  dueCents: number;
  /** Parte de `dueCents` que é saldo de semanas anteriores (R1: semana com ajuste posterior). */
  previousCents: number;
  paidInWeekCents: number;
  openAtEndCents: number;
  paidAfterCents: number;
  currentOpenCents: number;
  payments: { id: string; amountCents: number; paidAt: string; reversed: boolean }[];
  /** Pode ser quitado pelo lote (devido, sem revisão, com obrigação vinculada). */
  payable: boolean;
  notes: string[];
  /**
   * R1 (DEC-7): mudanças de valor feitas DEPOIS de o item ficar devido, cada uma com a sua
   * competência (data local em que foi feita). As posteriores à semana não entram nela.
   */
  changes: {
    competence: string;
    amountCents: number;
    reason: string;
    kind: 'AJUSTE' | 'VALOR_ALTERADO';
    afterWeek: boolean;
  }[];
}

export interface ClosingRowDto {
  beneficiary: { userId: string | null; displayName: string };
  category: 'TAPECARIA' | 'LOGISTICA';
  items: number;
  forecastCents: number;
  awaitingCents: number;
  weekDueCents: number;
  previousOpenCents: number;
  dueCents: number;
  paidInWeekCents: number;
  openAtEndCents: number;
  paidAfterCents: number;
  currentOpenCents: number;
  adjustmentsCents: number;
  /** Lote permitido (recebedor vinculado e ativo). */
  canPay: boolean;
  /** R2 (D13): situação da confirmação do profissional nesta semana. */
  confirmation: WeekConfirmationDto | null;
}

export interface ClosingPendencyDto {
  kind:
    | 'REVISAO_ABERTA'
    | 'SEM_RECEBEDOR'
    | 'CUSTO_NAO_INFORMADO'
    | 'DIVERGENCIA_CONTA'
    | 'PECA_DEVOLVIDA';
  /** Bloqueia a conferência até ser resolvida explicitamente. */
  blocking: boolean;
  message: string;
  ref: { kind: string; id: string; code: string } | null;
}

export interface WeeklyClosingDto {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  /** ABERTO (nunca conferido), CONFERIDO ou REABERTO. */
  status: 'ABERTO' | 'CONFERIDO' | 'REABERTO';
  version: number;
  checkedBy: string | null;
  checkedAt: string | null;
  note: string | null;
  reopenReason: string | null;
  /** Valores devidos mudaram depois da conferência (ajuste, estorno, novo item...). */
  divergent: boolean;
  divergences: string[];
  rows: ClosingRowDto[];
  totals: Omit<ClosingRowDto, 'beneficiary' | 'category' | 'canPay' | 'confirmation'>;
  items: ClosingItemDto[];
  pendencies: ClosingPendencyDto[];
  payments: {
    id: string;
    code: string;
    beneficiary: string;
    category: 'TAPECARIA' | 'LOGISTICA';
    amountCents: number;
    paidAt: string;
    method: PaymentMethod;
    reference: string | null;
    reversed: boolean;
    parts: { code: string; amountCents: number }[];
  }[];
  history: {
    kind: string;
    note: string | null;
    actor: string | null;
    createdAt: string;
    data: unknown;
  }[];
}
