import type { MaterialKind, MaterialSourcing, Priority } from './domain';
import type { MaterialUnit } from './measurements-domain';
import type {
  LeftoverCondition,
  LeftoverStatus,
  LineStage,
  MaterialReadiness,
  PurchaseOrderStatus,
  ReceiptIssue,
  ReservationStatus,
  StockMovementType,
} from './purchasing-domain';

export interface Ref {
  id: string;
  code: string;
}

export interface SpecDto {
  kind: MaterialKind;
  description: string;
  color: string | null;
  reference: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  unit: MaterialUnit;
}

export interface SupplierDto {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  categories: MaterialKind[];
  notes: string | null;
  active: boolean;
  openOrders: number;
  version: number;
}

export interface PurchaseAllocationDto {
  id: string;
  materialRequirementId: string;
  serviceOrder: Ref;
  itemCode: string | null;
  quantity: number;
}

export interface PurchaseOrderItemDto extends SpecDto {
  id: string;
  position: number;
  sourcing: MaterialSourcing;
  quantity: number;
  extraAuthorized: number;
  receivedQuantity: number;
  /** Fase 12: saldo encerrado (não será entregue). */
  closedQuantity: number;
  pendingQuantity: number;
  rejectedQuantity: number;
  /** Preços só para quem tem `compras.ver`. */
  unitPriceCents: number | null;
  totalCents: number | null;
  serviceOrder: Ref | null;
  stockItem: Ref | null;
  allocations: PurchaseAllocationDto[];
  notes: string | null;
}

export interface PurchaseOrderSummaryDto {
  id: string;
  number: number;
  code: string;
  status: PurchaseOrderStatus;
  supplier: { id: string; name: string } | null;
  expectedDate: string | null;
  createdAt: string;
  itemCount: number;
  totalCents: number | null;
  serviceOrders: Ref[];
  /** Há recebimento com divergência ainda pendente. */
  hasIssues: boolean;
  version: number;
}

export interface ReceiptReversalDto {
  id: string;
  quantity: number;
  reason: string;
  authorizedBy: string | null;
  createdAt: string;
}

export interface MaterialReceiptLineDto extends SpecDto {
  id: string;
  purchaseOrderItemId: string;
  acceptedQuantity: number;
  rejectedQuantity: number;
  reversedQuantity: number;
  specConfirmed: boolean;
  issue: ReceiptIssue | null;
  issueNote: string | null;
  serviceOrder: Ref | null;
  reversals: ReceiptReversalDto[];
}

export interface MaterialReceiptDto {
  id: string;
  number: number;
  code: string;
  purchaseOrder: Ref;
  receivedAt: string;
  receivedBy: string | null;
  notes: string | null;
  lines: MaterialReceiptLineDto[];
}

export interface PurchaseOrderHistoryDto {
  id: string;
  kind: string;
  note: string | null;
  changes: unknown;
  actor: string | null;
  createdAt: string;
}

export interface PurchaseOrderDto extends PurchaseOrderSummaryDto {
  notes: string | null;
  items: PurchaseOrderItemDto[];
  receipts: MaterialReceiptDto[];
  history: PurchaseOrderHistoryDto[];
  createdBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Fase 12: saldo pendente encerrado (o recebido é preservado). */
  balanceClosedAt: string | null;
  balanceCloseReason: string | null;
  can: {
    edit: boolean;
    confirm: boolean;
    cancel: boolean;
    authorizeExtra: boolean;
    closeBalance: boolean;
  };
}

/** Pedido aguardando chegada, como o funcionário vê (sem preços nem fornecedor comercial). */
export interface PendingMaterialReceiptDto {
  id: string;
  code: string;
  status: PurchaseOrderStatus;
  supplierName: string | null;
  expectedDate: string | null;
  items: (SpecDto & {
    id: string;
    sourcing: MaterialSourcing;
    quantity: number;
    receivedQuantity: number;
    remaining: number;
    serviceOrder: Ref | null;
    destinations: string[];
  })[];
}

export interface PurchaseNeedDto extends SpecDto {
  requirementId: string;
  serviceOrder: Ref & { promisedDate: string | null; priority: Priority };
  customerName: string;
  itemCode: string | null;
  sourcing: MaterialSourcing;
  need: number;
  purchasedDraft: number;
  purchased: number;
  received: number;
  covered: number;
  pendingToBuy: number;
  stage: LineStage;
  purchases: {
    purchaseOrderId: string;
    code: string;
    status: PurchaseOrderStatus;
    supplierName: string | null;
    quantity: number;
    unitPriceCents: number | null;
  }[];
}

export interface StockItemDto extends SpecDto {
  id: string;
  number: number;
  code: string;
  onHand: number;
  reserved: number;
  available: number;
  minQuantity: number | null;
  belowMinimum: boolean;
  location: string | null;
  notes: string | null;
  active: boolean;
  version: number;
}

export interface StockMovementDto {
  id: string;
  type: StockMovementType;
  stockItem: Ref & { description: string; unit: MaterialUnit };
  quantity: number;
  balanceAfter: number;
  reservedAfter: number;
  serviceOrder: Ref | null;
  reference: string | null;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

export interface StockReservationDto {
  id: string;
  status: ReservationStatus;
  stockItem: Ref & { description: string; unit: MaterialUnit };
  serviceOrder: Ref;
  materialRequirementId: string | null;
  quantity: number;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  closeReason: string | null;
  version: number;
}

export interface LeftoverDto {
  id: string;
  serviceOrder: Ref;
  kind: MaterialKind;
  description: string;
  color: string | null;
  reference: string | null;
  foamDensity: string | null;
  thicknessCm: number | null;
  quantity: number;
  initialQuantity: number;
  unit: MaterialUnit;
  location: string;
  condition: LeftoverCondition;
  reusable: boolean;
  status: LeftoverStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
  transfers: {
    id: string;
    toServiceOrder: Ref;
    quantity: number;
    reason: string;
    authorizedBy: string | null;
    createdAt: string;
  }[];
}

export interface ReadinessLineDto extends SpecDto {
  requirementId: string;
  itemCode: string | null;
  sourcing: MaterialSourcing;
  need: number;
  purchased: number;
  received: number;
  reserved: number;
  transferredIn: number;
  covered: number;
  divergence: boolean;
  stage: LineStage;
}

export interface MaterialReadinessDto {
  serviceOrder: Ref & { status: string; promisedDate: string | null; priority: Priority };
  customerName: string;
  state: MaterialReadiness;
  updatedAt: string | null;
  pending: { openMeasurements: number; pendingRequests: number };
  lines: ReadinessLineDto[];
  purchaseOrders: {
    id: string;
    code: string;
    status: PurchaseOrderStatus;
    supplierName: string | null;
    expectedDate: string | null;
    totalCents: number | null;
  }[];
  receipts: {
    id: string;
    code: string;
    purchaseOrderCode: string;
    receivedAt: string;
    receivedBy: string | null;
    accepted: number;
    issues: number;
  }[];
  reservations: StockReservationDto[];
  leftovers: LeftoverDto[];
  /** Sempre falso: materiais completos não autorizam o início da produção. */
  canStartProduction: false;
}

export interface ReadinessSummaryDto {
  serviceOrder: Ref & { promisedDate: string | null; priority: Priority };
  customerName: string;
  state: MaterialReadiness;
  updatedAt: string | null;
  lines: number;
  coveredLines: number;
}
