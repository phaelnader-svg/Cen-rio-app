/**
 * Enumerações, rótulos e regras de transição do fluxo comercial → oficina
 * (Fase 2). Os valores espelham os enums do banco.
 */

export const CUSTOMER_KINDS = ['PF', 'PJ'] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];
export const CUSTOMER_KIND_LABEL: Record<CustomerKind, string> = {
  PF: 'Pessoa física',
  PJ: 'Pessoa jurídica',
};

export const PIECE_TYPES = [
  'SOFA',
  'POLTRONA',
  'CADEIRA',
  'CABECEIRA',
  'CANTO_ALEMAO',
  'PUFE',
  'BANCO',
  'COLCHAO',
  'OUTRO',
] as const;
export type PieceType = (typeof PIECE_TYPES)[number];
export const PIECE_TYPE_LABEL: Record<PieceType, string> = {
  SOFA: 'Sofá',
  POLTRONA: 'Poltrona',
  CADEIRA: 'Cadeira',
  CABECEIRA: 'Cabeceira',
  CANTO_ALEMAO: 'Canto alemão',
  PUFE: 'Pufe',
  BANCO: 'Banco',
  COLCHAO: 'Colchão/assento',
  OUTRO: 'Outro',
};

export const ORDER_STATUSES = [
  'AGUARDANDO_RETIRADA',
  'RETIRADA_AGENDADA',
  'RECEBIDO_PARCIAL',
  'RECEBIDO',
  'CANCELADO',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  AGUARDANDO_RETIRADA: 'Aguardando retirada',
  RETIRADA_AGENDADA: 'Retirada agendada',
  RECEBIDO_PARCIAL: 'Recebido parcialmente',
  RECEBIDO: 'Recebido na oficina',
  CANCELADO: 'Cancelado',
};

/**
 * Fase 12 — situação do serviço do pedido (derivada; não altera o valor negociado):
 * devolução parcial, devolução total, serviço concluído (todas as peças ativas entregues),
 * serviço cancelado ou em andamento.
 */
export const ORDER_SERVICE_STATES = [
  'EM_ANDAMENTO',
  'DEVOLUCAO_PARCIAL',
  'DEVOLUCAO_TOTAL',
  'SERVICO_CONCLUIDO',
  'SERVICO_CANCELADO',
] as const;
export type OrderServiceState = (typeof ORDER_SERVICE_STATES)[number];
export const ORDER_SERVICE_STATE_LABEL: Record<OrderServiceState, string> = {
  EM_ANDAMENTO: 'Em andamento',
  DEVOLUCAO_PARCIAL: 'Devolução parcial',
  DEVOLUCAO_TOTAL: 'Devolução total',
  SERVICO_CONCLUIDO: 'Serviço concluído',
  SERVICO_CANCELADO: 'Serviço cancelado',
};
export function orderServiceState(i: {
  cancelled: boolean;
  receivedPieces: number;
  returnedPieces: number;
  activePieces: number;
  deliveredPieces: number;
}): OrderServiceState {
  if (i.cancelled) return 'SERVICO_CANCELADO';
  if (i.receivedPieces > 0 && i.returnedPieces >= i.receivedPieces) return 'DEVOLUCAO_TOTAL';
  if (i.activePieces > 0 && i.deliveredPieces >= i.activePieces) return 'SERVICO_CONCLUIDO';
  if (i.returnedPieces > 0) return 'DEVOLUCAO_PARCIAL';
  return 'EM_ANDAMENTO';
}

export const PICKUP_STATUSES = [
  'AGUARDANDO_AGENDAMENTO',
  'AGENDADA',
  'EM_EXECUCAO',
  'RETIRADA_REALIZADA',
  'RECEBIDA_NA_OFICINA',
  'CANCELADA',
  'COM_OCORRENCIA',
] as const;
export type PickupStatus = (typeof PICKUP_STATUSES)[number];
export const PICKUP_STATUS_LABEL: Record<PickupStatus, string> = {
  AGUARDANDO_AGENDAMENTO: 'Aguardando agendamento',
  AGENDADA: 'Agendada',
  EM_EXECUCAO: 'Em execução',
  RETIRADA_REALIZADA: 'Retirada realizada',
  RECEBIDA_NA_OFICINA: 'Recebida na oficina',
  CANCELADA: 'Cancelada',
  COM_OCORRENCIA: 'Com ocorrência',
};

/**
 * Transições manuais permitidas (registradas pelo gestor nesta fase; no futuro,
 * também pela integração com a logística). "Recebida na oficina" só é atingida
 * pelo registro de recebimento físico — nunca manualmente.
 */
export const PICKUP_TRANSITIONS: Record<PickupStatus, readonly PickupStatus[]> = {
  AGUARDANDO_AGENDAMENTO: ['AGENDADA', 'CANCELADA'],
  AGENDADA: ['EM_EXECUCAO', 'AGUARDANDO_AGENDAMENTO', 'COM_OCORRENCIA', 'CANCELADA'],
  EM_EXECUCAO: ['RETIRADA_REALIZADA', 'COM_OCORRENCIA'],
  RETIRADA_REALIZADA: ['COM_OCORRENCIA'],
  COM_OCORRENCIA: [
    'AGENDADA',
    'AGUARDANDO_AGENDAMENTO',
    'EM_EXECUCAO',
    'RETIRADA_REALIZADA',
    'CANCELADA',
  ],
  RECEBIDA_NA_OFICINA: [],
  CANCELADA: [],
};

