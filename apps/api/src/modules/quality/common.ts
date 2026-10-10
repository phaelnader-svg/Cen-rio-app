import {
  EVENT_TYPES,
  FULFILLMENT_STAGE_LABEL,
  LOGISTICS_OPEN,
  SUBSTITUTE_REASONS,
  anyPermissionAudience,
  computeStage,
  deliveryReadiness,
  formatServiceOrderItemCode,
  inspectionCode,
  pieceLabelPayload,
  taskCode,
  type FulfillmentStage,
  type InspectionStatus,
  type NotificationKind,
  type PackagingStatus,
  type Permission,
  type PieceRefDto,
  type SubstituteReason,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { attendanceConfig, clock, dbDate } from '../attendance/common';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { skillsByEmployee } from '../help/engine';
import { notify } from '../notifications/notify';
import { refreshLaborOf } from '../finance/labor';

// ─────────────────────────── Acesso ───────────────────────────

/** Inspetor (tablet ou painel) ou gestor da qualidade. */
export const INSPECT = {
  session: 'any',
  anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
} as const;
export const QUALITY_MANAGE = { session: 'WEB', permissions: ['qualidade.gerenciar'] } as const;
/** Consulta de expedição (peças, localização, prontas para entrega). */
export const SHIPPING_VIEW = {
  session: 'WEB',
  anyPermissions: ['qualidade.gerenciar', 'entregas.ver', 'entregas.gerenciar'],
} as const;
export const DELIVERY_MANAGE = { session: 'WEB', permissions: ['entregas.gerenciar'] } as const;

export const QUALITY_AUDIENCE = anyPermissionAudience(
  'qualidade.gerenciar',
  'entregas.ver',
  'entregas.gerenciar',
);
export const qualityAudience = (...users: (string | null | undefined)[]) =>
  [QUALITY_AUDIENCE, ...[...new Set(users.filter(Boolean))].map((u) => `user:${u}`)].join(
    '|',
  ) as typeof QUALITY_AUDIENCE;

export async function usersWith(db: Tx | PrismaClient, permission: Permission) {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true } });
  const out: string[] = [];
  for (const u of users) {
    if ((await loadUserPermissions(db, u.id)).has(permission)) out.push(u.id);
  }
  return out;
}

export async function notifyUsersWith(
  tx: Tx,
  actor: ActorContext,
  permission: Permission,
  kind: NotificationKind,
  dedupeKey: string,
  body: string,
  serviceOrderId: string | null = null,
  taskId: string | null = null,
) {
  await notify(
    tx,
    actor,
    (await usersWith(tx, permission)).map((userId) => ({
      userId,
      kind,
      dedupeKey: `${dedupeKey}:${userId}`,
      body,
      serviceOrderId,
      taskId,
      includeActor: true,
    })),
  );
}

// ─────────────────────────── Peças ───────────────────────────

export const pieceInclude = {
  serviceOrder: {
    select: {
      id: true,
      number: true,
      status: true,
      promisedDate: true,
      priority: true,
      orderId: true,
      customer: { select: { id: true, name: true } },
    },
  },
  currentLocation: { select: { id: true, label: true } },
} as const;
export type PieceRow = Prisma.ServiceOrderItemGetPayload<{ include: typeof pieceInclude }>;

export const pieceCode = (p: { position: number; serviceOrder: { number: number } }) =>
  formatServiceOrderItemCode(p.serviceOrder.number, p.position);

export function pieceRef(p: PieceRow): PieceRefDto {
  return {
    id: p.id,
    code: pieceCode(p),
    description: p.description,
    pieceType: p.pieceType,
    serviceType: p.serviceType,
    quantity: p.quantity,
    serviceOrder: {
      id: p.serviceOrder.id,
      code: serviceOrderCode(p.serviceOrder.number),
      number: p.serviceOrder.number,
      promisedDate: dateOnly(p.serviceOrder.promisedDate),
    },
    customer: p.serviceOrder.customer.name,
    customerId: p.serviceOrder.customer.id,
    orderId: p.serviceOrder.orderId,
    orderItemId: p.orderItemId,
    stage: p.fulfillmentStage as FulfillmentStage,
    location: p.currentLocation,
  };
}

