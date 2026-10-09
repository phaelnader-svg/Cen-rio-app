import { z } from 'zod';
import {
  ADJUSTMENT_KINDS,
  ELIGIBILITY_RULES,
  EXPENSE_CATEGORIES,
  LOGISTICS_COST_KINDS,
  PAYABLE_CATEGORIES,
  PAYMENT_METHODS,
  SPLIT_METHODS,
} from '../finance-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './common';
import { periodQuerySchema } from './measurements';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Mês no formato AAAA-MM.');
const cents = (label: string) =>
  z
    .number({ message: `${label} é obrigatório.` })
    .int(`${label} em centavos.`)
    .min(1, `${label} deve ser maior que zero.`)
    .max(1_000_000_000);
const reason = (label = 'Motivo') => trimmed(3, 500, label);

// ─────────────────────────── Receita ───────────────────────────

export const commercialAdjustmentSchema = z.object({
  kind: z.enum(ADJUSTMENT_KINDS),
  /** Desconto/acréscimo: valor positivo; ajuste: com sinal. */
  amountCents: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((v) => v !== 0, 'Informe o valor.'),
  reason: reason('Justificativa'),
});

export const revenueSplitSchema = z.object({
  /** Valor da receita do pedido atribuído a cada OS (vazio = proporcional às peças). */
  shares: z
    .array(
      z.object({
        serviceOrderId: idSchema,
        revenueCents: z.number().int().min(0).max(1_000_000_000),
      }),
    )
    .min(1)
    .max(50),
  reason: reason(),
});

// ─────────────────────────── Contas a receber ───────────────────────────

export const createReceivableSchema = z.object({
  orderId: idSchema,
  serviceOrderId: idSchema.nullable().optional(),
  description: trimmed(2, 200, 'Descrição'),
  amountCents: cents('Valor'),
  dueDate: dateOnly,
  expectedMethod: z.enum(PAYMENT_METHODS),
  notes: optionalText(1000),
});

export const receivePaymentSchema = z.object({
  amountCents: cents('Valor recebido'),
  receivedAt: dateOnly,
  method: z.enum(PAYMENT_METHODS),
  note: optionalText(500),
  version: versionSchema,
});

export const reversePaymentSchema = z.object({ reason: reason('Motivo do estorno') });

export const cancelFinanceSchema = z.object({ reason: reason(), version: versionSchema });

export const receivableQuerySchema = periodQuerySchema.extend({
  status: z.string().max(60).optional(),
  orderId: idSchema.optional(),
});

// ─────────────────────────── Contas a pagar ───────────────────────────

export const createPayableSchema = z.object({
  beneficiary: trimmed(2, 160, 'Beneficiário'),
  supplierId: idSchema.nullable().optional(),
  category: z.enum(PAYABLE_CATEGORIES),
  description: trimmed(2, 200, 'Descrição'),
  amountCents: cents('Valor'),
  dueDate: dateOnly,
  notes: optionalText(1000),
});

export const payPayableSchema = z.object({
  amountCents: cents('Valor pago'),
  paidAt: dateOnly,
  method: z.enum(PAYMENT_METHODS),
  note: optionalText(500),
  version: versionSchema,
});

// ─────────────────────────── Mão de obra por produção ───────────────────────────

export const createLaborSchema = z.object({
  professionalUserId: idSchema,
  serviceOrderId: idSchema,
  serviceOrderItemId: idSchema.nullable().optional(),
  service: trimmed(2, 200, 'Serviço'),
  agreedCents: cents('Valor combinado'),
  eligibility: z.enum(ELIGIBILITY_RULES).default('QUALIDADE_APROVADA'),
  notes: optionalText(500),
});

export const laborAdjustmentSchema = z.object({
  amountCents: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((v) => v !== 0, 'Informe o valor.'),
  reason: reason('Justificativa'),
  version: versionSchema,
});

