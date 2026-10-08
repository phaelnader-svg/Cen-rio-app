import type { MaterialReadiness } from './purchasing-domain';
import type {
  AttachmentEntity,
  CustomerKind,
  MaterialKind,
  MaterialSourcing,
  MeasurementKind,
  OrderStatus,
  PickupStatus,
  PickupTeam,
  PieceCondition,
  PieceType,
  Priority,
  ReceiptOrigin,
  ServiceOrderStatus,
  ServiceType,
} from './domain';
import type { EmployeeSummaryDto } from './types';

export interface AddressSnapshot {
  label: string;
  street: string;
  number: string;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  reference: string | null;
}

export interface CustomerAddressDto extends AddressSnapshot {
  id: string;
  isPrimary: boolean;
}

/** Dados mínimos do cliente (sem dados pessoais). */
export interface CustomerSummaryDto {
  id: string;
  kind: CustomerKind;
  name: string;
  tradeName: string | null;
}

export interface CustomerDto extends CustomerSummaryDto {
  document: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  addresses: CustomerAddressDto[];
  orderCount: number;
  serviceOrderCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateCandidateDto {
  id: string;
  name: string;
  kind: CustomerKind;
  reasons: ('documento' | 'telefone' | 'whatsapp' | 'email' | 'nome')[];
}

export interface OrderItemDto {
  id: string;
  position: number;
  pieceType: PieceType;
  description: string;
  quantity: number;
  notes: string | null;
  /** Quantidade já recebida fisicamente na oficina. */
  receivedQuantity: number;
  /** Quantidade em retiradas ativas (ainda não recebidas). */
  inActivePickups: number;
  /** Quantidade recebida já incluída em OS ativas. */
  inServiceOrders: number;
}

export interface OrderSummaryDto {
  id: string;
  number: number;
  code: string;
  status: OrderStatus;
  customer: CustomerSummaryDto;
  contractedService: string;
  totalPieces: number;
  receivedPieces: number;
  createdAt: string;
}

export interface OrderDto extends OrderSummaryDto {
  pickupAddressId: string | null;
  pickupAddress: AddressSnapshot | null;
  description: string | null;
  /** null quando o usuário não tem permissão de ver valores (veja `valuesVisible`). */
  agreedValueCents: number | null;
  paymentTerms: string | null;
  valuesVisible: boolean;
  notes: string | null;
  items: OrderItemDto[];
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  version: number;
  updatedAt: string;
}

export interface PickupEventDto {
  id: string;
  kind: string;
  fromStatus: PickupStatus | null;
  toStatus: PickupStatus | null;
  note: string | null;
  source: 'MANUAL' | 'SISTEMA' | 'INTEGRACAO';
  recordedBy: string | null;
  occurredAt: string;
}

export interface PickupDto {
  id: string;
  number: number;
  code: string;
  status: PickupStatus;
  order: { id: string; code: string; contractedService: string };
  customer: CustomerSummaryDto & { phone: string | null; whatsapp: string | null };
  address: AddressSnapshot | null;
  scheduledDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  team: PickupTeam;
  teamNotes: string | null;
  instructions: string | null;
  externalReference: string | null;
  items: { orderItemId: string; pieceType: PieceType; description: string; quantity: number }[];
  events: PickupEventDto[];
  allowedTransitions: PickupStatus[];
  version: number;
  createdAt: string;
}

export interface ReceiptLineDto {
  orderItemId: string;
  pieceType: PieceType;
  description: string;
  quantity: number;
  condition: PieceCondition;
  conditionNotes: string | null;
  location: string;
}

export interface ReceiptDto {
  id: string;
  number: number;
  code: string;
  order: { id: string; code: string };
  customer: CustomerSummaryDto;
  pickup: { id: string; code: string } | null;
  origin: ReceiptOrigin;
  receivedAt: string;
  receivedBy: EmployeeSummaryDto | null;
  registeredBy: string | null;
  divergences: string | null;
  notes: string | null;
  lines: ReceiptLineDto[];
  createdAt: string;
}

export interface MeasurementDto {
  label: string;
  valueCm: number;
}

export interface ServiceOrderItemDto {
  id: string;
  code: string;
  position: number;
  orderItemId: string;
  pieceType: PieceType;
  description: string;
  quantity: number;
  serviceType: ServiceType;
  fabricName: string | null;
  fabricColor: string | null;
  fabricReference: string | null;
  foamSpecs: string | null;
  technicalNotes: string | null;
  measurements: MeasurementDto[];
  measurementNotes: string | null;
  measuredAt: string | null;
  measuredBy: string | null;
  measurementKind: MeasurementKind | null;
  /** Onde a peça foi guardada no recebimento. */
  locations: string[];
  version: number;
}

export interface MaterialRequirementDto {
  id: string;
  serviceOrderItemId: string | null;
  kind: MaterialKind;
  description: string;
  quantity: number | null;
  unit: string | null;
  sourcing: MaterialSourcing;
  notes: string | null;
  createdAt: string;
  /** PREVISAO_MANUAL (não conferida) ou SOLICITACAO_APROVADA (conferida na Fase 3). */
  origin: 'PREVISAO_MANUAL' | 'SOLICITACAO_APROVADA';
  color: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
}

export type ReadinessState = 'OK' | 'PENDENTE' | 'FASE_FUTURA';

export interface ServiceOrderReadinessDto {
  measurements: ReadinessState;
  technicalLead: ReadinessState;
  materials: ReadinessState;
  /** Prontidão detalhada de materiais (Fase 4). */
  materialsState: MaterialReadiness;
  scheduling: ReadinessState;
  /** Sempre false nesta fase: a produção só começa pela programação (fases futuras). */
  canStartProduction: false;
}

export interface ServiceOrderSummaryDto {
  id: string;
  number: number;
  code: string;
  status: ServiceOrderStatus;
  order: { id: string; code: string };
  customer: CustomerSummaryDto;
  priority: Priority;
  promisedDate: string | null;
  technicalLead: EmployeeSummaryDto | null;
  itemCount: number;
  pieceCount: number;
  createdAt: string;
}

export interface ServiceOrderDto extends ServiceOrderSummaryDto {
  technicalInstructions: string | null;
  notes: string | null;
  items: ServiceOrderItemDto[];
  materials: MaterialRequirementDto[];
  readiness: ServiceOrderReadinessDto;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  version: number;
  updatedAt: string;
}

export interface ServiceOrderRevisionDto {
  id: string;
  revision: number;
  scope: 'OS' | 'ITEM' | 'MEDICAO' | 'MATERIAL' | 'CRIACAO' | 'CANCELAMENTO';
  itemCode: string | null;
  changes: unknown;
  reason: string | null;
  changedBy: string | null;
  createdAt: string;
}

export interface AttachmentDto {
  id: string;
  entityType: AttachmentEntity;
  entityId: string;
  url: string;
  caption: string | null;
  mimeType: string;
  createdBy: string | null;
  createdAt: string;
}

export interface PageDto<T> {
  items: T[];
  total: number;
}
