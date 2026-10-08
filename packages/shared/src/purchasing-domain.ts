/**
 * Fase 4 — compras, recebimento de materiais e estoque híbrido: enumerações,
 * rótulos e regras puras (testadas isoladamente e usadas pela API e pela web).
 */
import type { MaterialKind } from './domain';
import { formatNumber } from './domain';
import type { MaterialUnit } from './measurements-domain';

export const PURCHASE_PREFIX = { purchaseOrder: 'CP', materialReceipt: 'RM', stockItem: 'MT' };
export const purchaseOrderCode = (n: number) => formatNumber(PURCHASE_PREFIX.purchaseOrder, n);
export const materialReceiptCode = (n: number) => formatNumber(PURCHASE_PREFIX.materialReceipt, n);
export const stockItemCode = (n: number) => formatNumber(PURCHASE_PREFIX.stockItem, n);

export const PURCHASE_ORDER_STATUSES = [
  'RASCUNHO',
  'CONFIRMADO',
  'PARCIALMENTE_RECEBIDO',
  'RECEBIDO',
  'CANCELADO',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export const PURCHASE_ORDER_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  RASCUNHO: 'Rascunho',
  CONFIRMADO: 'Confirmado',
  PARCIALMENTE_RECEBIDO: 'Parcialmente recebido',
  RECEBIDO: 'Recebido',
  CANCELADO: 'Cancelado',
};
/** Pedidos que aguardam (ou ainda podem receber) material. */
export const PURCHASE_ORDER_RECEIVABLE: readonly PurchaseOrderStatus[] = [
  'CONFIRMADO',
  'PARCIALMENTE_RECEBIDO',
];
/** Pedidos que contam como "comprado". */
export const PURCHASE_ORDER_COMMITTED: readonly PurchaseOrderStatus[] = [
  'CONFIRMADO',
  'PARCIALMENTE_RECEBIDO',
  'RECEBIDO',
];

export const RECEIPT_ISSUES = ['INCORRETO', 'DANIFICADO', 'INCOMPLETO', 'OUTRO'] as const;
export type ReceiptIssue = (typeof RECEIPT_ISSUES)[number];
export const RECEIPT_ISSUE_LABEL: Record<ReceiptIssue, string> = {
  INCORRETO: 'Material incorreto (referência/especificação)',
  DANIFICADO: 'Danificado',
  INCOMPLETO: 'Incompleto',
  OUTRO: 'Outro problema',
};

