import { describe, expect, it } from 'vitest';
import {
  compareQueue,
  compareTasks,
  createPlanSchema,
  evaluateRelease,
  onlyReassignableBlockers,
  queueOrderProblem,
  findCycle,
  mondayOf,
  templateSchema,
  zonedDateTime,
} from '../src';

const base = {
  osActive: true,
  pieceReceived: true,
  published: true,
  assigned: true,
  dependenciesDone: true,
  materialsReady: true,
  requiresMaterials: true,
  manuallyBlocked: false,
  scheduledAt: new Date('2026-10-08T11:30:00Z'),
  now: new Date('2026-10-08T12:00:00Z'),
};

describe('Liberação de tarefas', () => {
  it('liberada só com todas as condições; programada antes do horário', () => {
    expect(evaluateRelease(base)).toEqual({ status: 'LIBERADA', blockers: [] });
    expect(evaluateRelease({ ...base, now: new Date('2026-10-08T11:00:00Z') }).status).toBe(
      'PROGRAMADA',
    );
    expect(evaluateRelease({ ...base, scheduledAt: null }).status).toBe('PROGRAMADA');
    expect(evaluateRelease({ ...base, materialsReady: false })).toEqual({
      status: 'BLOQUEADA',
      blockers: ['MATERIAIS'],
    });
    expect(
      evaluateRelease({ ...base, materialsReady: false, requiresMaterials: false }).status,
    ).toBe('LIBERADA');
    expect(
      evaluateRelease({
        ...base,
        osActive: false,
        published: false,
        dependenciesDone: false,
        manuallyBlocked: true,
      }).blockers,
    ).toEqual(['OS_INATIVA', 'NAO_PUBLICADA', 'DEPENDENCIAS', 'BLOQUEIO']);
  });
});

describe('Dependências', () => {
  it('detecta ciclos e aceita grafos com vários pais', () => {
    const dag = new Map([
      ['montagem', ['preparacao', 'costura']],
      ['costura', ['corte']],
      ['preparacao', ['desmontagem']],
    ]);
    expect(findCycle(dag)).toBeNull();
    dag.set('desmontagem', ['montagem']);
    expect(findCycle(dag)).toEqual(['montagem', 'preparacao', 'desmontagem', 'montagem']);
  });

  it('modelo só aceita dependência de etapa anterior', () => {
    const step = (dependsOn: number[]) => ({ activity: 'MONTAGEM', name: 'Etapa', dependsOn });
    expect(templateSchema.safeParse({ name: 'Modelo', steps: [step([]), step([1])] }).success).toBe(
      true,
    );
    expect(templateSchema.safeParse({ name: 'Modelo', steps: [step([2]), step([])] }).success).toBe(
      false,
    );
  });
});

