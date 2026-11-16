import type {
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
