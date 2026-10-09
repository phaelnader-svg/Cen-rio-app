import {
  EVENT_TYPES,
  anyPermissionAudience,
  receiptCorrectionProblem,
  returnCode,
  type PieceReturnDto,
  type ReturnStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import {
  dateOnly,
  lockOrder,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  serviceOrderCode,
} from '../commercial/common';
import { settleLaborOfWithdrawal } from '../finance/withdrawal';
import { releaseReservationsOfItems } from '../purchasing/withdrawal';
import { itemAllocations, refreshOrderStatus } from '../commercial/status';
import { notify, taskNotice } from '../notifications/notify';
import { onServiceOrderCancelled, protectCancelledServiceOrder } from '../production/cancellation';
import { domainTaskEvent, lockTasks, taskEvent } from '../production/common';
import { pieceCode, pieceInclude, qualityEvent, refreshItemStage } from './common';
import { cancelDelivery, deliveryEvent, lockDelivery } from './shipping';

export const RETURN_AUDIENCE = anyPermissionAudience(
  'devolucoes.gerenciar',
  'pedidos.ver',
  'entregas.ver',
);

export const returnInclude = {
  order: { select: { id: true, number: true, customer: { select: { name: true } } } },
  responsible: { select: { id: true, displayName: true } },
  lines: { include: { orderItem: { select: { description: true, position: true } } } },
} as const satisfies Prisma.PieceReturnInclude;
type ReturnRow = Prisma.PieceReturnGetPayload<{ include: typeof returnInclude }>;

export async function toReturnDto(db: Tx | PrismaClient, r: ReturnRow): Promise<PieceReturnDto> {
  const soItems = await db.serviceOrderItem.findMany({
    where: { id: { in: r.lines.flatMap((l) => l.serviceOrderItemIds) } },
    include: pieceInclude,
  });
  const confirmedBy = r.confirmedById
    ? await db.user.findUnique({ where: { id: r.confirmedById }, select: { displayName: true } })
    : null;
  return {
    id: r.id,
    number: r.number,
    code: returnCode(r.number),
    status: r.status as ReturnStatus,
    order: { id: r.order.id, code: orderCode(r.order.number), customer: r.order.customer.name },
    reason: r.reason,
    responsible: r.responsible
      ? { userId: r.responsible.id, displayName: r.responsible.displayName }
      : null,
    returnDate: dateOnly(r.returnDate)!,
    destination: r.destination,
    lines: [...r.lines]
      .sort((a, b) => a.orderItem.position - b.orderItem.position)
      .map((l) => ({
        orderItemId: l.orderItemId,
        description: l.orderItem.description,
        quantity: l.quantity,
        serviceOrderItems: soItems
          .filter((s) => l.serviceOrderItemIds.includes(s.id))
          .map((s) => ({ id: s.id, code: pieceCode(s) })),
      })),
    review: await reviewOf(db, r, soItems),
    history: (
      await db.auditLog.findMany({
        where: { entityType: 'piece_return', entityId: r.id },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { displayName: true } } },
      })
    ).map((h) => ({
      id: h.id,
      action: h.action,
      summary: h.summary,
      actor: h.actor?.displayName ?? null,
      createdAt: h.createdAt.toISOString(),
    })),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    confirmedBy: confirmedBy?.displayName ?? null,
    confirmationNote: r.confirmationNote,
    cancelReason: r.cancelReason,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Fase 12: pendências de revisão do gestor depois de uma devolução confirmada. */
async function reviewOf(
  db: Tx | PrismaClient,
  r: ReturnRow,
  soItems: { id: string; serviceOrderId: string }[],
): Promise<PieceReturnDto['review']> {
  if (r.status !== 'CONFIRMADA' || !soItems.length) return { reservations: [], laborToReview: 0 };
  const soIds = [...new Set(soItems.map((i) => i.serviceOrderId))];
  const reservations = await db.stockReservation.findMany({
    where: {
      serviceOrderId: { in: soIds },
      status: 'ATIVA',
      serviceOrder: { status: 'ABERTA' },
      OR: [{ materialRequirementId: null }, { requirement: { serviceOrderItemId: null } }],
    },
    include: {
      stockItem: { select: { description: true } },
      serviceOrder: { select: { number: true } },
    },
  });
  const laborToReview = await db.productionPayable.count({
    where: {
      serviceOrderItemId: { in: soItems.map((i) => i.id) },
      status: { in: ['PREVISTO', 'LIBERADO', 'PAGO_PARCIAL'] },
    },
  });
  return {
    reservations: reservations.map((x) => ({
      id: x.id,
      serviceOrder: serviceOrderCode(x.serviceOrder.number),
      material: x.stockItem.description,
      quantity: Number(x.quantity),
    })),
    laborToReview,
  };
}

async function lockReturn(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM piece_returns WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Devolução');
  return tx.pieceReturn.findUniqueOrThrow({ where: { id }, include: returnInclude });
}

async function returnEvent(
  tx: Tx,
  actor: ActorContext,
  r: { id: string; number: number; status: string; orderId: string },
) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.PIECE_RETURN_UPDATED,
    aggregateType: 'piece_return',
    aggregateId: r.id,
    payload: { id: r.id, code: returnCode(r.number), status: r.status, orderId: r.orderId },
    audience: RETURN_AUDIENCE,
  });
}

