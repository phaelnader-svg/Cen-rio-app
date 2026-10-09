/**
 * Evolução, Fase 4 — "Minha semana" no tablet (funções puras, testadas isoladamente).
 *
 * Destaque: a tarefa em execução; sem ela, a primeira executável da fila (ordem do servidor,
 * nunca reordenada aqui). Próximas: até três tarefas seguintes na ordem da fila, sem repetir o
 * destaque nem inventar cartões. Sem executável: motivos agregados dos bloqueios, para orientar
 * o funcionário — nada é liberado pela tela.
 */
import type { ReleaseBlocker, TaskStatus } from './production-domain';

export interface WeekViewTask {
  id: string;
  status: TaskStatus;
  blockers: readonly ReleaseBlocker[];
  blockedReason?: string | null;
}
export interface WeekViewInput<T extends WeekViewTask> {
  current: T | null;
  next: T | null;
  items: readonly { position: number; executable: boolean; task: T }[];
}
export type WeekWaitReason = ReleaseBlocker | 'PAUSADA_COM_OCORRENCIA';

export function summarizeWeek<T extends WeekViewTask>(q: WeekViewInput<T>, max = 3) {
  const highlight = q.current ?? q.next ?? null;
  const kind: 'EM_EXECUCAO' | 'PROXIMA' | null = q.current
    ? 'EM_EXECUCAO'
    : q.next
      ? 'PROXIMA'
      : null;
  const upcoming = q.items.filter((e) => e.task.id !== highlight?.id).slice(0, Math.max(0, max));
  const reasons = new Set<WeekWaitReason>();
  if (!highlight)
    for (const e of q.items) {
      for (const b of e.task.blockers) reasons.add(b);
      if (e.task.blockedReason) reasons.add('BLOQUEIO');
      if (e.task.status === 'PAUSADA' && !e.executable) reasons.add('PAUSADA_COM_OCORRENCIA');
    }
  return {
    highlight,
    kind,
    upcoming,
    hasMore: q.items.length - (highlight ? 1 : 0) > upcoming.length,
    waitReasons: [...reasons],
  };
}

export const WEEK_WAIT_REASON_LABEL: Record<WeekWaitReason, string> = {
  OS_INATIVA: 'a OS não está ativa',
  PECA_NAO_RECEBIDA: 'a peça ainda não chegou à oficina',
  NAO_PUBLICADA: 'a programação ainda não foi publicada',
  SEM_RESPONSAVEL: 'falta definir o responsável (gestor)',
  DEPENDENCIAS: 'aguardando etapas anteriores',
  MATERIAIS: 'aguardando materiais',
  BLOQUEIO: 'bloqueada pelo gestor',
  OCORRENCIA: 'há uma ocorrência em aberto',
  PAUSADA_COM_OCORRENCIA: 'pausada até a ocorrência ser resolvida',
};

/** Paginação simples da fila completa (sem virtualização: até centenas de itens leves). */
export function pageOf<T>(items: readonly T[], page: number, size = 20) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { items: items.slice((p - 1) * size, p * size), page: p, pages };
}
