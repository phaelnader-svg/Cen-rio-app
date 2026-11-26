import { plural } from '../text';
import { z } from 'zod';

export const idSchema = z.guid({ message: 'Identificador inválido.' });

export const versionSchema = z
  .number({ message: 'Versão obrigatória para controle de concorrência.' })
  .int()
  .min(1);

export const trimmed = (min: number, max: number, label: string) =>
  z
    .string({ message: `${label} é obrigatório.` })
    .trim()
    .min(min, { message: `${label} deve ter ao menos ${plural(min, 'caractere', 'caracteres')}.` })
    .max(max, { message: `${label} deve ter no máximo ${max} caracteres.` });

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: 'Cor deve estar no formato #RRGGBB.' });

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

/** Só os dígitos do WhatsApp brasileiro (DDD + número), sem o 0 nem o 55 da frente. */
export function whatsappDigits(v: string | null | undefined): string {
  let d = String(v ?? '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d;
}

/**
 * Tem um celular com DDD que dá para chamar no WhatsApp: DDD + 9 números, começando com 9
 * (decisão do dono, 26/11/2026).
 */
export function hasWhatsapp(v: string | null | undefined): boolean {
  const d = whatsappDigits(v);
  return d.length === 11 && d[2] === '9';
}

/** "(11) 98765-4321" — como o número fica gravado e aparece no painel. */
export function formatWhatsapp(v: string | null | undefined): string {
  const d = whatsappDigits(v);
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return String(v ?? '').trim();
}

/** Telefone (celular) obrigatório ao entrar no sistema (26/11/2026). */
export const whatsappSchema = z
  .string({ message: 'Escreva o celular com DDD.' })
  .trim()
  .max(30, { message: 'Escreva o celular com DDD.' })
  .refine((v) => hasWhatsapp(v), {
    message: 'Escreva o celular com DDD e 9 números. Ex.: (11) 98765-4321.',
  })
  .transform((v) => formatWhatsapp(v));
