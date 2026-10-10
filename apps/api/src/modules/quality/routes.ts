import {
  EVENT_TYPES,
  PICKUP_STATUS_LABEL,
  approveInspectionSchema,
  assignInspectorSchema,
  assignLogisticsOccurrenceSchema,
  assignPackagingSchema,
  assignPickupLogisticsSchema,
  cancelWithReasonSchema,
  checkInspectionItemSchema,
  completePackagingSchema,
  confirmReturnSchema,
  createDeliverySchema,
  createReturnSchema,
  deliverItemsSchema,
  deliveryQuerySchema,
  deliveryVersionSchema,
  frustrateDeliverySchema,
  inspectionQuerySchema,
  installDeliverySchema,
  locationSchema,
  logisticsQuerySchema,
  moveItemSchema,
  openLogisticsOccurrenceSchema,
  parsePieceLabel,
  pickupExecutionSchema,
  qualitySettingsSchema,
  qualityTemplateSchema,
  receiptCorrectionSchema,
  rejectInspectionSchema,
  resolveLogisticsOccurrenceSchema,
  stageQuerySchema,
  startInspectionSchema,
  updateDeliverySchema,
  type LogisticsJobDto,
  type PieceStatusDto,
  type ServiceType,
} from '@cenario/shared';
import type { Prisma, PrismaClient } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import { Errors } from '../../lib/errors';
import { refreshAvailabilityOfUser } from '../attendance/common';
import { asSnapshot, dateOnly, lockOrder, pickupCode } from '../commercial/common';
import { refreshOrderStatus } from '../commercial/status';
import { emitOrderEvent } from '../orders/routes';
import { PICKUP_AUDIENCE } from '../pickups/routes';
import { notify } from '../notifications/notify';
import { idParams } from '../presenters';
import { workers } from '../production/plans';
import {
  DELIVERY_MANAGE,
  INSPECT,
  QUALITY_AUDIENCE,
  QUALITY_MANAGE,
  SHIPPING_VIEW,
  labelOf,
  mainInspector,
  moveItem,
  pieceInclude,
  pieceRef,
  readinessOfItem,
  usersWith,
} from './common';
import {
  approveInspection,
  assignInspector,
  checkItem,
  inspectionInclude,
  rejectInspection,
  startInspection,
  toInspectionDto,
  viewerOf,
} from './inspections';
import {
  assignOccurrence,
  cancelOccurrence,
  occurrenceInclude,
  resolveOccurrence,
  toOccurrenceDto,
} from './logistics';
import { assignPackaging, completePackaging, packagingInclude, toPackagingDto } from './packaging';
import {
  cancelReturn,
  confirmReturn,
  correctReceiptLine,
  createReturn,
  returnInclude,
  toReturnDto,
} from './returns';
import {
  arriveDelivery,
  cancelDelivery,
  completeDelivery,
  confirmDelivery,
  createDelivery,
  deliverItems,
  deliveryInclude,
  departDelivery,
  frustrateDelivery,
  installDelivery,
  openOccurrence,
  toDeliveryDto,
  toDeliveryJob,
  updateDelivery,
} from './shipping';
import { syncTripCost, upsertTripCost } from '../finance/trip-costs';

const PACKAGING_ACCESS = {
  session: 'any',
  anyPermissions: ['producao.executar', 'qualidade.gerenciar'],
} as const;
const LOCATION_READ = {
  session: 'any',
  anyPermissions: [
    'producao.executar',
    'qualidade.inspecionar',
    'qualidade.gerenciar',
    'entregas.ver',
    'entregas.gerenciar',
    'logistica.executar',
  ],
} as const;
const MOVE_ACCESS = {
  session: 'any',
  anyPermissions: ['producao.executar', 'qualidade.gerenciar', 'entregas.gerenciar'],
} as const;
const DELIVERY_VIEW = {
  session: 'WEB',
  anyPermissions: ['entregas.ver', 'entregas.gerenciar'],
} as const;
const DELIVERY_EXECUTE = {
  session: 'any',
  anyPermissions: ['entregas.gerenciar', 'logistica.executar'],
} as const;
const LOGISTICS_SELF = { session: 'any', permissions: ['logistica.executar'] } as const;
const RETURNS_MANAGE = { session: 'WEB', permissions: ['devolucoes.gerenciar'] } as const;
const RETURNS_VIEW = {
  session: 'WEB',
  anyPermissions: ['devolucoes.gerenciar', 'pedidos.ver'],
} as const;

const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const device = (r: FastifyRequest) => r.auth?.deviceId ?? null;
const isManager = (r: FastifyRequest, p: 'qualidade.gerenciar' | 'entregas.gerenciar') =>
  r.auth?.permissions.has(p) ?? false;

