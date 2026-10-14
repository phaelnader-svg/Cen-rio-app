import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRODUCTION_TEMPLATES,
  SIMPLIFIED_PRODUCTION_TEMPLATES,
  classifyStep,
  selectProductionTemplate,
  stepAssigneeProblem,
  templateSchema,
} from '../src';

/** Simplificação Fase 5 — regras puras dos modelos simplificados (D6, D7). */
const tpl = (name: string, pieceTypes: string[], serviceTypes: string[] = [], active = true) => ({
  name,
  pieceTypes,
  serviceTypes,
  active,
});

describe('Simplificação Fase 5 — modelos simplificados', () => {
  it('reforma com 3 etapas (preparação + tapeçaria + tapeçaria) e cabeceira com 2', () => {
    const [reforma, cabeceira] = SIMPLIFIED_PRODUCTION_TEMPLATES;
    expect(reforma!.steps.map((s) => classifyStep(s.activity, s.role))).toEqual([
      'PREPARACAO',
      'TAPECARIA',
      'TAPECARIA',
    ]);
    expect(reforma!.steps[2]!.dependsOn).toEqual([1, 2]);
    expect(cabeceira!.steps.map((s) => classifyStep(s.activity, s.role))).toEqual([
      'PREPARACAO',
      'TAPECARIA',
    ]);
    expect(cabeceira!.steps[1]!.dependsOn).toEqual([1]);
    // Registros novos: ids próprios, nenhum nome repetido com os modelos antigos (D6).
    const legacy = new Set(DEFAULT_PRODUCTION_TEMPLATES.map((t) => t.name));
    expect(SIMPLIFIED_PRODUCTION_TEMPLATES.every((t) => !legacy.has(t.name))).toBe(true);
    // Mesmas regras de validação do cadastro de modelos.
    for (const t of SIMPLIFIED_PRODUCTION_TEMPLATES)
      expect(
        templateSchema.safeParse({
          name: t.name,
          pieceTypes: t.pieceTypes,
          serviceTypes: t.serviceTypes,
          steps: t.steps,
        }).success,
      ).toBe(true);
  });

  it('seleção: específico do serviço > geral (comportamento anterior) > nenhum', () => {
    const geralSofa = tpl('Reforma de sofá', ['SOFA', 'CANTO_ALEMAO']);
    const reforma = tpl('Reforma (simplificado)', ['SOFA', 'CANTO_ALEMAO'], ['REFORMA_COMPLETA']);
    const geralCab = tpl('Cabeceira', ['CABECEIRA']);
    const fabCab = tpl('Cabeceira (simplificado)', ['CABECEIRA'], ['FABRICACAO']);
    const all = [geralSofa, geralCab, reforma, fabCab]; // ordem de criação: antigos primeiro
    const pick = (pieceType: string, serviceType: string) =>
      selectProductionTemplate(all, { pieceType, serviceType })?.name ?? null;
    expect(pick('SOFA', 'REFORMA_COMPLETA')).toBe(reforma.name);
    expect(pick('CANTO_ALEMAO', 'REFORMA_COMPLETA')).toBe(reforma.name);
    expect(pick('SOFA', 'TROCA_DE_TECIDO')).toBe(geralSofa.name); // fallback
    expect(pick('CABECEIRA', 'FABRICACAO')).toBe(fabCab.name);
    expect(pick('CABECEIRA', 'REPARO')).toBe(geralCab.name); // fallback
    expect(pick('POLTRONA', 'REFORMA_COMPLETA')).toBeNull(); // nenhum modelo para a peça
  });

  it('modelo inativo nunca é escolhido; específico de outro serviço também não', () => {
    const reformaInativa = tpl('R', ['SOFA'], ['REFORMA_COMPLETA'], false);
    const geral = tpl('G', ['SOFA']);
    expect(
      selectProductionTemplate([reformaInativa, geral], {
        pieceType: 'SOFA',
        serviceType: 'REFORMA_COMPLETA',
      })?.name,
    ).toBe('G');
    expect(
      selectProductionTemplate([tpl('G', ['SOFA'], [], false), reformaInativa], {
        pieceType: 'SOFA',
        serviceType: 'REFORMA_COMPLETA',
      }),
    ).toBeNull();
    expect(
      selectProductionTemplate([tpl('F', ['SOFA'], ['FABRICACAO'])], {
        pieceType: 'SOFA',
        serviceType: 'REFORMA_COMPLETA',
      }),
    ).toBeNull();
    // Empate: o mais antigo (ordem recebida).
    expect(
      selectProductionTemplate([tpl('A', ['SOFA'], ['REPARO']), tpl('B', ['SOFA'], ['REPARO'])], {
        pieceType: 'SOFA',
        serviceType: 'REPARO',
      })?.name,
    ).toBe('A');
  });

  it('responsável padrão por etapa: nunca em tapeçaria (titular da peça)', () => {
    expect(stepAssigneeProblem('TAPECARIA')).toMatch(/titular/);
    expect(stepAssigneeProblem('PREPARACAO')).toBeNull();
    expect(stepAssigneeProblem('OUTRA')).toBeNull();
    const id = '00000000-0000-4000-8000-000000000001';
    const base = { name: 'Modelo', pieceTypes: ['CABECEIRA'] };
    expect(
      templateSchema.safeParse({
        ...base,
        steps: [
          {
            activity: 'REVESTIMENTO',
            name: 'Tapeçaria',
            role: 'PRINCIPAL',
            stepClass: 'TAPECARIA',
            defaultAssigneeUserId: id,
          },
        ],
      }).success,
    ).toBe(false);
    const ok = templateSchema.parse({
      ...base,
      serviceTypes: ['FABRICACAO'],
      steps: [
        {
          activity: 'PREPARACAO_MDF',
          name: 'Corte e preparação',
          stepClass: 'PREPARACAO',
          defaultAssigneeUserId: id,
        },
      ],
    });
    expect(ok.serviceTypes).toEqual(['FABRICACAO']);
    expect(ok.steps[0]!.defaultAssigneeUserId).toBe(id);
    // Sem os campos novos: modelo geral, sem responsável próprio (compatível com o anterior).
    const legacy = templateSchema.parse({
      ...base,
      steps: [{ activity: 'PREPARACAO', name: 'Preparação' }],
    });
    expect(legacy.serviceTypes).toEqual([]);
    expect(legacy.steps[0]!.defaultAssigneeUserId).toBeNull();
    expect(
      templateSchema.safeParse({ ...base, serviceTypes: ['INEXISTENTE'], steps: legacy.steps })
        .success,
    ).toBe(false);
  });
});
