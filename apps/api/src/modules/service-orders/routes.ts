import {
  EVENT_TYPES,
  reworkCode,
  anyPermissionAudience,
  cancelServiceOrderSchema,
  createServiceOrderSchema,
  formatServiceOrderItemCode,
  measurementSchema,
  serviceOrderMaterialPurchasedSchema,
  serviceOrderQuerySchema,
  updateServiceOrderItemSchema,
  updateServiceOrderSchema,
  type MeasurementDto,
  type PageDto,
  type ServiceOrderDto,
  type ServiceOrderRevisionDto,
  type ServiceOrderSummaryDto,
  normalizeQuoteName,
  type QuoteSnapshot,
  type QuoteWorkOrder,
} from '@cenario/shared';
import { applyServicePriority, lockServicePlanning } from '../production/service-priority';
import { serviceDeadlineOf, serviceDeadlines } from '../deadlines/service';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { emitItemTechnicalChange } from '../../core/item-changes';
import { actorFrom, actorOf, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { appendEvent } from '../../core/events/append';
import { quoteWork } from './quote-work';
import { diffObjects } from '../../lib/diff';
import { Errors } from '../../lib/errors';
import { notify } from '../notifications/notify';
import { protectCancelledServiceOrder } from '../production/cancellation';
import { idParams, toEmployeeSummary } from '../presenters';
import {
  can,
  dateOnly,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  serviceOrderCode,
  toCustomerSummary,
} from '../commercial/common';
import { itemAllocations } from '../commercial/status';
import { emitOrderEvent } from '../orders/routes';
import { orderRevenue } from '../finance/revenue';
import { loadTeam, upholsterersOf } from '../production/distribution';
import { loadOperationalState, loadOperationalStates } from './operational';
import { createServiceOrder } from './service';
import { requireCompanyId } from '../../core/tenant';

const VIEW = { session: 'any', permissions: ['os.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['os.gerenciar'] } as const;
const AUDIENCE = anyPermissionAudience('os.ver', 'pedidos.ver');
const itemParams = z.object({ id: z.guid(), itemId: z.guid() });

const reworkSelect = { select: { id: true, number: true } } as const;

const fullInclude = {
  order: { select: { id: true, number: true, rework: reworkSelect } },
  customer: true,
  technicalLead: true,
  createdBy: { select: { displayName: true } },
  materialPurchasedBy: { select: { displayName: true } },
  items: {
    include: {
      measuredBy: { select: { displayName: true } },
      currentLocation: { select: { id: true, label: true } },
    },
    orderBy: { position: 'asc' as const },
  },
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
  // Materiais e medidas nunca impedem o início da produção; a prontidão só informa (a lista
  // simples da OS dá o aviso).
  const simpleMaterialsPending = await db.serviceOrderMaterial.count({
    where: { serviceOrderId: id, removedAt: null, available: false },
  });
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
    rework: so.order.rework
      ? { id: so.order.rework.id, code: reworkCode(so.order.rework.number) }
      : null,
    customer: toCustomerSummary(so.customer),
    priority: so.priority,
    promisedDate: dateOnly(so.promisedDate),
    deadline: await serviceDeadlineOf(db, id),
    technicalLead: so.technicalLead ? toEmployeeSummary(so.technicalLead) : null,
    itemCount: so.items.length,
    pieceCount: so.items.reduce((a, i) => a + i.quantity, 0),
    createdAt: so.createdAt.toISOString(),
    materialPurchasedAt: so.materialPurchasedAt?.toISOString() ?? null,
    materialPurchasedBy: so.materialPurchasedBy?.displayName ?? null,
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
      currentLocation: i.currentLocation,
      version: i.version,
    })),
    // Prontidão para produção: apenas informativa. O início é decidido tarefa a
    // tarefa pelo motor de liberação (Fase 5), nunca pela OS como um todo.
    readiness: {
      measurements: so.items.length > 0 && measuredCount === so.items.length ? 'OK' : 'INFORMATIVO',
      technicalLead: so.technicalLeadId ? 'OK' : 'PENDENTE',
      simpleMaterialsPending,
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

/**
 * Bloqueia a OS e devolve o próximo número de revisão do histórico técnico. FOR NO KEY UPDATE:
 * serializa as revisões sem barrar quem só referencia a OS (tarefa de embalagem, inspeção) —
 * evita o deadlock "alteração técnica × aprovação da qualidade" (Fase 8).
 */
async function lockForRevision(tx: Tx, id: string): Promise<number> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM service_orders WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
  if (!rows.length) throw Errors.notFound('Ordem de serviço');
  const last = await tx.serviceOrderRevision.aggregate({
    where: { serviceOrderId: id },
    _max: { revision: true },
  });
  return (last._max.revision ?? 0) + 1;
}

/**
 * Regra central de alteração do prazo prometido de UMA OS (usada pela opção "aplicar às OS
 * abertas" do pedido): trava a OS, grava revisão + auditoria + evento e avisa quem tem tarefa
 * aberta — o mesmo registro da edição da OS. NUNCA mexe em fila, prioridade, tarefas ou
 * planejamento (D9). Devolve o código da OS alterada, ou null quando nada mudou.
 */
export async function changeServiceOrderPromisedDate(
  tx: Tx,
  actor: ActorContext,
  id: string,
  to: string,
  reason: string,
  origin: string,
): Promise<string | null> {
  const revision = await lockForRevision(tx, id);
  const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
  const from = dateOnly(so.promisedDate);
  if (so.status !== 'ABERTA' || from === to) return null;
  await tx.serviceOrder.update({
    where: { id },
    data: { promisedDate: parseDateOnly(to), version: { increment: 1 } },
  });
  const br = (d: string | null) => (d ? d.split('-').reverse().join('/') : 'sem prazo');
  await recordChange(tx, actor, so, revision, {
    scope: 'OS',
    changes: { promisedDate: { from, to } },
    reason,
    summary: `OS ${serviceOrderCode(so.number)}: prazo prometido ${br(from)} → ${br(to)} (${origin}).`,
    action: 'service_order.updated',
  });
  return serviceOrderCode(so.number);
}

export async function recordChange(
  tx: Tx,
  request: FastifyRequest | ActorContext,
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
  const actor = actorOf(request);
  // Fase 10: alteração técnica da peça → a qualidade reavalia a aprovação (regra explícita).
  if ((entry.scope === 'ITEM' || entry.scope === 'MEDICAO') && entry.itemId) {
    await emitItemTechnicalChange(tx, actor, {
      itemId: entry.itemId,
      serviceOrderId: so.id,
      scope: entry.scope,
      summary: entry.summary,
    });
  }
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
    // Fase 10: o motivo também na auditoria (antes só ficava no histórico técnico da OS).
    changes: entry.reason ? { ...entry.changes, reason: entry.reason } : entry.changes,
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
  // Fase 6: mudança técnica avisa quem tem tarefa publicada e aberta nesta OS.
  if (entry.scope !== 'CRIACAO' && entry.scope !== 'CANCELAMENTO') {
    const open = await tx.productionTask.findMany({
      where: {
        serviceOrderId: so.id,
        assigneeUserId: { not: null },
        status: { in: ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'] },
      },
      select: { assigneeUserId: true },
    });
    await notify(
      tx,
      actor,
      [...new Set(open.map((t) => t.assigneeUserId!))].map((userId) => ({
        userId,
        kind: 'OS_ATUALIZADA' as const,
        dedupeKey: `OS_ATUALIZADA:${so.id}:${revision}`,
        body: entry.summary,
        serviceOrderId: so.id,
      })),
    );
  }
}

/** Dia da semana (0 = domingo) no fuso da empresa. */
function weekdayIn(timezone: string, date = new Date()): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(
    date,
  );
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

type AvailableCommercial = {
  contractedCents: number | null;
  adjustmentsCents: number | null;
  finalCents: number | null;
  manualSplit: boolean;
  serviceOrders: { code: string; revenueCents: number; pieces: number }[];
};

/**
 * Fluxo da OS (2026-11-18): o que o orçamento aprovado já diz sobre a execução — tecido,
 * detalhes da O.S. do orçamento, foto e o tapeceiro (ligado pelo nome ao titular).
 */
function quotePrefill(
  quote: { number: number; snapshot: Prisma.JsonValue; workOrder: Prisma.JsonValue },
  upholsterers: { userId: string; displayName: string }[],
) {
  const snap = (quote.snapshot ?? {}) as Partial<QuoteSnapshot>;
  const wo = (quote.workOrder ?? null) as Partial<QuoteWorkOrder> | null;
  const fabrics = (snap.fabrics ?? []).filter(Boolean);
  const details: string[] = [];
  // 2026-11-18 (Raphael): o serviço do tapeceiro escolhido no orçamento vai para a OS.
  const upholsteryService = snap.upholstery?.name?.trim() || null;
  if (snap.sofaCount && snap.sofaCount > 1) details.push(`Quantidade: ${snap.sofaCount}`);
  if (wo) {
    if (wo.keepOriginal) details.push(`Manter o original: ${wo.keepOriginal}`);
    if (wo.changeFoam) details.push(`Trocar espuma: ${wo.changeFoam}`);
    if (wo.changeFabric) details.push(`Trocar tecido: ${wo.changeFabric}`);
    if (wo.repairStructure) details.push(`Reparar estrutura: ${wo.repairStructure}`);
  } else {
    if (snap.foamChange !== undefined)
      details.push(`Trocar espuma: ${snap.foamChange ? 'Sim' : 'Não'}`);
    if (snap.fabricChange !== undefined)
      details.push(`Trocar tecido: ${snap.fabricChange ? 'Sim' : 'Não'}`);
  }
  if (wo?.fabricMeters) details.push(`Tecido: ${String(wo.fabricMeters).replace('.', ',')} m`);
  const materials = (wo?.items ?? snap.lines ?? [])
    .filter((l) => l && l.name && (('realQty' in l ? l.realQty : l.qty) ?? 0) > 0)
    .map(
      (l) =>
        `${l.name} (${String('realQty' in l ? l.realQty : l.qty).replace('.', ',')} ${l.unit})`,
    );
  const name = wo?.responsibleName ? normalizeQuoteName(wo.responsibleName) : '';
  const upholsterer = name
    ? (upholsterers.find((u) => normalizeQuoteName(u.displayName) === name) ?? null)
    : null;
  return {
    number: quote.number,
    service: snap.service ?? '',
    upholsteryService,
    fabricName: wo?.fabricName?.trim() || fabrics.join(', '),
    details,
    notes: wo?.notes?.trim() ?? '',
    materials,
    responsibleName: wo?.responsibleName ?? null,
    upholstererUserId: upholsterer?.userId ?? null,
    photoDataUrl: wo?.photoDataUrl ?? null,
  };
}

/** Responsável técnico da OS: o funcionário ativo com o mesmo nome do responsável do orçamento. */
async function quoteLead(db: Tx | PrismaClient, quote: { workOrder: Prisma.JsonValue }) {
  const wo = (quote.workOrder ?? null) as Partial<QuoteWorkOrder> | null;
  const name = wo?.responsibleName ? normalizeQuoteName(wo.responsibleName) : '';
  if (!name) return null;
  const employees = await db.employee.findMany({
    where: { active: true },
    select: { id: true, displayName: true },
  });
  return employees.find((e) => normalizeQuoteName(e.displayName) === name)?.id ?? null;
}

export async function serviceOrderRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/service-orders', { config: { access: VIEW } }, async (request) => {
    const q = serviceOrderQuerySchema.parse(request.query);
    // Fase 10: o código da peça (OS-00012/1) também acha a OS.
    const numberMatch = q.q?.trim().match(/^(?:os-?)?0*(\d{1,9})(?:\/\d{1,4})?$/i);
    const where: Prisma.ServiceOrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.orderId ? { orderId: q.orderId } : {}),
      ...(q.material === 'AGUARDANDO'
        ? { status: 'ABERTA', materialPurchasedAt: null }
        : q.material === 'COMPRADO'
          ? { materialPurchasedAt: { not: null } }
          : {}),
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
          order: { select: { id: true, number: true, rework: reworkSelect } },
          customer: true,
          technicalLead: true,
          items: { select: { quantity: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: q.limit,
        skip: q.offset,
      }),
    ]);
    const deadlines = await serviceDeadlines(prisma, { id: { in: rows.map((r) => r.id) } });
    const states = await loadOperationalStates(
      prisma,
      rows.map((r) => r.id),
    );
    return {
      total,
      items: rows.map(
        (so): ServiceOrderSummaryDto => ({
          id: so.id,
          number: so.number,
          code: serviceOrderCode(so.number),
          status: so.status,
          order: { id: so.order.id, code: orderCode(so.order.number) },
          rework: so.order.rework
            ? { id: so.order.rework.id, code: reworkCode(so.order.rework.number) }
            : null,
          customer: toCustomerSummary(so.customer),
          priority: so.priority,
          promisedDate: dateOnly(so.promisedDate),
          deadline: deadlines.get(so.id)!,
          technicalLead: so.technicalLead ? toEmployeeSummary(so.technicalLead) : null,
          itemCount: so.items.length,
          pieceCount: so.items.reduce((a, i) => a + i.quantity, 0),
          createdAt: so.createdAt.toISOString(),
          materialPurchasedAt: so.materialPurchasedAt?.toISOString() ?? null,
          version: so.version,
          operationalState: states.get(so.id)?.state,
        }),
      ),
    } satisfies PageDto<ServiceOrderSummaryDto>;
  });

  /** Peças recebidas ainda não incluídas em OS (base para criar a OS). */
  app.get('/api/v1/service-orders/available', { config: { access: MANAGE } }, async (request) => {
    const { orderId } = z.object({ orderId: z.guid() }).parse(request.query);
    const order = await prisma.commercialOrder.findUnique({
      where: { id: orderId },
      include: { customer: true, items: { orderBy: { position: 'asc' } } },
    });
    if (!order) throw Errors.notFound('Pedido');
    const alloc = await itemAllocations(prisma as unknown as Tx, orderId);
    const perms = request.auth!.permissions;
    // Valores comerciais: só com a permissão de ver valores do pedido (mesma regra do pedido).
    let commercial: AvailableCommercial | null = null;
    if (perms.has('pedidos.valores')) {
      const r = await orderRevenue(prisma, orderId);
      const pieces = new Map(
        r.order.serviceOrders.map((so) => [
          so.id,
          so.items
            .filter((i) => i.fulfillmentStage !== 'DEVOLVIDA')
            .reduce((a, i) => a + i.quantity, 0),
        ]),
      );
      commercial = {
        contractedCents: order.agreedValueCents,
        adjustmentsCents: perms.has('financeiro.ver') ? r.adjustmentsCents : null,
        finalCents: perms.has('financeiro.ver') ? r.finalCents : order.agreedValueCents,
        manualSplit: r.manual,
        serviceOrders: r.shares.map((s) => ({
          code: serviceOrderCode(s.number),
          revenueCents: s.revenueCents,
          pieces: pieces.get(s.id) ?? 0,
        })),
      };
    }
    const canPlan = perms.has('producao.planejar');
    const canLabor = perms.has('financeiro.ver') && perms.has('financeiro.gerenciar');
    const upholsterers = canPlan ? upholsterersOf(await loadTeam(prisma)) : [];
    // Fluxo da OS (2026-11-18): a tela de gerar OS vem preenchida com o orçamento aprovado.
    const quote = await prisma.quote.findFirst({
      where: { orderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return {
      order: {
        id: order.id,
        code: orderCode(order.number),
        status: order.status,
        contractedService: order.contractedService,
        promisedDate: dateOnly(order.promisedDate),
        technicalNotes: order.technicalNotes,
      },
      quote: quote
        ? {
            ...quotePrefill(quote, upholsterers),
            technicalLeadId: await quoteLead(prisma, quote),
            work: quoteWork(quote),
          }
        : null,
      commercial,
      permissions: { upholsterer: canPlan, labor: canLabor },
      upholsterers,
      customer: toCustomerSummary(order.customer),
      items: order.items.map((i) => ({
        orderItemId: i.id,
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
        receivedQuantity: i.receivedQuantity,
        inServiceOrders: alloc.inServiceOrders(i.id),
        available: i.quantity - i.returnedQuantity - alloc.inServiceOrders(i.id),
        serviceType: i.serviceType,
        fabricName: i.fabricName,
        fabricColor: i.fabricColor,
        fabricReference: i.fabricReference,
        technicalNotes: i.technicalNotes ?? i.notes,
        plannedUpholstererUserId: canPlan ? i.plannedUpholstererUserId : null,
        plannedLaborUnitCents: canLabor ? i.plannedLaborUnitCents : null,
      })),
    };
  });

  app.get('/api/v1/service-orders/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadServiceOrderDto(prisma, id);
  });

  /**
   * Reformulação, Fase 0: estado operacional derivado (somente leitura; nenhum contrato existente
   * muda). Só no painel: a base técnica dos estados que as próximas fases vão exibir.
   */
  app.get(
    '/api/v1/service-orders/:id/operational-state',
    { config: { access: { session: 'WEB', permissions: ['os.ver'] } } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const state = await loadOperationalState(prisma, id);
      if (!state) throw Errors.notFound('Ordem de serviço');
      return state;
    },
  );

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
   * Cria a OS técnica a partir do pedido (peças ainda não incluídas em outra OS ativa). A tela
   * oferece a criação depois que a peça chega na tapeçaria; a API não exige a chegada.
   */
  app.post(
    '/api/v1/service-orders',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createServiceOrderSchema.parse(request.body);
      const id = await prisma.$transaction(
        async (tx) =>
          (await createServiceOrder(tx, actorFrom(request), request.auth!.permissions, input)).id,
      );
      return reply.status(201).send(await loadServiceOrderDto(prisma, id));
    },
  );

  app.put('/api/v1/service-orders/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateServiceOrderSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      // Mesma ordem de travas do planejamento (a prioridade da OS vale também nele).
      await lockServicePlanning(tx, id);
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
          // Fase 10: campo ausente mantém o prazo (antes, omitir apagava o prazo da OS).
          promisedDate:
            input.promisedDate === undefined
              ? before.promisedDate
              : parseDateOnly(input.promisedDate),
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
      // Alterar o prazo prometido exige motivo (como no prazo do pedido).
      if ('promisedDate' in changes && !input.reason)
        throw Errors.validation(
          [{ path: 'reason', message: 'Informe o motivo da alteração do prazo.' }],
          'Informe o motivo da alteração do prazo.',
        );
      await recordChange(tx, request, after, revision, {
        scope: 'OS',
        changes,
        reason: input.reason,
        summary: `OS ${serviceOrderCode(after.number)} alterada.`,
        action: 'service_order.updated',
      });
      // Saneamento: a prioridade é do serviço — já planejada, vale também no planejamento
      // (itens e tarefas não iniciadas; D9 só reposiciona esta OS). Sem planejamento, só a OS.
      if (before.priority !== after.priority)
        await applyServicePriority(tx, actorFrom(request), id, after.priority, input.reason, {
          updateServiceOrder: false,
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
      const company = await prisma.companySettings.findUnique({
        where: { id: requireCompanyId() },
      });
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

  /** Cancela a OS: as peças voltam a ficar disponíveis para outra OS. */
  /**
   * Fluxo da OS (2026-11-18): botão rápido "Material comprado". Marcado, a OS entra na
   * programação da semana; desmarcar só vale enquanto ela ainda não foi programada.
   */
  app.post(
    '/api/v1/service-orders/:id/material-purchased',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = serviceOrderMaterialPurchasedSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockServicePlanning(tx, id);
        const revision = await lockForRevision(tx, id);
        const before = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        if (before.status === 'CANCELADA')
          throw Errors.business('OS cancelada não pode ser alterada.');
        if (Boolean(before.materialPurchasedAt) === input.purchased) return;
        if (
          !input.purchased &&
          (await tx.productionPlanItem.count({ where: { serviceOrderId: id } })) > 0
        )
          throw Errors.business(
            'Esta OS já está na programação da semana. Tire-a da programação antes de desmarcar o material.',
          );
        const after = await tx.serviceOrder.update({
          where: { id, version: input.version },
          data: input.purchased
            ? {
                materialPurchasedAt: new Date(),
                materialPurchasedById: actor.userId,
                version: { increment: 1 },
              }
            : { materialPurchasedAt: null, materialPurchasedById: null, version: { increment: 1 } },
        });
        await recordChange(tx, request, after, revision, {
          scope: 'OS',
          changes: { materialPurchased: { from: !input.purchased, to: input.purchased } },
          summary: input.purchased
            ? `OS ${serviceOrderCode(after.number)}: material comprado — liberada para a programação.`
            : `OS ${serviceOrderCode(after.number)}: material desmarcado — aguardando material.`,
          action: 'service_order.material_purchased',
        });
      });
      return loadServiceOrderDto(prisma, id);
    },
  );

  app.post('/api/v1/service-orders/:id/cancel', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = cancelServiceOrderSchema.parse(request.body);
    await prisma.$transaction((tx) =>
      cancelServiceOrder(tx, actorFrom(request), id, input.reason, input.version),
    );
    return loadServiceOrderDto(prisma, id);
  });
}

