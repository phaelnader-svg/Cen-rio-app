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