export const labelOf = (p: PieceRow) => pieceLabelPayload(pieceCode(p));

export async function lockItem(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM service_order_items WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Peça');
  return tx.serviceOrderItem.findUniqueOrThrow({ where: { id }, include: pieceInclude });
}

export async function qualityEvent(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  entry: {
    kind: string;
    inspectionId?: string | null;
    note?: string | null;
    data?: unknown;
    deviceId?: string | null;
  },
) {
  await tx.qualityEvent.create({
    data: {
      serviceOrderItemId: itemId,
      inspectionId: entry.inspectionId ?? null,
      kind: entry.kind,
      note: entry.note?.slice(0, 1000) ?? null,
      data: (entry.data as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
      deviceId: entry.deviceId ?? null,
      createdAt: clock(),
    },
  });
}

// ─────────────────────────── Tarefas obrigatórias ───────────────────────────

/**
 * Tarefas obrigatórias de produção da peça: as da própria peça e as da OS inteira (sem peça),
 * exceto apoio, resolução de ocorrência, correção e embalagem; canceladas e rascunhos não contam.
 */
export function requiredTaskWhere(item: { id: string; serviceOrderId: string }) {
  return {
    serviceOrderId: item.serviceOrderId,
    OR: [{ serviceOrderItemId: item.id }, { serviceOrderItemId: null }],
    supportForTaskId: null,
    issueId: null,
    inspectionId: null,
    activity: { notIn: ['CORRECAO', 'EMBALAGEM'] },
    status: { notIn: ['CANCELADA', 'RASCUNHO'] },
  } satisfies Prisma.ProductionTaskWhereInput;
}

/** Quem executou o serviço: responsáveis e quem concluiu as tarefas obrigatórias, apoios e correções. */
export async function executorsOf(
  db: Tx | PrismaClient,
  item: { id: string; serviceOrderId: string },
) {
  const required = await db.productionTask.findMany({
    where: requiredTaskWhere(item),
    select: { id: true, assigneeUserId: true, completedById: true },
  });
  const others = await db.productionTask.findMany({
    where: {
      status: { not: 'CANCELADA' },
      OR: [
        { supportForTaskId: { in: required.map((t) => t.id) } },
        { activity: 'CORRECAO', inspection: { serviceOrderItemId: item.id } },
      ],
    },
    select: { assigneeUserId: true, completedById: true },
  });
  return new Set(
    [...required, ...others]
      .flatMap((t) => [t.assigneeUserId, t.completedById])
      .filter((u): u is string => Boolean(u)),
  );
}

// ─────────────────────────── Inspetor ───────────────────────────

const ABSENT = [
  'AUSENCIA_PRESUMIDA',
  'AUSENCIA_CONFIRMADA',
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
];

/**
 * Inspetor principal: o definido nas configurações; sem definição, quem tem a competência de
 * inspeção e a permissão de inspecionar (Thiago, no cadastro inicial).
 */
export async function mainInspector(db: Tx | PrismaClient) {
  const settings = await db.companySettings.findUnique({ where: { id: 1 } });
  const candidates = settings?.qualityInspectorUserId
    ? [settings.qualityInspectorUserId]
    : await (async () => {
        const skills = await skillsByEmployee(db);
        const employees = await db.employee.findMany({
          where: { active: true, user: { active: true } },
          orderBy: { displayName: 'asc' },
        });
        return employees.filter((e) => skills.get(e.id)?.has('INSPECAO')).map((e) => e.userId);
      })();
  for (const userId of candidates) {
    const user = await db.user.findUnique({ where: { id: userId }, include: { employee: true } });
    if (!user?.active || user.employee?.active === false) continue;
    if ((await loadUserPermissions(db, userId)).has('qualidade.inspecionar')) return user;
  }
  return null;
}

export async function isAbsentToday(db: Tx | PrismaClient, userId: string) {
  const employee = await db.employee.findUnique({ where: { userId } });
  if (!employee) return false;
  const cfg = await attendanceConfig(db);
  const day = await db.operationalAttendance.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: dbDate(cfg.today) } },
  });
  return Boolean(day && !day.arrivedAt && ABSENT.includes(day.situation));
}