describe('Datas e ordenação', () => {
  it('semana começa na segunda; horário no fuso da empresa', () => {
    expect(mondayOf('2026-10-09')).toBe('2026-10-05');
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(zonedDateTime('2026-10-09', '08:30', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-10-09T11:30:00.000Z',
    );
  });

  it('em execução primeiro, depois prioridade e horário', () => {
    const t = (status: string, priority: string, scheduledAt: string | null, sequence = 0) =>
      ({ status, priority, scheduledAt, sequence }) as Parameters<typeof compareTasks>[0];
    const list = [
      t('LIBERADA', 'NORMAL', '2026-10-08T12:00:00Z'),
      t('LIBERADA', 'URGENTE', '2026-10-08T14:00:00Z'),
      t('EM_EXECUCAO', 'BAIXA', null),
      t('BLOQUEADA', 'URGENTE', null),
    ].sort(compareTasks);
    expect(list.map((x) => `${x.status}/${x.priority}`)).toEqual([
      'EM_EXECUCAO/BAIXA',
      'LIBERADA/URGENTE',
      'LIBERADA/NORMAL',
      'BLOQUEADA/URGENTE',
    ]);
  });
});

describe('Evolução Fase 2 — fila semanal', () => {
  it('liberação por modo: LEGADO exige horário; FILA ignora horário mas mantém os bloqueios', () => {
    const noTime = { ...base, scheduledAt: null };
    const future = { ...base, now: new Date('2026-10-08T11:00:00Z') };
    expect(evaluateRelease(noTime).status).toBe('PROGRAMADA');
    expect(evaluateRelease({ ...noTime, mode: 'LEGADO' }).status).toBe('PROGRAMADA');
    expect(evaluateRelease(future).status).toBe('PROGRAMADA');
    expect(evaluateRelease({ ...noTime, mode: 'FILA_SEMANAL' })).toEqual({
      status: 'LIBERADA',
      blockers: [],
    });
    expect(evaluateRelease({ ...future, mode: 'FILA_SEMANAL' }).status).toBe('LIBERADA');
    expect(
      evaluateRelease({
        ...noTime,
        mode: 'FILA_SEMANAL',
        dependenciesDone: false,
        materialsReady: false,
      }),
    ).toEqual({ status: 'BLOQUEADA', blockers: ['DEPENDENCIAS', 'MATERIAIS'] });
  });

  it('planos novos nascem em fila; LEGADO só se pedido', () => {
    expect(createPlanSchema.parse({ weekStart: '2026-10-12' }).mode).toBe('FILA_SEMANAL');
    expect(createPlanSchema.parse({ weekStart: '2026-10-12', mode: 'LEGADO' }).mode).toBe('LEGADO');
  });

  it('ordem da fila: semana, prioridade, posição do gestor, sequência e número (determinística)', () => {
    const t = (id: string, o: Partial<Parameters<typeof compareQueue>[0]>) => ({
      id,
      weekStart: '2026-10-12',
      priority: 'NORMAL',
      queuePosition: null as number | null,
      sequence: 100,
      number: 1,
      ...o,
    });
    const list = [
      t('seq2', { sequence: 200, number: 5 }),
      t('num2', { number: 2 }),
      t('pos2', { queuePosition: 2, number: 9 }),
      t('urg', { priority: 'URGENTE', number: 8 }),
      t('pos1', { queuePosition: 1, number: 7 }),
      t('anterior', { weekStart: '2026-10-05', priority: 'BAIXA', number: 99 }),
      t('num1', { number: 1 }),
    ];
    expect(list.sort(compareQueue).map((x) => x.id)).toEqual([
      'anterior',
      'urg',
      'pos1',
      'pos2',
      'num1',
      'num2',
      'seq2',
    ]);
  });

  it('posição só pesa quando definida: ordem legada (sem posição) inalterada', () => {
    const a = {
      status: 'LIBERADA' as const,
      priority: 'NORMAL',
      scheduledAt: '2026-10-08T10:00:00Z',
      sequence: 2,
    };
    const b = { ...a, scheduledAt: '2026-10-08T09:00:00Z', sequence: 1 };
    expect([a, b].sort(compareTasks)).toEqual([b, a]);
    const an = { ...a, queuePosition: null };
    const bn = { ...b, queuePosition: null };
    expect([an, bn].sort(compareTasks)).toEqual([bn, an]);
    // Com posição definida, ela vence o horário.
    expect(
      [
        { ...b, queuePosition: 2 },
        { ...a, queuePosition: 1 },
      ].sort(compareTasks)[0],
    ).toMatchObject({
      queuePosition: 1,
    });
  });

  it('reordenação respeita faixas de prioridade e dependências', () => {
    expect(
      queueOrderProblem([
        { id: 'a', priority: 'URGENTE', dependsOn: [] },
        { id: 'b', priority: 'NORMAL', dependsOn: ['a'] },
      ]),
    ).toBeNull();
    expect(
      queueOrderProblem([
        { id: 'b', priority: 'NORMAL', dependsOn: [] },
        { id: 'a', priority: 'URGENTE', dependsOn: [] },
      ]),
    ).toMatch(/prioridade/);
    expect(
      queueOrderProblem([
        { id: 'b', priority: 'NORMAL', dependsOn: ['a'] },
        { id: 'a', priority: 'NORMAL', dependsOn: [] },
      ]),
    ).toMatch(/depende/);
  });

  it('defeito HORARIO corrigido: só DEPENDENCIAS permite a redistribuição simples', () => {
    expect(onlyReassignableBlockers(['DEPENDENCIAS'])).toBe(true);
    expect(onlyReassignableBlockers(['HORARIO'])).toBe(false);
    expect(onlyReassignableBlockers(['MATERIAIS'])).toBe(false);
  });
});
