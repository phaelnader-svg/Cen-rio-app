import {
  EVENT_TYPES,
  anyPermissionAudience,
  cancelServiceOrderSchema,
  createServiceOrderSchema,
  formatServiceOrderItemCode,
  materialRequirementSchema,
  measurementSchema,
  serviceOrderQuerySchema,
  updateServiceOrderItemSchema,
  updateServiceOrderSchema,
  type MeasurementDto,
  type PageDto,
  type ServiceOrderDto,
  type ServiceOrderRevisionDto,
  type ServiceOrderSummaryDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { diffObjects } from '../../lib/diff';
import { Errors } from '../../lib/errors';
import { protectCancelledServiceOrder } from '../production/cancellation';
import { readinessOf } from '../purchasing/common';
import { idParams, toEmployeeSummary } from '../presenters';
import {
  can,
  dateOnly,
  lockOrder,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  serviceOrderCode,
  toCustomerSummary,
} from '../commercial/common';
import { itemAllocations } from '../commercial/status';
import { emitOrderEvent } from '../orders/routes';

const VIEW = { session: 'any', permissions: ['os.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['os.gerenciar'] } as const;
const AUDIENCE = anyPermissionAudience('os.ver', 'pedidos.ver');
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const materialParams = z.object({ id: z.string().uuid(), materialId: z.string().uuid() });

const fullInclude = {
  order: { select: { id: true, number: true } },
  customer: true,
  technicalLead: true,
  createdBy: { select: { displayName: true } },
  items: {
    include: {
      measuredBy: { select: { displayName: true } },
      orderItem: { include: { receiptLines: { select: { location: true } } } },
    },
    orderBy: { position: 'asc' as const },
  },
  materials: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.ServiceOrderInclude;

function measurementsOf(json: Prisma.JsonValue): MeasurementDto[] {
  return Array.isArray(json) ? (json as unknown as MeasurementDto[]) : [];
}

export async function loadServiceOrderDto(
  db: PrismaClient | Tx,
  id: string,
): Promise<ServiceOrderDto> {
  const so = await db.serviceOrder.findUnique({ where: { id }, include: fullInclude });
  if (!so) throw Errors.notFound('Ordem de serviço');
  const measuredCount = so.items.filter((i) => measurementsOf(i.measurements).length > 0).length;
  const materialsState = (await readinessOf(db, id)).state;
  // Fase 5: programada quando há tarefa ativa em planejamento publicado.
  const scheduled = await db.productionTask.count({
    where: {
      serviceOrderId: id,
      plan: { status: 'PUBLICADO' },
      status: { notIn: ['RASCUNHO', 'CANCELADA'] },
    },
  });
  return {
    id: so.id,
    number: so.number,
    code: serviceOrderCode(so.number),
    status: so.status,
    order: { id: so.order.id, code: orderCode(so.order.number) },
    customer: toCustomerSummary(so.customer),
    priority: so.priority,
    promisedDate: dateOnly(so.promisedDate),
    technicalLead: so.technicalLead ? toEmployeeSummary(so.technicalLead) : null,
    itemCount: so.items.length,
    pieceCount: so.items.reduce((a, i) => a + i.quantity, 0),
    createdAt: so.createdAt.toISOString(),
    technicalInstructions: so.technicalInstructions,
    notes: so.notes,
    items: so.items.map((i) => ({
      id: i.id,
      code: formatServiceOrderItemCode(so.number, i.position),
      position: i.position,
      orderItemId: i.orderItemId,
      pieceType: i.pieceType,
      description: i.description,
      quantity: i.quantity,
      serviceType: i.serviceType,
      fabricName: i.fabricName,
      fabricColor: i.fabricColor,
      fabricReference: i.fabricReference,
      foamSpecs: i.foamSpecs,
      technicalNotes: i.technicalNotes,
      measurements: measurementsOf(i.measurements),
      measurementNotes: i.measurementNotes,
      measuredAt: i.measuredAt?.toISOString() ?? null,
      measuredBy: i.measuredBy?.displayName ?? null,
      measurementKind: i.measurementKind,
      locations: [...new Set(i.orderItem.receiptLines.map((l) => l.location))],
      version: i.version,
    })),
    materials: so.materials.map((m) => ({
      id: m.id,
      serviceOrderItemId: m.serviceOrderItemId,
      kind: m.kind,
      description: m.description,
      quantity: m.quantity ? Number(m.quantity) : null,
      unit: m.unitCode ?? m.unit,
      sourcing: m.sourcing,
      notes: m.notes,
      createdAt: m.createdAt.toISOString(),
      origin: m.origin,
      color: m.color,
      foamDensity: m.foamDensity,
      thicknessCm: m.thicknessCm ? Number(m.thicknessCm) : null,
    })),
    // Prontidão para produção: apenas informativa. O início é decidido tarefa a
    // tarefa pelo motor de liberação (Fase 5), nunca pela OS como um todo.
    readiness: {
      measurements: so.items.length > 0 && measuredCount === so.items.length ? 'OK' : 'PENDENTE',
      technicalLead: so.technicalLeadId ? 'OK' : 'PENDENTE',
      // Fase 4: calculada a partir de solicitações, compras, recebimentos e reservas.
      materials: materialsState === 'COMPLETO' ? 'OK' : 'PENDENTE',
      materialsState,
      scheduling: scheduled > 0 ? 'OK' : 'PENDENTE',
      canStartProduction: false,
    },
    cancelledAt: so.cancelledAt?.toISOString() ?? null,
    cancelReason: so.cancelReason,
    createdBy: so.createdBy?.displayName ?? null,
    version: so.version,
    updatedAt: so.updatedAt.toISOString(),
  };
}

/** Bloqueia a OS e devolve o próximo número de revisão do histórico técnico. */
async function lockForRevision(tx: Tx, id: string): Promise<number> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM service_orders WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Ordem de serviço');
  const last = await tx.serviceOrderRevision.aggregate({
    where: { serviceOrderId: id },
    _max: { revision: true },
  });
  return (last._max.revision ?? 0) + 1;
}

async function recordChange(
  tx: Tx,
  request: FastifyRequest,
  so: { id: string; number: number },
  revision: number,
  entry: {
    scope: ServiceOrderRevisionDto['scope'];
    itemId?: string | null;
    changes: object;
    reason?: string | null;
    summary: string;
    action: string;
  },
  type: (typeof EVENT_TYPES)[
    | 'SERVICE_ORDER_CREATED'
    | 'SERVICE_ORDER_UPDATED'] = EVENT_TYPES.SERVICE_ORDER_UPDATED,
) {
  const actor = actorFrom(request);
  await tx.serviceOrderRevision.create({
    data: {
      serviceOrderId: so.id,
      revision,
      scope: entry.scope,
      itemId: entry.itemId ?? null,
      changes: entry.changes as Prisma.InputJsonValue,
      reason: entry.reason ?? null,
      changedById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: entry.action,
    entityType: 'service_order',
    entityId: so.id,
    summary: entry.summary,
    changes: entry.changes,
  });
  const current = await tx.serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
  await appendEvent(tx, actor, {
    type,
    aggregateType: 'service_order',
    aggregateId: so.id,
    payload: {
      id: so.id,
      code: serviceOrderCode(so.number),
      revision,
      status: current.status,
      version: current.version,
    },
    audience: AUDIENCE,
  });
}

/** Dia da semana (0 = domingo) no fuso da empresa. */
function weekdayIn(timezone: string, date = new Date()): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(
    date,
  );
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

export async function serviceOrderRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/service-orders', { config: { access: VIEW } }, async (request) => {
    const q = serviceOrderQuerySchema.parse(request.query);
    const numberMatch = q.q?.match(/^(?:os-?)?0*(\d{1,9})$/i);
    const where: Prisma.ServiceOrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.orderId ? { orderId: q.orderId } : {}),
      ...(q.q
        ? {
            OR: [
              ...(numberMatch ? [{ number: Number(numberMatch[1]) }] : []),
              { customer: { name: { contains: q.q, mode: 'insensitive' } } },
              { items: { some: { description: { contains: q.q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.serviceOrder.count({ where }),
      prisma.serviceOrder.findMany({
        where,
        include: {
          order: { select: { id: true, number: true } },
          customer: true,
          technicalLead: true,
          items: { select: { quantity: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: q.limit,
        skip: q.offset,
      }),
    ]);
    return {
      total,
      items: rows.map(
        (so): ServiceOrderSummaryDto => ({
          id: so.id,
          number: so.number,
          code: serviceOrderCode(so.number),
          status: so.status,
          order: { id: so.order.id, code: orderCode(so.order.number) },
          customer: toCustomerSummary(so.customer),
          priority: so.priority,
          promisedDate: dateOnly(so.promisedDate),
          technicalLead: so.technicalLead ? toEmployeeSummary(so.technicalLead) : null,
          itemCount: so.items.length,
          pieceCount: so.items.reduce((a, i) => a + i.quantity, 0),
          createdAt: so.createdAt.toISOString(),
        }),
      ),
    } satisfies PageDto<ServiceOrderSummaryDto>;
  });

  /** Peças recebidas ainda não incluídas em OS (base para criar a OS). */
  app.get('/api/v1/service-orders/available', { config: { access: MANAGE } }, async (request) => {
    const { orderId } = z.object({ orderId: z.string().uuid() }).parse(request.query);
    const order = await prisma.commercialOrder.findUnique({
      where: { id: orderId },
      include: { customer: true, items: { orderBy: { position: 'asc' } } },
    });
    if (!order) throw Errors.notFound('Pedido');
    const alloc = await itemAllocations(prisma as unknown as Tx, orderId);
    return {
      order: {
        id: order.id,
        code: orderCode(order.number),
        status: order.status,
        contractedService: order.contractedService,
      },
      customer: toCustomerSummary(order.customer),
      items: order.items.map((i) => ({
        orderItemId: i.id,
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
        receivedQuantity: i.receivedQuantity,
        inServiceOrders: alloc.inServiceOrders(i.id),
        available: i.receivedQuantity - alloc.inServiceOrders(i.id),
      })),
    };
  });

  app.get('/api/v1/service-orders/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadServiceOrderDto(prisma, id);
  });

  app.get('/api/v1/service-orders/:id/revisions', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const so = await prisma.serviceOrder.findUnique({ where: { id }, include: { items: true } });
    if (!so) throw Errors.notFound('Ordem de serviço');
    const revisions = await prisma.serviceOrderRevision.findMany({
      where: { serviceOrderId: id },
      include: { changedBy: { select: { displayName: true } } },
      orderBy: { revision: 'desc' },
    });
    const codes = new Map(
      so.items.map((i) => [i.id, formatServiceOrderItemCode(so.number, i.position)]),
    );
    return revisions.map(
      (r): ServiceOrderRevisionDto => ({
        id: r.id,
        revision: r.revision,
        scope: r.scope as ServiceOrderRevisionDto['scope'],
        itemCode: r.itemId ? (codes.get(r.itemId) ?? null) : null,
        changes: r.changes,
        reason: r.reason,
        changedBy: r.changedBy?.displayName ?? null,
        createdAt: r.createdAt.toISOString(),
      }),
    );
  });

  /**
   * Cria a OS técnica. Só aceita peças efetivamente recebidas e ainda não
   * incluídas em outra OS ativa — antes do recebimento físico, a OS é bloqueada.
   */
  app.post(
    '/api/v1/service-orders',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createServiceOrderSchema.parse(request.body);
      const id = await prisma.$transaction(async (tx) => {
        if (!(await lockOrder(tx, input.orderId))) throw Errors.notFound('Pedido');
        await lockOrderItems(tx, input.orderId);
        const order = await tx.commercialOrder.findUniqueOrThrow({
          where: { id: input.orderId },
          include: { items: true },
        });
        if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
        const totalReceived = order.items.reduce((a, i) => a + i.receivedQuantity, 0);
        if (totalReceived === 0) {
          throw Errors.business(
            'A OS técnica só pode ser criada depois que a peça chegar à oficina. Registre o recebimento primeiro.',
          );
        }
        const alloc = await itemAllocations(tx, order.id);
        const requested = new Map<string, number>();
        for (const it of input.items) {
          requested.set(it.orderItemId, (requested.get(it.orderItemId) ?? 0) + it.quantity);
        }
        for (const [orderItemId, qty] of requested) {
          const item = order.items.find((i) => i.id === orderItemId);
          if (!item) throw Errors.validation(undefined, 'Peça não pertence a este pedido.');
          const available = item.receivedQuantity - alloc.inServiceOrders(item.id);
          if (qty > available) {
            throw Errors.business(
              available <= 0
                ? `"${item.description}" ainda não foi recebida ou já está em outra OS.`
                : `"${item.description}": apenas ${available} peça(s) recebida(s) disponível(is) para OS.`,
            );
          }
        }
        if (input.technicalLeadId) {
          const lead = await tx.employee.findUnique({ where: { id: input.technicalLeadId } });
          if (!lead || !lead.active)
            throw Errors.validation(undefined, 'Responsável técnico inválido.');
        }
        const actor = actorFrom(request);
        const so = await tx.serviceOrder.create({
          data: {
            orderId: order.id,
            customerId: order.customerId,
            technicalInstructions: input.technicalInstructions ?? null,
            notes: input.notes ?? null,
            promisedDate: parseDateOnly(input.promisedDate),
            priority: input.priority,
            technicalLeadId: input.technicalLeadId ?? null,
            createdById: actor.userId,
            items: {
              create: input.items.map((it, idx) => {
                const oi = order.items.find((i) => i.id === it.orderItemId)!;
                return {
                  orderItemId: oi.id,
                  position: idx + 1,
                  pieceType: oi.pieceType,
                  description: it.description,
                  quantity: it.quantity,
                  serviceType: it.serviceType,
                  fabricName: it.fabricName ?? null,
                  fabricColor: it.fabricColor ?? null,
                  fabricReference: it.fabricReference ?? null,
                  foamSpecs: it.foamSpecs ?? null,
                  technicalNotes: it.technicalNotes ?? null,
                };
              }),
            },
          },
        });
        await recordChange(
          tx,
          request,
          so,
          1,
          {
            scope: 'CRIACAO',
            changes: {
              items: input.items.map((i) => ({
                description: i.description,
                quantity: i.quantity,
                serviceType: i.serviceType,
              })),
              priority: input.priority,
              promisedDate: input.promisedDate ?? null,
            },
            summary: `OS ${serviceOrderCode(so.number)} criada a partir do pedido ${orderCode(order.number)}.`,
            action: 'service_order.created',
          },
          EVENT_TYPES.SERVICE_ORDER_CREATED,
        );
        await emitOrderEvent(tx, request, order.id);
        return so.id;
      });
      return reply.status(201).send(await loadServiceOrderDto(prisma, id));
    },
  );

  app.put('/api/v1/service-orders/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateServiceOrderSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const revision = await lockForRevision(tx, id);
      const before = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (before.status === 'CANCELADA')
        throw Errors.business('OS cancelada não pode ser alterada.');
      if (input.technicalLeadId) {
        const lead = await tx.employee.findUnique({ where: { id: input.technicalLeadId } });
        if (!lead || !lead.active)
          throw Errors.validation(undefined, 'Responsável técnico inválido.');
      }
      const after = await tx.serviceOrder.update({
        where: { id, version: input.version },
        data: {
          technicalInstructions: input.technicalInstructions ?? null,
          notes: input.notes ?? null,
          promisedDate: parseDateOnly(input.promisedDate),
          priority: input.priority,
          technicalLeadId: input.technicalLeadId ?? null,
          version: { increment: 1 },
        },
      });
      const changes = diffObjects(
        { ...before, promisedDate: dateOnly(before.promisedDate) },
        { ...after, promisedDate: dateOnly(after.promisedDate) },
        ['technicalInstructions', 'notes', 'promisedDate', 'priority', 'technicalLeadId'],
      );
      if (Object.keys(changes).length === 0) return;
      await recordChange(tx, request, after, revision, {
        scope: 'OS',
        changes,
        reason: input.reason,
        summary: `OS ${serviceOrderCode(after.number)} alterada.`,
        action: 'service_order.updated',
      });
    });
    return loadServiceOrderDto(prisma, id);
  });

  app.put(
    '/api/v1/service-orders/:id/items/:itemId',
    { config: { access: MANAGE } },
    async (request) => {
      const { id, itemId } = itemParams.parse(request.params);
      const input = updateServiceOrderItemSchema.parse(request.body);
      await prisma.$transaction(async (tx) => {
        const revision = await lockForRevision(tx, id);
        const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
        if (so.status === 'CANCELADA') throw Errors.business('OS cancelada não pode ser alterada.');
        const before = await tx.serviceOrderItem.findFirst({
          where: { id: itemId, serviceOrderId: id },
        });
        if (!before) throw Errors.notFound('Item da OS');
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        const after = await tx.serviceOrderItem.update({
          where: { id: itemId, version: input.version },
          data: {
            serviceType: input.serviceType,
            description: input.description,
            fabricName: input.fabricName ?? null,
            fabricColor: input.fabricColor ?? null,
            fabricReference: input.fabricReference ?? null,
            foamSpecs: input.foamSpecs ?? null,
            technicalNotes: input.technicalNotes ?? null,
            version: { increment: 1 },
          },
        });
        const changes = diffObjects(before, after, [
          'serviceType',
          'description',
          'fabricName',
          'fabricColor',
          'fabricReference',
          'foamSpecs',
          'technicalNotes',
        ]);
        if (Object.keys(changes).length === 0) return;
        await tx.serviceOrder.update({ where: { id }, data: { updatedAt: new Date() } });
        await recordChange(tx, request, so, revision, {
          scope: 'ITEM',
          itemId,
          changes,
          reason: input.reason,
          summary: `Especificações de ${formatServiceOrderItemCode(so.number, before.position)} alteradas.`,
          action: 'service_order.item_updated',
        });
      });
      return loadServiceOrderDto(prisma, id);
    },
  );

  /**
   * Medições. O gestor é o responsável principal (rotina no dia configurado, em
   * geral sexta-feira); fora disso, ou por tapeceiro autorizado, a medição é
   * registrada como extraordinária.
   */
  app.put(
    '/api/v1/service-orders/:id/items/:itemId/measurements',
    {
      // Fase 3: tapeceiros medem somente pelas medições atribuídas (/api/v1/measurements);
      // o registro direto ficou restrito ao gestor.
      config: { access: { session: 'WEB', permissions: ['os.gerenciar'] } },
    },
    async (request) => {
      const { id, itemId } = itemParams.parse(request.params);
      const input = measurementSchema.parse(request.body);
      const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
      const isManager = can(request, 'os.gerenciar');
      const routineDay =
        weekdayIn(company?.timezone ?? 'America/Sao_Paulo') === (company?.measurementWeekday ?? 5);
      const kind = isManager && routineDay ? 'ROTINA' : 'EXTRAORDINARIA';
      await prisma.$transaction(async (tx) => {
        const revision = await lockForRevision(tx, id);
        const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
        if (so.status === 'CANCELADA') throw Errors.business('OS cancelada não pode ser alterada.');
        const before = await tx.serviceOrderItem.findFirst({
          where: { id: itemId, serviceOrderId: id },
        });
        if (!before) throw Errors.notFound('Item da OS');
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        const actor = actorFrom(request);
        await tx.serviceOrderItem.update({
          where: { id: itemId, version: input.version },
          data: {
            measurements: input.measurements as unknown as Prisma.InputJsonValue,
            measurementNotes: input.notes ?? null,
            measuredAt: new Date(),
            measuredById: actor.userId,
            measurementKind: kind,
            version: { increment: 1 },
          },
        });
        await tx.serviceOrder.update({ where: { id }, data: { updatedAt: new Date() } });
        await recordChange(tx, request, so, revision, {
          scope: 'MEDICAO',
          itemId,
          changes: {
            measurements: { from: measurementsOf(before.measurements), to: input.measurements },
            kind,
          },
          summary: `Medidas de ${formatServiceOrderItemCode(so.number, before.position)} registradas (${
            kind === 'ROTINA' ? 'rotina' : 'extraordinária'
          }).`,
          action: 'service_order.measured',
        });
      });
      return loadServiceOrderDto(prisma, id);
    },
  );

  app.post(
    '/api/v1/service-orders/:id/materials',
    { config: { access: MANAGE } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = materialRequirementSchema.parse(request.body);
      await prisma.$transaction(async (tx) => {
        const revision = await lockForRevision(tx, id);
        const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
        if (so.status === 'CANCELADA') throw Errors.business('OS cancelada não pode ser alterada.');
        if (input.serviceOrderItemId) {
          const item = await tx.serviceOrderItem.findFirst({
            where: { id: input.serviceOrderItemId, serviceOrderId: id },
          });
          if (!item) throw Errors.validation(undefined, 'Item não pertence a esta OS.');
        }
        const m = await tx.materialRequirement.create({
          data: {
            serviceOrderId: id,
            serviceOrderItemId: input.serviceOrderItemId ?? null,
            kind: input.kind,
            description: input.description,
            quantity: input.quantity ?? null,
            unit: input.unit ?? null,
            sourcing: input.sourcing,
            notes: input.notes ?? null,
          },
        });
        await tx.serviceOrder.update({ where: { id }, data: { updatedAt: new Date() } });
        await recordChange(tx, request, so, revision, {
          scope: 'MATERIAL',
          itemId: input.serviceOrderItemId ?? null,
          changes: {
            added: { id: m.id, kind: m.kind, description: m.description, sourcing: m.sourcing },
          },
          summary: `Material "${m.description}" previsto na OS ${serviceOrderCode(so.number)}.`,
          action: 'service_order.material_added',
        });
      });
      return reply.status(201).send(await loadServiceOrderDto(prisma, id));
    },
  );

  app.delete(
    '/api/v1/service-orders/:id/materials/:materialId',
    { config: { access: MANAGE } },
    async (request) => {
      const { id, materialId } = materialParams.parse(request.params);
      await prisma.$transaction(async (tx) => {
        const revision = await lockForRevision(tx, id);
        const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
        if (so.status === 'CANCELADA') throw Errors.business('OS cancelada não pode ser alterada.');
        const m = await tx.materialRequirement.findFirst({
          where: { id: materialId, serviceOrderId: id },
        });
        if (!m) throw Errors.notFound('Material');
        if (m.origin === 'SOLICITACAO_APROVADA') {
          throw Errors.business(
            'Material aprovado em solicitação só muda pela revisão da medição (reabrir aprovação).',
          );
        }
        await tx.materialRequirement.delete({ where: { id: materialId } });
        await tx.serviceOrder.update({ where: { id }, data: { updatedAt: new Date() } });
        await recordChange(tx, request, so, revision, {
          scope: 'MATERIAL',
          itemId: m.serviceOrderItemId,
          changes: { removed: { kind: m.kind, description: m.description, sourcing: m.sourcing } },
          summary: `Material "${m.description}" removido da OS ${serviceOrderCode(so.number)}.`,
          action: 'service_order.material_removed',
        });
      });
      return loadServiceOrderDto(prisma, id);
    },
  );

  /** Cancela a OS: as peças voltam a ficar disponíveis para outra OS. */
  app.post('/api/v1/service-orders/:id/cancel', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = cancelServiceOrderSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const revision = await lockForRevision(tx, id);
      const before = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (before.status === 'CANCELADA') throw Errors.business('A OS já está cancelada.');
      await lockOrderItems(tx, before.orderId);
      const actor = actorFrom(request);
      const after = await tx.serviceOrder.update({
        where: { id },
        data: {
          status: 'CANCELADA',
          cancelledAt: new Date(),
          cancelledById: actor.userId,
          cancelReason: input.reason,
          version: { increment: 1 },
        },
      });
      await recordChange(tx, request, after, revision, {
        scope: 'CANCELAMENTO',
        changes: { status: { from: before.status, to: 'CANCELADA' } },
        reason: input.reason,
        summary: `OS ${serviceOrderCode(after.number)} cancelada.`,
        action: 'service_order.cancelled',
      });
      await emitOrderEvent(tx, request, before.orderId);
      await protectCancelledServiceOrder(tx, actor, id, input.reason);
    });
    return loadServiceOrderDto(prisma, id);
  });
}
