import {
  EVENT_TYPES,
  PURCHASE_ORDER_COMMITTED,
  anyPermissionAudience,
  computeReadiness,
  coverageExcess,
  requirementCoverage,
  formatServiceOrderItemCode,
  lineStage,
  q3,
  specKey,
  stockItemCode,
  type LeftoverDto,
  type MaterialReadiness,
  type MaterialSpec,
  type MaterialUnit,
  type Permission,
  type ReadinessLineDto,
  type RequirementOrphanDto,
  type PurchaseOrderStatus,
  purchaseOrderCode,
  type SpecDto,
  type StockItemDto,
  type StockReservationDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, StockMovementType, Tx } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';

// ─────────────────────────── Acesso ───────────────────────────

export const PURCHASE_VIEW = {
  session: 'WEB',
  anyPermissions: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
} as const;
export const PURCHASE_MANAGE = { session: 'WEB', permissions: ['compras.gerenciar'] } as const;
export const PURCHASE_APPROVE = { session: 'WEB', permissions: ['compras.aprovar'] } as const;
export const STOCK_VIEW = {
  session: 'WEB',
  anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
} as const;
export const STOCK_MANAGE = { session: 'WEB', permissions: ['estoque.gerenciar'] } as const;
export const STOCK_AUTHORIZE = { session: 'WEB', permissions: ['estoque.autorizar'] } as const;
/** Recebimento de materiais: qualquer funcionário autenticado (painel ou tablet). */
export const ANY_EMPLOYEE = { session: 'any' } as const;

export const MANAGEMENT_AUDIENCE = anyPermissionAudience(
  'compras.ver',
  'compras.gerenciar',
  'estoque.ver',
  'estoque.gerenciar',
);
export const READINESS_AUDIENCE = anyPermissionAudience(
  'os.ver',
  'estoque.ver',
  'compras.ver',
  'materiais.ver',
);

export const has = (request: FastifyRequest, p: Permission) =>
  request.auth?.permissions.has(p) ?? false;
export const canSeePrices = (request: FastifyRequest) => has(request, 'compras.ver');

export const num = (d: Prisma.Decimal | number | null | undefined): number =>
  d === null || d === undefined ? 0 : q3(Number(d));
export const numOrNull = (d: Prisma.Decimal | null | undefined): number | null =>
  d === null || d === undefined ? null : Number(d);

// ─────────────────────────── Especificação ───────────────────────────

type SpecRow = {
  kind: MaterialSpec['kind'];
  description: string;
  color?: string | null;
  reference?: string | null;
  foamDensity?: string | null;
  thicknessCm?: Prisma.Decimal | null;
  lengthCm?: Prisma.Decimal | null;
  widthCm?: Prisma.Decimal | null;
};

export function specOf(r: SpecRow, unit: MaterialUnit): SpecDto {
  return {
    kind: r.kind,
    description: r.description,
    color: r.color ?? null,
    reference: r.reference ?? null,
    foamDensity: r.foamDensity ?? null,
    thicknessCm: numOrNull(r.thicknessCm),
    lengthCm: numOrNull(r.lengthCm),
    widthCm: numOrNull(r.widthCm),
    unit,
  };
}

/** Chave do catálogo de estoque (sem cor/referência, que não existem nos materiais comuns). */
export const stockSpecKey = (s: MaterialSpec) => specKey({ ...s, color: null, reference: null });

// ─────────────────────────── Bloqueios ───────────────────────────

