/**
 * Fase 11 — financeiro operacional: receita por OS, contas a receber e a pagar, custos de
 * material, mão de obra por produção, logística com rateio, despesas e indicadores.
 * Valores em centavos (inteiros). Regras puras, testadas isoladamente. Não é contabilidade
 * fiscal: tributos são estimativas configuradas pelo gestor.
 */
import { formatNumber } from './domain';
import { formatCents } from './purchasing-domain';

export const receivableCode = (n: number) => formatNumber('RC', n);
export const payableCode = (n: number) => formatNumber('CPG', n);
export const productionPayableCode = (n: number) => formatNumber('MO', n);
export const logisticsCostCode = (n: number) => formatNumber('LG', n);
export const expenseCode = (n: number) => formatNumber('DP', n);

export const PAYMENT_METHODS = [
  'PIX',
  'DINHEIRO',
  'CARTAO_CREDITO',
  'CARTAO_DEBITO',
  'BOLETO',
  'TRANSFERENCIA',
  'CHEQUE',
  'OUTRO',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  DINHEIRO: 'Dinheiro',
  CARTAO_CREDITO: 'Cartão de crédito',
  CARTAO_DEBITO: 'Cartão de débito',
  BOLETO: 'Boleto',
  TRANSFERENCIA: 'Transferência',
  CHEQUE: 'Cheque',
  OUTRO: 'Outro',
};

export const ADJUSTMENT_KINDS = ['DESCONTO', 'ACRESCIMO', 'AJUSTE'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];
export const ADJUSTMENT_KIND_LABEL: Record<AdjustmentKind, string> = {
  DESCONTO: 'Desconto',
  ACRESCIMO: 'Acréscimo',
  AJUSTE: 'Ajuste autorizado',
};
/** Sinal do ajuste comercial: desconto reduz, acréscimo aumenta, ajuste usa o sinal informado. */
export function signedAdjustment(kind: AdjustmentKind, amountCents: number) {
  if (kind === 'DESCONTO') return -Math.abs(amountCents);
  if (kind === 'ACRESCIMO') return Math.abs(amountCents);
  return amountCents;
}

export const RECEIVABLE_STATUSES = ['ABERTO', 'PARCIAL', 'RECEBIDO', 'CANCELADO'] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];
export const RECEIVABLE_STATUS_LABEL: Record<ReceivableStatus, string> = {
  ABERTO: 'Em aberto',
  PARCIAL: 'Recebido em parte',
  RECEBIDO: 'Recebido',
  CANCELADO: 'Cancelado',
};
export const PAYABLE_STATUSES = ['ABERTO', 'PARCIAL', 'PAGO', 'CANCELADO'] as const;
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];
export const PAYABLE_STATUS_LABEL: Record<PayableStatus, string> = {
  ABERTO: 'Em aberto',
  PARCIAL: 'Pago em parte',
  PAGO: 'Pago',
  CANCELADO: 'Cancelado',
};

/** Situação de uma obrigação a partir do valor e do total quitado (recebido ou pago). */
export function settlementStatus(amountCents: number, settledCents: number) {
  if (settledCents <= 0) return 'ABERTO' as const;
  if (settledCents >= amountCents) return 'QUITADO' as const;
  return 'PARCIAL' as const;
}

/** Recebimento/pagamento não pode passar do saldo (evita duplicidade e erro de digitação). */
export function settlementProblem(amountCents: number, settledCents: number, newCents: number) {
  if (!Number.isInteger(newCents) || newCents <= 0) return 'Informe um valor maior que zero.';
  if (settledCents + newCents > amountCents)
    return `O valor passa do saldo em aberto (${formatCents(amountCents - settledCents)}).`;
  return null;
}

export const FINANCIAL_STATUSES = [
  'SEM_VALOR',
  'SEM_COBRANCA',
  'A_RECEBER',
  'PARCIAL',
  'QUITADO',
] as const;
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];
export const FINANCIAL_STATUS_LABEL: Record<FinancialStatus, string> = {
  SEM_VALOR: 'Sem valor contratado',
  SEM_COBRANCA: 'Cobrança não lançada',
  A_RECEBER: 'A receber',
  PARCIAL: 'Recebido em parte',
  QUITADO: 'Quitado',
};
/** Situação financeira do pedido (derivada): valor final × lançado × recebido. */
export function orderFinancialStatus(i: {
  finalCents: number | null;
  billedCents: number;
  receivedCents: number;
}): FinancialStatus {
  if (i.finalCents === null) return 'SEM_VALOR';
  if (i.receivedCents >= i.finalCents && i.finalCents > 0) return 'QUITADO';
  if (i.receivedCents > 0) return 'PARCIAL';
  if (i.billedCents === 0) return 'SEM_COBRANCA';
  return 'A_RECEBER';
}

