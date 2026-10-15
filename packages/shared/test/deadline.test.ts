import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  deadlineReasons,
  deadlineWindowEnd,
  orderDeadline,
  serviceDeadline,
  workingDaysUntil,
  type DeadlineFacts,
} from '../src';

/** Quinta-feira, 15/10/2026; expediente de segunda a sexta (padrão da empresa). */
const TODAY = '2026-10-15';
const WEEK = [1, 2, 3, 4, 5];

const facts = (over: Partial<DeadlineFacts> = {}): DeadlineFacts => ({
  status: 'ABERTA',
  promisedDate: TODAY,
  pieces: [{ stage: 'EM_PRODUCAO', delivery: null, frustrationKind: null }],
  planned: true,
  started: true,
  blocked: false,
  materialsReadiness: 'COMPLETO',
  ...over,
});
const piece = (
  stage: string,
  delivery: { status: string; scheduledDate: string } | null = null,
) => ({
  stage,
  delivery,
  frustrationKind: null as string | null,
});

describe('calendário de dias úteis (dias de trabalho da empresa)', () => {
  it('5 dias úteis a partir de quinta = quinta seguinte (pula o fim de semana)', () => {
    expect(addWorkingDays(TODAY, 1, WEEK)).toBe('2026-10-16');
    expect(addWorkingDays(TODAY, 2, WEEK)).toBe('2026-10-19');
    expect(deadlineWindowEnd(TODAY, WEEK)).toBe('2026-10-22');
    expect(addWorkingDays(TODAY, 6, WEEK)).toBe('2026-10-23');
  });
  it('sábado como dia de trabalho encurta a janela', () => {
    expect(deadlineWindowEnd(TODAY, [1, 2, 3, 4, 5, 6])).toBe('2026-10-21');
  });
  it('dias úteis restantes e de atraso', () => {
    expect(workingDaysUntil(TODAY, TODAY, WEEK)).toBe(0);
    expect(workingDaysUntil(TODAY, '2026-10-19', WEEK)).toBe(2);
    expect(workingDaysUntil(TODAY, '2026-10-17', WEEK)).toBe(1);
    expect(workingDaysUntil(TODAY, '2026-10-14', WEEK)).toBe(-1);
    expect(workingDaysUntil('2026-10-19', '2026-10-16', WEEK)).toBe(-1);
  });
});

