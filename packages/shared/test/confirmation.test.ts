import { describe, expect, it } from 'vitest';
import {
  confirmationCode,
  confirmationLine,
  confirmationPayload,
  sameLine,
  valueChangeCode,
} from '../src';

/** R2 — linhas da confirmação semanal (D13). */
const item = (o: Partial<Parameters<typeof confirmationLine>[0]> = {}) => ({
  kind: 'MAO_DE_OBRA' as const,
  id: 'b-1',
  code: 'MO-00001',
  bucket: 'WEEK' as const,
  dueCents: 80000,
  totalDueCents: 80000,
  currentOpenCents: 80000,
  ...o,
});

describe('confirmação semanal (R2)', () => {
  it('pagamento parcial não muda a linha; mudar o devido muda', () => {
    const a = confirmationLine(item());
    expect(sameLine(a, confirmationLine(item({ currentOpenCents: 20000 })))).toBe(true);
    expect(sameLine(a, confirmationLine(item({ dueCents: 90000, totalDueCents: 90000 })))).toBe(
      false,
    );
    expect(sameLine(a, confirmationLine(item({ bucket: 'PREVIOUS' })))).toBe(false);
  });

  it('previsto (antecipação) vira FORECAST com o saldo atual', () => {
    expect(
      confirmationLine(item({ bucket: null, dueCents: 0, currentOpenCents: 50000 })),
    ).toMatchObject({
      bucket: 'FORECAST',
      dueCents: 50000,
    });
  });

  it('texto assinado independe da ordem das linhas e muda com pessoa ou semana', () => {
    const l1 = confirmationLine(item());
    const l2 = confirmationLine(item({ kind: 'LOGISTICA', id: 'c-1', code: 'LG-00001' }));
    const p = confirmationPayload('u-1', '2026-10-12', [l1, l2]);
    expect(confirmationPayload('u-1', '2026-10-12', [l2, l1])).toBe(p);
    expect(confirmationPayload('u-2', '2026-10-12', [l1, l2])).not.toBe(p);
    expect(confirmationPayload('u-1', '2026-10-19', [l1, l2])).not.toBe(p);
  });

  it('códigos', () => {
    expect(valueChangeCode(1)).toBe('SV-00001');
    expect(confirmationCode(12)).toBe('CS-00012');
  });
});