// ─────────────────────────── Mão de obra por produção ───────────────────────────

export const ELIGIBILITY_RULES = [
  'PRODUCAO_CONCLUIDA',
  'QUALIDADE_APROVADA',
  'ENTREGA_CONCLUIDA',
] as const;
export type EligibilityRule = (typeof ELIGIBILITY_RULES)[number];
export const ELIGIBILITY_LABEL: Record<EligibilityRule, string> = {
  PRODUCAO_CONCLUIDA: 'Produção da peça concluída',
  QUALIDADE_APROVADA: 'Aprovada na inspeção de qualidade',
  ENTREGA_CONCLUIDA: 'Entregue ao cliente',
};
export const LABOR_STATUSES = [
  'PREVISTO',
  'LIBERADO',
  'PAGO_PARCIAL',
  'PAGO',
  'CANCELADO',
] as const;
export type LaborStatus = (typeof LABOR_STATUSES)[number];
export const LABOR_STATUS_LABEL: Record<LaborStatus, string> = {
  PREVISTO: 'Previsto (aguardando condição)',
  LIBERADO: 'Liberado para pagamento',
  PAGO_PARCIAL: 'Pago em parte',
  PAGO: 'Pago',
  CANCELADO: 'Cancelado',
};

/** Etapas da peça que satisfazem cada regra de elegibilidade. */
const STAGES_AFTER: Record<EligibilityRule, readonly string[]> = {
  PRODUCAO_CONCLUIDA: [
    'AGUARDANDO_INSPECAO',
    'EM_INSPECAO',
    'EM_CORRECAO',
    'AGUARDANDO_EMBALAGEM',
    'EM_EMBALAGEM',
    'BLOQUEIO_EXPEDICAO',
    'PRONTA_ENTREGA',
    'ENTREGA_AGENDADA',
    'EM_TRANSPORTE',
    'ENTREGUE',
  ],
  QUALIDADE_APROVADA: [
    'AGUARDANDO_EMBALAGEM',
    'EM_EMBALAGEM',
    'BLOQUEIO_EXPEDICAO',
    'PRONTA_ENTREGA',
    'ENTREGA_AGENDADA',
    'EM_TRANSPORTE',
    'ENTREGUE',
  ],
  ENTREGA_CONCLUIDA: ['ENTREGUE'],
};
/** Elegível quando todas as peças cobertas atingiram a etapa exigida (nunca pela tarefa sozinha). */
export function laborEligible(rule: EligibilityRule, stages: readonly string[]) {
  return stages.length > 0 && stages.every((s) => STAGES_AFTER[rule].includes(s));
}
export const laborDue = (p: { agreedCents: number; adjustmentsCents: number }) =>
  Math.max(0, p.agreedCents + p.adjustmentsCents);
export function laborStatus(p: {
  agreedCents: number;
  adjustmentsCents: number;
  paidCents: number;
  eligible: boolean;
  cancelled: boolean;
}): LaborStatus {
  if (p.cancelled) return 'CANCELADO';
  const due = laborDue(p);
  if (p.paidCents > 0 && p.paidCents >= due) return 'PAGO';
  if (p.paidCents > 0) return 'PAGO_PARCIAL';
  return p.eligible ? 'LIBERADO' : 'PREVISTO';
}

// ─────────────────────────── Logística e despesas ───────────────────────────

export const LOGISTICS_COST_KINDS = [
  'RETIRADA',
  'ENTREGA',
  'INSTALACAO',
  'TRANSPORTE_TERCEIRIZADO',
  'DESLOCAMENTO',
] as const;
export type LogisticsCostKind = (typeof LOGISTICS_COST_KINDS)[number];
export const LOGISTICS_COST_KIND_LABEL: Record<LogisticsCostKind, string> = {
  RETIRADA: 'Retirada',
  ENTREGA: 'Entrega',
  INSTALACAO: 'Instalação',
  TRANSPORTE_TERCEIRIZADO: 'Transporte terceirizado',
  DESLOCAMENTO: 'Deslocamento adicional',
};
export const SPLIT_METHODS = ['IGUAL', 'POR_PECA', 'MANUAL'] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];
export const SPLIT_METHOD_LABEL: Record<SplitMethod, string> = {
  IGUAL: 'Igual entre as OS',
  POR_PECA: 'Proporcional ao número de peças',
  MANUAL: 'Valores informados',
};

/**
 * Rateio sem perder centavos: divide `total` pelos pesos; a sobra de arredondamento vai para as
 * partes com maior resto (empate: ordem original), de modo que a soma é sempre exatamente `total`.
 */
