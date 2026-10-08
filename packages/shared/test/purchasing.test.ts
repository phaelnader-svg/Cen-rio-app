import { describe, expect, it } from 'vitest';
import {
  computeReadiness,
  lineStage,
  lineTotalCents,
  materialReceiptLineSchema,
  purchaseOrderItemSchema,
  specKey,
  specMismatch,
} from '../src';

const line = (need: number, covered: number, purchased = 0, divergence = false) => ({
  need,
  covered,
  purchased,
  divergence,
});

describe('Prontidão de materiais', () => {
  it('estados a partir dos registros', () => {
    expect(computeReadiness([], false)).toBe('SEM_LEVANTAMENTO');
    expect(computeReadiness([], true)).toBe('AGUARDANDO_APROVACAO');
    expect(computeReadiness([line(12, 0)], false)).toBe('AGUARDANDO_COMPRA');
    expect(computeReadiness([line(12, 0, 12)], false)).toBe('AGUARDANDO_RECEBIMENTO');
    expect(computeReadiness([line(12, 0, 12), line(2, 0)], false)).toBe('AGUARDANDO_COMPRA');
    expect(computeReadiness([line(12, 5, 12)], false)).toBe('PARCIALMENTE_DISPONIVEL');
    expect(computeReadiness([line(12, 12, 12), line(2, 2)], false)).toBe('COMPLETO');
    expect(computeReadiness([line(12, 5, 12, true)], false)).toBe('COM_DIVERGENCIA');
    // Divergência resolvida (tudo coberto) não bloqueia.
    expect(computeReadiness([line(12, 12, 12, true)], false)).toBe('COMPLETO');
    // Ainda há solicitação a aprovar: não está completo.
    expect(computeReadiness([line(12, 12, 12)], true)).toBe('AGUARDANDO_APROVACAO');
  });

  it('etapa de cada material', () => {
    const base = { need: 10, purchased: 0, received: 0, reserved: 0, covered: 0, exclusive: true };
    expect(lineStage(base)).toBe('APROVADO');
    expect(lineStage({ ...base, purchased: 10 })).toBe('COMPRADO');
    expect(lineStage({ ...base, purchased: 10, received: 4, covered: 4 })).toBe(
      'PARCIALMENTE_RECEBIDO',
    );
    expect(lineStage({ ...base, purchased: 10, received: 10, covered: 10 })).toBe('DISPONIVEL');
    expect(lineStage({ ...base, exclusive: false, purchased: 10, received: 10 })).toBe(
      'RECEBIDO_CONFERIDO',
    );
    expect(lineStage({ ...base, exclusive: false, received: 10, reserved: 6, covered: 6 })).toBe(
      'RESERVADO',
    );
  });
});

describe('Especificação e valores', () => {
  const linho = {
    kind: 'TECIDO' as const,
    description: 'Linho',
    color: 'Bege',
    reference: 'L-10',
    unit: 'METRO' as const,
  };
  it('tecidos só combinam com mesma referência e cor; unidades nunca se somam', () => {
    expect(specMismatch(linho, { ...linho, description: ' linho ', color: 'BEGE' })).toBeNull();
    expect(specMismatch(linho, { ...linho, color: 'Azul' })).toMatch(/referência, cor/);
    expect(specMismatch(linho, { ...linho, reference: 'L-11' })).toMatch(/referência, cor/);
    expect(specMismatch(linho, { ...linho, unit: 'METRO_QUADRADO' })).toMatch(/Unidades/);
    expect(specKey(linho)).toBe(specKey({ ...linho, description: 'LINHO' }));
  });

  it('total em centavos arredondado', () => {
    expect(lineTotalCents(12.5, 4590)).toBe(57375);
    expect(lineTotalCents(0.333, 100)).toBe(33);
    expect(lineTotalCents(2, null)).toBeNull();
  });

  it('item de compra exclusivo exige uma única OS; recebimento exige conferência e motivo', () => {
    const alloc = (id: string) => ({ materialRequirementId: id, quantity: 1 });
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    expect(
      purchaseOrderItemSchema.safeParse({
        sourcing: 'EXCLUSIVO_OS',
        allocations: [alloc(id1), alloc(id2)],
        quantity: 2,
      }).success,
    ).toBe(false);
    expect(
      purchaseOrderItemSchema.safeParse({
        sourcing: 'ESTOQUE',
        allocations: [alloc(id1), alloc(id2)],
        quantity: 1,
      }).success,
    ).toBe(false);
    expect(
      materialReceiptLineSchema.safeParse({
        purchaseOrderItemId: id1,
        acceptedQuantity: 1,
        specConfirmed: false,
      }).success,
    ).toBe(false);
    expect(
      materialReceiptLineSchema.safeParse({
        purchaseOrderItemId: id1,
        acceptedQuantity: 0,
        rejectedQuantity: 2,
        specConfirmed: false,
        issue: 'DANIFICADO',
      }).success,
    ).toBe(false);
    expect(
      materialReceiptLineSchema.safeParse({
        purchaseOrderItemId: id1,
        acceptedQuantity: 0,
        rejectedQuantity: 2,
        specConfirmed: false,
        issue: 'DANIFICADO',
        issueNote: 'Molhado',
      }).success,
    ).toBe(true);
  });
});
