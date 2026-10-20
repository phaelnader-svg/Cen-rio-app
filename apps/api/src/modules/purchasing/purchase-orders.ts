import {
  EVENT_TYPES,
  PURCHASE_ORDER_RECEIVABLE,
  authorizeExtraSchema,
  cancelPurchaseOrderSchema,
  formatServiceOrderItemCode,
  lineTotalCents,
  materialReceiptCode,
  needsQuerySchema,
  purchaseOrderCode,
  purchaseOrderDecisionSchema,
  purchaseOrderQuerySchema,
  purchaseOrderSchema,
  q3,
  specMismatch,
  stockItemCode,
  unitError,
  updatePurchaseOrderSchema,
  type MaterialReceiptDto,
  type MaterialUnit,
  type PurchaseNeedDto,
  type PurchaseOrderDto,
  type PurchaseOrderItemInput,
  type PurchaseOrderSummaryDto,
  type RejectionDecision,
  draftAgeDays,
} from '@cenario/shared';
import { shopTimezone, todayIso } from '../finance/common';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { dateOnly, orderCode, parseDateOnly, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import {
  MANAGEMENT_AUDIENCE,
  PURCHASE_APPROVE,
  PURCHASE_MANAGE,
  PURCHASE_VIEW,
  canSeePrices,
  has,
  itemCodeOf,
  orderItemRefSelect,
  preArrivalOf,
  lockRows,
  num,
  pendingQuantity,
  poHistory,
  refreshReadiness,
  REJECTION_HISTORY_KINDS,
  decidedRejectionLines,
  requirementsWithProgress,
  specOf,
  stageOf,
  stockSpecKey,
  type RequirementProgress,
  type RequirementWithProgress,
} from './common';
import { assertActiveRequirement } from './requirements';

// ─────────────────────────── Leitura ───────────────────────────

const decisionHistory = {
  where: { kind: { in: REJECTION_HISTORY_KINDS } },
  select: { kind: true, changes: true },
} as const;

export const receiptInclude = {
  purchaseOrder: { select: { id: true, number: true, history: decisionHistory } },
  receivedBy: { select: { displayName: true } },
  lines: {
    include: {
      item: { include: { serviceOrder: { select: { id: true, number: true } } } },
      reversals: {
        include: { authorizedBy: { select: { displayName: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  },
} as const;

export function toReceiptDto(
  r: Prisma.MaterialReceiptGetPayload<{ include: typeof receiptInclude }>,
): MaterialReceiptDto {
  const decisions = rejectionDecisions(r.purchaseOrder.history);
  return {
    id: r.id,
    number: r.number,
    code: materialReceiptCode(r.number),
    purchaseOrder: { id: r.purchaseOrder.id, code: purchaseOrderCode(r.purchaseOrder.number) },
    receivedAt: r.receivedAt.toISOString(),
    receivedBy: r.receivedBy.displayName,
    notes: r.notes,
    lines: r.lines.map((l) => ({
      id: l.id,
      purchaseOrderItemId: l.purchaseOrderItemId,
      ...specOf(l.item, l.item.unit),
      acceptedQuantity: num(l.acceptedQuantity),
      rejectedQuantity: num(l.rejectedQuantity),
      reversedQuantity: q3(l.reversals.reduce((s, x) => s + num(x.quantity), 0)),
      specConfirmed: l.specConfirmed,
      issue: l.issue,
      issueNote: l.issueNote,
      serviceOrder: l.item.serviceOrder
        ? { id: l.item.serviceOrder.id, code: serviceOrderCode(l.item.serviceOrder.number) }
        : null,
      reversals: l.reversals.map((x) => ({
        id: x.id,
        quantity: num(x.quantity),
        reason: x.reason,
        authorizedBy: x.authorizedBy.displayName,
        createdAt: x.createdAt.toISOString(),
      })),
      rejectionDecision: decisions.get(l.id) ?? null,
      rejectionPending:
        num(l.rejectedQuantity) > 0 &&
        !decisions.has(l.id) &&
        num(l.item.receivedQuantity) + num(l.item.closedQuantity) < num(l.item.quantity),
    })),
  };
}

/** Decisão gravada (histórico do pedido) para cada linha de recebimento com recusa. */
export function rejectionDecisions(history: { kind: string; changes: unknown }[]) {
  const out = new Map<string, RejectionDecision>();
  for (const h of history) {
    const id = (h.changes as { receiptLineId?: unknown } | null)?.receiptLineId;
    if (typeof id !== 'string') continue;
    if (h.kind === 'RECUSA_REPOR') out.set(id, 'REPOR');
    if (h.kind === 'RECUSA_NAO_REPOR') out.set(id, 'NAO_REPOR');
  }
  return out;
}

const itemsInclude = {
  orderBy: { position: 'asc' },
  include: {
    serviceOrder: { select: { id: true, number: true } },
    stockItem: { select: { id: true, number: true } },
    allocations: {
      orderBy: { createdAt: 'asc' },
      include: {
        serviceOrder: { select: { id: true, number: true } },
        requirement: {
          include: {
            serviceOrderItem: { select: { position: true } },
            orderItem: orderItemRefSelect,
          },
        },
      },
    },
    receiptLines: { select: { id: true, rejectedQuantity: true } },
  },
} as const;

const summaryInclude = {
  supplier: { select: { id: true, name: true } },
  items: {
    ...itemsInclude,
    include: {
      ...itemsInclude.include,
      serviceOrder: { select: { id: true, number: true, status: true } },
      allocations: {
        ...itemsInclude.include.allocations,
        include: {
          ...itemsInclude.include.allocations.include,
          serviceOrder: { select: { id: true, number: true, status: true } },
        },
      },
    },
  },
  history: decisionHistory,
} as const;

const detailInclude = {
  ...summaryInclude,
  createdBy: { select: { displayName: true } },
  confirmedBy: { select: { displayName: true } },
  history: {
    include: { actor: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  },
  receipts: { include: receiptInclude, orderBy: { receivedAt: 'asc' } },
} as const;

type SummaryRow = Prisma.PurchaseOrderGetPayload<{ include: typeof summaryInclude }>;

/**
 * V8: OS cancelada com compra ainda viva (não cancelada) — o material fica sem destino
 * operacional. Nada é cancelado ou redistribuído automaticamente: comum entra no estoque livre
 * pelo fluxo normal; exclusivo continua identificado na OS cancelada (sobra/reaproveitamento).
 */
function withoutDestination(po: SummaryRow) {
  const out = new Map<string, string>();
  for (const i of po.items) {
    if (i.serviceOrder?.status === 'CANCELADA')
      out.set(i.serviceOrder.id, serviceOrderCode(i.serviceOrder.number));
    for (const a of i.allocations) {
      if (a.serviceOrder?.status === 'CANCELADA')
        out.set(a.serviceOrder.id, serviceOrderCode(a.serviceOrder.number));
      // Etapa 3: previsão pré-OS cancelada (pedido/peça cancelados) — a compra fica sem destino.
      const o = a.requirement.orderItem?.order;
      if (!a.serviceOrder && o && a.requirement.status === 'CANCELADA')
        out.set(o.id, orderCode(o.number));
    }
  }
  return [...out].map(([id, code]) => ({ id, code })).sort((a, b) => a.code.localeCompare(b.code));
}

function toSummary(
  po: SummaryRow,
  prices: boolean,
  clockCtx: { today: string; tz: string },
): PurchaseOrderSummaryDto {
  const decided = decidedRejectionLines(po.history);
  const priced = po.items.filter((i) => i.unitPriceCents !== null);
  const sos = new Map<string, string>();
  for (const i of po.items) {
    for (const a of i.allocations)
      if (a.serviceOrder) sos.set(a.serviceOrder.id, serviceOrderCode(a.serviceOrder.number));
    if (i.serviceOrder) sos.set(i.serviceOrder.id, serviceOrderCode(i.serviceOrder.number));
  }
  return {
    id: po.id,
    number: po.number,
    code: purchaseOrderCode(po.number),
    status: po.status,
    supplier: po.supplier,
    expectedDate: dateOnly(po.expectedDate),
    createdAt: po.createdAt.toISOString(),
    itemCount: po.items.length,
    totalCents:
      prices && priced.length
        ? priced.reduce((s, i) => s + (lineTotalCents(num(i.quantity), i.unitPriceCents) ?? 0), 0)
        : null,
    serviceOrders: [...sos]
      .map(([id, code]) => ({ id, code }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    hasIssues: po.items.some(
      (i) =>
        num(i.receivedQuantity) + num(i.closedQuantity) < num(i.quantity) &&
        i.receiptLines.some((l) => num(l.rejectedQuantity) > 0 && !decided.has(l.id)),
    ),
    withoutDestination: po.status === 'CANCELADO' ? [] : withoutDestination(po),
    draftDays:
      po.status === 'RASCUNHO' ? draftAgeDays(po.createdAt, clockCtx.today, clockCtx.tz) : null,
    version: po.version,
  };
}

export async function loadPurchaseOrder(
  db: Tx | PrismaClient,
  id: string,
  request: FastifyRequest,
): Promise<PurchaseOrderDto> {
  const po = await db.purchaseOrder.findUnique({ where: { id }, include: detailInclude });
  if (!po) throw Errors.notFound('Pedido de compra');
  const prices = canSeePrices(request);
  const received = po.items.some((i) => num(i.receivedQuantity) > 0);
  const tz = await shopTimezone(db);
  return {
    ...toSummary(po, prices, { today: todayIso(tz), tz }),
    notes: po.notes,
    items: po.items.map((i) => {
      const rejected = i.receiptLines.reduce((s, l) => s + num(l.rejectedQuantity), 0);
      return {
        id: i.id,
        position: i.position,
        ...specOf(i, i.unit),
        sourcing: i.sourcing,
        quantity: num(i.quantity),
        extraAuthorized: num(i.extraAuthorized),
        receivedQuantity: num(i.receivedQuantity),
        closedQuantity: num(i.closedQuantity),
        pendingQuantity: pendingQuantity(i),
        rejectedQuantity: q3(rejected),
        unitPriceCents: prices ? i.unitPriceCents : null,
        totalCents: prices ? lineTotalCents(num(i.quantity), i.unitPriceCents) : null,
        serviceOrder: i.serviceOrder
          ? { id: i.serviceOrder.id, code: serviceOrderCode(i.serviceOrder.number) }
          : null,
        stockItem: i.stockItem
          ? { id: i.stockItem.id, code: stockItemCode(i.stockItem.number) }
          : null,
        allocations: i.allocations.map((a) => ({
          id: a.id,
          materialRequirementId: a.materialRequirementId,
          serviceOrder: a.serviceOrder
            ? { id: a.serviceOrder.id, code: serviceOrderCode(a.serviceOrder.number) }
            : null,
          preArrival: preArrivalOf(a.requirement),
          itemCode:
            a.requirement.serviceOrderItem && a.serviceOrder
              ? formatServiceOrderItemCode(
                  a.serviceOrder.number,
                  a.requirement.serviceOrderItem.position,
                )
              : null,
          quantity: num(a.quantity),
        })),
        notes: i.notes,
      };
    }),
    receipts: po.receipts.map(toReceiptDto),
    history: po.history.map((h) => ({
      id: h.id,
      kind: h.kind,
      note: h.note,
      changes: prices ? h.changes : null,
      actor: h.actor?.displayName ?? null,
      createdAt: h.createdAt.toISOString(),
    })),
    createdBy: po.createdBy?.displayName ?? null,
    confirmedAt: po.confirmedAt?.toISOString() ?? null,
    confirmedBy: po.confirmedBy?.displayName ?? null,
    cancelledAt: po.cancelledAt?.toISOString() ?? null,
    cancelReason: po.cancelReason,
    balanceClosedAt: po.balanceClosedAt?.toISOString() ?? null,
    balanceCloseReason: po.balanceCloseReason,
    can: {
      edit: po.status === 'RASCUNHO' && has(request, 'compras.gerenciar'),
      confirm: po.status === 'RASCUNHO' && has(request, 'compras.aprovar'),
      cancel:
        (po.status === 'RASCUNHO' || po.status === 'CONFIRMADO') &&
        !received &&
        has(request, 'compras.aprovar'),
      authorizeExtra:
        (PURCHASE_ORDER_RECEIVABLE as readonly string[]).includes(po.status) &&
        has(request, 'compras.aprovar'),
      closeBalance: po.status === 'PARCIALMENTE_RECEBIDO' && has(request, 'compras.aprovar'),
      decideRejection:
        (PURCHASE_ORDER_RECEIVABLE as readonly string[]).includes(po.status) &&
        has(request, 'compras.aprovar'),
    },
  };
}

// ─────────────────────────── Montagem dos itens ───────────────────────────

/** "OS-0012" ou, antes da chegada (Etapa 3), "pedido PED-0034 (Sofá)". */
function destinationCode(r: {
  serviceOrder: { number: number } | null;
  orderItem: { description: string; order: { number: number } } | null;
}) {
  if (r.serviceOrder) return serviceOrderCode(r.serviceOrder.number);
  return r.orderItem
    ? `pedido ${orderCode(r.orderItem.order.number)} (${r.orderItem.description})`
    : 'destino desconhecido';
}

const EPS = 1e-6;

/**
 * Valida e prepara os itens: somente necessidades APROVADAS de OS abertas, sem
 * comprar mais que o aprovado; tecido/exclusivo sempre de uma única OS; material
 * comum ligado ao catálogo do estoque e com especificação compatível em todas as origens.
 */
async function prepareItems(
  tx: Tx,
  items: PurchaseOrderItemInput[],
  excludePurchaseOrderId?: string,
) {
  const reqIds = items.flatMap((i) => (i.allocations ?? []).map((a) => a.materialRequirementId));
  // Ordem única de bloqueio (Etapa 3): pedido → necessidades → OS. A previsão pré-OS revalida o
  // pedido sob bloqueio (cancelamento concorrente do pedido espera ou é visto).
  const preOs = await tx.materialRequirement.findMany({
    where: { id: { in: reqIds }, serviceOrderId: null },
    select: { orderItem: { select: { orderId: true } } },
  });
  await lockRows(
    tx,
    'commercial_orders',
    preOs.flatMap((x) => (x.orderItem ? [x.orderItem.orderId] : [])),
  );
  await lockRows(tx, 'material_requirements', reqIds);
  const reqs = await tx.materialRequirement.findMany({
    where: { id: { in: reqIds } },
    include: {
      serviceOrder: { select: { id: true, number: true, status: true } },
      orderItem: {
        select: { description: true, order: { select: { number: true, status: true } } },
      },
      allocations: {
        include: { item: { include: { purchaseOrder: { select: { id: true, status: true } } } } },
      },
    },
  });
  const byId = new Map(reqs.map((r) => [r.id, r]));
  // Regra única (E2): só se compra o que realmente falta — reservado, entregue, sobra recebida,
  // comprado e rascunhos (fora este pedido, na edição) já cobrem a necessidade.
  const shortfallOf = new Map(
    (await requirementsWithProgress(tx, { id: { in: reqIds } }, { excludePurchaseOrderId })).map(
      ({ r, p }) => [r.id, p],
    ),
  );
  const usedHere = new Map<string, number>();
  const out: (Prisma.PurchaseOrderItemCreateWithoutPurchaseOrderInput & {
    allocationRows: {
      materialRequirementId: string;
      serviceOrderId: string | null;
      quantity: number;
    }[];
  })[] = [];

  for (const [idx, item] of items.entries()) {
    const allocations = item.allocations ?? [];
    const label = `Item ${idx + 1}`;
    const linked = allocations.map((a) => {
      const r = byId.get(a.materialRequirementId);
      assertActiveRequirement(r, `${label}: a necessidade de material`);
      if (!r || (r.origin !== 'SOLICITACAO_APROVADA' && r.origin !== 'PREVISAO_COMPRA')) {
        throw Errors.business(
          `${label}: somente materiais de solicitações aprovadas (ou previsões de compra) podem ser comprados.`,
        );
      }
      const osCode = destinationCode(r);
      if (r.serviceOrder) {
        if (r.serviceOrder.status !== 'ABERTA')
          throw Errors.business(`${label}: a ${osCode} não está aberta.`);
      } else if (r.origin !== 'PREVISAO_COMPRA' || !r.orderItem) {
        throw Errors.business(`${label}: necessidade sem destino.`);
      } else if (r.orderItem.order.status === 'CANCELADO') {
        throw Errors.business(`${label}: o ${osCode} foi cancelado.`);
      }
      const p = shortfallOf.get(r.id);
      const missing = p?.shortfall ?? 0;
      const total = (usedHere.get(r.id) ?? 0) + a.quantity;
      if (total > missing + EPS) {
        const already = p ? q3(p.need - p.shortfall) : 0;
        throw Errors.conflict(
          `${label}: quantidade acima da necessidade aprovada da ${osCode} ` +
            `(aprovado ${num(r.quantity)}, já em compras ou atendido ${already}; falta ${missing}).`,
        );
      }
      usedHere.set(r.id, (usedHere.get(r.id) ?? 0) + a.quantity);
      return { r, quantity: a.quantity };
    });

    if (item.sourcing === 'EXCLUSIVO_OS') {
      const { r, quantity } = linked[0]!;
      if (r.sourcing !== 'EXCLUSIVO_OS') {
        throw Errors.business(
          `${label}: esta necessidade é de material comum; compre para o estoque.`,
        );
      }
      const unit = r.unitCode as MaterialUnit;
      const err = unitError(r.kind, unit, item.quantity);
      if (err) throw Errors.validation([{ path: `items.${idx}.quantity`, message: err }], err);
      out.push({
        position: idx + 1,
        kind: r.kind,
        sourcing: 'EXCLUSIVO_OS',
        description: r.description,
        color: r.color,
        reference: r.reference,
        foamDensity: r.foamDensity,
        thicknessCm: r.thicknessCm,
        lengthCm: r.lengthCm,
        widthCm: r.widthCm,
        unit,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents ?? null,
        notes: item.notes ?? null,
        // Pré-OS (Etapa 3): o destino é a única alocação; a OS é preenchida na chegada da peça.
        ...(r.serviceOrderId ? { serviceOrder: { connect: { id: r.serviceOrderId } } } : {}),
        allocationRows: [
          { materialRequirementId: r.id, serviceOrderId: r.serviceOrderId, quantity },
        ],
      });
      continue;
    }

    // Material comum (estoque)
    for (const { r } of linked) {
      if (r.sourcing !== 'ESTOQUE' || r.kind === 'TECIDO') {
        throw Errors.business(
          `${label}: tecido e materiais exclusivos são comprados por OS, nunca para o estoque comum.`,
        );
      }
    }
    let stock = item.stockItemId
      ? await tx.stockItem.findUnique({ where: { id: item.stockItemId } })
      : null;
    if (item.stockItemId && !stock) throw Errors.notFound('Material do estoque');
    if (!stock) {
      const first = linked[0]!.r;
      const spec = specOf(first, first.unitCode as MaterialUnit);
      stock = await tx.stockItem.upsert({
        where: { specKey: stockSpecKey(spec) },
        update: {},
        create: {
          kind: first.kind,
          description: first.description,
          foamDensity: first.foamDensity,
          thicknessCm: first.thicknessCm,
          lengthCm: first.lengthCm,
          widthCm: first.widthCm,
          unit: spec.unit,
          specKey: stockSpecKey(spec),
        },
      });
    }
    if (!stock.active) throw Errors.business(`${label}: material do estoque inativo.`);
    const stockSpec = specOf(stock, stock.unit);
    for (const { r } of linked) {
      const reqSpec = { ...specOf(r, r.unitCode as MaterialUnit), color: null, reference: null };
      const mismatch = specMismatch(stockSpec, reqSpec);
      if (mismatch) {
        throw Errors.business(
          `${label}: ${destinationCode(r)} pede "${r.description}" — ${mismatch}`,
        );
      }
    }
    const err = unitError(stock.kind, stock.unit, item.quantity);
    if (err) throw Errors.validation([{ path: `items.${idx}.quantity`, message: err }], err);
    out.push({
      position: idx + 1,
      kind: stock.kind,
      sourcing: 'ESTOQUE',
      description: stock.description,
      foamDensity: stock.foamDensity,
      thicknessCm: stock.thicknessCm,
      lengthCm: stock.lengthCm,
      widthCm: stock.widthCm,
      unit: stock.unit,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents ?? null,
      notes: item.notes ?? null,
      stockItem: { connect: { id: stock.id } },
      allocationRows: linked.map(({ r, quantity }) => ({
        materialRequirementId: r.id,
        serviceOrderId: r.serviceOrderId,
        quantity,
      })),
    });
  }
  return out;
}

async function writeItems(
  tx: Tx,
  purchaseOrderId: string,
  prepared: Awaited<ReturnType<typeof prepareItems>>,
) {
  for (const { allocationRows, ...data } of prepared) {
    const created = await tx.purchaseOrderItem.create({
      data: { ...data, purchaseOrder: { connect: { id: purchaseOrderId } } },
    });
    for (const a of allocationRows) {
      await tx.purchaseAllocation.create({ data: { ...a, purchaseOrderItemId: created.id } });
    }
  }
  return [
    ...new Set(
      prepared.flatMap((p) =>
        p.allocationRows.flatMap((a) => (a.serviceOrderId ? [a.serviceOrderId] : [])),
      ),
    ),
  ];
}

async function assertSupplier(tx: Tx, supplierId: string | null | undefined) {
  if (!supplierId) return;
  const s = await tx.supplier.findUnique({ where: { id: supplierId } });
  if (!s) throw Errors.notFound('Fornecedor');
  if (!s.active) throw Errors.business('Fornecedor inativo.');
}

export async function lockPurchaseOrder(tx: Tx, id: string) {
  await lockRows(tx, 'purchase_orders', [id]);
  const po = await tx.purchaseOrder.findUnique({
    where: { id },
    include: { items: { include: { allocations: true } }, supplier: true },
  });
  if (!po) throw Errors.notFound('Pedido de compra');
  return po;
}

export const poServiceOrderIds = (po: {
  items: { serviceOrderId: string | null; allocations: { serviceOrderId: string | null }[] }[];
}) => [
  ...new Set(
    po.items.flatMap((i) => [
      ...(i.serviceOrderId ? [i.serviceOrderId] : []),
      ...i.allocations.flatMap((a) => (a.serviceOrderId ? [a.serviceOrderId] : [])),
    ]),
  ),
];

/** Prazo da OS (sem prazo por último), depois a ordem de aprovação. */
export function sortByDeadline<T extends { r: RequirementWithProgress }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const date = (x: T) =>
      (x.r.serviceOrder?.promisedDate ?? x.r.orderItem?.order.promisedDate)?.getTime() ??
      Number.POSITIVE_INFINITY;
    const da = date(a);
    const db = date(b);
    return da - db || a.r.createdAt.getTime() - b.r.createdAt.getTime();
  });
}

export function toNeedDto(
  r: RequirementWithProgress,
  p: RequirementProgress,
  prices: boolean,
): PurchaseNeedDto {
  return {
    requirementId: r.id,
    serviceOrder: r.serviceOrder
      ? {
          id: r.serviceOrder.id,
          code: serviceOrderCode(r.serviceOrder.number),
          promisedDate: dateOnly(r.serviceOrder.promisedDate),
          priority: r.serviceOrder.priority,
        }
      : null,
    preArrival: preArrivalOf(r),
    forecast: r.origin === 'PREVISAO_COMPRA',
    customerName: (r.serviceOrder?.customer ?? r.orderItem?.order.customer)?.name ?? '',
    itemCode: itemCodeOf(r),
    ...specOf(r, (r.unitCode ?? 'UNIDADE') as MaterialUnit),
    sourcing: r.sourcing,
    need: p.need,
    purchasedDraft: p.purchasedDraft,
    purchased: p.purchased,
    received: p.received,
    reserved: q3(p.reserved + p.consumed),
    transferredIn: p.transferredIn,
    covered: p.covered,
    awaiting: p.awaiting,
    pendingToBuy: p.shortfall,
    divergence: p.divergence,
    stage: stageOf(r, p),
    purchases: r.allocations
      .filter((a) => a.item.purchaseOrder.status !== 'CANCELADO')
      .map((a) => ({
        purchaseOrderId: a.item.purchaseOrderId,
        code: purchaseOrderCode(a.item.purchaseOrder.number),
        status: a.item.purchaseOrder.status,
        supplierName: a.item.purchaseOrder.supplier?.name ?? null,
        quantity: num(a.quantity),
        unitPriceCents: prices ? a.item.unitPriceCents : null,
      })),
  };
}

// ─────────────────────────── Rotas ───────────────────────────

export async function purchaseOrderRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Central de compras: necessidades aprovadas e quanto falta comprar. */
  app.get('/api/v1/purchasing/needs', { config: { access: PURCHASE_VIEW } }, async (request) => {
    const q = needsQuerySchema.parse(request.query);
    const prices = canSeePrices(request);
    const rows = await requirementsWithProgress(prisma, {
      ...(q.serviceOrderId
        ? { serviceOrderId: q.serviceOrderId, serviceOrder: { status: 'ABERTA' } }
        : {
            OR: [
              { serviceOrder: { status: 'ABERTA' } },
              // Etapa 3: previsão de compra antes da chegada (pedido não cancelado).
              {
                serviceOrderId: null,
                origin: 'PREVISAO_COMPRA',
                orderItem: { order: { status: { not: 'CANCELADO' } } },
              },
            ],
          }),
      ...(q.kind ? { kind: q.kind } : {}),
    });
    const out: PurchaseNeedDto[] = sortByDeadline(rows).map(({ r, p }) => toNeedDto(r, p, prices));
    return q.pendingOnly ? out.filter((n) => n.pendingToBuy > 0) : out;
  });

  app.get('/api/v1/purchase-orders', { config: { access: PURCHASE_VIEW } }, async (request) => {
    const q = purchaseOrderQuerySchema.parse(request.query);
    const code = q.q?.match(/^(?:cp-?)?0*(\d{1,9})$/i);
    const rows = await prisma.purchaseOrder.findMany({
      where: {
        ...(q.status?.length ? { status: { in: q.status } } : {}),
        ...(q.supplierId ? { supplierId: q.supplierId } : {}),
        ...(q.serviceOrderId
          ? {
              items: {
                some: {
                  OR: [
                    { serviceOrderId: q.serviceOrderId },
                    { allocations: { some: { serviceOrderId: q.serviceOrderId } } },
                  ],
                },
              },
            }
          : {}),
        ...(q.q
          ? {
              OR: [
                ...(code ? [{ number: Number(code[1]) }] : []),
                { supplier: { name: { contains: q.q, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      include: summaryInclude,
      orderBy: { number: 'desc' },
      take: q.limit,
    });
    const prices = canSeePrices(request);
    const tz = await shopTimezone(prisma);
    const ctx = { today: todayIso(tz), tz };
    return rows.map((r) => toSummary(r, prices, ctx));
  });

  app.get('/api/v1/purchase-orders/:id', { config: { access: PURCHASE_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadPurchaseOrder(prisma, id, request);
  });

  app.post(
    '/api/v1/purchase-orders',
    { config: { access: PURCHASE_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = purchaseOrderSchema.parse(request.body);
      const actor = actorFrom(request);
      const id = await prisma.$transaction(async (tx) => {
        await assertSupplier(tx, input.supplierId);
        const prepared = await prepareItems(tx, input.items);
        const po = await tx.purchaseOrder.create({
          data: {
            supplierId: input.supplierId ?? null,
            expectedDate: parseDateOnly(input.expectedDate ?? null),
            notes: input.notes ?? null,
            createdById: actor.userId,
          },
        });
        const sos = await writeItems(tx, po.id, prepared);
        await poHistory(tx, actor, po.id, {
          kind: 'CRIADO',
          summary: `Pedido de compra ${purchaseOrderCode(po.number)} criado (rascunho).`,
          changes: { items: prepared.length },
        });
        await refreshReadiness(tx, actor, sos);
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PURCHASE_ORDER_CREATED,
          aggregateType: 'purchase_order',
          aggregateId: po.id,
          payload: { id: po.id, code: purchaseOrderCode(po.number), status: po.status },
          audience: MANAGEMENT_AUDIENCE,
        });
        return po.id;
      });
      return reply.status(201).send(await loadPurchaseOrder(prisma, id, request));
    },
  );

  /** Edição completa somente em rascunho. */
  app.put(
    '/api/v1/purchase-orders/:id',
    { config: { access: PURCHASE_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = updatePurchaseOrderSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, id);
        if (po.version !== input.version) throw Errors.versionConflict(po.version);
        if (po.status !== 'RASCUNHO') {
          throw Errors.business('Só pedidos em rascunho podem ser alterados.');
        }
        await assertSupplier(tx, input.supplierId);
        const before = poServiceOrderIds(po);
        const prepared = await prepareItems(tx, input.items, id);
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        const sos = await writeItems(tx, id, prepared);
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            supplierId: input.supplierId ?? null,
            expectedDate: parseDateOnly(input.expectedDate ?? null),
            notes: input.notes ?? null,
            version: { increment: 1 },
          },
        });
        await poHistory(tx, actor, id, {
          kind: 'ALTERADO',
          summary: `Pedido de compra ${purchaseOrderCode(po.number)} alterado (rascunho).`,
          changes: { items: prepared.length },
        });
        await refreshReadiness(tx, actor, [...before, ...sos]);
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PURCHASE_ORDER_UPDATED,
          aggregateType: 'purchase_order',
          aggregateId: id,
          payload: { id, code: purchaseOrderCode(po.number), status: 'RASCUNHO' },
          audience: MANAGEMENT_AUDIENCE,
        });
      });
      return loadPurchaseOrder(prisma, id, request);
    },
  );

  app.post(
    '/api/v1/purchase-orders/:id/confirm',
    { config: { access: PURCHASE_APPROVE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = purchaseOrderDecisionSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, id);
        if (po.version !== input.version) throw Errors.versionConflict(po.version);
        if (po.status !== 'RASCUNHO')
          throw Errors.business('Só pedidos em rascunho podem ser confirmados.');
        if (!po.supplier) throw Errors.business('Escolha o fornecedor antes de confirmar.');
        if (!po.supplier.active) throw Errors.business('Fornecedor inativo.');
        if (po.items.some((i) => i.unitPriceCents === null)) {
          throw Errors.business('Informe o preço unitário de todos os itens antes de confirmar.');
        }
        // As necessidades continuam aprovadas e das OS abertas (revalida no momento da confirmação).
        const reqIds = po.items.flatMap((i) => i.allocations.map((a) => a.materialRequirementId));
        // Etapa 2: rascunho antigo é revalidado sob bloqueio — necessidade substituída ou
        // cancelada depois do rascunho não recebe compra confirmada (409, edite o rascunho).
        // Ordem única de bloqueio (Etapa 3): pedido (previsão pré-OS) → necessidades.
        const preOs = await tx.materialRequirement.findMany({
          where: { id: { in: reqIds }, serviceOrderId: null },
          select: { orderItem: { select: { orderId: true } } },
        });
        await lockRows(
          tx,
          'commercial_orders',
          preOs.flatMap((x) => (x.orderItem ? [x.orderItem.orderId] : [])),
        );
        await lockRows(tx, 'material_requirements', reqIds);
        const reqs = await tx.materialRequirement.findMany({
          where: { id: { in: reqIds } },
          include: {
            serviceOrder: { select: { status: true, number: true } },
            orderItem: {
              select: { description: true, order: { select: { number: true, status: true } } },
            },
          },
        });
        const stale = reqs.find((r) => r.status !== 'ATIVA');
        if (stale)
          throw Errors.conflict(
            `A necessidade "${stale.description}" (${destinationCode(stale)}) foi ${
              stale.status === 'SUBSTITUIDA' ? 'substituída por uma nova medição' : 'cancelada'
            } depois deste rascunho. Edite o rascunho e vincule a necessidade atual.`,
            { requirementId: stale.id, status: stale.status },
          );
        const closed = reqs.find((r) =>
          r.serviceOrder
            ? r.serviceOrder.status !== 'ABERTA'
            : r.orderItem?.order.status === 'CANCELADO',
        );
        if (closed)
          throw Errors.business(
            closed.serviceOrder
              ? `A ${destinationCode(closed)} não está aberta.`
              : `O ${destinationCode(closed)} foi cancelado.`,
          );
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: 'CONFIRMADO',
            confirmedAt: new Date(),
            confirmedById: actor.userId,
            version: { increment: 1 },
          },
        });
        const totalCents = po.items.reduce(
          (s, i) => s + (lineTotalCents(num(i.quantity), i.unitPriceCents) ?? 0),
          0,
        );
        await poHistory(tx, actor, id, {
          kind: 'CONFIRMADO',
          note: input.note ?? null,
          summary: `Pedido de compra ${purchaseOrderCode(po.number)} confirmado com ${po.supplier.name}.`,
          changes: { supplier: po.supplier.name, totalCents },
        });
        await refreshReadiness(tx, actor, poServiceOrderIds(po));
        // Todos os funcionários: o pedido passa a aguardar recebimento (payload sem valores).
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PURCHASE_ORDER_CONFIRMED,
          aggregateType: 'purchase_order',
          aggregateId: id,
          payload: { id, code: purchaseOrderCode(po.number), status: 'CONFIRMADO' },
          audience: 'all',
        });
      });
      return loadPurchaseOrder(prisma, id, request);
    },
  );

  app.post(
    '/api/v1/purchase-orders/:id/cancel',
    { config: { access: PURCHASE_APPROVE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelPurchaseOrderSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, id);
        if (po.version !== input.version) throw Errors.versionConflict(po.version);
        if (po.status !== 'RASCUNHO' && po.status !== 'CONFIRMADO') {
          throw Errors.business(
            'Pedido com recebimento não pode ser cancelado; estorne os recebimentos antes.',
          );
        }
        if (po.items.some((i) => num(i.receivedQuantity) > 0)) {
          throw Errors.business(
            'Há material recebido neste pedido; estorne os recebimentos antes.',
          );
        }
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: 'CANCELADO',
            cancelledAt: new Date(),
            cancelledById: actor.userId,
            cancelReason: input.reason,
            version: { increment: 1 },
          },
        });
        await poHistory(tx, actor, id, {
          kind: 'CANCELADO',
          note: input.reason,
          summary: `Pedido de compra ${purchaseOrderCode(po.number)} cancelado.`,
        });
        await refreshReadiness(tx, actor, poServiceOrderIds(po));
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PURCHASE_ORDER_CANCELLED,
          aggregateType: 'purchase_order',
          aggregateId: id,
          payload: { id, code: purchaseOrderCode(po.number), status: 'CANCELADO' },
          audience: 'all',
        });
      });
      return loadPurchaseOrder(prisma, id, request);
    },
  );

  /**
   * Fase 12 — encerra o saldo que não será entregue (gestor, com justificativa). O que já foi
   * recebido e seus custos ficam como estão; só o pendente deixa de ser esperado, as necessidades
   * voltam a aparecer como não atendidas e a prontidão é recalculada. Não mexe no estoque.
   */
  app.post(
    '/api/v1/purchase-orders/:id/close-balance',
    { config: { access: PURCHASE_APPROVE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelPurchaseOrderSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, id);
        if (po.version !== input.version) throw Errors.versionConflict(po.version);
        if (po.status !== 'PARCIALMENTE_RECEBIDO') {
          throw Errors.business(
            po.status === 'CONFIRMADO'
              ? 'Nada foi recebido neste pedido: para desistir da compra, cancele o pedido.'
              : 'Só pedidos parcialmente recebidos têm saldo para encerrar.',
          );
        }
        await lockRows(
          tx,
          'purchase_order_items',
          po.items.map((i) => i.id),
        );
        const closed: { item: string; quantity: number }[] = [];
        for (const i of po.items) {
          const pending = q3(num(i.quantity) - num(i.receivedQuantity) - num(i.closedQuantity));
          if (pending <= 1e-6) continue;
          await tx.purchaseOrderItem.update({
            where: { id: i.id },
            data: { closedQuantity: q3(num(i.closedQuantity) + pending) },
          });
          closed.push({ item: i.description, quantity: pending });
        }
        if (!closed.length) throw Errors.business('Não há saldo pendente neste pedido.');
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: 'RECEBIDO',
            balanceClosedAt: new Date(),
            balanceClosedById: actor.userId,
            balanceCloseReason: input.reason,
            version: { increment: 1 },
          },
        });
        await poHistory(tx, actor, id, {
          kind: 'SALDO_ENCERRADO',
          note: input.reason,
          summary: `Saldo pendente do pedido de compra ${purchaseOrderCode(po.number)} encerrado: ${closed
            .map((c) => `${c.quantity} de ${c.item}`)
            .join(', ')}.`,
          changes: { closed },
        });
        await refreshReadiness(tx, actor, poServiceOrderIds(po));
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PURCHASE_ORDER_UPDATED,
          aggregateType: 'purchase_order',
          aggregateId: id,
          payload: { id, code: purchaseOrderCode(po.number), status: 'RECEBIDO' },
          audience: 'all',
        });
      });
      return loadPurchaseOrder(prisma, id, request);
    },
  );

  /** Fluxo explícito para receber acima do pedido (ex.: rolo de tecido maior). */
  app.post(
    '/api/v1/purchase-orders/:id/items/:itemId/authorize-extra',
    { config: { access: PURCHASE_APPROVE } },
    async (request) => {
      const { id, itemId } = z
        .object({ id: z.string().uuid(), itemId: z.string().uuid() })
        .parse(request.params);
      const input = authorizeExtraSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, id);
        if (po.version !== input.version) throw Errors.versionConflict(po.version);
        if (!(PURCHASE_ORDER_RECEIVABLE as readonly string[]).includes(po.status)) {
          throw Errors.business('Só pedidos aguardando recebimento aceitam autorização adicional.');
        }
        const item = po.items.find((i) => i.id === itemId);
        if (!item) throw Errors.notFound('Item do pedido');
        const err = unitError(item.kind, item.unit, input.quantity);
        if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
        await tx.purchaseOrderItem.update({
          where: { id: itemId },
          data: { extraAuthorized: q3(num(item.extraAuthorized) + input.quantity) },
        });
        await tx.purchaseOrder.update({ where: { id }, data: { version: { increment: 1 } } });
        await poHistory(tx, actor, id, {
          kind: 'EXCEDENTE_AUTORIZADO',
          note: input.reason,
          summary: `Recebimento adicional de ${input.quantity} autorizado no item ${item.position} de ${purchaseOrderCode(po.number)}.`,
          changes: { item: item.position, quantity: input.quantity },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PURCHASE_ORDER_UPDATED,
          aggregateType: 'purchase_order',
          aggregateId: id,
          payload: { id, code: purchaseOrderCode(po.number), status: po.status },
          audience: 'all',
        });
      });
      return loadPurchaseOrder(prisma, id, request);
    },
  );
}
