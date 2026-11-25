import {
  PLANS,
  SUBSCRIPTION_STATUS_LABEL,
  accessEndsAt,
  isPlanKey,
  subscriptionStatus,
  type BillingCycle,
  type PlanKey,
  type SubscriptionDto,
  type SubscriptionFacts,
  type SubscriptionStatus,
} from '@cenario/shared';
import type { Env } from '../config/env';
import { listPriceCents, platformConfig } from './platform-config';

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

/**
 * Painel da plataforma (2026-11-25): a tolerância (dias até bloquear) vem do painel. O parâmetro
 * `env` fica por compatibilidade das chamadas.
 */
export function statusOf(
  c: CompanyBillingRow,
  _env?: unknown,
  now = new Date(),
): SubscriptionStatus {
  return subscriptionStatus(factsOf(c), now, platformConfig().graceDays);
}

/**
 * Cobrança ligada: pelo servidor (BILLING_ENABLED, com o Asaas) ou pelo "bloqueio automático" do
 * painel da plataforma (cobrança feita pelo dono, por PIX).
 */
export function billingOn(env: Pick<Env, 'BILLING_ENABLED'>): boolean {
  return env.BILLING_ENABLED || platformConfig().autoBlock;
}

/** Bloqueio por falta de pagamento: só com a cobrança ligada e passada a tolerância. */
export function billingLocked(
  c: CompanyBillingRow,
  env: Pick<Env, 'BILLING_ENABLED'>,
  now = new Date(),
): boolean {
  // Cortesia (marcada no painel) nunca é bloqueada: statusOf devolve CORTESIA.
  return billingOn(env) && statusOf(c, env, now) === 'VENCIDA';
}

export function blocksAt(c: CompanyBillingRow, _env?: unknown): Date | null {
  const end = accessEndsAt(factsOf(c));
  if (!end) return null;
  const grace = c.paidUntil ? platformConfig().graceDays * 86_400_000 : 0;
  return new Date(end.getTime() + grace);
}

export function plansCatalog(): SubscriptionDto['plans'] {
  return Object.values(PLANS).map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    monthlyCents: listPriceCents(p.key, 'MENSAL'),
    annualCents: listPriceCents(p.key, 'ANUAL'),
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
export const billingEnvironment = () => ({
  BILLING_ENABLED: billingOn(currentBillingEnv),
  BILLING_GRACE_DAYS: platformConfig().graceDays,
});