export function splitCents(total: number, weights: readonly number[]): number[] {
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!w.length) return [];
  if (sum === 0)
    return splitCents(
      total,
      w.map(() => 1),
    );
  const base = w.map((x) => Math.floor((total * x) / sum));
  let rest = total - base.reduce((a, b) => a + b, 0);
  // Maiores restos primeiro (empate: ordem original) — nenhuma parte de peso zero ganha centavo.
  const order = w
    .map((x, i) => ({ i, r: (total * x) / sum - base[i]! }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest -= 1) base[order[k]!.i]! += 1;
  return base;
}

export const EXPENSE_CATEGORIES = [
  'ALUGUEL',
  'ENERGIA',
  'AGUA',
  'INTERNET',
  'COMBUSTIVEL',
  'MARKETING',
  'CONTABILIDADE',
  'SISTEMAS',
  'OUTRAS',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  ALUGUEL: 'Aluguel',
  ENERGIA: 'Energia',
  AGUA: 'Água',
  INTERNET: 'Internet',
  COMBUSTIVEL: 'Combustível',
  MARKETING: 'Marketing',
  CONTABILIDADE: 'Contabilidade',
  SISTEMAS: 'Sistemas',
  OUTRAS: 'Outras despesas',
};
/** Categorias de contas a pagar: despesas + fornecedores de material + logística + outros. */
export const PAYABLE_CATEGORIES = [
  ...EXPENSE_CATEGORIES,
  'MATERIAL',
  'LOGISTICA',
  'SERVICOS',
] as const;
export type PayableCategory = (typeof PAYABLE_CATEGORIES)[number];
export const PAYABLE_CATEGORY_LABEL: Record<PayableCategory, string> = {
  ...EXPENSE_CATEGORY_LABEL,
  MATERIAL: 'Materiais (fornecedor)',
  LOGISTICA: 'Logística',
  SERVICOS: 'Serviços de terceiros',
};

