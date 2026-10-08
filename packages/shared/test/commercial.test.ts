import { describe, expect, it } from 'vitest';
import {
  PICKUP_TRANSITIONS,
  createReceiptSchema,
  createServiceOrderSchema,
  formatDocument,
  formatMoney,
  isValidCnpj,
  isValidCpf,
  materialRequirementSchema,
  normalizeSearch,
  parseMoneyToCents,
} from '../src';

describe('Documentos e valores', () => {
  it('valida CPF e CNPJ pelos dígitos verificadores', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
    expect(formatDocument('52998224725')).toBe('529.982.247-25');
  });
  it('converte valores em reais', () => {
    expect(parseMoneyToCents('3.500,00')).toBe(350000);
    expect(parseMoneyToCents('R$ 1234,5')).toBe(123450);
    expect(parseMoneyToCents('12,345')).toBeNull();
    expect(formatMoney(350000)).toMatch(/3\.500,00/);
  });
  it('normaliza texto para pesquisa', () => {
    expect(normalizeSearch('  João   CONCEIÇÃO ')).toBe('joao conceicao');
  });
});

describe('Regras do fluxo', () => {
  it('"Recebida na oficina" nunca é transição manual', () => {
    for (const targets of Object.values(PICKUP_TRANSITIONS)) {
      expect(targets).not.toContain('RECEBIDA_NA_OFICINA');
    }
    expect(PICKUP_TRANSITIONS.CANCELADA).toEqual([]);
  });
  it('tecido é sempre comprado para a OS', () => {
    const base = { kind: 'TECIDO', description: 'Linho', sourcing: 'ESTOQUE' };
    expect(materialRequirementSchema.safeParse(base).success).toBe(false);
    expect(materialRequirementSchema.safeParse({ ...base, sourcing: 'EXCLUSIVO_OS' }).success).toBe(
      true,
    );
    expect(
      materialRequirementSchema.safeParse({
        kind: 'OUTRO',
        description: 'Grampos',
        sourcing: 'ESTOQUE',
      }).success,
    ).toBe(true);
  });
  it('recebimento exige localização e OS exige peças', () => {
    const id = '5f1e1f7e-1c1a-4a8e-9a3e-1d2f3a4b5c6d';
    expect(
      createReceiptSchema.safeParse({
        orderId: id,
        origin: 'ENTREGUE_PELO_CLIENTE',
        lines: [{ orderItemId: id, quantity: 1, condition: 'BOA', location: '' }],
      }).success,
    ).toBe(false);
    expect(createServiceOrderSchema.safeParse({ orderId: id, items: [] }).success).toBe(false);
  });
});
