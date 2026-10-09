/**
 * Evolução, Fase 3 — distribuição automática de tarefas por OS e peça (funções puras).
 *
 * Cada etapa de modelo tem uma CLASSE explícita (não inferida do nome livre):
 * - PREPARACAO: desmontagem e preparação (responsável padrão configurável: ajudante);
 * - TAPECARIA: corte, costura, revestimento, montagem e acabamento — sempre do tapeceiro
 *   titular da peça (um por peça; nunca dividido automaticamente);
 * - OUTRA: atividades gerais (sem responsável automático: o gestor define).
 * A inspeção não é etapa de modelo: segue o módulo de qualidade (inspetor padrão + segregação).
 */
import type { ProductionActivity, TaskRole } from './production-domain';

/** Versão da tabela de classificação abaixo (registrada no relatório e nos testes). */
export const STEP_CLASSIFICATION_VERSION = 1;

export const STEP_CLASSES = ['PREPARACAO', 'TAPECARIA', 'OUTRA'] as const;
export type StepClass = (typeof STEP_CLASSES)[number];
export const STEP_CLASS_LABEL: Record<StepClass, string> = {
  PREPARACAO: 'Preparação/desmontagem',
  TAPECARIA: 'Tapeçaria (titular da peça)',
  OUTRA: 'Outra (gestor define)',
};

/** Classe natural de cada atividade programável (correção/embalagem nascem da qualidade). */
export const ACTIVITY_STEP_CLASS: Partial<Record<ProductionActivity, StepClass>> = {
  DESMONTAGEM: 'PREPARACAO',
  PREPARACAO: 'PREPARACAO',
  PREPARACAO_MDF: 'PREPARACAO',
  CORTE_ESPUMA: 'PREPARACAO',
  CORTE_TECIDO: 'TAPECARIA',
  CORTE: 'TAPECARIA',
  COSTURA: 'TAPECARIA',
  REVESTIMENTO: 'TAPECARIA',
  MONTAGEM: 'TAPECARIA',
  ACABAMENTO: 'TAPECARIA',
  APOIO: 'OUTRA',
  OUTRA: 'OUTRA',
};
/** Papel da tarefa implicado pela classe (tapeçaria é do responsável principal). */
export const STEP_CLASS_ROLE: Record<StepClass, TaskRole> = {
  PREPARACAO: 'APOIO',
  TAPECARIA: 'PRINCIPAL',
  OUTRA: 'APOIO',
};

/**
 * Classificação automática SÓ quando atividade e papel concordam (mesma regra da migration).
 * Qualquer combinação ambígua devolve null: a etapa fica pendente de revisão do gestor.
 */
export function classifyStep(activity: ProductionActivity, role: TaskRole): StepClass | null {
  const c = ACTIVITY_STEP_CLASS[activity];
  return c && STEP_CLASS_ROLE[c] === role ? c : null;
}

/** Classe informada explicitamente pelo gestor: precisa ser compatível com a atividade. */
export function stepClassProblem(
  activity: ProductionActivity,
  stepClass: StepClass,
): string | null {
  const natural = ACTIVITY_STEP_CLASS[activity];
  if (!natural) return 'Esta atividade não entra em modelos.';
  // OUTRA aceita qualquer atividade (o gestor decide quem faz); as demais exigem a natural.
  if (stepClass !== 'OUTRA' && stepClass !== natural)
    return `A classe "${STEP_CLASS_LABEL[stepClass]}" não combina com a atividade.`;
  return null;
}

export const DISTRIBUTION_PENDENCIES = [
  'SEM_MODELO',
  'SEM_TITULAR',
  'TITULAR_INELEGIVEL',
  'SEM_RESPONSAVEL_PADRAO',
  'ETAPA_SEM_CLASSIFICACAO',
  'MODELO_ALTERADO',
  'JA_GERADA_EM_OUTRA_SEMANA',
  'SEM_INSPETOR',
  'REVISAO_FINANCEIRA',
] as const;
export type DistributionPendency = (typeof DISTRIBUTION_PENDENCIES)[number];
export const DISTRIBUTION_PENDENCY_LABEL: Record<DistributionPendency, string> = {
  SEM_MODELO: 'Nenhum modelo ativo para este tipo de peça',
  SEM_TITULAR: 'Peça sem tapeceiro titular definido',
  TITULAR_INELEGIVEL: 'Titular inativo ou sem permissão de produção',
  SEM_RESPONSAVEL_PADRAO: 'Sem responsável padrão elegível para a preparação',
  ETAPA_SEM_CLASSIFICACAO: 'Etapa do modelo sem classificação (revise o modelo)',
  MODELO_ALTERADO: 'Modelo alterado depois da geração (revisão manual)',
  JA_GERADA_EM_OUTRA_SEMANA: 'Tarefas desta peça já geradas em outra semana',
  SEM_INSPETOR: 'Sem inspetor elegível (a qualidade pedirá substituto)',
  REVISAO_FINANCEIRA: 'Mão de obra combinada com outra pessoa: revisão financeira manual',
};

export const OWNER_CHANGE_KINDS = ['DEFINICAO', 'SUBSTITUICAO'] as const;
export type OwnerChangeKind = (typeof OWNER_CHANGE_KINDS)[number];
