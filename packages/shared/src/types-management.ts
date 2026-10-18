/**
 * Fase 10 (plano principal) — visão do gestor (Início) e linha do tempo do serviço. Tudo
 * derivado das fontes canônicas a cada consulta; nada é gravado. Seção sem permissão = `null`
 * (nunca "0" no lugar de "não disponível").
 */
export interface OverviewDto {
  generatedAt: string;
  /** "Hoje" no fuso da oficina. */
  today: string;
  operations: {
    /** OS abertas com ao menos uma peça ainda não entregue/devolvida/cancelada. */
    activeServiceOrders: number;
    /** Estados da regra única de prazos (dias úteis). */
    deadlines: { late: number; atRisk: number; soon: number };
    /** OS ativas cuja prontidão de materiais ainda segura a produção. */
    awaitingMaterials: number;
    /** Peças das OS ativas, pela etapa gravada (mesma da peça/expedição). */
    pieces: {
      production: number;
      quality: number;
      rework: number;
      packaging: number;
      blocked: number;
      ready: number;
      scheduled: number;
      inTransit: number;
    };
  } | null;
  deliveries: {
    /** Entregas agendadas de hoje até daqui a 2 dias. */
    upcoming: number;
    /** Tentativas frustradas aguardando reagendamento. */
    frustrated: number;
  } | null;
  finance: {
    receivables: { openCents: number; overdueCents: number; overdueCount: number };
    payables: { openCents: number; overdueCents: number };
    /** Mão de obra liberada e ainda não paga (ProductionPayable). */
    laborDueCents: number;
    decisions: { valueRequests: number; laborReviews: number; paymentReports: number };
  } | null;
}

export type TimelineDomain =
  | 'PEDIDO'
  | 'RETIRADA'
  | 'RECEBIMENTO'
  | 'OS'
  | 'MEDICAO'
  | 'PRODUCAO'
  | 'QUALIDADE'
  | 'ENTREGA'
  | 'FINANCEIRO'
  | 'AUDITORIA';

export interface TimelineEntryDto {
  at: string;
  domain: TimelineDomain;
  kind: string;
  title: string;
  note: string | null;
  actor: string | null;
}

export interface ServiceTimelineDto {
  serviceOrder: { id: string; code: string };
  order: { id: string; code: string } | null;
  entries: TimelineEntryDto[];
  /** Verdadeiro quando o limite cortou eventos antigos. */
  truncated: boolean;
}
