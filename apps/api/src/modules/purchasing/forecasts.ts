import {
  forecastLinkSchema,
  formatServiceOrderItemCode,
  materialForecastSchema,
  q3,
  unitError,
  type MaterialUnit,
  type OrderForecastsDto,
} from '@cenario/shared';
import type { MaterialRequirement, Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly, lockOrder, orderCode, serviceOrderCode } from '../commercial/common';
import { itemAllocations } from '../commercial/status';
import { idParams } from '../presenters';
import {
  canSeePrices,
  chainsOf,
  changeStock,
  lockRows,
  lockStockItem,
  num,
  refreshReadiness,
  requirementsWithProgress,
  toOrphanDto,
  toReadinessLine,
} from './common';
import { cancelRequirements } from './requirements';

/**
 * Compras e materiais sem duplicidade — Etapa 3: PREVISÃO DE COMPRA antes da chegada da peça.
 *
 * A previsão é uma `MaterialRequirement` com `origin = PREVISAO_COMPRA`, presa à peça do pedido
 * (`order_item_id`) e sem OS. Pode ser comprada (mesma regra da falta). Na chegada, a MESMA linha é
 * vinculada à OS real (UPDATE condicional, sem copiar compra, recebimento, custo nem reserva). A
 * medição real depois a substitui pela cadeia da Etapa 2. Previsão nunca é medição.
 *
 * Ordem única de bloqueio: pedido → peças do pedido → necessidades → OS → itens de compra →
 * estoque. O recebimento do fornecedor nunca bloqueia previsão sem OS (ver `autoReserve`).
 */

const APPROVE = { session: 'WEB', permissions: ['materiais.aprovar'] } as const;
const VIEW = {
  session: 'WEB',
  anyPermissions: ['materiais.aprovar', 'materiais.ver', 'compras.ver'],
} as const;

type ForecastInput = z.output<typeof materialForecastSchema>;

const specData = (input: ForecastInput) => ({
  kind: input.kind,
  sourcing: input.sourcing,
  description: input.description,
  color: input.color ?? null,
  reference: input.reference ?? null,
  foamDensity: input.foamDensity ?? null,
  thicknessCm: input.thicknessCm ?? null,
  lengthCm: input.lengthCm ?? null,
  widthCm: input.widthCm ?? null,
  quantity: input.quantity,
  unit: null,
  unitCode: input.unit,
  notes: input.notes ?? null,
});

/**
 * "Virgem" (AB-7/AB-9): previsão ATIVA sem NENHUM vínculo — sem compra (nem rascunho, nem pedido
 * cancelado), reserva, sobra, ocorrência, tarefa, predecessora ou sucessora.
 */
async function isVirgin(db: Tx | PrismaClient, id: string) {
  const r = await db.materialRequirement.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          allocations: true,
          reservations: true,
          transfersIn: true,
          issues: true,
          productionTasks: true,
          leftoversFrom: true,
        },
      },
      replacedBy: { select: { id: true } },
    },
  });
  if (!r) return false;
  const c = r._count;
  return (
    r.status === 'ATIVA' &&
    !r.replacesRequirementId &&
    !r.replacedBy &&
    c.allocations +
      c.reservations +
      c.transfersIn +
      c.issues +
      c.productionTasks +
      c.leftoversFrom ===
      0
  );
}

/** Previsão pré-OS bloqueada na ordem certa (pedido → necessidade) e relida sob bloqueio. */
async function lockForecast(tx: Tx, id: string) {
  const pre = await tx.materialRequirement.findUnique({
    where: { id },
    select: { orderItem: { select: { orderId: true } } },
  });
  if (!pre?.orderItem) throw Errors.notFound('Previsão de material');
  await lockOrder(tx, pre.orderItem.orderId);
  await lockRows(tx, 'material_requirements', [id]);
  const r = await tx.materialRequirement.findUnique({
    where: { id },
    include: { orderItem: { include: { order: true } } },
  });
  if (!r || r.origin !== 'PREVISAO_COMPRA' || !r.orderItem)
    throw Errors.notFound('Previsão de material');
  return r as typeof r & { orderItem: NonNullable<typeof r.orderItem> };
}

