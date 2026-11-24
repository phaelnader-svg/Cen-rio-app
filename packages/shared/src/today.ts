import type { OperationalState } from './operational-state';

/**
 * Reformulação, Fase 4 — "Hoje" no Início: o dia da oficina numa olhada, e os alertas internos.
 *
 * Tudo vem das fontes que já existem (tarefas, presença, etapa da peça, motor de prazos, prontidão
 * de materiais, Central de atenção, estado da OS da Fase 0). Cada seção só aparece para quem já
 * podia ver aquele dado; nenhuma traz valores financeiros. As ações sugeridas só EXPLICAM e levam
 * à tela certa: nada é executado sozinho.
 */

/** Peça pronta há este número de dias sem entrega vira alerta. */
export const READY_WITHOUT_DELIVERY_DAYS = 2;
/** Produção programada até este número de dias à frente com material faltando vira alerta. */
export const MATERIAL_ALERT_DAYS = 2;

export const OPERATIONAL_ALERT_KINDS = [
  'PRAZO_EM_RISCO',
  'PECA_PRONTA_SEM_ENTREGA',
  'MATERIAL_FALTANTE',
  'PRAZO_PROXIMO',
  'CONTA_A_VENCER',
  'CONTA_VENCIDA',
  'SERVICO_PARADO',
] as const;
/** Conta a pagar avisa no sininho a partir deste número de dias antes do vencimento. */
export const BILL_ALERT_DAYS_BEFORE = 1;
/** O Resumo do financeiro lista as contas que vencem nos próximos dias. */
export const BILL_UPCOMING_DAYS = 7;
/** Prazos de entrega entram no Início (e no sininho) a partir de uma semana antes. */
export const DEADLINE_ALERT_CALENDAR_DAYS = 7;

/** Serviço com prazo de entrega na próxima semana (ou já vencido), para o Início. */
export interface TodayDeadlineDto {
  /** OS (já gerada) ou pedido (peças ainda não chegaram / OS ainda não gerada). */
  kind: 'OS' | 'PEDIDO';
  id: string;
  code: string;
  customer: string;
  promisedDate: string;
  /** Dias corridos até o prazo (negativo = dias de atraso). */
  days: number;
  /** ATRASADO, EM_RISCO, PROXIMO (OS) ou PRAZO_VENCIDO/PRAZO_PROXIMO (pedido). */
  state: string;
  stateLabel: string;
  /** Por que pode atrasar (vazio = só está chegando). */
  reasons: string[];
  link: string;
}
export type OperationalAlertKind = (typeof OPERATIONAL_ALERT_KINDS)[number];

export interface TodayAlertDto {
  kind: OperationalAlertKind;
  title: string;
  body: string;
  link: string;
  at: string;
}

export interface TodaySuggestionDto {
  /** Estável (para a tela não repetir a mesma sugestão). */
  key: string;
  title: string;
  /** Por que está sendo sugerido (sempre explicado). */
  why: string;
  /** Tela onde o gestor decide e faz — a sugestão nunca executa nada. */
  link: string;
  priority: 'ALTA' | 'NORMAL';
}

export interface TodayDto {
  date: string;
  generatedAt: string;
  /** `null` = sem permissão para a seção. */
  inExecution:
    | {
        taskId: string;
        code: string;
        title: string;
        serviceOrder: { id: string; code: string };
        assignee: string | null;
        status: 'EM_EXECUCAO' | 'PAUSADA';
        since: string | null;
      }[]
    | null;
  present: {
    total: number;
    people: { displayName: string; arrivedAt: string | null }[];
  } | null;
  readyPieces:
    | {
        itemId: string;
        code: string;
        description: string;
        customer: string;
        serviceOrderId: string;
        /** Dias completos desde que ficou pronta. */
        days: number;
      }[]
    | null;
  pendencies: {
    total: number;
    critical: number;
    top: { title: string; description: string; link: string; category: string }[];
  } | null;
  alerts: TodayAlertDto[];
  /** Serviços com prazo de entrega em até uma semana ou já vencido (`null` = sem permissão). */
  deadlines?: TodayDeadlineDto[] | null;
  suggestions: TodaySuggestionDto[];
  /** Estado geral das OS ativas (regra da Fase 0), para as sugestões. */
  states?: Partial<Record<OperationalState, number>>;
}
