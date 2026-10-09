import { z } from 'zod';
import { MATERIAL_KINDS, MATERIAL_SOURCINGS } from '../domain';
import { DECIMAL_UNITS, MATERIAL_UNITS, UNITS_BY_KIND } from '../measurements-domain';
import {
  LEFTOVER_CONDITIONS,
  PURCHASE_ORDER_STATUSES,
  RECEIPT_ISSUES,
  RESERVATION_STATUSES,
} from '../purchasing-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data deve estar no formato AAAA-MM-DD.' });

const qty = (label = 'Quantidade') =>
  z
    .number({ message: `${label} é obrigatória.` })
    .positive({ message: `${label} deve ser maior que zero.` })
    .max(1_000_000)
    .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, {
      message: 'Use no máximo 3 casas decimais.',
    });
const nonNegativeQty = z
  .number()
  .min(0, { message: 'Quantidade não pode ser negativa.' })
  .max(1_000_000)
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, {
    message: 'Use no máximo 3 casas decimais.',
  });
const cm = z.number().positive({ message: 'Medida deve ser maior que zero.' }).max(10_000);
const cents = z.number().int({ message: 'Preço em centavos.' }).min(0).max(100_000_000);
const reason = (label = 'Motivo') => trimmed(3, 500, label);
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(300)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)))
    .optional();

// ─────────────────────────── Fornecedores ───────────────────────────

export const supplierSchema = z.object({
  name: trimmed(2, 160, 'Nome ou razão social'),
  contactName: optionalText(120),
  phone: optionalText(30),
  email: z
    .string()
    .trim()
    .max(160)
    .transform((v) => (v === '' ? null : v.toLowerCase()))
    .pipe(z.string().email({ message: 'E-mail inválido.' }).nullable())
    .nullable()
    .optional(),
  address: optionalText(300),
  categories: z.array(z.enum(MATERIAL_KINDS)).max(3).default([]),
  notes: optionalText(1000),
  active: z.boolean().default(true),
});
export type SupplierInput = z.input<typeof supplierSchema>;
export const updateSupplierSchema = supplierSchema.extend({ version: versionSchema });

// ─────────────────────────── Pedidos de compra ───────────────────────────

export const purchaseOrderItemSchema = z
  .object({
    sourcing: z.enum(MATERIAL_SOURCINGS),
    /** Material do catálogo (estoque). Ausente: o servidor localiza/cria pela especificação. */
    stockItemId: idSchema.nullable().optional(),
    /** Origem das quantidades: necessidades aprovadas das OS. */
    allocations: z
      .array(z.object({ materialRequirementId: idSchema, quantity: qty() }))
      .max(100)
      .default([]),
    /** Quantidade total comprada (≥ soma das origens; o excedente vai para o estoque/OS). */
    quantity: qty(),
    unitPriceCents: cents.nullable().optional(),
    notes: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.sourcing === 'EXCLUSIVO_OS' && v.allocations.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: 'Compra exclusiva deve ter exatamente uma OS de origem.',
      });
    }
    if (v.sourcing === 'ESTOQUE' && !v.stockItemId && v.allocations.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['stockItemId'],
        message: 'Informe o material do estoque ou as necessidades de origem.',
      });
    }
    const sum = v.allocations.reduce((a, b) => a + b.quantity, 0);
    if (v.quantity + 1e-9 < sum) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'A quantidade comprada não pode ser menor que a soma das origens.',
      });
    }
    const ids = v.allocations.map((a) => a.materialRequirementId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'Origem repetida.' });
    }
  });
export type PurchaseOrderItemInput = z.input<typeof purchaseOrderItemSchema>;

export const purchaseOrderSchema = z.object({
  supplierId: idSchema.nullable().optional(),
  expectedDate: dateOnly.nullable().optional(),
  notes: optionalText(2000),
  items: z.array(purchaseOrderItemSchema).min(1, { message: 'Inclua ao menos um item.' }).max(100),
});
export type PurchaseOrderInput = z.input<typeof purchaseOrderSchema>;
export const updatePurchaseOrderSchema = purchaseOrderSchema.extend({ version: versionSchema });

export const purchaseOrderDecisionSchema = z.object({
  note: optionalText(500),
  version: versionSchema,
});
export const cancelPurchaseOrderSchema = z.object({ reason: reason(), version: versionSchema });
export const authorizeExtraSchema = z.object({
  quantity: qty('Quantidade adicional'),
  reason: reason(),
  version: versionSchema,
});

