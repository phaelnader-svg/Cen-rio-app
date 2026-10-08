import { z } from 'zod';
import { ATTENDANCE_ACTIONS } from '../attendance-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM.');

/** Andamento opcional de uma tarefa ao encerrar o expediente (nada é obrigatório). */
export const departureTaskSchema = z.object({
  taskId: idSchema,
  note: optionalText(500),
  percent: z.number().int().min(0).max(100).nullable().optional(),
  step: optionalText(200),
  nextStep: optionalText(200),
});

export const departSchema = z.object({
  tasks: z.array(departureTaskSchema).max(30).default([]),
  /** Observação geral do dia (opcional). */
  note: optionalText(500),
});
export type DepartInput = z.input<typeof departSchema>;

export const teamQuerySchema = z.object({
  date: dateOnly.optional(),
  employeeId: idSchema.optional(),
});

export const historyQuerySchema = z.object({
  employeeId: idSchema,
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

/**
 * Registro/correção do gestor. Sempre com motivo (preserva o histórico original).
 * Atestado: só o fato informado — nunca CID, diagnóstico ou dados médicos.
 */
export const attendanceActionSchema = z
  .object({
    employeeId: idSchema,
    date: dateOnly,
    action: z.enum(ATTENDANCE_ACTIONS),
    reason: trimmed(3, 300, 'Justificativa'),
    /** Horário de chegada/saída (HH:MM, fuso da empresa) para chegada tardia, esquecimento e correção. */
    arrivalTime: time.nullable().optional(),
    departureTime: time.nullable().optional(),
    /** Descrição curta da atividade externa. */
    externalNote: optionalText(200),
    version: versionSchema.optional(),
  })
  .refine((v) => !['CHEGADA_TARDIA', 'ESQUECIMENTO'].includes(v.action) || Boolean(v.arrivalTime), {
    message: 'Informe o horário de chegada.',
    path: ['arrivalTime'],
  })
  .refine((v) => v.action !== 'SAIDA_ANTECIPADA' || Boolean(v.departureTime), {
    message: 'Informe o horário de saída.',
    path: ['departureTime'],
  })
  .refine((v) => v.action !== 'TRABALHO_EXTERNO' || Boolean(v.externalNote), {
    message: 'Descreva a atividade externa.',
    path: ['externalNote'],
  });
export type AttendanceActionInput = z.input<typeof attendanceActionSchema>;

export const resolveImpactSchema = z.object({ resolution: trimmed(3, 300, 'Encaminhamento') });
