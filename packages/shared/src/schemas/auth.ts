import { z } from 'zod';
import { trimmed, whatsappSchema } from './common';
import { PROVISIONAL_TRADE_NAME } from './company';

export const EMAIL_MAX = 254;

/** Regra única de senha do painel (Criar conta, Minha conta e funcionários). */
export const PASSWORD_MIN = 8;
export const PASSWORD_RULE_HINT = `Mínimo de ${PASSWORD_MIN} caracteres, com letras e números.`;

export const passwordPolicySchema = z
  .string()
  .min(PASSWORD_MIN, { message: `A senha deve ter ao menos ${PASSWORD_MIN} caracteres.` })
  .max(128, { message: 'A senha deve ter no máximo 128 caracteres.' })
  .refine((v) => /[A-Za-zÀ-ÿ]/.test(v) && /\d/.test(v), {
    message: 'A senha deve conter letras e números.',
  });

export const pinSchema = z
  .string()
  .regex(/^\d{6}$/, { message: 'O PIN deve ter exatamente 6 dígitos.' })
  .refine((v) => !/^(\d)\1{5}$/.test(v) && !['123456', '654321', '012345'].includes(v), {
    message: 'PIN muito simples. Evite sequências ou dígitos repetidos.',
  });

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
  password: z.string().min(1, { message: 'Informe a senha.' }).max(128),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const tabletLoginSchema = z.object({
  employeeId: z.guid({ message: 'Selecione um funcionário.' }),
  pin: z.string().regex(/^\d{6}$/, { message: 'O PIN deve ter 6 dígitos.' }),
});
export type TabletLoginInput = z.infer<typeof tabletLoginSchema>;

/** Código de vinculação: 8 caracteres de um alfabeto sem ambiguidades, exibido como XXXX-XXXX. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const pairDeviceSchema = z.object({
  code: z
    .string()
    .transform(normalizePairingCode)
    .refine((v) => v.length === 8 && [...v].every((c) => PAIRING_ALPHABET.includes(c)), {
      message: 'Código de vinculação inválido.',
    }),
});
export type PairDeviceInput = z.infer<typeof pairDeviceSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordPolicySchema,
});

/** Senha de quem cria a própria conta pela tela de entrar: a mesma regra do resto do painel. */
export const SIGNUP_PASSWORD_MIN = PASSWORD_MIN;

/**
 * Criar conta (tela /entrar). Multi-empresa: cada conta criada é uma empresa nova, e quem cria
 * entra direto como gestor dela.
 */
export const signupSchema = z
  .object({
    // Decisão do dono (26/11/2026): nome da empresa e de quem cria vêm do próprio cadastro.
    companyName: trimmed(2, 120, 'Nome da empresa').refine((v) => v !== PROVISIONAL_TRADE_NAME, {
      message: 'Escreva o nome da sua empresa.',
    }),
    ownerName: trimmed(2, 40, 'Seu nome'),
    // O telefone não é pedido no cadastro: a janela ao entrar no sistema pede (decisão do dono,
    // 26/11/2026). Se vier (outras telas), é conferido.
    whatsapp: z.preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      whatsappSchema.optional(),
    ),
    email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
    password: passwordPolicySchema,
    passwordConfirm: z.string().max(128),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: 'As senhas não conferem.',
    path: ['passwordConfirm'],
  });
export type SignupInput = z.infer<typeof signupSchema>;