export const purchaseOrderQuerySchema = z.object({
  status: csv(PURCHASE_ORDER_STATUSES),
  supplierId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const needsQuerySchema = z.object({
  pendingOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  kind: z.enum(MATERIAL_KINDS).optional(),
  serviceOrderId: idSchema.optional(),
});

// ─────────────────────────── Recebimento de materiais ───────────────────────────

export const materialReceiptLineSchema = z
  .object({
    purchaseOrderItemId: idSchema,
    /** Recebido conforme (conferido): entra no estoque/OS. */
    acceptedQuantity: nonNegativeQty,
    /** Recebido com problema: registrado, NÃO fica disponível. */
    rejectedQuantity: nonNegativeQty.default(0),
    /** Conferência de referência e especificação feita por quem recebe. */
    specConfirmed: z.boolean(),
    issue: z.enum(RECEIPT_ISSUES).nullable().optional(),
    issueNote: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.acceptedQuantity + v.rejectedQuantity <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptedQuantity'],
        message: 'Informe a quantidade recebida.',
      });
    }
    if (v.acceptedQuantity > 0 && !v.specConfirmed) {
      ctx.addIssue({
        code: 'custom',
        path: ['specConfirmed'],
        message: 'Confirme que conferiu a referência e a especificação.',
      });
    }
    if (v.rejectedQuantity > 0 && !v.issue) {
      ctx.addIssue({
        code: 'custom',
        path: ['issue'],
        message: 'Informe o tipo de divergência.',
      });
    }
    if (v.issue && !v.issueNote) {
      ctx.addIssue({
        code: 'custom',
        path: ['issueNote'],
        message: 'Descreva a divergência.',
      });
    }
  });
export type MaterialReceiptLineInput = z.input<typeof materialReceiptLineSchema>;

export const materialReceiptSchema = z.object({
  purchaseOrderId: idSchema,
  notes: optionalText(1000),
  lines: z.array(materialReceiptLineSchema).min(1).max(100),
});
export type MaterialReceiptInput = z.input<typeof materialReceiptSchema>;

export const reverseReceiptSchema = z.object({
  quantity: qty('Quantidade estornada'),
  reason: reason('Motivo do estorno'),
});

// ─────────────────────────── Estoque ───────────────────────────

export const stockItemSchema = z
  .object({
    kind: z.enum(['ESPUMA', 'OUTRO']),
    description: trimmed(2, 160, 'Descrição'),
    foamDensity: optionalText(30),
    thicknessCm: cm.nullable().optional(),
    lengthCm: cm.nullable().optional(),
    widthCm: cm.nullable().optional(),
    unit: z.enum(MATERIAL_UNITS),
    minQuantity: nonNegativeQty.nullable().optional(),
    location: optionalText(120),
    notes: optionalText(500),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (!UNITS_BY_KIND[v.kind].includes(v.unit)) {
      ctx.addIssue({
        code: 'custom',
        path: ['unit'],
        message: 'Unidade incompatível com o tipo de material.',
      });
    }
    if (v.kind === 'ESPUMA' && (!v.foamDensity || !v.thicknessCm)) {
      ctx.addIssue({
        code: 'custom',
        path: ['foamDensity'],
        message: 'Espuma exige densidade e espessura.',
      });
    }
    if (v.minQuantity && !DECIMAL_UNITS.includes(v.unit) && !Number.isInteger(v.minQuantity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['minQuantity'],
        message: 'Nesta unidade use número inteiro.',
      });
    }
  });
export type StockItemInput = z.input<typeof stockItemSchema>;
export const updateStockItemSchema = z.object({
  minQuantity: nonNegativeQty.nullable().optional(),
  location: optionalText(120),
  notes: optionalText(500),
  active: z.boolean(),
  version: versionSchema,
});

export const stockAdjustSchema = z.object({
  /** Positivo = entrada; negativo = saída. */
  quantity: z
    .number()
    .refine((v) => v !== 0, { message: 'Informe uma quantidade diferente de zero.' })
    .refine((v) => Math.abs(v) <= 1_000_000, { message: 'Quantidade muito grande.' }),
  reason: reason('Motivo do ajuste'),
  /** Fase 11: entrada que é devolução de material de uma OS (sai do custo dessa OS). */
  serviceOrderId: idSchema.nullable().optional(),
});

export const stockIssueSchema = z.object({
  quantity: qty(),
  serviceOrderId: idSchema.nullable().optional(),
  reason: reason(),
});

export const reservationSchema = z.object({
  stockItemId: idSchema,
  serviceOrderId: idSchema,
  materialRequirementId: idSchema.nullable().optional(),
  quantity: qty(),
  notes: optionalText(300),
});
export const releaseReservationSchema = z.object({ reason: reason() });

export const movementQuerySchema = z.object({
  stockItemId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const reservationQuerySchema = z.object({
  stockItemId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
  status: csv(RESERVATION_STATUSES),
});

// ─────────────────────────── Sobras ───────────────────────────

export const leftoverSchema = z
  .object({
    serviceOrderId: idSchema,
    kind: z.enum(MATERIAL_KINDS),
    description: trimmed(2, 160, 'Descrição'),
    color: optionalText(60),
    reference: optionalText(80),
    foamDensity: optionalText(30),
    thicknessCm: cm.nullable().optional(),
    quantity: qty(),
    unit: z.enum(MATERIAL_UNITS),
    location: trimmed(2, 120, 'Localização'),
    condition: z.enum(LEFTOVER_CONDITIONS),
    reusable: z.boolean(),
    notes: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (!UNITS_BY_KIND[v.kind].includes(v.unit)) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Unidade incompatível.' });
    }
  });
export type LeftoverInput = z.input<typeof leftoverSchema>;

export const leftoverTransferSchema = z.object({
  targetServiceOrderId: idSchema,
  targetRequirementId: idSchema.nullable().optional(),
  quantity: qty(),
  reason: reason('Motivo da transferência'),
});
export const leftoverDiscardSchema = z.object({ reason: reason() });
