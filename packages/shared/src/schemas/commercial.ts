import { z } from 'zod';
import {
  BR_STATES,
  CUSTOMER_KINDS,
  MATERIAL_KINDS,
  MATERIAL_SOURCINGS,
  PICKUP_STATUSES,
  PICKUP_TEAMS,
  PIECE_CONDITIONS,
  PIECE_TYPES,
  PRIORITIES,
  RECEIPT_ORIGINS,
  SERVICE_TYPES,
} from '../domain';
import { isValidCnpj, isValidCpf, onlyDigits } from '../documents';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data deve estar no formato AAAA-MM-DD.' })
  .refine((v) => !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime()), {
    message: 'Data inválida.',
  });
const timeOnly = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Horário deve estar no formato HH:MM.' });

const phone = z
  .string()
  .trim()
  .max(30)
  .transform((v) => onlyDigits(v))
  .refine((v) => v === '' || (v.length >= 10 && v.length <= 13), {
    message: 'Telefone deve ter DDD e número (10 ou 11 dígitos).',
  })
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

// ───────────────────────────── Clientes ─────────────────────────────

export const customerAddressSchema = z.object({
  label: trimmed(2, 40, 'Identificação do endereço'),
  street: trimmed(2, 160, 'Logradouro'),
  number: trimmed(1, 20, 'Número'),
  complement: optionalText(80),
  district: optionalText(80),
  city: trimmed(2, 80, 'Cidade'),
  state: z.enum(BR_STATES, { message: 'UF inválida.' }),
  postalCode: z
    .string()
    .trim()
    .transform(onlyDigits)
    .refine((v) => v === '' || v.length === 8, { message: 'CEP deve ter 8 dígitos.' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  reference: optionalText(200),
  isPrimary: z.boolean().default(false),
});
export type CustomerAddressInput = z.input<typeof customerAddressSchema>;

const customerFields = {
  kind: z.enum(CUSTOMER_KINDS),
  name: trimmed(2, 160, 'Nome ou razão social'),
  tradeName: optionalText(160),
  document: z
    .string()
    .trim()
    .transform(onlyDigits)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  phone,
  whatsapp: phone,
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
  notes: optionalText(2000),
};

function refineDocument<T extends { kind: 'PF' | 'PJ'; document?: string | null }>(
  v: T,
  ctx: z.RefinementCtx,
) {
  if (!v.document) return;
  const ok = v.kind === 'PF' ? isValidCpf(v.document) : isValidCnpj(v.document);
  if (!ok) {
    ctx.addIssue({
      code: 'custom',
      path: ['document'],
      message: v.kind === 'PF' ? 'CPF inválido.' : 'CNPJ inválido.',
    });
  }
}

export const createCustomerSchema = z
  .object({
    ...customerFields,
    addresses: z.array(customerAddressSchema).max(10).default([]),
    /** Confirma o cadastro mesmo havendo clientes com contato/nome semelhantes. */
    allowSimilar: z.boolean().default(false),
  })
  .superRefine(refineDocument);
export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({ ...customerFields, version: versionSchema, allowSimilar: z.boolean().default(false) })
  .superRefine(refineDocument);
export type UpdateCustomerInput = z.input<typeof updateCustomerSchema>;

export const customerQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(CUSTOMER_KINDS).optional(),
  city: z.string().trim().max(80).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

// ───────────────────────────── Pedidos ─────────────────────────────

export const orderItemSchema = z.object({
  /** Presente ao editar um item existente. */
  id: idSchema.optional(),
  pieceType: z.enum(PIECE_TYPES),
  description: trimmed(2, 300, 'Descrição da peça'),
  quantity: z.number().int().min(1, { message: 'Quantidade mínima: 1.' }).max(200),
  notes: optionalText(500),
});
export type OrderItemInput = z.input<typeof orderItemSchema>;

const orderFields = {
  pickupAddressId: idSchema.nullable().optional(),
  contractedService: trimmed(2, 300, 'Serviço contratado'),
  description: optionalText(2000),
  /** Valor negociado em centavos. Exige permissão de valores. */
  agreedValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  paymentTerms: optionalText(1000),
  notes: optionalText(2000),
  items: z.array(orderItemSchema).min(1, { message: 'Inclua ao menos uma peça.' }).max(50),
};

export const createOrderSchema = z.object({ customerId: idSchema, ...orderFields });
export type CreateOrderInput = z.input<typeof createOrderSchema>;

export const updateOrderSchema = z.object({ ...orderFields, version: versionSchema });
export type UpdateOrderInput = z.input<typeof updateOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: trimmed(3, 500, 'Motivo do cancelamento'),
  version: versionSchema,
});

export const orderQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().max(40).optional(),
  customerId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

// ───────────────────────────── Retiradas ─────────────────────────────

const pickupFields = {
  addressId: idSchema.nullable().optional(),
  scheduledDate: dateOnly.nullable().optional(),
  windowStart: timeOnly.nullable().optional(),
  windowEnd: timeOnly.nullable().optional(),
  team: z.enum(PICKUP_TEAMS).default('LOGISTICA_TERCEIRIZADA'),
  teamNotes: optionalText(200),
  instructions: optionalText(1000),
  /** Referência externa (ex.: protocolo da logística) — preparado para integração. */
  externalReference: optionalText(80),
  items: z
    .array(z.object({ orderItemId: idSchema, quantity: z.number().int().min(1).max(200) }))
    .min(1, { message: 'Selecione as peças a retirar.' })
    .max(50),
};