// ─────────────────────────── Vinculação à OS real ───────────────────────────

/**
 * Vincula previsões (a cadeia pré-OS de uma peça do pedido) a um item de OS: UPDATE condicional
 * (`service_order_id IS NULL`) da necessidade, das alocações e dos itens exclusivos — as MESMAS
 * linhas. Idempotente (repetir não muda nada). Depois tenta a reserva segura (AB-5) e recalcula a
 * prontidão. Devolve os ids efetivamente vinculados.
 */
async function linkForecasts(
  tx: Tx,
  actor: ActorContext,
  ids: string[],
  target: { serviceOrderId: string; serviceOrderItemId: string },
  how: 'linked_on_arrival' | 'linked_manually',
) {
  if (!ids.length) return [] as string[];
  await lockRows(tx, 'material_requirements', ids);
  const rows = await tx.materialRequirement.findMany({
    where: { id: { in: ids }, serviceOrderId: null, origin: 'PREVISAO_COMPRA' },
    select: { id: true },
  });
  const linked = rows.map((r) => r.id);
  if (!linked.length) return linked;
  await tx.materialRequirement.updateMany({
    where: { id: { in: linked }, serviceOrderId: null },
    data: { serviceOrderId: target.serviceOrderId, serviceOrderItemId: target.serviceOrderItemId },
  });
  await tx.purchaseAllocation.updateMany({
    where: { materialRequirementId: { in: linked }, serviceOrderId: null },
    data: { serviceOrderId: target.serviceOrderId },
  });
  // Item exclusivo: uma única alocação (a da previsão) — a OS do item passa a ser a da previsão.
  await tx.purchaseOrderItem.updateMany({
    where: {
      sourcing: 'EXCLUSIVO_OS',
      serviceOrderId: null,
      allocations: { some: { materialRequirementId: { in: linked } } },
    },
    data: { serviceOrderId: target.serviceOrderId },
  });
  await audit(tx, actor, {
    action: `material_forecast.${how}`,
    entityType: 'service_order',
    entityId: target.serviceOrderId,
    summary: `${linked.length} previsão(ões) de material vinculada(s) à OS ${
      how === 'linked_on_arrival' ? 'na chegada da peça' : 'pelo gestor'
    } (previsão não é medição: a medição real continua obrigatória).`,
    changes: { requirements: linked, serviceOrderItemId: target.serviceOrderItemId },
  });
  await reserveOnArrival(tx, actor, linked);
  await refreshReadiness(tx, actor, [target.serviceOrderId]);
  return linked;
}

/**
 * AB-5: material de estoque comprado e recebido para a previsão antes da OS — na chegada, reserva
 * automaticamente SÓ quando tudo é inequívoco: previsão ATIVA de estoque, um único item do estoque
 * nas suas compras, quantidade recebida destinada a ela (fatia FIFO da alocação, a mesma regra da
 * cobertura) ainda não reservada, e saldo livre suficiente. Qualquer dúvida → nada é inventado; a
 * ação "Reservar" continua disponível. Reserva de outra OS nunca é considerada livre.
 */
