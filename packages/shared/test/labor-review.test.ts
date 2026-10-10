import { describe, expect, it } from 'vitest';
import { laborSituation, reviewResolutionProblem } from '../src';

describe('Evolução Fase 5 — situação da mão de obra', () => {
  const base = {
    status: 'PREVISTO' as const,
    inReview: false,
    eligibility: 'QUALIDADE_APROVADA' as const,
    stages: ['EM_PRODUCAO'],
  };
  it('distingue previsto, aguardando qualidade, liberado, parcial, pago, revisão e cancelado', () => {
    expect(laborSituation(base)).toBe('PREVISTO');
    expect(laborSituation({ ...base, stages: ['AGUARDANDO_INSPECAO'] })).toBe(
      'AGUARDANDO_QUALIDADE',
    );
    expect(laborSituation({ ...base, stages: ['EM_CORRECAO'] })).toBe('AGUARDANDO_QUALIDADE');
    expect(laborSituation({ ...base, status: 'LIBERADO' })).toBe('LIBERADO');
    expect(laborSituation({ ...base, status: 'PAGO_PARCIAL' })).toBe('PAGO_PARCIAL');
    expect(laborSituation({ ...base, status: 'PAGO' })).toBe('PAGO');
    expect(laborSituation({ ...base, status: 'LIBERADO', inReview: true })).toBe('EM_REVISAO');
    expect(laborSituation({ ...base, status: 'PAGO', inReview: true })).toBe('PAGO');
    expect(laborSituation({ ...base, status: 'CANCELADO', inReview: true })).toBe('CANCELADO');
    // Regra "produção concluída": aguardando inspeção não é "aguardando qualidade".
    expect(
      laborSituation({
        ...base,
        eligibility: 'PRODUCAO_CONCLUIDA',
        stages: ['AGUARDANDO_INSPECAO'],
      }),
    ).toBe('PREVISTO');
  });
});

describe('Evolução Fase 5 — resolução da revisão financeira', () => {
  const existing = [{ professionalUserId: 'r', dueCents: 100000, paidCents: 30000 }];
  it('aceita divisão explícita, sem rateio automático', () => {
    expect(
      reviewResolutionProblem(
        [
          { professionalUserId: 'r', amountCents: 40000 },
          { professionalUserId: 'm', amountCents: 60000 },
        ],
        existing,
      ),
    ).toBeNull();
  });
  it('recusa abaixo do já pago, omissão, duplicidade, negativos e novo com zero', () => {
    expect(
      reviewResolutionProblem([{ professionalUserId: 'r', amountCents: 20000 }], existing),
    ).toMatch(/já pago/);
    expect(
      reviewResolutionProblem([{ professionalUserId: 'm', amountCents: 60000 }], existing),
    ).toMatch(/Inclua todos/);
    expect(
      reviewResolutionProblem(
        [
          { professionalUserId: 'r', amountCents: 40000 },
          { professionalUserId: 'r', amountCents: 1 },
        ],
        existing,
      ),
    ).toMatch(/única vez/);
    expect(
      reviewResolutionProblem([{ professionalUserId: 'r', amountCents: -1 }], existing),
    ).toMatch(/negativos/);
    expect(
      reviewResolutionProblem(
        [
          { professionalUserId: 'r', amountCents: 40000 },
          { professionalUserId: 'm', amountCents: 0 },
        ],
        existing,
      ),
    ).toMatch(/Novo profissional/);
    expect(reviewResolutionProblem([], existing)).toMatch(/Informe/);
  });
});
