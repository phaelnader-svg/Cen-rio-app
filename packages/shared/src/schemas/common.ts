import { z } from 'zod';

export const idSchema = z.string().uuid({ message: 'Identificador inválido.' });

export const versionSchema = z
  .number({ message: 'Versão obrigatória para controle de concorrência.' })
  .int()
  .min(1);

export const trimmed = (min: number, max: number, label: string) =>
  z
    .string({ message: `${label} é obrigatório.` })
    .trim()
    .min(min, { message: `${label} deve ter ao menos ${min} caractere(s).` })
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
