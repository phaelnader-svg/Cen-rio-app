/**
 * Fase 9 — ocorrências (impedimentos), central de atenção e delegação de soluções.
 * Regras determinísticas e auditáveis.
 */
import { formatNumber } from './domain';

export const issueCode = (n: number) => formatNumber('OC', n);

export const ISSUE_KINDS = ['MATERIAL', 'TECNICO', 'OUTRO'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  MATERIAL: 'Falta material',
  TECNICO: 'Problema técnico',
  OUTRO: 'Outro impedimento',
};

/** Impacto informado por quem registra. */
export const ISSUE_IMPACTS = ['IMPEDIDO', 'DIFICULDADE', 'OUTRA_ATIVIDADE'] as const;
export type IssueImpact = (typeof ISSUE_IMPACTS)[number];
export const ISSUE_IMPACT_LABEL: Record<IssueImpact, string> = {
  IMPEDIDO: 'Impedido de continuar',
  DIFICULDADE: 'Consegue continuar com dificuldade',
  OUTRA_ATIVIDADE: 'Consegue executar outra atividade',
};
/** Bloqueio total ou "faz outra atividade" impedem a tarefa; dificuldade a mantém ativa. */
export const blocksTaskFor = (impact: IssueImpact) => impact !== 'DIFICULDADE';

export const ISSUE_STATUSES = [
  'ABERTA',
  'ATRIBUIDA',
  'EM_RESOLUCAO',
  'AGUARDANDO_VERIFICACAO',
  'RESOLVIDA',
  'CANCELADA',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  ABERTA: 'Aberta',
  ATRIBUIDA: 'Atribuída',
  EM_RESOLUCAO: 'Em resolução',
  AGUARDANDO_VERIFICACAO: 'Aguardando verificação',
  RESOLVIDA: 'Resolvida',
  CANCELADA: 'Cancelada',
};
export const ISSUE_OPEN: readonly IssueStatus[] = [
  'ABERTA',
  'ATRIBUIDA',
  'EM_RESOLUCAO',
  'AGUARDANDO_VERIFICACAO',
];

/** Transições válidas (validadas na API e documentadas). */
export const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  ABERTA: ['ATRIBUIDA', 'AGUARDANDO_VERIFICACAO', 'CANCELADA'],
  ATRIBUIDA: ['ATRIBUIDA', 'EM_RESOLUCAO', 'AGUARDANDO_VERIFICACAO', 'ABERTA', 'CANCELADA'],
  EM_RESOLUCAO: ['ATRIBUIDA', 'AGUARDANDO_VERIFICACAO', 'ABERTA', 'CANCELADA'],
  AGUARDANDO_VERIFICACAO: ['RESOLVIDA', 'ABERTA', 'ATRIBUIDA', 'CANCELADA'],
  RESOLVIDA: ['ABERTA'],
  CANCELADA: ['ABERTA'],
};
export const canTransition = (from: IssueStatus, to: IssueStatus) =>
  ISSUE_TRANSITIONS[from].includes(to);

/** Prioridade inicial: bloqueio total → alta; tarefa urgente → urgente. */
export function initialIssuePriority(
  impact: IssueImpact,
  taskPriority: string,
): 'BAIXA' | 'NORMAL' | 'ALTA' | 'URGENTE' {
  if (taskPriority === 'URGENTE' && impact !== 'DIFICULDADE') return 'URGENTE';
  return impact === 'DIFICULDADE' ? 'NORMAL' : 'ALTA';
}

// ─────────────────────────── Central de atenção ───────────────────────────

export const ATTENTION_CATEGORIES = ['CRITICO', 'ATENCAO', 'ACAO', 'INFO'] as const;
export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number];
export const ATTENTION_CATEGORY_LABEL: Record<AttentionCategory, string> = {
  CRITICO: 'Crítico',
  ATENCAO: 'Atenção',
  ACAO: 'Ação necessária',
  INFO: 'Informativo',
};