async function reserveOnArrival(tx: Tx, actor: ActorContext, ids: string[]) {
  const heads = await requirementsWithProgress(tx, {
    id: { in: ids },
    sourcing: 'ESTOQUE',
    status: 'ATIVA',
  });
  for (const { r, p } of heads) {
    if (!r.serviceOrderId) continue;
    const stockIds = [
      ...new Set(
        r.allocations
          .filter((a) => a.item.purchaseOrder.status !== 'CANCELADO' && a.item.stockItemId)
          .map((a) => a.item.stockItemId!),
      ),
    ];
    if (stockIds.length !== 1) continue;
    const destined = q3(p.received - p.reserved - p.consumed);
    const qty = q3(Math.min(destined, p.need - p.covered));
    if (qty <= 0) continue;
    const stock = await lockStockItem(tx, stockIds[0]!);
    if (!stock.active || unitError(stock.kind, stock.unit, qty)) continue;
    if (q3(num(stock.onHand) - num(stock.reserved)) < qty) continue;
    const res = await tx.stockReservation.create({
      data: {
        stockItemId: stock.id,
        serviceOrderId: r.serviceOrderId,
        materialRequirementId: r.id,
        quantity: qty,
        notes: 'Reserva automática na chegada da peça (compra prevista recebida antes)',
        createdById: actor.userId,
      },
    });
    await changeStock(tx, actor, stock, { reserved: qty });
    await audit(tx, actor, {
      action: 'stock.reserved_on_arrival',
      entityType: 'stock_reservation',
      entityId: res.id,
      summary: `Reserva automática de ${qty} na chegada da peça (previsão comprada e recebida).`,
      changes: { requirementId: r.id, quantity: qty },
    });
  }
}

/**
 * Ponto único de vinculação na criação da OS (manual ou automática na chegada). AB-3: só vincula
 * quando o destino é inequívoco — peça do pedido com quantidade 1, ou quantidade > 1 inteira nesta
 * OS (e em nenhuma outra). Chegada parcial: a previsão fica na peça do pedido, "pendente de
 * vinculação", para o gestor decidir (nada é dividido nem atribuído silenciosamente).
 */
export async function linkForecastsOnArrival(tx: Tx, actor: ActorContext, serviceOrderId: string) {
  const items = await tx.serviceOrderItem.findMany({
    where: { serviceOrderId },
    include: { orderItem: { select: { id: true, quantity: true } } },
  });
  for (const si of items) {
    const forecasts = await tx.materialRequirement.findMany({
      where: { orderItemId: si.orderItemId, origin: 'PREVISAO_COMPRA', serviceOrderId: null },
      select: { id: true },
    });
    if (!forecasts.length) continue;
    const otherItems = await tx.serviceOrderItem.count({
      where: { orderItemId: si.orderItemId, id: { not: si.id } },
    });
    const unequivocal =
      si.orderItem.quantity === 1 || (si.quantity === si.orderItem.quantity && otherItems === 0);
    if (!unequivocal) {
      await audit(tx, actor, {
        action: 'material_forecast.link_pending',
        entityType: 'service_order',
        entityId: serviceOrderId,
        summary: `Chegada parcial (${si.quantity} de ${si.orderItem.quantity}): ${forecasts.length} previsão(ões) de material da peça aguardam vinculação pelo gestor.`,
        changes: { orderItemId: si.orderItemId, requirements: forecasts.map((f) => f.id) },
      });
      continue;
    }
    await linkForecasts(
      tx,
      actor,
      forecasts.map((f) => f.id),
      { serviceOrderId, serviceOrderItemId: si.id },
      'linked_on_arrival',
    );
  }
}

// ─────────────────────────── Pedido: cancelamento e remoção de peça ───────────────────────────

/** Pedido cancelado: previsões ATIVAS sem OS viram CANCELADA (compras e recebidos permanecem). */
export async function cancelForecastsOfOrder(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  reason: string,
) {
  return cancelRequirements(
    tx,
    actor,
    { serviceOrderId: null, origin: 'PREVISAO_COMPRA', orderItem: { orderId } },
    `Pedido cancelado: ${reason}`,
    { refresh: false },
  );
}

/**
 * AB-7: remoção física de peças do pedido. Previsão virgem sai junto (auditado); qualquer vínculo
 * (rascunho, compra, recebimento, reserva, sobra, cadeia) recusa a remoção com mensagem clara.
 */
