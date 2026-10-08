/**
 * Fase 10 — controle de qualidade, correções, embalagem, expedição e logística.
 * Regras determinísticas (funções puras), usadas pela API, pelas telas e pelos testes.
 */
import { formatNumber, type PieceType, type ServiceType } from './domain';

export const inspectionCode = (n: number) => formatNumber('IQ', n);
export const packagingCode = (n: number) => formatNumber('EB', n);
export const deliveryCode = (n: number) => formatNumber('EN', n);
export const logisticsCode = (n: number) => formatNumber('OL', n);
export const returnCode = (n: number) => formatNumber('DV', n);

// ─────────────────────────── Inspeção ───────────────────────────

export const INSPECTION_STATUSES = [
  'PENDENTE',
  'EM_ANDAMENTO',
  'APROVADA',
  'REPROVADA',
  'INVALIDADA',
  'CANCELADA',
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
export const INSPECTION_STATUS_LABEL: Record<InspectionStatus, string> = {
  PENDENTE: 'Aguardando inspeção',
  EM_ANDAMENTO: 'Em inspeção',
  APROVADA: 'Aprovada',
  REPROVADA: 'Reprovada',
  INVALIDADA: 'Aprovação invalidada',
  CANCELADA: 'Cancelada',
};
export const INSPECTION_OPEN: readonly InspectionStatus[] = ['PENDENTE', 'EM_ANDAMENTO'];

export const INSPECTION_REASONS = [
  'PRODUCAO_CONCLUIDA',
  'CORRECAO_CONCLUIDA',
  'ALTERACAO_TECNICA',
  'MANUAL',
] as const;
export type InspectionReason = (typeof INSPECTION_REASONS)[number];
export const INSPECTION_REASON_LABEL: Record<InspectionReason, string> = {
  PRODUCAO_CONCLUIDA: 'Produção concluída',
  CORRECAO_CONCLUIDA: 'Nova inspeção após correção',
  ALTERACAO_TECNICA: 'Reverificação após alteração técnica',
  MANUAL: 'Solicitada pelo gestor',
};

export const CHECK_RESULTS = ['OK', 'NAO_CONFORME', 'NAO_SE_APLICA'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];
export const CHECK_RESULT_LABEL: Record<CheckResult, string> = {
  OK: 'Conforme',
  NAO_CONFORME: 'Não conforme',
  NAO_SE_APLICA: 'Não se aplica',
};

/** Por que a inspeção precisa de um substituto (ou da decisão do gestor). */
export const SUBSTITUTE_REASONS = {
  AUSENTE: 'Inspetor principal ausente hoje',
  EXECUTOR: 'O inspetor principal executou o serviço',
  SEM_INSPETOR: 'Nenhum inspetor principal definido',
} as const;
export type SubstituteReason = keyof typeof SUBSTITUTE_REASONS;

/**
 * Quem pode aprovar ou reprovar uma inspeção (regra única):
 * - o gestor (qualidade.gerenciar) sempre pode;
 * - o inspetor designado pode, desde que não tenha executado o serviço — salvo autorização
 *   específica registrada pelo gestor (evita autoaprovação);
 * - qualquer outra pessoa, não.
 */
export function canDecideInspection(i: {
  isManager: boolean;
  isAssignedInspector: boolean;
  executedService: boolean;
  executorAuthorized: boolean;
}): { allowed: boolean; reason: string | null } {
  if (i.isManager) return { allowed: true, reason: null };
  if (!i.isAssignedInspector)
    return { allowed: false, reason: 'A inspeção está designada para outra pessoa.' };
  if (i.executedService && !i.executorAuthorized)
    return {
      allowed: false,
      reason:
        'Você executou este serviço: a aprovação precisa do gestor ou de outro inspetor autorizado.',
    };
  return { allowed: true, reason: null };
}

/**
 * Validação da decisão: aprovar exige todos os itens obrigatórios conferidos e nenhum "não
 * conforme"; reprovar exige motivo e ao menos um defeito registrado.
 */
export function decisionProblems(
  decision: 'APROVAR' | 'REPROVAR',
  items: readonly { required: boolean; result: CheckResult | null }[],
  reason?: string | null,
): string[] {
  const out: string[] = [];
  if (decision === 'APROVAR') {
    if (items.some((i) => i.required && !i.result))
      out.push('Confira todos os itens obrigatórios do checklist.');
    if (items.some((i) => i.result === 'NAO_CONFORME'))
      out.push('Há itens não conformes: reprove e registre a correção.');
    if (items.some((i) => i.required && i.result === 'NAO_SE_APLICA'))
      out.push('Itens obrigatórios não podem ser marcados como "não se aplica".');
  } else {
    if (!reason || reason.trim().length < 3) out.push('Informe o motivo da reprovação.');
    if (!items.some((i) => i.result === 'NAO_CONFORME'))
      out.push('Marque ao menos um item como não conforme (defeito encontrado).');
  }
  return out;
}

// ─────────────────────────── Checklists ───────────────────────────

export interface QualityTemplateItemDef {
  label: string;
  guidance?: string;
  required?: boolean;
  /** Vazio = vale para todos os tipos de serviço. */
  serviceTypes?: readonly ServiceType[];
}
export interface QualityTemplateDef {
  name: string;
  pieceTypes: readonly PieceType[];
  items: readonly QualityTemplateItemDef[];
}

const STRUCTURAL: ServiceType[] = ['REFORMA_COMPLETA', 'REPARO', 'FABRICACAO', 'OUTRO'];
const FOAM: ServiceType[] = ['REFORMA_COMPLETA', 'TROCA_DE_ESPUMA', 'FABRICACAO', 'OUTRO'];
const COVER: ServiceType[] = [
  'REFORMA_COMPLETA',
  'TROCA_DE_TECIDO',
  'FABRICACAO',
  'REPARO',
  'OUTRO',
];

/** Checklists iniciais (o gestor pode ajustar). Só pede o que é relevante ao serviço. */
export const DEFAULT_QUALITY_TEMPLATES: readonly QualityTemplateDef[] = [
  {
    name: 'Sofás',
    pieceTypes: ['SOFA', 'CANTO_ALEMAO'],
    items: [
      { label: 'Estrutura', guidance: 'Firme, sem rangidos nem folgas.', serviceTypes: STRUCTURAL },
      { label: 'Fixações', guidance: 'Parafusos, grampos e pés firmes.', serviceTypes: STRUCTURAL },
      { label: 'Espumas', guidance: 'Densidade e montagem conforme a OS.', serviceTypes: FOAM },
      { label: 'Conforto', guidance: 'Assento e encosto uniformes.', serviceTypes: FOAM },
      { label: 'Costuras', guidance: 'Retas, firmes, sem pontos soltos.', serviceTypes: COVER },
      {
        label: 'Revestimento',
        guidance: 'Tecido esticado, sem rugas ou manchas.',
        serviceTypes: COVER,
      },
      { label: 'Acabamento', guidance: 'Arremates, vivos e base.' },
      { label: 'Limpeza', guidance: 'Sem resíduos de espuma, linha ou cola.' },
      { label: 'Conformidade com a OS', guidance: 'Tecido, cor, medidas e instruções técnicas.' },
    ],
  },
  {
    name: 'Cabeceiras',
    pieceTypes: ['CABECEIRA'],
    items: [
      { label: 'Medidas', guidance: 'Conforme a medição registrada na OS.' },
      {
        label: 'Estrutura',
        guidance: 'MDF/madeira firme e sem empenos.',
        serviceTypes: STRUCTURAL,
      },
      { label: 'Espuma', guidance: 'Espessura e uniformidade.', serviceTypes: FOAM },
      { label: 'Revestimento', guidance: 'Tecido esticado, sem rugas.', serviceTypes: COVER },
      { label: 'Acabamento', guidance: 'Cantos, grampeamento e fundo.' },
      { label: 'Fixações', guidance: 'Suportes e ferragens presentes.' },
      {
        label: 'Preparação para instalação',
        guidance: 'Ferragens separadas e pontos de fixação identificados.',
        serviceTypes: ['FABRICACAO', 'INSTALACAO', 'REFORMA_COMPLETA', 'OUTRO'],
      },
    ],
  },
  {
    name: 'Cadeiras e poltronas',
    pieceTypes: ['CADEIRA', 'POLTRONA'],
    items: [
      { label: 'Estrutura', guidance: 'Firme, sem folgas.', serviceTypes: STRUCTURAL },
      { label: 'Estabilidade', guidance: 'Apoia sem balançar.' },
      { label: 'Espumas', guidance: 'Conforme a OS.', serviceTypes: FOAM },
      { label: 'Costuras', guidance: 'Retas e firmes.', serviceTypes: COVER },
      { label: 'Acabamento', guidance: 'Arremates e base.' },
      { label: 'Limpeza', guidance: 'Sem resíduos.' },
    ],
  },
  {
    name: 'Outras peças',
    pieceTypes: ['PUFE', 'BANCO', 'COLCHAO', 'OUTRO'],
    items: [
      { label: 'Estrutura', serviceTypes: STRUCTURAL },
      { label: 'Espumas', serviceTypes: FOAM },
      { label: 'Revestimento', serviceTypes: COVER },
      { label: 'Acabamento' },
      { label: 'Limpeza' },
      { label: 'Conformidade com a OS' },
    ],
  },
];

/** Itens do checklist que se aplicam ao tipo de serviço (preserva a ordem). */
export function checklistFor<T extends { serviceTypes: readonly string[] }>(
  items: readonly T[],
  serviceType: ServiceType,
): T[] {
  return items.filter((i) => i.serviceTypes.length === 0 || i.serviceTypes.includes(serviceType));
}

// ─────────────────────────── Etapa da peça ───────────────────────────

export const FULFILLMENT_STAGES = [
  'EM_PRODUCAO',
  'AGUARDANDO_INSPECAO',
  'EM_INSPECAO',
  'EM_CORRECAO',
  'AGUARDANDO_EMBALAGEM',
  'EM_EMBALAGEM',
  'BLOQUEIO_EXPEDICAO',
  'PRONTA_ENTREGA',
  'ENTREGA_AGENDADA',
  'EM_TRANSPORTE',
  'ENTREGUE',
  'DEVOLVIDA',
  'CANCELADA',
] as const;
export type FulfillmentStage = (typeof FULFILLMENT_STAGES)[number];
export const FULFILLMENT_STAGE_LABEL: Record<FulfillmentStage, string> = {
  EM_PRODUCAO: 'Em produção',
  AGUARDANDO_INSPECAO: 'Aguardando inspeção',
  EM_INSPECAO: 'Em inspeção',
  EM_CORRECAO: 'Em correção',
  AGUARDANDO_EMBALAGEM: 'Aguardando embalagem',
  EM_EMBALAGEM: 'Em embalagem',
  BLOQUEIO_EXPEDICAO: 'Expedição bloqueada',
  PRONTA_ENTREGA: 'Pronta para entrega',
  ENTREGA_AGENDADA: 'Entrega agendada',
  EM_TRANSPORTE: 'Em transporte',
  ENTREGUE: 'Entregue',
  DEVOLVIDA: 'Devolvida ao cliente',
  CANCELADA: 'Cancelada',
};

export interface ReadinessInput {
  /** Tarefas obrigatórias de produção da peça (sem apoio, ocorrência, correção, embalagem). */
  requiredTasks: number;
  requiredTasksDone: number;
  /** Situação da inspeção mais recente (null = nenhuma). */
  inspection: InspectionStatus | null;
  /** Correções (tarefas) ainda não concluídas. */
  openCorrections: number;
  packaging: 'PENDENTE' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'INVALIDADA' | 'CANCELADA' | null;
  /** Ocorrência logística aberta que bloqueia a expedição. */
  shippingBlock: boolean;
}

export const READINESS_CHECKS = [
  'TAREFAS',
  'INSPECAO',
  'CORRECOES',
  'EMBALAGEM',
  'SEM_BLOQUEIO',
] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];
export const READINESS_CHECK_LABEL: Record<ReadinessCheck, string> = {
  TAREFAS: 'Tarefas obrigatórias concluídas',
  INSPECAO: 'Inspeção final aprovada',
  CORRECOES: 'Nenhuma correção obrigatória pendente',
  EMBALAGEM: 'Embalagem concluída',
  SEM_BLOQUEIO: 'Sem bloqueio crítico de expedição',
};

