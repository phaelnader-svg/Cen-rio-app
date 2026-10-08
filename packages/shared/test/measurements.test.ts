import { describe, expect, it } from 'vitest';
import {
  consolidateMaterials,
  consolidatedToCsv,
  describeMaterial,
  materialRequestItemSchema,
  nextWeekday,
  unitError,
  type ConsolidationInput,
} from '../src';

const base = (o: Partial<ConsolidationInput>): ConsolidationInput => ({
  kind: 'TECIDO',
  sourcing: 'EXCLUSIVO_OS',
  description: 'Linho',
  color: 'Bege',
  reference: null,
  foamDensity: null,
  thicknessCm: null,
  lengthCm: null,
  widthCm: null,
  unit: 'METRO',
  quantity: 1,
  serviceOrder: { id: 'a', code: 'OS-00152' },
  itemCode: 'OS-00152/1',
  measurementCode: 'MD-00001',
  ...o,
});

describe('Unidades', () => {
  it('compatibilidade por tipo e inteiros para unidades contáveis', () => {
    expect(unitError('TECIDO', 'METRO', 12.35)).toBeNull();
    expect(unitError('TECIDO', 'PLACA', 1)).toMatch(/compatível/);
    expect(unitError('ESPUMA', 'PLACA', 1.5)).toMatch(/inteiro/);
    expect(unitError('OUTRO', 'METRO_QUADRADO', 1.25)).toBeNull();
    expect(unitError('OUTRO', 'UNIDADE', 0)).toMatch(/maior que zero/);
    expect(unitError('TECIDO', 'METRO', 1.0005)).toMatch(/3 casas/);
  });
  it('schema exige densidade e espessura da espuma', () => {
    const foam = {
      kind: 'ESPUMA',
      sourcing: 'EXCLUSIVO_OS',
      description: 'Espuma',
      quantity: 2,
      unit: 'PLACA',
    };
    expect(materialRequestItemSchema.safeParse(foam).success).toBe(false);
    expect(
      materialRequestItemSchema.safeParse({ ...foam, foamDensity: 'D28', thicknessCm: 3 }).success,
    ).toBe(true);
  });
  it('próxima sexta-feira', () => {
    expect(nextWeekday('2026-10-08', 5)).toBe('2026-10-09');
    expect(nextWeekday('2026-10-09', 5)).toBe('2026-10-09');
    expect(nextWeekday('2026-10-10', 5)).toBe('2026-10-16');
  });
});

describe('Consolidação', () => {
  it('reproduz o exemplo: tecidos por OS, espumas por OS, comuns agrupados', () => {
    const lines = consolidateMaterials([
      base({ quantity: 12 }),
      base({
        description: 'Suede',
        color: 'Cinza',
        quantity: 8,
        serviceOrder: { id: 'b', code: 'OS-00153' },
        itemCode: 'OS-00153/1',
      }),
      base({
        kind: 'ESPUMA',
        description: 'Espuma',
        color: null,
        foamDensity: 'D28',
        thicknessCm: 3,
        unit: 'PLACA',
        quantity: 2,
      }),
      base({
        kind: 'ESPUMA',
        description: 'Espuma',
        color: null,
        foamDensity: 'D33',
        thicknessCm: 5,
        unit: 'PLACA',
        quantity: 1,
        serviceOrder: { id: 'b', code: 'OS-00153' },
      }),
      base({
        kind: 'OUTRO',
        sourcing: 'ESTOQUE',
        description: 'Cola de contato',
        color: null,
        unit: 'EMBALAGEM',
        quantity: 1,
      }),
      base({
        kind: 'OUTRO',
        sourcing: 'ESTOQUE',
        description: 'cola de contato',
        color: null,
        unit: 'EMBALAGEM',
        quantity: 2,
        serviceOrder: { id: 'b', code: 'OS-00153' },
      }),
    ]);
    expect(
      lines.map((l) => [
        l.kind,
        describeMaterial(l),
        l.totalQuantity,
        l.serviceOrder?.code ?? null,
      ]),
    ).toEqual([
      ['TECIDO', 'Linho Bege', 12, 'OS-00152'],
      ['TECIDO', 'Suede Cinza', 8, 'OS-00153'],
      ['ESPUMA', 'Espuma D28 3 cm', 2, 'OS-00152'],
      ['ESPUMA', 'Espuma D33 5 cm', 1, 'OS-00153'],
      ['OUTRO', 'Cola de contato', 3, null],
    ]);
    expect(lines[4]!.origins.map((o) => o.serviceOrderCode)).toEqual(['OS-00152', 'OS-00153']);
  });
  it('tecido com o mesmo nome em OS diferentes NÃO é somado; decimais preservados', () => {
    const lines = consolidateMaterials([
      base({ quantity: 1.1 }),
      base({ quantity: 2.2 }),
      base({ quantity: 5, serviceOrder: { id: 'b', code: 'OS-00153' } }),
    ]);
    expect(lines.map((l) => [l.serviceOrder?.code, l.totalQuantity])).toEqual([
      ['OS-00152', 3.3],
      ['OS-00153', 5],
    ]);
  });
  it('CSV com BOM, ";" e vírgula decimal', () => {
    const csv = consolidatedToCsv(consolidateMaterials([base({ quantity: 12.5 })]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Tecido;Linho Bege;12,5;metros;OS-00152;OS-00152/1: 12,5');
  });
});