type Line = { orderItemId: string; quantity: number; serviceOrderItemIds: string[] };

/**
 * Valida as linhas: peças de OS devolvidas inteiras (do item do pedido, ainda na oficina, sem
 * entrega em andamento e fora de outra devolução pendente) e o restante sai das peças recebidas
 * que não estão em OS.
 */
async function validateLines(tx: Tx, orderId: string, lines: Line[], currentId?: string) {
  const orderItems = await tx.commercialOrderItem.findMany({ where: { orderId } });
  const alloc = await itemAllocations(tx, orderId);
  const pending = await tx.pieceReturnLine.findMany({
    where: {
      pieceReturn: {
        orderId,
        status: 'REGISTRADA',
        ...(currentId ? { id: { not: currentId } } : {}),
      },
    },
  });
  const seen = new Set<string>();
  for (const line of lines) {
    const oi = orderItems.find((o) => o.id === line.orderItemId);
    if (!oi) throw Errors.business('Peça não pertence a este pedido.');
    if (seen.has(oi.id)) throw Errors.business('Peça repetida na devolução.');
    seen.add(oi.id);
    const soItems = await tx.serviceOrderItem.findMany({
      where: { id: { in: line.serviceOrderItemIds } },
      include: {
        ...pieceInclude,
        deliveryItems: { where: { active: true }, include: { delivery: true } },
      },
    });
    if (soItems.length !== new Set(line.serviceOrderItemIds).size)
      throw Errors.business('Peça de OS inválida.');
    let inSo = 0;
    for (const s of soItems) {
      if (s.orderItemId !== oi.id)
        throw Errors.business(`${pieceCode(s)} é de outro item do pedido.`);
      if (s.serviceOrder.status !== 'ABERTA' && s.fulfillmentStage !== 'CANCELADA')
        throw Errors.business(`${pieceCode(s)}: OS inválida.`);
      if (['ENTREGUE', 'DEVOLVIDA'].includes(s.fulfillmentStage))
        throw Errors.business(`${pieceCode(s)} já saiu da oficina.`);
      if (s.deliveryItems.some((d) => ['EM_TRANSPORTE', 'NO_DESTINO'].includes(d.delivery.status)))
        throw Errors.business(`${pieceCode(s)} está em transporte.`);
      if (pending.some((p) => p.serviceOrderItemIds.includes(s.id)))
        throw Errors.conflict(`${pieceCode(s)} já está em outra devolução pendente.`);
      inSo += s.quantity;
    }
    const loose = line.quantity - inSo;
    if (loose < 0)
      throw Errors.business(`"${oi.description}": quantidade menor que as peças de OS escolhidas.`);
    const pendingLoose = pending
      .filter((p) => p.orderItemId === oi.id)
      .reduce((a, p) => a + p.quantity, 0);
    const availableLoose =
      oi.receivedQuantity - oi.returnedQuantity - alloc.inServiceOrders(oi.id) - pendingLoose;
    if (loose > availableLoose)
      throw Errors.business(
        `"${oi.description}": só ${Math.max(availableLoose, 0)} peça(s) recebida(s) fora de OS para devolver; escolha as peças de OS a devolver.`,
      );
  }
}

