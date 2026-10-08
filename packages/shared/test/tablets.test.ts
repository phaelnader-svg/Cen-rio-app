import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABEL,
  completeTaskSchema,
  pauseTaskSchema,
  progressTaskSchema,
  templateStepSchema,
} from '../src';

describe('Fase 6 — esquemas do tablet', () => {
  it('andamento: basta um campo útil; percentual nunca é obrigatório', () => {
    expect(progressTaskSchema.safeParse({}).success).toBe(false);
    expect(progressTaskSchema.safeParse({ note: '   ' }).success).toBe(false);
    expect(progressTaskSchema.parse({ step: 'Braços cortados' })).toMatchObject({
      step: 'Braços cortados',
      attachmentIds: [],
    });
    expect(progressTaskSchema.safeParse({ percent: 0 }).success).toBe(true);
    expect(progressTaskSchema.safeParse({ percent: 120 }).success).toBe(false);
  });

  it('conclusão comum não exige nada; pausa por impedimento é opcional', () => {
    expect(completeTaskSchema.parse(undefined)).toEqual({ attachmentIds: [] });
    expect(completeTaskSchema.parse({})).toEqual({ attachmentIds: [] });
    expect(pauseTaskSchema.parse({ reason: 'FIM_EXPEDIENTE' }).impediment).toBe(false);
    expect(pauseTaskSchema.safeParse({ reason: 'OUTRO' }).success).toBe(false);
  });

  it('etapa de modelo: registro de conclusão padrão é nenhum', () => {
    const step = templateStepSchema.parse({ activity: 'ACABAMENTO', name: 'Acabamento' });
    expect(step.completionRequirement).toBe('NENHUM');
  });

  it('todo tipo de aviso tem título em português', () => {
    for (const k of NOTIFICATION_KINDS)
      expect(NOTIFICATION_KIND_LABEL[k].length).toBeGreaterThan(3);
  });
});
