import { z } from 'zod';
import { PIECE_TYPES, SERVICE_TYPES, type PieceType, type ServiceType } from './domain';
import { checklistFor } from './quality-domain';
import { idSchema, optionalText, trimmed, versionSchema } from './schemas/common';

/**
 * Reformulação, Fase 2 — MODELOS DE SERVIÇO.
 *
 * Um "modelo de serviço" é a combinação (tipo de peça × tipo de serviço) e reúne, numa só tela, o
 * que já existia espalhado:
 *  - as ETAPAS de produção (modelo de produção escolhido pela mesma regra do planejamento:
 *    {@link selectProductionTemplate} — específico do serviço, senão o geral);
 *  - o CHECKLIST de qualidade (o mesmo da inspeção: primeiro modelo ativo do tipo de peça por nome,
 *    só com os itens do serviço — {@link checklistFor});
 *  - a LISTA PADRÃO DE MATERIAIS (nova): por tipo de peça, para um serviço ou para todos.
 *
 * Nada é duplicado: etapas e checklist continuam guardados e editados onde sempre estiveram; esta
 * tela só mostra o efeito combinado e leva ao editor certo.
 *
 * Materiais padrão são SUGESTÃO: aplicados numa OS viram linhas da lista simples SEM custo, NÃO
 * compradas e NÃO disponíveis, que o gestor revisa, altera ou remove. Nunca geram compra, despesa,
 * custo realizado ou movimento de estoque.
 */

export const pieceTypeSchema = z.enum(PIECE_TYPES);
export const serviceTypeSchema = z.enum(SERVICE_TYPES);

/** Quantidade POR PEÇA (positiva, até 3 casas). */
const perPieceQuantity = z
  .number({ message: 'Quantidade inválida.' })
  .positive('A quantidade deve ser maior que zero.')
  .max(1_000_000)
  .refine(
    (v) => Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6,
    'Use no máximo 3 casas decimais.',
  );

export const serviceModelMaterialCreateSchema = z.object({
  pieceType: pieceTypeSchema,
  /** null = qualquer serviço deste tipo de peça. */
  serviceType: serviceTypeSchema.nullable(),
  description: trimmed(2, 200, 'Material'),
  categoryId: idSchema.nullable().optional(),
  inventoryItemId: idSchema.nullable().optional(),
  quantity: perPieceQuantity.nullable().optional(),
  unit: optionalText(20),
  notes: optionalText(500),
  position: z.number().int().min(0).max(10_000).optional(),
});
export type ServiceModelMaterialCreateInput = z.infer<typeof serviceModelMaterialCreateSchema>;

export const serviceModelMaterialUpdateSchema = serviceModelMaterialCreateSchema
  .omit({ pieceType: true })
  .partial()
  .extend({ version: versionSchema })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nada para alterar.');
export type ServiceModelMaterialUpdateInput = z.infer<typeof serviceModelMaterialUpdateSchema>;

export const serviceModelMaterialArchiveSchema = z.object({ version: versionSchema });

export const serviceModelQuerySchema = z.object({
  pieceType: pieceTypeSchema,
  serviceType: serviceTypeSchema,
});

export interface ServiceModelMaterialDto {
  id: string;
  pieceType: PieceType;
  serviceType: ServiceType | null;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
  position: number;
  version: number;
  updatedAt: string;
}

/** Materiais padrão que valem para a peça: do tipo de peça, gerais (serviço null) ou do serviço. */
export function modelMaterialsFor<
  T extends { pieceType: string; serviceType: string | null; archived?: boolean },
>(materials: readonly T[], piece: { pieceType: string; serviceType: string }): T[] {
  return materials.filter(
    (m) =>
      !m.archived &&
      m.pieceType === piece.pieceType &&
      (m.serviceType === null || m.serviceType === piece.serviceType),
  );
}

/** O que a tela unificada mostra para uma combinação peça × serviço. */
export interface ServiceModelDto {
  pieceType: PieceType;
  serviceType: ServiceType;
  /** `undefined` = sem permissão de ver etapas (producao.ver/planejar). */
  production?: {
    template: { id: string; name: string; general: boolean } | null;
    steps: { position: number; name: string; optional: boolean }[];
  };
  /** `undefined` = sem permissão de ver checklists (qualidade.gerenciar). */
  quality?: {
    template: { id: string; name: string } | null;
    /** Itens que a inspeção usará (sem modelo: o checklist mínimo do sistema). */
    items: { label: string; required: boolean }[];
  };
  materials: ServiceModelMaterialDto[];
}

/** Visão geral: uma linha por combinação, com o que está configurado. */
export interface ServiceModelOverviewRowDto {
  pieceType: PieceType;
  serviceType: ServiceType;
  productionTemplate?: { id: string; name: string; general: boolean } | null;
  qualityTemplate?: { id: string; name: string; items: number } | null;
  materials: number;
}

export interface ServiceModelOverviewDto {
  rows: ServiceModelOverviewRowDto[];
  can: { production: boolean; quality: boolean; materials: boolean };
}

/** Checklist mínimo que a inspeção usa quando não há modelo ativo do tipo de peça. */
export const DEFAULT_QUALITY_CHECKLIST = [
  { label: 'Acabamento', required: true },
  { label: 'Conformidade com a OS', required: true },
] as const;

/** Itens efetivos do checklist (mesma regra da inspeção). */
export function effectiveChecklist<
  T extends { label: string; required: boolean; serviceTypes: readonly string[] },
>(template: { items: readonly T[] } | null, serviceType: ServiceType) {
  return template
    ? checklistFor(template.items, serviceType).map((i) => ({
        label: i.label,
        required: i.required,
      }))
    : DEFAULT_QUALITY_CHECKLIST.map((i) => ({ ...i }));
}

// ------------------------------------------------------------------ sugestão na OS

/** Linha sugerida para a OS (somada entre as peças que pedem o mesmo material padrão). */
export interface OsMaterialSuggestionDto {
  modelMaterialId: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  categoryName: string | null;
  inventoryItemName: string | null;
  /** Peças da OS de onde a sugestão vem (ex.: "Sofá · Troca de tecido (2)"). */
  sources: string[];
  /** Já existe na lista da OS (sugerida antes e não removida): não será adicionada de novo. */
  alreadyAdded: boolean;
}

export interface OsMaterialSuggestionsDto {
  suggestions: OsMaterialSuggestionDto[];
  /** Combinações da OS sem nenhum material padrão configurado. */
  withoutModel: string[];
}

export const osMaterialSuggestApplySchema = z.object({
  /** Materiais padrão escolhidos (vazio não é aceito). */
  modelMaterialIds: z.array(idSchema).min(1, 'Escolha ao menos um material.').max(200),
});
export type OsMaterialSuggestApplyInput = z.infer<typeof osMaterialSuggestApplySchema>;

/** Texto padrão da observação de uma linha sugerida. */
export const SUGGESTED_MATERIAL_NOTE =
  'Sugerido pelo modelo de serviço — revise quantidade e custo.';

/** Soma de quantidades com 3 casas (evita 0,30000000000000004). */
export function addQuantity(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return a ?? b;
  return Math.round((a + b) * 1000) / 1000;
}
