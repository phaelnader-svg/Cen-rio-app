// ─────────────────────────── Prazos e serviços em risco ───────────────────────────
//
// Regra única (pura) do estado do prazo prometido de uma OS e da atenção do pedido antes da OS.
// Só LÊ fatos já gravados — nunca altera fila, prioridade, tarefas ou planejamento (D9 intacta).
// Sem duração por etapa e sem previsão: o prazo serve para ALERTAR; o gestor decide.

/** Janela fixa de "prazo próximo": de hoje até o 5º dia útil seguinte, inclusive. */
export const DEADLINE_WINDOW_WORKING_DAYS = 5;

export const DEADLINE_STATES = [
  'ATRASADO',
  'EM_RISCO',
  'PROXIMO',
  'NO_PRAZO',
  'SEM_PRAZO',
  'ENCERRADA',
] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];
export const DEADLINE_STATE_LABEL: Record<DeadlineState, string> = {
  ATRASADO: 'Atrasado',
  EM_RISCO: 'Em risco',
  PROXIMO: 'Prazo próximo',
  NO_PRAZO: 'No prazo',
  SEM_PRAZO: 'Sem prazo',
  ENCERRADA: 'Encerrada',
};

export const DEADLINE_REASONS = [
  'NAO_PLANEJADA',
  'PRODUCAO_NAO_INICIADA',
  'BLOQUEADA',
  'MATERIAIS',
  'EM_CORRECAO',
  'PRONTA_SEM_ENTREGA',
  'ENTREGA_DEPOIS_DO_PRAZO',
  'ENTREGA_FRUSTRADA',
] as const;
export type DeadlineReason = (typeof DEADLINE_REASONS)[number];
export const DEADLINE_REASON_LABEL: Record<DeadlineReason, string> = {
  NAO_PLANEJADA: 'Ainda não planejada',
  PRODUCAO_NAO_INICIADA: 'Produção ainda não iniciada',
  BLOQUEADA: 'Produção bloqueada',
  MATERIAIS: 'Materiais pendentes',
  EM_CORRECAO: 'Peça em correção',
  PRONTA_SEM_ENTREGA: 'Pronta, sem entrega agendada',
  ENTREGA_DEPOIS_DO_PRAZO: 'Entrega agendada depois do prazo',
  ENTREGA_FRUSTRADA: 'Entrega frustrada, ainda não reagendada',
};

// ─────────────────────────── Calendário (dias de trabalho da empresa) ───────────────────────────

const shift = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const safeDays = (workingDays: readonly number[]) =>
  workingDays.length ? workingDays : [1, 2, 3, 4, 5];

/** O n-ésimo dia útil depois de `date` (dias de trabalho configurados na empresa). */
export function addWorkingDays(date: string, n: number, workingDays: readonly number[]): string {
  const days = safeDays(workingDays);
  let d = date;
  let left = n;
  while (left > 0) {
    d = shift(d, 1);
    if (days.includes(weekday(d))) left -= 1;
  }
  return d;
}

/** Último dia da janela de prazo próximo (inclusive). */
export const deadlineWindowEnd = (today: string, workingDays: readonly number[]) =>
  addWorkingDays(today, DEADLINE_WINDOW_WORKING_DAYS, workingDays);

/**
 * Dias úteis entre hoje e o prazo: positivo = dias úteis restantes até o prazo (dias úteis em
 * (hoje, prazo]); 0 = vence hoje (ou num dia sem expediente antes do próximo útil); negativo =
 * dias úteis de atraso (dias úteis em [prazo, hoje)).
 */
export function workingDaysUntil(
  today: string,
  date: string,
  workingDays: readonly number[],
): number {
  const days = safeDays(workingDays);
  if (date === today) return 0;
  let count = 0;
  if (date > today) {
    for (let d = shift(today, 1); d <= date; d = shift(d, 1))
      if (days.includes(weekday(d))) count++;
    return count;
  }
  for (let d = date; d < today; d = shift(d, 1)) if (days.includes(weekday(d))) count++;
  return -count;
}

// ─────────────────────────── Estado do prazo da OS ───────────────────────────

/** Fatos gravados de uma OS que alimentam a regra (coletados pela API em lote). */
export interface DeadlineFacts {
  status: 'ABERTA' | 'CANCELADA';
  promisedDate: string | null;
  /** Peças ativas: fora DEVOLVIDA e CANCELADA. */
  pieces: {
    stage: string;
    /** Entrega ativa da peça (a última vinculada), se houver. */
    delivery: { status: string; scheduledDate: string } | null;
    /** Tipo da ocorrência logística da entrega frustrada (contexto), se houver. */
    frustrationKind: string | null;
  }[];
  /** Tem item de planejamento ou alguma tarefa não cancelada. */
  planned: boolean;
  /** Alguma tarefa iniciada (início registrado, em execução, pausada ou concluída). */
  started: boolean;
  /** Tarefa aberta com bloqueio não rotineiro, ocorrência que bloqueia ou pausa por impedimento. */
  blocked: boolean;
  /** Situação gravada dos materiais da OS. */
  materialsReadiness: string;
}

export interface ServiceDeadline {
  state: DeadlineState;
  promisedDate: string | null;
  /** Ver `workingDaysUntil`; null sem prazo. */
  workingDays: number | null;
  reasons: DeadlineReason[];
  /** Contexto conhecido (ex.: "Cliente indisponível para entrega."). */
  context: string[];
}

