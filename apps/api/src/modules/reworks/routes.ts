import {
  addBusinessDays,
  EVENT_TYPES,
  REWORK_CAUSE_LABEL,
  REWORK_CAUSES,
  reworkCancelSchema,
  reworkCode,
  reworkCreateSchema,
  reworkUpdateSchema,
  type ReworkCause,
  type ReworkCostDto,
  type ReworkDto,
  type ReworkStage,
  type ReworkStatsDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { assertModuleEnabled } from '../../core/modules';
import { Errors } from '../../lib/errors';
import { dateOnly, orderCode, pickupCode, serviceOrderCode } from '../commercial/common';
import { ACTIVE_PICKUP_STATUSES } from '../commercial/status';
import { deadlineCalendar } from '../deadlines/service';
import { syncTripCost } from '../finance/trip-costs';
import { resolvePickupAssignment } from '../notifications/notify';
import { createOrder } from '../orders/service';
import { idParams } from '../presenters';
import { schedulePickup } from '../services/routes';
import { emitPickupEvent } from '../pickups/routes';
import { announcePickupChange } from '../pickups/service';

/**
 * Retrabalhos (2026-11-18). Um serviço já feito que volta para ser refeito vira um PEDIDO próprio
 * (sem valor, sem cobrança) com retirada e OS normais: entra na agenda, na programação e na
 * expedição como qualquer serviço, marcado em vermelho. O gasto é o material e a mão de obra das
 * OS do retrabalho, a logística da retirada/entrega e um custo extra informado à mão.
 */
const VIEW = { session: 'WEB', anyPermissions: ['os.ver', 'os.gerenciar'] } as const;
const MANAGE = {
  session: 'WEB',
  permissions: ['os.gerenciar', 'pedidos.gerenciar', 'retiradas.gerenciar'],
} as const;

type Db = Tx | PrismaClient;

const reworkInclude = {
  order: {
    include: {
      items: { orderBy: { position: 'asc' } },
      pickups: {
        where: { status: { not: 'CANCELADA' } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      serviceOrders: {
        orderBy: { number: 'asc' },
        include: { items: { select: { fulfillmentStage: true } } },
      },
    },
  },
  originalOrder: {
    select: {
      id: true,
      number: true,
      contractedService: true,
      customer: { select: { id: true, name: true, phone: true, whatsapp: true } },
    },
  },
} as const satisfies Prisma.ReworkInclude;
type ReworkRow = Prisma.ReworkGetPayload<{ include: typeof reworkInclude }>;

const DONE_STAGES = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];

function stageOf(r: ReworkRow): ReworkStage {
  if (r.cancelledAt || r.order.status === 'CANCELADO') return 'CANCELADO';
  const sos = r.order.serviceOrders.filter((s) => s.status !== 'CANCELADA');
  if (sos.length) {
    const items = sos.flatMap((s) => s.items);
    const received = r.order.items.reduce((a, i) => a + i.receivedQuantity, 0);
    const total = r.order.items.reduce((a, i) => a + i.quantity, 0);
    if (items.length && items.every((i) => DONE_STAGES.includes(i.fulfillmentStage)))
      return received >= total ? 'CONCLUIDO' : 'EM_PRODUCAO';
    return 'EM_PRODUCAO';
  }
  if (r.order.status === 'RECEBIDO' || r.order.status === 'RECEBIDO_PARCIAL') return 'NA_OFICINA';
  return r.order.pickups.length ? 'AGUARDANDO_RETIRADA' : 'AGUARDANDO_PECAS';
}

/** Gasto do retrabalho: material e mão de obra das OS, logística das viagens e o custo extra. */
export async function reworkCosts(
  db: Db,
  rows: { id: string; orderId: string; extraCostCents: number }[],
): Promise<Map<string, ReworkCostDto>> {
  const out = new Map<string, ReworkCostDto>();
  if (!rows.length) return out;
  const orderIds = rows.map((r) => r.orderId);
  const sos = await db.serviceOrder.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true },
  });
  const soOrder = new Map(sos.map((s) => [s.id, s.orderId]));
  const [costs, labor, pickups, deliveries] = await Promise.all([
    db.serviceOrderCost.groupBy({
      by: ['serviceOrderId'],
      where: { serviceOrderId: { in: [...soOrder.keys()] } },
      _sum: { amountCents: true },
    }),
    db.productionPayable.findMany({
      where: { serviceOrderId: { in: [...soOrder.keys()] }, status: { not: 'CANCELADO' } },
      select: { serviceOrderId: true, agreedCents: true, adjustmentsCents: true },
    }),
    db.logisticsCost.findMany({
      where: { pickup: { orderId: { in: orderIds } }, status: { not: 'CANCELADO' } },
      select: { amountCents: true, adjustmentsCents: true, pickup: { select: { orderId: true } } },
    }),
    db.logisticsCostAllocation.findMany({
      where: {
        serviceOrderId: { in: [...soOrder.keys()] },
        cost: { status: { not: 'CANCELADO' }, pickupId: null },
      },
      select: { serviceOrderId: true, amountCents: true },
    }),
  ]);
  for (const r of rows) {
    const mine = (soId: string | null | undefined) => soId && soOrder.get(soId) === r.orderId;
    const materialsCents = costs
      .filter((c) => mine(c.serviceOrderId))
      .reduce((a, c) => a + (c._sum.amountCents ?? 0), 0);
    const laborCents = labor
      .filter((l) => mine(l.serviceOrderId))
      .reduce((a, l) => a + l.agreedCents + l.adjustmentsCents, 0);
    const logisticsCents =
      pickups
        .filter((p) => p.pickup?.orderId === r.orderId)
        .reduce((a, p) => a + p.amountCents + p.adjustmentsCents, 0) +
      deliveries.filter((d) => mine(d.serviceOrderId)).reduce((a, d) => a + d.amountCents, 0);
    const extraCents = r.extraCostCents;
    out.set(r.id, {
      materialsCents,
      laborCents,
      logisticsCents,
      extraCents,
      totalCents: materialsCents + laborCents + logisticsCents + extraCents,
    });
  }
  return out;
}

