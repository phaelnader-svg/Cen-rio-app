import type { IssueKind } from './issue-domain';
import type { PieceType, Priority, ServiceType } from './domain';
import type { MaterialReadiness } from './purchasing-domain';
import type { DistributionPendency, OwnerChangeKind, StepClass } from './distribution-domain';
import type {
  CompletionRequirement,
  NotificationKind,
  PauseReason,
  PlanMode,
  PlanStatus,
  ProductionActivity,
  ReleaseBlocker,
  TaskRole,
  TaskStatus,
} from './production-domain';
import type { MeasurementDto } from './types-commercial';
import type { ReadinessLineDto } from './types-purchasing';

export interface ProductionTemplateDto {
  id: string;
  name: string;
  pieceTypes: PieceType[];
  /** Simplificação Fase 5: vazio = modelo geral (qualquer serviço). */
  serviceTypes: ServiceType[];
  active: boolean;
  steps: {
    id: string;
    position: number;
    activity: ProductionActivity;
    name: string;
    role: TaskRole;
    requiresMaterials: boolean;
    optional: boolean;
    dependsOn: number[];
    completionRequirement: CompletionRequirement;
    /** Evolução Fase 3: null = ambígua (pendência de revisão). */
    stepClass: StepClass | null;
    /** Simplificação Fase 5: responsável padrão da etapa (null = global da preparação). */
    defaultAssignee: { userId: string; displayName: string } | null;
  }[];
  version: number;
}

export interface WorkerDto {
  userId: string;
  displayName: string;
  jobTitle: string | null;
  color: string;
  isTapeceiro: boolean;
}

export interface TaskRefDto {
  id: string;
  code: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
}

export interface ProductionTaskDto {
  id: string;
  number: number;
  code: string;
  plan: { id: string; weekStart: string; status: PlanStatus; mode: PlanMode } | null;
  serviceOrder: { id: string; code: string; promisedDate: string | null };
  customerName: string;
  serviceOrderItem: {
    id: string;
    code: string;
    description: string;
    /** Evolução Fase 4: tapeceiro titular da peça (não é quem executa uma etapa de apoio). */
    upholsterer: { userId: string; displayName: string } | null;
  } | null;
  activity: ProductionActivity;
  /** Evolução Fase 3/4: classe da etapa (null = legado ou avulsa sem classe). */
  stepClass: StepClass | null;
  title: string;
  role: TaskRole;
  assignee: { userId: string; displayName: string; color: string } | null;
  priority: Priority;
  sequence: number;
  /** Evolução Fase 2: posição na fila definida pelo gestor (null = ordem natural). */
  queuePosition: number | null;
  /** Semana de origem, quando a pendência foi transferida. */
  carriedFromWeek: string | null;
  scheduledAt: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  dueDate: string | null;
  instructions: string | null;
  requiresMaterials: boolean;
  status: TaskStatus;
  blockers: ReleaseBlocker[];
  blockedReason: string | null;
  dependsOn: TaskRefDto[];
  dependents: TaskRefDto[];
  startedAt: string | null;
  completedAt: string | null;
  pauseReason: PauseReason | null;
  pauseNote: string | null;
  /** Fase 6: pausa que representa impedimento real (base da futura central de atenção). */
  pauseImpediment: boolean;
  lastProgress: {
    note: string | null;
    percent: number | null;
    step: string | null;
    nextStep: string | null;
    at: string;
  } | null;
  /** Fase 6: registro exigido para concluir (só o necessário). */
  completionRequirement: CompletionRequirement;
  /** Fase 8: duração estimada (apoios) e vínculo da tarefa de apoio com a tarefa principal. */
  estimatedMinutes: number | null;
  supportFor: { id: string; code: string; title: string; requester: string | null } | null;
  /** Fase 9: tarefa de resolução de uma ocorrência. */
  issueFor: {
    id: string;
    code: string;
    kind: IssueKind;
    description: string;
    reporter: string;
  } | null;
  /**
   * Fase 10: correção (defeitos da inspeção reprovada) ou embalagem (após a aprovação).
   * Embalagem conclui pela tela própria (proteção e localização), não pelo "Concluir".
   */
  qualityFor?: {
    inspectionId: string;
    code: string;
    kind: 'CORRECAO' | 'EMBALAGEM';
    note: string | null;
    defects: { label: string; note: string | null }[];
    packagingId: string | null;
  } | null;
  version: number;
}

export interface TaskEventDto {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actor: string | null;
  createdAt: string;
  /** Andamento estruturado e fotos do registro (Fase 6). */
  extra: {
    percent?: number | null;
    step?: string | null;
    nextStep?: string | null;
    attachmentIds?: string[];
  } | null;
}

