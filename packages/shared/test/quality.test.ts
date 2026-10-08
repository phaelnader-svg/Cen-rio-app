import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_TEMPLATES,
  canDecideInspection,
  canDeliveryTransition,
  checklistFor,
  computeStage,
  decisionProblems,
  deliveryReadiness,
  parsePieceLabel,
  pieceLabelPayload,
  receiptCorrectionProblem,
  regionOf,
} from '../src';

const ready = {
  requiredTasks: 2,
  requiredTasksDone: 2,
  inspection: 'APROVADA' as const,
  openCorrections: 0,
  packaging: 'CONCLUIDA' as const,
  shippingBlock: false,
};
const flags = {
  cancelled: false,
  returned: false,
  delivered: false,
  inTransit: false,
  scheduled: false,
};

describe('Fase 10 — regras de qualidade e expedição', () => {
  it('pronto para entrega exige as cinco condições', () => {
    expect(deliveryReadiness(ready)).toEqual({ ready: true, missing: [] });
    expect(
      deliveryReadiness({
        ...ready,
        requiredTasksDone: 1,
        inspection: 'REPROVADA',
        openCorrections: 1,
        packaging: null,
        shippingBlock: true,
      }).missing,
    ).toEqual(['TAREFAS', 'INSPECAO', 'CORRECOES', 'EMBALAGEM', 'SEM_BLOQUEIO']);
    expect(deliveryReadiness({ ...ready, requiredTasks: 0, requiredTasksDone: 0 }).missing).toEqual(
      ['TAREFAS'],
    );
  });

  it('etapa derivada da peça', () => {
    expect(computeStage({ ...ready, ...flags })).toBe('PRONTA_ENTREGA');
    expect(computeStage({ ...ready, ...flags, scheduled: true })).toBe('ENTREGA_AGENDADA');
    expect(computeStage({ ...ready, ...flags, inTransit: true })).toBe('EM_TRANSPORTE');
    expect(computeStage({ ...ready, ...flags, shippingBlock: true })).toBe('BLOQUEIO_EXPEDICAO');
    expect(computeStage({ ...ready, ...flags, packaging: 'PENDENTE' })).toBe(
      'AGUARDANDO_EMBALAGEM',
    );
    expect(computeStage({ ...ready, ...flags, inspection: 'REPROVADA' })).toBe('EM_CORRECAO');
    expect(computeStage({ ...ready, ...flags, inspection: 'INVALIDADA', packaging: null })).toBe(
      'AGUARDANDO_INSPECAO',
    );
    expect(computeStage({ ...ready, ...flags, requiredTasksDone: 1 })).toBe('EM_PRODUCAO');
    expect(computeStage({ ...ready, ...flags, returned: true, delivered: true })).toBe('DEVOLVIDA');
  });

  it('quem decide a inspeção (sem autoaprovação)', () => {
    const base = {
      isManager: false,
      isAssignedInspector: true,
      executedService: false,
      executorAuthorized: false,
    };
    expect(canDecideInspection(base).allowed).toBe(true);
    expect(canDecideInspection({ ...base, executedService: true }).allowed).toBe(false);
    expect(
      canDecideInspection({ ...base, executedService: true, executorAuthorized: true }).allowed,
    ).toBe(true);
    expect(canDecideInspection({ ...base, isAssignedInspector: false }).allowed).toBe(false);
    expect(
      canDecideInspection({ ...base, isAssignedInspector: false, isManager: true }).allowed,
    ).toBe(true);
  });

  it('aprovação e reprovação: checklist, motivo e defeito', () => {
    const items = [
      { required: true, result: 'OK' as const },
      { required: false, result: 'NAO_SE_APLICA' as const },
    ];
    expect(decisionProblems('APROVAR', items)).toEqual([]);
    expect(decisionProblems('APROVAR', [{ required: true, result: null }])).toHaveLength(1);
    expect(decisionProblems('REPROVAR', items, 'Costura solta')).toHaveLength(1);
    expect(
      decisionProblems('REPROVAR', [{ required: true, result: 'NAO_CONFORME' }], ''),
    ).toHaveLength(1);
  });

  it('checklist sem itens irrelevantes para o serviço', () => {
    const cadeiras = DEFAULT_QUALITY_TEMPLATES.find((t) => t.name === 'Cadeiras e poltronas')!;
    const items = cadeiras.items.map((i) => ({ ...i, serviceTypes: i.serviceTypes ?? [] }));
    expect(checklistFor(items, 'TROCA_DE_TECIDO').map((i) => i.label)).toEqual([
      'Estabilidade',
      'Costuras',
      'Acabamento',
      'Limpeza',
    ]);
    expect(checklistFor(items, 'REFORMA_COMPLETA')).toHaveLength(6);
  });

  it('entregas: transições, região e etiqueta', () => {
    expect(canDeliveryTransition('EM_TRANSPORTE', 'CONCLUIDA')).toBe(false);
    expect(canDeliveryTransition('NO_DESTINO', 'CONCLUIDA')).toBe(true);
    expect(canDeliveryTransition('FRUSTRADA', 'AGENDADA')).toBe(true);
    expect(regionOf({ city: 'Curitiba', district: 'Batel' })).toBe('Curitiba — Batel');
    expect(parsePieceLabel(pieceLabelPayload('OS-00012/2'))).toBe('OS-00012/2');
    expect(parsePieceLabel('qualquer coisa')).toBeNull();
  });

  it('correção de recebimento não descobre peça em OS', () => {
    const base = {
      currentReceived: 2,
      lineQuantity: 2,
      ordered: 2,
      inServiceOrders: 2,
      returned: 0,
    };
    expect(receiptCorrectionProblem({ ...base, newLineQuantity: 1 })).toMatch(/OS ativa/);
    expect(
      receiptCorrectionProblem({ ...base, inServiceOrders: 0, newLineQuantity: 1 }),
    ).toBeNull();
    expect(receiptCorrectionProblem({ ...base, inServiceOrders: 0, newLineQuantity: 3 })).toMatch(
      /pedido/,
    );
  });
});
