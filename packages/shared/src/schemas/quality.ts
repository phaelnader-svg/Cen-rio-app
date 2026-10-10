import { z } from 'zod';
import { PICKUP_TEAMS, PIECE_TYPES, PRIORITIES, SERVICE_TYPES } from '../domain';
import {
  CHECK_RESULTS,
  DELIVERY_STATUSES,
  FULFILLMENT_STAGES,
  INSPECTION_STATUSES,
  LOGISTICS_KINDS,
  LOGISTICS_STATUSES,
  PROTECTIONS,
} from '../quality-domain';
import { customerAddressSchema } from './commercial';
import { idSchema, optionalText, trimmed, versionSchema } from './common';
import { tripCostInputSchema } from './finance';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const timeOnly = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário no formato HH:MM.');
const reason = (label = 'Motivo') => trimmed(3, 500, label);

// ─────────────────────────── Inspeções ───────────────────────────

export const inspectionQuerySchema = z.object({
  status: z.enum(INSPECTION_STATUSES).optional(),
  /** "open" = pendentes e em andamento. */
  scope: z.enum(['open', 'all', 'mine']).default('open'),
  serviceOrderId: idSchema.optional(),
  serviceOrderItemId: idSchema.optional(),
});

export const startInspectionSchema = z.object({ version: versionSchema });

/** Marca um item do checklist (null limpa a conferência). */
export const checkInspectionItemSchema = z
  .object({
    result: z.enum(CHECK_RESULTS).nullable(),
    note: optionalText(500),
  })
  .refine((v) => v.result !== 'NAO_CONFORME' || Boolean(v.note && v.note.length >= 3), {
    path: ['note'],
    message: 'Descreva o defeito encontrado.',
  });

export const approveInspectionSchema = z.object({
  note: optionalText(1000),
  version: versionSchema,
});

export const rejectInspectionSchema = z.object({
  reason: trimmed(3, 1000, 'Motivo da reprovação'),
  correction: z
    .object({
      /** Vazio = tapeceiro principal da peça (ou quem executou o serviço). */
      assigneeUserId: idSchema.nullable().optional(),
      priority: z.enum(PRIORITIES).optional(),
      dueDate: dateOnly.nullable().optional(),
      instructions: optionalText(500),
    })
    .default({}),
  version: versionSchema,
});

/** Gestor: designa o inspetor (substituto) e, se for o executor, autoriza explicitamente. */
export const assignInspectorSchema = z
  .object({
    inspectorUserId: idSchema,
    reason: optionalText(300),
    authorizeExecutor: z.boolean().default(false),
    version: versionSchema,
  })
  .refine((v) => !v.authorizeExecutor || Boolean(v.reason && v.reason.length >= 3), {
    path: ['reason'],
    message: 'Justifique a autorização para quem executou o serviço.',
  });

export const qualitySettingsSchema = z.object({
  qualityInspectorUserId: idSchema.nullable(),
});

export const qualityTemplateSchema = z.object({
  name: trimmed(2, 80, 'Nome do checklist'),
  pieceTypes: z.array(z.enum(PIECE_TYPES)).min(1, 'Escolha ao menos um tipo de peça.').max(20),
  active: z.boolean().default(true),
  items: z
    .array(
      z.object({
        label: trimmed(2, 120, 'Item'),
        guidance: optionalText(300),
        required: z.boolean().default(true),
        serviceTypes: z.array(z.enum(SERVICE_TYPES)).max(20).default([]),
      }),
    )
    .min(1, 'Inclua ao menos um item no checklist.')
    .max(40),
  version: versionSchema.optional(),
});
export type QualityTemplateInput = z.input<typeof qualityTemplateSchema>;

// ─────────────────────────── Embalagem e localização ───────────────────────────

export const assignPackagingSchema = z.object({
  assigneeUserId: idSchema,
  /** O tapeceiro responsável só embala com autorização do gestor. */
  authorizeTapeceiro: z.boolean().default(false),
  version: versionSchema,
});

export const completePackagingSchema = z.object({
  protection: z.enum(PROTECTIONS, { message: 'Escolha o tipo de proteção.' }),
  locationId: idSchema,
  notes: optionalText(500),
  version: versionSchema,
});

export const locationSchema = z.object({
  label: trimmed(2, 80, 'Nome da localização'),
  position: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});

export const moveItemSchema = z.object({
  locationId: idSchema,
  note: optionalText(300),
});

export const stageQuerySchema = z.object({
  stage: z
    .string()
    .max(400)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(FULFILLMENT_STAGES)))
    .optional(),
  serviceOrderId: idSchema.optional(),
  q: z.string().trim().max(80).optional(),
});

// ─────────────────────────── Entregas ───────────────────────────

function refineWindow(
  v: { windowStart?: string | null; windowEnd?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.windowStart && v.windowEnd && v.windowEnd <= v.windowStart)
    ctx.addIssue({
      code: 'custom',
      path: ['windowEnd'],
      message: 'O fim da janela deve ser após o início.',
    });
}

