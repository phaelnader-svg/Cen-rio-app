import { z } from 'zod';
import {
  BR_STATES,
  CUSTOMER_KINDS,
  ORDER_STATUSES,
  SERVICE_ORDER_STATUSES,
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
import { tripCostInputSchema } from './finance';
import {
  ELIGIBILITY_RULES,
  MAX_INSTALLMENTS,
  PAYMENT_METHODS,
  PAYMENT_MODELS,
} from '../finance-domain';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data deve estar no formato AAAA-MM-DD.' })
  .refine((v) => !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime()), {
    message: 'Data inválida.',
  });
/** Prazo prometido obrigatório (Novo serviço e alteração do prazo do pedido). */
const requiredPromisedDate = z
  .string({ error: 'Informe o prazo de entrega combinado com o cliente.' })
  .min(1, { message: 'Informe o prazo de entrega combinado com o cliente.' })
  .pipe(dateOnly);
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
  /**
   * Cobrança: valor fechado da peça (opcional, exige pedidos.valores). Todas ou nenhuma; a soma é
   * igual ao valor final do pedido.
   */
  agreedValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
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

/**
 * Cobrança (AM-11): pedido com valor líquido recebido exige decisão explícita — reter (o valor
 * comercial passa a ser o retido) e/ou reembolsar o restante. Nunca "cancelar e tratar depois".
 */
export const orderCancelFinanceSchema = z.object({
  retainedCents: z.number().int().min(0).max(1_000_000_000),
  refund: z
    .object({
      refundedAt: dateOnly,
      method: z.enum(PAYMENT_METHODS),
    })
    .nullable()
    .optional(),
});

export const cancelOrderSchema = z.object({
  reason: trimmed(3, 500, 'Motivo do cancelamento'),
  version: versionSchema,
  finance: orderCancelFinanceSchema.nullable().optional(),
});

/**
 * Alteração do prazo prometido do pedido (promessa vigente para as OS que ainda vão nascer).
 * `applyToServiceOrders`: resposta explícita à pergunta "Aplicar este novo prazo também às OS
 * abertas deste pedido?" — nunca há atualização silenciosa das OS existentes.
 */
export const updateOrderPromisedDateSchema = z.object({
  promisedDate: requiredPromisedDate,
  reason: trimmed(3, 300, 'Motivo da alteração do prazo'),
  applyToServiceOrders: z.boolean({ error: 'Responda se o prazo vale também para as OS abertas.' }),
  version: versionSchema,
});
export type UpdateOrderPromisedDateInput = z.input<typeof updateOrderPromisedDateSchema>;

