/**
 * Relatório da semana (Gerente, 2026-11-25): os últimos 7 dias em números que importam —
 * quanto fechou (e o mesmo período do ano passado), quanto entrou e saiu, o lucro por serviço,
 * os orçamentos, o que está atrasado para receber e o que vem na semana que vem. Usa o mesmo
 * cálculo do Resumo do financeiro; no domingo, às 18 h, o dono recebe o aviso no sininho.
 */
import { SERVICE_TYPE_LABEL, type OfficeWeekDto, type ServiceType } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { billsDue } from '../finance/bills';
import { period, shopTimezone, todayIso } from '../finance/common';
import { dashboard } from '../finance/results';
import { notifyUsersWith } from '../quality/common';

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const lastYear = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });

export async function officeWeek(prisma: PrismaClient, today?: string): Promise<OfficeWeekDto> {
  const tz = await shopTimezone(prisma);
  const to = today ?? todayIso(tz);
  const from = addDays(to, -6);
  return prisma.$transaction(
    async (tx) => {
      const d = await dashboard(tx, SYSTEM, { from, to });
      const lp = period({ from: lastYear(from), to: lastYear(to) }, tz);
      const ly = await tx.commercialOrder.findMany({
        where: {
          status: { not: 'CANCELADO' },
          createdAt: { gte: lp.fromTs, lt: lp.toExclusive },
        },
        select: { agreedValueCents: true },
      });
      const fromTs = period({ from, to }, tz).fromTs;
      const [quotesSent, quotesApproved, next, deliveries] = await Promise.all([
        tx.quote.count({ where: { deletedAt: null, createdAt: { gte: fromTs } } }),
        tx.quote.count({
          where: { deletedAt: null, status: 'APROVADO', statusChangedAt: { gte: fromTs } },
        }),
        billsDue(tx, to, 7),
        tx.delivery.count({
          where: {
            status: { in: ['PROVISORIA', 'AGENDADA'] },
            scheduledDate: {
              gt: new Date(`${to}T00:00:00Z`),
              lte: new Date(`${addDays(to, 7)}T00:00:00Z`),
            },
          },
        }),
      ]);
      const upcoming = next.upcoming.filter((b) => b.days >= 0 && b.days <= 7);
      return {
        from,
        to,
        contractedCents: d.accrual.contractedCents,
        contractedOrders: d.accrual.contractedOrders,
        lastYearContractedCents: ly.length
          ? ly.reduce((a, o) => a + (o.agreedValueCents ?? 0), 0)
          : null,
        receivedCents: d.cash.receivedCents,
        paidCents: d.cash.paidPayablesCents + d.cash.paidLaborCents,
        cashNetCents: d.cash.netCents,
        completedOrders: d.accrual.completedOrders,
        marginCents: d.accrual.contributionMarginCents,
        services: d.topServices.slice(0, 5).map((s) => ({
          label: SERVICE_TYPE_LABEL[s.serviceType as ServiceType] ?? s.serviceType,
          orders: s.orders,
          revenueCents: s.revenueCents,
          marginCents: s.marginCents,
        })),
        quotesSent,
        quotesApproved,
        receivableOverdueCents: d.open.receivableOverdueCents,
        nextWeek: {
          billsCount: upcoming.length,
          billsCents: upcoming.reduce((a, b) => a + b.openCents, 0),
          deliveries,
        },
        reworks: d.reworks.count,
      };
    },
    { timeout: 30_000 },
  );
}

/** Domingo, a partir das 18 h: um aviso curto no sininho; o relatório completo abre no Escritório. */
export async function weeklyReportNotice(prisma: PrismaClient, today: string) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (weekday !== 0) return false;
  const w = await officeWeek(prisma, today);
  const body = [
    `Semana: fechou ${brl(w.contractedCents)}`,
    `entrou ${brl(w.receivedCents)}`,
    `saiu ${brl(w.paidCents)}`,
    w.completedOrders ? `lucro das OS entregues ${brl(w.marginCents)}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  await prisma.$transaction((tx) =>
    notifyUsersWith(
      tx,
      SYSTEM,
      'financeiro.ver',
      'AGENTES_SEMANA',
      `AGENTES_SEMANA:${today}`,
      `${body}. Toque para ver o relatório.`.slice(0, 300),
    ),
  );
  return true;
}
