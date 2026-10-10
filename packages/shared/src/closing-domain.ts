/**
 * Evolução, Fase 7 — fechamento semanal geral (tapeceiros + logística). Regras puras.
 *
 * COMPETÊNCIA (política explícita):
 * - Semana = segunda 00:00 a domingo 23:59:59 no fuso da oficina.
 * - Um item entra no fechamento da semana em que se tornou DEVIDO: liberação da mão de obra
 *   (`eligible_at`) ou realização da viagem/autorização da taxa (`due_at`), em data local.
 * - Item devido antes da semana e ainda com saldo no início dela aparece como SALDO ANTERIOR
 *   (identificado), pelo valor em aberto no início da semana — nunca pelo valor cheio de novo.
 * - Pagamentos contam pela data efetiva (`paid_at`, data local): os da semana abatem o saldo da
 *   semana; os posteriores aparecem como "pago depois" e reduzem o saldo anterior da próxima
 *   semana. Pagamento estornado não conta em período algum (o estorno fica no histórico).
 * - Previsto, aguardando qualidade e em revisão são a situação ATUAL e nunca entram no pagável.
 */
export const CLOSING_CATEGORIES = ['TAPECARIA', 'LOGISTICA'] as const;
export type ClosingCategory = (typeof CLOSING_CATEGORIES)[number];
export const CLOSING_CATEGORY_LABEL: Record<ClosingCategory, string> = {
  TAPECARIA: 'Tapeçaria',
  LOGISTICA: 'Logística',
};

export const CLOSING_ITEM_STATES = [
  'PREVISTO',
  'AGUARDANDO_QUALIDADE',
  'EM_REVISAO',
  'PENDENTE_CONFIGURACAO',
  'DEVIDO',
] as const;
export type ClosingItemState = (typeof CLOSING_ITEM_STATES)[number];
export const CLOSING_ITEM_STATE_LABEL: Record<ClosingItemState, string> = {
  PREVISTO: 'Previsto (em execução / agendado)',
  AGUARDANDO_QUALIDADE: 'Concluído, aguardando qualidade',
  EM_REVISAO: 'Em revisão financeira',
  PENDENTE_CONFIGURACAO: 'Devido sem recebedor ativo',
  DEVIDO: 'Liberado / devido',
};

/** Segunda-feira da semana de uma data (AAAA-MM-DD). */
export function closingWeekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const closingWeekEnd = (weekStart: string) => {
  const d = new Date(`${weekStart}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
};
export const isMonday = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(`${iso}T12:00:00Z`).getUTCDay() === 1;

export interface ClosingPaymentLine {
  amountCents: number;
  /** Data local do pagamento (AAAA-MM-DD). */
  paidAt: string;
  reversed: boolean;
}

export interface ClosingFigures {
  /** WEEK: devido na semana; PREVIOUS: saldo anterior; null: fora deste fechamento. */
  bucket: 'WEEK' | 'PREVIOUS' | null;
  /** Devido considerado neste fechamento (devido − pago antes do início da semana). */
  dueCents: number;
  paidInWeekCents: number;
  openAtEndCents: number;
  paidAfterCents: number;
  /** Saldo atual (devido − todos os pagamentos não estornados). */
  currentOpenCents: number;
}

/** Números de um item DEVIDO dentro do fechamento [weekStart, weekEnd] (datas locais). */
export function closingFigures(
  item: { dueCents: number; competence: string; payments: readonly ClosingPaymentLine[] },
  weekStart: string,
  weekEnd: string,
): ClosingFigures {
  const valid = item.payments.filter((p) => !p.reversed);
  const sum = (f: (p: ClosingPaymentLine) => boolean) =>
    valid.filter(f).reduce((a, p) => a + p.amountCents, 0);
  const paidBefore = sum((p) => p.paidAt < weekStart);
  const paidInWeek = sum((p) => p.paidAt >= weekStart && p.paidAt <= weekEnd);
  const paidAfter = sum((p) => p.paidAt > weekEnd);
  const current = Math.max(0, item.dueCents - paidBefore - paidInWeek - paidAfter);
  const startOpen = Math.max(0, item.dueCents - paidBefore);
  let bucket: ClosingFigures['bucket'] = null;
  if (item.competence >= weekStart && item.competence <= weekEnd) bucket = 'WEEK';
  else if (item.competence < weekStart && startOpen > 0) bucket = 'PREVIOUS';
  return {
    bucket,
    dueCents: bucket ? startOpen : 0,
    paidInWeekCents: bucket ? Math.min(paidInWeek, startOpen) : 0,
    openAtEndCents: bucket ? Math.max(0, startOpen - paidInWeek) : 0,
    paidAfterCents: bucket ? paidAfter : 0,
    currentOpenCents: current,
  };
}

/**
 * Distribui um pagamento externo (Pix) pelas obrigações em aberto, da mais antiga para a mais
 * nova (competência, depois código). Nunca passa do saldo; sobra = erro do chamador.
 */
export function allocateClosingPayment<T extends { id: string; openCents: number; order: string }>(
  amountCents: number,
  items: readonly T[],
): { parts: { item: T; amountCents: number }[]; leftoverCents: number } {
  const ordered = [...items]
    .filter((i) => i.openCents > 0)
    .sort((a, b) => a.order.localeCompare(b.order));
  let rest = amountCents;
  const parts: { item: T; amountCents: number }[] = [];
  for (const item of ordered) {
    if (rest <= 0) break;
    const take = Math.min(rest, item.openCents);
    parts.push({ item, amountCents: take });
    rest -= take;
  }
  return { parts, leftoverCents: rest };
}
