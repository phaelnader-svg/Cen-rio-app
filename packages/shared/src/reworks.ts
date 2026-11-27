import { z } from 'zod';
import { formatNumber } from './domain';
import { PAYMENT_METHODS, type PaymentMethod } from './finance-domain';
import { newServicePickupSchema } from './schemas/commercial';

/**
 * Retrabalhos (2026-11-18) — substituem "Devoluções" no menu. Um serviço já feito volta para ser
 * refeito: o retrabalho (RT-00001) vira um pedido próprio, SEM cobrança, com a retirada e a OS
 * normais do sistema (as mesmas telas, a mesma programação). Tudo que nasce dele aparece em
 * vermelho (agenda, OS, pedido) e o gasto entra no Resumo do financeiro.
 */

export const reworkCode = (n: number) => formatNumber('RT', n);

export const REWORK_CAUSES = [
  'ERRO_EXECUCAO',
  'DEFEITO_MATERIAL',
  'DANO_TRANSPORTE',
  'PEDIDO_CLIENTE',
  'OUTRO',
] as const;
export type ReworkCause = (typeof REWORK_CAUSES)[number];
export const REWORK_CAUSE_LABEL: Record<ReworkCause, string> = {
  ERRO_EXECUCAO: 'Erro na execução',
  DEFEITO_MATERIAL: 'Defeito de material',
  DANO_TRANSPORTE: 'Dano no transporte',
  PEDIDO_CLIENTE: 'Pedido do cliente',
  OUTRO: 'Outro motivo',
};

/** Onde o retrabalho está (derivado do pedido, da retirada e das OS; nunca digitado). */
export const REWORK_STAGES = [
  'AGUARDANDO_RETIRADA',
  'AGUARDANDO_PECAS',
  'NA_OFICINA',
  'EM_PRODUCAO',
  'CONCLUIDO',
  'CANCELADO',
] as const;
export type ReworkStage = (typeof REWORK_STAGES)[number];
export const REWORK_STAGE_LABEL: Record<ReworkStage, string> = {
  AGUARDANDO_RETIRADA: 'Retirada agendada',
  AGUARDANDO_PECAS: 'Aguardando as peças',
  NA_OFICINA: 'Na oficina, sem OS',
  EM_PRODUCAO: 'Em produção',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
};

const text = (min: number, max: number, label: string) =>
  z
    .string({ error: `Informe ${label}.` })
    .trim()
    .min(min, { message: `Informe ${label}.` })
    .max(max, { message: `${label[0]!.toUpperCase()}${label.slice(1)} muito longo.` });

export const reworkCreateSchema = z.object({
  /** Pedido do serviço que voltou. */
  originalOrderId: z.guid({ message: 'Escolha o serviço que precisa ser refeito.' }),
  /** Peças do pedido original que voltam (com a quantidade). */
  items: z
    .array(
      z.object({
        orderItemId: z.guid(),
        quantity: z.number().int().min(1).max(200),
      }),
    )
    .min(1, { message: 'Marque ao menos uma peça.' })
    .max(50),
  /** O que precisa ser refeito (vai para o pedido e para a OS). */
  reason: text(3, 1000, 'o que precisa ser refeito'),
  cause: z.enum(REWORK_CAUSES, { message: 'Escolha o motivo.' }),
  /** Prazo combinado em dias úteis, contado do dia da retirada (ou de hoje). */
  deliveryBusinessDays: z
    .number({ message: 'Informe o prazo em dias úteis.' })
    .int({ message: 'Informe o prazo em dias úteis.' })
    .min(1, { message: 'O prazo precisa ter pelo menos 1 dia útil.' })
    .max(120, { message: 'Prazo longo demais.' }),
  /** Retirada na casa do cliente; `null` = o cliente traz as peças. */
  pickup: newServicePickupSchema.nullable().optional(),
  /** Gasto fora da OS (deslocamento extra, peça comprada à parte...). Exige financeiro. */
  extraCostCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  extraCostNote: z.string().trim().max(300).nullable().optional(),
});
export type ReworkCreateInput = z.input<typeof reworkCreateSchema>;

export const reworkUpdateSchema = z.object({
  version: z.number().int().min(1),
  reason: text(3, 1000, 'o que precisa ser refeito').optional(),
  cause: z.enum(REWORK_CAUSES).optional(),
  extraCostCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  extraCostNote: z.string().trim().max(300).nullable().optional(),
});
export type ReworkUpdateInput = z.input<typeof reworkUpdateSchema>;

export const reworkCancelSchema = z.object({
  version: z.number().int().min(1),
  reason: text(3, 500, 'o motivo do cancelamento'),
});

export interface ReworkCostDto {
  materialsCents: number;
  laborCents: number;
  logisticsCents: number;
  extraCents: number;
  totalCents: number;
}

