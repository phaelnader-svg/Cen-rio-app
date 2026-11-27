import { z } from 'zod';
import { optionalText, trimmed, whatsappSchema } from './common';

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
    /** Fase 7: início da janela do botão "Cheguei". */
    arrivalWindowStart: timeSchema.default('07:00'),
    /** Fase 7: atraso (min) a partir do qual o gestor é avisado. */
    lateAlertMinutes: z.number().int().min(0).max(240).default(15),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    planningWeekday: z.number().int().min(0).max(6),
    measurementWeekday: z.number().int().min(0).max(6),
    /** 26/11/2026: atende na casa do cliente ("No local" nas retiradas). */
    servesOnSite: z.boolean().optional(),
    /** 26/11/2026: quanto quer faturar por mês (centavos). Vazio = sem meta. */
    monthlyGoalCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((v) => toMinutes(v.arrivalWindowStart) <= toMinutes(v.workdayStart), {
    message: 'A janela do “Cheguei” deve começar até o início previsto do expediente.',
    path: ['arrivalWindowStart'],
  })
  .refine((v) => toMinutes(v.arrivalAlertAt) > toMinutes(v.workdayStart), {
    message: 'O limite de alerta de chegada deve ser posterior ao início do expediente.',
    path: ['arrivalAlertAt'],
  })
  .refine((v) => toMinutes(v.workdayEnd) > toMinutes(v.arrivalAlertAt), {
    message: 'O fim do expediente deve ser posterior ao limite de alerta de chegada.',
    path: ['workdayEnd'],
  });
/** Nome provisório de toda empresa criada pelo Criar conta (as boas-vindas pedem o nome real). */
export const PROVISIONAL_TRADE_NAME = 'Minha empresa';

/** Boas-vindas do primeiro acesso: nome da empresa e de quem criou a conta. */
export const companyWelcomeSchema = z
  .object({
    tradeName: trimmed(2, 120, 'Nome da empresa').refine((v) => v !== PROVISIONAL_TRADE_NAME, {
      message: 'Escreva o nome da sua empresa.',
    }),
    displayName: trimmed(2, 40, 'Seu nome'),
    whatsapp: whatsappSchema.optional(),
  })
  .strict();
/** Empresa antiga sem WhatsApp: o gestor informa ao entrar (uma vez). */
export const companyContactSchema = z.object({ whatsapp: whatsappSchema }).strict();
export type CompanyContactInput = z.input<typeof companyContactSchema>;

export type CompanyWelcomeInput = z.input<typeof companyWelcomeSchema>;

export type CompanySettingsInput = z.input<typeof companySettingsSchema>;