async function toDtos(db: Db, rows: ReworkRow[], withCost: boolean): Promise<ReworkDto[]> {
  const costs = withCost ? await reworkCosts(db, rows) : new Map<string, ReworkCostDto>();
  const { today } = await deadlineCalendar(db);
  return rows.map((r) => {
    const stage = stageOf(r);
    const promised = dateOnly(r.order.promisedDate);
    const pickup = r.order.pickups[0] ?? null;
    const sos = r.order.serviceOrders.filter((s) => s.status !== 'CANCELADA');
    const received = r.order.items.reduce((a, i) => a + i.receivedQuantity, 0);
    const inOs = sos.length; // OS do retrabalho já gerada (uma por chegada, normalmente)
    return {
      id: r.id,
      number: r.number,
      code: reworkCode(r.number),
      stage,
      cause: r.cause as ReworkCause,
      reason: r.reason,
      customer: {
        id: r.originalOrder.customer.id,
        name: r.originalOrder.customer.name,
        phone: r.originalOrder.customer.whatsapp ?? r.originalOrder.customer.phone ?? null,
      },
      originalOrder: {
        id: r.originalOrder.id,
        code: orderCode(r.originalOrder.number),
        service: r.originalOrder.contractedService,
      },
      order: { id: r.order.id, code: orderCode(r.order.number) },
      items: r.order.items.map((i) => ({
        orderItemId: i.id,
        description: i.description,
        quantity: i.quantity,
      })),
      promisedDate: promised,
      late: Boolean(promised && promised < today && stage !== 'CONCLUIDO' && stage !== 'CANCELADO'),
      pickup: pickup && {
        id: pickup.id,
        code: pickupCode(pickup.number),
        scheduledDate: dateOnly(pickup.scheduledDate),
        windowStart: pickup.windowStart,
        status: pickup.status,
      },
      serviceOrders: sos.map((s) => ({
        id: s.id,
        code: serviceOrderCode(s.number),
        status: s.status,
      })),
      canGenerateOs: stage !== 'CANCELADO' && received > 0 && inOs === 0,
      cost: withCost ? (costs.get(r.id) ?? null) : null,
      extraCostNote: r.extraCostNote,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt.toISOString(),
      version: r.version,
    };
  });
}

