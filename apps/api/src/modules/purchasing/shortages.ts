import {
  q3,
  specKey,
  stockItemCode,
  stockPurchaseSuggestion,
  type MaterialUnit,
  type PurchaseShortageDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serviceOrderCode } from '../commercial/common';
import { serviceDeadlines } from '../deadlines/service';
import {
  PURCHASE_VIEW,
  canSeePrices,
  num,
  requirementsWithProgress,
  specOf,
  stockSpecKey,
} from './common';
import { sortByDeadline, toNeedDto } from './purchase-orders';

type Db = Tx | PrismaClient;

/** Pedidos de compra que ainda podem trazer material (rascunho conta como intenção — D10). */
const OPEN_PO = ['RASCUNHO', 'CONFIRMADO', 'PARCIALMENTE_RECEBIDO'] as const;
const WAITING_TASK = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];

/**
 * Compra para o estoque ainda pendente e sem destino: o que falta chegar de cada item de estoque
 * menos a parte alocada a OS ABERTAS (a alocação de OS cancelada volta a ser compra livre — V8).
 */
async function freePendingByStockItem(db: Db, stockItemIds: string[]) {
  const out = new Map<string, number>();
  if (!stockItemIds.length) return out;
  const items = await db.purchaseOrderItem.findMany({
    where: {
      stockItemId: { in: stockItemIds },
      sourcing: 'ESTOQUE',
      purchaseOrder: { status: { in: [...OPEN_PO] } },
    },
    include: {
      purchaseOrder: { select: { status: true } },
      allocations: {
        include: { serviceOrder: { select: { status: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  for (const i of items) {
    const draft = i.purchaseOrder.status === 'RASCUNHO';
    const received = draft ? 0 : num(i.receivedQuantity);
    const expected = draft
      ? num(i.quantity)
      : Math.max(received, num(i.quantity) - num(i.closedQuantity));
    const pending = Math.max(0, expected - received);
    let before = 0;
    let allocatedPending = 0;
    for (const a of i.allocations) {
      const qty = num(a.quantity);
      const orderedShare = Math.min(qty, Math.max(0, expected - before));
      const receivedShare = Math.min(qty, Math.max(0, received - before));
      before += qty;
      if (a.serviceOrder.status === 'ABERTA') allocatedPending += orderedShare - receivedShare;
    }
    const free = q3(Math.max(0, pending - allocatedPending));
    out.set(i.stockItemId!, q3((out.get(i.stockItemId!) ?? 0) + free));
  }
  return out;
}

/**
 * "A comprar" consolidado: uma linha por especificação, a falta de cada OS dentro dela e a
 * sugestão de compra. Usa a mesma regra da prontidão (`requirementsWithProgress`). Só leitura:
 * nada é reservado, transferido ou comprado aqui.
 */
export async function purchaseShortages(
  db: Db,
  opts: { prices: boolean },
): Promise<PurchaseShortageDto[]> {
  const rows = sortByDeadline(
    await requirementsWithProgress(db, { serviceOrder: { status: 'ABERTA' } }),
  );
  if (!rows.length) return [];
  const osIds = [...new Set(rows.map(({ r }) => r.serviceOrderId))];
  const keyOf = (r: (typeof rows)[number]['r']) => {
    const spec = specOf(r, (r.unitCode ?? 'UNIDADE') as MaterialUnit);
    return r.sourcing === 'ESTOQUE' ? `E|${stockSpecKey(spec)}` : `X|${specKey(spec)}`;
  };
  const stockKeys = [
    ...new Set(rows.filter(({ r }) => r.sourcing === 'ESTOQUE').map(({ r }) => keyOf(r).slice(2))),
  ];
  const [stockItems, deadlines, tasks, leftovers] = await Promise.all([
    db.stockItem.findMany({ where: { specKey: { in: stockKeys } } }),
    serviceDeadlines(db, { id: { in: osIds } }),
    db.productionTask.findMany({
      where: {
        serviceOrderId: { in: osIds },
        status: { in: WAITING_TASK as never },
        blockers: { has: 'MATERIAIS' },
      },
      select: { serviceOrderId: true, materials: { select: { requirementId: true } } },
    }),
    db.materialLeftover.findMany({
      where: { status: 'DISPONIVEL', reusable: true },
      include: { serviceOrder: { select: { id: true, number: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const stockByKey = new Map(stockItems.map((s) => [s.specKey, s]));
  const freePending = await freePendingByStockItem(
    db,
    stockItems.map((s) => s.id),
  );
  const leftoverKey = (s: Parameters<typeof specOf>[0], unit: MaterialUnit) =>
    specKey({ ...specOf({ ...s, lengthCm: null, widthCm: null }, unit) });

  const groups = new Map<string, PurchaseShortageDto>();
  for (const { r, p } of rows) {
    // Só o que ainda não está disponível para a OS (o resto não precisa de ação de compra).
    if (q3(p.covered) >= q3(p.need)) continue;
    const key = keyOf(r);
    const unit = (r.unitCode ?? 'UNIDADE') as MaterialUnit;
    const blocks = tasks.some(
      (t) =>
        t.serviceOrderId === r.serviceOrderId &&
        (t.materials.length === 0 || t.materials.some((m) => m.requirementId === r.id)),
    );
    let g = groups.get(key);
    if (!g) {
      const stock = r.sourcing === 'ESTOQUE' ? (stockByKey.get(key.slice(2)) ?? null) : null;
      const available = stock ? q3(num(stock.onHand) - num(stock.reserved)) : 0;
      const spec =
        r.sourcing === 'ESTOQUE'
          ? { ...specOf(r, unit), color: null, reference: null }
          : specOf(r, unit);
      const lk = leftoverKey(r, unit);
      g = {
        key,
        ...spec,
        sourcing: r.sourcing,
        need: 0,
        covered: 0,
        inPurchase: 0,
        awaiting: 0,
        inDraft: 0,
        shortfall: 0,
        freeStock: r.sourcing === 'ESTOQUE' ? (stock?.active === false ? 0 : available) : null,
        freePending: stock ? (freePending.get(stock.id) ?? 0) : 0,
        suggestion: 0,
        stockItem: stock ? { id: stock.id, code: stockItemCode(stock.number), available } : null,
        leftovers:
          r.sourcing === 'EXCLUSIVO_OS'
            ? leftovers
                .filter((l) => leftoverKey(l, l.unit) === lk)
                .map((l) => ({
                  id: l.id,
                  serviceOrder: {
                    id: l.serviceOrder.id,
                    code: serviceOrderCode(l.serviceOrder.number),
                  },
                  quantity: num(l.quantity),
                  location: l.location,
                }))
            : [],
        blocksProduction: false,
        rows: [],
      };
      groups.set(key, g);
    }
    g.need = q3(g.need + p.need);
    g.covered = q3(g.covered + p.covered);
    g.awaiting = q3(g.awaiting + p.awaiting);
    g.inDraft = q3(
      g.inDraft + Math.min(p.purchasedDraft, Math.max(0, p.need - p.covered - p.awaiting)),
    );
    g.shortfall = q3(g.shortfall + p.shortfall);
    g.blocksProduction ||= blocks;
    g.rows.push({
      ...toNeedDto(r, p, opts.prices),
      deadlineState: deadlines.get(r.serviceOrderId)?.state ?? 'SEM_PRAZO',
      blocksProduction: blocks,
    });
  }
  for (const g of groups.values()) {
    g.inPurchase = q3(g.awaiting + g.inDraft);
    // Sobras não descontam (V2): continuam só como sugestão a conferir.
    g.suggestion =
      g.sourcing === 'ESTOQUE'
        ? stockPurchaseSuggestion({
            shortfall: g.shortfall,
            freeStock: g.freeStock ?? 0,
            freePending: g.freePending,
          })
        : g.shortfall;
  }
  return [...groups.values()];
}

export async function shortageRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get(
    '/api/v1/purchasing/shortages',
    { config: { access: PURCHASE_VIEW } },
    async (request) => {
      z.object({}).passthrough().parse(request.query);
      return purchaseShortages(prisma, { prices: canSeePrices(request) });
    },
  );
}
