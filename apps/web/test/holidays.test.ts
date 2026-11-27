import { describe, expect, it } from 'vitest';
import { easterSunday, holidayOf } from '../lib/holidays';

describe('feriados nacionais', () => {
  it('calcula a Páscoa', () => {
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });

  it('marca fixos e móveis', () => {
    expect(holidayOf('2026-11-20')?.name).toMatch(/Consciência Negra/);
    expect(holidayOf('2026-11-15')?.name).toBe('Proclamação da República');
    expect(holidayOf('2026-04-03')?.name).toBe('Sexta-feira Santa');
    expect(holidayOf('2026-02-17')?.optional).toBe(true); // Carnaval
    expect(holidayOf('2026-06-04')?.name).toMatch(/Corpus Christi/);
    expect(holidayOf('2026-11-16')).toBeNull();
  });
});
