import type { DeadlineState } from './deadline-domain';
import type { MaterialKind, MaterialSourcing, Priority } from './domain';
import type { MaterialUnit } from './measurements-domain';
import type {
  LeftoverCondition,
  LeftoverStatus,
  LineStage,
  MaterialReadiness,
  PurchaseOrderStatus,
  ReceiptIssue,
  RejectionDecision,
  RequirementStatus,
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

/**
 * Etapa 3: destino de uma previsão de compra ainda sem OS — a peça do pedido. `pendingLink`: a
 * peça já chegou mas a vinculação à OS exige decisão do gestor (quantidade > 1 com chegada parcial).
 */
export interface PreArrivalDto {
  order: Ref & { promisedDate: string | null };
  orderItemId: string;
  piece: string;
  pendingLink: boolean;
}

export interface PurchaseAllocationDto {
  id: string;
  materialRequirementId: string;
  /** Nulo antes da chegada (Etapa 3): ver `preArrival`. */
  serviceOrder: Ref | null;
  preArrival: PreArrivalDto | null;
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
  /** Há recusa no recebimento aguardando a decisão repor/não repor. */
  hasIssues: boolean;
  /** V8: compra (ou parte dela) para OS cancelada — sem destino operacional. */
  withoutDestination: Ref[];
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
  /** V4: decisão sobre a quantidade recusada (null = ainda não decidida). */
  rejectionDecision: RejectionDecision | null;
  /** Recusa com saldo ainda em aberto aguardando a decisão repor/não repor. */
  rejectionPending: boolean;
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
    decideRejection: boolean;
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
  /** Nulo para a previsão de compra antes da chegada da peça ("Pré-chegada"). */
  serviceOrder: (Ref & { promisedDate: string | null; priority: Priority }) | null;
  preArrival: PreArrivalDto | null;
  /** Previsão de compra (não medida). */
  forecast: boolean;
  customerName: string;
  itemCode: string | null;
  sourcing: MaterialSourcing;
  need: number;
  purchasedDraft: number;
  purchased: number;
  received: number;
  /** Reservado + entregue à OS (estoque). */
  reserved: number;
  transferredIn: number;
  covered: number;
  /** Comprado (confirmado) e ainda não chegou. */
  awaiting: number;
  /** Falta comprar para esta OS (regra única `requirementCoverage`). */
  pendingToBuy: number;
  /** Recusa no recebimento aguardando decisão (repor / não repor). */
  divergence: boolean;
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

/** Linha de uma OS dentro do material consolidado de "A comprar". */
export interface PurchaseShortageRowDto extends PurchaseNeedDto {
  /** Estado do prazo da OS (só leitura; regra de Prazos). */
  deadlineState: DeadlineState;
  /** Há tarefa aguardando início bloqueada por este material. */
  blocksProduction: boolean;
}

/**
 * Material de "A comprar" consolidado por especificação. Estoque: somado entre OS pela chave do
 * catálogo; exclusivo/tecido: agrupado pela especificação completa, mas a compra continua por OS.
 */
export interface PurchaseShortageDto extends SpecDto {
  key: string;
  sourcing: MaterialSourcing;
  need: number;
  /** Disponível para as OS (reservado/entregue, recebido exclusivo, sobra transferida). */
  covered: number;
  /** Em compra: confirmado aguardando chegada + rascunho, das OS. */
  inPurchase: number;
  awaiting: number;
  inDraft: number;
  /** Falta das OS (soma). */
  shortfall: number;
  /** Estoque: saldo − reservas ativas de todas as OS (null para exclusivo). */
  freeStock: number | null;
  /** Estoque: compra para o estoque pendente sem destino (não alocada a OS aberta). */
  freePending: number;
  /** Quanto comprar: falta − estoque livre − compra de estoque pendente (estoque); falta (exclusivo). */
  suggestion: number;
  stockItem: (Ref & { available: number }) | null;
  /** Sobras compatíveis pela especificação: só sugestão (conferir cor/lote/tonalidade). */
  leftovers: { id: string; origin: string; quantity: number; location: string }[];
  blocksProduction: boolean;
  rows: PurchaseShortageRowDto[];
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
  /** V5: reserva ativa de OS já entregue — consumo ainda não confirmado. */
  unconfirmedConsumption: boolean;
  version: number;
}

export interface LeftoverDto {
  id: string;
  /** Nulo para sobra de origem pré-OS (Etapa 3): ver `preArrival`. */
  serviceOrder: Ref | null;
  preArrival: { order: Ref; piece: string; requirementId: string } | null;
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
  /** Comprado (confirmado) e ainda não chegou. */
  awaiting: number;
  /** Em rascunho de compra. */
  inDraft: number;
  /** Falta comprar (regra única). */
  shortfall: number;
  divergence: boolean;
  stage: LineStage;
  /** Etapa 2: o que passa da necessidade atual (depois de uma redução), por estágio. */
  excess: { draft: number; awaiting: number; available: number; consumed: number; total: number };
  /** Necessidades anteriores substituídas por esta (mais recente primeiro) e se herdou cobertura. */
  replaces: {
    requirementId: string;
    quantity: number;
    description: string;
    inherited: boolean;
    forecast: boolean;
  }[];
  /** Etapa 3: previsão de compra (não medida) — não libera produção sozinha. */
  forecast: boolean;
  /**
   * Excedente exclusivo recebido: dados para "Registrar sobra" (o usuário revisa e confirma).
   * `unitPriceCents` só quando há um único preço de origem conhecido (e quem vê preços).
   */
  leftoverDraft: {
    quantity: number;
    unitPriceCents: number | null;
    purchaseOrders: string[];
  } | null;
}

/**
 * Etapa 2: fatos de uma necessidade SUBSTITUÍDA (sem herança) ou CANCELADA que ficaram sem
 * necessidade ativa — exigem decisão humana; nada é cancelado, liberado ou movido sozinho.
 */
export interface RequirementOrphanDto extends SpecDto {
  requirementId: string;
  status: RequirementStatus;
  itemCode: string | null;
  closeReason: string | null;
  /** Compra confirmada ainda não recebida (decidir: manter, encerrar saldo ou cancelar). */
  awaiting: number;
  draft: number;
  /** Exclusivo recebido (candidato a sobra) ou reservado/entregue (estoque). */
  receivedExclusive: number;
  reservations: { id: string; quantity: number; status: ReservationStatus }[];
  purchaseOrders: { id: string; code: string; status: PurchaseOrderStatus }[];
}

export interface MaterialReadinessDto {
  serviceOrder: Ref & { status: string; promisedDate: string | null; priority: Priority };
  customerName: string;
  state: MaterialReadiness;
  updatedAt: string | null;
  /**
   * `forecasts`: previsões de compra ATIVAS vinculadas à OS ainda não substituídas pela medição real
   * (Etapa 3, AB-4) — a prontidão não fica COMPLETO só com previsão.
   */
  pending: { openMeasurements: number; pendingRequests: number; forecasts: number };
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
  /** V5: OS entregue com reserva ativa (material sem consumo confirmado). */
  unconfirmedConsumption: boolean;
  /** Etapa 2: material/compra de necessidades encerradas sem necessidade ativa. */
  orphans: RequirementOrphanDto[];
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

/** Etapa 3: previsões de compra das peças de um pedido (antes e depois da chegada). */
export interface OrderForecastsDto {
  order: Ref & { status: string; promisedDate: string | null };
  pieces: {
    orderItemId: string;
    position: number;
    description: string;
    quantity: number;
    receivedQuantity: number;
    /** Itens de OS desta peça (para a vinculação manual quando a chegada foi parcial). */
    serviceOrderItems: { id: string; serviceOrder: Ref; quantity: number; code: string }[];
    /** A peça pode receber previsão nova (ainda não chegou nem entrou em OS). */
    canForecast: boolean;
  }[];
  forecasts: (ReadinessLineDto & {
    orderItemId: string;
    serviceOrder: Ref | null;
    pendingLink: boolean;
    /** Sem nenhum vínculo: editável no lugar (AB-9). */
    virgin: boolean;
  })[];
  /** Fatos de previsões encerradas ainda sem destino (compra, recebido exclusivo, sobra). */
  orphans: (RequirementOrphanDto & { orderItemId: string })[];
}
