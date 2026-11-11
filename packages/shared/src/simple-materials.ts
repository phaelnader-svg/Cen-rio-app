import { z } from 'zod';
import { idSchema, optionalText, trimmed, versionSchema } from './schemas/common';

/**
 * Reformulação, Fase 1 — materiais necessários da OS (lista simples) e estoque simples.
 *
 * Materiais da OS: "comprado" e "na oficina" são INDEPENDENTES (as quatro combinações valem;
 * nenhum implica o outro). O custo é opcional: `null` = não informado, que é diferente de zero.
 * Nada aqui gera compra formal, reserva, movimento de estoque, conta a pagar ou pagamento.
 *
 * Regra de custo (fonte de verdade e conciliação):
 *  - Cada material conta uma única vez, pela sua própria fonte. Material da lista simples → o custo
 *    informado na linha. Material de compra formal, saída de estoque ou sobra → o livro de custos
 *    formal (como antes). A lista simples nunca cria registros formais, e os registros formais nunca
 *    criam linhas simples: não há caminho automático de duplicidade.
 *  - O custo de uma linha entra no realizado da OS só com "comprado" marcado; antes disso é previsão.
 *  - Linha comprada sem custo = "sem preço": o total fica subestimado e a OS mostra o aviso (nunca
 *    vira zero silencioso). Linha não comprada sem custo = previsão sem preço.
 *  - O realizado vai para o livro de custos imutável por lançamentos compensatórios (origem
 *    MATERIAL_OS): editar o custo, desmarcar "comprado" ou remover a linha lança a diferença, sem
 *    reescrever nada. Relatórios e margens leem o livro, então nada some deles.
 *  - Se a mesma OS tiver custo formal e custo informado na lista simples, o resultado mostra um
 *    aviso para o gestor conferir se o mesmo material não foi lançado nos dois fluxos.
 */

/** Quantidade opcional (positiva, até 3 casas). */
const quantity = z
  .number({ message: 'Quantidade inválida.' })
  .positive('A quantidade deve ser maior que zero.')
  .max(1_000_000)
  .refine(
    (v) => Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6,
    'Use no máximo 3 casas decimais.',
  );

/** Quantidade de estoque (zero permitido). */
export const stockQuantitySchema = z
  .number({ message: 'Quantidade inválida.' })
  .min(0, 'A quantidade não pode ser negativa.')
  .max(1_000_000)
  .refine(
    (v) => Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6,
    'Use no máximo 3 casas decimais.',
  );

/** Custo em centavos: null = não informado (diferente de zero). */
export const optionalCostCents = z
  .number({ message: 'Custo inválido.' })
  .int('Custo em centavos.')
  .min(0, 'O custo não pode ser negativo.')
  .max(1_000_000_000)
  .nullable();

// ------------------------------------------------------------------ materiais da OS
export const osMaterialCreateSchema = z.object({
  description: trimmed(2, 200, 'Material'),
  categoryId: idSchema.nullable().optional(),
  inventoryItemId: idSchema.nullable().optional(),
  quantity: quantity.nullable().optional(),
  unit: optionalText(20),
  notes: optionalText(500),
  purchased: z.boolean().optional(),
  available: z.boolean().optional(),
  costCents: optionalCostCents.optional(),
});
export type OsMaterialCreateInput = z.infer<typeof osMaterialCreateSchema>;

/** Edição parcial: só os campos enviados mudam. Sempre com a versão lida. */
export const osMaterialUpdateSchema = osMaterialCreateSchema
  .partial()
  .extend({ version: versionSchema })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nada para alterar.');
export type OsMaterialUpdateInput = z.infer<typeof osMaterialUpdateSchema>;

export const osMaterialRemoveSchema = z.object({ version: versionSchema });

export interface OsMaterialDto {
  id: string;
  serviceOrderId: string;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
  purchased: boolean;
  available: boolean;
  /** Só para quem vê o financeiro; `undefined` quando oculto, `null` quando não informado. */
  costCents?: number | null;
  version: number;
  updatedAt: string;
  updatedBy: { id: string; displayName: string } | null;
}

export interface OsMaterialsSummary {
  total: number;
  purchased: number;
  available: number;
  /** Linhas ainda não disponíveis na oficina (só informativo: nunca bloqueia a produção). */
  notAvailable: number;
}

export interface OsMaterialsDto {
  materials: OsMaterialDto[];
  summary: OsMaterialsSummary;
  /** Aviso discreto (null = nada pendente). */
  notice: string | null;
  /** O usuário vê e edita custos (financeiro.ver). */
  canSeeCosts: boolean;
}

export const MATERIALS_PENDING_NOTICE = 'Existem materiais ainda não disponíveis na oficina.';

export function summarizeOsMaterials(
  rows: readonly { purchased: boolean; available: boolean }[],
): OsMaterialsSummary {
  const purchased = rows.filter((r) => r.purchased).length;
  const available = rows.filter((r) => r.available).length;
  return { total: rows.length, purchased, available, notAvailable: rows.length - available };
}

/**
 * Quanto do custo de uma linha está realizado (vai para o livro de custos): só com "comprado" e
 * custo informado; linha removida = 0 (o lançamento compensatório zera o que já foi lançado).
 */
