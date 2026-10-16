import { EVENT_TYPES, weightedAverageCents, type MaterialCostSummaryDto } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { financeEvent } from './common';

const num = (d: unknown) => Number(d ?? 0);
const ACTIVE_PO = ['CONFIRMADO', 'PARCIALMENTE_RECEBIDO', 'RECEBIDO'] as const;

/**
 * Custo médio ponderado de um item do estoque comum até um instante: lotes recebidos (aceitos,
 * líquidos de estornos) dos pedidos de compra com preço. Determinístico: o mesmo instante dá
 * sempre o mesmo custo, independentemente de quando o custo é lançado na OS.
 */
export async function stockAverageCost(db: Tx | PrismaClient, stockItemId: string, at: Date) {
  const lines = await db.materialReceiptLine.findMany({
    where: {
      item: { stockItemId, unitPriceCents: { not: null } },
      receipt: { receivedAt: { lte: at } },
    },
    include: {
      item: { select: { unitPriceCents: true } },
      reversals: { where: { createdAt: { lte: at } }, select: { quantity: true } },
    },
  });
  return weightedAverageCents(
    lines.map((l) => ({
      quantity: num(l.acceptedQuantity) - l.reversals.reduce((a, r) => a + num(r.quantity), 0),
      unitCents: l.item.unitPriceCents!,
    })),
  );
}

/** Preço unitário de origem de uma sobra: compra exclusiva da OS com o mesmo material. */
async function leftoverUnitCost(
  db: Tx | PrismaClient,
  leftover: { serviceOrderId: string; kind: string; description: string },
) {
  const items = await db.purchaseOrderItem.findMany({
    where: {
      serviceOrderId: leftover.serviceOrderId,
      sourcing: 'EXCLUSIVO_OS',
      kind: leftover.kind as never,
      unitPriceCents: { not: null },
      purchaseOrder: { status: { in: [...ACTIVE_PO] } },
    },
  });
  const same =
    items.find(
      (i) => i.description.trim().toLowerCase() === leftover.description.trim().toLowerCase(),
    ) ?? items[0];
  return same?.unitPriceCents ?? null;
}

type Entry = {
  serviceOrderId: string;
  source: string;
  sourceKey: string;
  description: string;
  quantity: number | null;
  unitCostCents: number | null;
  sign: 1 | -1;
  occurredAt: Date;
  note?: string | null;
};

/**
 * Razão de custos de material da OS (idempotente: a chave de origem impede duplicar o mesmo
 * fato). Fontes: compras exclusivas recebidas (e estornos), saídas de estoque para a OS e
 * devoluções ao estoque, transferências de sobras (sai da origem, entra no destino). Compra não
 * vira custo consumido sozinha: material comum só entra quando sai do estoque para a OS.
 */