async function pieceStatus(
  db: PrismaClient,
  id: string,
  withHistory = false,
): Promise<PieceStatusDto> {
  const item = await db.serviceOrderItem.findUnique({ where: { id }, include: pieceInclude });
  if (!item) throw Errors.notFound('Peça');
  const r = await readinessOfItem(db, id);
  const di = r.deliveryItem;
  const history = withHistory
    ? [
        ...(
          await db.qualityEvent.findMany({
            where: { serviceOrderItemId: id },
            include: { actor: { select: { displayName: true } } },
          })
        ).map((e) => ({
          id: e.id,
          kind: e.kind,
          note: e.note,
          actor: e.actor?.displayName ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
        ...(
          await db.itemLocationEvent.findMany({
            where: { serviceOrderItemId: id },
            include: { actor: { select: { displayName: true } }, location: true },
          })
        ).map((e) => ({
          id: e.id,
          kind: 'LOCALIZACAO',
          note: `${e.location.label}${e.note ? ` — ${e.note}` : ''}`,
          actor: e.actor?.displayName ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : undefined;
  return {
    ...pieceRef(item),
    readiness: r.readiness,
    inspection: r.inspection
      ? {
          id: r.inspection.id,
          code: `IQ-${String(r.inspection.number).padStart(5, '0')}`,
          status: r.inspection.status,
          round: r.inspection.round,
        }
      : null,
    packaging: r.inspection?.packaging
      ? {
          id: r.inspection.packaging.id,
          code: `EB-${String(r.inspection.packaging.number).padStart(5, '0')}`,
          status: r.inspection.packaging.status,
        }
      : null,
    delivery: di
      ? {
          id: di.delivery.id,
          code: `EN-${String(di.delivery.number).padStart(5, '0')}`,
          status: di.delivery.status,
          scheduledDate: dateOnly(di.delivery.scheduledDate)!,
        }
      : null,
    labelPayload: labelOf(item),
    ...(history ? { history } : {}),
  };
}

export async function qualityRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const viewer = (r: FastifyRequest) => viewerOf(prisma, r.auth!.userId);

  // ─────────────────────────── Inspeções ───────────────────────────

  app.get('/api/v1/quality/inspections', { config: { access: INSPECT } }, async (request) => {
    const q = inspectionQuerySchema.parse(request.query);
    const v = await viewer(request);
    const mine = !v.isManager || q.scope === 'mine';
    const where: Prisma.QualityInspectionWhereInput = {
      ...(q.status
        ? { status: q.status }
        : q.scope === 'all'
          ? {}
          : { status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } }),
      ...(mine ? { inspectorUserId: v.userId } : {}),
      ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
      ...(q.serviceOrderItemId ? { serviceOrderItemId: q.serviceOrderItemId } : {}),
    };
    const rows = await prisma.qualityInspection.findMany({
      where,
      include: inspectionInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    const PRIORITY = { URGENTE: 0, ALTA: 1, NORMAL: 2, BAIXA: 3 } as const;
    rows.sort(
      (a, b) =>
        PRIORITY[a.priority] - PRIORITY[b.priority] ||
        (dateOnly(a.dueDate) ?? '9999').localeCompare(dateOnly(b.dueDate) ?? '9999') ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return Promise.all(rows.map((r) => toInspectionDto(prisma, r, v)));
  });

  app.get('/api/v1/quality/inspections/:id', { config: { access: INSPECT } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const v = await viewer(request);
    const r = await prisma.qualityInspection.findUnique({
      where: { id },
      include: inspectionInclude,
    });
    if (!r) throw Errors.notFound('Inspeção');
    if (!v.isManager && r.inspectorUserId !== v.userId) throw Errors.forbidden();
    return toInspectionDto(prisma, r, v);
  });

  async function inspectionAction(
    request: FastifyRequest,
    run: (
      tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
      v: Awaited<ReturnType<typeof viewer>>,
      id: string,
    ) => Promise<unknown>,
  ) {
    const { id } = idParams.parse(request.params);
    const v = await viewer(request);
    await prisma.$transaction((tx) => run(tx, v, id));
    const r = await prisma.qualityInspection.findUniqueOrThrow({
      where: { id },
      include: inspectionInclude,
    });
    return toInspectionDto(prisma, r, v);
  }

  app.post(
    '/api/v1/quality/inspections/:id/start',
    { config: { access: INSPECT, idempotent: true } },
    (request) =>
      inspectionAction(request, (tx, v, id) =>
        startInspection(
          tx,
          actorFrom(request),
          v,
          id,
          startInspectionSchema.parse(request.body).version,
          device(request),
        ),
      ),
  );

  app.put(
    '/api/v1/quality/inspections/:id/items/:itemId',
    { config: { access: INSPECT } },
    (request) => {
      const { itemId } = itemParams.parse(request.params);
      const input = checkInspectionItemSchema.parse(request.body);
      return inspectionAction(request, (tx, v, id) =>
        checkItem(tx, actorFrom(request), v, id, itemId, input, device(request)),
      );
    },
  );

  app.post(
    '/api/v1/quality/inspections/:id/approve',
    { config: { access: INSPECT, idempotent: true } },
    async (request) => {
      const input = approveInspectionSchema.parse(request.body);
      const dto = await inspectionAction(request, (tx, v, id) =>
        approveInspection(tx, actorFrom(request), v, id, input, device(request)),
      );
      await prisma.$transaction((tx) =>
        refreshAvailabilityOfUser(tx, actorFrom(request), request.auth!.userId),
      );
      return dto;
    },
  );

  app.post(
    '/api/v1/quality/inspections/:id/reject',
    { config: { access: INSPECT, idempotent: true } },
    (request) => {
      const input = rejectInspectionSchema.parse(request.body);
      return inspectionAction(request, (tx, v, id) =>
        rejectInspection(tx, actorFrom(request), v, id, input, device(request)),
      );
    },
  );

  app.post(
    '/api/v1/quality/inspections/:id/assign',
    { config: { access: QUALITY_MANAGE } },
    (request) => {
      const input = assignInspectorSchema.parse(request.body);
      return inspectionAction(request, (tx, _v, id) =>
        assignInspector(tx, actorFrom(request), id, input),
      );
    },
  );

  /** Quem pode inspecionar (para o gestor designar), com o inspetor principal marcado. */
  app.get('/api/v1/quality/inspectors', { config: { access: QUALITY_MANAGE } }, async () => {
    const main = await mainInspector(prisma);
    const ids = new Set([
      ...(await usersWith(prisma, 'qualidade.inspecionar')),
      ...(await usersWith(prisma, 'qualidade.gerenciar')),
    ]);
    const users = await prisma.user.findMany({
      where: { id: { in: [...ids] }, active: true },
      orderBy: { displayName: 'asc' },
    });
    return users.map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      isMain: u.id === main?.id,
    }));
  });

  app.get('/api/v1/quality/settings', { config: { access: QUALITY_MANAGE } }, async () => {
    const s = await prisma.companySettings.findUnique({ where: { id: 1 } });
    const main = await mainInspector(prisma);
    return {
      qualityInspectorUserId: s?.qualityInspectorUserId ?? null,
      effectiveInspector: main ? { userId: main.id, displayName: main.displayName } : null,
    };
  });

  app.put('/api/v1/quality/settings', { config: { access: QUALITY_MANAGE } }, async (request) => {
    const input = qualitySettingsSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      if (input.qualityInspectorUserId) {
        const perms = await loadUserPermissions(tx, input.qualityInspectorUserId);
        if (!perms.has('qualidade.inspecionar'))
          throw Errors.business('O inspetor principal precisa da permissão "Inspecionar peças".');
      }
      await tx.companySettings.update({
        where: { id: 1 },
        data: { qualityInspectorUserId: input.qualityInspectorUserId },
      });
      await audit(tx, actorFrom(request), {
        action: 'quality.settings_updated',
        entityType: 'company_settings',
        entityId: '1',
        summary: 'Inspetor principal da qualidade alterado.',
        changes: input,
      });
    });
    const main = await mainInspector(prisma);
    return {
      qualityInspectorUserId: input.qualityInspectorUserId,
      effectiveInspector: main ? { userId: main.id, displayName: main.displayName } : null,
    };
  });

  // ─────────────────────────── Checklists ───────────────────────────

  const templateDto = (t: Prisma.QualityTemplateGetPayload<{ include: { items: true } }>) => ({
    id: t.id,
    name: t.name,
    pieceTypes: t.pieceTypes,
    active: t.active,
    items: [...t.items]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        id: i.id,
        position: i.position,
        label: i.label,
        guidance: i.guidance,
        required: i.required,
        serviceTypes: i.serviceTypes as ServiceType[],
      })),
    version: t.version,
  });

  app.get('/api/v1/quality/templates', { config: { access: QUALITY_MANAGE } }, async () =>
    (
      await prisma.qualityTemplate.findMany({ include: { items: true }, orderBy: { name: 'asc' } })
    ).map(templateDto),
  );

  async function saveTemplate(request: FastifyRequest, id: string | null) {
    const input = qualityTemplateSchema.parse(request.body);
    const saved = await prisma.$transaction(async (tx) => {
      let templateId = id;
      if (id) {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM quality_templates WHERE id = ${id}::uuid FOR UPDATE`;
        if (!rows.length) throw Errors.notFound('Checklist');
        const cur = await tx.qualityTemplate.findUniqueOrThrow({ where: { id } });
        if (input.version !== undefined && cur.version !== input.version)
          throw Errors.versionConflict(cur.version);
        // Itens do modelo podem ser trocados: as inspeções guardam a própria cópia do checklist.
        await tx.qualityTemplateItem.deleteMany({ where: { templateId: id } });
        await tx.qualityTemplate.update({
          where: { id },
          data: {
            name: input.name,
            pieceTypes: input.pieceTypes,
            active: input.active,
            version: { increment: 1 },
          },
        });
      } else {
        templateId = (
          await tx.qualityTemplate.create({
            data: { name: input.name, pieceTypes: input.pieceTypes, active: input.active },
          })
        ).id;
      }
      await tx.qualityTemplateItem.createMany({
        data: input.items.map((i, idx) => ({
          templateId: templateId!,
          position: idx + 1,
          label: i.label,
          guidance: i.guidance ?? null,
          required: i.required,
          serviceTypes: i.serviceTypes,
        })),
      });
      const actor = actorFrom(request);
      await audit(tx, actor, {
        action: id ? 'quality.template_updated' : 'quality.template_created',
        entityType: 'quality_template',
        entityId: templateId!,
        summary: `Checklist "${input.name}" ${id ? 'alterado' : 'criado'} (${input.items.length} itens).`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.QUALITY_TEMPLATE_CHANGED,
        aggregateType: 'quality_template',
        aggregateId: templateId!,
        payload: { id: templateId },
        audience: QUALITY_AUDIENCE,
      });
      return tx.qualityTemplate.findUniqueOrThrow({
        where: { id: templateId! },
        include: { items: true },
      });
    });
    return templateDto(saved);
  }
  app.post('/api/v1/quality/templates', { config: { access: QUALITY_MANAGE } }, (r) =>
    saveTemplate(r, null),
  );
  app.put('/api/v1/quality/templates/:id', { config: { access: QUALITY_MANAGE } }, (r) =>
    saveTemplate(r, idParams.parse(r.params).id),
  );

  // ─────────────────────────── Embalagem ───────────────────────────

  app.get('/api/v1/packaging', { config: { access: PACKAGING_ACCESS } }, async (request) => {
    const q = z
      .object({ scope: z.enum(['open', 'all', 'mine']).default('open') })
      .parse(request.query);
    const manager = isManager(request, 'qualidade.gerenciar');
    const rows = await prisma.packagingRecord.findMany({
      where: {
        ...(q.scope === 'all' ? {} : { status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } }),
        ...(!manager || q.scope === 'mine' ? { assigneeUserId: request.auth!.userId } : {}),
      },
      include: packagingInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(rows.map((r) => toPackagingDto(prisma, r)));
  });

  app.get('/api/v1/packaging/:id', { config: { access: PACKAGING_ACCESS } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const r = await prisma.packagingRecord.findUnique({ where: { id }, include: packagingInclude });
    if (!r) throw Errors.notFound('Embalagem');
    if (!isManager(request, 'qualidade.gerenciar') && r.assigneeUserId !== request.auth!.userId)
      throw Errors.forbidden();
    return toPackagingDto(prisma, r);
  });

  app.post(
    '/api/v1/packaging/:id/assign',
    { config: { access: QUALITY_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = assignPackagingSchema.parse(request.body);
      await prisma.$transaction((tx) => assignPackaging(tx, actorFrom(request), id, input));
      return toPackagingDto(
        prisma,
        await prisma.packagingRecord.findUniqueOrThrow({
          where: { id },
          include: packagingInclude,
        }),
      );
    },
  );

  app.post(
    '/api/v1/packaging/:id/complete',
    { config: { access: PACKAGING_ACCESS, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = completePackagingSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction((tx) =>
        completePackaging(
          tx,
          actor,
          { userId: request.auth!.userId, isManager: isManager(request, 'qualidade.gerenciar') },
          id,
          input,
          device(request),
        ),
      );
      await prisma.$transaction((tx) => refreshAvailabilityOfUser(tx, actor, request.auth!.userId));
      return toPackagingDto(
        prisma,
        await prisma.packagingRecord.findUniqueOrThrow({
          where: { id },
          include: packagingInclude,
        }),
      );
    },
  );

  // ─────────────────────────── Localizações e peças ───────────────────────────

  app.get('/api/v1/locations', { config: { access: LOCATION_READ } }, async () => {
    const rows = await prisma.itemLocation.findMany({
      orderBy: [{ position: 'asc' }, { label: 'asc' }],
      include: { _count: { select: { items: true } } },
    });
    return rows.map((l) => ({
      id: l.id,
      key: l.key,
      label: l.label,
      position: l.position,
      active: l.active,
      pieces: l._count.items,
    }));
  });

  app.post('/api/v1/locations', { config: { access: QUALITY_MANAGE } }, async (request) => {
    const input = locationSchema.parse(request.body);
    const key = input.label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 30);
    const l = await prisma.$transaction(async (tx) => {
      if (await tx.itemLocation.findUnique({ where: { key } }))
        throw Errors.conflict('Já existe uma localização com esse nome.');
      const created = await tx.itemLocation.create({ data: { key, ...input } });
      await audit(tx, actorFrom(request), {
        action: 'location.created',
        entityType: 'item_location',
        entityId: created.id,
        summary: `Localização "${created.label}" criada.`,
      });
      return created;
    });
    return { ...l, pieces: 0, createdAt: undefined };
  });

  app.put('/api/v1/locations/:id', { config: { access: QUALITY_MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = locationSchema.parse(request.body);
    const l = await prisma.$transaction(async (tx) => {
      const cur = await tx.itemLocation.findUnique({ where: { id } });
      if (!cur) throw Errors.notFound('Localização');
      const u = await tx.itemLocation.update({ where: { id }, data: input });
      await audit(tx, actorFrom(request), {
        action: 'location.updated',
        entityType: 'item_location',
        entityId: id,
        summary: `Localização "${cur.label}" → "${u.label}"${u.active ? '' : ' (desativada)'}.`,
      });
      return u;
    });
    return { id: l.id, key: l.key, label: l.label, position: l.position, active: l.active };
  });

  app.get('/api/v1/pieces', { config: { access: SHIPPING_VIEW } }, async (request) => {
    const q = stageQuerySchema.parse(request.query);
    const rows = await prisma.serviceOrderItem.findMany({
      where: {
        ...(q.stage?.length ? { fulfillmentStage: { in: q.stage } } : {}),
        ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
        ...(q.q
          ? {
              OR: [
                { description: { contains: q.q, mode: 'insensitive' } },
                { serviceOrder: { customer: { name: { contains: q.q, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
      select: { id: true },
    });
    return Promise.all(rows.map((r) => pieceStatus(prisma, r.id)));
  });

  /** Leitura da etiqueta/QR da peça (texto CENARIO:PECA:OS-00001/1). */
  app.get('/api/v1/pieces/by-label', { config: { access: MOVE_ACCESS } }, async (request) => {
    const { code } = z.object({ code: z.string().max(80) }).parse(request.query);
    const itemCode = parsePieceLabel(code) ?? code.trim();
    const m = /^OS-(\d{5})\/(\d+)$/.exec(itemCode);
    if (!m) throw Errors.validation(undefined, 'Etiqueta inválida.');
    const item = await prisma.serviceOrderItem.findFirst({
      where: { position: Number(m[2]), serviceOrder: { number: Number(m[1]) } },
    });
    if (!item) throw Errors.notFound('Peça');
    return pieceStatus(prisma, item.id);
  });

  app.get('/api/v1/pieces/:id', { config: { access: SHIPPING_VIEW } }, async (request) =>
    pieceStatus(prisma, idParams.parse(request.params).id, true),
  );

  app.post('/api/v1/pieces/:id/move', { config: { access: MOVE_ACCESS } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = moveItemSchema.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM service_order_items WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows.length) throw Errors.notFound('Peça');
      await moveItem(
        tx,
        actorFrom(request),
        id,
        input.locationId,
        input.note ?? null,
        device(request),
      );
    });
    return pieceStatus(prisma, id);
  });

  // ─────────────────────────── Entregas (gestor) ───────────────────────────

  const deliveryDto = async (id: string) =>
    toDeliveryDto(
      prisma,
      await prisma.delivery.findUniqueOrThrow({ where: { id }, include: deliveryInclude }),
    );

  app.get('/api/v1/deliveries', { config: { access: DELIVERY_VIEW } }, async (request) => {
    const q = deliveryQuerySchema.parse(request.query);
    const rows = await prisma.delivery.findMany({
      where: {
        ...(q.from || q.to
          ? {
              scheduledDate: {
                ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
                ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}),
              },
            }
          : {}),
        ...(q.status?.length ? { status: { in: q.status } } : {}),
      },
      include: deliveryInclude,
      orderBy: [{ scheduledDate: 'asc' }, { windowStart: 'asc' }, { number: 'asc' }],
      take: 300,
    });
    return Promise.all(rows.map((r) => toDeliveryDto(prisma, r)));
  });

  app.get('/api/v1/deliveries/:id', { config: { access: DELIVERY_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    if (!(await prisma.delivery.count({ where: { id } }))) throw Errors.notFound('Entrega');
    return deliveryDto(id);
  });

  app.post(
    '/api/v1/deliveries',
    { config: { access: DELIVERY_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createDeliverySchema.parse(request.body);
      if (input.tripCost && !request.auth!.permissions.has('financeiro.gerenciar'))
        throw Errors.forbidden('Informar o custo da viagem exige permissão do financeiro.');
      const d = await prisma.$transaction(async (tx) => {
        const created = await createDelivery(tx, actorFrom(request), input);
        if (input.tripCost)
          await upsertTripCost(tx, actorFrom(request), {
            deliveryId: created.id,
            ...input.tripCost,
          });
        return created;
      });
      return reply.status(201).send(await deliveryDto(d.id));
    },
  );

  app.put('/api/v1/deliveries/:id', { config: { access: DELIVERY_MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateDeliverySchema.parse(request.body);
    await prisma.$transaction((tx) => updateDelivery(tx, actorFrom(request), id, input));
    return deliveryDto(id);
  });

  app.post(
    '/api/v1/deliveries/:id/confirm',
    { config: { access: DELIVERY_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { version } = deliveryVersionSchema.parse(request.body);
      await prisma.$transaction((tx) => confirmDelivery(tx, actorFrom(request), id, version));
      return deliveryDto(id);
    },
  );

  app.post(
    '/api/v1/deliveries/:id/cancel',
    { config: { access: DELIVERY_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelWithReasonSchema.parse(request.body);
      await prisma.$transaction((tx) => cancelDelivery(tx, actorFrom(request), id, input));
      return deliveryDto(id);
    },
  );

  // ─────────────────────────── Execução (logística ou gestor) ───────────────────────────

  async function execute(
    request: FastifyRequest,
    run: (
      tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
      id: string,
      v: { userId: string; isManager: boolean },
    ) => Promise<unknown>,
  ) {
    const { id } = idParams.parse(request.params);
    const v = { userId: request.auth!.userId, isManager: isManager(request, 'entregas.gerenciar') };
    await prisma.$transaction((tx) => run(tx, id, v));
    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id },
      include: deliveryInclude,
    });
    return v.isManager && request.auth!.kind === 'WEB'
      ? toDeliveryDto(prisma, row)
      : toDeliveryJob(row);
  }

  app.post(
    '/api/v1/deliveries/:id/depart',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    (r) =>
      execute(r, (tx, id, v) =>
        departDelivery(tx, actorFrom(r), v, id, deliveryVersionSchema.parse(r.body), device(r)),
      ),
  );
  app.post(
    '/api/v1/deliveries/:id/arrive',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    (r) =>
      execute(r, (tx, id, v) =>
        arriveDelivery(tx, actorFrom(r), v, id, deliveryVersionSchema.parse(r.body), device(r)),
      ),
  );
  app.post(
    '/api/v1/deliveries/:id/items',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    (r) =>
      execute(r, (tx, id, v) =>
        deliverItems(tx, actorFrom(r), v, id, deliverItemsSchema.parse(r.body), device(r)),
      ),
  );
  app.post(
    '/api/v1/deliveries/:id/install',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    (r) =>
      execute(r, (tx, id, v) =>
        installDelivery(tx, actorFrom(r), v, id, installDeliverySchema.parse(r.body), device(r)),
      ),
  );
  app.post(
    '/api/v1/deliveries/:id/complete',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    (r) =>
      execute(r, (tx, id, v) =>
        completeDelivery(tx, actorFrom(r), v, id, deliveryVersionSchema.parse(r.body), device(r)),
      ),
  );
  app.post(
    '/api/v1/deliveries/:id/frustrate',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    (r) =>
      execute(r, (tx, id, v) =>
        frustrateDelivery(
          tx,
          actorFrom(r),
          v,
          id,
          frustrateDeliverySchema.parse(r.body),
          device(r),
        ),
      ),
  );

  // ─────────────────────────── Logística terceirizada ───────────────────────────

  /** Pessoas que executam entregas: logística terceirizada e equipe própria. */
  app.get('/api/v1/logistics/people', { config: { access: DELIVERY_VIEW } }, async () => {
    const own = await workers(prisma);
    const ownIds = new Set(own.map((w) => w.userId));
    const third = await prisma.user.findMany({
      where: {
        id: { in: (await usersWith(prisma, 'logistica.executar')).filter((u) => !ownIds.has(u)) },
        active: true,
        employee: { active: true },
      },
      orderBy: { displayName: 'asc' },
    });
    return [
      ...third.map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        team: 'LOGISTICA_TERCEIRIZADA' as const,
      })),
      ...own.map((w) => ({
        userId: w.userId,
        displayName: w.displayName,
        team: 'EQUIPE_PROPRIA' as const,
      })),
    ];
  });

  /** "Minhas entregas e retiradas" — visão restrita (sem valores nem dados comerciais). */
  app.get('/api/v1/logistics/jobs', { config: { access: LOGISTICS_SELF } }, async (request) => {
    const me = request.auth!.userId;
    const since = new Date(Date.now() - 2 * 86_400_000);
    const deliveries = await prisma.delivery.findMany({
      where: {
        responsibleUserId: me,
        OR: [
          { status: { in: ['AGENDADA', 'EM_TRANSPORTE', 'NO_DESTINO'] } },
          { status: { in: ['CONCLUIDA', 'FRUSTRADA'] }, updatedAt: { gte: since } },
        ],
      },
      include: deliveryInclude,
      orderBy: [{ scheduledDate: 'asc' }, { windowStart: 'asc' }],
    });
    const pickups = await prisma.pickupRequest.findMany({
      where: {
        logisticsUserId: me,
        OR: [
          { status: { in: ['AGENDADA', 'EM_EXECUCAO', 'COM_OCORRENCIA'] } },
          { status: 'RETIRADA_REALIZADA', updatedAt: { gte: since } },
        ],
      },
      include: {
        order: { include: { customer: { select: { name: true, phone: true } } } },
        items: { include: { orderItem: { select: { description: true } } } },
      },
      orderBy: [{ scheduledDate: 'asc' }],
    });
    const jobs: LogisticsJobDto[] = [
      ...deliveries.map(toDeliveryJob),
      ...pickups.map((p) => {
        const a = asSnapshot(p.addressSnapshot);
        return {
          id: p.id,
          kind: 'RETIRADA' as const,
          code: pickupCode(p.number),
          status: p.status,
          customerName: p.order.customer.name,
          address: a
            ? {
                street: a.street,
                number: a.number,
                complement: a.complement,
                district: a.district,
                city: a.city,
                state: a.state,
                postalCode: a.postalCode,
                reference: a.reference,
              }
            : null,
          contactName: p.order.customer.name,
          contactPhone: p.order.customer.phone,
          scheduledDate: dateOnly(p.scheduledDate),
          windowStart: p.windowStart,
          windowEnd: p.windowEnd,
          requiresInstallation: false,
          instructions: p.instructions,
          pieces: p.items.map((i) => ({
            id: i.orderItemId,
            code: null,
            description: i.orderItem.description,
            quantity: i.quantity,
            status: null,
          })),
          departedAt: null,
          arrivedAt: null,
          installedAt: null,
          completedAt: null,
          version: p.version,
        };
      }),
    ];
    return jobs;
  });

  /** Gestor atribui a retirada a quem executa (logística terceirizada ou equipe própria). */
  app.put(
    '/api/v1/pickups/:id/logistics',
    {
      config: {
        access: { session: 'WEB', anyPermissions: ['retiradas.gerenciar', 'entregas.gerenciar'] },
      },
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = assignPickupLogisticsSchema.parse(request.body);
      await prisma.$transaction(async (tx) => {
        const p = await tx.pickupRequest.findUnique({ where: { id } });
        if (!p) throw Errors.notFound('Retirada');
        await lockOrder(tx, p.orderId);
        const cur = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
        if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
        let name = 'ninguém';
        if (input.logisticsUserId) {
          const perms = await loadUserPermissions(tx, input.logisticsUserId);
          const u = await tx.user.findUnique({ where: { id: input.logisticsUserId } });
          if (!u?.active || (!perms.has('logistica.executar') && !perms.has('producao.executar')))
            throw Errors.business('Responsável inválido para a retirada.');
          name = u.displayName;
        }
        const actor = actorFrom(request);
        const u = await tx.pickupRequest.update({
          where: { id },
          data: { logisticsUserId: input.logisticsUserId, version: { increment: 1 } },
        });
        await tx.pickupEvent.create({
          data: {
            pickupId: id,
            kind: 'RESPONSAVEL',
            note: `Responsável: ${name}`,
            recordedById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'pickup.logistics_assigned',
          entityType: 'pickup_request',
          entityId: id,
          summary: `Retirada ${pickupCode(p.number)} atribuída a ${name}.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PICKUP_UPDATED,
          aggregateType: 'pickup_request',
          aggregateId: id,
          payload: { id, code: pickupCode(p.number), status: u.status, version: u.version },
          audience: input.logisticsUserId
            ? (`${PICKUP_AUDIENCE}|user:${input.logisticsUserId}` as typeof PICKUP_AUDIENCE)
            : PICKUP_AUDIENCE,
        });
        if (input.logisticsUserId) {
          await notify(tx, actor, [
            {
              userId: input.logisticsUserId,
              kind: 'ENTREGA_ATRIBUIDA',
              dedupeKey: `RETIRADA_ATRIBUIDA:${id}:${u.version}`,
              body: `Retirada ${pickupCode(p.number)}${p.scheduledDate ? ` em ${dateOnly(p.scheduledDate)!.split('-').reverse().join('/')}` : ''}.`,
              includeActor: true,
            },
          ]);
        }
      });
      return { ok: true };
    },
  );

  /** Logística registra a saída para a retirada e a retirada realizada (não o recebimento). */
  app.post(
    '/api/v1/logistics/pickups/:id/step',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = pickupExecutionSchema.parse(request.body);
      await prisma.$transaction(async (tx) => {
        const p = await tx.pickupRequest.findUnique({ where: { id } });
        if (!p) throw Errors.notFound('Retirada');
        if (!isManager(request, 'entregas.gerenciar') && p.logisticsUserId !== request.auth!.userId)
          throw Errors.forbidden('Esta retirada está atribuída a outra pessoa.');
        await lockOrder(tx, p.orderId);
        const cur = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
        const to = input.step === 'SAIDA' ? 'EM_EXECUCAO' : 'RETIRADA_REALIZADA';
        if (cur.status === to) return;
        if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
        const from = input.step === 'SAIDA' ? 'AGENDADA' : 'EM_EXECUCAO';
        if (cur.status !== from)
          throw Errors.business(
            `Retirada ${PICKUP_STATUS_LABEL[cur.status].toLowerCase()}: não é possível registrar este passo.`,
          );
        const actor = actorFrom(request);
        const u = await tx.pickupRequest.update({
          where: { id },
          data: { status: to, version: { increment: 1 } },
        });
        await tx.pickupEvent.create({
          data: {
            pickupId: id,
            kind: to,
            fromStatus: cur.status,
            toStatus: to,
            note: input.note ?? null,
            recordedById: actor.userId,
          },
        });
        await refreshOrderStatus(tx, p.orderId);
        await audit(tx, actor, {
          action: 'pickup.status_changed',
          entityType: 'pickup_request',
          entityId: id,
          summary: `Retirada ${pickupCode(p.number)}: ${PICKUP_STATUS_LABEL[cur.status]} → ${PICKUP_STATUS_LABEL[to]} (logística).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PICKUP_STATUS_CHANGED,
          aggregateType: 'pickup_request',
          aggregateId: id,
          payload: {
            id,
            code: pickupCode(p.number),
            orderId: p.orderId,
            status: to,
            version: u.version,
          },
          audience: `${PICKUP_AUDIENCE}|user:${request.auth!.userId}` as typeof PICKUP_AUDIENCE,
        });
        await syncTripCost(tx, actor, { pickupId: id });
        await emitOrderEvent(tx, request, p.orderId);
      });
      return { ok: true };
    },
  );

  // ─────────────────────────── Ocorrências logísticas ───────────────────────────

  const occurrenceDto = async (id: string) =>
    toOccurrenceDto(
      prisma,
      await prisma.logisticsOccurrence.findUniqueOrThrow({
        where: { id },
        include: occurrenceInclude,
      }),
    );

  app.get(
    '/api/v1/logistics-occurrences',
    { config: { access: DELIVERY_VIEW } },
    async (request) => {
      const q = logisticsQuerySchema.parse(request.query);
      const rows = await prisma.logisticsOccurrence.findMany({
        where: { ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}) },
        include: occurrenceInclude,
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return Promise.all(rows.map((r) => toOccurrenceDto(prisma, r)));
    },
  );

  app.get(
    '/api/v1/logistics-occurrences/:id',
    { config: { access: DELIVERY_EXECUTE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const r = await prisma.logisticsOccurrence.findUnique({
        where: { id },
        include: {
          ...occurrenceInclude,
          delivery: { select: { id: true, number: true, responsibleUserId: true } },
        },
      });
      if (!r) throw Errors.notFound('Ocorrência logística');
      const me = request.auth!.userId;
      if (
        !request.auth!.permissions.has('entregas.ver') &&
        !isManager(request, 'entregas.gerenciar') &&
        r.reportedById !== me &&
        r.responsibleUserId !== me &&
        r.delivery?.responsibleUserId !== me
      )
        throw Errors.forbidden();
      return occurrenceDto(id);
    },
  );

  app.post(
    '/api/v1/logistics-occurrences',
    { config: { access: DELIVERY_EXECUTE, idempotent: true } },
    async (request, reply) => {
      const input = openLogisticsOccurrenceSchema.parse(request.body);
      const manager = isManager(request, 'entregas.gerenciar');
      const o = await prisma.$transaction(async (tx) => {
        const me = request.auth!.userId;
        if (input.deliveryId) {
          const d = await tx.delivery.findUnique({ where: { id: input.deliveryId } });
          if (!d) throw Errors.notFound('Entrega');
          if (!manager && d.responsibleUserId !== me)
            throw Errors.forbidden('Esta entrega está atribuída a outra pessoa.');
        }
        if (input.pickupId) {
          const p = await tx.pickupRequest.findUnique({ where: { id: input.pickupId } });
          if (!p) throw Errors.notFound('Retirada');
          if (!manager && p.logisticsUserId !== me)
            throw Errors.forbidden('Esta retirada está atribuída a outra pessoa.');
        }
        if (input.serviceOrderItemId && !input.deliveryId && !manager)
          throw Errors.forbidden('Ocorrência de peça na oficina: só o gestor registra.');
        if (
          input.serviceOrderItemId &&
          !(await tx.serviceOrderItem.count({ where: { id: input.serviceOrderItemId } }))
        )
          throw Errors.notFound('Peça');
        return openOccurrence(tx, actorFrom(request), input, device(request));
      });
      return reply.status(201).send(await occurrenceDto(o.id));
    },
  );

  app.post(
    '/api/v1/logistics-occurrences/:id/assign',
    { config: { access: DELIVERY_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = assignLogisticsOccurrenceSchema.parse(request.body);
      await prisma.$transaction((tx) => assignOccurrence(tx, actorFrom(request), id, input));
      return occurrenceDto(id);
    },
  );

  app.post(
    '/api/v1/logistics-occurrences/:id/resolve',
    { config: { access: DELIVERY_EXECUTE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = resolveLogisticsOccurrenceSchema.parse(request.body);
      await prisma.$transaction((tx) =>
        resolveOccurrence(
          tx,
          actorFrom(request),
          { userId: request.auth!.userId, isManager: isManager(request, 'entregas.gerenciar') },
          id,
          input,
        ),
      );
      return occurrenceDto(id);
    },
  );

  app.post(
    '/api/v1/logistics-occurrences/:id/cancel',
    { config: { access: DELIVERY_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelWithReasonSchema.parse(request.body);
      await prisma.$transaction((tx) => cancelOccurrence(tx, actorFrom(request), id, input));
      return occurrenceDto(id);
    },
  );

  // ─────────────────────────── Devoluções e correção de recebimento ───────────────────────────

  const returnDto = async (id: string) =>
    toReturnDto(
      prisma,
      await prisma.pieceReturn.findUniqueOrThrow({ where: { id }, include: returnInclude }),
    );

  app.get('/api/v1/returns', { config: { access: RETURNS_VIEW } }, async (request) => {
    const q = z.object({ orderId: z.string().uuid().optional() }).parse(request.query);
    const rows = await prisma.pieceReturn.findMany({
      where: q.orderId ? { orderId: q.orderId } : {},
      include: returnInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map((r) => toReturnDto(prisma, r)));
  });

  app.get('/api/v1/returns/:id', { config: { access: RETURNS_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    if (!(await prisma.pieceReturn.count({ where: { id } }))) throw Errors.notFound('Devolução');
    return returnDto(id);
  });

  app.post(
    '/api/v1/returns',
    { config: { access: RETURNS_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createReturnSchema.parse(request.body);
      const r = await prisma.$transaction((tx) => createReturn(tx, actorFrom(request), input));
      return reply.status(201).send(await returnDto(r.id));
    },
  );

  app.post(
    '/api/v1/returns/:id/confirm',
    { config: { access: RETURNS_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = confirmReturnSchema.parse(request.body);
      await prisma.$transaction(async (tx) => {
        const r = await confirmReturn(tx, actorFrom(request), id, input);
        await emitOrderEvent(tx, request, r.orderId);
      });
      return returnDto(id);
    },
  );

  app.post(
    '/api/v1/returns/:id/cancel',
    { config: { access: RETURNS_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelWithReasonSchema.parse(request.body);
      await prisma.$transaction((tx) => cancelReturn(tx, actorFrom(request), id, input));
      return returnDto(id);
    },
  );

  app.post(
    '/api/v1/receipt-lines/:id/corrections',
    { config: { access: RETURNS_MANAGE, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = receiptCorrectionSchema.parse(request.body);
      const out = await prisma.$transaction(async (tx) => {
        const r = await correctReceiptLine(tx, actorFrom(request), id, input);
        await emitOrderEvent(tx, request, r.orderId);
        return r.correction;
      });
      return reply.status(201).send({
        id: out.id,
        receiptLineId: out.receiptLineId,
        previousQuantity: out.previousQuantity,
        newQuantity: out.newQuantity,
        reason: out.reason,
        actor: request.auth!.displayName,
        createdAt: out.createdAt.toISOString(),
      });
    },
  );

  app.get(
    '/api/v1/receipts/:id/corrections',
    {
      config: {
        access: {
          session: 'WEB',
          anyPermissions: ['pedidos.ver', 'recebimentos.registrar', 'devolucoes.gerenciar'],
        },
      },
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const rows = await prisma.receiptCorrection.findMany({
        where: { receiptLine: { receiptId: id } },
        orderBy: { createdAt: 'asc' },
      });
      const actors = new Map(
        (
          await prisma.user.findMany({
            where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } },
            select: { id: true, displayName: true },
          })
        ).map((u) => [u.id, u.displayName]),
      );
      return rows.map((r) => ({
        id: r.id,
        receiptLineId: r.receiptLineId,
        previousQuantity: r.previousQuantity,
        newQuantity: r.newQuantity,
        reason: r.reason,
        actor: r.actorId ? (actors.get(r.actorId) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );
}
