import { describe, expect, it } from 'vitest';
import {
  commercialAdjustmentSchema,
  contributionMargin,
  laborEligible,
  laborStatus,
  logisticsCostSchema,
  managementResult,
  orderFinancialStatus,
  recurringDueDate,
  settlementProblem,
  settlementStatus,
  signedAdjustment,
  splitCents,
  taskTimings,
  toCsv,
  weightedAverageCents,
} from '../src';

describe('Fase 11 — regras financeiras puras', () => {
  it('ajustes comerciais: desconto sempre reduz, acréscimo sempre soma', () => {
    expect(signedAdjustment('DESCONTO', 2000)).toBe(-2000);
    expect(signedAdjustment('DESCONTO', -2000)).toBe(-2000);
    expect(signedAdjustment('ACRESCIMO', -500)).toBe(500);
    expect(signedAdjustment('AJUSTE', -300)).toBe(-300);
    expect(
      commercialAdjustmentSchema.safeParse({ kind: 'DESCONTO', amountCents: 0, reason: 'xxx' })
        .success,
    ).toBe(false);
  });

  it('quitação: parcial, total e nunca acima do saldo', () => {
    expect(settlementStatus(1000, 0)).toBe('ABERTO');
    expect(settlementStatus(1000, 400)).toBe('PARCIAL');
    expect(settlementStatus(1000, 1000)).toBe('QUITADO');
    expect(settlementProblem(1000, 400, 600)).toBeNull();
    expect(settlementProblem(1000, 400, 601)).toMatch(/saldo/);
    expect(settlementProblem(1000, 0, 0)).toMatch(/maior que zero/);
  });

  it('situação financeira do pedido', () => {
    expect(orderFinancialStatus({ finalCents: null, billedCents: 0, receivedCents: 0 })).toBe(
      'SEM_VALOR',
    );
    expect(orderFinancialStatus({ finalCents: 1000, billedCents: 0, receivedCents: 0 })).toBe(
      'SEM_COBRANCA',
    );
    expect(orderFinancialStatus({ finalCents: 1000, billedCents: 500, receivedCents: 0 })).toBe(
      'A_RECEBER',
    );
    expect(orderFinancialStatus({ finalCents: 1000, billedCents: 500, receivedCents: 500 })).toBe(
      'PARCIAL',
    );
    expect(orderFinancialStatus({ finalCents: 1000, billedCents: 1000, receivedCents: 1000 })).toBe(
      'QUITADO',
    );
  });

  it('rateio em centavos: soma exata, proporcional, sem dividir por zero', () => {
    expect(splitCents(10001, [1, 1])).toEqual([5001, 5000]);
    expect(splitCents(1000, [1, 2])).toEqual([333, 667]);
    expect(splitCents(100, [0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(100);
    for (const total of [1, 7, 99, 12345])
      expect(splitCents(total, [3, 5, 7]).reduce((a, b) => a + b, 0)).toBe(total);
    const bad = logisticsCostSchema.safeParse({
      kind: 'ENTREGA',
      description: 'Entrega',
      amountCents: 100,
      date: '2026-10-01',
      splitMethod: 'MANUAL',
      allocations: [
        { serviceOrderId: '11111111-1111-4111-8111-111111111111', amountCents: 40 },
        { serviceOrderId: '22222222-2222-4222-8222-222222222222', amountCents: 40 },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('elegibilidade da mão de obra: nunca pela tarefa sozinha', () => {
    expect(laborEligible('QUALIDADE_APROVADA', ['AGUARDANDO_INSPECAO'])).toBe(false);
    expect(laborEligible('PRODUCAO_CONCLUIDA', ['AGUARDANDO_INSPECAO'])).toBe(true);
    expect(laborEligible('QUALIDADE_APROVADA', ['AGUARDANDO_EMBALAGEM', 'EM_PRODUCAO'])).toBe(
      false,
    );
    expect(laborEligible('ENTREGA_CONCLUIDA', ['ENTREGUE'])).toBe(true);
    expect(laborEligible('PRODUCAO_CONCLUIDA', [])).toBe(false);
    const base = { agreedCents: 1000, adjustmentsCents: 0, cancelled: false };
    expect(laborStatus({ ...base, paidCents: 0, eligible: false })).toBe('PREVISTO');
    expect(laborStatus({ ...base, paidCents: 0, eligible: true })).toBe('LIBERADO');
    expect(laborStatus({ ...base, paidCents: 500, eligible: true })).toBe('PAGO_PARCIAL');
    expect(laborStatus({ ...base, paidCents: 1000, eligible: true })).toBe('PAGO');
  });

  it('margem de contribuição e resultado gerencial', () => {
    const m = contributionMargin({
      revenueCents: 350000,
      materialsCents: 54000,
      laborCents: 80000,
      logisticsCents: 12000,
      otherVariableCents: 0,
      taxRateBps: 600,
    });
    expect(m).toMatchObject({ taxCents: 21000, variableCostsCents: 167000, marginCents: 183000 });
    expect(m.marginPct).toBeCloseTo(52.3, 1);
    expect(
      contributionMargin({
        revenueCents: 0,
        materialsCents: 0,
        laborCents: 0,
        logisticsCents: 0,
        otherVariableCents: 0,
        taxRateBps: null,
      }).marginPct,
    ).toBeNull();
    expect(
      managementResult({
        contributionMarginCents: 183000,
        operationalExpensesCents: 40000,
        fixedTeamCents: 300000,
      }),
    ).toBe(-157000);
  });

  it('custo médio ponderado, vencimento recorrente e tempos de tarefa', () => {
    expect(
      weightedAverageCents([
        { quantity: 6, unitCents: 1890 },
        { quantity: 4, unitCents: 2000 },
      ]),
    ).toBe(1934);
    expect(weightedAverageCents([])).toBeNull();
    expect(recurringDueDate('2026-02', 31)).toBe('2026-02-28');
    expect(recurringDueDate('2028-02', 30)).toBe('2028-02-29');
    expect(recurringDueDate('2026-03', 10)).toBe('2026-03-10');
    const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 8, min));
    expect(
      taskTimings([
        { kind: 'LIBERADA', at: t(0) },
        { kind: 'INICIADA', at: t(10) },
        { kind: 'PAUSADA', at: t(40) },
        { kind: 'RETOMADA', at: t(50) },
        { kind: 'CONCLUIDA', at: t(70) },
      ]),
    ).toEqual({ executionMinutes: 50, waitingMinutes: 10 });
  });

  it('CSV em português, com BOM e proteção contra fórmulas', () => {
    const csv = toCsv(
      ['Nome', 'Valor'],
      [
        ['=SOMA(A1)', '-12,50'],
        ['Ana; "Bia"', 3],
      ],
    );
    expect(csv.startsWith('﻿Nome;Valor\r\n')).toBe(true);
    expect(csv).toContain("'=SOMA(A1);-12,50");
    expect(csv).toContain('"Ana; ""Bia""";3');
  });
});