/** Prontidão de materiais que ainda segura a OS (mesma regra do motivo MATERIAIS e do Início). */
export const MATERIALS_PENDING_STATES = [
  'AGUARDANDO_COMPRA',
  'AGUARDANDO_RECEBIMENTO',
  'PARCIALMENTE_DISPONIVEL',
  'COM_DIVERGENCIA',
] as const;
const MATERIALS_PENDING = new Set<string>(MATERIALS_PENDING_STATES);
const FRUSTRATION_CONTEXT: Record<string, string> = {
  CLIENTE_INDISPONIVEL: 'Cliente indisponível para entrega.',
  ENDERECO_INCORRETO: 'Endereço de entrega incorreto.',
  ATRASO_TRANSPORTE: 'Atraso no transporte.',
  PECA_DANIFICADA: 'Peça danificada na entrega.',
  INSTALACAO_INCOMPLETA: 'Instalação incompleta.',
  DIVERGENCIA: 'Divergência na entrega.',
};

/** Motivos objetivos (na ordem de exibição), só a partir dos fatos gravados. */
export function deadlineReasons(f: DeadlineFacts): DeadlineReason[] {
  const pending = f.pieces.filter((p) => p.stage !== 'ENTREGUE');
  const r = new Set<DeadlineReason>();
  const inProduction = pending.some((p) => p.stage === 'EM_PRODUCAO');
  if (inProduction && !f.planned) r.add('NAO_PLANEJADA');
  else if (inProduction && !f.started) r.add('PRODUCAO_NAO_INICIADA');
  if (f.blocked || pending.some((p) => p.stage === 'BLOQUEIO_EXPEDICAO')) r.add('BLOQUEADA');
  if (inProduction && MATERIALS_PENDING.has(f.materialsReadiness)) r.add('MATERIAIS');
  if (pending.some((p) => p.stage === 'EM_CORRECAO')) r.add('EM_CORRECAO');
  for (const p of pending) {
    if (p.delivery?.status === 'FRUSTRADA') r.add('ENTREGA_FRUSTRADA');
    else if (p.stage === 'PRONTA_ENTREGA') r.add('PRONTA_SEM_ENTREGA');
    if (
      f.promisedDate &&
      p.delivery?.status === 'AGENDADA' &&
      p.delivery.scheduledDate > f.promisedDate
    )
      r.add('ENTREGA_DEPOIS_DO_PRAZO');
  }
  return DEADLINE_REASONS.filter((x) => r.has(x));
}

/**
 * Estado do prazo da OS:
 * - ENCERRADA: cancelada, ou sem peça ativa por entregar;
 * - SEM_PRAZO: sem prazo prometido (dados antigos continuam válidos, nunca "atrasados");
 * - ATRASADO: prazo < hoje (crítico, com ou sem motivo; os motivos viram explicação);
 * - EM_RISCO: prazo até o 5º dia útil e ao menos um motivo objetivo;
 * - PROXIMO: prazo até o 5º dia útil, sem motivo;
 * - NO_PRAZO: além da janela.
 */
export function serviceDeadline(
  f: DeadlineFacts,
  today: string,
  workingDays: readonly number[],
): ServiceDeadline {
  const pending = f.pieces.filter((p) => p.stage !== 'ENTREGUE');
  const base = { promisedDate: f.promisedDate, reasons: [], context: [] };
  if (f.status !== 'ABERTA' || !pending.length)
    return { ...base, state: 'ENCERRADA', workingDays: null };
  if (!f.promisedDate) return { ...base, state: 'SEM_PRAZO', workingDays: null };
  const days = workingDaysUntil(today, f.promisedDate, workingDays);
  const overdue = f.promisedDate < today;
  const inWindow = !overdue && f.promisedDate <= deadlineWindowEnd(today, workingDays);
  if (!overdue && !inWindow) return { ...base, state: 'NO_PRAZO', workingDays: days };
  const reasons = deadlineReasons(f);
  const context = [
    ...new Set(
      pending
        .map((p) => (p.delivery?.status === 'FRUSTRADA' ? p.frustrationKind : null))
        .filter((k): k is string => Boolean(k))
        .map((k) => FRUSTRATION_CONTEXT[k] ?? 'Entrega frustrada.'),
    ),
  ];
  return {
    state: overdue ? 'ATRASADO' : reasons.length ? 'EM_RISCO' : 'PROXIMO',
    promisedDate: f.promisedDate,
    workingDays: days,
    reasons,
    context,
  };
}

// ─────────────────────────── Pedido: peças ainda não recebidas ───────────────────────────

export const ORDER_DEADLINE_STATES = ['PRAZO_VENCIDO', 'PRAZO_PROXIMO'] as const;
export type OrderDeadlineState = (typeof ORDER_DEADLINE_STATES)[number];
export const ORDER_DEADLINE_LABEL: Record<OrderDeadlineState, string> = {
  PRAZO_VENCIDO: 'Prazo vencido',
  PRAZO_PROXIMO: 'Prazo próximo',
};

/**
 * Atenção do PEDIDO antes da OS existir: prazo prometido dentro da janela (ou vencido) e peças
 * que ainda deveriam chegar à oficina. Nunca classifica uma OS inexistente como atrasada; a
 * retirada não é reorganizada (só alerta). Sem peça faltando, ou fora da janela: nada.
 */
export function orderDeadline(
  o: { status: string; promisedDate: string | null; missingPieces: number },
  today: string,
  workingDays: readonly number[],
): OrderDeadlineState | null {
  if (o.status === 'CANCELADO' || !o.promisedDate || o.missingPieces <= 0) return null;
  if (o.promisedDate < today) return 'PRAZO_VENCIDO';
  return o.promisedDate <= deadlineWindowEnd(today, workingDays) ? 'PRAZO_PROXIMO' : null;
}
