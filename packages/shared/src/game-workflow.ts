/**
 * Situação de uma peça no jogo, separando o que o sistema mistura num rótulo só:
 * estado geral da OS, etapa atual (só "Em execução" quando o funcionário iniciou no tablet),
 * próxima etapa (disponível ou bloqueada, com o motivo e os nomes), situação dos materiais,
 * última posição física confirmada e a próxima ação para quem gerencia.
 * Função pura sobre os dados do retrato (mesmas regras oficiais: liberação, dependências).
 */
import { MATERIAL_READINESS_LABEL, type MaterialReadiness } from './purchasing-domain';
import { RELEASE_BLOCKER_LABEL, type ReleaseBlocker } from './production-domain';
import { FULFILLMENT_STAGE_LABEL, type FulfillmentStage } from './quality-domain';
import { ACTIVITY_LABEL_GAME } from './game-domain';
import type { GamePieceDto, GameTaskRef } from './types-game';

export type PiecePhase =
  | 'AGUARDANDO_PLANEJAMENTO'
  | 'AGUARDANDO_PUBLICACAO'
  | 'NA_FILA'
  | 'BLOQUEADA'
  | 'EM_EXECUCAO'
  | 'PAUSADA'
  | 'ENTRE_ETAPAS'
  | 'QUALIDADE'
  | 'EMBALAGEM'
  | 'PRONTA_ENTREGA'
  | 'EM_ENTREGA';

export const PHASE_INFO: Record<
  PiecePhase,
  { label: string; icon: string; tone: 'ok' | 'atencao' | 'risco' | 'info' }
> = {
  AGUARDANDO_PLANEJAMENTO: { label: 'Aguardando planejamento', icon: '🗓️', tone: 'atencao' },
  AGUARDANDO_PUBLICACAO: {
    label: 'Planejada (rascunho, não publicada)',
    icon: '📝',
    tone: 'atencao',
  },
  NA_FILA: { label: 'Na fila', icon: '⏳', tone: 'info' },
  BLOQUEADA: { label: 'Parada (bloqueada)', icon: '⛔', tone: 'risco' },
  EM_EXECUCAO: { label: 'Em execução', icon: '▶️', tone: 'ok' },
  PAUSADA: { label: 'Pausada', icon: '⏸️', tone: 'atencao' },
  ENTRE_ETAPAS: { label: 'Aguardando etapa seguinte', icon: '⏳', tone: 'info' },
  QUALIDADE: { label: 'Qualidade', icon: '🔍', tone: 'info' },
  EMBALAGEM: { label: 'Embalagem', icon: '📦', tone: 'info' },
  PRONTA_ENTREGA: { label: 'Pronta para entrega', icon: '🚚', tone: 'ok' },
  EM_ENTREGA: { label: 'Em entrega', icon: '🚚', tone: 'info' },
};

export interface WorkflowStep {
  taskId: string;
  activity: string;
  label: string;
  assignee: string | null;
  status: string;
  /** Pode ser iniciada agora no tablet pelo responsável. */
  available: boolean;
  /** Motivo, em português, quando não está disponível. */
  reason: string | null;
  startedAt: string | null;
}

export interface PieceWorkflow {
  phase: PiecePhase;
  phaseLabel: string;
  icon: string;
  tone: 'ok' | 'atencao' | 'risco' | 'info';
  /** Estado geral da OS (da peça) no fluxo oficial. */
  general: string;
  current: WorkflowStep | null;
  /** Todas as etapas iniciadas no tablet (etapas paralelas, ex.: desmanche e corte). */
  running: WorkflowStep[];
  next: WorkflowStep | null;
  steps: WorkflowStep[];
  blockedReason: string | null;
  material: { readiness: string; label: string };
  responsible: string | null;
}

const actLabel = (a: string) => ACTIVITY_LABEL_GAME[a] ?? a;
/** Nome oficial da etapa (o mesmo do tablet), sem o código da peça. */
const stepName = (t: GameTaskRef) =>
  t.title.replace(/\s+—\s+OS-[\d/]+$/, '').trim() || actLabel(t.activity);
const ddmm = (iso: string | null) =>
  iso ? iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '';

function stepOf(t: GameTaskRef, all: GameTaskRef[]): WorkflowStep {
  const pendingDeps = t.dependsOn
    .map((id) => all.find((x) => x.id === id))
    .filter(
      (d): d is GameTaskRef => Boolean(d) && d!.status !== 'CONCLUIDA' && d!.status !== 'CANCELADA',
    );
  const reasons = (t.blockers as ReleaseBlocker[]).map((b) =>
    b === 'DEPENDENCIAS' && pendingDeps.length
      ? `aguarda ${pendingDeps.map((d) => `${stepName(d).toLowerCase()} (${d.assigneeName ?? 'sem responsável'})`).join(' e ')}`
      : (RELEASE_BLOCKER_LABEL[b] ?? b).replace(/^./, (c) => c.toLowerCase()),
  );
  if (t.status === 'RASCUNHO') reasons.push('programação ainda não publicada');
  if (t.status === 'PROGRAMADA' && !reasons.length)
    reasons.push(`programada para ${ddmm(t.scheduledAt)}`);
  const available = t.status === 'LIBERADA';
  return {
    taskId: t.id,
    activity: t.activity,
    label: stepName(t),
    assignee: t.assigneeName,
    status: t.status,
    available,
    reason:
      available || t.status === 'EM_EXECUCAO' || t.status === 'CONCLUIDA'
        ? null
        : reasons.join('; ') || null,
    startedAt: t.startedAt,
  };
}

