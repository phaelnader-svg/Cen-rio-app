import {
  EVENT_TYPES,
  movementQuerySchema,
  q3,
  releaseReservationSchema,
  reservationQuerySchema,
  reservationSchema,
  specMismatch,
  stockAdjustSchema,
  stockIssueSchema,
  stockItemCode,
  stockItemSchema,
  unitError,
  updateStockItemSchema,
  type MaterialUnit,
  type StockMovementDto,
} from '@cenario/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import {
  MANAGEMENT_AUDIENCE,
  STOCK_MANAGE,
  STOCK_VIEW,
  changeStock,
  lockRows,
  lockStockItem,
  num,
  refreshReadiness,
  reservationInclude,
  specOf,
  stockSpecKey,
  toReservationDto,
  toStockItemDto,
} from './common';

const EPS = 1e-6;

export async function stockRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // ─────────────────────────── Catálogo e saldos ───────────────────────────

  app.get('/api/v1/stock-items', { config: { access: STOCK_VIEW } }, async () => {
    const rows = await prisma.stockItem.findMany({
      orderBy: [{ kind: 'asc' }, { description: 'asc' }],
    });
    return rows.map(toStockItemDto);
  });

  app.post('/api/v1/stock-items', { config: { access: STOCK_MANAGE } }, async (request, reply) => {
    const input = stockItemSchema.parse(request.body);
    const actor = actorFrom(request);
    const spec = {
      kind: input.kind,
      description: input.description,
      color: null,
      reference: null,
      foamDensity: input.foamDensity ?? null,
      thicknessCm: input.thicknessCm ?? null,
      lengthCm: input.lengthCm ?? null,
      widthCm: input.widthCm ?? null,
      unit: input.unit,
    };
    const specKey = stockSpecKey(spec);
    const item = await prisma.$transaction(async (tx) => {
      if (await tx.stockItem.findUnique({ where: { specKey } })) {
        throw Errors.conflict('Este material já está cadastrado no estoque (mesma especificação).');
      }
      const created = await tx.stockItem.create({
        data: {
          kind: input.kind,
          description: input.description,
          foamDensity: input.foamDensity ?? null,
          thicknessCm: input.thicknessCm ?? null,
          lengthCm: input.lengthCm ?? null,
          widthCm: input.widthCm ?? null,
          unit: input.unit,
          specKey,
          minQuantity: input.minQuantity ?? null,
          location: input.location ?? null,
          notes: input.notes ?? null,
          active: input.active,
        },
      });
      await audit(tx, actor, {
        action: 'stock_item.created',
        entityType: 'stock_item',
        entityId: created.id,
        summary: `Material ${stockItemCode(created.number)} (${created.description}) cadastrado no estoque.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.STOCK_MOVED,
        aggregateType: 'stock_item',
        aggregateId: created.id,
        payload: { stockItemId: created.id },
        audience: MANAGEMENT_AUDIENCE,
      });
      return created;
    });
    return reply.status(201).send(toStockItemDto(item));
  });

  /** Estoque mínimo, localização, observações e ativação (a especificação não muda). */
  app.put('/api/v1/stock-items/:id', { config: { access: STOCK_MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateStockItemSchema.parse(request.body);
    const actor = actorFrom(request);
    const item = await prisma.$transaction(async (tx) => {
      const cur = await lockStockItem(tx, id);
      if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
      if (input.minQuantity && unitError(cur.kind, cur.unit, input.minQuantity)) {
        throw Errors.validation([
          { path: 'minQuantity', message: 'Nesta unidade use número inteiro.' },
        ]);
      }
      const updated = await tx.stockItem.update({
        where: { id },
        data: {
          minQuantity: input.minQuantity ?? null,
          location: input.location ?? null,
          notes: input.notes ?? null,
          active: input.active,
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'stock_item.updated',
        entityType: 'stock_item',
        entityId: id,
        summary: `Material ${stockItemCode(cur.number)} atualizado.`,
        changes: { minQuantity: input.minQuantity ?? null, active: input.active },
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.STOCK_MOVED,
        aggregateType: 'stock_item',
        aggregateId: id,
        payload: { stockItemId: id },
        audience: MANAGEMENT_AUDIENCE,
      });
      return updated;
    });
    return toStockItemDto(item);
  });

  /** Ajuste de inventário (entrada ou saída), com motivo. Nunca abaixo do reservado. */
  app.post(
    '/api/v1/stock-items/:id/adjust',
    { config: { access: STOCK_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = stockAdjustSchema.parse(request.body);
      const actor = actorFrom(request);
      const item = await prisma.$transaction(async (tx) => {
        const stock = await lockStockItem(tx, id);
        const err = unitError(stock.kind, stock.unit, Math.abs(input.quantity));
        if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
        if (num(stock.onHand) + input.quantity < num(stock.reserved) - EPS) {
          throw Errors.conflict(
            num(stock.onHand) + input.quantity < 0
              ? 'O ajuste deixaria o estoque negativo.'
              : 'O ajuste deixaria o estoque abaixo do que está reservado para OS.',
          );
        }
        await changeStock(tx, actor, stock, {
          onHand: input.quantity,
          movement: {
            type: input.quantity > 0 ? 'AJUSTE_ENTRADA' : 'AJUSTE_SAIDA',
            reason: input.reason,
          },
        });
        await audit(tx, actor, {
          action: 'stock.adjusted',
          entityType: 'stock_item',
          entityId: id,
          summary: `Ajuste de ${input.quantity} em ${stockItemCode(stock.number)}: ${input.reason}`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.STOCK_MOVED,
          aggregateType: 'stock_item',
          aggregateId: id,
          payload: { stockItemId: id, quantity: input.quantity },
          audience: MANAGEMENT_AUDIENCE,
        });
        return tx.stockItem.findUniqueOrThrow({ where: { id } });
      });
      return toStockItemDto(item);
    },
  );

  /** Saída de material livre (sem reserva), opcionalmente para uma OS. */
  app.post(
    '/api/v1/stock-items/:id/issue',
    { config: { access: STOCK_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = stockIssueSchema.parse(request.body);
      const actor = actorFrom(request);
      const item = await prisma.$transaction(async (tx) => {
        const stock = await lockStockItem(tx, id);
        const err = unitError(stock.kind, stock.unit, input.quantity);
        if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
        if (input.serviceOrderId) {
          const so = await tx.serviceOrder.findUnique({ where: { id: input.serviceOrderId } });
          if (!so) throw Errors.notFound('Ordem de serviço');
        }
        await changeStock(tx, actor, stock, {
          onHand: -input.quantity,
          movement: {
            type: 'SAIDA_OS',
            serviceOrderId: input.serviceOrderId ?? null,
            reason: input.reason,
          },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.STOCK_MOVED,
          aggregateType: 'stock_item',
          aggregateId: id,
          payload: { stockItemId: id, quantity: -input.quantity },
          audience: MANAGEMENT_AUDIENCE,
        });
        return tx.stockItem.findUniqueOrThrow({ where: { id } });
      });
      return toStockItemDto(item);
    },
  );

  app.get('/api/v1/stock-movements', { config: { access: STOCK_VIEW } }, async (request) => {
    const q = movementQuerySchema.parse(request.query);
    const rows = await prisma.stockMovement.findMany({
      where: {
        ...(q.stockItemId ? { stockItemId: q.stockItemId } : {}),
        ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
      },
      include: {
        stockItem: true,
        serviceOrder: { select: { id: true, number: true } },
        actor: { select: { displayName: true } },
        receiptLine: { include: { receipt: { select: { number: true } } } },
        reservation: { include: { serviceOrder: { select: { id: true, number: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return rows.map((m): StockMovementDto => {
      const so = m.serviceOrder ?? m.reservation?.serviceOrder ?? null;
      return {
        id: m.id,
        type: m.type,
        stockItem: {
          id: m.stockItem.id,
          code: stockItemCode(m.stockItem.number),
          description: m.stockItem.description,
          unit: m.stockItem.unit,
        },
        quantity: num(m.quantity),
        balanceAfter: num(m.balanceAfter),
        reservedAfter: num(m.reservedAfter),
        serviceOrder: so ? { id: so.id, code: serviceOrderCode(so.number) } : null,
        reference: m.receiptLine
          ? `RM-${String(m.receiptLine.receipt.number).padStart(5, '0')}`
          : null,
        reason: m.reason,
        actor: m.actor?.displayName ?? null,
        createdAt: m.createdAt.toISOString(),
      };
    });
  });

  // ─────────────────────────── Reservas por OS ───────────────────────────

  app.get('/api/v1/stock-reservations', { config: { access: STOCK_VIEW } }, async (request) => {
    const q = reservationQuerySchema.parse(request.query);
    const rows = await prisma.stockReservation.findMany({
      where: {
        ...(q.stockItemId ? { stockItemId: q.stockItemId } : {}),
        ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
        ...(q.status?.length ? { status: { in: q.status } } : {}),
      },
      include: reservationInclude,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(toReservationDto);
  });

  /**
   * Reserva material comum para uma OS. O material é bloqueado (FOR UPDATE): duas
   * OS nunca reservam a mesma quantidade. Tecido não sai do estoque comum.
   */
  app.post(
    '/api/v1/stock-reservations',
    { config: { access: STOCK_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = reservationSchema.parse(request.body);
      const actor = actorFrom(request);
      const id = await prisma.$transaction(async (tx) => {
        const stock = await lockStockItem(tx, input.stockItemId);
        if (!stock.active) throw Errors.business('Material inativo.');
        const err = unitError(stock.kind, stock.unit, input.quantity);
        if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
        const so = await tx.serviceOrder.findUnique({ where: { id: input.serviceOrderId } });
        if (!so) throw Errors.notFound('Ordem de serviço');
        if (so.status !== 'ABERTA') throw Errors.business('A OS não está aberta.');
        if (input.materialRequirementId) {
          await lockRows(tx, 'material_requirements', [input.materialRequirementId]);
          const req = await tx.materialRequirement.findUnique({
            where: { id: input.materialRequirementId },
            include: {
              reservations: { where: { status: { in: ['ATIVA', 'CONSUMIDA'] } } },
              transfersIn: true,
            },
          });
          if (!req || req.serviceOrderId !== so.id) {
            throw Errors.business('A necessidade informada não é desta OS.');
          }
          if (req.origin !== 'SOLICITACAO_APROVADA') {
            throw Errors.business('Só necessidades aprovadas podem ser atendidas pelo estoque.');
          }
          if (req.kind === 'TECIDO' || req.sourcing !== 'ESTOQUE') {
            throw Errors.business(
              'Tecido e materiais exclusivos pertencem à OS que os comprou e não saem do estoque comum.',
            );
          }
          const mismatch = specMismatch(specOf(stock, stock.unit), {
            ...specOf(req, req.unitCode as MaterialUnit),
            color: null,
            reference: null,
          });
          if (mismatch)
            throw Errors.business(`Material incompatível com a necessidade: ${mismatch}`);
          const have =
            req.reservations.reduce((s, r) => s + num(r.quantity), 0) +
            req.transfersIn.reduce((s, t) => s + num(t.quantity), 0);
          if (have + input.quantity > num(req.quantity) + EPS) {
            throw Errors.business(
              `Reserva acima da necessidade aprovada (aprovado ${num(req.quantity)}, já atendido ${q3(have)}).`,
            );
          }
        }
        const available = q3(num(stock.onHand) - num(stock.reserved));
        if (input.quantity > available + EPS) {
          throw Errors.conflict(
            `Saldo disponível insuficiente: ${available} disponível (físico ${num(stock.onHand)}, reservado ${num(stock.reserved)}).`,
            { available },
          );
        }
        const r = await tx.stockReservation.create({
          data: {
            stockItemId: stock.id,
            serviceOrderId: so.id,
            materialRequirementId: input.materialRequirementId ?? null,
            quantity: input.quantity,
            notes: input.notes ?? null,
            createdById: actor.userId,
          },
        });
        await changeStock(tx, actor, stock, { reserved: input.quantity });
        await audit(tx, actor, {
          action: 'stock.reserved',
          entityType: 'stock_reservation',
          entityId: r.id,
          summary: `${input.quantity} de ${stockItemCode(stock.number)} reservado(s) para ${serviceOrderCode(so.number)}.`,
        });
        await refreshReadiness(tx, actor, [so.id]);
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.STOCK_RESERVED,
          aggregateType: 'stock_reservation',
          aggregateId: r.id,
          payload: {
            id: r.id,
            serviceOrderId: so.id,
            stockItemId: stock.id,
            quantity: input.quantity,
          },
          audience: MANAGEMENT_AUDIENCE,
        });
        return r.id;
      });
      const r = await prisma.stockReservation.findUniqueOrThrow({
        where: { id },
        include: reservationInclude,
      });
      return reply.status(201).send(toReservationDto(r));
    },
  );

  async function closeReservation(request: FastifyRequest, mode: 'release' | 'consume') {
    const { id } = idParams.parse(request.params);
    const reason = mode === 'release' ? releaseReservationSchema.parse(request.body).reason : null;
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const found = await tx.stockReservation.findUnique({ where: { id } });
      if (!found) throw Errors.notFound('Reserva');
      const stock = await lockStockItem(tx, found.stockItemId);
      await lockRows(tx, 'stock_reservations', [id]);
      const r = await tx.stockReservation.findUniqueOrThrow({ where: { id } });
      if (r.status !== 'ATIVA') throw Errors.business('A reserva não está ativa.');
      const qty = num(r.quantity);
      await tx.stockReservation.update({
        where: { id },
        data: {
          status: mode === 'release' ? 'LIBERADA' : 'CONSUMIDA',
          closedAt: new Date(),
          closedById: actor.userId,
          closeReason: reason,
          version: { increment: 1 },
        },
      });
      await changeStock(
        tx,
        actor,
        stock,
        mode === 'release'
          ? { reserved: -qty }
          : {
              reserved: -qty,
              onHand: -qty,
              movement: {
                type: 'SAIDA_OS',
                serviceOrderId: r.serviceOrderId,
                reservationId: id,
                reason: 'Entrega do material reservado à OS',
              },
            },
      );
      await audit(tx, actor, {
        action: mode === 'release' ? 'stock.released' : 'stock.consumed',
        entityType: 'stock_reservation',
        entityId: id,
        summary:
          mode === 'release'
            ? `Reserva de ${qty} de ${stockItemCode(stock.number)} liberada: ${reason}`
            : `${qty} de ${stockItemCode(stock.number)} entregue(s) à OS.`,
      });
      await refreshReadiness(tx, actor, [r.serviceOrderId]);
      await appendEvent(tx, actor, {
        type: mode === 'release' ? EVENT_TYPES.STOCK_RELEASED : EVENT_TYPES.STOCK_MOVED,
        aggregateType: 'stock_reservation',
        aggregateId: id,
        payload: { id, serviceOrderId: r.serviceOrderId, stockItemId: stock.id, quantity: qty },
        audience: MANAGEMENT_AUDIENCE,
      });
    });
    const r = await prisma.stockReservation.findUniqueOrThrow({
      where: { id },
      include: reservationInclude,
    });
    return toReservationDto(r);
  }

  app.post(
    '/api/v1/stock-reservations/:id/release',
    { config: { access: STOCK_MANAGE } },
    (request) => closeReservation(request, 'release'),
  );
  /** Entrega o material reservado à OS (saída física). Não inicia produção. */
  app.post(
    '/api/v1/stock-reservations/:id/consume',
    { config: { access: STOCK_MANAGE } },
    (request) => closeReservation(request, 'consume'),
  );
}