export async function removeForecastsOfItems(
  tx: Tx,
  actor: ActorContext,
  orderId: string,
  items: { id: string; description: string }[],
) {
  if (!items.length) return;
  const forecasts = await tx.materialRequirement.findMany({
    where: { orderItemId: { in: items.map((i) => i.id) } },
    select: { id: true, orderItemId: true, description: true },
  });
  const leftovers = await tx.materialLeftover.count({
    where: { orderItemId: { in: items.map((i) => i.id) } },
  });
  for (const f of forecasts) {
    if (leftovers > 0 || !(await isVirgin(tx, f.id))) {
      const piece = items.find((i) => i.id === f.orderItemId)?.description ?? 'peça';
      throw Errors.business(
        `A peça "${piece}" tem previsão de material com compra, recebimento ou outro vínculo ("${f.description}"). Cancele ou trate a previsão e seus vínculos antes de remover a peça.`,
      );
    }
  }
  if (!forecasts.length) return;
  await tx.materialRequirement.deleteMany({ where: { id: { in: forecasts.map((f) => f.id) } } });
  await audit(tx, actor, {
    action: 'material_forecast.removed_with_item',
    entityType: 'commercial_order',
    entityId: orderId,
    summary: `${forecasts.length} previsão(ões) de material sem nenhum vínculo removida(s) junto com a peça.`,
    changes: { forecasts: forecasts.map((f) => ({ id: f.id, description: f.description })) },
  });
}

// ─────────────────────────── Leitura ───────────────────────────

async function loadOrderForecasts(
  db: Tx | PrismaClient,
  orderId: string,
  prices: boolean,
): Promise<OrderForecastsDto> {
  const order = await db.commercialOrder.findUnique({
    where: { id: orderId },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: {
          serviceOrderItems: {
            where: { serviceOrder: { status: 'ABERTA' }, fulfillmentStage: { not: 'DEVOLVIDA' } },
            include: { serviceOrder: { select: { id: true, number: true } } },
          },
        },
      },
    },
  });
  if (!order) throw Errors.notFound('Pedido');
  const itemIds = order.items.map((i) => i.id);
  const alloc = await itemAllocations(db as Tx, orderId);
  const all = await db.materialRequirement.findMany({
    where: { orderItemId: { in: itemIds }, origin: 'PREVISAO_COMPRA' },
    select: { id: true, serviceOrderId: true, orderItemId: true, status: true },
  });
  const osIds = [...new Set(all.flatMap((r) => (r.serviceOrderId ? [r.serviceOrderId] : [])))];
  const chains = await chainsOf(db, osIds, null, {}, itemIds);
  const isForecast = (r: { origin: string; orderItemId: string | null }) =>
    r.origin === 'PREVISAO_COMPRA' && r.orderItemId !== null && itemIds.includes(r.orderItemId);
  const registered = new Map<string, number>();
  for (const l of await db.materialLeftover.findMany({
    where: { sourceRequirementId: { in: all.map((r) => r.id) } },
  }))
    registered.set(
      l.sourceRequirementId!,
      (registered.get(l.sourceRequirementId!) ?? 0) + num(l.initialQuantity),
    );
  const forecasts: OrderForecastsDto['forecasts'] = [];
  for (const h of chains.heads.filter((x) => isForecast(x.r))) {
    const line = toReadinessLine(h.r, h.p, h.inherited, { prices, broken: h.broken });
    const sub = registered.get(h.r.id) ?? 0;
    if (line.leftoverDraft) {
      const left = q3(line.leftoverDraft.quantity - sub);
      line.leftoverDraft = left > 0 ? { ...line.leftoverDraft, quantity: left } : null;
    }
    forecasts.push({
      ...line,
      orderItemId: h.r.orderItemId!,
      serviceOrder: h.r.serviceOrder
        ? { id: h.r.serviceOrder.id, code: serviceOrderCode(h.r.serviceOrder.number) }
        : null,
      pendingLink: !h.r.serviceOrderId && (h.r.orderItem?._count.serviceOrderItems ?? 0) > 0,
      virgin: await isVirgin(db, h.r.id),
    });
  }
  const orphans: OrderForecastsDto['orphans'] = [];
  for (const o of chains.orphans.filter((x) => isForecast(x.r))) {
    const dto = toOrphanDto(o.r, o.p);
    if (dto.receivedExclusive > 0)
      dto.receivedExclusive = Math.max(
        0,
        q3(dto.receivedExclusive - (registered.get(o.r.id) ?? 0)),
      );
    if (
      dto.awaiting > 0 ||
      dto.draft > 0 ||
      dto.receivedExclusive > 0 ||
      dto.reservations.length > 0
    )
      orphans.push({ ...dto, orderItemId: o.r.orderItemId! });
  }
  return {
    order: {
      id: order.id,
      code: orderCode(order.number),
      status: order.status,
      promisedDate: dateOnly(order.promisedDate),
    },
    pieces: order.items.map((i) => ({
      orderItemId: i.id,
      position: i.position,
      description: i.description,
      quantity: i.quantity,
      receivedQuantity: i.receivedQuantity,
      serviceOrderItems: i.serviceOrderItems.map((s) => ({
        id: s.id,
        serviceOrder: { id: s.serviceOrder.id, code: serviceOrderCode(s.serviceOrder.number) },
        quantity: s.quantity,
        code: formatServiceOrderItemCode(s.serviceOrder.number, s.position),
      })),
      canForecast: order.status !== 'CANCELADO' && alloc.inServiceOrders(i.id) === 0,
    })),
    forecasts,
    orphans,
  };
}