export const orderQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
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
  // Correção global: o compromisso é o HORÁRIO DE CHEGADA ao cliente (window_start). Com data
  // (retirada agendada) ele é obrigatório; o fim da janela é opcional e só existe em registros
  // antigos. Sem data = só solicitada (aguardando agendamento), sem horário confirmado.
  if (v.scheduledDate && !v.windowStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['windowStart'],
      message: 'Informe o horário de chegada ao cliente.',
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
  .object({
    orderId: idSchema,
    ...pickupFields,
    /** Correção global: quem executa (logística ou equipe própria), já na solicitação. */
    logisticsUserId: idSchema.nullable().optional(),
    /** Evolução Fase 6: custo total da viagem (exige financeiro.gerenciar). */
    tripCost: tripCostInputSchema.optional(),
    /** Simplificação Fase 3: participantes operacionais (veem a parada; não são credores). */
    participantUserIds: z.array(idSchema).max(6).optional(),
  })
  .superRefine(refineWindow);
export type CreatePickupInput = z.input<typeof createPickupSchema>;

export const updatePickupSchema = z
  .object({
    ...pickupFields,
    version: versionSchema,
    /** Simplificação Fase 3: participantes operacionais (ausente = mantém os atuais). */
    participantUserIds: z.array(idSchema).max(6).optional(),
  })
  .superRefine(refineWindow);
export type UpdatePickupInput = z.input<typeof updatePickupSchema>;

export const pickupTransitionSchema = z.object({
  toStatus: z.enum(PICKUP_STATUSES),
  note: optionalText(1000),
  version: versionSchema,
});

export const pickupQuerySchema = z.object({
  /** Uma ou mais situações separadas por vírgula. */
  status: z
    .string()
    .max(200)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(PICKUP_STATUSES)))
    .optional(),
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

/**
 * Correção global — mão de obra combinada com o titular NA CRIAÇÃO da OS (opcional). Gravada na
 * mesma transação da OS; exige `financeiro.gerenciar` e um titular definido na peça. Não libera
 * pagamento: a obrigação segue a regra de elegibilidade (padrão: qualidade aprovada).
 */
export const serviceOrderItemLaborSchema = z.object({
  agreedCents: z
    .number({ message: 'Valor da mão de obra é obrigatório.' })
    .int('Valor da mão de obra em centavos.')
    .min(1, 'Valor da mão de obra deve ser maior que zero.')
    .max(1_000_000_000),
  service: optionalText(200),
  eligibility: z.enum(ELIGIBILITY_RULES).default('QUALIDADE_APROVADA'),
  notes: optionalText(500),
});

export const createServiceOrderSchema = z.object({
  orderId: idSchema,
  ...osHeader,
  items: z
    .array(
      z
        .object({
          orderItemId: idSchema,
          quantity: z.number().int().min(1).max(200),
          ...osItemSpecs,
          /** Tapeceiro titular da peça (exige `producao.planejar`). Opcional. */
          upholstererUserId: idSchema.nullable().optional(),
          /** Mão de obra combinada com o titular (exige `financeiro.gerenciar`). Opcional. */
          labor: serviceOrderItemLaborSchema.nullable().optional(),
        })
        .refine((v) => !v.labor || Boolean(v.upholstererUserId), {
          path: ['labor'],
          message: 'Defina o tapeceiro titular da peça antes de combinar a mão de obra.',
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
  status: z.enum(SERVICE_ORDER_STATUSES).optional(),
  orderId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

// ───────────────────── Simplificação Fase 2 — Novo serviço ─────────────────────

/** Cliente do Novo serviço: um já cadastrado (com endereço existente ou novo) ou um cliente novo. */
const newServiceCustomerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('EXISTENTE'),
    customerId: idSchema,
    /** Endereço de retirada já cadastrado. */
    addressId: idSchema.nullable().optional(),
    /** Endereço novo, cadastrado no cliente na mesma operação (exige clientes.gerenciar). */
    newAddress: customerAddressSchema.nullable().optional(),
  }),
  z
    .object({
      mode: z.literal('NOVO'),
      ...customerFields,
      /** Endereço de retirada. Opcional quando o cliente entrega as peças (sem retirada). */
      address: customerAddressSchema.nullable().optional(),
      /** Confirma o cadastro mesmo havendo clientes com contato/nome semelhantes. */
      allowSimilar: z.boolean().default(false),
    })
    .superRefine(refineDocument),
]);

const plannedLaborCents = z
  .number({ message: 'Valor da mão de obra prevista inválido.' })
  .int('Valor da mão de obra em centavos.')
  .min(1, 'Mão de obra prevista deve ser maior que zero.')
  .max(10_000_000);

/** Mão de obra prevista só existe com titular previsto (o valor é do titular). */
function refinePlannedIntent(
  items: readonly {
    plannedUpholstererUserId?: string | null;
    plannedLaborUnitCents?: number | null;
  }[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  items.forEach((it, idx) => {
    if (it.plannedLaborUnitCents && !it.plannedUpholstererUserId)
      ctx.addIssue({
        code: 'custom',
        path: [...path, idx, 'plannedLaborUnitCents'],
        message: 'Escolha o tapeceiro titular antes de informar a mão de obra prevista.',
      });
  });
}

/** Peça do serviço fechado: só o que já se sabe no fechamento (nada técnico é obrigatório). */
export const newServiceItemSchema = orderItemSchema.omit({ id: true }).extend({
  serviceType: z.enum(SERVICE_TYPES),
  fabricName: optionalText(120),
  fabricColor: optionalText(80),
  fabricReference: optionalText(80),
  technicalNotes: optionalText(2000),
  /** Estabilização da Fase 2: titular previsto (intenção; aplicado na OS gerada na chegada). */
  plannedUpholstererUserId: idSchema.nullable().optional(),
  /** Mão de obra PREVISTA por unidade, em centavos (exige titular previsto). Não é pagamento. */
  plannedLaborUnitCents: plannedLaborCents.nullable().optional(),
});

export const newServicePickupSchema = z
  .object({
    scheduledDate: dateOnly.nullable().optional(),
    /** Horário de CHEGADA ao endereço do cliente (não há horário de término). */
    windowStart: timeOnly.nullable().optional(),
    team: z.enum(PICKUP_TEAMS),
    /** Profissional responsável (equipe própria: padrão da empresa; terceirizada: André). */
    logisticsUserId: idSchema.nullable().optional(),
    /** Quem executa junto (ex.: Izaías). Não são credores (Fase 6). */
    participantUserIds: z.array(idSchema).max(6).default([]),
    /**
     * Terceirizada: valor TOTAL combinado (vira obrigação do recebedor quando realizada).
     * Equipe própria: custo OPERACIONAL da retirada (só custeio; nunca dívida com funcionário).
     * Exige financeiro.gerenciar.
     */
    amountCents: z.number().int().min(1).max(10_000_000).nullable().optional(),
    instructions: optionalText(1000),
    notes: optionalText(200),
  })
  .superRefine((v, ctx) => {
    refineWindow(v, ctx);
    if (new Set(v.participantUserIds).size !== v.participantUserIds.length)
      ctx.addIssue({
        code: 'custom',
        path: ['participantUserIds'],
        message: 'Participante repetido.',
      });
    // Rodada 3 (F2-18, decisão do proprietário): equipe própria pode informar o custo
    // OPERACIONAL da retirada (custeio, sem obrigação nem pagamento) — ver `upsertTripCost`.
  });

export const newServicePaymentSchema = z.object({
  model: z.enum(PAYMENT_MODELS),
  /** 50/50: valor da entrada (padrão: metade). */
  entryCents: z.number().int().min(1).max(100_000_000).nullable().optional(),
  entryDueDate: dateOnly.nullable().optional(),
  entryMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  balanceMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  /** Pix/cartão 100%: vencimento (padrão: hoje). */
  dueDate: dateOnly.nullable().optional(),
  /** Cartão: parcelas (1..12). */
  installments: z.number().int().min(1).max(MAX_INSTALLMENTS).nullable().optional(),
});
export type NewServicePaymentInput = z.input<typeof newServicePaymentSchema>;

export const newServiceSchema = z
  .object({
    customer: newServiceCustomerSchema,
    service: z.object({
      contractedService: trimmed(2, 300, 'Serviço contratado'),
      description: optionalText(2000),
      /** Valor total fechado com o cliente (exige pedidos.valores). */
      agreedValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      paymentTerms: optionalText(1000),
      /** Cobrança (AM-1): condição estruturada; gera as cobranças junto com o pedido. */
      payment: newServicePaymentSchema.nullable().optional(),
      /** Prazo de entrega combinado (obrigatório; copiado para a OS gerada na chegada). */
      promisedDate: requiredPromisedDate,
      technicalNotes: optionalText(4000),
      notes: optionalText(2000),
      items: z.array(newServiceItemSchema).min(1, { message: 'Inclua ao menos uma peça.' }).max(50),
    }),
    /**
     * Retirada na casa do cliente. `null` (ou ausente) = o CLIENTE ENTREGA as peças na tapeçaria:
     * nenhuma retirada, responsável, custo de logística ou agenda é criado (estabilização da Fase 2).
     */
    pickup: newServicePickupSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    refinePlannedIntent(v.service.items, ctx, ['service', 'items']);
    if (v.pickup && v.customer.mode === 'NOVO' && !v.customer.address)
      ctx.addIssue({
        code: 'custom',
        path: ['customer', 'address'],
        message: 'Informe o endereço de retirada (ou marque que o cliente entrega as peças).',
      });
  });
export type NewServiceInput = z.input<typeof newServiceSchema>;

/**
 * Estabilização da Fase 2: alterar o titular / a mão de obra previstos de um pedido depois do
 * fechamento. Vale só para as OS geradas a partir de agora (as já geradas não mudam).
 */
export const orderPlannedIntentSchema = z
  .object({
    version: versionSchema,
    items: z
      .array(
        z.object({
          orderItemId: idSchema,
          plannedUpholstererUserId: idSchema.nullable(),
          plannedLaborUnitCents: plannedLaborCents.nullable(),
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((v, ctx) => {
    refinePlannedIntent(v.items, ctx, ['items']);
    if (new Set(v.items.map((i) => i.orderItemId)).size !== v.items.length)
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Peça repetida.' });
  });
export type OrderPlannedIntentInput = z.input<typeof orderPlannedIntentSchema>;

/** Responsável padrão da equipe própria (Empresa). `null` remove a configuração. */
export const ownTeamSettingsSchema = z.object({
  userId: idSchema.nullable(),
  version: versionSchema,
});

// ─────────────── Simplificação Fase 3 — chegada compartilhada nos tablets ───────────────

/** Confirmação rápida da chegada das peças de uma retirada (padrão: tudo o que falta). */
export const confirmPieceArrivalSchema = z.object({
  /** Versão da retirada vista na tela (recusa confirmação desatualizada). */
  version: versionSchema,
  /** Peças que chegaram agora; ausente = todo o saldo da retirada. */
  lines: z
    .array(z.object({ orderItemId: idSchema, quantity: z.number().int().min(0).max(200) }))
    .max(50)
    .optional(),
  /** Opcional — divergência/avaria percebida na chegada. */
  problem: z
    .object({ note: z.string().trim().min(3, 'Descreva o problema.').max(1000) })
    .nullable()
    .optional(),
});
export type ConfirmPieceArrivalInput = z.input<typeof confirmPieceArrivalSchema>;
