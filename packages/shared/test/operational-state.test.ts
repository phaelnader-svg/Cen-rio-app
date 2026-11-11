import { describe, expect, it } from 'vitest';
import {
  FULFILLMENT_STAGES,
  OPERATIONAL_STATES,
  OPERATIONAL_STATE_LABEL,
  computeStage,
  operationalItemState,
  operationalOrderState,
  type OperationalTaskInput,
  type TaskStatus,
} from '../src';

/** Reformulação, Fase 0 — estado operacional derivado (somente leitura). */
const t = (status: TaskStatus, blockers: string[] = []): OperationalTaskInput => ({
  status,
  blockers,
});
const prod = (...tasks: OperationalTaskInput[]) =>
  operationalItemState({ stage: 'EM_PRODUCAO', tasks });

describe('estado operacional da peça', () => {
  it('toda etapa canônica tem um estado (nenhuma fica sem mapeamento) e todo estado tem rótulo', () => {
    for (const stage of FULFILLMENT_STAGES) {
      const r = operationalItemState({ stage, tasks: [t('EM_EXECUCAO')] });
      expect(OPERATIONAL_STATES).toContain(r.state);
    }
    for (const s of OPERATIONAL_STATES) expect(OPERATIONAL_STATE_LABEL[s]).toBeTruthy();
  });

  it('fora de "em produção", o estado vem só da etapa gravada (as tarefas não mudam nada)', () => {
    const map = {
      AGUARDANDO_INSPECAO: 'AGUARDANDO_QUALIDADE',
      EM_INSPECAO: 'AGUARDANDO_QUALIDADE',
      EM_CORRECAO: 'CORRECAO_NECESSARIA',
      AGUARDANDO_EMBALAGEM: 'EMBALAGEM',
      EM_EMBALAGEM: 'EMBALAGEM',
      BLOQUEIO_EXPEDICAO: 'PRONTA_PARA_ENTREGA',
      PRONTA_ENTREGA: 'PRONTA_PARA_ENTREGA',
      ENTREGA_AGENDADA: 'PRONTA_PARA_ENTREGA',
      EM_TRANSPORTE: 'EM_ENTREGA',
      ENTREGUE: 'ENTREGUE',
      DEVOLVIDA: 'DEVOLVIDA',
      CANCELADA: 'CANCELADA',
    } as const;
    for (const [stage, state] of Object.entries(map))
      for (const tasks of [[], [t('EM_EXECUCAO')], [t('BLOQUEADA', ['MATERIAIS'])]])
        expect(
          operationalItemState({ stage: stage as keyof typeof map, tasks }).state,
          `${stage}`,
        ).toBe(state);
    expect(operationalItemState({ stage: 'BLOQUEIO_EXPEDICAO', tasks: [] }).reasons).toEqual([
      'BLOQUEIO_EXPEDICAO',
    ]);
  });

  it('em produção: sem tarefa publicada não é presumida pronta', () => {
    expect(prod()).toEqual({ state: 'NAO_PLANEJADA', reasons: ['SEM_TAREFAS'] });
    expect(prod(t('RASCUNHO'))).toEqual({ state: 'NAO_PLANEJADA', reasons: ['SO_RASCUNHO'] });
    expect(prod(t('CANCELADA'))).toEqual({ state: 'NAO_PLANEJADA', reasons: ['SEM_TAREFAS'] });
  });

  it('em produção: execução e pausa prevalecem', () => {
    expect(prod(t('EM_EXECUCAO'), t('BLOQUEADA', ['MATERIAIS'])).state).toBe('EM_PRODUCAO');
    expect(prod(t('PAUSADA'), t('BLOQUEADA', ['DEPENDENCIAS']))).toEqual({
      state: 'EM_PRODUCAO',
      reasons: ['PAUSADA'],
    });
  });

  it('em produção: material segura a peça só quando nada está liberado', () => {
    expect(prod(t('BLOQUEADA', ['MATERIAIS', 'DEPENDENCIAS']))).toEqual({
      state: 'AGUARDANDO_MATERIAIS',
      reasons: ['BLOQUEIO:DEPENDENCIAS', 'BLOQUEIO:MATERIAIS'],
    });
    expect(prod(t('CONCLUIDA'), t('BLOQUEADA', ['MATERIAIS'])).state).toBe('AGUARDANDO_MATERIAIS');
    expect(prod(t('LIBERADA'), t('BLOQUEADA', ['MATERIAIS'])).state).toBe('PRONTA_PARA_PRODUCAO');
  });

  it('em produção: liberada, programada, entre etapas e impedida', () => {
    expect(prod(t('LIBERADA'), t('BLOQUEADA', ['DEPENDENCIAS'])).state).toBe(
      'PRONTA_PARA_PRODUCAO',
    );
    expect(prod(t('PROGRAMADA'), t('BLOQUEADA', ['DEPENDENCIAS']))).toEqual({
      state: 'PRONTA_PARA_PRODUCAO',
      reasons: ['PROGRAMADA'],
    });
    expect(prod(t('CONCLUIDA'), t('LIBERADA')).state).toBe('EM_PRODUCAO');
    expect(prod(t('CONCLUIDA'), t('BLOQUEADA', ['OCORRENCIA']))).toEqual({
      state: 'EM_PRODUCAO',
      reasons: ['ENTRE_ETAPAS', 'BLOQUEIO:OCORRENCIA'],
    });
    expect(prod(t('BLOQUEADA', ['BLOQUEIO']))).toEqual({
      state: 'PRODUCAO_IMPEDIDA',
      reasons: ['BLOQUEIO:BLOQUEIO'],
    });
  });

  it('compatível com a etapa canônica: o mesmo cálculo de `computeStage` leva ao estado esperado', () => {
    const base = {
      requiredTasks: 1,
      requiredTasksDone: 1,
      inspection: 'APROVADA' as const,
      openCorrections: 0,
      packaging: 'CONCLUIDA' as const,
      shippingBlock: false,
      cancelled: false,
      returned: false,
      delivered: false,
      inTransit: false,
      scheduled: false,
    };
    const of = (o: Partial<typeof base>) =>
      operationalItemState({ stage: computeStage({ ...base, ...o }), tasks: [] }).state;
    expect(of({})).toBe('PRONTA_PARA_ENTREGA');
    expect(of({ packaging: 'PENDENTE' })).toBe('EMBALAGEM');
    expect(of({ inspection: null })).toBe('AGUARDANDO_QUALIDADE');
    expect(of({ inspection: 'REPROVADA' })).toBe('CORRECAO_NECESSARIA');
    expect(of({ delivered: true })).toBe('ENTREGUE');
    expect(of({ requiredTasksDone: 0 })).toBe('NAO_PLANEJADA'); // sem tarefas informadas
  });
});