export async function createReturn(
  tx: Tx,
  actor: ActorContext,
  input: {
    orderId: string;
    reason: string;
    responsibleUserId?: string | null;
    returnDate: string;
    destination?: string | null;
    lines: Line[];
  },
) {
  if (!(await lockOrder(tx, input.orderId))) throw Errors.notFound('Pedido');
  await lockOrderItems(tx, input.orderId);
  await validateLines(tx, input.orderId, input.lines);
  if (input.responsibleUserId) {
    const u = await tx.user.findUnique({ where: { id: input.responsibleUserId } });
    if (!u?.active) throw Errors.business('Responsável inválido.');
  }
  const r = await tx.pieceReturn.create({
    data: {
      orderId: input.orderId,
      reason: input.reason,
      responsibleUserId: input.responsibleUserId ?? actor.userId,
      returnDate: parseDateOnly(input.returnDate)!,
      destination: input.destination ?? null,
      createdById: actor.userId,
      lines: {
        create: input.lines.map((l) => ({
          orderItemId: l.orderItemId,
          quantity: l.quantity,
          serviceOrderItemIds: [...new Set(l.serviceOrderItemIds)],
        })),
      },
    },
  });
  await audit(tx, actor, {
    action: 'return.registered',
    entityType: 'piece_return',
    entityId: r.id,
    summary: `Devolução ${returnCode(r.number)} registrada: ${input.lines.reduce((a, l) => a + l.quantity, 0)} peça(s). Motivo: ${input.reason}`,
  });
  await returnEvent(tx, actor, r);
  return r;
}

/** Retira a peça do fluxo de produção/qualidade/expedição sem apagar nada. */
async function withdrawItem(tx: Tx, actor: ActorContext, itemId: string, reason: string) {
  const tasks = await tx.productionTask.findMany({
    where: { serviceOrderItemId: itemId, status: { notIn: ['CONCLUIDA', 'CANCELADA'] } },
  });
  await lockTasks(
    tx,
    tasks.map((t) => t.id),
  );
  for (const t of tasks) {
    if (t.status === 'RASCUNHO') {
      await tx.productionTask.delete({ where: { id: t.id } });
      continue;
    }
    const u = await tx.productionTask.update({
      where: { id: t.id },
      data: {
        status: 'CANCELADA',
        cancelReason: reason.slice(0, 500),
        pauseImpediment: false,
        version: { increment: 1 },
      },
    });
    await notify(tx, actor, taskNotice(u, 'TAREFA_CANCELADA', reason));
    await taskEvent(tx, actor, null, t, {
      kind: 'CANCELADA',
      from: t.status,
      to: 'CANCELADA',
      note: reason,
    });
    await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, u);
  }
  await tx.qualityInspection.updateMany({
    where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
    data: { status: 'CANCELADA', invalidatedAt: new Date(), invalidReason: reason.slice(0, 500) },
  });
  await tx.packagingRecord.updateMany({
    where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
    data: { status: 'CANCELADA', invalidReason: reason.slice(0, 500) },
  });
  const deliveryItems = await tx.deliveryItem.findMany({
    where: { serviceOrderItemId: itemId, active: true },
    include: { delivery: true },
  });
  for (const di of deliveryItems) {
    await tx.deliveryItem.update({
      where: {
        deliveryId_serviceOrderItemId: { deliveryId: di.deliveryId, serviceOrderItemId: itemId },
      },
      data: { active: false },
    });
    await deliveryEvent(tx, actor, di.deliveryId, { kind: 'PECA_RETIRADA', note: reason });
    const left = await tx.deliveryItem.count({
      where: { deliveryId: di.deliveryId, active: true },
    });
    if (!left && ['PROVISORIA', 'AGENDADA', 'FRUSTRADA'].includes(di.delivery.status)) {
      const d = await lockDelivery(tx, di.deliveryId);
      await cancelDelivery(tx, actor, d.id, { reason: `Sem peças: ${reason}`, version: d.version });
    }
  }
}

