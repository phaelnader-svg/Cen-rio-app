import { describe, expect, it } from 'vitest';
import {
  blocksTaskFor,
  canTransition,
  evaluateRelease,
  initialIssuePriority,
  issueCategory,
  issueCode,
  openIssueSchema,
} from '../src';

describe('Fase 9 — regras das ocorrências', () => {
  it('código, impacto e prioridade inicial', () => {
    expect(issueCode(7)).toBe('OC-00007');
    expect(blocksTaskFor('IMPEDIDO')).toBe(true);
    expect(blocksTaskFor('OUTRA_ATIVIDADE')).toBe(true);
    expect(blocksTaskFor('DIFICULDADE')).toBe(false);
    expect(initialIssuePriority('IMPEDIDO', 'NORMAL')).toBe('ALTA');
    expect(initialIssuePriority('IMPEDIDO', 'URGENTE')).toBe('URGENTE');
    expect(initialIssuePriority('DIFICULDADE', 'URGENTE')).toBe('NORMAL');
  });

  it('estados: conclusão não resolve; reabertura só depois de encerrada', () => {
    expect(canTransition('EM_RESOLUCAO', 'RESOLVIDA')).toBe(false);
    expect(canTransition('AGUARDANDO_VERIFICACAO', 'RESOLVIDA')).toBe(true);
    expect(canTransition('RESOLVIDA', 'ABERTA')).toBe(true);
    expect(canTransition('ABERTA', 'RESOLVIDA')).toBe(false);
    expect(canTransition('RESOLVIDA', 'CANCELADA')).toBe(false);
  });

  it('categoria na central de atenção', () => {
    const base = { blocksTask: true, deadlineRisk: false, resolutionOverdue: false };
    expect(issueCategory({ ...base, status: 'ABERTA' })).toBe('ACAO');
    expect(issueCategory({ ...base, status: 'EM_RESOLUCAO' })).toBe('ATENCAO');
    expect(issueCategory({ ...base, status: 'ATRIBUIDA', deadlineRisk: true })).toBe('CRITICO');
    expect(issueCategory({ ...base, status: 'ATRIBUIDA', resolutionOverdue: true })).toBe(
      'CRITICO',
    );
    expect(issueCategory({ ...base, status: 'AGUARDANDO_VERIFICACAO' })).toBe('ACAO');
    expect(issueCategory({ ...base, blocksTask: false, status: 'ATRIBUIDA' })).toBe('INFO');
    expect(issueCategory({ ...base, status: 'RESOLVIDA' })).toBe('INFO');
  });

  it('ocorrência aberta bloqueia a liberação da tarefa', () => {
    const r = evaluateRelease({
      osActive: true,
      pieceReceived: true,
      published: true,
      assigned: true,
      dependenciesDone: true,
      materialsReady: true,
      requiresMaterials: false,
      manuallyBlocked: false,
      openIssue: true,
      scheduledAt: new Date('2026-10-08T11:00:00Z'),
      now: new Date('2026-10-08T12:00:00Z'),
    });
    expect(r).toEqual({ status: 'BLOQUEADA', blockers: ['OCORRENCIA'] });
  });

  it('formulário do tablet: outro impedimento só pede descrição e se continua', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(
      openIssueSchema.safeParse({ taskId: id, kind: 'OUTRO', description: 'Sem luz' }).success,
    ).toBe(false);
    expect(
      openIssueSchema.safeParse({
        taskId: id,
        kind: 'OUTRO',
        description: 'Sem luz',
        canContinue: false,
      }).success,
    ).toBe(true);
    expect(
      openIssueSchema.safeParse({ taskId: id, kind: 'TECNICO', description: 'Máquina' }).success,
    ).toBe(false);
    expect(
      openIssueSchema.safeParse({
        taskId: id,
        kind: 'MATERIAL',
        impact: 'IMPEDIDO',
        material: { description: 'Grampo', quantity: 2, unit: 'EMBALAGEM' },
      }).success,
    ).toBe(true);
  });
});
