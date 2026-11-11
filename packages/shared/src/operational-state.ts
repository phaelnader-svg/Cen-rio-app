import type { TaskStatus } from './production-domain';
import type { FulfillmentStage } from './quality-domain';

/**
 * Reformulação, Fase 0 — estado operacional da peça e da OS, SÓ PARA LEITURA.
 *
 * Não é uma segunda fonte de verdade: deriva da etapa canônica gravada na peça
 * (`fulfillmentStage`, calculada por `computeStage`) e, enquanto a peça está "em produção", das
 * suas tarefas obrigatórias (o mesmo recorte de `requiredTaskWhere`). Nenhum enum muda, nada é
 * gravado e nenhuma regra de liberação, logística ou encerramento é alterada.
 *
 * Limitações explícitas (dados que ainda não existem):
 * - "Aguardando materiais" vem do bloqueio MATERIAIS das tarefas (regra atual de prontidão), não
 *   de marcações por material (Fase 1).
 * - "Entregue" só existe com entrega concluída da logística (regra atual; Fase 1).
 * - Enquanto a embalagem for obrigatória, a peça aprovada passa por EMBALAGEM antes de "pronta".
 * - Peça sem tarefa obrigatória publicada = NAO_PLANEJADA (não é presumida "pronta").
 */
export const OPERATIONAL_STATES = [
  'NAO_PLANEJADA',
  'AGUARDANDO_MATERIAIS',
  'PRODUCAO_IMPEDIDA',
  'PRONTA_PARA_PRODUCAO',
  'EM_PRODUCAO',
  'CORRECAO_NECESSARIA',
  'AGUARDANDO_QUALIDADE',
  'EMBALAGEM',
  'PRONTA_PARA_ENTREGA',
  'EM_ENTREGA',
  'ENTREGUE',
  'DEVOLVIDA',
  'CANCELADA',
] as const;
export type OperationalState = (typeof OPERATIONAL_STATES)[number];

export const OPERATIONAL_STATE_LABEL: Record<OperationalState, string> = {
  NAO_PLANEJADA: 'Não planejada',
  AGUARDANDO_MATERIAIS: 'Aguardando materiais',
  PRODUCAO_IMPEDIDA: 'Produção impedida',
  PRONTA_PARA_PRODUCAO: 'Pronta para produção',
  EM_PRODUCAO: 'Em produção',
  CORRECAO_NECESSARIA: 'Correção necessária',
  AGUARDANDO_QUALIDADE: 'Aguardando qualidade',
  EMBALAGEM: 'Embalagem',
  PRONTA_PARA_ENTREGA: 'Pronta para entrega',
  EM_ENTREGA: 'Em entrega',
  ENTREGUE: 'Entregue',
  DEVOLVIDA: 'Devolvida ao cliente',
  CANCELADA: 'Cancelada',
};

/** Ordem de avanço: a OS mostra a peça ativa MENOS avançada. */
const RANK: Record<OperationalState, number> = {
  NAO_PLANEJADA: 0,
  AGUARDANDO_MATERIAIS: 1,
  PRODUCAO_IMPEDIDA: 1,
  PRONTA_PARA_PRODUCAO: 2,
  EM_PRODUCAO: 3,
  CORRECAO_NECESSARIA: 4,
  AGUARDANDO_QUALIDADE: 5,
  EMBALAGEM: 6,
  PRONTA_PARA_ENTREGA: 7,
  EM_ENTREGA: 8,
  ENTREGUE: 9,
  DEVOLVIDA: 9,
  CANCELADA: 9,
};
const TERMINAL: readonly OperationalState[] = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];

/** Detalhes que acompanham o estado (nunca mudam o estado: só explicam). */
export type OperationalReason =
  | 'SEM_TAREFAS'
  | 'SO_RASCUNHO'
  | 'PAUSADA'
  | 'ENTRE_ETAPAS'
  | 'PROGRAMADA'
  | 'BLOQUEIO_EXPEDICAO'
  | 'ENTREGA_AGENDADA'
  | `BLOQUEIO:${string}`;

export interface OperationalTaskInput {
  status: TaskStatus;
  blockers: readonly string[];
}

export interface OperationalItemInput {
  /** Etapa gravada da peça (fonte canônica). */
  stage: FulfillmentStage;
  /** Tarefas obrigatórias da peça (recorte de `requiredTaskWhere`), incluindo rascunhos. */
  tasks: readonly OperationalTaskInput[];
}

export interface OperationalItemState {
  state: OperationalState;
  reasons: OperationalReason[];
}

const OPEN_WAITING: readonly TaskStatus[] = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];

