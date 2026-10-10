import { describe, expect, it } from 'vitest';
import {
  logisticsWeeklyQuerySchema,
  tripAdjustmentSchema,
  tripAllocation,
  tripCentsSchema,
  tripCostSchema,
  tripCostSituation,
} from '../src';

const so = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  number: n,
});

describe('Evolução Fase 6 — custos de logística (domínio)', () => {
  it('rateio exato: R$ 100 em 3 OS = 33,34 + 33,33 + 33,33, primeiras OS recebem o resto', () => {
    const r = tripAllocation(10000, [so(9), so(3), so(5)]);
    expect(r.map((x) => [x.serviceOrderId.slice(-1), x.amountCents])).toEqual([
      ['3', 3334],
      ['5', 3333],
      ['9', 3333],
    ]);
    for (const total of [1, 2, 99, 10000, 10001, 9_999_999])
      for (const n of [1, 2, 3, 7])
        expect(
          tripAllocation(
            total,
            Array.from({ length: n }, (_, i) => so(i + 1)),
          ).reduce((a, x) => a + x.amountCents, 0),
        ).toBe(total);
    expect(tripAllocation(10000, [])).toEqual([]);
  });

  it('valor da viagem: centavos inteiros, > 0, sem NaN/fração/estouro', () => {
    for (const bad of [0, -1, 10.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001, '100'])
      expect(tripCentsSchema.safeParse(bad).success, String(bad)).toBe(false);
    expect(tripCentsSchema.safeParse(10000).success).toBe(true);
    const id = so(1).id;
    expect(tripCostSchema.safeParse({ amountCents: 100 }).success).toBe(false);
    expect(
      tripCostSchema.safeParse({ pickupId: id, deliveryId: id, amountCents: 100 }).success,
    ).toBe(false);
    expect(
      tripCostSchema.safeParse({ pickupId: id, amountCents: 100, participantUserIds: [id, id] })
        .success,
    ).toBe(false);
    expect(
      tripAdjustmentSchema.safeParse({ amountCents: 0, reason: 'xxx', version: 1 }).success,
    ).toBe(false);
    expect(
      logisticsWeeklyQuerySchema.safeParse({ from: '2026-10-10', to: '2026-10-01' }).success,
    ).toBe(false);
  });

  it('situação derivada: combinado não é devido; pago parcial; pendente sem recebedor', () => {
    expect(tripCostSituation({ status: 'PREVISTO', payable: null })).toBe('COMBINADO');
    expect(tripCostSituation({ status: 'DEVIDO', payable: null })).toBe('PENDENTE_RECEBEDOR');
    expect(
      tripCostSituation({ status: 'DEVIDO', payable: { status: 'ABERTO', paidCents: 0 } }),
    ).toBe('DEVIDO');
    expect(
      tripCostSituation({ status: 'DEVIDO', payable: { status: 'PARCIAL', paidCents: 10 } }),
    ).toBe('PAGO_PARCIAL');
    expect(
      tripCostSituation({ status: 'DEVIDO', payable: { status: 'PAGO', paidCents: 10 } }),
    ).toBe('PAGO');
    expect(tripCostSituation({ status: 'CANCELADO', payable: null })).toBe('CANCELADO');
  });
});