export async function syncMaterialCosts(tx: Tx, actor: ActorContext, serviceOrderId: string) {
  const entries: Entry[] = [];
  const lines = await tx.materialReceiptLine.findMany({
    where: {
      item: { serviceOrderId, sourcing: 'EXCLUSIVO_OS' },
      receipt: { purchaseOrder: { status: { not: 'CANCELADO' } } },
    },
    include: { item: true, receipt: true, reversals: true },
  });
  for (const l of lines) {
    entries.push({
      serviceOrderId,
      source: 'COMPRA_EXCLUSIVA',
      sourceKey: `receipt_line:${l.id}`,
      description: l.item.description,
      quantity: num(l.acceptedQuantity),
      unitCostCents: l.item.unitPriceCents,
      sign: 1,
      occurredAt: l.receipt.receivedAt,
    });
    for (const r of l.reversals)
      entries.push({
        serviceOrderId,
        source: 'ESTORNO_COMPRA',
        sourceKey: `receipt_reversal:${r.id}`,
        description: `Estorno: ${l.item.description}`,
        quantity: num(r.quantity),
        unitCostCents: l.item.unitPriceCents,
        sign: -1,
        occurredAt: r.createdAt,
        note: r.reason,
      });
  }
  const movements = await tx.stockMovement.findMany({
    where: { serviceOrderId, type: { in: ['SAIDA_OS', 'AJUSTE_ENTRADA'] } },
    include: { stockItem: true },
  });
  for (const m of movements) {
    const out = m.type === 'SAIDA_OS';
    entries.push({
      serviceOrderId,
      source: out ? 'SAIDA_ESTOQUE' : 'DEVOLUCAO_ESTOQUE',
      sourceKey: `stock_movement:${m.id}`,
      description: m.stockItem.description,
      quantity: Math.abs(num(m.quantity)),
      unitCostCents: await stockAverageCost(tx, m.stockItemId, m.createdAt),
      sign: out ? 1 : -1,
      occurredAt: m.createdAt,
      note: m.reason,
    });
  }
  const transfers = await tx.materialLeftoverTransfer.findMany({
    where: { OR: [{ fromServiceOrderId: serviceOrderId }, { toServiceOrderId: serviceOrderId }] },
    include: { leftover: true },
  });
  for (const t of transfers) {
    const unit = await leftoverUnitCost(tx, t.leftover);
    if (t.fromServiceOrderId === serviceOrderId)
      entries.push({
        serviceOrderId,
        source: 'SOBRA_SAIDA',
        sourceKey: `leftover_transfer:${t.id}:out`,
        description: `Sobra transferida: ${t.leftover.description}`,
        quantity: num(t.quantity),
        unitCostCents: unit,
        sign: -1,
        occurredAt: t.createdAt,
        note: t.reason,
      });
    if (t.toServiceOrderId === serviceOrderId)
      entries.push({
        serviceOrderId,
        source: 'SOBRA_ENTRADA',
        sourceKey: `leftover_transfer:${t.id}:in`,
        description: `Sobra recebida: ${t.leftover.description}`,
        quantity: num(t.quantity),
        unitCostCents: unit,
        sign: 1,
        occurredAt: t.createdAt,
        note: t.reason,
      });
  }
  const known = new Set(
    (
      await tx.serviceOrderCost.findMany({
        where: { sourceKey: { in: entries.map((e) => e.sourceKey) } },
        select: { sourceKey: true },
      })
    ).map((r) => r.sourceKey),
  );
  const fresh = entries.filter((e) => !known.has(e.sourceKey));
  if (!fresh.length) return 0;
  await tx.serviceOrderCost.createMany({
    data: fresh.map((e) => ({
      serviceOrderId: e.serviceOrderId,
      category: 'MATERIAL',
      source: e.source,
      sourceKey: e.sourceKey,
      description: e.description.slice(0, 200),
      quantity: e.quantity,
      unitCostCents: e.unitCostCents,
      amountCents:
        e.unitCostCents === null || e.quantity === null
          ? 0
          : e.sign * Math.round(e.quantity * e.unitCostCents),
      priced: e.unitCostCents !== null,
      occurredAt: e.occurredAt,
      note: e.note?.slice(0, 500) ?? null,
      actorId: actor.userId,
    })),
    skipDuplicates: true,
  });
  await financeEvent(tx, actor, {
    entityType: 'service_order',
    entityId: serviceOrderId,
    kind: 'CUSTOS_ATUALIZADOS',
    note: `${fresh.length} lançamento(s) de material`,
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return fresh.length;
}

/** Sincroniza a razão de material de todas as OS com fatos de material (relatórios agregados). */
export async function syncAllMaterialCosts(tx: Tx, actor: ActorContext) {
  const [exclusive, movements, transfers] = await Promise.all([
    tx.purchaseOrderItem.findMany({
      where: {
        sourcing: 'EXCLUSIVO_OS',
        serviceOrderId: { not: null },
        receiptLines: { some: {} },
      },
      select: { serviceOrderId: true },
      distinct: ['serviceOrderId'],
    }),
    tx.stockMovement.findMany({
      where: { serviceOrderId: { not: null }, type: { in: ['SAIDA_OS', 'AJUSTE_ENTRADA'] } },
      select: { serviceOrderId: true },
      distinct: ['serviceOrderId'],
    }),
    tx.materialLeftoverTransfer.findMany({
      select: { fromServiceOrderId: true, toServiceOrderId: true },
    }),
  ]);
  const ids = new Set<string>();
  for (const r of [...exclusive, ...movements]) if (r.serviceOrderId) ids.add(r.serviceOrderId);
  for (const t of transfers) {
    ids.add(t.fromServiceOrderId);
    ids.add(t.toServiceOrderId);
  }
  for (const id of [...ids].sort()) await syncMaterialCosts(tx, actor, id);
}

/**
 * Reservas ATIVAS de OS já operacionalmente concluídas (todas as peças ativas entregues): o
 * consumo nunca foi confirmado e o material não entrou no custo (V5). Nada é consumido
 * automaticamente: o aviso some quando a reserva é entregue à OS ou liberada.
 */
export async function forgottenReservations(
  db: Tx | PrismaClient,
  where: { serviceOrderId?: string } = {},
) {
  const active = await db.stockReservation.findMany({
    where: {
      status: 'ATIVA',
      ...(where.serviceOrderId ? { serviceOrderId: where.serviceOrderId } : {}),
    },
    select: { id: true, serviceOrderId: true },
  });
  const delivered = await deliveredServiceOrders(db, [
    ...new Set(active.map((r) => r.serviceOrderId)),
  ]);
  return active.filter((r) => delivered.has(r.serviceOrderId));
}

/** OS cujas peças ativas (fora devolvidas/canceladas) foram todas entregues. */
export async function deliveredServiceOrders(db: Tx | PrismaClient, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const items = await db.serviceOrderItem.findMany({
    where: { serviceOrderId: { in: ids }, fulfillmentStage: { notIn: ['DEVOLVIDA', 'CANCELADA'] } },
    select: { serviceOrderId: true, fulfillmentStage: true },
  });
  const state = new Map<string, boolean>();
  for (const i of items)
    state.set(
      i.serviceOrderId,
      (state.get(i.serviceOrderId) ?? true) && i.fulfillmentStage === 'ENTREGUE',
    );
  return new Set([...state].filter(([, v]) => v).map(([k]) => k));
}

/** Previsto × comprado × reservado × consumido (sem duplicar: cada um é uma visão). */
export async function materialSummary(
  db: Tx | PrismaClient,
  serviceOrderId: string,
): Promise<MaterialCostSummaryDto> {
  const now = new Date();
  const reqs = await db.materialRequirement.findMany({
    where: { serviceOrderId, quantity: { not: null } },
    include: {
      allocations: { include: { item: { select: { unitPriceCents: true } } } },
      reservations: { select: { stockItemId: true } },
    },
  });
  const exclusive = await db.purchaseOrderItem.findMany({
    where: {
      serviceOrderId,
      sourcing: 'EXCLUSIVO_OS',
      purchaseOrder: { status: { in: [...ACTIVE_PO] } },
    },
  });
  let forecastCents = 0;
  let forecastUnpriced = 0;
  for (const r of reqs) {
    let unit =
      r.allocations.find((a) => a.item.unitPriceCents !== null)?.item.unitPriceCents ??
      exclusive.find(
        (e) =>
          e.unitPriceCents !== null &&
          e.description.trim().toLowerCase() === r.description.trim().toLowerCase(),
      )?.unitPriceCents ??
      null;
    if (unit === null && r.reservations[0])
      unit = await stockAverageCost(db, r.reservations[0].stockItemId, now);
    if (unit === null) forecastUnpriced += 1;
    else forecastCents += Math.round(num(r.quantity) * unit);
  }
  // Comprado = pedido menos o saldo encerrado (Fase 12): o que não virá não conta.
  const purchasedCents = exclusive.reduce(
    (a, e) => a + Math.round((num(e.quantity) - num(e.closedQuantity)) * (e.unitPriceCents ?? 0)),
    0,
  );
  const reservations = await db.stockReservation.findMany({
    where: { serviceOrderId, status: 'ATIVA' },
  });
  let reservedCents = 0;
  for (const r of reservations) {
    const unit = await stockAverageCost(db, r.stockItemId, now);
    reservedCents += unit === null ? 0 : Math.round(num(r.quantity) * unit);
  }
  const ledger = await db.serviceOrderCost.findMany({
    where: { serviceOrderId, category: 'MATERIAL' },
    orderBy: { occurredAt: 'asc' },
  });
  return {
    forecastCents,
    forecastUnpriced,
    purchasedCents,
    reservedCents,
    consumedCents: ledger.reduce((a, l) => a + l.amountCents, 0),
    unpricedLines: ledger.filter((l) => !l.priced).length,
    activeReservations: reservations.length,
    lines: ledger.map((l) => ({
      id: l.id,
      source: l.source,
      description: l.description,
      quantity: l.quantity === null ? null : Number(l.quantity),
      unitCostCents: l.unitCostCents,
      amountCents: l.amountCents,
      priced: l.priced,
      occurredAt: l.occurredAt.toISOString(),
      note: l.note,
    })),
  };
}
