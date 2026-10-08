import { z } from 'zod';
import { optionalText, trimmed } from './common';

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Horário deve estar no formato HH:MM.' });

const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const WEEKDAYS = [
  { value: 0, label: 'Domingo' },
  { value: 1, label: 'Segunda-feira' },
  { value: 2, label: 'Terça-feira' },
  { value: 3, label: 'Quarta-feira' },
  { value: 4, label: 'Quinta-feira' },
  { value: 5, label: 'Sexta-feira' },
  { value: 6, label: 'Sábado' },
] as const;

export const companySettingsSchema = z
  .object({
    tradeName: trimmed(2, 120, 'Nome fantasia'),
    legalName: optionalText(160),
    document: z
      .string()
      .trim()
      .max(20)
      .regex(/^[\d./-]*$/, { message: 'CNPJ contém caracteres inválidos.' })
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    phone: optionalText(30),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine((v) => v === '' || z.string().email().safeParse(v).success, {
        message: 'E-mail inválido.',
      })
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    address: optionalText(240),
    timezone: z
      .string()
      .min(3)
      .max(64)
      .refine(
        (tz) => {
          try {
            new Intl.DateTimeFormat('pt-BR', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'Fuso horário inválido.' },
      ),
    workdayStart: timeSchema,
    arrivalAlertAt: timeSchema,
    workdayEnd: timeSchema,
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    planningWeekday: z.number().int().min(0).max(6),
    measurementWeekday: z.number().int().min(0).max(6),
    version: z.number().int().min(1),
  })
  .refine((v) => toMinutes(v.arrivalAlertAt) > toMinutes(v.workdayStart), {
    message: 'O limite de alerta de chegada deve ser posterior ao início do expediente.',
    path: ['arrivalAlertAt'],
  })
  .refine((v) => toMinutes(v.workdayEnd) > toMinutes(v.arrivalAlertAt), {
    message: 'O fim do expediente deve ser posterior ao limite de alerta de chegada.',
    path: ['workdayEnd'],
  });
export type CompanySettingsInput = z.input<typeof companySettingsSchema>;
