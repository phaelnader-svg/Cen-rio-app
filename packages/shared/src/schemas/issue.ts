import { z } from 'zod';
import {
  ATTENTION_CATEGORIES,
  ATTENTION_TYPES,
  ISSUE_IMPACTS,
  ISSUE_KINDS,
  ISSUE_STATUSES,
} from '../issue-domain';
import { SKILLS } from '../help-domain';
import { MATERIAL_UNITS } from '../measurements-domain';
import { PRIORITIES } from '../domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');

/**
 * "Tenho um problema" no tablet. OS, funcionário, dispositivo e horário são registrados pelo
 * servidor. Falta de material: material, quantidade e unidade. Outro impedimento: só a
 * descrição e se consegue continuar trabalhando.
 */
export const openIssueSchema = z
  .object({
    taskId: idSchema,
    kind: z.enum(ISSUE_KINDS, { message: 'Escolha o tipo de problema.' }),
    description: optionalText(1000),
    impact: z.enum(ISSUE_IMPACTS).optional(),
    canContinue: z.boolean().optional(),
    material: z
      .object({
        requirementId: idSchema.nullable().optional(),
        stockItemId: idSchema.nullable().optional(),
        description: optionalText(200),
        quantity: z.number().positive('Informe a quantidade.').max(100000),
        unit: z.enum(MATERIAL_UNITS, { message: 'Escolha a unidade.' }),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'OUTRO') {
      if (!v.description || v.description.length < 3)
        ctx.addIssue({ code: 'custom', path: ['description'], message: 'Descreva o problema.' });
      if (v.canContinue === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['canContinue'],
          message: 'Informe se consegue continuar trabalhando.',
        });
      return;
    }
    if (!v.impact)
      ctx.addIssue({ code: 'custom', path: ['impact'], message: 'Informe o impacto.' });
    if (v.kind === 'TECNICO' && (!v.description || v.description.length < 3))
      ctx.addIssue({ code: 'custom', path: ['description'], message: 'Descreva o problema.' });
    if (v.kind === 'MATERIAL') {
      if (!v.material)
        ctx.addIssue({ code: 'custom', path: ['material'], message: 'Informe o material.' });
      else if (!v.material.requirementId && !v.material.stockItemId && !v.material.description)
        ctx.addIssue({
          code: 'custom',
          path: ['material', 'description'],
          message: 'Escolha o material ou descreva-o.',
        });
    }
  });
export type OpenIssueInput = z.input<typeof openIssueSchema>;

export const assignIssueSchema = z.object({
  assigneeUserId: idSchema,
  instructions: trimmed(3, 300, 'O que fazer'),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  requiredSkill: z.enum(SKILLS).nullable().optional(),
  /** Confirmação explícita quando o responsável tem conflito de agenda. */
  confirmConflict: z.boolean().default(false),
  version: versionSchema.optional(),
});

export const issueNoteSchema = z.object({
  note: trimmed(3, 1000, 'Descrição'),
  version: versionSchema.optional(),
});

export const verifyIssueSchema = z.object({
  resolved: z.boolean(),
  note: trimmed(3, 1000, 'Resultado da verificação'),
  version: versionSchema.optional(),
});

export const issueListQuerySchema = z.object({
  status: z.enum(ISSUE_STATUSES).optional(),
  kind: z.enum(ISSUE_KINDS).optional(),
  taskId: idSchema.optional(),
});

export const attentionQuerySchema = z.object({
  category: z.enum(ATTENTION_CATEGORIES).optional(),
  type: z.enum(ATTENTION_TYPES).optional(),
  status: z.string().max(40).optional(),
  employeeUserId: idSchema.optional(),
  solverUserId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
  date: dateOnly.optional(),
});

/** Escolha manual do ajudante pelo gestor (Fase 9). */
export const manualHelpAssignSchema = z
  .object({
    helperUserId: idSchema,
    confirmConflict: z.boolean().default(false),
    note: optionalText(300),
    version: versionSchema.optional(),
  })
  .refine((v) => !v.confirmConflict || Boolean(v.note && v.note.length >= 3), {
    path: ['note'],
    message: 'Explique por que aprova o conflito.',
  });
