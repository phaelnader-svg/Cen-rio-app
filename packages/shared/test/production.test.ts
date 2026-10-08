import { describe, expect, it } from 'vitest';
import {
  compareTasks,
  evaluateRelease,
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