export const ATTENTION_TYPES = [
  'OCORRENCIA',
  'AJUDA',
  'PROPOSTA',
  'PRESENCA',
  'IMPEDIMENTO',
  'PRAZO',
  'QUALIDADE',
  'LOGISTICA',
  'RASCUNHO_ANTIGO',
  'PRAZO_OS',
  'PRAZO_PEDIDO',
  'COBRANCA',
  'FINANCEIRO',
  'MATERIAL',
  'PLANEJAMENTO',
  'RECEBIMENTO',
] as const;
export type AttentionType = (typeof ATTENTION_TYPES)[number];
/**
 * Rodada 3 (F10-18): permissão do PRÓPRIO domínio exigida por tipo de item da Central, além do
 * acesso à Central (`ocorrencias.ver`/`ocorrencias.gerenciar`). Basta uma da lista. Ocorrência é o
 * domínio da própria Central; COBRANCA, FINANCEIRO e MATERIAL têm regra própria na origem (mais
 * fina, por cartão) e ficam aqui só como piso.
 */
export const ATTENTION_TYPE_PERMISSIONS: Record<AttentionType, readonly string[]> = {
  OCORRENCIA: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
  AJUDA: ['producao.planejar'],
  PROPOSTA: ['producao.planejar'],
  PRESENCA: ['presenca.ver', 'presenca.gerenciar'],
  IMPEDIMENTO: ['producao.ver', 'producao.planejar'],
  PRAZO: ['producao.ver', 'producao.planejar'],
  QUALIDADE: ['qualidade.gerenciar', 'qualidade.inspecionar'],
  LOGISTICA: ['entregas.ver', 'entregas.gerenciar', 'retiradas.ver', 'retiradas.gerenciar'],
  RASCUNHO_ANTIGO: ['producao.planejar'],
  PRAZO_OS: ['os.ver', 'producao.ver', 'producao.planejar'],
  PRAZO_PEDIDO: ['pedidos.ver', 'recebimentos.registrar', 'retiradas.ver'],
  COBRANCA: ['financeiro.ver'],
  FINANCEIRO: ['financeiro.ver'],
  MATERIAL: [
    'compras.ver',
    'compras.gerenciar',
    'compras.aprovar',
    'materiais.aprovar',
    'estoque.ver',
    'estoque.gerenciar',
    'estoque.conferir',
  ],
  PLANEJAMENTO: ['producao.planejar', 'producao.ver'],
  RECEBIMENTO: ['pedidos.ver', 'recebimentos.registrar', 'os.ver'],
};
export const ATTENTION_TYPE_LABEL: Record<AttentionType, string> = {
  OCORRENCIA: 'Ocorrência',
  AJUDA: 'Pedido de ajuda',
  PROPOSTA: 'Reprogramação',
  PRESENCA: 'Presença',
  IMPEDIMENTO: 'Pausa por impedimento',
  PRAZO: 'Prazo interno da tarefa',
  QUALIDADE: 'Qualidade e embalagem',
  LOGISTICA: 'Entregas e logística',
  RASCUNHO_ANTIGO: 'Rascunho de semana passada',
  PRAZO_OS: 'Prazo da OS',
  PRAZO_PEDIDO: 'Prazo do pedido (peças não recebidas)',
  COBRANCA: 'Cobrança do cliente',
  FINANCEIRO: 'Decisão financeira (negociação/revisão)',
  MATERIAL: 'Materiais e compras',
  PLANEJAMENTO: 'Serviços a planejar',
  RECEBIMENTO: 'Divergência no recebimento de peças',
};

/**
 * Categoria de uma ocorrência (regra única, usada na central e nos testes):
 * - crítico: impede a tarefa e há risco de prazo (prazo interno hoje/vencido, entrega ao cliente
 *   em até 2 dias, tarefa urgente) ou o prazo de resolução venceu;
 * - ação necessária: aberta (falta delegar) ou aguardando verificação do gestor;
 * - atenção: em andamento e impede a tarefa (ou com dificuldade e risco de prazo);
 * - informativo: em andamento sem bloqueio, ou resolvida/cancelada nas últimas 24 h.
 */
export function issueCategory(i: {
  status: IssueStatus;
  blocksTask: boolean;
  deadlineRisk: boolean;
  resolutionOverdue: boolean;
}): AttentionCategory {
  if (i.status === 'RESOLVIDA' || i.status === 'CANCELADA') return 'INFO';
  if (i.resolutionOverdue || (i.blocksTask && i.deadlineRisk)) return 'CRITICO';
  if (i.status === 'ABERTA' || i.status === 'AGUARDANDO_VERIFICACAO') return 'ACAO';
  if (i.blocksTask || i.deadlineRisk) return 'ATENCAO';
  return 'INFO';
}
export const CATEGORY_ORDER: Record<AttentionCategory, number> = {
  CRITICO: 0,
  ACAO: 1,
  ATENCAO: 2,
  INFO: 3,
};
