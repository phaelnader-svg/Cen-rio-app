import { z } from 'zod';
import { MATERIAL_KINDS, MATERIAL_SOURCINGS, MEASUREMENT_KINDS } from '../domain';
import {
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_UNITS,
  MEASUREMENT_STATUSES,
  unitError,
} from '../measurements-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data deve estar no formato AAAA-MM-DD.' })
  .refine((v) => !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime()), {
    message: 'Data inválida.',
  });

const cm = z.number().positive({ message: 'Medida deve ser maior que zero.' }).max(10_000);

export const createMeasurementSchema = z
  .object({
    serviceOrderId: idSchema,
    /** Peça específica; ausente = OS inteira. */
    serviceOrderItemId: idSchema.nullable().optional(),
    kind: z.enum(MEASUREMENT_KINDS),
    assigneeUserId: idSchema,
    dueDate: dateOnly,
    reason: optionalText(500),
  })
  .refine((v) => v.kind !== 'EXTRAORDINARIA' || Boolean(v.reason), {
    message: 'Informe o motivo da medição extraordinária.',
    path: ['reason'],
  });
export type CreateMeasurementInput = z.input<typeof createMeasurementSchema>;

export const assignMeasurementSchema = z.object({
  assigneeUserId: idSchema,
  dueDate: dateOnly.optional(),
  note: optionalText(300),
  version: versionSchema,
});

export const cancelMeasurementSchema = z.object({
  reason: trimmed(3, 500, 'Motivo do cancelamento'),
  version: versionSchema,
});

/** Item de material solicitado. Preço e fornecedor NÃO fazem parte da medição. */
export const materialRequestItemSchema = z
  .object({
    serviceOrderItemId: idSchema.nullable().optional(),
    kind: z.enum(MATERIAL_KINDS),
    sourcing: z.enum(MATERIAL_SOURCINGS),
    description: trimmed(2, 160, 'Descrição do material'),
    color: optionalText(60),
    reference: optionalText(80),
    foamDensity: optionalText(30),
    thicknessCm: cm.nullable().optional(),
    lengthCm: cm.nullable().optional(),
    widthCm: cm.nullable().optional(),
    quantity: z.number({ message: 'Informe a quantidade.' }),
    unit: z.enum(MATERIAL_UNITS),
    notes: optionalText(500),
  })
  .superRefine((v, ctx) => {
    const err = unitError(v.kind, v.unit, v.quantity);
    if (err)
      ctx.addIssue({
        code: 'custom',
        path: [err.includes('Unidade') ? 'unit' : 'quantity'],
        message: err,
      });
    if (v.kind === 'TECIDO' && v.sourcing !== 'EXCLUSIVO_OS') {
      ctx.addIssue({
        code: 'custom',
        path: ['sourcing'],
        message: 'Tecidos são comprados especificamente para cada OS.',
      });
    }
    if (v.kind === 'ESPUMA' && !v.foamDensity) {
      ctx.addIssue({
        code: 'custom',
        path: ['foamDensity'],
        message: 'Informe o tipo/densidade da espuma (ex.: D28).',
      });
    }
    if (v.kind === 'ESPUMA' && !v.thicknessCm) {
      ctx.addIssue({
        code: 'custom',
        path: ['thicknessCm'],
        message: 'Informe a espessura da espuma.',
      });
    }
    if (v.kind !== 'ESPUMA' && (v.foamDensity || v.thicknessCm)) {
      ctx.addIssue({
        code: 'custom',
        path: ['foamDensity'],
        message: 'Densidade e espessura são exclusivas de espumas.',
      });
    }
  });
export type MaterialRequestItemInput = z.input<typeof materialRequestItemSchema>;

export const pieceMeasurementSchema = z.object({
  serviceOrderItemId: idSchema,
  dimensions: z
    .array(z.object({ label: trimmed(1, 60, 'Identificação da medida'), valueCm: cm }))
    .max(40),
  notes: optionalText(1000),
});

export const saveMeasurementDraftSchema = z.object({
  pieces: z.array(pieceMeasurementSchema).max(50).default([]),
  items: z.array(materialRequestItemSchema).max(100).default([]),
  notes: optionalText(2000),
  version: versionSchema,
});
export type SaveMeasurementDraftInput = z.input<typeof saveMeasurementDraftSchema>;

export const submitMeasurementSchema = z.object({ version: versionSchema });

export const reviseRequestSchema = z.object({
  items: z.array(materialRequestItemSchema).min(1).max(100),
  reason: trimmed(3, 300, 'Motivo da revisão'),
  version: versionSchema,
});

export const requestDecisionSchema = z.object({
  note: optionalText(500),
  version: versionSchema,
});

export const returnRequestSchema = z.object({
  reason: trimmed(3, 500, 'Motivo da devolução'),
  version: versionSchema,
});

export const measurementQuerySchema = z.object({
  status: z
    .string()
    .max(200)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(MEASUREMENT_STATUSES)))
    .optional(),
  requestStatus: z
    .string()
    .max(200)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(MATERIAL_REQUEST_STATUSES)))
    .optional(),
  kind: z.enum(MEASUREMENT_KINDS).optional(),
  assigneeUserId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
  customerId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const periodQuerySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
