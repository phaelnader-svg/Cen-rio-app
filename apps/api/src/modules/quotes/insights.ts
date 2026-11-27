/**
 * Etapa 3 da lista de 53 (2026-11-27):
 * - Item 12: data de entrega sugerida pela fila da oficina (o que já está na frente e quanto a
 *   oficina termina por semana, pelo histórico real do tablet).
 * - Item 18: lucro por tipo de peça (pelos orçamentos que viraram serviço, menos o gasto extra dos
 *   retrabalhos). Só para quem vê o financeiro.
 */
import {
  PIECE_TYPE_LABEL,
  addBusinessDays,
  type DeliverySuggestionDto,
  type PieceProfitDto,
  type PieceType,
  type QuoteSnapshot,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deadlineCalendar } from '../deadlines/service';

const VIEW = {
  session: 'WEB',
  anyPermissions: ['orcamentos.ver', 'orcamentos.gerenciar'],
} as const;
const FIN_VIEW = { session: 'WEB', permissions: ['financeiro.ver'] } as const;
const DAY_MS = 86_400_000;
/** Semanas de histórico usadas para medir quanto a oficina termina. */
const HISTORY_WEEKS = 8;

export async function quoteInsightRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/quotes/delivery-suggestion', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({ pieces: z.coerce.number().int().min(1).max(200).default(1) })
      .parse(request.query);
    const cal = await deadlineCalendar(prisma);
    const since = new Date(Date.now() - HISTORY_WEEKS * 7 * DAY_MS);
    const [done, inShop, waiting] = await Promise.all([
      // Peças terminadas: todas as tarefas concluídas, a última nas últimas semanas.
      prisma.serviceOrderItem.aggregate({
        _sum: { quantity: true },
        where: {
          serviceOrder: { status: { not: 'CANCELADA' } },
          productionTasks: {
            some: { completedAt: { gte: since } },
            none: { status: { notIn: ['CONCLUIDA', 'CANCELADA'] } },
          },
        },
      }),
      // Na frente: peças das OS abertas que ainda estão em produção.
      prisma.serviceOrderItem.aggregate({
        _sum: { quantity: true },
        where: { serviceOrder: { status: 'ABERTA' }, fulfillmentStage: 'EM_PRODUCAO' },
      }),
      // E os pedidos aprovados que ainda não viraram OS.
      prisma.commercialOrderItem.aggregate({
        _sum: { quantity: true },
        where: {
          order: { status: { not: 'CANCELADO' }, serviceOrders: { none: { status: 'ABERTA' } } },
          serviceOrderItems: { none: {} },
        },
      }),
    ]);
    const weekly = (done._sum.quantity ?? 0) / HISTORY_WEEKS;
    const ahead = (inShop._sum.quantity ?? 0) + (waiting._sum.quantity ?? 0);
    const perWeek = cal.workingDays.length || 5;
    if (weekly < 0.5) {
      const out: DeliverySuggestionDto = {
        aheadPieces: ahead,
        weeklyPieces: Math.round(weekly * 10) / 10,
        businessDays: null,
        date: null,
      };
      return out;
    }
    const queueDays = Math.ceil((ahead / weekly) * perWeek);
    const jobDays = Math.max(2, Math.ceil((q.pieces / weekly) * perWeek));
    const businessDays = Math.min(365, queueDays + jobDays);
    const out: DeliverySuggestionDto = {
      aheadPieces: ahead,
      weeklyPieces: Math.round(weekly * 10) / 10,
      businessDays,
      date: addBusinessDays(cal.today, businessDays, cal.workingDays),
    };
    return out;
  });

  app.get('/api/v1/reports/profit-by-piece', { config: { access: FIN_VIEW } }, async (request) => {
    const q = z
      .object({ months: z.coerce.number().int().min(1).max(36).default(12) })
      .parse(request.query);
    const since = new Date(Date.now() - q.months * 30 * DAY_MS);
    const quotes = await prisma.quote.findMany({
      where: { deletedAt: null, orderId: { not: null }, createdAt: { gte: since } },
      select: { orderId: true, snapshot: true },
    });
    const orderIds = quotes.map((x) => x.orderId!);
    const [orders, reworks] = await Promise.all([
      prisma.commercialOrder.findMany({
        where: { id: { in: orderIds }, status: { not: 'CANCELADO' } },
        select: { id: true, items: { select: { pieceType: true, quantity: true } } },
      }),
      prisma.rework.findMany({
        where: { originalOrderId: { in: orderIds }, cancelledAt: null },
        select: { originalOrderId: true, extraCostCents: true },
      }),
    ]);
    const byOrder = new Map(orders.map((o) => [o.id, o]));
    const rows = new Map<
      PieceType,
      { pieces: number; services: Set<string>; revenue: number; profit: number; reworks: number }
    >();
    for (const qt of quotes) {
      const o = byOrder.get(qt.orderId!);
      if (!o || o.items.length === 0) continue;
      const t = (qt.snapshot as unknown as QuoteSnapshot).totals;
      if (!t) continue;
      const extra = reworks
        .filter((r) => r.originalOrderId === o.id)
        .reduce((a, r) => a + r.extraCostCents, 0);
      const count = reworks.filter((r) => r.originalOrderId === o.id).length;
      const totalQty = o.items.reduce((a, i) => a + Math.max(1, i.quantity), 0);
      for (const i of o.items) {
        const share = Math.max(1, i.quantity) / totalQty;
        const row = rows.get(i.pieceType) ?? {
          pieces: 0,
          services: new Set<string>(),
          revenue: 0,
          profit: 0,
          reworks: 0,
        };
        row.pieces += Math.max(1, i.quantity);
        row.services.add(o.id);
        row.revenue += (t.totalCents - t.taxCents) * share;
        row.profit += (t.profitCents - extra) * share;
        row.reworks += count * share;
        rows.set(i.pieceType, row);
      }
    }
    const items: PieceProfitDto[] = [...rows.entries()]
      .map(([type, r]) => ({
        pieceType: type,
        label: PIECE_TYPE_LABEL[type],
        pieces: r.pieces,
        services: r.services.size,
        revenueCents: Math.round(r.revenue),
        profitCents: Math.round(r.profit),
        profitPerPieceCents: Math.round(r.profit / Math.max(1, r.pieces)),
        marginPct: r.revenue > 0 ? Math.round((r.profit / r.revenue) * 1000) / 10 : null,
        reworks: Math.round(r.reworks),
      }))
      .sort((a, b) => b.profitPerPieceCents - a.profitPerPieceCents);
    return { months: q.months, items };
  });
}