/**
 * Escolha do inspetor de uma nova inspeção. Sem inspetor (ausente, executou o serviço ou não
 * definido), a inspeção fica aguardando o gestor designar um substituto ou aprovar diretamente.
 */
export async function chooseInspector(
  tx: Tx,
  item: { id: string; serviceOrderId: string },
): Promise<{ inspectorUserId: string | null; substitute: SubstituteReason | null }> {
  const main = await mainInspector(tx);
  if (!main) return { inspectorUserId: null, substitute: 'SEM_INSPETOR' };
  if ((await executorsOf(tx, item)).has(main.id))
    return { inspectorUserId: null, substitute: 'EXECUTOR' };
  if (await isAbsentToday(tx, main.id)) return { inspectorUserId: null, substitute: 'AUSENTE' };
  return { inspectorUserId: main.id, substitute: null };
}
export const substituteText = (r: SubstituteReason | null) => (r ? SUBSTITUTE_REASONS[r] : null);

// ─────────────────────────── Etapa ───────────────────────────

const OPEN_TASK: Prisma.EnumTaskStatusFilter<'ProductionTask'> = {
  notIn: ['CONCLUIDA', 'CANCELADA'],
};

/** Situação completa da peça no fluxo (base da etapa e do "pronto para entrega"). */
export async function stageInputs(db: Tx | PrismaClient, itemId: string) {
  const item = await db.serviceOrderItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { serviceOrder: { select: { status: true, number: true } } },
  });
  const required = await db.productionTask.groupBy({
    by: ['status'],
    where: requiredTaskWhere(item),
    _count: true,
  });
  const requiredTasks = required.reduce((a, r) => a + r._count, 0);
  const requiredTasksDone = required
    .filter((r) => r.status === 'CONCLUIDA')
    .reduce((a, r) => a + r._count, 0);
  const inspection = await db.qualityInspection.findFirst({
    where: { serviceOrderItemId: itemId, status: { not: 'CANCELADA' } },
    orderBy: { round: 'desc' },
    include: { packaging: true },
  });
  const openCorrections = await db.productionTask.count({
    where: { activity: 'CORRECAO', inspection: { serviceOrderItemId: itemId }, status: OPEN_TASK },
  });
  const shippingBlock =
    (await db.logisticsOccurrence.count({
      where: {
        blocksShipping: true,
        status: { in: [...LOGISTICS_OPEN] },
        OR: [
          { serviceOrderItemId: itemId },
          {
            serviceOrderItemId: null,
            delivery: { items: { some: { serviceOrderItemId: itemId, active: true } } },
          },
        ],
      },
    })) > 0;
  const deliveryItem = await db.deliveryItem.findFirst({
    where: { serviceOrderItemId: itemId, active: true },
    include: { delivery: true },
  });
  const delivered = await db.deliveryItem.count({
    where: { serviceOrderItemId: itemId, status: { in: ['ENTREGUE', 'DIVERGENTE'] } },
  });
  return {
    item,
    inspection,
    deliveryItem,
    input: {
      requiredTasks,
      requiredTasksDone,
      inspection: (inspection?.status ?? null) as InspectionStatus | null,
      openCorrections,
      packaging: (inspection?.status === 'APROVADA'
        ? (inspection.packaging?.status ?? null)
        : null) as PackagingStatus | null,
      shippingBlock,
      cancelled: item.serviceOrder.status === 'CANCELADA',
      returned: item.fulfillmentStage === 'DEVOLVIDA',
      delivered: delivered > 0,
      inTransit: Boolean(
        deliveryItem &&
          deliveryItem.status === 'PENDENTE' &&
          ['EM_TRANSPORTE', 'NO_DESTINO'].includes(deliveryItem.delivery.status),
      ),
      scheduled: deliveryItem?.delivery.status === 'AGENDADA',
    },
  };
}

export async function readinessOfItem(db: Tx | PrismaClient, itemId: string) {
  const s = await stageInputs(db, itemId);
  return { ...s, readiness: deliveryReadiness(s.input), stage: computeStage(s.input) };
}

/**
 * Recalcula a etapa da peça (determinística, a partir do banco). Ao chegar em "Pronta para
 * entrega", avisa o gestor uma única vez por embalagem — nunca agenda nada sozinho.
 */
