import type { Priority } from './domain';
import type { CandidateEvaluation } from './help-domain';
import type {
  AttentionCategory,
  AttentionType,
  IssueImpact,
  IssueKind,
  IssueStatus,
} from './issue-domain';
import type { MaterialUnit } from './measurements-domain';
import type { TaskStatus } from './production-domain';

export interface IssueTaskRefDto {
  id: string;
  code: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
}

export interface IssueEventDto {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actor: string | null;
  createdAt: string;
}

export interface IssueDto {
  id: string;
  number: number;
  code: string;
  kind: IssueKind;
  status: IssueStatus;
  impact: IssueImpact;
  blocksTask: boolean;
  priority: Priority;
  description: string;
  task: IssueTaskRefDto;
  serviceOrder: { id: string; code: string; promisedDate: string | null };
  reporter: { userId: string; displayName: string };
  material: {
    requirementId: string | null;
    stockItemId: string | null;
    description: string;
    quantity: number;
    unit: MaterialUnit;
  } | null;
  assignee: { userId: string; displayName: string } | null;
  actionTask: IssueTaskRefDto | null;
  requiredSkill: string | null;
  dueAt: string | null;
  resultNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  reopenCount: number;
  category: AttentionCategory;
  deadlineRisk: boolean;
  photos: number;
  createdAt: string;
  events?: IssueEventDto[];
  /** O que o usuário atual pode fazer (o servidor sempre revalida). */
  can?: {
    assign: boolean;
    record: boolean;
    requestVerification: boolean;
    verify: boolean;
    reopen: boolean;
    cancel: boolean;
  };
  version: number;
}

export interface IssueImpactDto {
  task: IssueTaskRefDto & { dueDate: string | null; priority: Priority };
  dependents: (IssueTaskRefDto & {
    dueDate: string | null;
    scheduledAt: string | null;
    depth: number;
  })[];
  people: string[];
  promisedDate: string | null;
  deadlineRisk: boolean;
  reasons: string[];
}

export interface AttentionItemDto {
  /** `TIPO:id` estável (sem duplicar o mesmo fato). */
  key: string;
  type: AttentionType;
  category: AttentionCategory;
  title: string;
  description: string;
  serviceOrder: { id: string; code: string } | null;
  task: { id: string; code: string; title: string } | null;
  employee: { userId: string; displayName: string } | null;
  priority: Priority;
  status: string;
  statusLabel: string;
  at: string;
  deadline: string | null;
  solver: { userId: string; displayName: string } | null;
  impacts: string[];
  nextActions: string[];
  link: string;
}

export interface AttentionDto {
  generatedAt: string;
  counts: Record<AttentionCategory, number>;
  items: AttentionItemDto[];
}

export interface ManualHelpCheckDto {
  candidates: CandidateEvaluation[];
}
