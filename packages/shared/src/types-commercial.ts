import type { OrderDeadlineState, ServiceDeadline } from './deadline-domain';
import type { MaterialReadiness } from './purchasing-domain';
import type {
  AttachmentEntity,
  CustomerKind,
  MaterialKind,
  MaterialSourcing,
  MeasurementKind,
  OrderServiceState,
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
  /** Fase 12: quantidade devolvida ao cliente. */
  returnedQuantity: number;
  /**
   * Estabilização da Fase 2: titular previsto no fechamento (intenção). A OS gerada na chegada
   * usa-o se ele ainda puder ser titular.
   */
  plannedUpholsterer: { userId: string; displayName: string } | null;
  /** Mão de obra PREVISTA por unidade (não é pagamento). null sem `financeiro.ver`. */
  plannedLaborUnitCents: number | null;
}

export interface OrderSummaryDto {
  id: string;
  number: number;
  code: string;
  status: OrderStatus;
  /** Estabilização da Fase 2: o cliente entrega as peças (sem retirada). */
  customerDropOff: boolean;
  customer: CustomerSummaryDto;
  contractedService: string;
  totalPieces: number;
  receivedPieces: number;
  /** Fase 12: peças devolvidas ao cliente e situação do serviço (derivada). */
  returnedPieces: number;
  serviceState: OrderServiceState;
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
  /** Simplificação Fase 2: a OS nasce automaticamente na confirmação da chegada das peças. */
  autoServiceOrder: boolean;
  /** Promessa vigente para as peças/OS que ainda vão nascer (OS novas copiam este prazo). */
  promisedDate: string | null;
  /** Atenção do pedido antes da OS: prazo vencido/próximo com peça ainda não recebida. */
  deadline: OrderDeadlineState | null;
  /** Histórico das alterações do prazo do pedido (auditoria), da mais recente à mais antiga. */
  promisedDateHistory: OrderPromisedDateChangeDto[];
  technicalNotes: string | null;
  /** Pode ver a mão de obra prevista dos itens (`financeiro.ver`). */
  plannedLaborVisible: boolean;
  version: number;
  updatedAt: string;
}