export function realizedOsMaterialCost(row: {
  purchased: boolean;
  costCents: number | null;
  removed: boolean;
}): number {
  return !row.removed && row.purchased && row.costCents !== null ? row.costCents : 0;
}

/** Classificação de custo da lista simples para o resumo de materiais da OS. */
export function osMaterialCostTotals(
  rows: readonly { purchased: boolean; costCents: number | null }[],
) {
  let forecastCents = 0;
  let forecastUnpriced = 0;
  let realizedCents = 0;
  let realizedUnpriced = 0;
  for (const r of rows) {
    if (r.costCents === null) {
      if (r.purchased) realizedUnpriced += 1;
      else forecastUnpriced += 1;
    } else {
      forecastCents += r.costCents;
      if (r.purchased) realizedCents += r.costCents;
    }
  }
  return { forecastCents, forecastUnpriced, realizedCents, realizedUnpriced };
}

// ------------------------------------------------------------------ estoque simples
export const inventoryCategoryCreateSchema = z.object({
  name: trimmed(2, 60, 'Nome da categoria'),
  position: z.number().int().min(0).max(10_000).optional(),
});
export const inventoryCategoryUpdateSchema = inventoryCategoryCreateSchema
  .partial()
  .extend({ version: versionSchema });

export const inventoryItemCreateSchema = z.object({
  name: trimmed(2, 160, 'Nome do material'),
  categoryId: idSchema.nullable().optional(),
  unit: trimmed(1, 20, 'Unidade'),
  quantity: stockQuantitySchema.optional(),
  referenceCostCents: optionalCostCents.optional(),
  location: optionalText(120),
  notes: optionalText(500),
});
/** Edição do cadastro. A quantidade NÃO muda aqui: só por ajuste (com histórico). */
export const inventoryItemUpdateSchema = inventoryItemCreateSchema
  .omit({ quantity: true })
  .partial()
  .extend({ version: versionSchema });

export const fabricRollCreateSchema = z.object({
  code: trimmed(1, 40, 'Identificação do rolo'),
  color: optionalText(60),
  reference: optionalText(80),
  meters: stockQuantitySchema.optional(),
  notes: optionalText(500),
});
/** Edição do cadastro do rolo. A metragem NÃO muda aqui: só por ajuste (com histórico). */
export const fabricRollUpdateSchema = fabricRollCreateSchema
  .omit({ meters: true })
  .partial()
  .extend({ version: versionSchema });

/** Ajuste manual: informa o valor NOVO (o anterior é registrado pelo servidor). */
export const inventoryAdjustSchema = z.object({
  newQuantity: stockQuantitySchema,
  reason: optionalText(500),
  version: versionSchema,
});

export const archiveSchema = z.object({ archived: z.boolean(), version: versionSchema });
export const removeVersionSchema = z.object({ version: versionSchema });

export interface InventoryCategoryDto {
  id: string;
  name: string;
  position: number;
  archived: boolean;
  itemCount: number;
  /** Pode ser excluída (sem materiais nem uso em OS); senão, só arquivada. */
  deletable: boolean;
  version: number;
}

export interface FabricRollDto {
  id: string;
  itemId: string;
  code: string;
  color: string | null;
  reference: string | null;
  meters: number;
  notes: string | null;
  archived: boolean;
  deletable: boolean;
  version: number;
  updatedAt: string;
}

export interface InventoryItemDto {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  unit: string;
  quantity: number;
  referenceCostCents?: number | null;
  location: string | null;
  notes: string | null;
  archived: boolean;
  deletable: boolean;
  rolls: FabricRollDto[];
  /** Soma da metragem dos rolos ativos (null = material sem rolos). */
  rollMeters: number | null;
  version: number;
  updatedAt: string;
}

export interface InventoryAdjustmentDto {
  id: string;
  itemId: string | null;
  rollId: string | null;
  previousQuantity: number;
  newQuantity: number;
  reason: string | null;
  actor: { id: string; displayName: string } | null;
  createdAt: string;
}

// ------------------------------------------------------------------ entrega direta pela OS
export const directDeliverySchema = z.object({
  note: optionalText(1000),
});
export type DirectDeliveryInput = z.infer<typeof directDeliverySchema>;

/** Motivo de uma peça não poder ser entregue agora (para a OS mostrar o que falta). */
export interface DirectDeliveryBlock {
  itemId: string;
  code: string;
  reasons: string[];
}

export interface DirectDeliveryEligibilityDto {
  /** A OS pode ser marcada como entregue agora. */
  eligible: boolean;
  /** Todas as peças ativas já estão entregues. */
  delivered: boolean;
  /** Peças que seriam entregues por esta ação. */
  pendingItems: { itemId: string; code: string }[];
  blocks: DirectDeliveryBlock[];
  /** Entrega registrada (a mais recente), quando houver. */
  lastDelivery: {
    id: string;
    code: string;
    origin: 'LOGISTICA' | 'DIRETA';
    completedAt: string | null;
    confirmedBy: { id: string; displayName: string } | null;
  } | null;
}

export interface DirectDeliveryResultDto {
  /** false = a OS já estava entregue (repetição idempotente, nada foi gravado). */
  created: boolean;
  deliveryId: string | null;
  deliveryCode: string | null;
  deliveredItems: number;
  eligibility: DirectDeliveryEligibilityDto;
}