export const payLaborSchema = z.object({
  amountCents: cents('Valor pago'),
  paidAt: dateOnly,
  method: z.enum(PAYMENT_METHODS),
  note: optionalText(500),
  /** Pagamento antes da condição de elegibilidade: só com justificativa explícita do gestor. */
  earlyReason: optionalText(500),
  version: versionSchema,
});

export const laborQuerySchema = z.object({
  status: z.string().max(60).optional(),
  professionalUserId: idSchema.optional(),
  serviceOrderId: idSchema.optional(),
});

// ─────────────────────────── Equipe fixa ───────────────────────────

export const teamCostSchema = z.object({
  userId: idSchema,
  month,
  amountCents: cents('Custo mensal'),
  notes: optionalText(500),
});

// ─────────────────────────── Logística ───────────────────────────

export const logisticsCostSchema = z
  .object({
    kind: z.enum(LOGISTICS_COST_KINDS),
    description: trimmed(2, 200, 'Descrição'),
    amountCents: cents('Valor'),
    date: dateOnly,
    deliveryId: idSchema.nullable().optional(),
    pickupId: idSchema.nullable().optional(),
    beneficiary: optionalText(160),
    splitMethod: z.enum(SPLIT_METHODS),
    splitNote: optionalText(500),
    allocations: z
      .array(
        z.object({
          serviceOrderId: idSchema,
          amountCents: z.number().int().min(0).max(1_000_000_000).optional(),
        }),
      )
      .min(1, 'Informe as OS atendidas.')
      .max(50),
    /** Gera a conta a pagar ao beneficiário (vencimento informado). */
    payableDueDate: dateOnly.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const ids = v.allocations.map((a) => a.serviceOrderId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'OS repetida no rateio.' });
    if (v.splitMethod === 'MANUAL') {
      if (v.allocations.some((a) => a.amountCents === undefined))
        ctx.addIssue({
          code: 'custom',
          path: ['allocations'],
          message: 'Informe o valor de cada OS.',
        });
      else if (v.allocations.reduce((a, x) => a + (x.amountCents ?? 0), 0) !== v.amountCents)
        ctx.addIssue({
          code: 'custom',
          path: ['allocations'],
          message: 'A soma do rateio precisa ser igual ao valor total.',
        });
    }
    if (v.payableDueDate && !v.beneficiary)
      ctx.addIssue({ code: 'custom', path: ['beneficiary'], message: 'Informe o beneficiário.' });
  });

// ─────────────────────────── Despesas ───────────────────────────

export const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: trimmed(2, 200, 'Descrição'),
  amountCents: cents('Valor'),
  competence: month,
  dueDate: dateOnly,
  beneficiary: trimmed(2, 160, 'Beneficiário'),
});

export const recurringExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: trimmed(2, 200, 'Descrição'),
  amountCents: cents('Valor'),
  dayOfMonth: z.number().int().min(1).max(31),
  beneficiary: trimmed(2, 160, 'Beneficiário'),
  startMonth: month,
  endMonth: month.nullable().optional(),
  active: z.boolean().default(true),
  version: versionSchema.optional(),
});

export const generateRecurringSchema = z.object({ month });

// ─────────────────────────── Custos e configuração ───────────────────────────

export const manualCostSchema = z.object({
  serviceOrderId: idSchema,
  category: z.enum(['MATERIAL', 'OUTRO_VARIAVEL']),
  description: trimmed(2, 200, 'Descrição'),
  amountCents: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((v) => v !== 0, 'Informe o valor.'),
  reason: reason('Justificativa'),
});

export const financeSettingsSchema = z.object({
  /** Alíquota estimada sobre a receita em pontos-base (600 = 6,00%); null = não configurada. */
  taxRateBps: z.number().int().min(0).max(5000).nullable(),
});

export const reportQuerySchema = periodQuerySchema.extend({
  format: z.enum(['json', 'csv']).default('json'),
});