/** Primeiro dia do mês (AAAA-MM-01) de uma data AAAA-MM-DD. */
export const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;
/** Data do vencimento de uma recorrência no mês (dia limitado ao último dia do mês). */
export function recurringDueDate(month: string, dayOfMonth: number) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month.slice(0, 7)}-${String(Math.min(dayOfMonth, last)).padStart(2, '0')}`;
}

// ─────────────────────────── Resultado por OS ───────────────────────────

export interface OrderResultInput {
  revenueCents: number;
  materialsCents: number;
  laborCents: number;
  logisticsCents: number;
  otherVariableCents: number;
  /** Alíquota estimada em pontos-base (600 = 6%); null = não configurada. */
  taxRateBps: number | null;
}
/**
 * Margem de contribuição = receita − custos variáveis (materiais, mão de obra direta,
 * logística, tributos estimados, outros variáveis). NÃO é lucro líquido: não desconta despesas
 * fixas nem a equipe de remuneração fixa.
 */
export function contributionMargin(i: OrderResultInput) {
  const taxCents = i.taxRateBps === null ? 0 : Math.round((i.revenueCents * i.taxRateBps) / 10_000);
  const variable =
    i.materialsCents + i.laborCents + i.logisticsCents + i.otherVariableCents + taxCents;
  const marginCents = i.revenueCents - variable;
  return {
    taxCents,
    variableCostsCents: variable,
    marginCents,
    marginPct: i.revenueCents > 0 ? Math.round((marginCents / i.revenueCents) * 1000) / 10 : null,
  };
}

/** Resultado gerencial estimado (competência): margens − despesas operacionais − equipe fixa. */
export function managementResult(i: {
  contributionMarginCents: number;
  operationalExpensesCents: number;
  fixedTeamCents: number;
}) {
  return i.contributionMarginCents - i.operationalExpensesCents - i.fixedTeamCents;
}

/** Custo médio ponderado (centavos por unidade) a partir de lotes recebidos (quantidade × preço). */
export function weightedAverageCents(lots: readonly { quantity: number; unitCents: number }[]) {
  const q = lots.reduce((a, l) => a + l.quantity, 0);
  if (q <= 0) return null;
  return Math.round(lots.reduce((a, l) => a + l.quantity * l.unitCents, 0) / q);
}

/** CSV com ponto e vírgula (Excel em português), aspas quando necessário e BOM para acentos. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
) {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    // Evita fórmulas ao abrir no Excel (texto livre começando com =, +, @ ou -texto).
    if (typeof v === 'string' && /^([=+@\t\r]|-[^\d])/.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}
/** Centavos → "1234,56" (CSV, sem símbolo). */
export const csvMoney = (cents: number | null) =>
  cents === null ? '' : (cents / 100).toFixed(2).replace('.', ',');

// ─────────────────────────── Produtividade ───────────────────────────

/**
 * Tempos de uma tarefa a partir do histórico (imutável): execução = soma dos trechos entre
 * Iniciada/Retomada e Pausada/Concluída/Cancelada; espera = da primeira liberação ao início.
 */
export function taskTimings(events: readonly { kind: string; at: Date }[]) {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  let runningSince: Date | null = null;
  let execMs = 0;
  let releasedAt: Date | null = null;
  let startedAt: Date | null = null;
  for (const e of sorted) {
    if (e.kind === 'LIBERADA' && !releasedAt && !startedAt) releasedAt = e.at;
    if (e.kind === 'INICIADA' || e.kind === 'RETOMADA') {
      if (!startedAt) startedAt = e.at;
      if (!runningSince) runningSince = e.at;
    }
    if (
      (e.kind === 'PAUSADA' || e.kind === 'CONCLUIDA' || e.kind === 'CANCELADA') &&
      runningSince
    ) {
      execMs += e.at.getTime() - runningSince.getTime();
      runningSince = null;
    }
  }
  return {
    executionMinutes: Math.round(execMs / 60_000),
    waitingMinutes:
      releasedAt && startedAt
        ? Math.max(0, Math.round((startedAt.getTime() - releasedAt.getTime()) / 60_000))
        : null,
  };
}

// ─────────────────────────── Evolução Fase 5: situação e revisão ───────────────────────────

/**
 * Situação exibida (derivada; o status gravado continua o da Fase 11). Distingue o que está
 * combinado, o que terminou e aguarda a qualidade, o liberado, o pago, o saldo e o que está
 * travado por revisão financeira.
 */
export const LABOR_SITUATIONS = [
  'PREVISTO',
  'AGUARDANDO_QUALIDADE',
  'LIBERADO',
  'PAGO_PARCIAL',
  'PAGO',
  'EM_REVISAO',
  'CANCELADO',
] as const;
export type LaborSituation = (typeof LABOR_SITUATIONS)[number];
export const LABOR_SITUATION_LABEL: Record<LaborSituation, string> = {
  PREVISTO: 'Combinado (previsto)',
  AGUARDANDO_QUALIDADE: 'Concluído, aguardando qualidade',
  LIBERADO: 'Liberado para pagamento',
  PAGO_PARCIAL: 'Pago em parte (saldo pendente)',
  PAGO: 'Pago',
  EM_REVISAO: 'Em revisão financeira',
  CANCELADO: 'Cancelado',
};
const AWAITING_QUALITY_STAGES = ['AGUARDANDO_INSPECAO', 'EM_INSPECAO', 'EM_CORRECAO'];
export function laborSituation(p: {
  status: LaborStatus;
  inReview: boolean;
  eligibility: EligibilityRule;
  stages: readonly string[];
}): LaborSituation {
  if (p.status === 'CANCELADO') return 'CANCELADO';
  if (p.status === 'PAGO') return 'PAGO';
  if (p.inReview) return 'EM_REVISAO';
  if (p.status === 'PAGO_PARCIAL') return 'PAGO_PARCIAL';
  if (p.status === 'LIBERADO') return 'LIBERADO';
  if (
    p.eligibility === 'QUALIDADE_APROVADA' &&
    p.stages.length > 0 &&
    p.stages.every((s) => AWAITING_QUALITY_STAGES.includes(s))
  )
    return 'AGUARDANDO_QUALIDADE';
  return 'PREVISTO';
}

/**
 * Resolução de uma revisão financeira: o gestor informa o valor devido a cada profissional.
 * Todos os que já têm obrigação no escopo precisam constar; ninguém fica abaixo do que já
 * recebeu; novos profissionais só com valor positivo. Sem rateio automático.
 */
export function reviewResolutionProblem(
  lines: readonly { professionalUserId: string; amountCents: number }[],
  existing: readonly { professionalUserId: string; dueCents: number; paidCents: number }[],
): string | null {
  if (!lines.length) return 'Informe o valor devido a cada profissional.';
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.professionalUserId)) return 'Cada profissional aparece uma única vez.';
    seen.add(l.professionalUserId);
    if (!Number.isInteger(l.amountCents) || l.amountCents < 0)
      return 'Valores em centavos, sem valores negativos.';
  }
  for (const e of existing) {
    const l = lines.find((x) => x.professionalUserId === e.professionalUserId);
    if (!l) return 'Inclua todos os profissionais que já têm valor combinado nesta peça/OS.';
    if (l.amountCents < e.paidCents)
      return `O valor devido não pode ficar abaixo do já pago (${formatCents(e.paidCents)}).`;
  }
  for (const l of lines)
    if (!existing.some((e) => e.professionalUserId === l.professionalUserId) && l.amountCents === 0)
      return 'Novo profissional só com valor maior que zero.';
  return null;
}
