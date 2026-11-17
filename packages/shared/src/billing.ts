/**
 * Cobrança e planos (melhorias 1, 2 e 7 — 2026-11-17).
 *
 * Dois planos: o Cenário Gestão (R$ 399/mês, definido pelo dono em 2026-10-25) e o plano
 * superior (R$ 599/mês), que inclui o ambiente interativo (jogo Firma Viva). O anual tem 15% de
 * desconto. Decisões do dono em 2026-11-17: Asaas, teste grátis de 7 dias, e-mail pelo Resend,
 * bloqueio 5 dias depois do vencimento.
 * Valores em centavos.
 *
 * A situação da assinatura é CALCULADA a partir das datas (não há tarefa que "vira" o estado):
 * - cortesia: nunca vence (a Cenário Estofados e quem o dono liberar);
 * - teste: até `trialEndsAt`;
 * - ativa: pago até `paidUntil`;
 * - atrasada: venceu, mas ainda dentro da tolerância (o sistema funciona, com aviso);
 * - vencida: passou da tolerância — só a tela de assinatura abre até pagar.
 */

export const PLAN_KEYS = ['gestao', 'gestao_jogo'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export const BILLING_CYCLES = ['MENSAL', 'ANUAL'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Desconto do pagamento anual (15%, definido pelo dono em 2026-10-25). */
export const ANNUAL_DISCOUNT_BPS = 1500;

export interface PlanDefinition {
  key: PlanKey;
  label: string;
  description: string;
  /** Mensalidade em centavos. */
  monthlyCents: number;
  /** Inclui o ambiente interativo (Firma Viva). */
  includesGame: boolean;
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  gestao: {
    key: 'gestao',
    label: 'Cenário Gestão',
    description: 'O sistema completo da tapeçaria: painel, tablets da oficina e orçamentos.',
    monthlyCents: 39_900,
    includesGame: false,
  },
  gestao_jogo: {
    key: 'gestao_jogo',
    label: 'Cenário Gestão + Firma Viva',
    description:
      'Tudo do Cenário Gestão e o ambiente interativo Firma Viva, com a oficina e o escritório em 3D.',
    // R$ 599/mês, definido pelo dono em 2026-11-17.
    monthlyCents: 59_900,
    includesGame: true,
  },
};

export const isPlanKey = (v: string): v is PlanKey => (PLAN_KEYS as readonly string[]).includes(v);

/** Valor de uma cobrança do ciclo, em centavos (anual = 12 meses com o desconto). */
export function planPriceCents(plan: PlanKey, cycle: BillingCycle): number {
  const monthly = PLANS[plan].monthlyCents;
  if (cycle === 'MENSAL') return monthly;
  return Math.round((monthly * 12 * (10_000 - ANNUAL_DISCOUNT_BPS)) / 10_000);
}

export const SUBSCRIPTION_STATUSES = ['CORTESIA', 'TESTE', 'ATIVA', 'ATRASADA', 'VENCIDA'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  CORTESIA: 'Cortesia',
  TESTE: 'Teste grátis',
  ATIVA: 'Em dia',
  ATRASADA: 'Pagamento atrasado',
  VENCIDA: 'Vencida (bloqueada)',
};

export interface SubscriptionFacts {
  courtesy: boolean;
  trialEndsAt: Date | null;
  paidUntil: Date | null;
}

/** Fim do acesso (sem tolerância). `null` = não vence (cortesia). */
export function accessEndsAt(f: SubscriptionFacts): Date | null {
  if (f.courtesy) return null;
  const t = Math.max(f.trialEndsAt?.getTime() ?? 0, f.paidUntil?.getTime() ?? 0);
  return new Date(t);
}

export function subscriptionStatus(
  f: SubscriptionFacts,
  now: Date,
  graceDays: number,
): SubscriptionStatus {
  if (f.courtesy) return 'CORTESIA';
  const paid = f.paidUntil?.getTime() ?? 0;
  const trial = f.trialEndsAt?.getTime() ?? 0;
  const t = now.getTime();
  if (paid > t) return 'ATIVA';
  if (trial > t) return 'TESTE';
  const end = Math.max(paid, trial);
  // Tolerância só para quem já pagou alguma vez; o fim do teste grátis não tem tolerância.
  if (paid > 0 && t < end + graceDays * 86_400_000) return 'ATRASADA';
  return 'VENCIDA';
}

/** Soma um ciclo a uma data (mês a mês respeitando o calendário; ano = 12 meses). */
export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (cycle === 'ANUAL' ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export const INVOICE_STATUSES = ['PENDENTE', 'PAGA', 'VENCIDA', 'CANCELADA'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface SubscriptionInvoiceDto {
  id: string;
  plan: PlanKey;
  cycle: BillingCycle;
  amountCents: number;
  dueDate: string;
  status: InvoiceStatus;
  paymentUrl: string | null;
  paidAt: string | null;
  periodEnd: string | null;
}

export interface SubscriptionDto {
  plan: PlanKey;
  planLabel: string;
  cycle: BillingCycle;
  status: SubscriptionStatus;
  statusLabel: string;
  trialEndsAt: string | null;
  paidUntil: string | null;
  /** Até quando o sistema funciona sem pagar (com a tolerância). */
  blocksAt: string | null;
  /** Cobrança ligada no servidor (sem ela nada bloqueia; a conta funciona como hoje). */
  billingEnabled: boolean;
  /** Pode gerar cobrança online (provedor configurado). */
  canPayOnline: boolean;
  includesGame: boolean;
  invoices: SubscriptionInvoiceDto[];
  plans: {
    key: PlanKey;
    label: string;
    description: string;
    monthlyCents: number;
    annualCents: number;
    includesGame: boolean;
  }[];
}