/** Retrabalhos de um período (abertos nele), com a estatística e o gasto. */
export async function reworkStats(
  db: Db,
  q: { from: string; to: string },
  withCost: boolean,
): Promise<ReworkStatsDto> {
  const fromTs = new Date(`${q.from}T03:00:00.000Z`);
  const toTs = new Date(`${q.to}T03:00:00.000Z`);
  toTs.setUTCDate(toTs.getUTCDate() + 1);
  const rows = await db.rework.findMany({
    where: { cancelledAt: null, createdAt: { gte: fromTs, lt: toTs } },
    select: { id: true, orderId: true, extraCostCents: true, cause: true },
  });
  const delivered = await db.commercialOrder.count({
    where: {
      rework: null,
      serviceOrders: {
        some: {
          items: {
            some: {
              deliveryItems: {
                some: { status: 'ENTREGUE', deliveredAt: { gte: fromTs, lt: toTs } },
              },
            },
          },
        },
      },
    },
  });
  const byCause = REWORK_CAUSES.map((cause) => ({
    cause,
    count: rows.filter((r) => r.cause === cause).length,
  })).filter((c) => c.count > 0);
  // Últimos 6 meses (contando o do fim do período).
  const end = q.to.slice(0, 7);
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${end}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  const since = new Date(`${months[0]}-01T03:00:00.000Z`);
  const recent = await db.rework.findMany({
    where: { cancelledAt: null, createdAt: { gte: since } },
    select: { createdAt: true },
  });
  const monthOf = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 7);
  const costs = withCost ? await reworkCosts(db, rows) : null;
  const sum = (k: keyof ReworkCostDto) =>
    costs ? [...costs.values()].reduce((a, c) => a + c[k], 0) : 0;
  return {
    from: q.from,
    to: q.to,
    count: rows.length,
    deliveredOrders: delivered,
    rateBps: delivered ? Math.round((rows.length / delivered) * 10_000) : null,
    byCause,
    byMonth: months.map((m) => ({
      month: m,
      count: recent.filter((r) => monthOf(r.createdAt) === m).length,
    })),
    cost: costs
      ? {
          materialsCents: sum('materialsCents'),
          laborCents: sum('laborCents'),
          logisticsCents: sum('logisticsCents'),
          extraCents: sum('extraCents'),
          totalCents: sum('totalCents'),
        }
      : null,
  };
}

const listQuery = z.object({
  situacao: z.enum(['abertos', 'concluidos', 'cancelados', 'todos']).default('abertos'),
  q: z.string().trim().max(80).optional(),
});
const periodQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const ordersQuery = z.object({ q: z.string().trim().max(80).default('') });

