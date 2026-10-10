import { z } from 'zod';
import {
  ADJUSTMENT_KINDS,
  ELIGIBILITY_RULES,
  EXPENSE_CATEGORIES,
  LOGISTICS_COST_KINDS,
  LOGISTICS_MAX_CENTS,
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

/** Evolução Fase 5: corrigir o valor combinado (antes de qualquer pagamento), com motivo. */
export const editLaborAgreedSchema = z.object({
  agreedCents: cents('Valor combinado'),
  reason: reason('Motivo'),
  version: versionSchema,
});

/** Resolução da revisão financeira: valor devido por profissional (sem rateio automático). */
export const resolveLaborReviewSchema = z.object({
  lines: z
    .array(
      z.object({
        professionalUserId: idSchema,
        amountCents: z.number().int().min(0).max(1_000_000_000),
      }),
    )
    .min(1)
    .max(10),
  reason: reason('Justificativa'),
  version: versionSchema,
});

/** "Meus valores" no tablet: confirmação do PIN a cada abertura (sessão do tablet é longa). */
export const myProductionUnlockSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'PIN de 6 dígitos.'),
});

export const laborWeeklyQuerySchema = z
  .object({ from: dateOnly, to: dateOnly })
  .refine((q) => q.from <= q.to, { message: 'Período inválido.', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 400 * 86_400_000, {
    message: 'Período máximo: 400 dias.',
    path: ['to'],
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

// ─────────────────────────── Evolução Fase 6: custos de retirada e entrega ───────────────────────────

/** Valor total da viagem: centavos inteiros, > 0 (R$ 0 não é aceito — sem custo = sem lançamento). */
export const tripCentsSchema = z
  .number({ message: 'Informe o valor total da viagem.' })
  .int('Valor em centavos inteiros.')
  .min(1, 'O valor deve ser maior que zero (viagem sem custo não é lançada).')
  .max(LOGISTICS_MAX_CENTS, 'Valor acima do limite (R$ 100.000,00).');

/** Custo informado junto do agendamento (criação da retirada/entrega). */
export const tripCostInputSchema = z
  .object({
    amountCents: tripCentsSchema,
    participantUserIds: z.array(idSchema).max(6).default([]),
  })
  .refine((v) => new Set(v.participantUserIds).size === v.participantUserIds.length, {
    message: 'Participante repetido.',
    path: ['participantUserIds'],
  });

/** Custo da viagem (retirada OU entrega): combinado no agendamento, editável com motivo. */
export const tripCostSchema = z
  .object({
    pickupId: idSchema.nullable().optional(),
    deliveryId: idSchema.nullable().optional(),
    amountCents: tripCentsSchema,
    /** Quem executa (André, Izaías...). Não são credores: o recebedor é o configurado. */
    participantUserIds: z.array(idSchema).max(6).default([]),
    /** OS escolhidas pelo gestor (vazio = OS da própria viagem, recalculadas automaticamente). */
    serviceOrderIds: z.array(idSchema).max(30).optional(),
    /** Obrigatório ao alterar um custo já registrado. */
    reason: optionalText(500),
    version: versionSchema.optional(),
  })
  .refine((v) => Boolean(v.pickupId) !== Boolean(v.deliveryId), {
    message: 'Informe a retirada ou a entrega.',
    path: ['pickupId'],
  })
  .refine((v) => new Set(v.participantUserIds).size === v.participantUserIds.length, {
    message: 'Participante repetido.',
    path: ['participantUserIds'],
  })
  .refine(
    (v) => !v.serviceOrderIds || new Set(v.serviceOrderIds).size === v.serviceOrderIds.length,
    {
      message: 'OS repetida no rateio.',
      path: ['serviceOrderIds'],
    },
  );

export const logisticsDefaultsSchema = z.object({
  defaultPickupCostCents: tripCentsSchema.nullable(),
  defaultDeliveryCostCents: tripCentsSchema.nullable(),
  logisticsPayeeUserId: idSchema.nullable(),
});

/** Taxa de tentativa frustrada: só com autorização explícita e justificativa. */
export const tripFeeSchema = z.object({
  amountCents: tripCentsSchema,
  reason: reason('Justificativa da taxa'),
});

/** Ajuste do valor devido (com sinal), depois de constituída a obrigação. */
export const tripAdjustmentSchema = z.object({
  amountCents: z
    .number()
    .int('Valor em centavos inteiros.')
    .min(-LOGISTICS_MAX_CENTS)
    .max(LOGISTICS_MAX_CENTS)
    .refine((v) => v !== 0, 'O ajuste não pode ser zero.'),
  reason: reason('Justificativa do ajuste'),
  version: versionSchema,
});

export const reversePayablePaymentSchema = z.object({
  reason: reason('Motivo do estorno'),
  version: versionSchema,
});

export const logisticsWeeklyQuerySchema = z
  .object({ from: dateOnly, to: dateOnly, payeeUserId: idSchema.optional() })
  .refine((q) => q.from <= q.to, { message: 'Período inválido.', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 400 * 86_400_000, {
    message: 'Período máximo: 400 dias.',
    path: ['to'],
  });

// ─────────────────────────── Evolução Fase 7: fechamento semanal ───────────────────────────

const monday = dateOnly.refine(
  (v) => new Date(`${v}T12:00:00Z`).getUTCDay() === 1,
  'A semana começa na segunda-feira.',
);
export const weekStartParamsSchema = z.object({ weekStart: monday });
export const closingQuerySchema = z.object({
  beneficiaryUserId: idSchema.optional(),
  category: z.enum(['TAPECARIA', 'LOGISTICA']).optional(),
  state: z
    .enum(['PREVISTO', 'AGUARDANDO_QUALIDADE', 'EM_REVISAO', 'PENDENTE_CONFIGURACAO', 'DEVIDO'])
    .optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export const confirmClosingSchema = z.object({
  /** Versão vista na tela (0 = nunca conferido). */
  version: z.number().int().min(0),
  note: optionalText(1000),
});
export const reopenClosingSchema = z.object({
  reason: reason('Motivo da reabertura'),
  version: versionSchema,
});
/** Pix/transferência feito FORA do sistema (nenhuma transação bancária é iniciada). */
export const closingPaymentSchema = z.object({
  beneficiaryUserId: idSchema,
  category: z.enum(['TAPECARIA', 'LOGISTICA']),
  amountCents: cents('Valor pago'),
  paidAt: dateOnly,
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(120),
  note: optionalText(500),
});
export const reverseClosingPaymentSchema = z.object({ reason: reason('Motivo do estorno') });
export const reverseLaborPaymentSchema = z.object({
  reason: reason('Motivo do estorno'),
  version: versionSchema,
});
export const freeTripSchema = z
  .object({
    pickupId: idSchema.nullable().optional(),
    deliveryId: idSchema.nullable().optional(),
    reason: reason('Motivo (gratuita confirmada)'),
  })
  .refine((v) => Boolean(v.pickupId) !== Boolean(v.deliveryId), {
    message: 'Informe a retirada ou a entrega.',
    path: ['pickupId'],
  });