/** "Pronto para entrega" exige as cinco condições, sem exceção. */
export function deliveryReadiness(i: ReadinessInput): {
  ready: boolean;
  missing: ReadinessCheck[];
} {
  const missing: ReadinessCheck[] = [];
  if (i.requiredTasks === 0 || i.requiredTasksDone < i.requiredTasks) missing.push('TAREFAS');
  if (i.inspection !== 'APROVADA') missing.push('INSPECAO');
  if (i.openCorrections > 0) missing.push('CORRECOES');
  if (i.packaging !== 'CONCLUIDA') missing.push('EMBALAGEM');
  if (i.shippingBlock) missing.push('SEM_BLOQUEIO');
  return { ready: missing.length === 0, missing };
}

/**
 * Etapa da peça (derivada, determinística). A logística (agendada, em transporte, entregue)
 * só vale enquanto a peça continua liberada; devolução e cancelamento prevalecem.
 */
export function computeStage(
  i: ReadinessInput & {
    cancelled: boolean;
    returned: boolean;
    delivered: boolean;
    inTransit: boolean;
    scheduled: boolean;
  },
): FulfillmentStage {
  if (i.returned) return 'DEVOLVIDA';
  if (i.delivered) return 'ENTREGUE';
  if (i.cancelled) return 'CANCELADA';
  if (i.inTransit) return 'EM_TRANSPORTE';
  if (i.requiredTasks === 0 || i.requiredTasksDone < i.requiredTasks) return 'EM_PRODUCAO';
  if (i.openCorrections > 0 || i.inspection === 'REPROVADA') return 'EM_CORRECAO';
  if (i.inspection === 'EM_ANDAMENTO') return 'EM_INSPECAO';
  if (i.inspection !== 'APROVADA') return 'AGUARDANDO_INSPECAO';
  if (i.packaging === 'EM_ANDAMENTO') return 'EM_EMBALAGEM';
  if (i.packaging !== 'CONCLUIDA') return 'AGUARDANDO_EMBALAGEM';
  if (i.shippingBlock) return 'BLOQUEIO_EXPEDICAO';
  return i.scheduled ? 'ENTREGA_AGENDADA' : 'PRONTA_ENTREGA';
}

