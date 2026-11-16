import { describe, expect, it } from 'vitest';
import {
  MATERIAL_UNITS,
  MATERIAL_UNIT_LABEL,
  formatCents,
  measurementCode,
  purchaseOrderCode,
  q3,
} from '../src';

describe('Materiais (o que ficou depois da remoção de Compras e Medições)', () => {
  it('toda unidade tem rótulo', () => {
    for (const u of MATERIAL_UNITS) expect(MATERIAL_UNIT_LABEL[u]).toBeTruthy();
  });
  it('códigos dos registros antigos continuam legíveis', () => {
    expect(measurementCode(1)).toBe('MD-00001');
    expect(purchaseOrderCode(152)).toBe('CP-00152');
  });
  it('arredondamento de quantidade e valores em reais', () => {
    expect(q3(0.1 + 0.2)).toBe(0.3);
    expect(formatCents(null)).toBe('—');
    expect(formatCents(123456).replace(/\s/g, ' ')).toBe('R$ 1.234,56');
  });
});
