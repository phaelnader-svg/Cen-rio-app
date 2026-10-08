/**
 * Fase 3 — medições e solicitações de materiais: enumerações, rótulos,
 * regras de unidade e consolidação da lista de materiais (funções puras,
 * usadas pela API e testadas isoladamente).
 */
import type { MaterialKind, MaterialSourcing } from './domain';
import { formatNumber } from './domain';

export const MEASUREMENT_STATUSES = ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA'] as const;
export type MeasurementStatus = (typeof MEASUREMENT_STATUSES)[number];
export const MEASUREMENT_STATUS_LABEL: Record<MeasurementStatus, string> = {
  PENDENTE: 'Atribuída',
  EM_ANDAMENTO: 'Em andamento',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};

export const MATERIAL_REQUEST_STATUSES = [
  'RASCUNHO',
  'ENVIADA',
  'EM_REVISAO',
  'APROVADA',
  'DEVOLVIDA',
  'CANCELADA',
] as const;
export type MaterialRequestStatus = (typeof MATERIAL_REQUEST_STATUSES)[number];
export const MATERIAL_REQUEST_STATUS_LABEL: Record<MaterialRequestStatus, string> = {
  RASCUNHO: 'Rascunho',
  ENVIADA: 'Enviada',
  EM_REVISAO: 'Em revisão',
  APROVADA: 'Aprovada para compra',
  DEVOLVIDA: 'Devolvida para correção',
  CANCELADA: 'Cancelada',
};

/** Quem executa pode editar a solicitação somente nestes estados. */
export const REQUEST_EDITABLE_BY_EXECUTOR: readonly MaterialRequestStatus[] = [
  'RASCUNHO',
  'DEVOLVIDA',
];
/** Aguardando o gestor. */
export const REQUEST_AWAITING_REVIEW: readonly MaterialRequestStatus[] = ['ENVIADA', 'EM_REVISAO'];

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
export const MATERIAL_UNIT_SHORT: Record<MaterialUnit, string> = {
  METRO: 'm',
  METRO_QUADRADO: 'm²',
  PLACA: 'pl',
  PECA: 'pç',
  UNIDADE: 'un',
  EMBALAGEM: 'emb',
};

/** Unidades aceitas por tipo de material. */
export const UNITS_BY_KIND: Record<MaterialKind, readonly MaterialUnit[]> = {
  TECIDO: ['METRO'],
  ESPUMA: ['PLACA', 'PECA', 'METRO_QUADRADO'],
  OUTRO: ['METRO', 'METRO_QUADRADO', 'PLACA', 'PECA', 'UNIDADE', 'EMBALAGEM'],
};

/** Unidades contáveis exigem quantidade inteira; metros e m² aceitam decimais. */
export const DECIMAL_UNITS: readonly MaterialUnit[] = ['METRO', 'METRO_QUADRADO'];

export function unitError(kind: MaterialKind, unit: MaterialUnit, quantity: number): string | null {
  if (!UNITS_BY_KIND[kind].includes(unit)) {
    return `Unidade "${MATERIAL_UNIT_LABEL[unit]}" não é compatível com ${
      kind === 'TECIDO'
        ? 'tecido (use metros)'
        : kind === 'ESPUMA'
          ? 'espuma (use placas, peças ou m²)'
          : 'este material'
    }.`;
  }
  if (!(quantity > 0)) return 'A quantidade deve ser maior que zero.';
  if (!DECIMAL_UNITS.includes(unit) && !Number.isInteger(quantity)) {
    return `Em ${MATERIAL_UNIT_LABEL[unit]} a quantidade deve ser um número inteiro.`;
  }
  if (Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-6) {
    return 'Use no máximo 3 casas decimais.';
  }
  return null;
}

export function measurementCode(n: number): string {
  return formatNumber('MD', n);
}

