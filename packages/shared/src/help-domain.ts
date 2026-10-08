/**
 * Fase 8 — solicitações de ajuda, distribuição de ajudantes e reprogramação.
 * Regras determinísticas e auditáveis (sem IA generativa): cada decisão grava os
 * candidatos avaliados, os motivos de exclusão e a pontuação usada.
 */
import { formatNumber } from './domain';

export const helpRequestCode = (n: number) => formatNumber('AJ', n);
export const proposalCode = (n: number) => formatNumber('RP', n);

/** Tipos de apoio pedidos pelo tapeceiro. */
export const HELP_KINDS = [
  'PARAFUSAR',
  'MOVIMENTAR',
  'AUXILIAR_MONTAGEM',
  'POSICIONAR',
  'OUTRO',
] as const;
export type HelpKind = (typeof HELP_KINDS)[number];
export const HELP_KIND_LABEL: Record<HelpKind, string> = {
  PARAFUSAR: 'Parafusar estrutura',
  MOVIMENTAR: 'Movimentar sofá',
  AUXILIAR_MONTAGEM: 'Auxiliar montagem',
  POSICIONAR: 'Virar ou posicionar peça',
  OUTRO: 'Outro apoio',
};
/** Duração sugerida (min) — ajustável na solicitação. */
export const HELP_KIND_MINUTES: Record<HelpKind, number> = {
  PARAFUSAR: 20,
  MOVIMENTAR: 10,
  AUXILIAR_MONTAGEM: 30,
  POSICIONAR: 10,
  OUTRO: 15,
};

/** Competências cadastradas pelo gestor. */
export const SKILLS = [
  'PARAFUSAR',
  'MOVIMENTAR',
  'AUXILIAR_MONTAGEM',
  'POSICIONAR',
  'APOIO_GERAL',
  'DESMONTAGEM',
  'PREPARACAO',
  'CABECEIRA',
  'REPARO',
  'INSTALACAO',
  'INSPECAO',
  'CORTE_COSTURA',
] as const;
export type Skill = (typeof SKILLS)[number];
export const SKILL_LABEL: Record<Skill, string> = {
  PARAFUSAR: 'Parafusar estrutura',
  MOVIMENTAR: 'Movimentar peças',
  AUXILIAR_MONTAGEM: 'Auxiliar montagem',
  POSICIONAR: 'Virar/posicionar peças',
  APOIO_GERAL: 'Apoio geral',
  DESMONTAGEM: 'Desmontagem',
  PREPARACAO: 'Preparação',
  CABECEIRA: 'Cabeceiras',
  REPARO: 'Reparos',
  INSTALACAO: 'Instalações',
  INSPECAO: 'Inspeção (futura)',
  CORTE_COSTURA: 'Corte e costura (tapeceiro)',
};
/** Competência exigida por tipo de apoio. */
export const HELP_KIND_SKILL: Record<HelpKind, Skill> = {
  PARAFUSAR: 'PARAFUSAR',
  MOVIMENTAR: 'MOVIMENTAR',
  AUXILIAR_MONTAGEM: 'AUXILIAR_MONTAGEM',
  POSICIONAR: 'POSICIONAR',
  OUTRO: 'APOIO_GERAL',
};
/** Competências iniciais por função (seed e migration; depois o gestor ajusta). */
const HELPER_SKILLS: readonly Skill[] = [
  'PARAFUSAR',
  'MOVIMENTAR',
  'AUXILIAR_MONTAGEM',
  'POSICIONAR',
  'APOIO_GERAL',
  'DESMONTAGEM',
  'PREPARACAO',
];
export const DEFAULT_ROLE_SKILLS: Readonly<Record<string, readonly Skill[]>> = {
  ajudante: HELPER_SKILLS,
  cabeceiras_qualidade: [...HELPER_SKILLS, 'CABECEIRA', 'REPARO', 'INSTALACAO', 'INSPECAO'],
  tapeceiro: ['CORTE_COSTURA'],
};
/** Especialidades preservadas: quem as tem é a segunda opção para apoio geral. */
export const SPECIALTY_SKILLS: readonly Skill[] = ['CABECEIRA', 'REPARO', 'INSPECAO'];

export const HELP_STATUSES = [
  'PENDENTE',
  'ATRIBUIDA',
  'EM_EXECUCAO',
  'CONCLUIDA',
  'CANCELADA',
  'ESCALADA',
] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];
export const HELP_STATUS_LABEL: Record<HelpStatus, string> = {
  PENDENTE: 'Aguardando ajudante',
  ATRIBUIDA: 'Ajudante a caminho',
  EM_EXECUCAO: 'Apoio em execução',
  CONCLUIDA: 'Apoio concluído',
  CANCELADA: 'Cancelada',
  ESCALADA: 'Encaminhada ao gestor',
};
export const HELP_OPEN: readonly HelpStatus[] = [
  'PENDENTE',
  'ATRIBUIDA',
  'EM_EXECUCAO',
  'ESCALADA',
];

