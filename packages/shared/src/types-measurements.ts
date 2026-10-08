import type { MaterialKind, MaterialSourcing, MeasurementKind, PieceType } from './domain';
import type {
  ConsolidatedLine,
  MaterialRequestStatus,
  MaterialUnit,
  MeasurementStatus,
} from './measurements-domain';
import type { CustomerSummaryDto, MeasurementDto } from './types-commercial';

export interface MaterialRequestItemDto {
  id: string;
  serviceOrderItemId: string | null;
  itemCode: string | null;
  kind: MaterialKind;
  sourcing: MaterialSourcing;
  description: string;
  color: string | null;
  reference: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  quantity: number;
  unit: MaterialUnit;
  notes: string | null;
}

export interface MeasurementPieceDto {
  serviceOrderItemId: string;
  itemCode: string;
  dimensions: MeasurementDto[];
  notes: string | null;
}

export interface MeasurementRevisionDto {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  changes: unknown;
  actor: string | null;
  createdAt: string;
}

/** Peça da OS como o executor da medição a vê (somente dados técnicos). */
export interface MeasurementOsItemDto {
  id: string;
  code: string;
  pieceType: PieceType;
  description: string;
  quantity: number;
  serviceType: string;
  fabricName: string | null;
  fabricColor: string | null;
  fabricReference: string | null;
  foamSpecs: string | null;
  technicalNotes: string | null;
  currentDimensions: MeasurementDto[];
}

export interface MeasurementSummaryDto {
  id: string;
  number: number;
  code: string;
  kind: MeasurementKind;
  status: MeasurementStatus;
  serviceOrder: { id: string; code: string };
  customer: CustomerSummaryDto;
  serviceOrderItem: { id: string; code: string; description: string } | null;
  assignee: { userId: string; displayName: string; color: string | null };
  requestedBy: string | null;
  requestedAt: string;
  dueDate: string;
  overdue: boolean;
  reason: string | null;
  completedAt: string | null;
  request: { id: string; status: MaterialRequestStatus; itemCount: number; version: number } | null;
  version: number;
}

export interface MeasurementDetailDto extends MeasurementSummaryDto {
  serviceOrderInfo: {
    technicalInstructions: string | null;
    notes: string | null;
    items: MeasurementOsItemDto[];
  };
  pieces: MeasurementPieceDto[];
  notes: string | null;
  startedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: MaterialRequestItemDto[];
  returnReason: string | null;
  revisions: MeasurementRevisionDto[];
  /** O que a sessão atual pode fazer (o servidor valida de novo em cada ação). */
  can: {
    edit: boolean;
    submit: boolean;
    reassign: boolean;
    cancel: boolean;
    review: boolean;
  };
}

export interface AwaitingMeasurementDto {
  serviceOrder: { id: string; code: string; promisedDate: string | null; priority: string };
  customer: CustomerSummaryDto;
  item: { id: string; code: string; description: string; quantity: number; pieceType: PieceType };
  receivedAt: string | null;
}

export interface MeasurementAssigneeDto {
  userId: string;
  displayName: string;
  jobTitle: string | null;
  color: string | null;
  isManager: boolean;
}

export interface ConsolidatedListDto {
  lines: ConsolidatedLine[];
  requestCount: number;
  generatedAt: string;
}

export interface PlanningDto {
  period: { from: string; to: string; measurementDay: string };
  awaiting: AwaitingMeasurementDto[];
  pending: MeasurementSummaryDto[];
  completed: MeasurementSummaryDto[];
  awaitingApproval: MeasurementSummaryDto[];
  materials: {
    /** Itens de solicitações enviadas/em revisão (ainda não conferidos). */
    requested: ConsolidatedLine[];
    /** Itens de solicitações aprovadas para compra. */
    approved: ConsolidatedLine[];
  };
}