export interface ProductionTaskDetailDto extends ProductionTaskDto {
  events: TaskEventDto[];
  serviceOrderInfo: {
    technicalInstructions: string | null;
    items: {
      id: string;
      code: string;
      pieceType: PieceType;
      description: string;
      quantity: number;
      fabricName: string | null;
      fabricColor: string | null;
      foamSpecs: string | null;
      technicalNotes: string | null;
      measurements: MeasurementDto[];
    }[];
  };
  /** Materiais aprovados da OS (sem preços). */
  materials: ReadinessLineDto[];
  /** Fase 6: materiais (requisitos) vinculados a esta tarefa; vazio = depende da OS inteira. */
  materialIds: string[];
  /** Fase 6: situação dos materiais desta tarefa. */
  taskMaterials: 'NAO_EXIGE' | 'DISPONIVEIS' | 'FALTANDO';
  /** Fase 6: histórico técnico da OS (campos alterados, sem valores comerciais). */
  technicalHistory: {
    revision: number;
    scope: string;
    itemCode: string | null;
    fields: string[];
    reason: string | null;
    changedBy: string | null;
    createdAt: string;
  }[];
  materialsState: MaterialReadiness;
  /** Histórico de produção da OS (todas as tarefas). */
  osTasks: TaskRefDto[];
  can: {
    start: boolean;
    pause: boolean;
    resume: boolean;
    progress: boolean;
    complete: boolean;
    manage: boolean;
  };
}

export interface PlanItemDto {
  id: string;
  serviceOrder: {
    id: string;
    code: string;
    promisedDate: string | null;
    priority: Priority;
    status: string;
  };
  customerName: string;
  principal: { userId: string; displayName: string } | null;
  priority: Priority;
  materialsState: MaterialReadiness;
  hasSofa: boolean;
}

export interface PlanConflictDto {
  kind:
    | 'SEM_RESPONSAVEL'
    | 'SEM_HORARIO'
    | 'HORARIO_COINCIDENTE'
    | 'ANTES_DA_DEPENDENCIA'
    | 'MATERIAIS'
    | 'APOS_PRAZO'
    | 'FORA_DA_SEMANA';
  message: string;
  taskIds: string[];
}

export interface PlanRevisionDto {
  id: string;
  revision: number;
  reason: string | null;
  offSchedule: boolean;
  createdBy: string | null;
  createdAt: string;
  taskCount: number;
}

export interface ProductionPlanDto {
  id: string;
  weekStart: string;
  weekEnd: string;
  status: PlanStatus;
  /** Evolução Fase 2: LEGADO (por horário) ou FILA_SEMANAL. */
  mode: PlanMode;
  /** A semana já terminou (no fuso da empresa) e ainda há pendências. */
  weekEnded: boolean;
  pendingCount: number;
  revision: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  items: PlanItemDto[];
  tasks: ProductionTaskDto[];
  conflicts: PlanConflictDto[];
  revisions: PlanRevisionDto[];
  version: number;
}

/** Evolução Fase 2: fila do funcionário (ordem da fila, independente do estado). */
export interface QueueEntryDto {
  /** 1 = primeira da fila. Não muda quando a tarefa fica bloqueada. */
  position: number;
  executable: boolean;
  task: ProductionTaskDto;
}
export interface MyQueueDto {
  /** Evolução Fase 4: semana vigente (segunda a domingo, no fuso da empresa). */
  week: { start: string; end: string };
  /** Contagens da fila (não medem produtividade): concluídas na semana e situação das abertas. */
  counts: { done: number; running: number; paused: number; executable: number; blocked: number };
  /** Abertas que vêm de semanas anteriores (pendências não transferidas automaticamente). */
  fromPreviousWeeks: number;
  /** Em execução ou, se não houver, a primeira pausada. */
  current: ProductionTaskDto | null;
  /** Primeira tarefa LIBERADA na ordem da fila (nunca é iniciada automaticamente). */
  next: ProductionTaskDto | null;
  /** Quantas tarefas à frente da "próxima" estão bloqueadas (mantêm o lugar). */
  blockedAhead: number;
  items: QueueEntryDto[];
  total: number;
}

export interface PlanCandidateDto {
  serviceOrder: { id: string; code: string; promisedDate: string | null; priority: Priority };
  customerName: string;
  materialsState: MaterialReadiness;
  items: { id: string; code: string; pieceType: PieceType; description: string }[];
  technicalLead: { userId: string; displayName: string } | null;
  openTasks: number;
  inPlan: boolean;
}

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  taskId: string | null;
  serviceOrderId: string | null;
  createdAt: string;
  readAt: string | null;
}

