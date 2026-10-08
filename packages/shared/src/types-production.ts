import type { PieceType, Priority } from './domain';
import type { MaterialReadiness } from './purchasing-domain';
import type {
  CompletionRequirement,
  NotificationKind,
  PauseReason,
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
  plan: { id: string; weekStart: string; status: PlanStatus } | null;
  serviceOrder: { id: string; code: string; promisedDate: string | null };
  customerName: string;
  serviceOrderItem: { id: string; code: string; description: string } | null;
  activity: ProductionActivity;
  title: string;
  role: TaskRole;
  assignee: { userId: string; displayName: string; color: string } | null;
  priority: Priority;
  sequence: number;
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