function refineWindow(
  v: { windowStart?: string | null; windowEnd?: string | null; scheduledDate?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.windowStart && v.windowEnd && v.windowEnd <= v.windowStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['windowEnd'],
      message: 'O fim da janela deve ser após o início.',
    });
  }
  if ((v.windowStart || v.windowEnd) && !v.scheduledDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['scheduledDate'],
      message: 'Informe a data da retirada.',
    });
  }
}

export const createPickupSchema = z
  .object({ orderId: idSchema, ...pickupFields })
  .superRefine(refineWindow);
export type CreatePickupInput = z.input<typeof createPickupSchema>;

export const updatePickupSchema = z
  .object({ ...pickupFields, version: versionSchema })
  .superRefine(refineWindow);
export type UpdatePickupInput = z.input<typeof updatePickupSchema>;

export const pickupTransitionSchema = z.object({
  toStatus: z.enum(PICKUP_STATUSES),
  note: optionalText(1000),
  version: versionSchema,
});

export const pickupQuerySchema = z.object({
  status: z.string().max(40).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  orderId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ───────────────────────────── Recebimentos ─────────────────────────────

export const createReceiptSchema = z.object({
  orderId: idSchema,
  pickupId: idSchema.nullable().optional(),
  origin: z.enum(RECEIPT_ORIGINS),
  /** Data/hora da chegada (ISO). Padrão: agora. Não pode estar no futuro. */
  receivedAt: z.string().datetime({ offset: true }).optional(),
  /** Funcionário que recebeu fisicamente (padrão: quem registra). */
  receivedByEmployeeId: idSchema.optional(),
  divergences: optionalText(2000),
  notes: optionalText(2000),
  lines: z
    .array(
      z.object({
        orderItemId: idSchema,
        quantity: z.number().int().min(1).max(200),
        condition: z.enum(PIECE_CONDITIONS),
        conditionNotes: optionalText(500),
        location: trimmed(2, 80, 'Localização na oficina'),
      }),
    )
    .min(1, { message: 'Informe ao menos uma peça recebida.' })
    .max(50),
});
export type CreateReceiptInput = z.input<typeof createReceiptSchema>;

// ───────────────────────────── Ordens de serviço ─────────────────────────────

const osHeader = {
  technicalInstructions: optionalText(4000),
  notes: optionalText(2000),
  promisedDate: dateOnly.nullable().optional(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  technicalLeadId: idSchema.nullable().optional(),
};

const osItemSpecs = {
  serviceType: z.enum(SERVICE_TYPES),
  description: trimmed(2, 300, 'Descrição da peça'),
  fabricName: optionalText(120),
  fabricColor: optionalText(80),
  fabricReference: optionalText(80),
  foamSpecs: optionalText(500),
  technicalNotes: optionalText(2000),
};

export const createServiceOrderSchema = z.object({
  orderId: idSchema,
  ...osHeader,
  items: z
    .array(
      z.object({
        orderItemId: idSchema,
        quantity: z.number().int().min(1).max(200),
        ...osItemSpecs,
      }),
    )
    .min(1, { message: 'Inclua ao menos uma peça recebida.' })
    .max(50),
});
export type CreateServiceOrderInput = z.input<typeof createServiceOrderSchema>;

export const updateServiceOrderSchema = z.object({
  ...osHeader,
  /** Motivo da alteração (registrado no histórico técnico). */
  reason: optionalText(300),
  version: versionSchema,
});
export type UpdateServiceOrderInput = z.input<typeof updateServiceOrderSchema>;

export const updateServiceOrderItemSchema = z.object({
  ...osItemSpecs,
  reason: optionalText(300),
  version: versionSchema,
});
export type UpdateServiceOrderItemInput = z.input<typeof updateServiceOrderItemSchema>;

export const measurementSchema = z.object({
  measurements: z
    .array(
      z.object({
        label: trimmed(1, 60, 'Identificação da medida'),
        valueCm: z.number().positive().max(10_000),
      }),
    )
    .min(1, { message: 'Informe ao menos uma medida.' })
    .max(40),
  notes: optionalText(1000),
  version: versionSchema,
});
export type MeasurementInput = z.input<typeof measurementSchema>;

export const cancelServiceOrderSchema = z.object({
  reason: trimmed(3, 500, 'Motivo do cancelamento'),
  version: versionSchema,
});

export const materialRequirementSchema = z
  .object({
    serviceOrderItemId: idSchema.nullable().optional(),
    kind: z.enum(MATERIAL_KINDS),
    description: trimmed(2, 200, 'Descrição do material'),
    quantity: z.number().positive().max(100_000).nullable().optional(),
    unit: optionalText(20),
    sourcing: z.enum(MATERIAL_SOURCINGS),
    notes: optionalText(500),
  })
  .refine((v) => v.kind !== 'TECIDO' || v.sourcing === 'EXCLUSIVO_OS', {
    message: 'Tecidos são comprados especificamente para cada OS.',
    path: ['sourcing'],
  });
export type MaterialRequirementInput = z.input<typeof materialRequirementSchema>;

export const serviceOrderQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().max(40).optional(),
  orderId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