export async function confirmReturn(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { note: string; version: number },
) {
  const r = await lockReturn(tx, id);
  if (r.status === 'CONFIRMADA') return r;
  if (r.version !== input.version) throw Errors.versionConflict(r.version);
  if (r.status !== 'REGISTRADA') throw Errors.business('Devolução cancelada.');
  await lockOrder(tx, r.orderId);
  await lockOrderItems(tx, r.orderId);
  await validateLines(tx, r.orderId, r.lines, r.id);
  const code = returnCode(r.number);
  const reason = `Devolvida ao cliente (${code}): ${r.reason}`;
  const touchedOrders = new Set<string>();
  const returnedBySo = new Map<string, string[]>();
  for (const line of r.lines) {
    for (const itemId of line.serviceOrderItemIds) {
      const item = await tx.serviceOrderItem.findUniqueOrThrow({
        where: { id: itemId },
        include: pieceInclude,
      });
      await withdrawItem(tx, actor, itemId, reason);
      await tx.serviceOrderItem.update({
        where: { id: itemId },
        data: { fulfillmentStage: 'DEVOLVIDA', currentLocationId: null },
      });
      await qualityEvent(tx, actor, itemId, {
        kind: 'DEVOLVIDA',
        note: `${reason}. ${input.note}`,
      });
      touchedOrders.add(item.serviceOrderId);
      returnedBySo.set(item.serviceOrderId, [
        ...(returnedBySo.get(item.serviceOrderId) ?? []),
        itemId,
      ]);
    }
    await tx.commercialOrderItem.update({
      where: { id: line.orderItemId },
      data: { returnedQuantity: { increment: line.quantity } },
    });
  }
  const u = await tx.pieceReturn.update({
    where: { id },
    data: {
      status: 'CONFIRMADA',
      confirmedAt: new Date(),
      confirmedById: actor.userId,
      confirmationNote: input.note,
      version: { increment: 1 },
    },
  });
  // OS sem nenhuma peça restante na oficina: cancelada com proteção (tarefas e reservas).
  for (const serviceOrderId of touchedOrders) {
    const so = await tx.serviceOrder.findUniqueOrThrow({
      where: { id: serviceOrderId },
      include: { items: { select: { fulfillmentStage: true } } },
    });
    if (so.status !== 'ABERTA') continue;
    if (so.items.some((i) => i.fulfillmentStage !== 'DEVOLVIDA')) {
      // Devolução parcial (Fase 12): só as reservas e os valores das peças devolvidas.
      const items = returnedBySo.get(so.id) ?? [];
      await releaseReservationsOfItems(tx, actor, so.id, items, `Peça devolvida (${code})`);
      await settleLaborOfWithdrawal(
        tx,
        actor,
        so.id,
        { itemIds: items },
        `peça devolvida (${code})`,
      );
      continue;
    }
    await tx.$queryRaw`SELECT id FROM service_orders WHERE id = ${so.id}::uuid FOR UPDATE`;
    const last = await tx.serviceOrderRevision.aggregate({
      where: { serviceOrderId: so.id },
      _max: { revision: true },
    });
    await tx.serviceOrder.update({
      where: { id: so.id },
      data: {
        status: 'CANCELADA',
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        cancelReason: reason.slice(0, 500),
        version: { increment: 1 },
      },
    });
    await tx.serviceOrderRevision.create({
      data: {
        serviceOrderId: so.id,
        revision: (last._max.revision ?? 0) + 1,
        scope: 'CANCELAMENTO',
        changes: { status: { from: 'ABERTA', to: 'CANCELADA' }, return: code },
        reason: reason.slice(0, 300),
        changedById: actor.userId,
      },
    });
    await protectCancelledServiceOrder(tx, actor, so.id, reason);
  }
  await refreshOrderStatus(tx, r.orderId);
  await audit(tx, actor, {
    action: 'return.confirmed',
    entityType: 'piece_return',
    entityId: id,
    summary: `${code} confirmada (${orderCode(r.order.number)}): ${input.note}`,
  });
  await returnEvent(tx, actor, u);
  return u;
}

