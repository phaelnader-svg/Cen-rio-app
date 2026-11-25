/**
 * Financeiro do Escritório (2026-11-25): previsão do caixa das próximas 4 semanas, lembrete do
 * DAS do mês e aviso do pacote do contador. Tudo a partir dos registros oficiais (contas a receber,
 * contas a pagar, maquininha); nada é lançado sozinho.
 */
import type { OfficeForecastDto } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { brl } from '../office/common';
import { monthClosing } from '../office/closing';
import { notifyUsersWith } from '../quality/common';

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const d10 = (d: Date) => d.toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Semanas de segunda a domingo, a partir da semana de hoje. */
export async function cashForecast(
  db: PrismaClient,
  today: string,
  weeks = 4,
): Promise<OfficeForecastDto> {
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = addDays(today, -((wd + 6) % 7));
  const end = addDays(monday, weeks * 7 - 1);
  const [rec, pay, cards] = await Promise.all([
    db.customerReceivable.findMany({
      where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lte: at(end) } },
      include: { customer: { select: { name: true } } },
    }),
    db.accountPayable.findMany({
      where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lte: at(end) } },
    }),
    db.cardSettlement.findMany({
      where: { settledAt: null, expectedDate: { gte: at(today), lte: at(end) } },
    }),
  ]);
  type Line = { label: string; amountCents: number; date: string };
  const ins: Line[] = [
    ...rec.map((r) => ({
      label: r.customer.name,
      amountCents: r.amountCents - r.receivedCents,
      date: r.dueDate ? d10(r.dueDate) : today,
    })),
    ...cards.map((c) => ({
      label: 'Maquininha',
      amountCents: c.netCents,
      date: d10(c.expectedDate),
    })),
  ].filter((l) => l.amountCents > 0);
  const outs: Line[] = pay
    .map((p) => ({
      label: p.beneficiary || p.description,
      amountCents: p.amountCents - p.paidCents,
      date: d10(p.dueDate),
    }))
    .filter((l) => l.amountCents > 0);
  const sum = (ls: Line[]) => ls.reduce((a, l) => a + l.amountCents, 0);
  const top = (ls: Line[]) => [...ls].sort((a, b) => b.amountCents - a.amountCents).slice(0, 4);
  return {
    today,
    overdueInCents: sum(ins.filter((l) => l.date < today)),
    overdueOutCents: sum(outs.filter((l) => l.date < today)),
    weeks: Array.from({ length: weeks }, (_, k) => {
      const from = addDays(monday, k * 7);
      const to = addDays(from, 6);
      // A semana de hoje conta só de hoje em diante (o vencido fica separado).
      const inWeek = (l: Line) => l.date >= (k === 0 ? today : from) && l.date <= to;
      const wi = ins.filter(inWeek);
      const wo = outs.filter(inWeek);
      return { from, to, inCents: sum(wi), outCents: sum(wo), ins: top(wi), outs: top(wo) };
    }),
  };
}

const TAX = /\b(das|simples nacional|imposto|impostos|guia)\b/i;

/**
 * Do dia 15 ao 20: lembra o DAS (Simples Nacional) se não houver, neste mês, nenhuma conta com
 * cara de imposto (DAS, Simples, imposto, guia). Um aviso por mês.
 */
export async function taxReminder(prisma: PrismaClient, today: string) {
  const day = Number(today.slice(8, 10));
  if (day < 15 || day > 20) return false;
  const month = today.slice(0, 7);
  const first = at(`${month}-01`);
  const next = new Date(first);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const bills = await prisma.accountPayable.findMany({
    where: { dueDate: { gte: first, lt: next }, status: { not: 'CANCELADO' } },
    select: { description: true, beneficiary: true, category: true },
  });
  if (bills.some((b) => TAX.test(`${b.description} ${b.beneficiary} ${b.category}`))) return false;
  const m = MONTHS[Number(month.slice(5, 7)) - 1];
  const when = day === 20 ? 'vence hoje' : `vence dia 20`;
  await prisma.$transaction((tx) =>
    notifyUsersWith(
      tx,
      SYSTEM,
      'financeiro.ver',
      'AGENTES_IMPOSTO',
      `AGENTES_IMPOSTO:${month}:${day === 20 ? 'hoje' : 'antes'}`,
      `O DAS de ${m} ${when}. Ainda não vi a conta lançada: se já pagou, lance a despesa para o caixa ficar certo.`,
    ),
  );
  return true;
}

/** Do dia 1 ao 5: o pacote do mês passado para o contador, com o que ainda falta. Um por mês. */
export async function accountantPackageNotice(prisma: PrismaClient, today: string) {
  const day = Number(today.slice(8, 10));
  if (day > 5) return false;
  const d = at(`${today.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d10(d).slice(0, 7);
  const c = await monthClosing(prisma, month);
  const m = MONTHS[Number(month.slice(5, 7)) - 1];
  const falta = c.pending.length
    ? ` Falta: ${c.pending
        .slice(0, 2)
        .map((p) => p.label.toLowerCase())
        .join('; ')}${c.pending.length > 2 ? ` e mais ${c.pending.length - 2}` : ''}.`
    : '';
  await prisma.$transaction((tx) =>
    notifyUsersWith(
      tx,
      SYSTEM,
      'financeiro.ver',
      'AGENTES_CONTADOR',
      `AGENTES_CONTADOR:${month}`,
      `Pacote de ${m} para o contador: entrou ${brl(c.totals.receivedCents)}, saiu ${brl(c.totals.paidCents)}.${falta}`.slice(
        0,
        300,
      ),
    ),
  );
  return true;
}