describe('estado operacional da OS', () => {
  const s = (state: (typeof OPERATIONAL_STATES)[number]) => ({ state, reasons: [] });

  it('mostra a peça ativa menos avançada e conta por estado', () => {
    const r = operationalOrderState([s('AGUARDANDO_QUALIDADE'), s('EM_PRODUCAO'), s('ENTREGUE')]);
    expect(r.state).toBe('EM_PRODUCAO');
    expect(r.counts).toEqual({ AGUARDANDO_QUALIDADE: 1, EM_PRODUCAO: 1, ENTREGUE: 1 });
    expect(r.activeItems).toBe(2);
    expect(r.totalItems).toBe(3);
  });

  it('correção vem antes de qualidade; pronta para entrega só quando nenhuma peça está atrás', () => {
    expect(operationalOrderState([s('AGUARDANDO_QUALIDADE'), s('CORRECAO_NECESSARIA')]).state).toBe(
      'CORRECAO_NECESSARIA',
    );
    expect(operationalOrderState([s('PRONTA_PARA_ENTREGA'), s('EMBALAGEM')]).state).toBe(
      'EMBALAGEM',
    );
  });

  it('sem peças ativas: entregue > devolvida > cancelada; OS cancelada é sempre cancelada', () => {
    expect(operationalOrderState([s('ENTREGUE'), s('CANCELADA')]).state).toBe('ENTREGUE');
    expect(operationalOrderState([s('DEVOLVIDA'), s('CANCELADA')]).state).toBe('DEVOLVIDA');
    expect(operationalOrderState([s('CANCELADA')]).state).toBe('CANCELADA');
    expect(operationalOrderState([s('EM_PRODUCAO')], true).state).toBe('CANCELADA');
    expect(operationalOrderState([]).state).toBe('NAO_PLANEJADA');
  });
});
