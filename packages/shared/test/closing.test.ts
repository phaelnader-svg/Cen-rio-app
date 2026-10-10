import { describe, expect, it } from 'vitest';
import {
  allocateClosingPayment,
  closingFigures,
  closingWeekEnd,
  closingWeekStart,
  isMonday,
} from '../src';

const W = '2026-10-05';
const E = closingWeekEnd(W);

describe('Evolução Fase 7 — regras do fechamento semanal', () => {
  it('semana segunda→domingo', () => {
    expect(closingWeekStart('2026-10-11')).toBe('2026-10-05');
    expect(closingWeekStart('2026-10-05')).toBe('2026-10-05');
    expect(E).toBe('2026-10-11');
    expect(isMonday('2026-10-05')).toBe(true);
    expect(isMonday('2026-10-06')).toBe(false);
  });

  it('competência: devido na semana × saldo anterior × fora; pagamentos por data efetiva', () => {
    const week = closingFigures(
      {
        dueCents: 140000,
        competence: '2026-10-07',
        payments: [{ amountCents: 60000, paidAt: '2026-10-09', reversed: false }],
      },
      W,
      E,
    );
    expect(week).toMatchObject({
      bucket: 'WEEK',
      dueCents: 140000,
      paidInWeekCents: 60000,
      openAtEndCents: 80000,
      currentOpenCents: 80000,
    });
    // Liberado antes, pago em parte antes: saldo anterior identificado pelo valor em aberto.
    const prev = closingFigures(
      {
        dueCents: 10000,
        competence: '2026-09-30',
        payments: [{ amountCents: 4000, paidAt: '2026-10-01', reversed: false }],
      },
      W,
      E,
    );
    expect(prev).toMatchObject({
      bucket: 'PREVIOUS',
      dueCents: 6000,
      paidInWeekCents: 0,
      openAtEndCents: 6000,
    });
    // Pago antes da semana: não volta.
    expect(
      closingFigures(
        {
          dueCents: 10000,
          competence: '2026-09-30',
          payments: [{ amountCents: 10000, paidAt: '2026-10-02', reversed: false }],
        },
        W,
        E,
      ).bucket,
    ).toBeNull();
    // Pagamento posterior não some da semana nem conta duas vezes.
    const late = closingFigures(
      {
        dueCents: 10000,
        competence: '2026-10-06',
        payments: [{ amountCents: 10000, paidAt: '2026-10-14', reversed: false }],
      },
      W,
      E,
    );
    expect(late).toMatchObject({
      bucket: 'WEEK',
      dueCents: 10000,
      paidInWeekCents: 0,
      openAtEndCents: 10000,
      paidAfterCents: 10000,
      currentOpenCents: 0,
    });
    const next = closingFigures(
      {
        dueCents: 10000,
        competence: '2026-10-06',
        payments: [{ amountCents: 10000, paidAt: '2026-10-14', reversed: false }],
      },
      '2026-10-12',
      '2026-10-18',
    );
    expect(next).toMatchObject({
      bucket: 'PREVIOUS',
      dueCents: 10000,
      paidInWeekCents: 10000,
      openAtEndCents: 0,
    });
    // Estorno não conta em período algum.
    expect(
      closingFigures(
        {
          dueCents: 10000,
          competence: '2026-10-06',
          payments: [{ amountCents: 10000, paidAt: '2026-10-07', reversed: true }],
        },
        W,
        E,
      ),
    ).toMatchObject({ paidInWeekCents: 0, openAtEndCents: 10000 });
    // Liberado depois da semana: fora.
    expect(
      closingFigures({ dueCents: 1, competence: '2026-10-12', payments: [] }, W, E).bucket,
    ).toBeNull();
  });

  it('Pix de R$ 600 sobre 14 viagens de R$ 100: mais antigas primeiro, nunca passa do saldo', () => {
    const trips = Array.from({ length: 14 }, (_, i) => ({
      id: `t${i}`,
      openCents: 10000,
      order: `2026-10-0${5 + (i % 3)}|LG-${String(i).padStart(5, '0')}`,
    }));
    const r = allocateClosingPayment(60000, trips);
    expect(r.leftoverCents).toBe(0);
    expect(r.parts.reduce((a, p) => a + p.amountCents, 0)).toBe(60000);
    expect(r.parts.every((p) => p.amountCents <= 10000)).toBe(true);
    expect(r.parts.map((p) => p.item.order)).toEqual([...r.parts.map((p) => p.item.order)].sort());
    const partial = allocateClosingPayment(25050, trips);
    expect(partial.parts.map((p) => p.amountCents)).toEqual([10000, 10000, 5050]);
    expect(allocateClosingPayment(150000, trips).leftoverCents).toBe(10000);
  });
});