const deliveryFields = {
  addressId: idSchema.nullable().optional(),
  /** Endereço avulso (quando não é um endereço cadastrado do cliente). */
  address: customerAddressSchema.omit({ isPrimary: true, label: true }).nullable().optional(),
  contactName: optionalText(120),
  contactPhone: optionalText(30),
  scheduledDate: dateOnly,
  windowStart: timeOnly.nullable().optional(),
  windowEnd: timeOnly.nullable().optional(),
  team: z.enum(PICKUP_TEAMS).default('EQUIPE_PROPRIA'),
  responsibleUserId: idSchema.nullable().optional(),
  requiresInstallation: z.boolean().default(false),
  instructions: optionalText(1000),
  notes: optionalText(1000),
  itemIds: z.array(idSchema).min(1, 'Escolha as peças da entrega.').max(50),
};

export const createDeliverySchema = z
  .object({
    customerId: idSchema,
    ...deliveryFields,
    /** Pré-agendamento provisório: permitido para peças ainda não liberadas; nunca confirma ao cliente. */
    provisional: z.boolean().default(false),
    /** Evolução Fase 6: custo total da viagem (exige financeiro.gerenciar). */
    tripCost: tripCostInputSchema.optional(),
  })
  .superRefine(refineWindow);
export type CreateDeliveryInput = z.input<typeof createDeliverySchema>;

export const updateDeliverySchema = z
  .object({
    ...deliveryFields,
    /** true = volta a provisório; vazio = mantém (frustrada → agendada). */
    provisional: z.boolean().optional(),
    reason: reason('Motivo da alteração'),
    version: versionSchema,
  })
  .superRefine(refineWindow);
export type UpdateDeliveryInput = z.input<typeof updateDeliverySchema>;

export const deliveryVersionSchema = z.object({
  note: optionalText(1000),
  version: versionSchema,
});

export const deliverItemsSchema = z.object({
  items: z
    .array(
      z
        .object({
          serviceOrderItemId: idSchema,
          status: z.enum(['ENTREGUE', 'DIVERGENTE', 'NAO_ENTREGUE']),
          note: optionalText(500),
        })
        .refine((v) => v.status === 'ENTREGUE' || Boolean(v.note && v.note.length >= 3), {
          path: ['note'],
          message: 'Descreva a divergência ou por que não foi entregue.',
        }),
    )
    .min(1)
    .max(50),
  version: versionSchema,
});

export const installDeliverySchema = z.object({
  note: trimmed(3, 1000, 'Como ficou a instalação'),
  complete: z.boolean().default(true),
  version: versionSchema,
});

export const frustrateDeliverySchema = z.object({
  kind: z.enum(LOGISTICS_KINDS).default('CLIENTE_INDISPONIVEL'),
  reason: trimmed(3, 1000, 'O que aconteceu'),
  version: versionSchema,
});

export const cancelWithReasonSchema = z.object({
  reason: reason(),
  version: versionSchema,
});

export const deliveryQuerySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  status: z
    .string()
    .max(200)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(DELIVERY_STATUSES)))
    .optional(),
});

export const assignPickupLogisticsSchema = z.object({
  logisticsUserId: idSchema.nullable(),
  version: versionSchema,
});

export const pickupExecutionSchema = z.object({
  step: z.enum(['SAIDA', 'RETIRADA_REALIZADA']),
  note: optionalText(1000),
  version: versionSchema,
});

// ─────────────────────────── Ocorrências logísticas ───────────────────────────

export const openLogisticsOccurrenceSchema = z
  .object({
    kind: z.enum(LOGISTICS_KINDS, { message: 'Escolha o tipo de ocorrência.' }),
    description: trimmed(3, 1000, 'Descrição'),
    deliveryId: idSchema.nullable().optional(),
    pickupId: idSchema.nullable().optional(),
    serviceOrderItemId: idSchema.nullable().optional(),
    /** Vazio = regra padrão (peça danificada e divergência bloqueiam a expedição). */
    blocksShipping: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.deliveryId || v.pickupId || v.serviceOrderItemId), {
    path: ['deliveryId'],
    message: 'Informe a entrega, a retirada ou a peça.',
  });

export const assignLogisticsOccurrenceSchema = z.object({
  responsibleUserId: idSchema,
  note: optionalText(500),
  version: versionSchema,
});

export const resolveLogisticsOccurrenceSchema = z.object({
  resolution: trimmed(3, 1000, 'Solução'),
  version: versionSchema,
});

export const logisticsQuerySchema = z.object({
  status: z.enum(LOGISTICS_STATUSES).optional(),
  kind: z.enum(LOGISTICS_KINDS).optional(),
});

// ─────────────────────────── Devoluções e correções ───────────────────────────

export const createReturnSchema = z.object({
  orderId: idSchema,
  reason: trimmed(3, 500, 'Motivo da devolução'),
  responsibleUserId: idSchema.nullable().optional(),
  returnDate: dateOnly,
  /** Fase 12: para onde as peças vão (ex.: entregue no endereço do cliente). */
  destination: optionalText(200),
  lines: z
    .array(
      z.object({
        orderItemId: idSchema,
        quantity: z.number().int().min(1).max(200),
        /** Peças de OS devolvidas inteiras (as demais saem das não alocadas). */
        serviceOrderItemIds: z.array(idSchema).max(50).default([]),
      }),
    )
    .min(1, 'Escolha as peças devolvidas.')
    .max(50),
});
export type CreateReturnInput = z.input<typeof createReturnSchema>;

export const confirmReturnSchema = z.object({
  note: trimmed(3, 500, 'Confirmação (quem recebeu, como)'),
  version: versionSchema,
});

export const receiptCorrectionSchema = z.object({
  newQuantity: z.number().int().min(0).max(200),
  reason: trimmed(5, 500, 'Justificativa da correção'),
});