export const STOCK_MOVEMENT_TYPES = [
  'ENTRADA_COMPRA',
  'ESTORNO_RECEBIMENTO',
  'SAIDA_OS',
  'AJUSTE_ENTRADA',
  'AJUSTE_SAIDA',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const STOCK_MOVEMENT_LABEL: Record<StockMovementType, string> = {
  ENTRADA_COMPRA: 'Entrada por compra',
  ESTORNO_RECEBIMENTO: 'Estorno de recebimento',
  SAIDA_OS: 'Saída para OS',
  AJUSTE_ENTRADA: 'Ajuste (entrada)',
  AJUSTE_SAIDA: 'Ajuste (saída)',
};

export const RESERVATION_STATUSES = ['ATIVA', 'CONSUMIDA', 'LIBERADA'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  ATIVA: 'Reservada',
  CONSUMIDA: 'Entregue à OS',
  LIBERADA: 'Liberada',
};

export const LEFTOVER_CONDITIONS = ['BOA', 'AVARIADA'] as const;
export type LeftoverCondition = (typeof LEFTOVER_CONDITIONS)[number];
export const LEFTOVER_CONDITION_LABEL: Record<LeftoverCondition, string> = {
  BOA: 'Boa',
  AVARIADA: 'Avariada',
};
export const LEFTOVER_STATUSES = ['DISPONIVEL', 'ESGOTADA', 'DESCARTADA'] as const;
export type LeftoverStatus = (typeof LEFTOVER_STATUSES)[number];
export const LEFTOVER_STATUS_LABEL: Record<LeftoverStatus, string> = {
  DISPONIVEL: 'Guardada na OS de origem',
  ESGOTADA: 'Transferida/esgotada',
  DESCARTADA: 'Descartada',
};

export const MATERIAL_READINESS_STATES = [
  'SEM_LEVANTAMENTO',
  'AGUARDANDO_APROVACAO',
  'AGUARDANDO_COMPRA',
  'AGUARDANDO_RECEBIMENTO',
  'PARCIALMENTE_DISPONIVEL',
  'COMPLETO',
  'COM_DIVERGENCIA',
] as const;
export type MaterialReadiness = (typeof MATERIAL_READINESS_STATES)[number];
export const MATERIAL_READINESS_LABEL: Record<MaterialReadiness, string> = {
  SEM_LEVANTAMENTO: 'Sem levantamento',
  AGUARDANDO_APROVACAO: 'Aguardando aprovação',
  AGUARDANDO_COMPRA: 'Aguardando compra',
  AGUARDANDO_RECEBIMENTO: 'Aguardando recebimento',
  PARCIALMENTE_DISPONIVEL: 'Parcialmente disponível',
  COMPLETO: 'Completo',
  COM_DIVERGENCIA: 'Com divergência',
};

/** Situação de cada material da OS (as 7 etapas distinguidas pelo sistema). */
export const LINE_STAGES = [
  'SOLICITADO',
  'APROVADO',
  'COMPRADO',
  'PARCIALMENTE_RECEBIDO',
  'RECEBIDO_CONFERIDO',
  'RESERVADO',
  'DISPONIVEL',
] as const;
export type LineStage = (typeof LINE_STAGES)[number];
export const LINE_STAGE_LABEL: Record<LineStage, string> = {
  SOLICITADO: 'Solicitado',
  APROVADO: 'Aprovado para compra',
  COMPRADO: 'Comprado',
  PARCIALMENTE_RECEBIDO: 'Parcialmente recebido',
  RECEBIDO_CONFERIDO: 'Recebido e conferido',
  RESERVADO: 'Reservado para a OS',
  DISPONIVEL: 'Disponível para execução',
};

// ─────────────────────────── Quantidades e dinheiro ───────────────────────────

/** Arredonda para 3 casas (precisão de NUMERIC(12,3)) evitando ruído de ponto flutuante. */
export const q3 = (n: number) => Math.round(n * 1000) / 1000;

/** Total em centavos de uma linha: quantidade × preço unitário (centavos), arredondado. */
export const lineTotalCents = (quantity: number, unitPriceCents: number | null) =>
  unitPriceCents === null ? null : Math.round(quantity * unitPriceCents);

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ─────────────────────────── Especificação ───────────────────────────

const norm = (v: string | number | null | undefined) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface MaterialSpec {
  kind: MaterialKind;
  description: string;
  color?: string | null;
  reference?: string | null;
  foamDensity?: string | null;
  thicknessCm?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  unit: MaterialUnit;
}

/**
 * Chave da especificação: dois materiais só são "o mesmo" (somáveis, reservados um
 * pelo outro, transferidos) quando tipo, descrição, cor, referência, densidade,
 * dimensões e unidade coincidem. Unidades diferentes nunca são somadas.
 */
export function specKey(s: MaterialSpec): string {
  return [
    s.kind,
    norm(s.description),
    norm(s.color),
    norm(s.reference),
    norm(s.foamDensity),
    s.thicknessCm ?? '',
    s.lengthCm ?? '',
    s.widthCm ?? '',
    s.unit,
  ].join('|');
}

/** Motivo de incompatibilidade entre duas especificações (null = compatíveis). */
export function specMismatch(a: MaterialSpec, b: MaterialSpec): string | null {
  if (a.kind !== b.kind) return 'Tipos de material diferentes.';
  if (a.unit !== b.unit) return 'Unidades diferentes não podem ser somadas.';
  if (specKey(a) !== specKey(b)) {
    return a.kind === 'TECIDO'
      ? 'Tecidos de referência, cor ou características diferentes não podem ser misturados.'
      : 'Especificações diferentes (descrição, densidade ou dimensões).';
  }
  return null;
}

// ─────────────────────────── Prontidão ───────────────────────────

export interface ReadinessLineInput {
  /** Quantidade aprovada (necessidade). */
  need: number;
  /** Quantidade efetivamente disponível para a OS: recebida e conferida (exclusivo) ou reservada (estoque). */
  covered: number;
  /** Quantidade em pedidos confirmados (inclui recebidos). */
  purchased: number;
  /** Recebimento com divergência ainda não resolvido. */
  divergence: boolean;
}

/**
 * Prontidão de materiais da OS, calculada só a partir de registros reais.
 * `pending` = existe medição em aberto ou solicitação ainda não aprovada.
 * Não libera produção: é um indicador para a programação (fases futuras).
 */
export function computeReadiness(lines: ReadinessLineInput[], pending: boolean): MaterialReadiness {
  if (lines.length === 0) return pending ? 'AGUARDANDO_APROVACAO' : 'SEM_LEVANTAMENTO';
  const open = lines.filter((l) => q3(l.covered) < q3(l.need));
  if (lines.some((l) => l.divergence) && open.length > 0) return 'COM_DIVERGENCIA';
  if (open.length === 0) return pending ? 'AGUARDANDO_APROVACAO' : 'COMPLETO';
  if (lines.some((l) => l.covered > 0)) return 'PARCIALMENTE_DISPONIVEL';
  if (pending) return 'AGUARDANDO_APROVACAO';
  if (open.every((l) => q3(l.purchased) >= q3(l.need))) return 'AGUARDANDO_RECEBIMENTO';
  return 'AGUARDANDO_COMPRA';
}

/** Etapa de um material (a mais avançada atingida para toda a quantidade). */
export function lineStage(l: {
  need: number;
  purchased: number;
  received: number;
  reserved: number;
  covered: number;
  exclusive: boolean;
}): LineStage {
  if (q3(l.covered) >= q3(l.need)) return 'DISPONIVEL';
  if (!l.exclusive && l.reserved > 0) return 'RESERVADO';
  if (q3(l.received) >= q3(l.need)) return 'RECEBIDO_CONFERIDO';
  if (l.received > 0) return 'PARCIALMENTE_RECEBIDO';
  if (q3(l.purchased) >= q3(l.need)) return 'COMPRADO';
  return 'APROVADO';
}
