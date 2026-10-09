import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STEP_CLASS,
  DEFAULT_PRODUCTION_TEMPLATES,
  PLANNABLE_ACTIVITIES,
  STEP_CLASSIFICATION_VERSION,
  classifyStep,
  stepClassProblem,
  templateSchema,
} from '../src';

describe('Evolução Fase 3 — classificação das etapas', () => {
  it('versão 1: toda atividade programável tem classe natural', () => {
    expect(STEP_CLASSIFICATION_VERSION).toBe(1);
    for (const a of PLANNABLE_ACTIVITIES) expect(ACTIVITY_STEP_CLASS[a]).toBeTruthy();
  });

  it('classifica só quando atividade e papel concordam (ambíguo = null)', () => {
    expect(classifyStep('COSTURA', 'PRINCIPAL')).toBe('TAPECARIA');
    expect(classifyStep('PREPARACAO', 'APOIO')).toBe('PREPARACAO');
    expect(classifyStep('OUTRA', 'APOIO')).toBe('OUTRA');
    expect(classifyStep('MONTAGEM', 'APOIO')).toBeNull();
    expect(classifyStep('DESMONTAGEM', 'PRINCIPAL')).toBeNull();
  });

  it('modelos padrão ficam inteiramente classificados (nenhuma etapa ambígua)', () => {
    for (const t of DEFAULT_PRODUCTION_TEMPLATES)
      for (const s of t.steps) expect(classifyStep(s.activity, s.role)).not.toBeNull();
  });

  it('classe explícita incompatível com a atividade é recusada', () => {
    expect(stepClassProblem('COSTURA', 'PREPARACAO')).toMatch(/não combina/);
    expect(stepClassProblem('COSTURA', 'OUTRA')).toBeNull();
    const bad = templateSchema.safeParse({
      name: 'X',
      steps: [{ activity: 'PREPARACAO', name: 'Prep', stepClass: 'TAPECARIA' }],
    });
    expect(bad.success).toBe(false);
  });
});
