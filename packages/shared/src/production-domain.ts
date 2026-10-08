/**
 * Fase 5 — motor de produção: atividades, estados de tarefa, regras de liberação
 * e validação do grafo de dependências (funções puras, testadas isoladamente).
 */
import { formatNumber } from './domain';

export const taskCode = (n: number) => formatNumber('TP', n);

export const PRODUCTION_ACTIVITIES = [
  'DESMONTAGEM',
  'PREPARACAO',
  'PREPARACAO_MDF',
  'CORTE_TECIDO',
  'CORTE_ESPUMA',
  'CORTE',
  'COSTURA',
  'REVESTIMENTO',
  'MONTAGEM',
  'ACABAMENTO',
  'APOIO',
  'OUTRA',
] as const;
export type ProductionActivity = (typeof PRODUCTION_ACTIVITIES)[number];
export const PRODUCTION_ACTIVITY_LABEL: Record<ProductionActivity, string> = {
  DESMONTAGEM: 'Desmontagem',
  PREPARACAO: 'Preparação',
  PREPARACAO_MDF: 'Preparação do MDF',
  CORTE_TECIDO: 'Corte de tecido',
  CORTE_ESPUMA: 'Corte de espuma',
  CORTE: 'Corte',
  COSTURA: 'Costura',
  REVESTIMENTO: 'Revestimento',
  MONTAGEM: 'Montagem',
  ACABAMENTO: 'Acabamento',
  APOIO: 'Apoio',
  OUTRA: 'Outra atividade',
};
/** Corte e costura do sofá são do tapeceiro principal. */
export const PRINCIPAL_ACTIVITIES: readonly ProductionActivity[] = ['CORTE_TECIDO', 'COSTURA'];

export const TASK_STATUSES = [
  'RASCUNHO',
  'BLOQUEADA',
  'PROGRAMADA',
  'LIBERADA',
  'EM_EXECUCAO',
  'PAUSADA',
  'CONCLUIDA',
  'CANCELADA',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  RASCUNHO: 'Rascunho',
  BLOQUEADA: 'Bloqueada',
  PROGRAMADA: 'Programada',
  LIBERADA: 'Liberada',
  EM_EXECUCAO: 'Em execução',
  PAUSADA: 'Pausada',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};
/** Estados em que a tarefa ainda espera para começar (reavaliados automaticamente). */
export const TASK_WAITING: readonly TaskStatus[] = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];
export const TASK_OPEN: readonly TaskStatus[] = [
  'RASCUNHO',
  'BLOQUEADA',
  'PROGRAMADA',
  'LIBERADA',
  'EM_EXECUCAO',
  'PAUSADA',
];

