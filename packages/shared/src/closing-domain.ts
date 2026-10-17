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
 * - R1 (DEC-7): mudança de valor DEPOIS de devido (ajuste, valor combinado corrigido) é um fato
 *   próprio, com competência na data em que foi feita: entra na semana dela (rastreável, com a
 *   obrigação de origem) e nunca reescreve a semana em que o valor ficou devido.
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
  /** Parte de `dueCents` que é saldo de semanas anteriores (o resto ficou devido nesta). */
  previousCents: number;
  paidInWeekCents: number;
  openAtEndCents: number;
  paidAfterCents: number;
  /** Saldo atual (devido − todos os pagamentos não estornados). */
  currentOpenCents: number;
}

/** Parcela do devido com a sua competência (data local): o valor ao ficar devido e cada mudança posterior. */
export interface DueComponent {
  competence: string;
  cents: number;
}

/** Números de um item DEVIDO dentro do fechamento [weekStart, weekEnd] (datas locais). */
export function closingFigures(
  item: { dueCents: number; competence: string; payments: readonly ClosingPaymentLine[] },
  weekStart: string,
  weekEnd: string,
): ClosingFigures {
  return closingTimelineFigures(
    {
      components: [{ competence: item.competence, cents: item.dueCents }],
      payments: item.payments,
    },
    weekStart,
    weekEnd,
  );
}

/**
 * Mesmas regras de `closingFigures` para um devido composto por parcelas com competências
 * diferentes (DEC-7): só o que tem competência até o fim da semana conta nela; uma mudança
 * posterior entra na semana em que foi feita (grupo da semana) e nunca altera a anterior.
 */
export function closingTimelineFigures(
  item: { components: readonly DueComponent[]; payments: readonly ClosingPaymentLine[] },
  weekStart: string,
  weekEnd: string,
): ClosingFigures & { totalDueCents: number } {
  const valid = item.payments.filter((p) => !p.reversed);
  const sum = (f: (p: ClosingPaymentLine) => boolean) =>
    valid.filter(f).reduce((a, p) => a + p.amountCents, 0);
  const due = (f: (c: DueComponent) => boolean) =>
    item.components.filter(f).reduce((a, c) => a + c.cents, 0);
  const paidBefore = sum((p) => p.paidAt < weekStart);
  const paidInWeek = sum((p) => p.paidAt >= weekStart && p.paidAt <= weekEnd);
  const paidAfter = sum((p) => p.paidAt > weekEnd);
  const dueBefore = due((c) => c.competence < weekStart);
  const dueInWeek = due((c) => c.competence >= weekStart && c.competence <= weekEnd);
  const dueAll = due(() => true);
  // A primeira parcela é o valor ao ficar devido (conta mesmo se zero); as demais, só se mudam.
  const inWeek = item.components.some(
    (c, i) => (i === 0 || c.cents !== 0) && c.competence >= weekStart && c.competence <= weekEnd,
  );
  const current = Math.max(0, dueAll - paidBefore - paidInWeek - paidAfter);
  const startOpen = Math.max(0, dueBefore - paidBefore);
  const considered = Math.max(0, dueBefore + dueInWeek - paidBefore);
  let bucket: ClosingFigures['bucket'] = null;
  if (inWeek) bucket = 'WEEK';
  else if (startOpen > 0) bucket = 'PREVIOUS';
  return {
    bucket,
    dueCents: bucket ? considered : 0,
    previousCents: bucket ? Math.min(startOpen, considered) : 0,
    paidInWeekCents: bucket ? Math.min(paidInWeek, considered) : 0,
    openAtEndCents: bucket ? Math.max(0, considered - paidInWeek) : 0,
    paidAfterCents: bucket ? paidAfter : 0,
    currentOpenCents: current,
    totalDueCents: Math.max(0, dueBefore + dueInWeek),
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
