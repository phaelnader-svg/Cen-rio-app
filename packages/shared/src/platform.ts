import { z } from 'zod';
import { BILLING_CYCLES, PLAN_KEYS, type BillingCycle, type PlanKey } from './billing';
import type { SubscriptionStatus } from './billing';
import { EMAIL_MAX, passwordPolicySchema } from './schemas/auth';

/**
 * Painel da plataforma (/plataforma, 2026-11-25): o painel do dono do Cenário Gestão como
 * produto, separado do login das empresas. Abas: Início, Empresas, Cobrança, Planos e preços,
 * Como eu recebo, Avisos e pedidos, Minha conta.
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida.' })
  .nullable()
  .optional();
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `No máximo ${max} caracteres.` })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const cents = z.number().int().min(100, { message: 'Valor muito baixo.' }).max(10_000_000);

export const platformLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
  password: z.string().min(1, { message: 'Informe a senha.' }).max(128),
});

export const platformPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, { message: 'Informe a senha atual.' }).max(128),
    newPassword: passwordPolicySchema,
    newPasswordConfirm: z.string().max(128),
  })
  .refine((v) => v.newPassword === v.newPasswordConfirm, {
    message: 'As senhas não conferem.',
    path: ['newPasswordConfirm'],
  });

/** Planos e preços + Como eu recebo (um formulário por aba; tudo opcional). */
export const platformSettingsSchema = z.object({
  priceGestaoCents: cents.optional(),
  priceJogoCents: cents.optional(),
  annualDiscountPct: z.number().int().min(0).max(90).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  graceDays: z.number().int().min(0).max(60).optional(),
  noticeDays: z.number().int().min(0).max(30).optional(),
  autoBlock: z.boolean().optional(),
  pixKey: optText(140),
  pixName: optText(120),
  pixBank: optText(80),
  whatsapp: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || (v.length >= 10 && v.length <= 13), {
      message: 'WhatsApp com DDD, só números (ex.: 12 99652-0615).',
    })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  paymentMessage: optText(500),
});
export type PlatformSettingsInput = z.infer<typeof platformSettingsSchema>;

export interface PlatformSettingsDto {
  priceGestaoCents: number;
  priceJogoCents: number;
  annualDiscountPct: number;
  trialDays: number;
  graceDays: number;
  noticeDays: number;
  autoBlock: boolean;
  pixKey: string | null;
  pixName: string | null;
  pixBank: string | null;
  whatsapp: string | null;
  paymentMessage: string | null;
  /** Empresas que ficariam bloqueadas na hora se o bloqueio automático fosse ligado agora. */
  wouldBlockNow: { id: number; tradeName: string }[];
  emailEnabled: boolean;
}

/** Editar uma empresa (aba Empresas). */
export const platformCompanyEditSchema = z.object({
  tradeName: z.string().trim().min(2, { message: 'Informe o nome.' }).max(120).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(EMAIL_MAX)
    .refine((v) => v === '' || z.string().email().safeParse(v).success, {
      message: 'E-mail inválido.',
    })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  phone: optText(30),
  document: optText(20),
  plan: z.enum(PLAN_KEYS).optional(),
  cycle: z.enum(BILLING_CYCLES).optional(),
  courtesy: z.boolean().optional(),
  /** Liberar as conexões do servidor (WhatsApp, Instagram, cobrança e notas): uma empresa só. */
  serverConnections: z.boolean().optional(),
  /** Valor combinado por ciclo, em centavos. `null` = preço da tabela. */
  billingPriceCents: cents.nullable().optional(),
  paidUntil: day,
  trialEndsAt: day,
  note: optText(500),
});
export type PlatformCompanyEditInput = z.infer<typeof platformCompanyEditSchema>;

/** Cadastrar empresa (o dono da plataforma cria a conta para o cliente). */
export const platformCompanyCreateSchema = z.object({
  tradeName: z.string().trim().min(2, { message: 'Informe o nome da empresa.' }).max(120),
  ownerName: z.string().trim().min(2, { message: 'Informe o nome de quem vai usar.' }).max(80),
  email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
  phone: optText(30),
  plan: z.enum(PLAN_KEYS),
  cycle: z.enum(BILLING_CYCLES),
  /** Dias de teste grátis (0 = já começa pagando). */
  trialDays: z.number().int().min(0).max(90),
  billingPriceCents: cents.nullable().optional(),
});
export type PlatformCompanyCreateInput = z.infer<typeof platformCompanyCreateSchema>;

