import { z } from 'zod';
import { BILLING_CYCLES, PLAN_KEYS } from '../billing';
import { EMAIL_MAX, SIGNUP_PASSWORD_MIN } from './auth';

/**
 * Conta: confirmação de e-mail, "esqueci minha senha" e assinatura (melhorias 3, 4 e 1).
 * A senha nova segue a mesma regra do Criar conta.
 */
const email = z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX);
/** Resposta da verificação anti-robô (Cloudflare Turnstile); vazia quando não configurada. */
const captcha = z.string().max(4096).optional();
const token = z.string().trim().min(20).max(200);

export const forgotPasswordSchema = z.object({ email, captcha });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token,
    password: z
      .string()
      .min(SIGNUP_PASSWORD_MIN, {
        message: `A senha deve ter ao menos ${SIGNUP_PASSWORD_MIN} caracteres.`,
      })
      .max(128, { message: 'A senha deve ter no máximo 128 caracteres.' }),
    passwordConfirm: z.string().max(128),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    path: ['passwordConfirm'],
    message: 'As senhas não conferem.',
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const confirmEmailSchema = z.object({ token });

export const subscribeSchema = z.object({
  plan: z.enum(PLAN_KEYS),
  cycle: z.enum(BILLING_CYCLES),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;

/** Painel do dono: plano, cortesia e pagamento registrado à mão (Pix direto, por exemplo). */
export const platformSubscriptionSchema = z.object({
  plan: z.enum(PLAN_KEYS).optional(),
  cycle: z.enum(BILLING_CYCLES).optional(),
  courtesy: z.boolean().optional(),
  /** Estende o pago-até (pagamento recebido fora do sistema). AAAA-MM-DD. */
  paidUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Estende o teste grátis até esta data. AAAA-MM-DD. */
  trialEndsAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type PlatformSubscriptionInput = z.infer<typeof platformSubscriptionSchema>;

/** Campos extras do Criar conta: anti-robô (Turnstile) e campo-isca invisível. */
export const signupExtrasSchema = z.object({
  captcha,
  /** Campo-isca: escondido na tela; só robô preenche. */
  website: z.string().max(200).optional(),
});
