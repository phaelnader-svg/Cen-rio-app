/**
 * Contas a pagar vencidas e a vencer (2026-11-18): o bloco do Resumo do financeiro e o aviso do
 * sininho usam a mesma lista. Só leitura.
 */
import { BILL_UPCOMING_DAYS, payableCode, type BillDueDto } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { dateOnly, parseDate } from './common';

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Contas abertas vencidas (mais antigas primeiro) e as que vencem de hoje até `days` dias. */
export async function billsDue(
  db: PrismaClient | Tx,
  today: string,
  days: number = BILL_UPCOMING_DAYS,
): Promise<{ overdue: BillDueDto[]; upcoming: BillDueDto[] }> {
  const rows = await db.accountPayable.findMany({
    where: {
      status: { in: ['ABERTO', 'PARCIAL'] },
      dueDate: { lte: parseDate(plusDays(today, days)) },
    },
    orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    take: 200,
  });
  const list = rows
    .map((r) => {
      const dueDate = dateOnly(r.dueDate)!;
      return {
        id: r.id,
        code: payableCode(r.number),
        beneficiary: r.beneficiary,
        description: r.description,
        category: r.category,
        openCents: r.amountCents - r.paidCents,
        dueDate,
        days: daysBetween(today, dueDate),
      };
    })
    .filter((b) => b.openCents > 0);
  return { overdue: list.filter((b) => b.days < 0), upcoming: list.filter((b) => b.days >= 0) };
}