// ─────────────────────────── Rotas ───────────────────────────

export async function forecastRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

  app.get(
    '/api/v1/orders/:id/material-forecasts',
    { config: { access: VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return loadOrderForecasts(prisma, id, canSeePrices(request));
    },
  );

  /** "Prever material" na peça do pedido — previsão, nunca medição. */
  app.post(
    '/api/v1/orders/:id/items/:itemId/material-forecasts',
    { config: { access: APPROVE, idempotent: true } },
    async (request, reply) => {
      const { id, itemId } = itemParams.parse(request.params);
      const input = materialForecastSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        if (!(await lockOrder(tx, id))) throw Errors.notFound('Pedido');
        const order = await tx.commercialOrder.findUniqueOrThrow({
          where: { id },
          include: { items: true },
        });
        if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
        const item = order.items.find((i) => i.id === itemId);
        if (!item) throw Errors.validation(undefined, 'A peça não pertence a este pedido.');
        const alloc = await itemAllocations(tx, id);
        if (alloc.inServiceOrders(item.id) > 0)
          throw Errors.business(
            'Esta peça já está em uma OS: o material é levantado pela medição real.',
          );
        const r = await tx.materialRequirement.create({
          data: {
            ...specData(input),
            origin: 'PREVISAO_COMPRA',
            orderItemId: item.id,
            serviceOrderId: null,
          },
        });
        await audit(tx, actor, {
          action: 'material_forecast.created',
          entityType: 'commercial_order',
          entityId: id,
          summary: `Previsão de material (não medido) para "${item.description}": ${input.description} — ${input.quantity}.`,
          changes: { requirementId: r.id, orderItemId: item.id, ...specData(input) },
        });
      });
      return reply.status(201).send(await loadOrderForecasts(prisma, id, canSeePrices(request)));
    },
  );

  /**
   * AB-9: previsão virgem é editada no lugar (auditoria antes/depois). Com QUALQUER vínculo
   * (inclusive rascunho), a alteração cria nova previsão ATIVA que SUBSTITUI a anterior (cadeia
   * da Etapa 2); fornecedor nunca é cancelado. Só antes da chegada.
   */
  app.put(
    '/api/v1/material-forecasts/:id',
    { config: { access: APPROVE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = materialForecastSchema.parse(request.body);
      const actor = actorFrom(request);
      const orderId = await prisma.$transaction(async (tx) => {
        const r = await lockForecast(tx, id);
        if (r.serviceOrderId)
          throw Errors.business(
            'A previsão já está na OS: a alteração é feita pela medição real (que a substitui).',
          );
        if (r.status !== 'ATIVA')
          throw Errors.conflict(
            `A previsão foi ${r.status === 'SUBSTITUIDA' ? 'substituída' : 'cancelada'}. Atualize a tela.`,
            { status: r.status },
          );
        if (r.orderItem.order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
        const before = specSnapshot(r);
        if (await isVirgin(tx, id)) {
          await tx.materialRequirement.update({ where: { id }, data: specData(input) });
          await audit(tx, actor, {
            action: 'material_forecast.edited',
            entityType: 'commercial_order',
            entityId: r.orderItem.orderId,
            summary: `Previsão de material alterada (sem vínculos): ${before.description} ${before.quantity} → ${input.description} ${input.quantity}.`,
            changes: { requirementId: id, before, after: specData(input) },
          });
        } else {
          const now = new Date();
          await tx.materialRequirement.update({
            where: { id },
            data: {
              status: 'SUBSTITUIDA',
              closedAt: now,
              closedById: actor.userId,
              closeReason: 'Previsão alterada (havia compra ou outro vínculo)',
            },
          });
          const next = await tx.materialRequirement.create({
            data: {
              ...specData(input),
              origin: 'PREVISAO_COMPRA',
              orderItemId: r.orderItemId,
              serviceOrderId: null,
              replacesRequirementId: id,
            },
          });
          await audit(tx, actor, {
            action: 'material_forecast.replaced',
            entityType: 'commercial_order',
            entityId: r.orderItem.orderId,
            summary: `Previsão alterada: ${before.description} ${before.quantity} → ${input.description} ${input.quantity} (nova previsão substitui a anterior; compras mantidas).`,
            changes: { from: id, to: next.id, before, after: specData(input) },
          });
        }
        return r.orderItem.orderId;
      });
      return loadOrderForecasts(prisma, orderId, canSeePrices(request));
    },
  );

  /** AB-3: vinculação explícita pelo gestor (chegada parcial / destino ambíguo). */
  app.post(
    '/api/v1/material-forecasts/:id/link',
    { config: { access: APPROVE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = forecastLinkSchema.parse(request.body);
      const actor = actorFrom(request);
      const orderId = await prisma.$transaction(async (tx) => {
        const r = await lockForecast(tx, id);
        const orderId = r.orderItem.orderId;
        if (r.serviceOrderId) return orderId; // já vinculada (repetição): nada muda
        if (r.status !== 'ATIVA')
          throw Errors.conflict('Só a previsão ativa pode ser vinculada. Atualize a tela.');
        const si = await tx.serviceOrderItem.findUnique({
          where: { id: input.serviceOrderItemId },
          include: { serviceOrder: { select: { status: true } } },
        });
        if (!si || si.orderItemId !== r.orderItemId)
          throw Errors.validation(undefined, 'Escolha uma peça de OS desta mesma peça do pedido.');
        if (si.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está aberta.');
        if (si.fulfillmentStage === 'DEVOLVIDA' || si.fulfillmentStage === 'CANCELADA')
          throw Errors.business('A peça escolhida foi devolvida ou cancelada.');
        // A cadeia pré-OS da previsão (predecessoras substituídas) vai junto: o histórico segue.
        const chain: string[] = [];
        let cur: Pick<MaterialRequirement, 'id' | 'replacesRequirementId'> | null = r;
        while (cur && !chain.includes(cur.id)) {
          chain.push(cur.id);
          cur = cur.replacesRequirementId
            ? await tx.materialRequirement.findFirst({
                where: { id: cur.replacesRequirementId, serviceOrderId: null },
                select: { id: true, replacesRequirementId: true },
              })
            : null;
        }
        await linkForecasts(
          tx,
          actor,
          chain,
          { serviceOrderId: si.serviceOrderId, serviceOrderItemId: si.id },
          'linked_manually',
        );
        return orderId;
      });
      return loadOrderForecasts(prisma, orderId, canSeePrices(request));
    },
  );
}

function specSnapshot(r: {
  description: string;
  quantity: Prisma.Decimal | null;
  unitCode: string | null;
  color: string | null;
  reference: string | null;
}) {
  return {
    description: r.description,
    quantity: num(r.quantity),
    unit: r.unitCode as MaterialUnit | null,
    color: r.color,
    reference: r.reference,
  };
}
