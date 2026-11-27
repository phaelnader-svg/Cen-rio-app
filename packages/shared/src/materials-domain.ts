/**
 * Materiais — o que sobrou de comum depois da remoção de Compras, Medições e Recebimento de
 * materiais (2026-11): unidades da lista simples e das ocorrências de material, formatação de
 * valores e os códigos dos registros antigos (CP-…, MD-…), que continuam legíveis no histórico.
 */
import { formatNumber } from './domain';

export const MATERIAL_UNITS = [
  'METRO',
  'METRO_QUADRADO',
  'PLACA',
  'PECA',
  'UNIDADE',
  'EMBALAGEM',
] as const;
export type MaterialUnit = (typeof MATERIAL_UNITS)[number];
export const MATERIAL_UNIT_LABEL: Record<MaterialUnit, string> = {
  METRO: 'metros',
  METRO_QUADRADO: 'm²',
  PLACA: 'placas',
  PECA: 'peças',
  UNIDADE: 'unidades',
  EMBALAGEM: 'embalagens',
};

/** Código de medição antiga (histórico). */
export const measurementCode = (n: number): string => formatNumber('MD', n);
/** Código de pedido de compra antigo (histórico de custos da OS). */
export const purchaseOrderCode = (n: number): string => formatNumber('CP', n);

/** Arredonda para 3 casas (precisão de NUMERIC(12,3)) evitando ruído de ponto flutuante. */
export const q3 = (n: number) => Math.round(n * 1000) / 1000;

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