/** Situações em que a retirada ainda pode originar recebimento. */
export const PICKUP_RECEIVABLE: readonly PickupStatus[] = [
  'AGENDADA',
  'EM_EXECUCAO',
  'RETIRADA_REALIZADA',
  'COM_OCORRENCIA',
];

export const PICKUP_TEAMS = ['LOGISTICA_TERCEIRIZADA', 'EQUIPE_PROPRIA'] as const;
export type PickupTeam = (typeof PICKUP_TEAMS)[number];
export const PICKUP_TEAM_LABEL: Record<PickupTeam, string> = {
  LOGISTICA_TERCEIRIZADA: 'Logística terceirizada',
  EQUIPE_PROPRIA: 'Equipe própria',
};

export const RECEIPT_ORIGINS = ['RETIRADA', 'ENTREGUE_PELO_CLIENTE'] as const;
export type ReceiptOrigin = (typeof RECEIPT_ORIGINS)[number];
export const RECEIPT_ORIGIN_LABEL: Record<ReceiptOrigin, string> = {
  RETIRADA: 'Retirada pela logística',
  ENTREGUE_PELO_CLIENTE: 'Entregue pelo cliente',
};

export const PIECE_CONDITIONS = ['BOA', 'REGULAR', 'DANIFICADA'] as const;
export type PieceCondition = (typeof PIECE_CONDITIONS)[number];
export const PIECE_CONDITION_LABEL: Record<PieceCondition, string> = {
  BOA: 'Boa',
  REGULAR: 'Regular (desgaste esperado)',
  DANIFICADA: 'Danificada / com avaria',
};

export const SERVICE_TYPES = [
  'REFORMA_COMPLETA',
  'TROCA_DE_TECIDO',
  'TROCA_DE_ESPUMA',
  'REPARO',
  'FABRICACAO',
  'INSTALACAO',
  'OUTRO',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  REFORMA_COMPLETA: 'Reforma completa',
  TROCA_DE_TECIDO: 'Troca de tecido',
  TROCA_DE_ESPUMA: 'Troca de espuma',
  REPARO: 'Reparo',
  FABRICACAO: 'Fabricação',
  INSTALACAO: 'Instalação',
  OUTRO: 'Outro',
};

export const SERVICE_ORDER_STATUSES = ['ABERTA', 'CANCELADA'] as const;
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];
export const SERVICE_ORDER_STATUS_LABEL: Record<ServiceOrderStatus, string> = {
  ABERTA: 'Aberta',
  CANCELADA: 'Cancelada',
};

export const PRIORITIES = ['BAIXA', 'NORMAL', 'ALTA', 'URGENTE'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = {
  BAIXA: 'Baixa',
  NORMAL: 'Normal',
  ALTA: 'Alta',
  URGENTE: 'Urgente',
};

export const MEASUREMENT_KINDS = ['ROTINA', 'EXTRAORDINARIA'] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];
export const MEASUREMENT_KIND_LABEL: Record<MeasurementKind, string> = {
  ROTINA: 'Medição de rotina',
  EXTRAORDINARIA: 'Medição extraordinária',
};

export const MATERIAL_KINDS = ['TECIDO', 'ESPUMA', 'OUTRO'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  TECIDO: 'Tecido',
  ESPUMA: 'Espuma',
  OUTRO: 'Outro material',
};

export const MATERIAL_SOURCINGS = ['EXCLUSIVO_OS', 'ESTOQUE'] as const;
export type MaterialSourcing = (typeof MATERIAL_SOURCINGS)[number];
export const MATERIAL_SOURCING_LABEL: Record<MaterialSourcing, string> = {
  EXCLUSIVO_OS: 'Compra exclusiva para esta OS',
  ESTOQUE: 'Material comum de estoque',
};

export const ATTACHMENT_ENTITIES = [
  'COMMERCIAL_ORDER',
  'PICKUP',
  'RECEIPT',
  'SERVICE_ORDER',
  'SERVICE_ORDER_ITEM',
  'PRODUCTION_TASK',
  'PRODUCTION_ISSUE',
  'QUALITY_INSPECTION',
  'PACKAGING',
  'DELIVERY',
  'LOGISTICS_OCCURRENCE',
  'FINANCE_PAYABLE',
] as const;
export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number];

export const BR_STATES = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;

/** Formatação dos números legíveis (sequências do banco). */
export const NUMBER_PREFIX = {
  order: 'PC',
  pickup: 'RT',
  receipt: 'RC',
  serviceOrder: 'OS',
} as const;

export function formatNumber(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

export function formatServiceOrderItemCode(osNumber: number, position: number): string {
  return `${formatNumber(NUMBER_PREFIX.serviceOrder, osNumber)}/${position}`;
}