/** "Recebi o pagamento" (aba Cobrança). */
export const platformPaymentSchema = z.object({
  amountCents: cents,
  /** Dia em que recebeu (AAAA-MM-DD). */
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Ciclos pagos (1 = um mês no mensal, um ano no anual). */
  cycles: z.number().int().min(1).max(12).default(1),
  /** Libera também o bloqueio feito à mão. */
  unblock: z.boolean().default(true),
  note: optText(200),
});
export type PlatformPaymentInput = z.infer<typeof platformPaymentSchema>;

export type PlatformDueTone = 'ok' | 'soon' | 'late' | 'blocked' | 'trial' | 'courtesy';

export interface PlatformCompanyDto {
  id: number;
  tradeName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerEmailConfirmed: boolean;
  email: string | null;
  phone: string | null;
  document: string | null;
  note: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  users: number;
  orders: number;
  lastOrderAt: string | null;
  /** Usa as conexões do servidor (liberado no painel; no máximo uma empresa). */
  serverConnections: boolean;
  isDemo: boolean;
  blockedAt: string | null;
  blockedReason: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  pausedUntil: string | null;
  supportAccessUntil: string | null;
  plan: PlanKey;
  planLabel: string;
  cycle: BillingCycle;
  courtesy: boolean;
  trialEndsAt: string | null;
  paidUntil: string | null;
  status: SubscriptionStatus;
  /** Próximo vencimento (fim do teste ou pago até). */
  dueAt: string | null;
  /** Dia em que o sistema bloqueia sozinho (com o bloqueio automático ligado). */
  blocksAt: string | null;
  /** Dias até o vencimento (negativo = atrasado). */
  daysToDue: number | null;
  tone: PlatformDueTone;
  /** O que ela paga por ciclo (valor combinado ou tabela). */
  priceCents: number;
  /** Valor combinado (null = tabela). */
  billingPriceCents: number | null;
  /** Quanto ela já pagou no total. */
  paidTotalCents: number;
  lastPaymentAt: string | null;
  /** Link do WhatsApp do dono da empresa com a cobrança pronta (null = sem telefone). */
  chargeWhatsappUrl: string | null;
}

export interface PlatformPaymentDto {
  id: string;
  companyId: number;
  tradeName: string;
  amountCents: number;
  receivedOn: string;
  periodEnd: string | null;
  plan: PlanKey;
  cycle: BillingCycle;
  provider: string;
}

export interface PlatformDashboardDto {
  /** Receita por mês (contratos ativos, anual dividido por 12). */
  mrrCents: number;
  paying: number;
  trial: number;
  courtesy: number;
  late: number;
  blocked: number;
  newThisMonth: number;
  receivedThisMonthCents: number;
  dueNext7Cents: number;
  dueNext7: { id: number; tradeName: string; dueAt: string; priceCents: number }[];
  lateList: { id: number; tradeName: string; dueAt: string; priceCents: number; days: number }[];
  trialEnding: { id: number; tradeName: string; trialEndsAt: string }[];
  /** Recebido por mês, dos últimos 12 meses (AAAA-MM). */
  byMonth: { month: string; cents: number }[];
  autoBlock: boolean;
  pixConfigured: boolean;
}

export interface PlatformMeDto {
  id: string;
  email: string;
  displayName: string;
}

export interface PlatformAuditDto {
  id: string;
  at: string;
  action: string;
  summary: string;
  by: string | null;
}

/** Como o cliente paga, mostrado na assinatura e na tela "Seu teste acabou". */
export interface ManualPaymentDto {
  pixKey: string | null;
  pixName: string | null;
  pixBank: string | null;
  /** Link do WhatsApp do Cenário Gestão com a mensagem pronta. */
  whatsappUrl: string | null;
  message: string | null;
  /** O valor desta empresa por ciclo. */
  amountCents: number;
}

/** "Esqueci a senha" do painel da plataforma. */
export const platformForgotSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
});

export const platformResetSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: passwordPolicySchema,
    passwordConfirm: z.string().max(128),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: 'As senhas não conferem.',
    path: ['passwordConfirm'],
  });