export async function reworkRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const load = (db: Db, id: string) =>
    db.rework.findUnique({ where: { id }, include: reworkInclude });
  const one = async (db: Db, id: string, withCost: boolean) => {
    const r = await load(db, id);
    if (!r) throw Errors.notFound('Retrabalho');
    return (await toDtos(db, [r], withCost))[0]!;
  };

  app.get('/api/v1/reworks', { config: { access: VIEW } }, async (request) => {
    const q = listQuery.parse(request.query);
    const rows = await prisma.rework.findMany({
      where: {
        ...(q.situacao === 'cancelados' ? { cancelledAt: { not: null } } : {}),
        ...(q.situacao === 'abertos' || q.situacao === 'concluidos' ? { cancelledAt: null } : {}),
        ...(q.q
          ? {
              OR: [
                { originalOrder: { customer: { name: { contains: q.q, mode: 'insensitive' } } } },
                { reason: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: reworkInclude,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const dtos = await toDtos(prisma, rows, request.auth!.permissions.has('financeiro.ver'));
    return dtos.filter((d) =>
      q.situacao === 'abertos'
        ? d.stage !== 'CONCLUIDO' && d.stage !== 'CANCELADO'
        : q.situacao === 'concluidos'
          ? d.stage === 'CONCLUIDO'
          : true,
    );
  });

  app.get('/api/v1/reworks/stats', { config: { access: VIEW } }, async (request) =>
    reworkStats(
      prisma,
      periodQuery.parse(request.query),
      request.auth!.permissions.has('financeiro.ver'),
    ),
  );

  /** Serviços que podem voltar: pedidos com peças entregues (busca por cliente ou número). */
  app.get('/api/v1/reworks/candidates', { config: { access: MANAGE } }, async (request) => {
    const { q } = ordersQuery.parse(request.query);
    const num = q.match(/^(?:pc-?)?0*(\d{1,9})$/i);
    const rows = await prisma.commercialOrder.findMany({
      where: {
        status: { not: 'CANCELADO' },
        rework: null,
        ...(q
          ? {
              OR: [
                ...(num ? [{ number: Number(num[1]) }] : []),
                { customer: { name: { contains: q, mode: 'insensitive' } } },
                { contractedService: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        customer: { select: { name: true } },
        items: { orderBy: { position: 'asc' } },
        serviceOrders: {
          select: {
            items: {
              select: {
                orderItemId: true,
                quantity: true,
                fulfillmentStage: true,
                deliveryItems: {
                  where: { status: 'ENTREGUE' },
                  select: { deliveredAt: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map((o) => {
      const soItems = o.serviceOrders.flatMap((s) => s.items);
      const deliveredAt = soItems
        .flatMap((i) => i.deliveryItems.map((d) => d.deliveredAt))
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        id: o.id,
        code: orderCode(o.number),
        customer: o.customer.name,
        service: o.contractedService,
        createdAt: o.createdAt.toISOString(),
        deliveredAt: deliveredAt?.toISOString() ?? null,
        items: o.items.map((i) => ({
          id: i.id,
          description: i.description,
          quantity: i.quantity,
          delivered: soItems
            .filter((s) => s.orderItemId === i.id && s.fulfillmentStage === 'ENTREGUE')
            .reduce((a, s) => a + s.quantity, 0),
        })),
      };
    });
  });

  app.get('/api/v1/reworks/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return one(prisma, id, request.auth!.permissions.has('financeiro.ver'));
  });

  app.post(
    '/api/v1/reworks',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = reworkCreateSchema.parse(request.body);
      const perms = request.auth!.permissions;
      if (input.pickup) await assertModuleEnabled(prisma, 'logistica');
      if (input.extraCostCents && !perms.has('financeiro.gerenciar'))
        throw Errors.forbidden('Informar o custo extra exige permissão do financeiro.');
      const actor = actorFrom(request);
      const id = await prisma.$transaction(
        async (tx) => {
          const orig = await tx.commercialOrder.findUnique({
            where: { id: input.originalOrderId },
            include: { items: true, customer: true, rework: { select: { id: true } } },
          });
          if (!orig || orig.status === 'CANCELADO')
            throw Errors.business('Serviço original não encontrado ou cancelado.');
          if (orig.rework)
            throw Errors.business(
              'Este pedido já é um retrabalho: abra o novo retrabalho a partir do serviço original.',
            );
          const seen = new Set<string>();
          const items = input.items.map((it) => {
            const src = orig.items.find((i) => i.id === it.orderItemId);
            if (!src || seen.has(it.orderItemId))
              throw Errors.validation(
                [{ path: 'items', message: 'Peça inválida.' }],
                'Peça inválida.',
              );
            seen.add(it.orderItemId);
            if (it.quantity > src.quantity)
              throw Errors.business(
                `"${src.description}": no máximo ${src.quantity} (a quantidade do serviço original).`,
              );
            return { src, quantity: it.quantity };
          });
          const cal = await deadlineCalendar(tx);
          const promisedDate = addBusinessDays(
            input.pickup?.scheduledDate ?? cal.today,
            input.deliveryBusinessDays,
            cal.workingDays,
          );
          // Endereço da retirada: o do serviço original (ou o principal do cliente).
          let addressId = orig.pickupAddressId;
          if (input.pickup && !addressId) {
            const primary = await tx.customerAddress.findFirst({
              where: { customerId: orig.customerId, archivedAt: null },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            });
            if (!primary)
              throw Errors.business(
                'O cliente não tem endereço cadastrado: cadastre o endereço ou marque que ele traz as peças.',
              );
            addressId = primary.id;
          }
          const reasonShort = input.reason.replace(/\s+/g, ' ').slice(0, 250);
          const order = await createOrder(tx, actor, perms, {
            customerId: orig.customerId,
            pickupAddressId: addressId,
            contractedService: `Retrabalho de ${orderCode(orig.number)}: ${reasonShort}`.slice(
              0,
              300,
            ),
            description: input.reason,
            agreedValueCents: null,
            paymentTerms: null,
            notes: `Retrabalho (${REWORK_CAUSE_LABEL[input.cause]}) do pedido ${orderCode(orig.number)}. Sem cobrança.`,
            promisedDate,
            technicalNotes: `RETRABALHO — ${input.reason}`.slice(0, 4000),
            autoServiceOrder: true,
            customerDropOff: !input.pickup,
            items: items.map(({ src, quantity }) => ({
              pieceType: src.pieceType,
              description: src.description,
              quantity,
              notes: src.notes,
              serviceType: src.serviceType,
              fabricName: src.fabricName,
              fabricColor: src.fabricColor,
              fabricReference: src.fabricReference,
              technicalNotes: `Retrabalho: ${reasonShort}`.slice(0, 2000),
            })),
          });
          await tx.commercialOrder.update({
            where: { id: order.id },
            data: { deliveryBusinessDays: input.deliveryBusinessDays },
          });
          const rw = await tx.rework.create({
            data: {
              orderId: order.id,
              originalOrderId: orig.id,
              reason: input.reason,
              cause: input.cause,
              extraCostCents: input.extraCostCents ?? 0,
              extraCostNote: input.extraCostNote || null,
              createdById: actor.userId,
            },
          });
          let pickupText = 'o cliente traz as peças';
          if (input.pickup) {
            const orderItems = await tx.commercialOrderItem.findMany({
              where: { orderId: order.id },
              orderBy: { position: 'asc' },
            });
            const { pickup } = await schedulePickup(tx, actor, perms, {
              orderId: order.id,
              addressId,
              pickup: input.pickup,
              items: orderItems.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
            });
            pickupText = `retirada ${pickupCode(pickup.number)}`;
          }
          await audit(tx, actor, {
            action: 'rework.created',
            entityType: 'rework',
            entityId: rw.id,
            summary: `${reworkCode(rw.number)}: retrabalho do pedido ${orderCode(orig.number)} (${orig.customer.name}) — pedido ${orderCode(order.number)}, ${pickupText}.`,
            changes: { originalOrderId: orig.id, orderId: order.id, cause: input.cause },
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.ORDER_UPDATED,
            aggregateType: 'commercial_order',
            aggregateId: order.id,
            payload: { id: order.id, code: orderCode(order.number), rework: true },
            audience: 'permission:pedidos.ver',
          });
          return rw.id;
        },
        { timeout: 30_000 },
      );
      return reply.status(201).send(await one(prisma, id, perms.has('financeiro.ver')));
    },
  );

  app.put('/api/v1/reworks/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = reworkUpdateSchema.parse(request.body);
    const perms = request.auth!.permissions;
    if (input.extraCostCents !== undefined && !perms.has('financeiro.gerenciar'))
      throw Errors.forbidden('Alterar o custo extra exige permissão do financeiro.');
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const r = await tx.rework.findUnique({ where: { id } });
      if (!r) throw Errors.notFound('Retrabalho');
      if (r.version !== input.version) throw Errors.versionConflict(r.version);
      if (r.cancelledAt) throw Errors.business('Retrabalho cancelado.');
      await tx.rework.update({
        where: { id },
        data: {
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.cause !== undefined ? { cause: input.cause } : {}),
          ...(input.extraCostCents !== undefined
            ? { extraCostCents: input.extraCostCents ?? 0 }
            : {}),
          ...(input.extraCostNote !== undefined
            ? { extraCostNote: input.extraCostNote || null }
            : {}),
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'rework.updated',
        entityType: 'rework',
        entityId: id,
        summary: `${reworkCode(r.number)}: dados do retrabalho alterados.`,
        changes: {
          ...(input.extraCostCents !== undefined
            ? { extraCostCents: { from: r.extraCostCents, to: input.extraCostCents ?? 0 } }
            : {}),
          ...(input.cause !== undefined ? { cause: { from: r.cause, to: input.cause } } : {}),
        },
      });
    });
    return one(prisma, id, perms.has('financeiro.ver'));
  });

  /** Cancelar o retrabalho: só a marca e o motivo; pedido, retirada e OS seguem seus fluxos. */
  app.post('/api/v1/reworks/:id/cancel', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = reworkCancelSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const r = await tx.rework.findUnique({ where: { id }, include: reworkInclude });
      if (!r) throw Errors.notFound('Retrabalho');
      if (r.version !== input.version) throw Errors.versionConflict(r.version);
      if (r.cancelledAt) throw Errors.business('Retrabalho já cancelado.');
      if (r.order.serviceOrders.some((s) => s.status !== 'CANCELADA'))
        throw Errors.business(
          'Este retrabalho já tem OS: cancele a OS antes (ou conclua o retrabalho normalmente).',
        );
      if (r.order.items.some((i) => i.receivedQuantity > 0))
        throw Errors.business(
          'As peças deste retrabalho já estão na oficina: gere a OS e conclua o retrabalho.',
        );
      // O pedido do retrabalho e a retirada ainda ativa saem junto (nada fica na agenda).
      if (r.order.status !== 'CANCELADO') {
        await tx.commercialOrder.update({
          where: { id: r.orderId },
          data: {
            status: 'CANCELADO',
            cancelledAt: new Date(),
            cancelledById: actor.userId,
            cancelReason: `Retrabalho cancelado: ${input.reason}`.slice(0, 500),
            version: { increment: 1 },
          },
        });
        const pickups = await tx.pickupRequest.findMany({
          where: { orderId: r.orderId, status: { in: [...ACTIVE_PICKUP_STATUSES] } },
        });
        for (const p of pickups) {
          await tx.pickupRequest.update({
            where: { id: p.id },
            data: { status: 'CANCELADA', version: { increment: 1 } },
          });
          await tx.pickupEvent.create({
            data: {
              pickupId: p.id,
              kind: 'CANCELADA',
              fromStatus: p.status,
              toStatus: 'CANCELADA',
              note: `Retrabalho cancelado: ${input.reason}`.slice(0, 500),
              source: 'SISTEMA',
              recordedById: actor.userId,
            },
          });
          await syncTripCost(
            tx,
            actor,
            { pickupId: p.id },
            `retrabalho cancelado: ${input.reason}`,
          );
          await resolvePickupAssignment(tx, actor, p.id);
          await emitPickupEvent(tx, actor, p.id, EVENT_TYPES.PICKUP_STATUS_CHANGED);
          await announcePickupChange(tx, actor, p.id, 'CANCELADA', input.reason);
        }
      }
      await tx.rework.update({
        where: { id },
        data: {
          cancelledAt: new Date(),
          cancelReason: input.reason,
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'rework.cancelled',
        entityType: 'rework',
        entityId: id,
        summary: `${reworkCode(r.number)}: cancelado — ${input.reason}`,
      });
    });
    return one(prisma, id, request.auth!.permissions.has('financeiro.ver'));
  });
}