export interface ReworkDto {
  id: string;
  number: number;
  code: string;
  stage: ReworkStage;
  cause: ReworkCause;
  reason: string;
  customer: { id: string; name: string; phone: string | null };
  originalOrder: { id: string; code: string; service: string };
  order: { id: string; code: string };
  items: { orderItemId: string; description: string; quantity: number }[];
  /** Prazo combinado (data) e se já passou sem concluir. */
  promisedDate: string | null;
  late: boolean;
  pickup: {
    id: string;
    code: string;
    scheduledDate: string | null;
    windowStart: string | null;
    status: string;
  } | null;
  serviceOrders: { id: string; code: string; status: string }[];
  /** Peças já na oficina e ainda sem OS: dá para gerar a OS do retrabalho. */
  canGenerateOs: boolean;
  /** Só com financeiro.ver. */
  cost: ReworkCostDto | null;
  extraCostNote: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  version: number;
}

/** Estatística do período (tela Retrabalhos e Resumo do financeiro). */
export interface ReworkStatsDto {
  from: string;
  to: string;
  /** Retrabalhos abertos no período (sem os cancelados). */
  count: number;
  /** Serviços entregues no período, para comparar (taxa de retrabalho). */
  deliveredOrders: number;
  /** Retrabalhos ÷ pedidos entregues, em pontos-base (nulo sem entregas). */
  rateBps: number | null;
  byCause: { cause: ReworkCause; count: number }[];
  /** Últimos 6 meses, do mais antigo ao atual. */
  byMonth: { month: string; count: number }[];
  /** Gasto com os retrabalhos do período (só com financeiro.ver). */
  cost: ReworkCostDto | null;
}

// ─────────────────────────── Receitas e despesas (financeiro) ───────────────────────────

/** Uma linha do dinheiro que entrou ou saiu (abas Receitas e Despesas do financeiro). */
export interface CashLineDto {
  id: string;
  /** Data do pagamento/recebimento (AAAA-MM-DD). */
  date: string;
  /** De onde veio a linha (para o link e o filtro). */
  source:
    | 'COBRANCA'
    | 'RECEITA_AVULSA'
    | 'CONTA'
    | 'DESPESA_AVULSA'
    | 'MAO_DE_OBRA'
    | 'LOGISTICA'
    | 'GASTO_FIXO';
  description: string;
  /** Cliente, fornecedor ou quem recebeu. */
  party: string | null;
  category: string | null;
  method: string | null;
  /** Negativo = estorno ou reembolso. */
  amountCents: number;
  /** Código do registro de origem (RC-00001, CPG-00001, PG-00001...). */
  reference: string | null;
  /** Receita avulsa lançada aqui (pode ser cancelada nesta tela). */
  manual: boolean;
  cancelled: boolean;
}

export interface CashLedgerDto {
  from: string;
  to: string;
  totalCents: number;
  bySource: { source: CashLineDto['source']; totalCents: number }[];
  lines: CashLineDto[];
}

export const CASH_SOURCE_LABEL: Record<CashLineDto['source'], string> = {
  COBRANCA: 'Pagamento de cliente',
  RECEITA_AVULSA: 'Receita avulsa',
  CONTA: 'Conta paga',
  DESPESA_AVULSA: 'Despesa avulsa',
  MAO_DE_OBRA: 'Mão de obra',
  LOGISTICA: 'Logística',
  GASTO_FIXO: 'Gasto fixo',
};

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida.' });
const money = z
  .number({ message: 'Informe o valor.' })
  .int()
  .min(1, { message: 'Informe o valor.' })
  .max(100_000_000, { message: 'Valor alto demais.' });

/** Incluir despesa: algo que já foi pago (vira uma conta paga, que aparece também em A pagar). */
export const manualExpenseSchema = z.object({
  date: dateOnly,
  description: text(2, 200, 'a descrição'),
  beneficiary: text(2, 160, 'para quem foi pago'),
  category: text(2, 30, 'a categoria'),
  amountCents: money,
  method: z.enum(PAYMENT_METHODS),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type ManualExpenseInput = z.input<typeof manualExpenseSchema>;

export const MANUAL_REVENUE_CATEGORIES = [
  'Venda de material',
  'Serviço avulso',
  'Reembolso',
  'Aporte do dono',
  'Outros',
] as const;

/** Incluir receita: dinheiro que entrou fora das cobranças de pedido. */
export const manualRevenueSchema = z.object({
  date: dateOnly,
  description: text(2, 200, 'a descrição'),
  category: text(2, 40, 'a categoria'),
  amountCents: money,
  method: z.enum(PAYMENT_METHODS),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type ManualRevenueInput = z.input<typeof manualRevenueSchema>;

export const manualRevenueCancelSchema = z.object({
  reason: text(3, 500, 'o motivo'),
});

export type { PaymentMethod };
