import {
  MATERIAL_KIND_LABEL,
  MATERIAL_UNIT_LABEL,
  describeMaterial,
  formatQuantity,
  type SpecDto,
} from '@cenario/shared';

/** "Tecido: Linho Bege ref. X" */
export const specText = (s: SpecDto, withKind = true) =>
  `${withKind ? `${MATERIAL_KIND_LABEL[s.kind]}: ` : ''}${describeMaterial(s)}`;

export const qtyText = (q: number, unit: SpecDto['unit']) =>
  `${formatQuantity(q)} ${MATERIAL_UNIT_LABEL[unit]}`;

interface DestinationLike {
  serviceOrder: { code: string } | null;
  preArrival: { order: { code: string }; piece: string } | null;
}

/** Destino de uma necessidade: a OS, ou "Pré-chegada" com o pedido e a peça (Etapa 3). */
export const destinationText = (d: DestinationLike) =>
  d.serviceOrder?.code ??
  (d.preArrival ? `Pré-chegada ${d.preArrival.order.code} · ${d.preArrival.piece}` : '—');