export async function refreshItemStage(tx: Tx, actor: ActorContext, itemId: string) {
  const s = await readinessOfItem(tx, itemId);
  const before = s.item.fulfillmentStage as FulfillmentStage;
  if (s.stage === before) return s.stage;
  const updated = await tx.serviceOrderItem.update({
    where: { id: itemId },
    data: { fulfillmentStage: s.stage },
    include: pieceInclude,
  });
  await qualityEvent(tx, actor, itemId, {
    kind: 'ETAPA',
    note: `${FULFILLMENT_STAGE_LABEL[before]} → ${FULFILLMENT_STAGE_LABEL[s.stage]}`,
    data: { from: before, to: s.stage },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.ITEM_STAGE_CHANGED,
    aggregateType: 'service_order_item',
    aggregateId: itemId,
    payload: {
      id: itemId,
      code: pieceCode(updated),
      serviceOrderId: updated.serviceOrderId,
      from: before,
      stage: s.stage,
    },
    audience: QUALITY_AUDIENCE,
  });
  // Evolução Fase 5: a liberação da mão de obra acompanha o evento (aprovação, entrega…),
  // na mesma transação — não depende de alguém abrir a tela do financeiro.
  await refreshLaborOf(tx, actor, { serviceOrderId: updated.serviceOrderId });
  if (s.stage === 'PRONTA_ENTREGA' && s.inspection?.packaging) {
    const siblings = await tx.serviceOrderItem.findMany({
      where: { serviceOrderId: updated.serviceOrderId },
      select: { fulfillmentStage: true },
    });
    const ready = siblings.filter((x) =>
      ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA'].includes(x.fulfillmentStage),
    ).length;
    await notifyUsersWith(
      tx,
      actor,
      'entregas.gerenciar',
      'PRONTO_ENTREGA',
      `PRONTO_ENTREGA:${itemId}:${s.inspection.packaging.id}`,
      `${pieceCode(updated)} · ${updated.description} (${updated.serviceOrder.customer.name}) está pronta para entrega — ${ready} de ${siblings.length} peça(s) da OS. Agende quando quiser.`,
      updated.serviceOrderId,
    );
  }
  return s.stage;
}

export async function refreshStagesOfOrder(tx: Tx, actor: ActorContext, serviceOrderId: string) {
  const items = await tx.serviceOrderItem.findMany({
    where: { serviceOrderId },
    select: { id: true },
  });
  for (const i of items) await refreshItemStage(tx, actor, i.id);
}

// ─────────────────────────── Localização ───────────────────────────

export async function locationByKey(db: Tx | PrismaClient, key: string) {
  return db.itemLocation.findUnique({ where: { key } });
}

/** Registra a movimentação (sem exigir cada pequeno deslocamento: só quando informada). */
export async function moveItem(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  locationId: string,
  note: string | null = null,
  deviceId: string | null = null,
) {
  const location = await tx.itemLocation.findUnique({ where: { id: locationId } });
  if (!location || !location.active) throw Errors.business('Localização inválida ou desativada.');
  const item = await tx.serviceOrderItem.findUniqueOrThrow({
    where: { id: itemId },
    include: pieceInclude,
  });
  if (item.currentLocationId === locationId) return location;
  await tx.serviceOrderItem.update({
    where: { id: itemId },
    data: { currentLocationId: locationId },
  });
  await tx.itemLocationEvent.create({
    data: {
      serviceOrderItemId: itemId,
      locationId,
      note,
      actorId: actor.userId,
      deviceId,
      createdAt: clock(),
    },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.ITEM_LOCATION_CHANGED,
    aggregateType: 'service_order_item',
    aggregateId: itemId,
    payload: { id: itemId, code: pieceCode(item), locationId, label: location.label },
    audience: QUALITY_AUDIENCE,
  });
  return location;
}

export async function moveItemToKey(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  key: string,
  note: string | null = null,
  deviceId: string | null = null,
) {
  const location = await locationByKey(tx, key);
  if (location?.active) await moveItem(tx, actor, itemId, location.id, note, deviceId);
}

export const inspectionLabel = (i: { number: number }) => inspectionCode(i.number);
export const taskLabel = (t: { number: number; title: string }) =>
  `${taskCode(t.number)} · ${t.title}`;
