import { z } from 'zod';
import { HELP_KINDS, HELP_STATUSES, PROPOSAL_STATUSES, SKILLS } from '../help-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM.');

/**
 * Pedido de ajuda numa tarefa própria. A duração é opcional (vale a sugestão do tipo).
 * "Preciso de ajuda agora" (urgente) exige uma justificativa curta.
 */
export const createHelpRequestSchema = z
  .object({
    taskId: idSchema,
    kind: z.enum(HELP_KINDS, { message: 'Escolha o tipo de apoio.' }),
    estimatedMinutes: z.number().int().min(5).max(240).optional(),
    urgent: z.boolean().default(false),
    justification: optionalText(300),
    note: optionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.urgent && (!v.justification || v.justification.length < 5)) {
      ctx.addIssue({
        code: 'custom',
        path: ['justification'],
        message: 'Ajuda urgente: diga em poucas palavras por que é urgente.',
      });
    }
  });
export type CreateHelpRequestInput = z.input<typeof createHelpRequestSchema>;

export const cancelHelpRequestSchema = z.object({
  reason: optionalText(300),
  version: versionSchema.optional(),
});

export const helpListQuerySchema = z.object({
  status: z.enum(HELP_STATUSES).optional(),
});

export const updateSkillsSchema = z.object({
  skills: z.array(z.enum(SKILLS)).max(SKILLS.length),
});

export const proposalListQuerySchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
});

export const approveProposalSchema = z.object({
  alternativeId: z.string().max(40).optional(),
  note: optionalText(500),
  version: versionSchema.optional(),
});

export const rejectProposalSchema = z.object({
  note: trimmed(3, 500, 'Motivo'),
  version: versionSchema.optional(),
});

/** Aprovação com ajuste: troca responsável ou data/hora de tarefas da alternativa escolhida. */
export const adjustProposalSchema = z.object({
  alternativeId: z.string().max(40),
  overrides: z
    .array(
      z.object({
        taskId: idSchema,
        toUserId: idSchema.nullable().optional(),
        toDate: dateOnly.nullable().optional(),
        toTime: time.nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  note: trimmed(3, 500, 'Motivo do ajuste'),
  version: versionSchema.optional(),
});

export const planningActionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  automatic: z.enum(['true', 'false']).optional(),
});

/** Relógio de teste (só existe com ENABLE_TEST_CLOCK em APP_ENV=test). */
export const testClockSchema = z.object({
  now: z.string().datetime({ offset: true }).nullable(),
});