// ─────────────────────────── Embalagem e localização ───────────────────────────

export const PACKAGING_STATUSES = [
  'PENDENTE',
  'EM_ANDAMENTO',
  'CONCLUIDA',
  'INVALIDADA',
  'CANCELADA',
] as const;
export type PackagingStatus = (typeof PACKAGING_STATUSES)[number];
export const PACKAGING_STATUS_LABEL: Record<PackagingStatus, string> = {
  PENDENTE: 'Aguardando embalagem',
  EM_ANDAMENTO: 'Em embalagem',
  CONCLUIDA: 'Embalada',
  INVALIDADA: 'Invalidada (alteração técnica)',
  CANCELADA: 'Cancelada',
};

export const PROTECTIONS = [
  'PLASTICO_BOLHA',
  'MANTA',
  'PAPELAO',
  'FILME_STRETCH',
  'CAPA_TECIDO',
  'OUTRO',
] as const;
export type Protection = (typeof PROTECTIONS)[number];
export const PROTECTION_LABEL: Record<Protection, string> = {
  PLASTICO_BOLHA: 'Plástico bolha',
  MANTA: 'Manta',
  PAPELAO: 'Papelão',
  FILME_STRETCH: 'Filme stretch',
  CAPA_TECIDO: 'Capa de tecido',
  OUTRO: 'Outra proteção',
};

