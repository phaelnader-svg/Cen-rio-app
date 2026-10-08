import { z } from 'zod';
import { PIECE_TYPES, PRIORITIES } from '../domain';
import {
  PAUSE_REASONS,
  PRODUCTION_ACTIVITIES,
  TASK_ROLES,
  TASK_STATUSES,
} from '../production-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data deve estar no formato AAAA-MM-DD.' });
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Horário no formato HH:MM.' });
const reason = (label = 'Motivo') => trimmed(3, 500, label);
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(300)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)))
    .optional();

// ─────────────────────────── Modelos ───────────────────────────

export const templateStepSchema = z.object({
  activity: z.enum(PRODUCTION_ACTIVITIES),
  name: trimmed(2, 80, 'Nome da etapa'),
  role: z.enum(TASK_ROLES).default('APOIO'),
  requiresMaterials: z.boolean().default(false),
  optional: z.boolean().default(false),
  /** Posições (1, 2, …) das etapas anteriores de que esta depende. */
  dependsOn: z.array(z.number().int().min(1)).max(20).default([]),
});

export const templateSchema = z
  .object({
    name: trimmed(2, 80, 'Nome do modelo'),
    pieceTypes: z.array(z.enum(PIECE_TYPES)).max(10).default([]),
    active: z.boolean().default(true),
    steps: z.array(templateStepSchema).min(1).max(30),
  })
  .superRefine((v, ctx) => {
    v.steps.forEach((s, i) => {
      if (s.dependsOn.some((d) => d >= i + 1)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'dependsOn'],
          message: 'Uma etapa só pode depender de etapas anteriores.',
        });
      }
    });
  });
export type TemplateInput = z.input<typeof templateSchema>;
export const updateTemplateSchema = z.object({ version: versionSchema }).and(templateSchema);

// ─────────────────────────── Planejamento ───────────────────────────

export const createPlanSchema = z.object({ weekStart: dateOnly, notes: optionalText(1000) });

export const addPlanItemSchema = z.object({
  serviceOrderId: idSchema,
  principalUserId: idSchema.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  /** Gera as tarefas a partir dos modelos de cada peça (padrão: sim). */
  generate: z.boolean().default(true),
  reason: optionalText(500),
});

export const updatePlanItemSchema = z.object({
  principalUserId: idSchema.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  reason: optionalText(500),
});

export const createTaskSchema = z.object({
  serviceOrderId: idSchema,
  serviceOrderItemId: idSchema.nullable().optional(),
  activity: z.enum(PRODUCTION_ACTIVITIES),
  title: optionalText(120),
  role: z.enum(TASK_ROLES).default('APOIO'),
  assigneeUserId: idSchema.nullable().optional(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  date: dateOnly.nullable().optional(),
  time: time.nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
  instructions: optionalText(2000),
  requiresMaterials: z.boolean().default(false),
  dependsOn: z.array(idSchema).max(20).default([]),
  reason: optionalText(500),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: optionalText(120),
  role: z.enum(TASK_ROLES).optional(),
  assigneeUserId: idSchema.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  date: dateOnly.nullable().optional(),
  time: time.nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
  instructions: optionalText(2000),
  requiresMaterials: z.boolean().optional(),
  /** Obrigatório depois da publicação (histórico da revisão). */
  reason: optionalText(500),
  version: versionSchema,
});
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;

export const taskDependenciesSchema = z.object({
  dependsOn: z.array(idSchema).max(20),
  reason: optionalText(500),
  version: versionSchema,
});

export const publishPlanSchema = z.object({
  notes: optionalText(1000),
  version: versionSchema,
});

export const taskReasonSchema = z.object({ reason: reason(), version: versionSchema.optional() });

// ─────────────────────────── Execução ───────────────────────────

export const pauseTaskSchema = z
  .object({ reason: z.enum(PAUSE_REASONS), note: optionalText(300) })
  .refine((v) => v.reason !== 'OUTRO' || Boolean(v.note), {
    message: 'Descreva o motivo.',
    path: ['note'],
  });

export const progressTaskSchema = z.object({
  note: trimmed(2, 500, 'Andamento'),
  percent: z.number().int().min(0).max(100).nullable().optional(),
});

export const boardQuerySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  assigneeUserId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
  planId: idSchema.optional(),
  status: csv(TASK_STATUSES),
  activity: z.enum(PRODUCTION_ACTIVITIES).optional(),
});