export interface OrderPromisedDateChangeDto {
  from: string | null;
  to: string | null;
  reason: string;
  /** OS abertas que receberam o novo prazo junto (opção "aplicar às OS"). */
  appliedTo: string[];
  by: string | null;
  at: string;
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
  /** Fase 10: identificação da linha (correção auditável). */
  id: string;
  orderItemId: string;
  pieceType: PieceType;
  description: string;
  quantity: number;
  condition: PieceCondition;
  conditionNotes: string | null;
  location: string;
  /** Fase 10: quantidade vigente após correção (null = sem correção; o original é imutável). */
  correctedQuantity: number | null;
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
  /** Simplificação Fase 2: OS gerada automaticamente por este recebimento (pedidos do Novo serviço). */
  generatedServiceOrder: { id: string; code: string } | null;
  /** Simplificação Fase 3: tablet usado na confirmação (quando houver). */
  device: string | null;
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
  /** Estado do prazo prometido (regra única da API; a tela não recalcula). */
  deadline: ServiceDeadline;
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

// ───────────────────── Simplificação Fase 2 — Novo serviço ─────────────────────

export type OwnTeamProblem = 'NAO_CONFIGURADO' | 'INATIVO' | 'INELEGIVEL';

export interface OwnTeamSettingsDto {
  /** Responsável padrão configurado (referência ao usuário real). */
  userId: string | null;
  displayName: string | null;
  /** Pendência para o gestor resolver — o sistema nunca escolhe outro silenciosamente. */
  problem: OwnTeamProblem | null;
  candidates: { userId: string; displayName: string }[];
  version: number;
}

export interface NewServiceDefaultsDto {
  ownTeam: OwnTeamSettingsDto;
  /** Responsável padrão da terceirizada = recebedor configurado (André), se elegível. */
  outsourced: { userId: string | null; displayName: string | null };
  people: {
    EQUIPE_PROPRIA: { userId: string; displayName: string }[];
    LOGISTICA_TERCEIRIZADA: { userId: string; displayName: string }[];
  };
  /** Valor sugerido (Fase 6). Só com permissão financeira; senão null. */
  suggestedPickupCostCents: number | null;
  canSetValues: boolean;
  canSetTripCost: boolean;
  canCreateCustomer: boolean;
  /** Estabilização da Fase 2: quem pode ser titular previsto (vazio sem `producao.planejar`). */
  upholsterers: { userId: string; displayName: string; isTapeceiro: boolean }[];
  /** Definir o titular previsto (`producao.planejar`). */
  canPlanUpholsterer: boolean;
  /** Definir a mão de obra prevista (`financeiro.ver` + `financeiro.gerenciar`). */
  canPlanLabor: boolean;
}

export interface NewServiceResultDto {
  customer: { id: string; name: string; created: boolean };
  order: {
    id: string;
    code: string;
    totalPieces: number;
    agreedValueCents: number | null;
    /** O cliente entrega as peças na tapeçaria (sem retirada). */
    customerDropOff: boolean;
  };
  /** null quando o cliente entrega as peças (sem retirada). */
  pickup: {
    id: string;
    code: string;
    status: PickupStatus;
    scheduledDate: string | null;
    windowStart: string | null;
    team: PickupTeam;
    responsible: string | null;
    participants: string[];
    address: AddressSnapshot | null;
  } | null;
  /** Custo previsto da logística (null sem custo ou sem permissão financeira). */
  tripCost: { code: string; amountCents: number; status: string } | null;
}

// ─────────────── Simplificação Fase 3 — Aguardando chegada ───────────────

export type PieceArrivalStage =
  | 'RETIRADA_HOJE'
  | 'RETIRADA_PREVISTA'
  | 'EM_COLETA'
  | 'A_CAMINHO'
  | 'CHEGOU_EM_PARTE'
  | 'COM_OCORRENCIA';

export interface PieceArrivalDto {
  pickupId: string;
  pickupCode: string;
  orderId: string;
  orderCode: string;
  /** Tablet: só "Primeiro I." (privacidade); painel: nome completo. */
  customerName: string;
  stage: PieceArrivalStage;
  stageLabel: string;
  scheduledDate: string | null;
  windowStart: string | null;
  items: { orderItemId: string; pieceType: PieceType; description: string; pending: number }[];
  pendingTotal: number;
  version: number;
}

export interface MaterialArrivalDueDto {
  purchaseOrderId: string;
  code: string;
  supplierName: string | null;
  expectedDate: string | null;
  dueLabel: string;
  items: {
    purchaseOrderItemId: string;
    description: string;
    unit: string;
    unitLabel: string;
    pending: number;
    /** CONTAGEM = conta-se na porta (peças, placas); FISICA = controle em metros (rolos etc.). */
    mode: 'CONTAGEM' | 'FISICA';
  }[];
  /** Chegadas físicas aguardando conferência técnica neste pedido. */
  awaitingConference: number;
  version: number;
}

export interface ArrivalsDto {
  /** null = sem permissão de receber peças de clientes. */
  pieces: PieceArrivalDto[] | null;
  materials: MaterialArrivalDueDto[];
}

export interface ArrivalConfirmationDto {
  kind: 'PECAS' | 'MATERIAIS';
  receipt: { id: string; code: string } | null;
  arrival: { id: string; code: string } | null;
  serviceOrder: { id: string; code: string } | null;
  remaining: number;
  confirmedBy: string | null;
  confirmedAt: string;
}

export interface MaterialArrivalDto {
  id: string;
  code: string;
  purchaseOrder: { id: string; code: string };
  status: 'PENDENTE_CONFERENCIA' | 'CONFERIDA' | 'CANCELADA';
  lines: {
    purchaseOrderItemId: string;
    description: string;
    unit: string;
    physicalCount: number;
    physicalUnit: string;
  }[];
  problemKind: string | null;
  problemNote: string | null;
  receivedBy: string | null;
  device: string | null;
  receivedAt: string;
  conferredBy: string | null;
  conferredAt: string | null;
}