/** Localizações iniciais (o gestor pode renomear, reordenar e desativar). */
export const DEFAULT_LOCATIONS = [
  { key: 'RECEBIMENTO', label: 'Recebimento' },
  { key: 'AGUARDANDO_PRODUCAO', label: 'Aguardando produção' },
  { key: 'MESA_PRODUCAO', label: 'Mesa de produção' },
  { key: 'AREA_TESTES', label: 'Área de testes' },
  { key: 'EMBALAGEM', label: 'Embalagem' },
  { key: 'EXPEDICAO', label: 'Expedição' },
  { key: 'EM_TRANSPORTE', label: 'Em transporte' },
  { key: 'ENTREGUE', label: 'Entregue' },
] as const;

/**
 * Conteúdo de etiqueta/QR da peça (sem hardware: o texto pode virar QR em qualquer gerador).
 * Formato estável: CENARIO:PECA:<código da peça>.
 */
export const pieceLabelPayload = (itemCode: string) => `CENARIO:PECA:${itemCode}`;
export function parsePieceLabel(payload: string): string | null {
  const m = /^CENARIO:PECA:(OS-\d{5}\/\d+)$/.exec(payload.trim());
  return m ? m[1]! : null;
}

// ─────────────────────────── Entregas ───────────────────────────

export const DELIVERY_STATUSES = [
  'PROVISORIA',
  'AGENDADA',
  'EM_TRANSPORTE',
  'NO_DESTINO',
  'CONCLUIDA',
  'FRUSTRADA',
  'CANCELADA',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  PROVISORIA: 'Pré-agendamento (provisório)',
  AGENDADA: 'Agendada',
  EM_TRANSPORTE: 'Em transporte',
  NO_DESTINO: 'No destino',
  CONCLUIDA: 'Concluída',
  FRUSTRADA: 'Tentativa frustrada',
  CANCELADA: 'Cancelada',
};
export const DELIVERY_ACTIVE: readonly DeliveryStatus[] = [
  'PROVISORIA',
  'AGENDADA',
  'EM_TRANSPORTE',
  'NO_DESTINO',
];
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  PROVISORIA: ['AGENDADA', 'CANCELADA'],
  AGENDADA: ['EM_TRANSPORTE', 'PROVISORIA', 'CANCELADA'],
  EM_TRANSPORTE: ['NO_DESTINO', 'FRUSTRADA'],
  NO_DESTINO: ['CONCLUIDA', 'FRUSTRADA'],
  CONCLUIDA: [],
  FRUSTRADA: ['AGENDADA', 'PROVISORIA', 'CANCELADA'],
  CANCELADA: [],
};
export const canDeliveryTransition = (from: DeliveryStatus, to: DeliveryStatus) =>
  DELIVERY_TRANSITIONS[from].includes(to);