export async function lockRows(tx: Tx, table: string, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  for (const id of sorted) {
    await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1::uuid FOR UPDATE`, id);
  }
}

export async function lockStockItem(tx: Tx, id: string) {
  await lockRows(tx, 'stock_items', [id]);
  const item = await tx.stockItem.findUnique({ where: { id } });
  if (!item) throw Errors.notFound('Material do estoque');
  return item;
}

// ─────────────────────────── Estoque ───────────────────────────

export interface StockChange {
  onHand?: number;
  reserved?: number;
  movement?: {
    type: StockMovementType;
    serviceOrderId?: string | null;
    materialReceiptLineId?: string | null;
    reservationId?: string | null;
    reason?: string | null;
  };
}

/**
 * Altera saldo físico/reservado de um material JÁ BLOQUEADO (FOR UPDATE), grava a
 * movimentação e valida: nunca negativo e reserva nunca maior que o saldo físico
 * (o banco também garante). Retorna se o material cruzou o estoque mínimo.
 */
export async function changeStock(
  tx: Tx,
  actor: ActorContext,
  item: {
    id: string;
    onHand: Prisma.Decimal;
    reserved: Prisma.Decimal;
    minQuantity: Prisma.Decimal | null;
    number: number;
    description: string;
  },
  change: StockChange,
) {
  const before = { onHand: num(item.onHand), reserved: num(item.reserved) };
  const after = {
    onHand: q3(before.onHand + (change.onHand ?? 0)),
    reserved: q3(before.reserved + (change.reserved ?? 0)),
  };
  if (after.onHand < 0) throw Errors.conflict('Operação deixaria o estoque negativo.');
  if (after.reserved < 0) throw Errors.conflict('Reserva inconsistente.');
  if (after.reserved > after.onHand) {
    throw Errors.conflict(
      `Saldo disponível insuficiente em ${stockItemCode(item.number)} (${item.description}): ` +
        `físico ${after.onHand}, reservado ${after.reserved}.`,
    );
  }
  await tx.stockItem.update({
    where: { id: item.id },
    data: { onHand: after.onHand, reserved: after.reserved },
  });
  item.onHand = after.onHand as unknown as Prisma.Decimal;
  item.reserved = after.reserved as unknown as Prisma.Decimal;
  if (change.movement && change.onHand) {
    await tx.stockMovement.create({
      data: {
        stockItemId: item.id,
        type: change.movement.type,
        quantity: change.onHand,
        balanceAfter: after.onHand,
        reservedAfter: after.reserved,
        serviceOrderId: change.movement.serviceOrderId ?? null,
        materialReceiptLineId: change.movement.materialReceiptLineId ?? null,
        reservationId: change.movement.reservationId ?? null,
        reason: change.movement.reason ?? null,
        actorId: actor.userId,
      },
    });
  }
  const min = item.minQuantity === null ? null : num(item.minQuantity);
  const crossedMinimum =
    min !== null && after.onHand - after.reserved < min && before.onHand - before.reserved >= min;
  if (crossedMinimum) {
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.MATERIAL_SHORTAGE_DETECTED,
      aggregateType: 'stock_item',
      aggregateId: item.id,
      payload: {
        reason: 'ESTOQUE_MINIMO',
        stockItemId: item.id,
        code: stockItemCode(item.number),
        available: q3(after.onHand - after.reserved),
        minQuantity: min,
      },
      audience: MANAGEMENT_AUDIENCE,
    });
  }
  return after;
}

export function toStockItemDto(i: {
  id: string;
  number: number;
  kind: MaterialSpec['kind'];
  description: string;
  foamDensity: string | null;
  thicknessCm: Prisma.Decimal | null;
  lengthCm: Prisma.Decimal | null;
  widthCm: Prisma.Decimal | null;
  unit: MaterialUnit;
  onHand: Prisma.Decimal;
  reserved: Prisma.Decimal;
  minQuantity: Prisma.Decimal | null;
  location: string | null;
  notes: string | null;
  active: boolean;
  version: number;
}): StockItemDto {
  const available = q3(num(i.onHand) - num(i.reserved));
  const min = i.minQuantity === null ? null : num(i.minQuantity);
  return {
    id: i.id,
    number: i.number,
    code: stockItemCode(i.number),
    ...specOf(i, i.unit),
    onHand: num(i.onHand),
    reserved: num(i.reserved),
    available,
    minQuantity: min,
    belowMinimum: min !== null && available < min,
    location: i.location,
    notes: i.notes,
    active: i.active,
    version: i.version,
  };
}

export const reservationInclude = {
  stockItem: true,
  serviceOrder: { select: { id: true, number: true } },
  createdBy: { select: { displayName: true } },
} as const;

export function toReservationDto(
  r: Prisma.StockReservationGetPayload<{ include: typeof reservationInclude }>,
  delivered: ReadonlySet<string> = new Set(),
): StockReservationDto {
  return {
    id: r.id,
    status: r.status,
    stockItem: {
      id: r.stockItem.id,
      code: stockItemCode(r.stockItem.number),
      description: r.stockItem.description,
      unit: r.stockItem.unit,
    },
    serviceOrder: { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) },
    materialRequirementId: r.materialRequirementId,
    quantity: num(r.quantity),
    createdBy: r.createdBy?.displayName ?? null,
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    closeReason: r.closeReason,
    unconfirmedConsumption: r.status === 'ATIVA' && delivered.has(r.serviceOrderId),
    version: r.version,
  };
}

export const leftoverInclude = {
  serviceOrder: { select: { id: true, number: true } },
  createdBy: { select: { displayName: true } },
  transfers: {
    include: {
      toServiceOrder: { select: { id: true, number: true } },
      authorizedBy: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

export function toLeftoverDto(
  l: Prisma.MaterialLeftoverGetPayload<{ include: typeof leftoverInclude }>,
): LeftoverDto {
  return {
    id: l.id,
    serviceOrder: { id: l.serviceOrder.id, code: serviceOrderCode(l.serviceOrder.number) },
    kind: l.kind,
    description: l.description,
    color: l.color,
    reference: l.reference,
    foamDensity: l.foamDensity,
    thicknessCm: numOrNull(l.thicknessCm),
    quantity: num(l.quantity),
    initialQuantity: num(l.initialQuantity),
    unit: l.unit,
    location: l.location,
    condition: l.condition,
    reusable: l.reusable,
    status: l.status,
    notes: l.notes,
    createdBy: l.createdBy?.displayName ?? null,
    createdAt: l.createdAt.toISOString(),
    version: l.version,
    transfers: l.transfers.map((t) => ({
      id: t.id,
      toServiceOrder: { id: t.toServiceOrder.id, code: serviceOrderCode(t.toServiceOrder.number) },
      quantity: num(t.quantity),
      reason: t.reason,
      authorizedBy: t.authorizedBy.displayName,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

// ─────────────────────────── Necessidades e prontidão ───────────────────────────

/** Decisões sobre recusa no recebimento (histórico do pedido de compra — V4). */
export const REJECTION_HISTORY_KINDS: string[] = ['RECUSA_REPOR', 'RECUSA_NAO_REPOR'];

/** Linhas de recebimento com recusa já decididas (REPOR/NÃO REPOR), pelo histórico do pedido. */
export function decidedRejectionLines(history: { kind: string; changes: unknown }[]) {
  const out = new Set<string>();
  for (const h of history) {
    if (!REJECTION_HISTORY_KINDS.includes(h.kind)) continue;
    const id = (h.changes as { receiptLineId?: unknown } | null)?.receiptLineId;
    if (typeof id === 'string') out.add(id);
  }
  return out;
}

/** Tudo o que é preciso para saber em que ponto está cada necessidade aprovada. */
export const requirementProgressInclude = {
  serviceOrderItem: { select: { position: true } },
  serviceOrder: {
    select: {
      id: true,
      number: true,
      status: true,
      promisedDate: true,
      priority: true,
      customer: { select: { name: true } },
    },
  },
  allocations: {
    include: {
      item: {
        include: {
          purchaseOrder: {
            include: {
              supplier: { select: { name: true } },
              history: {
                where: { kind: { in: REJECTION_HISTORY_KINDS } },
                select: { kind: true, changes: true },
              },
            },
          },
          allocations: { select: { id: true, quantity: true, createdAt: true } },
          receiptLines: { select: { id: true, rejectedQuantity: true } },
        },
      },
    },
  },
  reservations: { select: { id: true, quantity: true, status: true } },
  transfersIn: { select: { quantity: true } },
} as const;
export type RequirementWithProgress = Prisma.MaterialRequirementGetPayload<{
  include: typeof requirementProgressInclude;
}>;

export interface RequirementProgress {
  need: number;
  purchasedDraft: number;
  /** Em pedidos confirmados, líquido do saldo encerrado (inclui o recebido). */
  purchased: number;
  received: number;
  reserved: number;
  consumed: number;
  transferredIn: number;
  covered: number;
  /** Comprado e ainda não chegou. */
  awaiting: number;
  /** Falta comprar (regra única `requirementCoverage`). */
  shortfall: number;
  /** Etapa 2: o que passa da necessidade atual, por estágio (derivado das mesmas entradas). */
  excess: ReturnType<typeof coverageExcess>;
  divergence: boolean;
}

/** Reservas de estoque da OS sem necessidade vinculada, atribuídas pela especificação (E3). */
export interface AttributedReservations {
  reserved: number;
  consumed: number;
}

/**
 * Quanto de cada necessidade já foi comprado, recebido, reservado e está
 * disponível. O recebido (e o saldo ainda esperado) de um item consolidado é distribuído entre
 * as origens na ordem em que foram incluídas (FIFO), sem nunca ultrapassar a cota de cada OS.
 * Saldo encerrado (Fase 12) ou recusado sem reposição (V4) deixa de ser esperado.
 */
export function requirementProgress(
  r: RequirementWithProgress,
  attributed: AttributedReservations = { reserved: 0, consumed: 0 },
  opts: { excludePurchaseOrderId?: string } = {},
): RequirementProgress {
  const need = num(r.quantity);
  let purchasedDraft = 0;
  let purchased = 0;
  let received = 0;
  let divergence = false;
  for (const a of r.allocations) {
    const po = a.item.purchaseOrder;
    if (po.status === 'CANCELADO') continue;
    if (opts.excludePurchaseOrderId && po.id === opts.excludePurchaseOrderId) continue;
    const qtyA = num(a.quantity);
    const ordered = [...a.item.allocations].sort(
      (x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id),
    );
    const before = ordered
      .slice(
        0,
        ordered.findIndex((x) => x.id === a.id),
      )
      .reduce((s, x) => s + num(x.quantity), 0);
    if (po.status === 'RASCUNHO') {
      // A quantidade do item manda: alocações além dela não viram "em compra" (FIFO).
      purchasedDraft += Math.min(qtyA, Math.max(0, num(a.item.quantity) - before));
      continue;
    }
    const itemReceived = num(a.item.receivedQuantity);
    const expected = Math.max(itemReceived, num(a.item.quantity) - num(a.item.closedQuantity));
    received += Math.min(qtyA, Math.max(0, itemReceived - before));
    if ((PURCHASE_ORDER_COMMITTED as readonly string[]).includes(po.status))
      purchased += Math.min(qtyA, Math.max(0, expected - before));
    const itemOpen =
      num(a.item.receivedQuantity) + num(a.item.closedQuantity) < num(a.item.quantity);
    if (itemOpen) {
      const decided = decidedRejectionLines(po.history);
      if (a.item.receiptLines.some((l) => num(l.rejectedQuantity) > 0 && !decided.has(l.id)))
        divergence = true;
    }
  }
  const reserved =
    r.reservations.filter((x) => x.status === 'ATIVA').reduce((s, x) => s + num(x.quantity), 0) +
    attributed.reserved;
  const consumed =
    r.reservations
      .filter((x) => x.status === 'CONSUMIDA')
      .reduce((s, x) => s + num(x.quantity), 0) + attributed.consumed;
  const transferredIn = r.transfersIn.reduce((s, x) => s + num(x.quantity), 0);
  const input = {
    exclusive: r.sourcing === 'EXCLUSIVO_OS',
    need,
    ordered: purchased,
    received,
    reserved,
    consumed,
    draft: purchasedDraft,
    transferredIn,
  };
  const c = requirementCoverage(input);
  return {
    need,
    purchasedDraft: q3(purchasedDraft),
    purchased: q3(purchased),
    received: q3(received),
    reserved: q3(reserved),
    consumed: q3(consumed),
    transferredIn: q3(transferredIn),
    covered: c.covered,
    awaiting: c.awaiting,
    shortfall: c.shortfall,
    excess: coverageExcess(input),
    divergence,
  };
}

/**
 * Etapa 2: a cobertura de uma predecessora passa para a sucessora só quando a especificação é
 * estritamente a mesma pela regra do domínio — exclusivo: mesma origem e `specKey` completa;
 * estoque: mesma chave do catálogo. Tecido X → tecido Y nunca herda nada.
 */
export function coverageCompatible(
  a: Parameters<typeof specOf>[0] & { sourcing: string; unitCode: string | null },
  b: Parameters<typeof specOf>[0] & { sourcing: string; unitCode: string | null },
) {
  if (a.sourcing !== b.sourcing || a.kind !== b.kind || a.unitCode !== b.unitCode) return false;
  const sa = specOf(a, (a.unitCode ?? 'UNIDADE') as MaterialUnit);
  const sb = specOf(b, (b.unitCode ?? 'UNIDADE') as MaterialUnit);
  return a.sourcing === 'ESTOQUE'
    ? stockSpecKey(sa) === stockSpecKey(sb)
    : specKey(sa) === specKey(sb);
}

/** Uma necessidade ATIVA com as predecessoras cuja cobertura ela herda (mais nova primeiro). */
export interface RequirementChain {
  r: RequirementWithProgress;
  p: RequirementProgress;
  inherited: RequirementWithProgress[];
  /** Predecessora imediata quando a especificação mudou (cadeia quebrada: nada herdado dela). */
  broken?: RequirementWithProgress;
}

/** Junta os fatos da cadeia na sucessora (mesma necessidade da cabeça; nada é movido no banco). */
function merged(head: RequirementWithProgress, chain: RequirementWithProgress[]) {
  if (!chain.length) return head;
  return {
    ...head,
    allocations: [...head.allocations, ...chain.flatMap((c) => c.allocations)],
    reservations: [...head.reservations, ...chain.flatMap((c) => c.reservations)],
    transfersIn: [...head.transfersIn, ...chain.flatMap((c) => c.transfersIn)],
  } as RequirementWithProgress;
}

/**
 * Regra única de carregamento. Só necessidades ATIVAS geram falta, prontidão e "A comprar". Para
 * cada ATIVA, caminha pelas predecessoras enquanto a cadeia é compatível e agrega seus fatos
 * (compras, recebidos, reservas, sobras) antes de chamar `requirementCoverage` — a mesma função.
 * Reservas de estoque da OS sem necessidade indicada (E3) são atribuídas só a necessidades ATIVAS
 * de estoque da mesma OS e mesma chave do catálogo, na ordem de aprovação, sem passar da falta.
 * Também devolve os "órfãos": necessidades não ATIVAS cujos fatos não passaram a nenhuma ATIVA.
 */
export async function requirementChains(
  db: Tx | PrismaClient,
  where: Prisma.MaterialRequirementWhereInput,
  opts: { excludePurchaseOrderId?: string } = {},
) {
  const scope = await db.materialRequirement.findMany({
    where: { ...where, origin: 'SOLICITACAO_APROVADA', status: 'ATIVA' },
    select: { id: true, serviceOrderId: true },
  });
  return chainsOf(
    db,
    [...new Set(scope.map((r) => r.serviceOrderId))],
    new Set(scope.map((r) => r.id)),
    opts,
  );
}

export async function chainsOf(
  db: Tx | PrismaClient,
  osIds: string[],
  wanted: Set<string> | null,
  opts: { excludePurchaseOrderId?: string } = {},
) {
  if (!osIds.length) return { heads: [] as RequirementChain[], orphans: [] as RequirementChain[] };
  const [all, unlinked] = await Promise.all([
    db.materialRequirement.findMany({
      where: { serviceOrderId: { in: osIds }, origin: 'SOLICITACAO_APROVADA' },
      include: requirementProgressInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.stockReservation.findMany({
      where: {
        serviceOrderId: { in: osIds },
        materialRequirementId: null,
        status: { in: ['ATIVA', 'CONSUMIDA'] },
      },
      include: { stockItem: { select: { specKey: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const byId = new Map(all.map((r) => [r.id, r]));
  const carried = new Set<string>();
  const chainOf = new Map<string, RequirementWithProgress[]>();
  const brokenOf = new Map<string, RequirementWithProgress>();
  for (const head of all) {
    if (head.status !== 'ATIVA') continue;
    const chain: RequirementWithProgress[] = [];
    let cur = head;
    while (cur.replacesRequirementId) {
      const prev = byId.get(cur.replacesRequirementId);
      if (!prev || chain.includes(prev)) break;
      if (!coverageCompatible(prev, cur)) {
        if (cur === head) brokenOf.set(head.id, prev);
        break;
      }
      chain.push(prev);
      carried.add(prev.id);
      cur = prev;
    }
    chainOf.set(head.id, chain);
  }
  const heads = all.filter((r) => r.status === 'ATIVA');
  const extra = new Map<string, AttributedReservations>();
  const room = new Map<string, number>();
  for (const r of heads) {
    if (r.sourcing !== 'ESTOQUE') continue;
    const p = requirementProgress(merged(r, chainOf.get(r.id)!));
    room.set(r.id, q3(p.need - p.covered));
  }
  for (const u of unlinked) {
    let left = num(u.quantity);
    for (const r of heads) {
      if (left <= 0) break;
      if (r.serviceOrderId !== u.serviceOrderId || r.sourcing !== 'ESTOQUE') continue;
      if (
        stockSpecKey(specOf(r, (r.unitCode ?? 'UNIDADE') as MaterialUnit)) !== u.stockItem.specKey
      )
        continue;
      const free = room.get(r.id) ?? 0;
      const take = q3(Math.min(free, left));
      if (take <= 0) continue;
      room.set(r.id, q3(free - take));
      left = q3(left - take);
      const cur = extra.get(r.id) ?? { reserved: 0, consumed: 0 };
      if (u.status === 'ATIVA') cur.reserved = q3(cur.reserved + take);
      else cur.consumed = q3(cur.consumed + take);
      extra.set(r.id, cur);
    }
  }
  return {
    heads: heads
      .filter((r) => !wanted || wanted.has(r.id))
      .map((r) => {
        const inherited = chainOf.get(r.id)!;
        return {
          r,
          p: requirementProgress(merged(r, inherited), extra.get(r.id), opts),
          inherited,
          broken: brokenOf.get(r.id),
        } as RequirementChain;
      }),
    // Fatos de necessidades encerradas que não passaram a nenhuma ATIVA: tudo é "sem destino".
    orphans: all
      .filter((r) => r.status !== 'ATIVA' && !carried.has(r.id))
      .map((r) => ({
        r,
        p: requirementProgress({ ...r, quantity: 0 } as unknown as RequirementWithProgress),
        inherited: [] as RequirementWithProgress[],
      })) as RequirementChain[],
  };
}

/** Compatível com a Etapa 1: só as ATIVAS (com a cobertura herdada da cadeia). */
export async function requirementsWithProgress(
  db: Tx | PrismaClient,
  where: Prisma.MaterialRequirementWhereInput,
  opts: { excludePurchaseOrderId?: string } = {},
) {
  return (await requirementChains(db, where, opts)).heads;
}

/**
 * A necessidade ATIVA que hoje responde por `id`: ela mesma, ou a sucessora (seguindo a cadeia).
 * `compatibleOnly`: só segue enquanto a cobertura passa (reserva/compra herdada). Nulo quando a
 * cadeia termina CANCELADA ou incompatível.
 */
export async function activeHeadOf(db: Tx | PrismaClient, id: string, compatibleOnly = false) {
  let cur = await db.materialRequirement.findUnique({ where: { id } });
  const seen = new Set<string>();
  while (cur && cur.status === 'SUBSTITUIDA' && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = await db.materialRequirement.findUnique({
      where: { replacesRequirementId: cur.id },
    });
    if (!next || (compatibleOnly && !coverageCompatible(cur, next))) return null;
    cur = next;
  }
  return cur && cur.status === 'ATIVA' ? cur : null;
}

export function itemCodeOf(r: RequirementWithProgress) {
  return r.serviceOrderItem
    ? formatServiceOrderItemCode(r.serviceOrder.number, r.serviceOrderItem.position)
    : null;
}

export function toReadinessLine(
  r: RequirementWithProgress,
  p: RequirementProgress,
  inherited: RequirementWithProgress[] = [],
  opts: { prices?: boolean; broken?: RequirementWithProgress } = {},
): ReadinessLineDto {
  const unit = (r.unitCode ?? 'UNIDADE') as MaterialUnit;
  // Predecessoras: as herdadas (cadeia compatível) e a imediatamente anterior quando incompatível.
  const replaces = inherited.map((x) => ({
    requirementId: x.id,
    quantity: num(x.quantity),
    description: x.description,
    inherited: true,
  }));
  if (opts.broken)
    replaces.push({
      requirementId: opts.broken.id,
      quantity: num(opts.broken.quantity),
      description: opts.broken.description,
      inherited: false,
    });
  const exclusive = r.sourcing === 'EXCLUSIVO_OS';
  let leftoverDraft: ReadinessLineDto['leftoverDraft'] = null;
  if (exclusive && p.excess.available > 0) {
    const items = new Map<string, { code: string; price: number | null }>();
    for (const x of [r, ...inherited])
      for (const a of x.allocations)
        if (a.item.purchaseOrder.status !== 'CANCELADO' && num(a.item.receivedQuantity) > 0)
          items.set(a.item.id, {
            code: purchaseOrderCode(a.item.purchaseOrder.number),
            price: a.item.unitPriceCents,
          });
    const prices = [...new Set([...items.values()].map((i) => i.price))];
    leftoverDraft = {
      quantity: p.excess.available,
      unitPriceCents: opts.prices && prices.length === 1 ? (prices[0] ?? null) : null,
      purchaseOrders: [...new Set([...items.values()].map((i) => i.code))],
    };
  }
  return {
    requirementId: r.id,
    itemCode: itemCodeOf(r),
    ...specOf(r, unit),
    sourcing: r.sourcing,
    need: p.need,
    purchased: p.purchased,
    received: p.received,
    reserved: q3(p.reserved + p.consumed),
    transferredIn: p.transferredIn,
    covered: p.covered,
    awaiting: p.awaiting,
    inDraft: p.purchasedDraft,
    shortfall: p.shortfall,
    divergence: p.divergence,
    stage: stageOf(r, p),
    excess: p.excess,
    replaces,
    leftoverDraft,
  };
}

export function toOrphanDto(
  r: RequirementWithProgress,
  p: RequirementProgress,
): RequirementOrphanDto {
  const unit = (r.unitCode ?? 'UNIDADE') as MaterialUnit;
  const pos = new Map<string, { id: string; code: string; status: PurchaseOrderStatus }>();
  for (const a of r.allocations)
    pos.set(a.item.purchaseOrder.id, {
      id: a.item.purchaseOrder.id,
      code: purchaseOrderCode(a.item.purchaseOrder.number),
      status: a.item.purchaseOrder.status,
    });
  return {
    requirementId: r.id,
    status: r.status,
    itemCode: itemCodeOf(r),
    ...specOf(r, unit),
    closeReason: r.closeReason,
    awaiting: q3(Math.max(0, p.purchased - p.received)),
    draft: p.purchasedDraft,
    receivedExclusive: r.sourcing === 'EXCLUSIVO_OS' ? p.received : 0,
    reservations: r.reservations
      .filter((x) => x.status === 'ATIVA')
      .map((x) => ({ id: x.id, quantity: num(x.quantity), status: x.status })),
    purchaseOrders: [...pos.values()].filter((x) => x.status !== 'CANCELADO'),
  };
}

/** Órfão que pede decisão (algo ainda a caminho, em rascunho, recebido exclusivo ou reservado). */
export const orphanNeedsAction = (o: RequirementOrphanDto) =>
  o.awaiting > 0 || o.draft > 0 || o.receivedExclusive > 0 || o.reservations.length > 0;

export const stageOf = (r: { sourcing: string }, p: RequirementProgress) =>
  lineStage({
    need: p.need,
    // Coberto ou comprado-aguardando (o recebido que virou reserva não conta duas vezes).
    purchased: q3(p.covered + p.awaiting),
    received: p.received,
    reserved: p.reserved + p.consumed,
    covered: p.covered,
    exclusive: r.sourcing === 'EXCLUSIVO_OS',
  });

export async function readinessOf(
  db: Tx | PrismaClient,
  serviceOrderId: string,
  opts: { prices?: boolean } = {},
) {
  const [chains, openMeasurements, pendingRequests] = await Promise.all([
    chainsOf(db, [serviceOrderId], null),
    db.measurement.count({
      where: { serviceOrderId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
    }),
    db.materialRequest.count({
      where: {
        status: { in: ['ENVIADA', 'EM_REVISAO', 'DEVOLVIDA'] },
        measurement: { serviceOrderId, status: { not: 'CANCELADA' } },
      },
    }),
  ]);
  const rows = chains.heads;
  const requirements = rows.map((x) => x.r);
  const lines = rows.map(({ r, p, inherited, broken }) =>
    toReadinessLine(r, p, inherited, { ...opts, broken }),
  );
  const orphans = chains.orphans.map(({ r, p }) => toOrphanDto(r, p));
  // V8: sobra já registrada nesta OS (mesma especificação completa) deixa de ser oferecida.
  const registered = new Map<string, number>();
  for (const l of await db.materialLeftover.findMany({ where: { serviceOrderId } })) {
    const k = specKey(specOf(l, l.unit));
    registered.set(k, (registered.get(k) ?? 0) + num(l.initialQuantity));
  }
  const take = (k: string, q: number) => {
    const used = Math.min(q, registered.get(k) ?? 0);
    registered.set(k, q3((registered.get(k) ?? 0) - used));
    return q3(q - used);
  };
  for (const l of lines)
    if (l.leftoverDraft) {
      const left = take(specKey(l), l.leftoverDraft.quantity);
      l.leftoverDraft = left > 0 ? { ...l.leftoverDraft, quantity: left } : null;
    }
  for (const o of orphans)
    if (o.receivedExclusive > 0) o.receivedExclusive = take(specKey(o), o.receivedExclusive);
  const pendingOrphans = orphans.filter(orphanNeedsAction);
  // Etapa 2: levantamento feito e todas as necessidades encerradas (substituídas sem herdeira
  // ou canceladas) = nada falta — não volta para "sem levantamento" (tarefa não fica presa).
  const surveyedNothingLeft = rows.length === 0 && orphans.length > 0;
  const state = surveyedNothingLeft
    ? computeReadiness(
        [{ need: 0, covered: 0, purchased: 0, divergence: false }],
        openMeasurements + pendingRequests > 0,
      )
    : computeReadiness(
        rows.map(({ p }) => ({
          need: p.need,
          covered: p.covered,
          // Coberto + comprado aguardando chegada (rascunho não conta como comprado).
          purchased: q3(p.covered + p.awaiting),
          divergence: p.divergence,
        })),
        openMeasurements + pendingRequests > 0,
      );
  return {
    state,
    lines,
    requirements,
    orphans: pendingOrphans,
    openMeasurements,
    pendingRequests,
  };
}

/**
 * Recalcula a prontidão de materiais das OS afetadas (na mesma transação da
 * alteração) e publica `material.readiness_changed` quando muda. Nunca libera
 * produção, cria tarefas ou altera datas.
 */
/** Ouvintes de mudança de prontidão (a produção reavalia as tarefas que exigem materiais). */
type ReadinessListener = (tx: Tx, actor: ActorContext, serviceOrderId: string) => Promise<void>;
const readinessListeners: ReadinessListener[] = [];
export function onReadinessChanged(listener: ReadinessListener) {
  if (!readinessListeners.includes(listener)) readinessListeners.push(listener);
}

export async function refreshReadiness(tx: Tx, actor: ActorContext, serviceOrderIds: string[]) {
  for (const id of [...new Set(serviceOrderIds)].sort()) {
    const so = await tx.serviceOrder.findUnique({
      where: { id },
      select: { id: true, number: true, materialsReadiness: true },
    });
    if (!so) continue;
    const { state } = await readinessOf(tx, id);
    if (state === so.materialsReadiness) {
      // A situação da OS não mudou, mas a cobertura de um material pode ter mudado: as tarefas
      // vinculadas a materiais e as ocorrências de material são reavaliadas (idempotente).
      for (const l of readinessListeners) await l(tx, actor, id);
      continue;
    }
    await tx.serviceOrder.update({
      where: { id },
      data: { materialsReadiness: state, materialsReadinessAt: new Date() },
    });
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.MATERIAL_READINESS_CHANGED,
      aggregateType: 'service_order',
      aggregateId: id,
      payload: {
        serviceOrderId: id,
        code: serviceOrderCode(so.number),
        from: so.materialsReadiness,
        to: state satisfies MaterialReadiness,
      },
      audience: READINESS_AUDIENCE,
    });
    for (const l of readinessListeners) await l(tx, actor, id);
  }
}

// ─────────────────────────── Histórico do pedido ───────────────────────────

export async function poHistory(
  tx: Tx,
  actor: ActorContext,
  purchaseOrderId: string,
  entry: { kind: string; note?: string | null; changes?: object; summary: string },
) {
  await tx.purchaseOrderHistory.create({
    data: {
      purchaseOrderId,
      kind: entry.kind,
      note: entry.note ?? null,
      changes: (entry.changes as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: `purchase_order.${entry.kind.toLowerCase()}`,
    entityType: 'purchase_order',
    entityId: purchaseOrderId,
    summary: entry.summary,
    changes: entry.changes,
  });
}