/**
 * Cancela uma OS na transação do chamador (rota da OS e cancelamento do pedido, já que a OS nasce
 * no fechamento do serviço): tarefas não concluídas são canceladas e as peças ficam livres.
 */
export async function cancelServiceOrder(
  tx: Tx,
  actor: ActorContext,
  id: string,
  reason: string,
  expectedVersion?: number,
) {
  const revision = await lockForRevision(tx, id);
  const before = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
  if (expectedVersion !== undefined && before.version !== expectedVersion)
    throw Errors.versionConflict(before.version);
  if (before.status === 'CANCELADA') throw Errors.business('A OS já está cancelada.');
  await lockOrderItems(tx, before.orderId);
  const after = await tx.serviceOrder.update({
    where: { id },
    data: {
      status: 'CANCELADA',
      cancelledAt: new Date(),
      cancelledById: actor.userId,
      cancelReason: reason,
      version: { increment: 1 },
    },
  });
  await recordChange(tx, actor, after, revision, {
    scope: 'CANCELAMENTO',
    changes: { status: { from: before.status, to: 'CANCELADA' } },
    reason,
    summary: `OS ${serviceOrderCode(after.number)} cancelada.`,
    action: 'service_order.cancelled',
  });
  await emitOrderEvent(tx, actor, before.orderId);
  await protectCancelledServiceOrder(tx, actor, id, reason);
}