export async function cancelReturn(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: { reason: string; version: number },
) {
  const r = await lockReturn(tx, id);
  if (r.status === 'CANCELADA') return r;
  if (r.version !== input.version) throw Errors.versionConflict(r.version);
  if (r.status !== 'REGISTRADA')
    throw Errors.business(
      'Devolução confirmada não pode ser cancelada (o histórico é preservado).',
    );
  const u = await tx.pieceReturn.update({
    where: { id },
    data: {
      status: 'CANCELADA',
      cancelledAt: new Date(),
      cancelReason: input.reason,
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'return.cancelled',
    entityType: 'piece_return',
    entityId: id,
    summary: `${returnCode(r.number)} cancelada: ${input.reason}`,
  });
  await returnEvent(tx, actor, u);
  return u;
}

/**
 * Correção auditável de recebimento: o registro original é imutável; a correção fica numa
 * tabela própria e ajusta a quantidade recebida do item do pedido — só quando não deixa peças
 * em OS ou devolvidas sem cobertura.
 */
export async function correctReceiptLine(
  tx: Tx,
  actor: ActorContext,
  receiptLineId: string,
  input: { newQuantity: number; reason: string },
) {
  const line = await tx.receiptLine.findUnique({
    where: { id: receiptLineId },
    include: { receipt: true, orderItem: true },
  });
  if (!line) throw Errors.notFound('Linha de recebimento');
  await lockOrder(tx, line.receipt.orderId);
  await lockOrderItems(tx, line.receipt.orderId);
  const oi = await tx.commercialOrderItem.findUniqueOrThrow({ where: { id: line.orderItemId } });
  const last = await tx.receiptCorrection.findFirst({
    where: { receiptLineId },
    orderBy: { createdAt: 'desc' },
  });
  const effective = last?.newQuantity ?? line.quantity;
  if (effective === input.newQuantity) throw Errors.business('A quantidade informada é a atual.');
  const alloc = await itemAllocations(tx, line.receipt.orderId);
  const problem = receiptCorrectionProblem({
    currentReceived: oi.receivedQuantity,
    lineQuantity: effective,
    newLineQuantity: input.newQuantity,
    ordered: oi.quantity,
    inServiceOrders: alloc.inServiceOrders(oi.id),
    returned: oi.returnedQuantity,
  });
  if (problem) throw Errors.business(problem);
  const correction = await tx.receiptCorrection.create({
    data: {
      receiptLineId,
      orderItemId: oi.id,
      previousQuantity: effective,
      newQuantity: input.newQuantity,
      reason: input.reason,
      actorId: actor.userId,
    },
  });
  await tx.commercialOrderItem.update({
    where: { id: oi.id },
    data: { receivedQuantity: oi.receivedQuantity - effective + input.newQuantity },
  });
  await refreshOrderStatus(tx, line.receipt.orderId);
  await audit(tx, actor, {
    action: 'receipt.corrected',
    entityType: 'receipt',
    entityId: line.receiptId,
    summary: `Recebimento corrigido ("${oi.description}"): ${effective} → ${input.newQuantity}. Justificativa: ${input.reason}`,
    changes: { quantity: { from: effective, to: input.newQuantity } },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.RECEIPT_CORRECTED,
    aggregateType: 'receipt',
    aggregateId: line.receiptId,
    payload: { id: line.receiptId, orderId: line.receipt.orderId, correctionId: correction.id },
    audience: anyPermissionAudience(
      'pedidos.ver',
      'recebimentos.registrar',
      'devolucoes.gerenciar',
    ),
  });
  return { correction, orderId: line.receipt.orderId };
}

/** OS cancelada: inspeções e embalagens abertas são canceladas; a peça sai das entregas. */
onServiceOrderCancelled(async (tx, actor, serviceOrderId, reason) => {
  const items = await tx.serviceOrderItem.findMany({ where: { serviceOrderId } });
  for (const i of items) {
    if (i.fulfillmentStage === 'ENTREGUE' || i.fulfillmentStage === 'DEVOLVIDA') continue;
    await withdrawItem(tx, actor, i.id, `OS cancelada: ${reason}`);
    await refreshItemStage(tx, actor, i.id);
  }
});