function productionState(tasks: readonly OperationalTaskInput[]): OperationalItemState {
  const live = tasks.filter((t) => t.status !== 'CANCELADA');
  const published = live.filter((t) => t.status !== 'RASCUNHO');
  if (!published.length)
    return { state: 'NAO_PLANEJADA', reasons: [live.length ? 'SO_RASCUNHO' : 'SEM_TAREFAS'] };
  const has = (s: TaskStatus) => published.some((t) => t.status === s);
  const waiting = published.filter((t) => OPEN_WAITING.includes(t.status));
  const blockers = [...new Set(waiting.flatMap((t) => t.blockers))].sort();
  const blockReasons = blockers.map((b) => `BLOQUEIO:${b}` as const);
  if (has('EM_EXECUCAO')) return { state: 'EM_PRODUCAO', reasons: [] };
  if (has('PAUSADA')) return { state: 'EM_PRODUCAO', reasons: ['PAUSADA'] };
  // Nada liberado e alguma etapa parada por material: é isso que segura a peça.
  if (!has('LIBERADA') && waiting.some((t) => t.blockers.includes('MATERIAIS')))
    return { state: 'AGUARDANDO_MATERIAIS', reasons: blockReasons };
  // Já houve etapa concluída: a peça está em produção, entre uma etapa e outra.
  if (has('CONCLUIDA')) return { state: 'EM_PRODUCAO', reasons: ['ENTRE_ETAPAS', ...blockReasons] };
  if (has('LIBERADA')) return { state: 'PRONTA_PARA_PRODUCAO', reasons: [] };
  // PROGRAMADA = sem impedimento, só aguarda o horário (as etapas seguintes esperam por ela).
  if (has('PROGRAMADA')) return { state: 'PRONTA_PARA_PRODUCAO', reasons: ['PROGRAMADA'] };
  // Só esperando: etapa anterior, publicação, responsável, ocorrência ou bloqueio do gestor.
  return { state: 'PRODUCAO_IMPEDIDA', reasons: blockReasons };
}

export function operationalItemState(i: OperationalItemInput): OperationalItemState {
  switch (i.stage) {
    case 'EM_PRODUCAO':
      return productionState(i.tasks);
    case 'AGUARDANDO_INSPECAO':
    case 'EM_INSPECAO':
      return { state: 'AGUARDANDO_QUALIDADE', reasons: [] };
    case 'EM_CORRECAO':
      return { state: 'CORRECAO_NECESSARIA', reasons: [] };
    case 'AGUARDANDO_EMBALAGEM':
    case 'EM_EMBALAGEM':
      return { state: 'EMBALAGEM', reasons: [] };
    case 'BLOQUEIO_EXPEDICAO':
      return { state: 'PRONTA_PARA_ENTREGA', reasons: ['BLOQUEIO_EXPEDICAO'] };
    case 'PRONTA_ENTREGA':
      return { state: 'PRONTA_PARA_ENTREGA', reasons: [] };
    case 'ENTREGA_AGENDADA':
      return { state: 'PRONTA_PARA_ENTREGA', reasons: ['ENTREGA_AGENDADA'] };
    case 'EM_TRANSPORTE':
      return { state: 'EM_ENTREGA', reasons: [] };
    case 'ENTREGUE':
      return { state: 'ENTREGUE', reasons: [] };
    case 'DEVOLVIDA':
      return { state: 'DEVOLVIDA', reasons: [] };
    case 'CANCELADA':
      return { state: 'CANCELADA', reasons: [] };
  }
}

export interface OperationalOrderState {
  state: OperationalState;
  /** Quantas peças em cada estado (só os presentes). */
  counts: Partial<Record<OperationalState, number>>;
  /** Peças ainda em andamento (fora de entregue/devolvida/cancelada). */
  activeItems: number;
  totalItems: number;
}

/**
 * Estado da OS: a peça ativa menos avançada. Sem peças ativas, o desfecho final — entregue se
 * alguma peça foi entregue; senão devolvida; senão cancelada. OS cancelada é sempre cancelada.
 */
export function operationalOrderState(
  items: readonly OperationalItemState[],
  orderCancelled = false,
): OperationalOrderState {
  const counts: Partial<Record<OperationalState, number>> = {};
  for (const i of items) counts[i.state] = (counts[i.state] ?? 0) + 1;
  const active = items.filter((i) => !TERMINAL.includes(i.state));
  const base = { counts, activeItems: active.length, totalItems: items.length };
  if (orderCancelled) return { state: 'CANCELADA', ...base };
  if (active.length) {
    const least = active.reduce((a, b) => (RANK[b.state] < RANK[a.state] ? b : a));
    return { state: least.state, ...base };
  }
  if (counts.ENTREGUE) return { state: 'ENTREGUE', ...base };
  if (counts.DEVOLVIDA) return { state: 'DEVOLVIDA', ...base };
  return { state: items.length ? 'CANCELADA' : 'NAO_PLANEJADA', ...base };
}

export interface OperationalStateDto extends OperationalOrderState {
  serviceOrderId: string;
  items: ({ serviceOrderItemId: string; stage: FulfillmentStage } & OperationalItemState)[];
}
