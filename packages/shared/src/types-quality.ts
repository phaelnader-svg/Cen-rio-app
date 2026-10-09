import type { PickupTeam, PieceType, Priority, ServiceType } from './domain';
import type { TaskStatus } from './production-domain';
import type {
  CheckResult,
  DeliveryItemStatus,
  DeliveryStatus,
  FulfillmentStage,
  InspectionReason,
  InspectionStatus,
  LogisticsKind,
  LogisticsStatus,
  PackagingStatus,
  Protection,
  ReadinessCheck,
  ReturnStatus,
} from './quality-domain';

export interface PersonRefDto {
  userId: string;
  displayName: string;
}

export interface PieceRefDto {
  id: string;
  code: string;
  description: string;
  pieceType: PieceType;
  serviceType: ServiceType;
  quantity: number;
  serviceOrder: { id: string; code: string; number: number; promisedDate: string | null };
  customer: string;
  customerId: string;
  orderId: string;
  orderItemId: string;
  stage: FulfillmentStage;
  location: { id: string; label: string } | null;
}

export interface QualityHistoryDto {
  id: string;
  kind: string;
  note: string | null;
  actor: string | null;
  createdAt: string;
}

export interface InspectionItemDto {
  id: string;
  position: number;
  label: string;
  guidance: string | null;
  required: boolean;
  result: CheckResult | null;
  note: string | null;
  checkedAt: string | null;
  checkedBy: string | null;
}

export interface InspectionTaskDto {
  id: string;
  code: string;
  title: string;
  activity: string;
  status: TaskStatus;
  assignee: string | null;
  completedAt: string | null;
}

export interface InspectionDto {
  id: string;
  number: number;
  code: string;
  round: number;
  reason: InspectionReason;
  status: InspectionStatus;
  priority: Priority;
  dueDate: string | null;
  piece: PieceRefDto;
  inspector: PersonRefDto | null;
  substituteReason: string | null;
  /** Inspetor designado executou o serviço (só decide com autorização do gestor). */
  inspectorExecuted: boolean;
  executorAuthorized: boolean;
  itemVersion: number;
  osRevision: number | null;
  startedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  invalidatedAt: string | null;
  invalidReason: string | null;
  items: InspectionItemDto[];
  /** Correções abertas a partir desta inspeção. */
  corrections: InspectionTaskDto[];
  /** Etapas de produção da peça (histórico para o inspetor). */
  production: InspectionTaskDto[];
  photos: number;
  can: { start: boolean; check: boolean; decide: boolean; decideReason: string | null };
  version: number;
  createdAt: string;
}

export interface QualityTemplateDto {
  id: string;
  name: string;
  pieceTypes: PieceType[];
  active: boolean;
  items: {
    id: string;
    position: number;
    label: string;
    guidance: string | null;
    required: boolean;
    serviceTypes: ServiceType[];
  }[];
  version: number;
}

export interface PackagingDto {
  id: string;
  number: number;
  code: string;
  status: PackagingStatus;
  piece: PieceRefDto;
  inspectionCode: string;
  assignee: PersonRefDto | null;
  tapeceiroAuthorized: boolean;
  taskId: string | null;
  protection: Protection | null;
  location: { id: string; label: string } | null;
  notes: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  invalidReason: string | null;
  version: number;
}

export interface LocationDto {
  id: string;
  key: string;
  label: string;
  position: number;
  active: boolean;
  pieces: number;
}

export interface PieceStatusDto extends PieceRefDto {
  readiness: { ready: boolean; missing: ReadinessCheck[] };
  inspection: { id: string; code: string; status: InspectionStatus; round: number } | null;
  packaging: { id: string; code: string; status: PackagingStatus } | null;
  delivery: { id: string; code: string; status: DeliveryStatus; scheduledDate: string } | null;
  labelPayload: string;
  history?: QualityHistoryDto[];
}

export interface DeliveryAddressDto {
  street: string;
  number: string;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  reference: string | null;
}

export interface DeliveryItemDto {
  serviceOrderItemId: string;
  code: string;
  description: string;
  pieceType: PieceType;
  quantity: number;
  stage: FulfillmentStage;
  ready: boolean;
  status: DeliveryItemStatus;
  note: string | null;
  deliveredAt: string | null;
}

export interface DeliveryEventDto {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actor: string | null;
  createdAt: string;
}

/** Visão completa (gestor). A logística recebe a visão restrita abaixo. */
export interface DeliveryDto {
  id: string;
  number: number;
  code: string;
  status: DeliveryStatus;
  provisional: boolean;
  customer: { id: string; name: string };
  address: DeliveryAddressDto;
  region: string;
  contactName: string | null;
  contactPhone: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  team: PickupTeam;
  responsible: PersonRefDto | null;
  requiresInstallation: boolean;
  instructions: string | null;
  notes: string | null;
  attempts: number;
  departedAt: string | null;
  arrivedAt: string | null;
  installedAt: string | null;
  installationNote: string | null;
  completedAt: string | null;
  completionNote: string | null;
  cancelReason: string | null;
  items: DeliveryItemDto[];
  events: DeliveryEventDto[];
  openOccurrences: number;
  photos: number;
  version: number;
}

/**
 * O que a logística terceirizada vê: endereço, contato operacional, peças, data, horário,
 * instruções e situação. Nada de valores, margens ou dados comerciais.
 */
export interface LogisticsJobDto {
  id: string;
  kind: 'ENTREGA' | 'RETIRADA';
  code: string;
  status: string;
  customerName: string;
  address: DeliveryAddressDto | null;
  contactName: string | null;
  contactPhone: string | null;
  scheduledDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  requiresInstallation: boolean;
  instructions: string | null;
  pieces: {
    id: string;
    code: string | null;
    description: string;
    quantity: number;
    status: string | null;
  }[];
  departedAt: string | null;
  arrivedAt: string | null;
  installedAt: string | null;
  completedAt: string | null;
  version: number;
}

export interface LogisticsOccurrenceDto {
  id: string;
  number: number;
  code: string;
  kind: LogisticsKind;
  status: LogisticsStatus;
  description: string;
  blocksShipping: boolean;
  delivery: { id: string; code: string } | null;
  pickup: { id: string; code: string } | null;
  piece: { id: string; code: string; description: string } | null;
  responsible: PersonRefDto | null;
  reportedBy: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  cancelReason: string | null;
  events: DeliveryEventDto[];
  version: number;
  createdAt: string;
}

export interface PieceReturnDto {
  id: string;
  number: number;
  code: string;
  status: ReturnStatus;
  order: { id: string; code: string; customer: string };
  reason: string;
  responsible: PersonRefDto | null;
  returnDate: string;
  /** Fase 12: destino das peças devolvidas. */
  destination: string | null;
  lines: {
    orderItemId: string;
    description: string;
    quantity: number;
    serviceOrderItems: { id: string; code: string }[];
  }[];
  /** Fase 12: o que ficou para o gestor revisar depois da confirmação. */
  review: {
    /** Reservas ativas da OS sem peça definida (não são rateadas por suposição). */
    reservations: { id: string; serviceOrder: string; material: string; quantity: number }[];
    /** Valores de produção das peças devolvidas com trabalho executado ou valor devido. */
    laborToReview: number;
  };
  history: {
    id: string;
    action: string;
    summary: string;
    actor: string | null;
    createdAt: string;
  }[];
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmationNote: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
}

export interface ReceiptCorrectionDto {
  id: string;
  receiptLineId: string;
  previousQuantity: number;
  newQuantity: number;
  reason: string;
  actor: string | null;
  createdAt: string;
}