/** Motivos de exclusão de um candidato (registrados na avaliação). */
export const CANDIDATE_REASONS = {
  SEM_COMPETENCIA: 'Sem a competência exigida',
  NAO_CONFIRMOU: 'Não confirmou chegada',
  AUSENTE: 'Ausente',
  EXTERNO: 'Em atividade externa',
  ENCERRADO: 'Expediente encerrado',
  OCUPADO: 'Com tarefa em execução',
  OCUPADO_CRITICO: 'Com tarefa importante em execução',
  CONFLITO_AGENDA: 'Tarefa prioritária programada ou urgente aguardando',
} as const;
export type CandidateReason = keyof typeof CANDIDATE_REASONS;

export interface CandidateEvaluation {
  userId: string;
  name: string;
  eligible: boolean;
  reasons: CandidateReason[];
  score: number;
  notes: string[];
}

/**
 * Pontuação de impacto (menor = melhor). Determinística:
 * +10 se o candidato tem especialidade preservada (cabeceiras/reparos/inspeção) — para
 *     apoio geral, em condições iguais, João é preferido e Thiago fica preservado;
 * +5 por tarefa própria programada dentro da janela do apoio;
 * +3 se tem tarefa liberada esperando (vai atrasá-la um pouco);
 * +2 por tarefa própria pausada (deveria retomá-la).
 * Empate: ordem alfabética do nome.
 */
export function scoreCandidate(i: {
  specialty: boolean;
  tasksInWindow: number;
  releasedWaiting: number;
  paused?: number;
}): number {
  return (
    (i.specialty ? 10 : 0) +
    i.tasksInWindow * 5 +
    (i.releasedWaiting > 0 ? 3 : 0) +
    (i.paused ?? 0) * 2
  );
}

export function pickCandidate(list: CandidateEvaluation[]): CandidateEvaluation | null {
  const ok = list
    .filter((c) => c.eligible)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'pt-BR'));
  return ok[0] ?? null;
}

// ─────────────────────────── Reprogramação ───────────────────────────

export const PROPOSAL_KINDS = ['AUSENCIA', 'BLOQUEIO', 'AJUDA_URGENTE', 'CONFLITO'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_KIND_LABEL: Record<ProposalKind, string> = {
  AUSENCIA: 'Ausência',
  BLOQUEIO: 'Tarefa bloqueada',
  AJUDA_URGENTE: 'Ajuda urgente',
  CONFLITO: 'Conflito de programação',
};
export const PROPOSAL_STATUSES = [
  'PENDENTE',
  'APROVADA',
  'AJUSTADA',
  'REJEITADA',
  'OBSOLETA',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  PENDENTE: 'Aguardando decisão',
  APROVADA: 'Aprovada',
  AJUSTADA: 'Aprovada com ajuste',
  REJEITADA: 'Rejeitada',
  OBSOLETA: 'Sem efeito',
};

export const PROPOSAL_ACTIONS = [
  'REASSIGN',
  'RESCHEDULE',
  'CHANGE_PRINCIPAL',
  'INTERRUPT_FOR_HELP',
  'KEEP',
] as const;
export type ProposalActionType = (typeof PROPOSAL_ACTIONS)[number];
export interface ProposalAction {
  type: ProposalActionType;
  taskId: string;
  toUserId?: string | null;
  toDate?: string | null;
  toTime?: string | null;
  helpRequestId?: string | null;
}
export interface ProposalAlternative {
  id: string;
  title: string;
  actions: ProposalAction[];
  impacts: string[];
  critical: boolean;
  recommended: boolean;
}

/** Ações automáticas e aplicadas (histórico). */
export const PLANNING_ACTION_KINDS = [
  'AJUDA_ATRIBUIDA',
  'AJUDA_EM_ESPERA',
  'AJUDA_ESCALADA',
  'TAREFA_ANTECIPADA',
  'TAREFA_REATRIBUIDA',
  'ALTERNATIVA_SUGERIDA',
  'PROPOSTA_CRIADA',
  'PROPOSTA_APROVADA',
  'PROPOSTA_REJEITADA',
  'PROPOSTA_OBSOLETA',
  // Fase 9
  'RESOLUCAO_ATRIBUIDA',
] as const;
export type PlanningActionKind = (typeof PLANNING_ACTION_KINDS)[number];
export const PLANNING_ACTION_LABEL: Record<PlanningActionKind, string> = {
  AJUDA_ATRIBUIDA: 'Ajudante atribuído automaticamente',
  AJUDA_EM_ESPERA: 'Ajuda em espera (sem ajudante disponível)',
  AJUDA_ESCALADA: 'Ajuda encaminhada ao gestor',
  TAREFA_ANTECIPADA: 'Tarefa antecipada automaticamente',
  TAREFA_REATRIBUIDA: 'Tarefa reatribuída automaticamente',
  ALTERNATIVA_SUGERIDA: 'Tarefa alternativa sugerida',
  PROPOSTA_CRIADA: 'Reprogramação proposta ao gestor',
  PROPOSTA_APROVADA: 'Reprogramação aprovada e aplicada',
  PROPOSTA_REJEITADA: 'Reprogramação rejeitada',
  PROPOSTA_OBSOLETA: 'Proposta sem efeito',
  RESOLUCAO_ATRIBUIDA: 'Solução de ocorrência delegada',
};