export const PAUSE_REASONS = [
  'FIM_EXPEDIENTE',
  'AGUARDANDO_ORIENTACAO',
  'INTERRUPCAO_PROGRAMADA',
  'OUTRO',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export const PAUSE_REASON_LABEL: Record<PauseReason, string> = {
  FIM_EXPEDIENTE: 'Fim do expediente',
  AGUARDANDO_ORIENTACAO: 'Aguardando orientação',
  INTERRUPCAO_PROGRAMADA: 'Interrupção programada',
  OUTRO: 'Outro motivo',
};

/** Fase 6: registro exigido para concluir (por regra técnica da etapa); padrão: nenhum. */
export const COMPLETION_REQUIREMENTS = ['NENHUM', 'OBSERVACAO', 'FOTO'] as const;
export type CompletionRequirement = (typeof COMPLETION_REQUIREMENTS)[number];
export const COMPLETION_REQUIREMENT_LABEL: Record<CompletionRequirement, string> = {
  NENHUM: 'Nenhum registro',
  OBSERVACAO: 'Observação de conclusão',
  FOTO: 'Foto da tarefa concluída',
};

/** Fase 6: notificações persistentes dos tablets. */
export const NOTIFICATION_KINDS = [
  'TAREFA_ATRIBUIDA',
  'TAREFA_REMOVIDA',
  'PRIORIDADE_ALTERADA',
  'TAREFA_LIBERADA',
  'TAREFA_REPROGRAMADA',
  'TAREFA_BLOQUEADA',
  'TAREFA_CANCELADA',
  'DEPENDENCIA_CONCLUIDA',
  'OS_ATUALIZADA',
  // Fase 7 — presença operacional
  'CHEGADA_CONFIRMADA',
  'ATRASO_OPERACIONAL',
  'AUSENCIA_PRESUMIDA',
  'AUSENCIA_CONFIRMADA',
  'CHEGADA_APOS_AUSENCIA',
  'EXPEDIENTE_ENCERRADO',
  'TAREFA_PENDENTE_ENCERRAMENTO',
  'PRESENCA_ALTERADA',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  TAREFA_ATRIBUIDA: 'Nova tarefa atribuída',
  TAREFA_REMOVIDA: 'Tarefa passada para outra pessoa',
  PRIORIDADE_ALTERADA: 'Prioridade alterada',
  TAREFA_LIBERADA: 'Tarefa liberada',
  TAREFA_REPROGRAMADA: 'Tarefa reprogramada',
  TAREFA_BLOQUEADA: 'Tarefa bloqueada pelo gestor',
  TAREFA_CANCELADA: 'Tarefa cancelada',
  DEPENDENCIA_CONCLUIDA: 'Etapa anterior concluída',
  OS_ATUALIZADA: 'OS atualizada',
  CHEGADA_CONFIRMADA: 'Chegada confirmada',
  ATRASO_OPERACIONAL: 'Atraso operacional',
  AUSENCIA_PRESUMIDA: 'Ausência presumida',
  AUSENCIA_CONFIRMADA: 'Ausência confirmada',
  CHEGADA_APOS_AUSENCIA: 'Chegada após ausência presumida',
  EXPEDIENTE_ENCERRADO: 'Expediente encerrado',
  TAREFA_PENDENTE_ENCERRAMENTO: 'Tarefa pendente ao encerrar',
  PRESENCA_ALTERADA: 'Presença alterada pelo gestor',
};

export const PLAN_STATUSES = ['RASCUNHO', 'PUBLICADO'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const TASK_ROLES = ['PRINCIPAL', 'APOIO'] as const;
export type TaskRole = (typeof TASK_ROLES)[number];
export const TASK_ROLE_LABEL: Record<TaskRole, string> = {
  PRINCIPAL: 'Responsável principal',
  APOIO: 'Apoio',
};

// ─────────────────────────── Liberação ───────────────────────────

export const RELEASE_BLOCKERS = [
  'OS_INATIVA',
  'PECA_NAO_RECEBIDA',
  'NAO_PUBLICADA',
  'SEM_RESPONSAVEL',
  'DEPENDENCIAS',
  'MATERIAIS',
  'BLOQUEIO',
] as const;
export type ReleaseBlocker = (typeof RELEASE_BLOCKERS)[number];
export const RELEASE_BLOCKER_LABEL: Record<ReleaseBlocker, string> = {
  OS_INATIVA: 'A OS não está ativa',
  PECA_NAO_RECEBIDA: 'Peça ainda não recebida na oficina',
  NAO_PUBLICADA: 'Programação ainda não publicada',
  SEM_RESPONSAVEL: 'Sem responsável designado',
  DEPENDENCIAS: 'Aguardando etapas anteriores',
  MATERIAIS: 'Materiais não disponíveis/reservados',
  BLOQUEIO: 'Bloqueada pelo gestor',
};

export interface ReleaseInput {
  osActive: boolean;
  pieceReceived: boolean;
  published: boolean;
  assigned: boolean;
  dependenciesDone: boolean;
  /** Só conta quando a tarefa exige materiais. */
  materialsReady: boolean;
  requiresMaterials: boolean;
  manuallyBlocked: boolean;
  scheduledAt: Date | null;
  now: Date;
}

/**
 * Estado de uma tarefa que ainda não começou. "Programada" = tudo pronto, mas o
 * horário autorizado não chegou; "Liberada" = pode iniciar agora; "Bloqueada" =
 * alguma condição obrigatória falta (com os motivos).
 */
export function evaluateRelease(i: ReleaseInput): {
  status: 'BLOQUEADA' | 'PROGRAMADA' | 'LIBERADA';
  blockers: ReleaseBlocker[];
} {
  const blockers: ReleaseBlocker[] = [];
  if (!i.osActive) blockers.push('OS_INATIVA');
  if (!i.pieceReceived) blockers.push('PECA_NAO_RECEBIDA');
  if (!i.published) blockers.push('NAO_PUBLICADA');
  if (!i.assigned) blockers.push('SEM_RESPONSAVEL');
  if (!i.dependenciesDone) blockers.push('DEPENDENCIAS');
  if (i.requiresMaterials && !i.materialsReady) blockers.push('MATERIAIS');
  if (i.manuallyBlocked) blockers.push('BLOQUEIO');
  if (blockers.length) return { status: 'BLOQUEADA', blockers };
  if (!i.scheduledAt || i.scheduledAt.getTime() > i.now.getTime()) {
    return { status: 'PROGRAMADA', blockers };
  }
  return { status: 'LIBERADA', blockers };
}

// ─────────────────────────── Dependências ───────────────────────────

/**
 * Procura ciclo no grafo (arestas: tarefa → tarefas de que depende). Devolve o
 * caminho do ciclo (ids) ou null se o grafo for acíclico.
 */
export function findCycle(edges: Map<string, readonly string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const s = state.get(m);
      if (s === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (s === undefined) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) {
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

// ─────────────────────────── Datas ───────────────────────────

/** Segunda-feira da semana de `iso` (AAAA-MM-DD). */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Converte data + "HH:MM" no fuso da empresa para um instante UTC. */
export function zonedDateTime(dateIso: string, hhmm: string, timeZone: string): Date {
  const guess = new Date(`${dateIso}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

/** Data (AAAA-MM-DD) e hora (HH:MM) de um instante no fuso da empresa. */
export function localParts(d: Date, timeZone: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return { date, time };
}

/** Ordem das tarefas no tablet: em andamento primeiro, depois prioridade e horário. */
const STATUS_ORDER: Record<TaskStatus, number> = {
  EM_EXECUCAO: 0,
  PAUSADA: 1,
  LIBERADA: 2,
  PROGRAMADA: 3,
  BLOQUEADA: 4,
  RASCUNHO: 5,
  CONCLUIDA: 6,
  CANCELADA: 7,
};
const PRIORITY_ORDER: Record<string, number> = { URGENTE: 0, ALTA: 1, NORMAL: 2, BAIXA: 3 };
export function compareTasks(
  a: { status: TaskStatus; priority: string; scheduledAt: string | null; sequence: number },
  b: { status: TaskStatus; priority: string; scheduledAt: string | null; sequence: number },
): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
    (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '') ||
    a.sequence - b.sequence
  );
}

/** Modelos iniciais (os mesmos criados pela migration; o seed os recria se não houver nenhum). */
export const DEFAULT_PRODUCTION_TEMPLATES: readonly {
  name: string;
  pieceTypes: readonly string[];
  steps: readonly {
    activity: ProductionActivity;
    name: string;
    role: TaskRole;
    requiresMaterials: boolean;
    optional: boolean;
    dependsOn: readonly number[];
  }[];
}[] = [
  {
    name: 'Reforma de sofá',
    pieceTypes: ['SOFA', 'CANTO_ALEMAO'],
    steps: [
      {
        activity: 'DESMONTAGEM',
        name: 'Desmontagem',
        role: 'APOIO',
        requiresMaterials: false,
        optional: true,
        dependsOn: [],
      },
      {
        activity: 'PREPARACAO',
        name: 'Preparação',
        role: 'APOIO',
        requiresMaterials: false,
        optional: false,
        dependsOn: [1],
      },
      {
        activity: 'CORTE_TECIDO',
        name: 'Corte de tecido',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [],
      },
      {
        activity: 'COSTURA',
        name: 'Costura',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [3],
      },
      {
        activity: 'MONTAGEM',
        name: 'Montagem',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [2, 4],
      },
      {
        activity: 'ACABAMENTO',
        name: 'Acabamento',
        role: 'PRINCIPAL',
        requiresMaterials: false,
        optional: false,
        dependsOn: [5],
      },
    ],
  },
  {
    name: 'Cabeceira',
    pieceTypes: ['CABECEIRA'],
    steps: [
      {
        activity: 'PREPARACAO_MDF',
        name: 'Preparação do MDF',
        role: 'APOIO',
        requiresMaterials: true,
        optional: false,
        dependsOn: [],
      },
      {
        activity: 'CORTE_ESPUMA',
        name: 'Corte de espuma',
        role: 'APOIO',
        requiresMaterials: true,
        optional: false,
        dependsOn: [],
      },
      {
        activity: 'REVESTIMENTO',
        name: 'Revestimento',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [1, 2],
      },
      {
        activity: 'MONTAGEM',
        name: 'Montagem',
        role: 'PRINCIPAL',
        requiresMaterials: false,
        optional: false,
        dependsOn: [3],
      },
      {
        activity: 'ACABAMENTO',
        name: 'Acabamento',
        role: 'PRINCIPAL',
        requiresMaterials: false,
        optional: false,
        dependsOn: [4],
      },
    ],
  },
  {
    name: 'Cadeira ou poltrona',
    pieceTypes: ['CADEIRA', 'POLTRONA', 'PUFE', 'BANCO'],
    steps: [
      {
        activity: 'DESMONTAGEM',
        name: 'Desmontagem (quando necessária)',
        role: 'APOIO',
        requiresMaterials: false,
        optional: true,
        dependsOn: [],
      },
      {
        activity: 'PREPARACAO',
        name: 'Preparação',
        role: 'APOIO',
        requiresMaterials: false,
        optional: false,
        dependsOn: [1],
      },
      {
        activity: 'CORTE',
        name: 'Corte',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [],
      },
      {
        activity: 'COSTURA',
        name: 'Costura',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [3],
      },
      {
        activity: 'MONTAGEM',
        name: 'Montagem',
        role: 'PRINCIPAL',
        requiresMaterials: true,
        optional: false,
        dependsOn: [2, 4],
      },
      {
        activity: 'ACABAMENTO',
        name: 'Acabamento',
        role: 'PRINCIPAL',
        requiresMaterials: false,
        optional: false,
        dependsOn: [5],
      },
    ],
  },
];
