import type {
  CandidateEvaluation,
  HelpKind,
  HelpStatus,
  PlanningActionKind,
  ProposalAlternative,
  ProposalKind,
  ProposalStatus,
  Skill,
} from './help-domain';
import type { TaskStatus } from './production-domain';

export interface HelpTaskRefDto {
  id: string;
  code: string;
  title: string;
  status: TaskStatus;
}

export interface HelpRequestEventDto {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actor: string | null;
  /** Candidatos avaliados (motivos e pontuação) quando houve tentativa de atribuição. */
  candidates: CandidateEvaluation[] | null;
  createdAt: string;
}

export interface HelpRequestDto {
  id: string;
  number: number;
  code: string;
  task: HelpTaskRefDto;
  serviceOrder: { id: string; code: string };
  requester: { userId: string; displayName: string };
  helper: { userId: string; displayName: string } | null;
  kind: HelpKind;
  estimatedMinutes: number;
  urgent: boolean;
  justification: string | null;
  note: string | null;
  status: HelpStatus;
  supportTask: HelpTaskRefDto | null;
  /** Minutos desde o pedido (até atribuição/fim). */
  waitingMinutes: number;
  proposalId: string | null;
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  events?: HelpRequestEventDto[];
  version: number;
}

export interface ProposalTaskDto extends HelpTaskRefDto {
  assignee: string | null;
}

export interface RescheduleProposalDto {
  id: string;
  number: number;
  code: string;
  kind: ProposalKind;
  status: ProposalStatus;
  critical: boolean;
  situation: string;
  problem: string;
  affectedTasks: ProposalTaskDto[];
  alternatives: ProposalAlternative[];
  proposedAlternativeId: string;
  chosenAlternativeId: string | null;
  helpRequest: { id: string; code: string } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  version: number;
}

export interface PlanningActionDto {
  id: string;
  kind: PlanningActionKind;
  automatic: boolean;
  reason: string;
  actor: string | null;
  task: HelpTaskRefDto | null;
  helpRequestCode: string | null;
  proposalCode: string | null;
  createdAt: string;
}

export interface EmployeeSkillsDto {
  employeeId: string;
  userId: string;
  displayName: string;
  jobTitle: string;
  skills: Skill[];
}