export function pieceWorkflow(
  p: Pick<GamePieceDto, 'stage' | 'tasks' | 'readiness' | 'planned' | 'upholstererName'>,
): PieceWorkflow {
  const open = p.tasks.filter((t) => t.status !== 'CONCLUIDA' && t.status !== 'CANCELADA');
  const steps = open.map((t) => stepOf(t, p.tasks));
  const runningAll = steps.filter((s) => s.status === 'EM_EXECUCAO' || s.status === 'PAUSADA');
  const running = runningAll.find((s) => s.status === 'EM_EXECUCAO') ?? runningAll[0] ?? null;
  const waiting = steps.filter((s) => !runningAll.includes(s));
  const next = waiting.find((s) => s.available) ?? waiting[0] ?? null;
  const stage = p.stage as FulfillmentStage;
  let phase: PiecePhase;
  if (['AGUARDANDO_INSPECAO', 'EM_INSPECAO', 'EM_CORRECAO'].includes(stage)) phase = 'QUALIDADE';
  else if (['AGUARDANDO_EMBALAGEM', 'EM_EMBALAGEM'].includes(stage)) phase = 'EMBALAGEM';
  else if (['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'BLOQUEIO_EXPEDICAO'].includes(stage))
    phase = 'PRONTA_ENTREGA';
  else if (stage === 'EM_TRANSPORTE') phase = 'EM_ENTREGA';
  else if (running) phase = running.status === 'PAUSADA' ? 'PAUSADA' : 'EM_EXECUCAO';
  else if (!p.tasks.length || !p.planned) phase = 'AGUARDANDO_PLANEJAMENTO';
  else if (open.length && open.every((t) => t.status === 'RASCUNHO'))
    phase = 'AGUARDANDO_PUBLICACAO';
  else if (waiting.some((s) => s.available))
    phase = p.tasks.some((t) => t.status === 'CONCLUIDA') ? 'ENTRE_ETAPAS' : 'NA_FILA';
  else if (waiting.length)
    phase = waiting.every((s) => s.status === 'PROGRAMADA') ? 'NA_FILA' : 'BLOQUEADA';
  else phase = 'ENTRE_ETAPAS';
  const info = PHASE_INFO[phase];
  const blockedReason = phase === 'BLOQUEADA' ? (next?.reason ?? null) : null;
  return {
    phase,
    phaseLabel: info.label,
    icon: info.icon,
    tone: info.tone,
    general:
      FULFILLMENT_STAGE_LABEL[stage] === 'Em produção'
        ? 'Na oficina (produção)'
        : (FULFILLMENT_STAGE_LABEL[stage] ?? stage),
    current: running,
    running: runningAll,
    next,
    steps,
    blockedReason,
    material: {
      readiness: p.readiness ?? 'SEM_LEVANTAMENTO',
      label:
        MATERIAL_READINESS_LABEL[(p.readiness ?? 'SEM_LEVANTAMENTO') as MaterialReadiness] ??
        String(p.readiness),
    },
    responsible: running?.assignee ?? next?.assignee ?? p.upholstererName ?? null,
  };
}

/** Filtros rápidos da oficina. */
export const QUICK_FILTERS = {
  SEM_MATERIAL: (p: GamePieceDto) => p.tone === 'FALTA',
  PARADOS: (p: GamePieceDto) =>
    ['BLOQUEADA', 'AGUARDANDO_PLANEJAMENTO', 'AGUARDANDO_PUBLICACAO', 'PAUSADA'].includes(
      pieceWorkflow(p).phase,
    ),
  EM_EXECUCAO: (p: GamePieceDto) => pieceWorkflow(p).phase === 'EM_EXECUCAO',
  PRONTOS: (p: GamePieceDto) => pieceWorkflow(p).phase === 'PRONTA_ENTREGA',
} as const;
export type QuickFilter = keyof typeof QUICK_FILTERS;
export const QUICK_FILTER_LABEL: Record<QuickFilter, string> = {
  SEM_MATERIAL: '⛔ Sem material',
  PARADOS: '⏸️ Parados',
  EM_EXECUCAO: '▶️ Em execução',
  PRONTOS: '🚚 Prontos para entrega',
};
