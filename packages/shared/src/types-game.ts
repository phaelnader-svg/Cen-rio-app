import type {
  FurnitureModel,
  LayoutContent,
  MaterialTone,
  Placement,
  RemovalImpact,
} from './game-domain';

export interface GameSpaceDto extends LayoutContent {
  id: string;
  key: string;
  position: number;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface GameSpaceSummaryDto {
  id: string;
  key: string;
  name: string;
  kind: LayoutContent['kind'];
  widthCm: number;
  depthCm: number;
  version: number;
  illustrative: boolean;
}

export interface GameLayoutRevisionDto {
  version: number;
  summary: string;
  createdAt: string;
  createdBy: string | null;
}

/** 409 ao salvar: remoções com vínculos que pedem destino. */
export interface GameLayoutImpactDto {
  impacts: RemovalImpact[];
}

export interface GameTaskRef {
  id: string;
  code: string;
  title: string;
  activity: string;
  status: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  version: number;
  startedAt: string | null;
  completedAt: string | null;
  blockers: string[];
  planId: string | null;
}

export interface GamePieceDto {
  /** service_order_item. */
  id: string;
  itemCode: string;
  serviceOrderId: string;
  osCode: string;
  osNumber: number;
  osVersion: number;
  customerName: string | null;
  description: string;
  pieceType: string;
  model: FurnitureModel;
  quantity: number;
  serviceType: string;
  fabric: string | null;
  priority: string;
  promisedDate: string | null;
  stage: string;
  readiness: string;
  tone: MaterialTone;
  upholstererUserId: string | null;
  upholstererName: string | null;
  planned: boolean;
  planItemId: string | null;
  tasks: GameTaskRef[];
  placement: Placement;
  currentTask: GameTaskRef | null;
  nextTask: GameTaskRef | null;
  /** Posição física confirmada por alguém (separada da etapa registrada). */
  confirmedLocation: { label: string; areaId: string | null; at: string; by: string | null } | null;
  photoCount: number;
}

export interface GameEmployeeDto {
  userId: string;
  employeeId: string;
  name: string;
  color: string;
  roles: string[];
  stationIds: string[];
  currentTask: (GameTaskRef & { osCode: string; itemCode: string | null }) | null;
  queue: (GameTaskRef & { osCode: string; itemCode: string | null })[];
  attendance: string | null;
  /** Área onde trabalha conforme os registros (tarefa em execução) ou a estação vinculada. */
  areaId: string | null;
  stationId: string | null;
}

export interface GameSnapshotDto {
  generatedAt: string;
  lastSeq: string | null;
  pieces: GamePieceDto[];
  employees: GameEmployeeDto[];
  /** Materiais endereçados por posição (slotId → stockItemIds) para o semáforo das estantes. */
  slotAlerts: Record<string, 'FALTA' | 'BAIXO' | 'OK'>;
  canPlan: boolean;
  canExecuteStock: boolean;
}

export interface GameSlotMaterialDto {
  stockItemId: string;
  code: string;
  description: string;
  kind: string;
  unit: string;
  onHand: number;
  reserved: number;
  available: number;
  minQuantity: number | null;
  address: string;
  reservations: { serviceOrderId: string; osCode: string; quantity: number; status: string }[];
  waiting: { serviceOrderId: string; osCode: string; requirementId: string; missing: number }[];
  purchases: {
    purchaseOrderId: string;
    code: string;
    status: string;
    quantity: number;
    received: number;
    expectedDate: string | null;
  }[];
  movements: {
    id: string;
    type: string;
    quantity: number;
    balanceAfter: number;
    reason: string | null;
    osCode: string | null;
    at: string;
    actor: string | null;
  }[];
  version: number;
}

export interface GameSlotDetailDto {
  slotId: string;
  address: string;
  unitLabel: string;
  slotLabel: string;
  materials: GameSlotMaterialDto[];
}

export interface GameMaterialSearchDto {
  stockItemId: string;
  code: string;
  description: string;
  kind: string;
  available: number;
  unit: string;
  locations: { spaceKey: string; unitId: string; slotId: string; address: string }[];
  /** Texto do cadastro quando ainda não está endereçado no mapa. */
  legacyLocation: string | null;
}

export interface AgentDto {
  id: string;
  name: string;
  roleKey: string;
  roleLabel: string;
  instructions: string;
  dataScopes: string[];
  actionPolicies: Record<string, string>;
  status: 'ATIVO' | 'PAUSADO' | 'DESATIVADO';
  color: string;
  deskStationId: string | null;
  version: number;
  pendingProposals: number;
  channelPolicies: Record<string, string>;
  autoSendRules: string[];
  /** Funciona com dados do Cenário Gestão nesta versão. */
  engine: 'DADOS_CENARIO' | 'AGUARDANDO_INTEGRACAO' | 'INSTRUCOES';
}

export interface AgentReference {
  type:
    | 'OS'
    | 'TAREFA'
    | 'MATERIAL'
    | 'COMPRA'
    | 'CONTA'
    | 'RECEBIVEL'
    | 'FUNCIONARIO'
    | 'CONVERSA'
    | 'POST'
    | 'CAMPANHA';
  id: string;
  label: string;
  href?: string;
}

export interface AgentMessageDto {
  id: string;
  author: 'USUARIO' | 'AGENTE';
  content: string;
  references: AgentReference[];
  createdAt: string;
}

export interface AgentProposalDto {
  id: string;
  kind: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  evidence: AgentReference[];
  status: 'PENDENTE' | 'APROVADA' | 'REJEITADA' | 'EXECUTADA_TESTE';
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface AgentConversationDto {
  agent: AgentDto;
  messages: AgentMessageDto[];
  proposals: AgentProposalDto[];
  tasks: { label: string; detail: string; tone: 'risco' | 'atencao' | 'ok' }[];
}

export interface IntegrationDto {
  key: string;
  label: string;
  status: 'CONECTADA' | 'PRECISA_CONFIGURAR' | 'MODO_TESTE';
  detail: string;
}

export interface AgentRoleTemplate {
  roleKey: string;
  roleLabel: string;
  name: string;
  instructions: string;
  dataScopes: string[];
  actionPolicies: Record<string, string>;
  color: string;
  integrations: string[];
  channelPolicies?: Record<string, string>;
  autoSendRules?: string[];
}