export const DELIVERY_ITEM_STATUSES = [
  'PENDENTE',
  'ENTREGUE',
  'DIVERGENTE',
  'NAO_ENTREGUE',
] as const;
export type DeliveryItemStatus = (typeof DELIVERY_ITEM_STATUSES)[number];
export const DELIVERY_ITEM_STATUS_LABEL: Record<DeliveryItemStatus, string> = {
  PENDENTE: 'Pendente',
  ENTREGUE: 'Entregue',
  DIVERGENTE: 'Entregue com divergência',
  NAO_ENTREGUE: 'Não entregue',
};

/** Região para agrupar a agenda (cidade e bairro do endereço; não inventa rota). */
export function regionOf(address: { city?: string | null; district?: string | null }): string {
  const city = address.city?.trim() || 'Cidade não informada';
  return address.district?.trim() ? `${city} — ${address.district.trim()}` : city;
}

// ─────────────────────────── Ocorrências logísticas ───────────────────────────

export const LOGISTICS_KINDS = [
  'CLIENTE_INDISPONIVEL',
  'PECA_DANIFICADA',
  'ENDERECO_INCORRETO',
  'ATRASO_TRANSPORTE',
  'INSTALACAO_INCOMPLETA',
  'DIVERGENCIA',
  'OUTRO',
] as const;
export type LogisticsKind = (typeof LOGISTICS_KINDS)[number];
export const LOGISTICS_KIND_LABEL: Record<LogisticsKind, string> = {
  CLIENTE_INDISPONIVEL: 'Cliente indisponível',
  PECA_DANIFICADA: 'Peça danificada',
  ENDERECO_INCORRETO: 'Endereço incorreto',
  ATRASO_TRANSPORTE: 'Atraso no transporte',
  INSTALACAO_INCOMPLETA: 'Instalação incompleta',
  DIVERGENCIA: 'Divergência',
  OUTRO: 'Outra ocorrência',
};
/** Peça danificada ou divergência bloqueiam a expedição da peça até resolver. */
export const blocksShippingByDefault = (kind: LogisticsKind) =>
  kind === 'PECA_DANIFICADA' || kind === 'DIVERGENCIA';

export const LOGISTICS_STATUSES = ['ABERTA', 'EM_TRATAMENTO', 'RESOLVIDA', 'CANCELADA'] as const;
export type LogisticsStatus = (typeof LOGISTICS_STATUSES)[number];
export const LOGISTICS_STATUS_LABEL: Record<LogisticsStatus, string> = {
  ABERTA: 'Aberta',
  EM_TRATAMENTO: 'Em tratamento',
  RESOLVIDA: 'Resolvida',
  CANCELADA: 'Cancelada',
};
export const LOGISTICS_OPEN: readonly LogisticsStatus[] = ['ABERTA', 'EM_TRATAMENTO'];

// ─────────────────────────── Devoluções ───────────────────────────

export const RETURN_STATUSES = ['REGISTRADA', 'CONFIRMADA', 'CANCELADA'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  REGISTRADA: 'Registrada (aguardando confirmação)',
  CONFIRMADA: 'Confirmada',
  CANCELADA: 'Cancelada',
};

/**
 * Correção de recebimento: a nova quantidade não pode ficar abaixo do que já está em OS
 * (peças não devolvidas) nem acima do pedido.
 */
export function receiptCorrectionProblem(i: {
  currentReceived: number;
  lineQuantity: number;
  newLineQuantity: number;
  ordered: number;
  inServiceOrders: number;
  returned: number;
}): string | null {
  const newReceived = i.currentReceived - i.lineQuantity + i.newLineQuantity;
  if (i.newLineQuantity < 0) return 'Quantidade inválida.';
  if (newReceived > i.ordered) return 'A quantidade recebida não pode passar do pedido.';
  if (newReceived < i.inServiceOrders + i.returned)
    return 'Há peças desta linha em OS ativa ou devolvidas: devolva ou cancele antes de corrigir.';
  return null;
}