describe('estado do prazo da OS (regra única)', () => {
  const at = (promisedDate: string | null, over: Partial<DeadlineFacts> = {}) =>
    serviceDeadline(facts({ promisedDate, ...over }), TODAY, WEEK);

  it('prazo ontem + peça não entregue = ATRASADO, mesmo sem motivo', () => {
    const d = at('2026-10-14');
    expect(d).toMatchObject({ state: 'ATRASADO', workingDays: -1, reasons: [] });
  });
  it('prazo hoje = PROXIMO (não atrasado)', () => {
    expect(at(TODAY).state).toBe('PROXIMO');
  });
  it('prazo em 5 dias úteis = PROXIMO; em 6 dias úteis = NO_PRAZO', () => {
    expect(at('2026-10-22').state).toBe('PROXIMO');
    expect(at('2026-10-23').state).toBe('NO_PRAZO');
  });
  it('prazo num fim de semana dentro da janela = PROXIMO', () => {
    expect(at('2026-10-17')).toMatchObject({ state: 'PROXIMO', workingDays: 1 });
  });
  it('sem prazo = SEM_PRAZO (dado antigo nunca vira atrasado)', () => {
    expect(at(null).state).toBe('SEM_PRAZO');
  });
  it('cancelada, totalmente entregue ou sem peça ativa = ENCERRADA', () => {
    expect(at('2026-10-01', { status: 'CANCELADA' }).state).toBe('ENCERRADA');
    expect(at('2026-10-01', { pieces: [piece('ENTREGUE'), piece('ENTREGUE')] }).state).toBe(
      'ENCERRADA',
    );
    // A API remove DEVOLVIDA/CANCELADA das peças ativas: nada ativo = encerrada.
    expect(at('2026-10-01', { pieces: [] }).state).toBe('ENCERRADA');
  });
  it('entrega parcial: continua atrasada enquanto houver peça por entregar', () => {
    expect(
      at('2026-10-01', { pieces: [piece('ENTREGUE'), piece('PRONTA_ENTREGA')] }),
    ).toMatchObject({ state: 'ATRASADO', reasons: ['PRONTA_SEM_ENTREGA'] });
  });

  it('cada motivo de risco, isoladamente', () => {
    const r = (over: Partial<DeadlineFacts>) => at('2026-10-20', over);
    expect(r({ planned: false, started: false })).toMatchObject({
      state: 'EM_RISCO',
      reasons: ['NAO_PLANEJADA'],
    });
    expect(r({ started: false }).reasons).toEqual(['PRODUCAO_NAO_INICIADA']);
    expect(r({ blocked: true }).reasons).toEqual(['BLOQUEADA']);
    expect(r({ pieces: [piece('BLOQUEIO_EXPEDICAO')] }).reasons).toEqual(['BLOQUEADA']);
    expect(r({ materialsReadiness: 'AGUARDANDO_COMPRA' }).reasons).toEqual(['MATERIAIS']);
    expect(r({ pieces: [piece('EM_CORRECAO')] }).reasons).toEqual(['EM_CORRECAO']);
    expect(r({ pieces: [piece('PRONTA_ENTREGA')] }).reasons).toEqual(['PRONTA_SEM_ENTREGA']);
    // Provisória não é entrega agendada.
    expect(
      r({
        pieces: [piece('PRONTA_ENTREGA', { status: 'PROVISORIA', scheduledDate: '2026-10-19' })],
      }).reasons,
    ).toEqual(['PRONTA_SEM_ENTREGA']);
    expect(
      r({
        pieces: [piece('ENTREGA_AGENDADA', { status: 'AGENDADA', scheduledDate: '2026-10-21' })],
      }).reasons,
    ).toEqual(['ENTREGA_DEPOIS_DO_PRAZO']);
    expect(
      r({
        pieces: [piece('ENTREGA_AGENDADA', { status: 'AGENDADA', scheduledDate: '2026-10-20' })],
      }).state,
    ).toBe('PROXIMO');
    expect(
      r({ pieces: [piece('PRONTA_ENTREGA', { status: 'FRUSTRADA', scheduledDate: '2026-10-14' })] })
        .reasons,
    ).toEqual(['ENTREGA_FRUSTRADA']);
  });
  it('materiais e planejamento só contam enquanto há peça em produção', () => {
    expect(
      at('2026-10-20', {
        planned: false,
        started: false,
        materialsReadiness: 'AGUARDANDO_COMPRA',
        pieces: [piece('ENTREGA_AGENDADA', { status: 'AGENDADA', scheduledDate: '2026-10-19' })],
      }).state,
    ).toBe('PROXIMO');
  });
  it('vários motivos agregados numa única avaliação, em ordem fixa', () => {
    const d = at('2026-10-20', {
      started: false,
      blocked: true,
      materialsReadiness: 'COM_DIVERGENCIA',
      pieces: [piece('EM_PRODUCAO'), piece('EM_CORRECAO')],
    });
    expect(d.reasons).toEqual(['PRODUCAO_NAO_INICIADA', 'BLOQUEADA', 'MATERIAIS', 'EM_CORRECAO']);
  });
  it('ATRASADO prevalece e a causa conhecida aparece como contexto (cliente indisponível)', () => {
    const d = at('2026-10-13', {
      pieces: [
        {
          stage: 'PRONTA_ENTREGA',
          delivery: { status: 'FRUSTRADA', scheduledDate: '2026-10-13' },
          frustrationKind: 'CLIENTE_INDISPONIVEL',
        },
      ],
    });
    expect(d).toMatchObject({
      state: 'ATRASADO',
      reasons: ['ENTREGA_FRUSTRADA'],
      context: ['Cliente indisponível para entrega.'],
    });
  });
  it('deadlineReasons é pura: os mesmos fatos dão os mesmos motivos', () => {
    const f = facts({ started: false, blocked: true });
    expect(deadlineReasons(f)).toEqual(deadlineReasons(f));
  });
});

describe('atenção do pedido (peças ainda não recebidas)', () => {
  const o = (promisedDate: string | null, missingPieces = 1, status = 'RECEBIDO_PARCIAL') =>
    orderDeadline({ status, promisedDate, missingPieces }, TODAY, WEEK);
  it('prazo na janela com peça faltando = PRAZO_PROXIMO; vencido = PRAZO_VENCIDO', () => {
    expect(o('2026-10-22')).toBe('PRAZO_PROXIMO');
    expect(o(TODAY)).toBe('PRAZO_PROXIMO');
    expect(o('2026-10-14')).toBe('PRAZO_VENCIDO');
  });
  it('fora da janela, sem prazo, sem peça faltando ou cancelado = nada', () => {
    expect(o('2026-10-23')).toBeNull();
    expect(o(null)).toBeNull();
    expect(o('2026-10-14', 0)).toBeNull();
    expect(o('2026-10-14', 1, 'CANCELADO')).toBeNull();
  });
});