export function formatQuantity(q: number): string {
  return q.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Próxima data do dia da semana (0=dom) a partir de `fromIso` (inclusive). */
export function nextWeekday(fromIso: string, weekday: number): string {
  const d = new Date(`${fromIso}T00:00:00Z`);
  const delta = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────── Consolidação ───────────────────────────

export interface ConsolidationInput {
  kind: MaterialKind;
  sourcing: MaterialSourcing;
  description: string;
  color: string | null;
  reference: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  unit: MaterialUnit;
  quantity: number;
  serviceOrder: { id: string; code: string };
  itemCode: string | null;
  measurementCode: string | null;
}

export interface ConsolidatedLine {
  key: string;
  kind: MaterialKind;
  sourcing: MaterialSourcing;
  description: string;
  color: string | null;
  reference: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  unit: MaterialUnit;
  totalQuantity: number;
  /** Somente para linhas exclusivas de uma OS. */
  serviceOrder: { id: string; code: string } | null;
  origins: {
    serviceOrderCode: string;
    itemCode: string | null;
    measurementCode: string | null;
    quantity: number;
  }[];
}

const norm = (v: string | null | undefined) =>
  (v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Agrupa necessidades aprovadas:
 * - compra exclusiva da OS (sempre o caso do tecido): agrupa SOMENTE dentro da
 *   mesma OS — nomes iguais em OS diferentes continuam linhas separadas;
 * - materiais comuns de estoque: agrupa por especificação + unidade entre OS,
 *   preservando a origem de cada quantidade.
 */
export function consolidateMaterials(inputs: ConsolidationInput[]): ConsolidatedLine[] {
  const map = new Map<string, ConsolidatedLine>();
  for (const i of inputs) {
    const spec = [
      i.kind,
      i.sourcing,
      norm(i.description),
      norm(i.color),
      norm(i.reference),
      norm(i.foamDensity),
      i.thicknessCm ?? '',
      i.lengthCm ?? '',
      i.widthCm ?? '',
      i.unit,
    ].join('|');
    const perOs = i.sourcing === 'EXCLUSIVO_OS';
    const key = perOs ? `${i.serviceOrder.id}|${spec}` : spec;
    let line = map.get(key);
    if (!line) {
      line = {
        key,
        kind: i.kind,
        sourcing: i.sourcing,
        description: i.description,
        color: i.color,
        reference: i.reference,
        foamDensity: i.foamDensity,
        thicknessCm: i.thicknessCm,
        lengthCm: i.lengthCm,
        widthCm: i.widthCm,
        unit: i.unit,
        totalQuantity: 0,
        serviceOrder: perOs ? i.serviceOrder : null,
        origins: [],
      };
      map.set(key, line);
    }
    line.totalQuantity = Math.round((line.totalQuantity + i.quantity) * 1000) / 1000;
    line.origins.push({
      serviceOrderCode: i.serviceOrder.code,
      itemCode: i.itemCode,
      measurementCode: i.measurementCode,
      quantity: i.quantity,
    });
  }
  const order: Record<MaterialKind, number> = { TECIDO: 0, ESPUMA: 1, OUTRO: 2 };
  return [...map.values()].sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.serviceOrder?.code ?? '').localeCompare(b.serviceOrder?.code ?? '') ||
      a.description.localeCompare(b.description, 'pt-BR'),
  );
}

/** Descrição legível de uma linha (ex.: "Espuma D28 3 cm (200×60 cm)"). */
export function describeMaterial(l: {
  kind: MaterialKind;
  description: string;
  color: string | null;
  reference: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
  lengthCm: number | null;
  widthCm: number | null;
}): string {
  const parts = [l.description];
  if (l.kind === 'ESPUMA') {
    if (l.foamDensity) parts.push(l.foamDensity);
    if (l.thicknessCm) parts.push(`${formatQuantity(l.thicknessCm)} cm`);
    if (l.lengthCm && l.widthCm)
      parts.push(`(${formatQuantity(l.lengthCm)}×${formatQuantity(l.widthCm)} cm)`);
  }
  if (l.color) parts.push(l.color);
  if (l.reference) parts.push(`ref. ${l.reference}`);
  return parts.join(' ');
}

/** CSV com separador ";" e vírgula decimal (abre corretamente no Excel em pt-BR). */
export function consolidatedToCsv(lines: ConsolidatedLine[]): string {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [['Tipo', 'Material', 'Quantidade', 'Unidade', 'Destino', 'Origens'].join(';')];
  for (const l of lines) {
    rows.push(
      [
        l.kind === 'TECIDO' ? 'Tecido' : l.kind === 'ESPUMA' ? 'Espuma' : 'Outro',
        describeMaterial(l),
        formatQuantity(l.totalQuantity).replace(/\./g, ''),
        MATERIAL_UNIT_LABEL[l.unit],
        l.serviceOrder ? l.serviceOrder.code : 'Estoque (várias OS)',
        l.origins
          .map(
            (o) =>
              `${o.itemCode ?? o.serviceOrderCode}: ${formatQuantity(o.quantity).replace(/\./g, '')}`,
          )
          .join(' | '),
      ]
        .map((c) => esc(String(c)))
        .join(';'),
    );
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}
