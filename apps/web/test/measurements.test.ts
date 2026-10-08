import { describe, expect, it } from 'vitest';
import { decimalText, parseDecimal } from '../lib/measurements';

describe('números digitados no tablet', () => {
  it('aceita vírgula ou ponto decimal e milhar com ponto', () => {
    expect(parseDecimal('12,5')).toBe(12.5);
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal(' 1.250,75 ')).toBe(1250.75);
    expect(parseDecimal('3')).toBe(3);
  });

  it('vazio ou texto inválido vira NaN (o formulário mostra o erro)', () => {
    expect(parseDecimal('')).toBeNaN();
    expect(parseDecimal('doze')).toBeNaN();
    expect(parseDecimal('1,2,3')).toBeNaN();
  });

  it('exibe decimais com vírgula', () => {
    expect(decimalText(11.75)).toBe('11,75');
    expect(decimalText(null)).toBe('');
  });
});
