/**
 * Quadro de Metas — regras puras do caixa (compartilhadas entre API, jogo e testes).
 * Semana financeira: segunda 00:00 a domingo 23:59 no horário de São Paulo.
 */

export const CASH_TZ = 'America/Sao_Paulo';

export type CashMoveKind = 'OPERACAO' | 'TRANSFERENCIA' | 'APORTE' | 'RETIRADA';

export interface CashMoveDto {
  id: string;
  /** Instante usado para ordenar e decidir semana/saldo inicial. */
  at: string;
  /** Data local (São Paulo) exibida. */
  date: string;
  accountId: string;
  accountLabel: string;
  amountCents: number;
  /** Operação, transferência entre contas incluídas, aporte ou retirada. */
  kind: CashMoveKind;
  category: string;
  description: string;
  /** De onde veio o número (para conferir no Cenário Gestão). */
  source: 'RECEBIMENTO' | 'PAGAMENTO_CONTA' | 'MAO_DE_OBRA' | 'EXTRATO' | 'MANUAL' | 'CARTAO';
  sourceLabel: string;
  links: {
    type: 'OS' | 'PEDIDO' | 'CONTA' | 'COMPRA' | 'MAO_DE_OBRA' | 'EXTRATO' | 'LANCAMENTO';
    id: string;
    label: string;
    href: string;
  }[];
  /** Estorno/correção de outro lançamento. */
  reversal: boolean;
  note: string | null;
}

/** Data local (AAAA-MM-DD) de um instante no fuso de São Paulo. */
export function spDate(at: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CASH_TZ }).format(new Date(at));
}

/** Instante de uma data/hora local de São Paulo (fuso fixo −03:00, sem horário de verão). */
export function spInstant(date: string, time = '00:00'): Date {
  return new Date(`${date}T${time}:00-03:00`);
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Segunda-feira da semana (São Paulo) de uma data local. */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return addDaysIso(date, -((d.getUTCDay() + 6) % 7));
}

export interface WeekFigures {
  weekStart: string;
  weekEnd: string;
  openingCents: number;
  closingCents: number;
  inCents: number;
  outCents: number;
  deltaCents: number;
  /** Variação sobre a abertura; null quando a abertura é zero ou negativa (não se aplica). */
  pct: number | null;
  /** Variação só da operação (sem aportes, retiradas e transferências). */
  operationalDeltaCents: number;
  contributionsCents: number;
  withdrawalsCents: number;
}

/** Números de uma semana a partir da abertura e dos movimentos dela (transferências não contam). */
export function weekFigures(
  weekStart: string,
  openingCents: number,
  moves: Pick<CashMoveDto, 'amountCents' | 'kind'>[],
): WeekFigures {
  const real = moves.filter((m) => m.kind !== 'TRANSFERENCIA');
  const inCents = real.filter((m) => m.amountCents > 0).reduce((s, m) => s + m.amountCents, 0);
  const outCents = real.filter((m) => m.amountCents < 0).reduce((s, m) => s - m.amountCents, 0);
  const deltaCents = inCents - outCents;
  const contributionsCents = real
    .filter((m) => m.kind === 'APORTE')
    .reduce((s, m) => s + m.amountCents, 0);
  const withdrawalsCents = real
    .filter((m) => m.kind === 'RETIRADA')
    .reduce((s, m) => s - m.amountCents, 0);
  return {
    weekStart,
    weekEnd: addDaysIso(weekStart, 6),
    openingCents,
    closingCents: openingCents + deltaCents,
    inCents,
    outCents,
    deltaCents,
    pct: openingCents > 0 ? Math.round((deltaCents / openingCents) * 10000) / 100 : null,
    operationalDeltaCents: deltaCents - contributionsCents + withdrawalsCents,
    contributionsCents,
    withdrawalsCents,
  };
}

export interface GoalView {
  id: string;
  name: string;
  targetCents: number;
  deadline: string | null;
  accountIds: string[];
  active: boolean;
  version: number;
  balanceCents: number;
  /** Saldo como proporção da meta (R$ 50 mil de R$ 100 mil = 50%). */
  pctOfGoal: number;
  missingCents: number;
  daysLeft: number | null;
  /** Evolução desde o início (saldo de partida → meta), rótulo próprio. */
  startCents: number;
  pctSinceStart: number | null;
  achieved: { at: string; balanceCents: number } | null;
  /** Conquistada e o saldo caiu abaixo do patamar depois. */
  belowAfterAchieved: boolean;
  /** Prazo vencido: saldo na data prevista. */
  atDeadline: { balanceCents: number; reached: boolean } | null;
}

export function goalView(
  g: {
    id: string;
    name: string;
    targetCents: number;
    deadline: string | null;
    accountIds: string[];
    active: boolean;
    version: number;
  },
  balanceCents: number,
  startCents: number,
  today: string,
  achieved: GoalView['achieved'],
  balanceAtDeadline: number | null,
): GoalView {
  const pctOfGoal = Math.round((balanceCents / g.targetCents) * 10000) / 100;
  const span = g.targetCents - startCents;
  const daysLeft = g.deadline
    ? Math.round(
        (Date.parse(`${g.deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000,
      )
    : null;
  return {
    ...g,
    balanceCents,
    pctOfGoal,
    missingCents: Math.max(0, g.targetCents - balanceCents),
    daysLeft,
    startCents,
    pctSinceStart: span > 0 ? Math.round(((balanceCents - startCents) / span) * 10000) / 100 : null,
    achieved,
    belowAfterAchieved: Boolean(achieved) && balanceCents < g.targetCents,
    atDeadline:
      g.deadline && daysLeft !== null && daysLeft < 0 && balanceAtDeadline !== null
        ? { balanceCents: balanceAtDeadline, reached: balanceAtDeadline >= g.targetCents }
        : null,
  };
}

export const brlCents = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const signedBrl = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${brlCents(Math.abs(c))}`;
export const signedPct = (p: number | null) =>
  p === null
    ? 'não se aplica'
    : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
