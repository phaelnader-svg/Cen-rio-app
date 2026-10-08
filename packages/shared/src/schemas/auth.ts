import { z } from 'zod';

export const EMAIL_MAX = 254;

export const passwordPolicySchema = z
  .string()
  .min(10, { message: 'A senha deve ter ao menos 10 caracteres.' })
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
  employeeId: z.string().uuid({ message: 'Selecione um funcionário.' }),
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
