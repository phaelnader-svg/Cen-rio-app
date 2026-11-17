import {
  PLANS,
  SUBSCRIPTION_STATUS_LABEL,
  accessEndsAt,
  isPlanKey,
  planPriceCents,
  subscriptionStatus,
  type BillingCycle,
  type PlanKey,
  type SubscriptionDto,
  type SubscriptionFacts,
  type SubscriptionStatus,
} from '@cenario/shared';
import type { Env } from '../config/env';

/**
 * Cobrança da assinatura (melhoria 1). A situação sai das datas gravadas na empresa; não existe
 * tarefa que "vira" o estado. Com BILLING_ENABLED=false nada é bloqueado.
 */
export interface CompanyBillingRow {
  id: number;
  plan: string;
  billingCycle: string;
  billingCourtesy: boolean;
  trialEndsAt: Date | null;
  paidUntil: Date | null;
}

export const COMPANY_BILLING_SELECT = {
  id: true,
  plan: true,
  billingCycle: true,
  billingCourtesy: true,
  trialEndsAt: true,
  paidUntil: true,
} as const;

export const planOf = (c: Pick<CompanyBillingRow, 'plan'>): PlanKey =>
  isPlanKey(c.plan) ? c.plan : 'gestao';
export const cycleOf = (c: Pick<CompanyBillingRow, 'billingCycle'>): BillingCycle =>
  c.billingCycle === 'ANUAL' ? 'ANUAL' : 'MENSAL';

export const factsOf = (c: CompanyBillingRow): SubscriptionFacts => ({
  courtesy: c.billingCourtesy,
  trialEndsAt: c.trialEndsAt,
  paidUntil: c.paidUntil,
});

export function statusOf(
  c: CompanyBillingRow,
  env: Pick<Env, 'BILLING_GRACE_DAYS'>,
  now = new Date(),
): SubscriptionStatus {
  return subscriptionStatus(factsOf(c), now, env.BILLING_GRACE_DAYS);
}

/** Bloqueio por falta de pagamento: só com a cobrança ligada e passada a tolerância. */
export function billingLocked(
  c: CompanyBillingRow,
  env: Pick<Env, 'BILLING_ENABLED' | 'BILLING_GRACE_DAYS'>,
  now = new Date(),
): boolean {
  return env.BILLING_ENABLED && statusOf(c, env, now) === 'VENCIDA';
}

export function blocksAt(c: CompanyBillingRow, env: Pick<Env, 'BILLING_GRACE_DAYS'>): Date | null {
  const end = accessEndsAt(factsOf(c));
  if (!end) return null;
  const grace = c.paidUntil ? env.BILLING_GRACE_DAYS * 86_400_000 : 0;
  return new Date(end.getTime() + grace);
}

export function plansCatalog(): SubscriptionDto['plans'] {
  return Object.values(PLANS).map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    monthlyCents: planPriceCents(p.key, 'MENSAL'),
    annualCents: planPriceCents(p.key, 'ANUAL'),
    includesGame: p.includesGame,
  }));
}

export { SUBSCRIPTION_STATUS_LABEL };

/**
 * Configuração da cobrança do servidor em execução (definida em buildApp). Usada onde o `env`
 * não chega (montagem do /auth/me).
 */
let currentBillingEnv: Pick<Env, 'BILLING_ENABLED' | 'BILLING_GRACE_DAYS'> = {
  BILLING_ENABLED: false,
  BILLING_GRACE_DAYS: 5,
};
export function setBillingEnvironment(
  env: Pick<Env, 'BILLING_ENABLED' | 'BILLING_GRACE_DAYS'>,
  hasEmailDelivery: () => boolean = () => false,
) {
  currentBillingEnv = {
    BILLING_ENABLED: env.BILLING_ENABLED,
    BILLING_GRACE_DAYS: env.BILLING_GRACE_DAYS,
  };
  emailDelivery = hasEmailDelivery;
}
let emailDelivery: () => boolean = () => false;
/** Há envio de e-mail configurado (Resend)? Sem ele, nada pede confirmação nem oferece link. */
export const emailDeliveryEnabled = () => emailDelivery();
export const billingEnvironment = () => currentBillingEnv;
