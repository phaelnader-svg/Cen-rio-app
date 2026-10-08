import {
  EVENT_TYPES,
  leftoverDiscardSchema,
  lineTotalCents,
  materialReceiptCode,
  purchaseOrderCode,
  leftoverSchema,
  leftoverTransferSchema,
  q3,
  specMismatch,
  unitError,
  type MaterialReadinessDto,
  type MaterialUnit,
  type ReadinessSummaryDto,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import {
  MANAGEMENT_AUDIENCE,
  STOCK_AUTHORIZE,
  STOCK_MANAGE,
  STOCK_VIEW,
  canSeePrices,
  leftoverInclude,
  lockRows,
  num,
  readinessOf,
  refreshReadiness,
  requirementProgress,
  requirementProgressInclude,
  reservationInclude,
  specOf,
  toLeftoverDto,
  toReservationDto,
} from './common';

const EPS = 1e-6;

const READINESS_VIEW = {
  session: 'WEB',
  anyPermissions: ['os.ver', 'estoque.ver', 'compras.ver', 'materiais.ver'],
} as const;

export async function leftoverRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/material-leftovers', { config: { access: STOCK_VIEW } }, async (request) => {
    const q = z
      .object({
        serviceOrderId: z.string().uuid().optional(),
        all: z.enum(['true', 'false']).default('false'),
      })
      .parse(request.query);
    const rows = await prisma.materialLeftover.findMany({
      where: {
        ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
        ...(q.all === 'true' ? {} : { status: 'DISPONIVEL' }),
      },
      include: leftoverInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toLeftoverDto);
  });

  /** Registra sobra após o uso. Continua pertencendo à OS de origem. */
  app.post(
    '/api/v1/material-leftovers',
    { config: { access: STOCK_MANAGE } },
    async (request, reply) => {
      const input = leftoverSchema.parse(request.body);
      const actor = actorFrom(request);
      const err = unitError(input.kind, input.unit, input.quantity);
      if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
      const id = await prisma.$transaction(async (tx) => {
        const so = await tx.serviceOrder.findUnique({ where: { id: input.serviceOrderId } });
        if (!so) throw Errors.notFound('Ordem de serviço');
        const l = await tx.materialLeftover.create({
          data: {
            serviceOrderId: so.id,
            kind: input.kind,
            description: input.description,
            color: input.color ?? null,
            reference: input.reference ?? null,
            foamDensity: input.foamDensity ?? null,
            thicknessCm: input.thicknessCm ?? null,
            quantity: input.quantity,
            initialQuantity: input.quantity,
            unit: input.unit,
            location: input.location,
            condition: input.condition,
            reusable: input.reusable,
            notes: input.notes ?? null,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'leftover.recorded',
          entityType: 'material_leftover',
          entityId: l.id,
          summary: `Sobra de ${input.quantity} (${input.description}) registrada na ${serviceOrderCode(so.number)}.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.LEFTOVER_CHANGED,
          aggregateType: 'material_leftover',
          aggregateId: l.id,
          payload: { id: l.id, serviceOrderId: so.id },
          audience: MANAGEMENT_AUDIENCE,
        });
        return l.id;
      });
      const l = await prisma.materialLeftover.findUniqueOrThrow({
        where: { id },
        include: leftoverInclude,
      });
      return reply.status(201).send(toLeftoverDto(l));
    },
  );

  /**
   * Transferência de sobra para outra OS — somente com autorização do gestor e
   * histórico imutável. Tecidos de referência/cor diferentes não são misturados.
   */
  app.post(
    '/api/v1/material-leftovers/:id/transfer',
    { config: { access: STOCK_AUTHORIZE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = leftoverTransferSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRows(tx, 'material_leftovers', [id]);
        const l = await tx.materialLeftover.findUnique({
          where: { id },
          include: { serviceOrder: true },
        });
        if (!l) throw Errors.notFound('Sobra');
        if (l.status !== 'DISPONIVEL') throw Errors.business('Esta sobra não está disponível.');
        if (input.quantity > num(l.quantity) + EPS) {
          throw Errors.business(`A sobra tem apenas ${num(l.quantity)} disponível.`);
        }
        const err = unitError(l.kind, l.unit, input.quantity);
        if (err) throw Errors.validation([{ path: 'quantity', message: err }], err);
        if (input.targetServiceOrderId === l.serviceOrderId) {
          throw Errors.business('Escolha uma OS diferente da OS de origem.');
        }
        const target = await tx.serviceOrder.findUnique({
          where: { id: input.targetServiceOrderId },
        });
        if (!target) throw Errors.notFound('Ordem de serviço de destino');
        if (target.status !== 'ABERTA') throw Errors.business('A OS de destino não está aberta.');
        if (input.targetRequirementId) {
          await lockRows(tx, 'material_requirements', [input.targetRequirementId]);
          const req = await tx.materialRequirement.findUnique({
            where: { id: input.targetRequirementId },
            include: requirementProgressInclude,
          });
          if (!req || req.serviceOrderId !== target.id || req.origin !== 'SOLICITACAO_APROVADA') {
            throw Errors.business(
              'A necessidade de destino não é uma necessidade aprovada desta OS.',
            );
          }
          const mismatch = specMismatch(
            specOf(l, l.unit),
            specOf({ ...req, lengthCm: null, widthCm: null }, req.unitCode as MaterialUnit),
          );
          if (mismatch) throw Errors.business(mismatch);
          const p = requirementProgress(req);
          if (input.quantity > q3(p.need - p.covered) + EPS) {
            throw Errors.business(
              `A OS de destino precisa de apenas ${q3(p.need - p.covered)} deste material.`,
            );
          }
        }
        const remaining = q3(num(l.quantity) - input.quantity);
        await tx.materialLeftover.update({
          where: { id },
          data: {
            quantity: remaining,
            status: remaining <= 0 ? 'ESGOTADA' : 'DISPONIVEL',
            version: { increment: 1 },
          },
        });
        const t = await tx.materialLeftoverTransfer.create({
          data: {
            leftoverId: id,
            fromServiceOrderId: l.serviceOrderId,
            toServiceOrderId: target.id,
            toRequirementId: input.targetRequirementId ?? null,
            quantity: input.quantity,
            reason: input.reason,
            authorizedById: actor.userId!,
          },
        });
        await audit(tx, actor, {
          action: 'leftover.transferred',
          entityType: 'material_leftover',
          entityId: id,
          summary: `Sobra (${l.description}) transferida: ${input.quantity} da ${serviceOrderCode(l.serviceOrder.number)} para a ${serviceOrderCode(target.number)}. Motivo: ${input.reason}`,
          changes: { transferId: t.id, quantity: input.quantity, remaining },
        });
        await refreshReadiness(tx, actor, [target.id, l.serviceOrderId]);
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.LEFTOVER_CHANGED,
          aggregateType: 'material_leftover',
          aggregateId: id,
          payload: { id, from: l.serviceOrderId, to: target.id, quantity: input.quantity },
          audience: MANAGEMENT_AUDIENCE,
        });
      });
      const l = await prisma.materialLeftover.findUniqueOrThrow({
        where: { id },
        include: leftoverInclude,
      });
      return toLeftoverDto(l);
    },
  );

  app.post(
    '/api/v1/material-leftovers/:id/discard',
    { config: { access: STOCK_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = leftoverDiscardSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRows(tx, 'material_leftovers', [id]);
        const l = await tx.materialLeftover.findUnique({ where: { id } });
        if (!l) throw Errors.notFound('Sobra');
        if (l.status !== 'DISPONIVEL') throw Errors.business('Esta sobra não está disponível.');
        await tx.materialLeftover.update({
          where: { id },
          data: {
            status: 'DESCARTADA',
            notes: [l.notes, `Descartada: ${input.reason}`]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 500),
            version: { increment: 1 },
          },
        });
        await audit(tx, actor, {
          action: 'leftover.discarded',
          entityType: 'material_leftover',
          entityId: id,
          summary: `Sobra (${l.description}) descartada: ${input.reason}`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.LEFTOVER_CHANGED,
          aggregateType: 'material_leftover',
          aggregateId: id,
          payload: { id },
          audience: MANAGEMENT_AUDIENCE,
        });
      });
      const l = await prisma.materialLeftover.findUniqueOrThrow({
        where: { id },
        include: leftoverInclude,
      });
      return toLeftoverDto(l);
    },
  );

  // ─────────────────────────── Prontidão de materiais ───────────────────────────

  /** Prontidão das OS abertas (calculada na hora, a partir dos registros). */
  app.get('/api/v1/material-readiness', { config: { access: READINESS_VIEW } }, async () => {
    const sos = await prisma.serviceOrder.findMany({
      where: { status: 'ABERTA' },
      include: { customer: { select: { name: true } } },
      orderBy: [{ promisedDate: 'asc' }, { number: 'asc' }],
    });
    const out: ReadinessSummaryDto[] = [];
    for (const so of sos) {
      const r = await readinessOf(prisma, so.id);
      out.push({
        serviceOrder: {
          id: so.id,
          code: serviceOrderCode(so.number),
          promisedDate: dateOnly(so.promisedDate),
          priority: so.priority,
        },
        customerName: so.customer.name,
        state: r.state,
        updatedAt: so.materialsReadinessAt?.toISOString() ?? null,
        lines: r.lines.length,
        coveredLines: r.lines.filter((l) => l.covered + EPS >= l.need).length,
      });
    }
    return out;
  });

  app.get(
    '/api/v1/service-orders/:id/material-readiness',
    { config: { access: READINESS_VIEW } },
    async (request): Promise<MaterialReadinessDto> => {
      const { id } = idParams.parse(request.params);
      const so = await prisma.serviceOrder.findUnique({
        where: { id },
        include: { customer: { select: { name: true } } },
      });
      if (!so) throw Errors.notFound('Ordem de serviço');
      const r = await readinessOf(prisma, id);
      const prices = canSeePrices(request);
      const [pos, receipts, reservations, leftovers] = await Promise.all([
        prisma.purchaseOrder.findMany({
          where: {
            items: {
              some: {
                OR: [{ serviceOrderId: id }, { allocations: { some: { serviceOrderId: id } } }],
              },
            },
          },
          include: { supplier: { select: { name: true } }, items: true },
          orderBy: { number: 'asc' },
        }),
        prisma.materialReceipt.findMany({
          where: {
            lines: {
              some: {
                item: {
                  OR: [{ serviceOrderId: id }, { allocations: { some: { serviceOrderId: id } } }],
                },
              },
            },
          },
          include: {
            purchaseOrder: { select: { number: true } },
            receivedBy: { select: { displayName: true } },
            lines: true,
          },
          orderBy: { receivedAt: 'asc' },
        }),
        prisma.stockReservation.findMany({
          where: { serviceOrderId: id },
          include: reservationInclude,
          orderBy: { createdAt: 'asc' },
        }),
        prisma.materialLeftover.findMany({
          where: {
            OR: [{ serviceOrderId: id }, { transfers: { some: { toServiceOrderId: id } } }],
          },
          include: leftoverInclude,
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      return {
        serviceOrder: {
          id: so.id,
          code: serviceOrderCode(so.number),
          status: so.status,
          promisedDate: dateOnly(so.promisedDate),
          priority: so.priority,
        },
        customerName: so.customer.name,
        state: r.state,
        updatedAt: so.materialsReadinessAt?.toISOString() ?? null,
        pending: { openMeasurements: r.openMeasurements, pendingRequests: r.pendingRequests },
        lines: r.lines,
        purchaseOrders: pos.map((po) => ({
          id: po.id,
          code: purchaseOrderCode(po.number),
          status: po.status,
          supplierName: po.supplier?.name ?? null,
          expectedDate: dateOnly(po.expectedDate),
          totalCents: prices
            ? po.items.reduce(
                (s, i) => s + (lineTotalCents(num(i.quantity), i.unitPriceCents) ?? 0),
                0,
              )
            : null,
        })),
        receipts: receipts.map((rc) => ({
          id: rc.id,
          code: materialReceiptCode(rc.number),
          purchaseOrderCode: purchaseOrderCode(rc.purchaseOrder.number),
          receivedAt: rc.receivedAt.toISOString(),
          receivedBy: rc.receivedBy.displayName,
          accepted: q3(rc.lines.reduce((s, l) => s + num(l.acceptedQuantity), 0)),
          issues: rc.lines.filter((l) => l.issue).length,
        })),
        reservations: reservations.map(toReservationDto),
        leftovers: leftovers.map(toLeftoverDto),
        canStartProduction: false,
      };
    },
  );
}
