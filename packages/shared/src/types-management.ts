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
    /**
     * Rodada 3 (F10-04/F10-21k): OS ativas antes da produção, pela etapa do pipeline da
     * Produção (a mesma fonte da tela "A planejar"; contagem por OS, não por peça).
     */
    preProduction: {
      toPlan: number;
      plannedDraft: number;
      plannedPublished: number;
      awaitingCondition: number;
    };
    /**
     * Rodada 3 (F10-21l): tarefas de produção BLOQUEADAS por impedimento real (não a espera da
     * etapa anterior) em OS abertas — bloqueio de PRODUÇÃO.
     * (`pieces.blocked` continua sendo o bloqueio de EXPEDIÇÃO da peça.)
     */
    blockedTasks: number;
  } | null;
  deliveries: {
    /** Entregas agendadas de hoje até daqui a 2 dias. */
    upcoming: number;
    /** Tentativas frustradas aguardando reagendamento. */
    frustrated: number;
    /**
     * Rodada 2 (F10-21m): PEÇAS entregues hoje (dia da oficina, o mesmo "hoje" das entregas
     * próximas) pela regra canônica da Fase 8 — registrada como entregue (ou com divergência)
     * numa entrega CONCLUÍDA, contada no dia da conclusão. Frustrada, não entregue, removida,
     * agendada ou só em trânsito não contam; parcial conta só as peças entregues.
     */
    deliveredToday: number;
    /**
     * Rodada 3 (F10-05/F10-06): retiradas agendadas/em execução de hoje até daqui a 2 dias e
     * retiradas já feitas aguardando a chegada na oficina. `null` sem permissão de retiradas.
     */
    pickups: { upcoming: number; awaitingArrival: number } | null;
  } | null;
  finance: {
    receivables: { openCents: number; overdueCents: number; overdueCount: number };
    /**
     * Contas a pagar abertas (todas). Rodada 3 (F10-21r): `logistics*` é a PARTE dessas contas
     * que nasceu de custo logístico (viagem/frete) — subconjunto, não soma à parte.
     */
    payables: {
      openCents: number;
      overdueCents: number;
      logisticsOpenCents: number;
      logisticsOverdueCents: number;
    };
    /** Mão de obra liberada e ainda não paga (ProductionPayable). */
    laborDueCents: number;
    /**
     * Rodada 2 (F10-21s): pago aos profissionais (tapeçaria + logística) na semana corrente do
     * fechamento — o mesmo "Pago na semana" do Fechamento semanal (`buildClosingItems`), já
     * líquido de estornos. Não inclui previsto, devido não pago nem valores do cliente.
     */
    paid: { weekStart: string; paidInWeekCents: number };
    decisions: { valueRequests: number; laborReviews: number; paymentReports: number };
  } | null;
  /**
   * Rodada 3 (F10-21i): pendências da Central de Atenção — o mesmo cálculo e o mesmo recorte
   * de permissões da Central (fonte única). `null` sem acesso à Central.
   */
  attention: { total: number; critical: number; action: number } | null;
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
