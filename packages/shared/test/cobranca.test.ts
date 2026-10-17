import { describe, expect, it } from 'vitest';
import {
  effectiveDueDate,
  itemValuesProblem,
  orderFinancialStatus,
  paymentPlan,
  paymentPlanProblem,
  receivableOverdue,
  unitValues,
} from '../src';

describe('Cobrança — regras puras', () => {
  it('modelos geram as cobranças (50/50, Pix, cartão N× = uma cobrança, retirada, manual)', () => {
    expect(paymentPlan(400000, { model: 'ENTRADA_ENTREGA' }, '2026-10-17')).toEqual([
      expect.objectContaining({ amountCents: 200000, dueTrigger: 'DATA', dueDate: '2026-10-17' }),
      expect.objectContaining({ amountCents: 200000, dueTrigger: 'ENTREGA', dueDate: null }),
    ]);
    // Arredondamento a favor da entrada; soma exata.
    const odd = paymentPlan(100001, { model: 'ENTRADA_ENTREGA' }, '2026-10-17');
    expect(odd.map((d) => d.amountCents)).toEqual([50001, 50000]);
    expect(paymentPlan(400000, { model: 'CARTAO_100', installments: 5 }, 'x')).toEqual([
      expect.objectContaining({
        expectedMethod: 'CARTAO_CREDITO',
        installments: 5,
        amountCents: 400000,
      }),
    ]);
    expect(
      paymentPlan(400000, { model: 'CARTAO_RETIRADA', installments: 10 }, 'x')[0],
    ).toMatchObject({
      dueTrigger: 'RETIRADA',
      installments: 10,
    });
    expect(paymentPlan(400000, { model: 'MANUAL' }, 'x')).toEqual([]);
    expect(paymentPlanProblem(null, { model: 'PIX_100' }, { customerDropOff: false })).toMatch(
      /valor/,
    );
    expect(
      paymentPlanProblem(1000, { model: 'CARTAO_RETIRADA' }, { customerDropOff: true }),
    ).toMatch(/retirada/);
    expect(
      paymentPlanProblem(
        1000,
        { model: 'ENTRADA_ENTREGA', entryCents: 2000 },
        { customerDropOff: false },
      ),
    ).toBeTruthy();
  });

  it('valores por peça: todos ou nenhum, soma exata; unidades estáveis', () => {
    expect(itemValuesProblem([null, null], 400000)).toBeNull();
    expect(itemValuesProblem([300000, null], 400000)).toMatch(/todas/);
    expect(itemValuesProblem([300000, 90000], 400000)).toMatch(/soma/);
    expect(itemValuesProblem([300000, 100000], 400000)).toBeNull();
    expect(unitValues(100000, 3)).toEqual([33334, 33333, 33333]);
    expect(unitValues(100000, 3).reduce((a, b) => a + b, 0)).toBe(100000);
  });

  it('vencimento derivado: data vence no dia seguinte; evento vence na conclusão; nada sem evento', () => {
    expect(effectiveDueDate({ dueTrigger: 'ENTREGA', dueDate: null, eventDate: null })).toBeNull();
    const base = { openCents: 100, cancelled: false, today: '2026-10-17' };
    expect(
      receivableOverdue({ ...base, dueTrigger: 'DATA', effectiveDue: '2026-10-17' }).overdue,
    ).toBe(false);
    expect(receivableOverdue({ ...base, dueTrigger: 'DATA', effectiveDue: '2026-10-10' })).toEqual({
      overdue: true,
      daysOverdue: 7,
    });
    expect(
      receivableOverdue({ ...base, dueTrigger: 'ENTREGA', effectiveDue: '2026-10-17' }).overdue,
    ).toBe(true);
    expect(receivableOverdue({ ...base, dueTrigger: 'ENTREGA', effectiveDue: null }).overdue).toBe(
      false,
    );
    expect(
      receivableOverdue({ ...base, openCents: 0, dueTrigger: 'DATA', effectiveDue: '2026-01-01' })
        .overdue,
    ).toBe(false);
    expect(
      orderFinancialStatus({
        finalCents: 400000,
        billedCents: 400000,
        receivedCents: 200000,
        overdueCents: 1,
      }),
    ).toBe('VENCIDO');
    expect(
      orderFinancialStatus({
        finalCents: 400000,
        billedCents: 400000,
        receivedCents: 400000,
        overdueCents: 0,
      }),
    ).toBe('QUITADO');
  });
});
