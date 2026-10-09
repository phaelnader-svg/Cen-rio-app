import { describe, expect, it } from 'vitest';
import { pageOf, summarizeWeek, type WeekViewTask } from '../src';

const t = (
  id: string,
  status: WeekViewTask['status'],
  blockers: WeekViewTask['blockers'] = [],
) => ({
  id,
  status,
  blockers,
  blockedReason: null,
});
const queue = (tasks: ReturnType<typeof t>[], current: string | null, next: string | null) => ({
  current: tasks.find((x) => x.id === current) ?? null,
  next: tasks.find((x) => x.id === next) ?? null,
  items: tasks.map((task, i) => ({
    position: i + 1,
    executable: task.status === 'LIBERADA' || task.status === 'PAUSADA',
    task,
  })),
});

describe('Evolução Fase 4 — Minha semana (seleção)', () => {
  it('destaque é a tarefa em execução; próximas são as três seguintes na ordem', () => {
    const q = queue(
      [
        t('a', 'LIBERADA'),
        t('b', 'EM_EXECUCAO'),
        t('c', 'LIBERADA'),
        t('d', 'BLOQUEADA', ['DEPENDENCIAS']),
        t('e', 'LIBERADA'),
      ],
      'b',
      'a',
    );
    const s = summarizeWeek(q);
    expect(s.kind).toBe('EM_EXECUCAO');
    expect(s.highlight!.id).toBe('b');
    expect(s.upcoming.map((e) => e.task.id)).toEqual(['a', 'c', 'd']);
    expect(s.hasMore).toBe(true);
  });

  it('sem execução: destaca a primeira executável sem reordenar (bloqueada à frente fica na lista)', () => {
    const q = queue(
      [t('x', 'BLOQUEADA', ['MATERIAIS']), t('y', 'LIBERADA'), t('z', 'LIBERADA')],
      null,
      'y',
    );
    const s = summarizeWeek(q);
    expect(s.kind).toBe('PROXIMA');
    expect(s.highlight!.id).toBe('y');
    expect(s.upcoming.map((e) => e.task.id)).toEqual(['x', 'z']);
    expect(s.hasMore).toBe(false);
  });

  it('menos de três: não inventa cartões; fila vazia não tem destaque', () => {
    expect(summarizeWeek(queue([t('a', 'LIBERADA')], null, 'a')).upcoming).toEqual([]);
    const empty = summarizeWeek(queue([], null, null));
    expect(empty).toMatchObject({
      highlight: null,
      kind: null,
      upcoming: [],
      hasMore: false,
      waitReasons: [],
    });
  });

  it('nada executável: explica os motivos agregados', () => {
    const q = queue(
      [
        t('a', 'BLOQUEADA', ['DEPENDENCIAS']),
        t('b', 'BLOQUEADA', ['MATERIAIS', 'DEPENDENCIAS']),
        t('c', 'BLOQUEADA', ['OCORRENCIA']),
      ],
      null,
      null,
    );
    const s = summarizeWeek(q);
    expect(s.highlight).toBeNull();
    expect(s.waitReasons.sort()).toEqual(['DEPENDENCIAS', 'MATERIAIS', 'OCORRENCIA']);
    expect(s.upcoming).toHaveLength(3);
  });

  it('paginação da fila completa', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    expect(pageOf(items, 1).items).toHaveLength(20);
    expect(pageOf(items, 3)).toMatchObject({ page: 3, pages: 3 });
    expect(pageOf(items, 3).items).toEqual([40, 41, 42, 43, 44]);
    expect(pageOf(items, 99).page).toBe(3);
  });
});