// ─────────────────────────── Evolução Fase 3: distribuição ───────────────────────────

export interface DistributionPendencyDto {
  kind: DistributionPendency;
  message: string;
  taskIds: string[];
}
export interface PieceDistributionDto {
  item: { id: string; code: string; pieceType: string; description: string };
  serviceOrder: { id: string; code: string };
  needsUpholstery: boolean;
  upholsterer: { userId: string; displayName: string } | null;
  template: { id: string; name: string; version: number } | null;
  tasks: {
    id: string;
    code: string;
    title: string;
    stepClass: StepClass | null;
    status: string;
    assignee: { userId: string; displayName: string } | null;
    planId: string | null;
  }[];
  inspector: { userId: string; displayName: string } | null;
  pendencies: DistributionPendencyDto[];
  ownerChanges: {
    kind: OwnerChangeKind;
    from: string | null;
    to: string;
    reason: string | null;
    financialReviewRequired: boolean;
    createdBy: string | null;
    createdAt: string;
  }[];
}
export interface PlanDistributionDto {
  planId: string;
  mode: string;
  pieces: PieceDistributionDto[];
  pendencyCount: number;
}

// ─────────────────────── Simplificação Fase 4 — pré-planejamento ───────────────────────

/**
 * Onde a OS está na produção — mutuamente exclusivo, calculado dos vínculos reais do banco
 * (item de plano e tarefas), nunca de marcação visual.
 */
export type PipelineStage =
  | 'A_PLANEJAR'
  | 'PLANEJADO_RASCUNHO'
  | 'PLANEJADO_PUBLICADO'
  | 'AGUARDANDO_CONDICAO'
  | 'EM_PRODUCAO'
  | 'CONCLUIDO';

export const PIPELINE_STAGE_LABEL: Record<PipelineStage, string> = {
  A_PLANEJAR: 'A planejar',
  PLANEJADO_RASCUNHO: 'Planejado — rascunho',
  PLANEJADO_PUBLICADO: 'Planejado — publicado',
  AGUARDANDO_CONDICAO: 'Aguardando condição',
  EM_PRODUCAO: 'Em produção',
  CONCLUIDO: 'Concluído',
};

export interface PipelinePieceDto {
  id: string;
  code: string;
  pieceType: string;
  description: string;
  quantity: number;
  serviceType: string;
  /** Peça com etapa de tapeçaria no modelo atual (exige titular). */
  needsUpholsterer: boolean;
  template: string | null;
  upholsterer: { userId: string; displayName: string } | null;
}

export interface PipelineServiceDto {
  serviceOrder: { id: string; code: string; promisedDate: string | null; priority: string };
  customerName: string;
  receivedAt: string | null;
  pieces: PipelinePieceDto[];
  materials: { state: string; label: string; inConference: boolean };
  stage: PipelineStage;
  /** Item do plano (semana) — nulo em "A planejar". */
  plan: {
    planId: string;
    itemId: string;
    weekStart: string;
    planStatus: 'RASCUNHO' | 'PUBLICADO';
    startDate: string | null;
    version: number;
    plannedBy: string | null;
  } | null;
  tasks: { total: number; done: number; started: number; blocked: number; draft: number };
  /** Motivos legíveis de impedimento (Aguardando condição) — "planejado" ≠ "liberado". */
  blockers: string[];
  /** Pendências para o gestor decidir (sem titular, sem modelo, sem responsável elegível…). */
  pendencies: string[];
}

export interface ProductionPipelineDto {
  counts: Record<PipelineStage, number>;
  items: PipelineServiceDto[];
}

export interface PlanServicesResultDto {
  planned: {
    serviceOrderId: string;
    code: string;
    planId: string;
    weekStart: string;
    startDate: string;
    tasksCreated: number;
  }[];
}

export interface PublicationPreviewDto {
  planId: string;
  weekStart: string;
  planStatus: 'RASCUNHO' | 'PUBLICADO';
  version: number;
  /** Só o que esta publicação vai liberar (tarefas em rascunho). */
  serviceOrders: number;
  pieces: number;
  tasks: number;
  byAssignee: { userId: string | null; displayName: string; tasks: number }[];
  startDates: { code: string; startDate: string | null }[];
  pendencies: string[];
  materialsBlocked: { code: string; label: string }[];
  conflicts: string[];
  publishable: boolean;
}
