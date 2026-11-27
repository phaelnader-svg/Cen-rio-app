/**
 * Oficina sem tablet (2026-11-24, pedido do Raphael).
 *
 * O gestor marca o andamento do serviço pela OS — Começou, Ficou pronta, Aprovada, Saiu para
 * entrega, Entregue — com um clique, pelo computador ou pelo celular. Cada clique grava pelos
 * MESMOS registros que o tablet, a qualidade e a entrega já gravam (tarefas, inspeção, entrega),
 * então o estado da OS, os prazos, a mão de obra, as cobranças e as estatísticas seguem iguais:
 *
 * - a tarefa fica no nome do tapeceiro (quem fez), e o histórico guarda quem marcou;
 * - sem semana planejada, "Começou" cria uma tarefa única "Serviço completo" para o tapeceiro;
 * - "Aprovada" usa a aprovação normal da qualidade ("tudo conforme");
 * - "Saiu para entrega" usa a entrega agendada, se houver; senão grava uma saída direta pela OS
 *   (fora do roteiro); "Entregue" conclui essa entrega. "Cliente buscou" usa a entrega direta.
 *
 * Com a funcionalidade "Oficina sem tablet" ligada, a foto e a observação das etapas viram
 * opcionais e a qualidade aprova com um clique mesmo quando o gestor também trabalhou na peça.
 */
import {
  EVENT_TYPES,
  NEXT_STEPS,
  NEXT_STEP_DONE,
  NEXT_STEP_PERMISSION,
  NEXT_STEP_LABEL,
  OPERATIONAL_STATE_LABEL,
  STOPPED_SERVICE_DAYS,
  advanceServiceOrderSchema,
  deliveryCode,
  nextStepOf,
  taskCode,
  type AdvanceServiceOrderInput,
  type AdvanceServiceOrderResultDto,
  type NextStep,
  type OperationalStateDto,
  type ShopFloorDto,
  type ShopFloorGroupDto,
  type ShopFloorServiceDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import { moduleEnabled } from '../../core/modules';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { refreshAvailabilityOfUser } from '../attendance/common';
import { dateOnly, parseDateOnly, serviceOrderCode, snapshotAddress } from '../commercial/common';
import { serviceDeadlines } from '../deadlines/service';
import { lockRow } from '../finance/common';
import { originalTaskClosed } from '../issues/service';
import { idParams } from '../presenters';
import { moveItemToKey, pieceCode, pieceInclude, refreshItemStage } from '../quality/common';
import { deliverServiceOrderDirect } from '../quality/direct-delivery';
import {
  approveInspection,
  inspectIfProductionDone,
  qualityTaskClosed,
  viewerOf,
} from '../quality/inspections';
import {
  arriveDelivery,
  cancelDelivery,
  completeDelivery,
  deliverItems,
  deliveryDomainEvent,
  deliveryEvent,
  departDelivery,
  installDelivery,
  lockDelivery,
} from '../quality/shipping';
import { loadOperationalState, loadOperationalStates } from '../service-orders/operational';
import { company, domainTaskEvent, reevaluateTasks, taskEvent } from './common';

const ACCESS = {
  session: 'WEB',
  anyPermissions: ['producao.planejar', 'qualidade.gerenciar', 'entregas.gerenciar'],
} as const;
const VIEW = {
  session: 'WEB',
  anyPermissions: ['os.ver', 'producao.ver', 'producao.planejar'],
} as const;

const OPEN: Prisma.ProductionTaskWhereInput['status'] = {
  in: ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'],
};
const WAITING = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];
const DAY = 86_400_000;

/** Etapas obrigatórias da OS inteira (o mesmo recorte da etapa da peça, para todas as peças). */
const requiredOfOrder = (serviceOrderId: string) =>
  ({
    serviceOrderId,
    supportForTaskId: null,
    issueId: null,
    inspectionId: null,
    activity: { notIn: ['CORRECAO', 'EMBALAGEM'] },
  }) satisfies Prisma.ProductionTaskWhereInput;

/** Ordem natural das etapas (sequência do modelo, depois número). */
const taskOrder: Prisma.ProductionTaskOrderByWithRelationInput[] = [
  { sequence: 'asc' },
  { number: 'asc' },
];

export async function withoutTablet(db: Tx | PrismaClient) {
  return moduleEnabled(db, 'oficina_sem_tablet');
}

/** Tapeceiro da OS: o titular da primeira peça; senão o responsável técnico. */
async function upholstererOf(db: Tx | PrismaClient, serviceOrderId: string) {
  const so = await db.serviceOrder.findUniqueOrThrow({
    where: { id: serviceOrderId },
    select: {
      technicalLead: { select: { userId: true } },
      items: { select: { upholstererUserId: true }, orderBy: { position: 'asc' } },
    },
  });
  return (
    so.items.find((i) => i.upholstererUserId)?.upholstererUserId ?? so.technicalLead?.userId ?? null
  );
}

const nameOf = async (db: Tx | PrismaClient, userId: string | null) =>
  userId
    ? ((await db.user.findUnique({ where: { id: userId }, select: { displayName: true } }))
        ?.displayName ?? null)
    : null;

/** No modo fila, uma tarefa principal em andamento por pessoa: a outra fica pausada. */
async function pauseOthers(
  tx: Tx,
  actor: ActorContext,
  userId: string,
  exceptId: string,
  note: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fila:${userId}`}, 0))`;
  const others = await tx.productionTask.findMany({
    where: {
      assigneeUserId: userId,
      status: 'EM_EXECUCAO',
      queueExclusive: true,
      id: { not: exceptId },
    },
  });
  for (const o of others) {
    await tx.productionTask.update({
      where: { id: o.id },
      data: {
        status: 'PAUSADA',
        pauseReason: 'OUTRO',
        pauseNote: note,
        version: { increment: 1 },
      },
    });
    await taskEvent(tx, actor, null, o, {
      kind: 'PAUSADA',
      from: 'EM_EXECUCAO',
      to: 'PAUSADA',
      note,
      changes: { byManager: true },
    });
  }
}

type StepContext = {
  tx: Tx;
  actor: ActorContext;
  serviceOrderId: string;
  /** "Marcado por Raphael (sem tablet)". */
  note: string;
  relaxed: boolean;
  touchedUsers: Set<string>;
};

async function startTask(
  c: StepContext,
  t: Prisma.ProductionTaskGetPayload<object>,
  assignee: string,
) {
  const now = clockNow();
  const exclusive = t.queueExclusive;
  if (exclusive)
    await pauseOthers(
      c.tx,
      c.actor,
      assignee,
      t.id,
      `Começou outro serviço (${c.note.toLowerCase()})`,
    );
  const u = await c.tx.productionTask.update({
    where: { id: t.id },
    data: {
      assigneeUserId: assignee,
      status: 'EM_EXECUCAO',
      startedAt: t.startedAt ?? now,
      blockers: [],
      blockedReason: null,
      pauseReason: null,
      pauseNote: null,
      pauseImpediment: false,
      version: { increment: 1 },
    },
  });
  await taskEvent(c.tx, c.actor, null, t, {
    kind: 'INICIADA',
    from: t.status,
    to: 'EM_EXECUCAO',
    note: c.note,
    changes: { byManager: true, assigneeUserId: assignee },
  });
  await domainTaskEvent(c.tx, c.actor, EVENT_TYPES.PRODUCTION_TASK_STARTED, u);
  c.touchedUsers.add(assignee);
}

async function completeTask(
  c: StepContext,
  t: Prisma.ProductionTaskGetPayload<object>,
  fallbackAssignee: string | null,
  note: string | null,
) {
  const assignee = t.assigneeUserId ?? fallbackAssignee;
  if (!assignee)
    throw Errors.business(
      `${taskCode(t.number)} · ${t.title} está sem responsável: escolha o tapeceiro da OS em "Editar OS".`,
    );
  if (!c.relaxed && t.completionRequirement === 'OBSERVACAO' && !note)
    throw Errors.business(
      `A etapa ${t.title} pede uma observação de conclusão. Escreva a observação ou ligue "Oficina sem tablet" em Empresa → Funcionalidades.`,
    );
  if (!c.relaxed && t.completionRequirement === 'FOTO') {
    const photos = await c.tx.attachment.count({
      where: { entityType: 'PRODUCTION_TASK', entityId: t.id, deletedAt: null },
    });
    if (!photos)
      throw Errors.business(
        `A etapa ${t.title} pede uma foto antes de concluir. Conclua pelo tablet ou ligue "Oficina sem tablet" em Empresa → Funcionalidades.`,
      );
  }
  const now = clockNow();
  const u = await c.tx.productionTask.update({
    where: { id: t.id },
    data: {
      assigneeUserId: assignee,
      status: 'CONCLUIDA',
      startedAt: t.startedAt ?? now,
      completedAt: now,
      // Quem fez o serviço é o tapeceiro; quem marcou fica no histórico (evento).
      completedById: assignee,
      completedDeviceId: null,
      completionNote: note,
      progressPercent: 100,
      blockers: [],
      blockedReason: null,
      pauseReason: null,
      pauseNote: null,
      pauseImpediment: false,
      version: { increment: 1 },
    },
  });
  await taskEvent(c.tx, c.actor, null, t, {
    kind: 'CONCLUIDA',
    from: t.status,
    to: 'CONCLUIDA',
    note: note ? `${note} · ${c.note}` : c.note,
    changes: { byManager: true, assigneeUserId: assignee },
  });
  await audit(c.tx, c.actor, {
    action: 'production.task_completed',
    entityType: 'production_task',
    entityId: t.id,
    summary: `Tarefa ${taskCode(t.number)} (${t.title}) concluída — ${c.note.toLowerCase()}.`,
  });
  await domainTaskEvent(c.tx, c.actor, EVENT_TYPES.PRODUCTION_TASK_COMPLETED, u);
  await originalTaskClosed(c.tx, c.actor, t.id, 'CONCLUIDA');
  await qualityTaskClosed(c.tx, c.actor, t.id, 'CONCLUIDA');
  const dependents = await c.tx.taskDependency.findMany({
    where: { dependsOnId: t.id },
    select: { taskId: true },
  });
  await reevaluateTasks(
    c.tx,
    c.actor,
    dependents.map((d) => d.taskId),
    now,
  );
  c.touchedUsers.add(assignee);
}

/**
 * Sem nenhuma etapa publicada (semana não planejada): os rascunhos desta OS saem e nasce uma
 * etapa única "Serviço completo" para o tapeceiro, já em andamento.
 */
async function singleTask(c: StepContext, assignee: string) {
  const so = await c.tx.serviceOrder.findUniqueOrThrow({
    where: { id: c.serviceOrderId },
    select: { priority: true, promisedDate: true },
  });
  const drafts = await c.tx.productionTask.findMany({
    where: { ...requiredOfOrder(c.serviceOrderId), status: 'RASCUNHO' },
  });
  for (const d of drafts) {
    await c.tx.productionTask.update({
      where: { id: d.id },
      data: {
        status: 'CANCELADA',
        cancelReason: `Serviço marcado direto na OS (${c.note.toLowerCase()})`,
        version: { increment: 1 },
      },
    });
    await taskEvent(c.tx, c.actor, null, d, {
      kind: 'CANCELADA',
      from: 'RASCUNHO',
      to: 'CANCELADA',
      note: 'Serviço marcado direto na OS, sem a semana',
    });
  }
  const now = clockNow();
  const t = await c.tx.productionTask.create({
    data: {
      serviceOrderId: c.serviceOrderId,
      activity: 'REVESTIMENTO',
      stepClass: 'TAPECARIA',
      title: 'Serviço completo',
      role: 'PRINCIPAL',
      assigneeUserId: assignee,
      priority: so.priority,
      dueDate: so.promisedDate,
      status: 'EM_EXECUCAO',
      startedAt: now,
    },
  });
  await taskEvent(c.tx, c.actor, null, t, {
    kind: 'CRIADA',
    to: 'EM_EXECUCAO',
    note: `Serviço começou (${c.note.toLowerCase()})`,
    changes: { byManager: true, assigneeUserId: assignee },
  });
  await taskEvent(c.tx, c.actor, null, t, {
    kind: 'INICIADA',
    from: 'EM_EXECUCAO',
    to: 'EM_EXECUCAO',
    note: c.note,
    changes: { byManager: true },
  });
  await domainTaskEvent(c.tx, c.actor, EVENT_TYPES.PRODUCTION_TASK_STARTED, t);
  c.touchedUsers.add(assignee);
  return t;
}

async function stepStarted(c: StepContext) {
  const tapeceiro = await upholstererOf(c.tx, c.serviceOrderId);
  const tasks = await c.tx.productionTask.findMany({
    where: { ...requiredOfOrder(c.serviceOrderId), status: { notIn: ['CANCELADA', 'RASCUNHO'] } },
    orderBy: taskOrder,
  });
  if (!tasks.length) {
    if (!tapeceiro)
      throw Errors.business(
        'Escolha o tapeceiro da OS (botão "Editar OS") antes de marcar que começou.',
      );
    await singleTask(c, tapeceiro);
    return tapeceiro;
  }
  // Cada peça começa pela primeira etapa dela (as da OS inteira valem para todas as peças).
  const items = await c.tx.serviceOrderItem.findMany({
    where: { serviceOrderId: c.serviceOrderId, fulfillmentStage: 'EM_PRODUCAO' },
    select: { id: true },
    orderBy: { position: 'asc' },
  });
  const begun = (t: { status: string }) => !WAITING.includes(t.status);
  const toStart = new Map<string, (typeof tasks)[number]>();
  for (const item of items) {
    const mine = tasks.filter((t) => t.serviceOrderItemId === item.id || !t.serviceOrderItemId);
    if (mine.some(begun)) continue;
    const first = mine.find((t) => WAITING.includes(t.status));
    if (first) toStart.set(first.id, first);
  }
  let who: string | null = tapeceiro;
  for (const t of toStart.values()) {
    who = t.assigneeUserId ?? tapeceiro;
    if (!who)
      throw Errors.business(
        'Escolha o tapeceiro da OS (botão "Editar OS") antes de marcar que começou.',
      );
    await startTask(c, t, who);
  }
  return tapeceiro ?? who;
}

async function stepReady(c: StepContext, note: string | null) {
  const tapeceiro = await upholstererOf(c.tx, c.serviceOrderId);
  let open = await c.tx.productionTask.findMany({
    where: { ...requiredOfOrder(c.serviceOrderId), status: OPEN },
    orderBy: taskOrder,
  });
  const corrections = await c.tx.productionTask.findMany({
    where: {
      activity: 'CORRECAO',
      inspection: { serviceOrderId: c.serviceOrderId },
      status: OPEN,
    },
    orderBy: taskOrder,
  });
  const done = await c.tx.productionTask.count({
    where: { ...requiredOfOrder(c.serviceOrderId), status: 'CONCLUIDA' },
  });
  // Nada começado nem planejado: o serviço foi feito inteiro (marca o começo junto).
  if (!open.length && !corrections.length && !done) {
    if (!tapeceiro)
      throw Errors.business('Escolha o tapeceiro da OS (botão "Editar OS") antes de marcar.');
    open = [await singleTask(c, tapeceiro)];
  }
  for (const t of [...open, ...corrections]) await completeTask(c, t, tapeceiro, note);
  // Nenhuma etapa aberta, mas a inspeção ainda não nasceu (ex.: etapas concluídas antes).
  const items = await c.tx.serviceOrderItem.findMany({
    where: { serviceOrderId: c.serviceOrderId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const i of items) await inspectIfProductionDone(c.tx, c.actor, i.id);
  return tapeceiro;
}

async function stepApproved(c: StepContext, actorId: string) {
  const viewer = await viewerOf(c.tx, actorId);
  const items = await c.tx.serviceOrderItem.findMany({
    where: {
      serviceOrderId: c.serviceOrderId,
      fulfillmentStage: { in: ['AGUARDANDO_INSPECAO', 'EM_INSPECAO'] },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const item of items) {
    let i = await c.tx.qualityInspection.findFirst({
      where: { serviceOrderItemId: item.id, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
      orderBy: { round: 'desc' },
    });
    if (!i) {
      await inspectIfProductionDone(c.tx, c.actor, item.id);
      i = await c.tx.qualityInspection.findFirst({
        where: { serviceOrderItemId: item.id, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
        orderBy: { round: 'desc' },
      });
    }
    if (!i) continue;
    await approveInspection(c.tx, c.actor, viewer, i.id, {
      version: i.version,
      allConform: true,
      note: c.note,
      // Com "Oficina sem tablet", o gestor que também trabalhou na peça aprova com um clique;
      // a exceção continua registrada e destacada na auditoria.
      selfApprovalReason: c.relaxed
        ? 'Oficina sem tablet: aprovado pelo gestor no botão da próxima etapa.'
        : undefined,
    });
  }
}

const MANAGER = (userId: string) => ({ userId, isManager: true });

/** Saída para entrega: a entrega agendada sai; o que não tem entrega sai direto pela OS. */
async function stepLeft(c: StepContext, actorId: string) {
  const items = await c.tx.serviceOrderItem.findMany({
    where: {
      serviceOrderId: c.serviceOrderId,
      fulfillmentStage: { in: ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA'] },
    },
    include: pieceInclude,
    orderBy: { position: 'asc' },
  });
  if (!items.length) return;
  const active = await c.tx.deliveryItem.findMany({
    where: {
      serviceOrderItemId: { in: items.map((i) => i.id) },
      active: true,
      delivery: { status: { in: ['PROVISORIA', 'AGENDADA'] } },
    },
    include: { delivery: { select: { id: true, status: true } } },
  });
  const loose = new Set(items.map((i) => i.id));
  for (const deliveryId of [...new Set(active.map((a) => a.deliveryId))].sort()) {
    const d = await lockDelivery(c.tx, deliveryId);
    if (d.status === 'AGENDADA') {
      await departDelivery(
        c.tx,
        c.actor,
        MANAGER(actorId),
        d.id,
        { note: c.note, version: d.version },
        null,
      );
      for (const a of active.filter((x) => x.deliveryId === d.id))
        loose.delete(a.serviceOrderItemId);
    } else {
      // Pré-agendamento sem horário confirmado: sai do rascunho e a peça sai direto pela OS.
      await cancelDelivery(c.tx, c.actor, d.id, {
        reason: `Saiu para entrega direto pela OS (${c.note.toLowerCase()})`,
        version: d.version,
      });
    }
  }
  const pieces = items.filter((i) => loose.has(i.id));
  if (!pieces.length) return;
  const so = await c.tx.serviceOrder.findUniqueOrThrow({
    where: { id: c.serviceOrderId },
    include: { customer: true },
  });
  const address = await c.tx.customerAddress.findFirst({
    where: { customerId: so.customerId, archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  const { timezone } = await company(c.tx);
  const now = clockNow();
  const d = await c.tx.delivery.create({
    data: {
      origin: 'DIRETA',
      customerId: so.customerId,
      addressId: address?.id ?? null,
      addressSnapshot: (address
        ? snapshotAddress(address)
        : {}) as unknown as Prisma.InputJsonValue,
      contactName: so.customer.name,
      contactPhone: so.customer.phone ?? null,
      scheduledDate: parseDateOnly(
        new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now),
      )!,
      team: 'EQUIPE_PROPRIA',
      responsibleUserId: null,
      requiresInstallation: false,
      status: 'EM_TRANSPORTE',
      departedAt: now,
      createdById: c.actor.userId,
      items: { create: pieces.map((p) => ({ serviceOrderItemId: p.id })) },
    },
  });
  await deliveryEvent(c.tx, c.actor, d.id, {
    kind: 'SAIDA',
    to: 'EM_TRANSPORTE',
    note: `Saiu para entrega pela OS ${serviceOrderCode(so.number)} (${c.note.toLowerCase()}).`,
    data: { origin: 'DIRETA', items: pieces.map(pieceCode) },
  });
  for (const p of pieces) {
    await moveItemToKey(c.tx, c.actor, p.id, 'EM_TRANSPORTE', `Saída ${deliveryCode(d.number)}`);
    await refreshItemStage(c.tx, c.actor, p.id);
  }
  await audit(c.tx, c.actor, {
    action: 'delivery.direct_departed',
    entityType: 'delivery',
    entityId: d.id,
    summary: `${deliveryCode(d.number)}: OS ${serviceOrderCode(so.number)} saiu para entrega pela OS — ${so.customer.name}: ${pieces.map(pieceCode).join(', ')}.`,
  });
  await deliveryDomainEvent(c.tx, c.actor, d);
}

/** Entregue: conclui a entrega em andamento (todas as peças dela foram entregues). */
async function stepDelivered(c: StepContext, actorId: string, note: string | null) {
  const inTransit = await c.tx.deliveryItem.findMany({
    where: {
      active: true,
      serviceOrderItem: { serviceOrderId: c.serviceOrderId },
      delivery: { status: { in: ['EM_TRANSPORTE', 'NO_DESTINO'] } },
    },
    select: { deliveryId: true },
  });
  const viewer = MANAGER(actorId);
  for (const id of [...new Set(inTransit.map((x) => x.deliveryId))].sort()) {
    let d = await lockDelivery(c.tx, id);
    if (d.status === 'EM_TRANSPORTE') {
      await arriveDelivery(c.tx, c.actor, viewer, id, { note: c.note, version: d.version }, null);
      d = await lockDelivery(c.tx, id);
    }
    const pending = d.items.filter((i) => i.active && i.status === 'PENDENTE');
    if (pending.length) {
      await deliverItems(
        c.tx,
        c.actor,
        viewer,
        id,
        {
          items: pending.map((i) => ({
            serviceOrderItemId: i.serviceOrderItemId,
            status: 'ENTREGUE' as const,
          })),
          version: d.version,
        },
        null,
      );
      d = await lockDelivery(c.tx, id);
    }
    if (d.requiresInstallation && !d.installedAt) {
      await installDelivery(
        c.tx,
        c.actor,
        viewer,
        id,
        { note: `Instalação feita (${c.note.toLowerCase()})`, complete: true, version: d.version },
        null,
      );
      d = await lockDelivery(c.tx, id);
    }
    await completeDelivery(
      c.tx,
      c.actor,
      viewer,
      id,
      { note: note ?? c.note, version: d.version },
      null,
    );
  }
}

/** Marca a próxima etapa da OS (uma transação; repetir o mesmo clique não grava de novo). */
export async function advanceServiceOrder(
  tx: Tx,
  actor: ActorContext & { userId: string },
  serviceOrderId: string,
  input: AdvanceServiceOrderInput,
  permissions: ReadonlySet<string>,
): Promise<{ done: NextStep | null; touchedUsers: string[]; upholsterer: string | null }> {
  await lockRow(tx, 'service_orders', serviceOrderId, 'Ordem de serviço');
  const so = await tx.serviceOrder.findUniqueOrThrow({
    where: { id: serviceOrderId },
    select: { number: true, status: true, materialPurchasedAt: true },
  });
  const code = serviceOrderCode(so.number);
  if (so.status !== 'ABERTA') throw Errors.business(`${code} não está aberta.`);
  const state = (await loadOperationalState(tx, serviceOrderId))!;
  const next = nextOf(state, Boolean(so.materialPurchasedAt));
  const wanted = input.step;
  const customerPickup = Boolean(input.pickedUpByCustomer) && wanted === 'ENTREGUE';
  const matches = next === wanted || (customerPickup && next === 'SAIU');
  if (!matches) {
    // Clique repetido (a OS já passou desta etapa): nada é gravado de novo.
    const at = next
      ? NEXT_STEPS.indexOf(next)
      : state.state === 'ENTREGUE'
        ? NEXT_STEPS.length
        : -1;
    if (at > NEXT_STEPS.indexOf(wanted)) return { done: null, touchedUsers: [], upholsterer: null };
    if (!so.materialPurchasedAt && wanted === 'COMECOU')
      throw Errors.business(`${code}: marque "Material comprado" antes de marcar que começou.`);
    throw Errors.business(
      `${code} está em "${OPERATIONAL_STATE_LABEL[state.state]}"${next ? `: a próxima etapa é "${NEXT_STEP_LABEL[next]}"` : ''}.`,
    );
  }
  if (!permissions.has(NEXT_STEP_PERMISSION[wanted]))
    throw Errors.forbidden(`Você não tem permissão para marcar "${NEXT_STEP_LABEL[wanted]}".`);
  const who = await nameOf(tx, actor.userId);
  const c: StepContext = {
    tx,
    actor,
    serviceOrderId,
    note: `Marcado por ${who ?? 'gestor'} (sem tablet)`,
    relaxed: await withoutTablet(tx),
    touchedUsers: new Set(),
  };
  const note = input.note?.trim() || null;
  let upholsterer: string | null = null;
  switch (wanted) {
    case 'COMECOU':
      upholsterer = await stepStarted(c);
      break;
    case 'PRONTA':
      upholsterer = await stepReady(c, note);
      break;
    case 'APROVADA':
      await stepApproved(c, actor.userId);
      break;
    case 'SAIU':
      await stepLeft(c, actor.userId);
      break;
    case 'ENTREGUE':
      if (customerPickup)
        await deliverServiceOrderDirect(
          tx,
          actor,
          serviceOrderId,
          note ?? 'Cliente buscou na oficina',
        );
      else await stepDelivered(c, actor.userId, note);
      break;
  }
  await audit(tx, actor, {
    action: 'service_order.next_step',
    entityType: 'service_order',
    entityId: serviceOrderId,
    summary: `${code} ${customerPickup ? 'foi entregue (cliente buscou)' : NEXT_STEP_DONE[wanted]} — ${c.note.toLowerCase()}.`,
    changes: { step: wanted, ...(customerPickup ? { pickedUpByCustomer: true } : {}) },
  });
  return { done: wanted, touchedUsers: [...c.touchedUsers], upholsterer };
}

function nextOf(state: OperationalStateDto, materialPurchased: boolean) {
  return nextStepOf({
    state: state.state,
    reasons: state.items.flatMap((i) => i.reasons),
    materialPurchased,
  });
}

/** Próxima etapa de várias OS (lista de OS e "Hoje na oficina"). */
export async function nextStepsOf(
  db: Tx | PrismaClient,
  rows: readonly { id: string; status: string; materialPurchasedAt: Date | null }[],
  states?: Map<string, OperationalStateDto>,
) {
  const s =
    states ??
    (await loadOperationalStates(
      db,
      rows.map((r) => r.id),
    ));
  const out = new Map<string, NextStep | null>();
  for (const r of rows) {
    const st = s.get(r.id);
    out.set(r.id, !st || r.status !== 'ABERTA' ? null : nextOf(st, Boolean(r.materialPurchasedAt)));
  }
  return out;
}

/** Último movimento de cada OS (etapas, qualidade, entrega), para "parado há X dias". */
export async function lastMovesOf(db: Tx | PrismaClient, serviceOrderIds: string[]) {
  const out = new Map<string, Date>();
  if (!serviceOrderIds.length) return out;
  const rows = await db.$queryRaw<{ id: string; at: Date | null }[]>`
    SELECT so.id::text AS id, GREATEST(
      (SELECT MAX(e.created_at) FROM production_task_events e
         JOIN production_tasks t ON t.id = e.task_id WHERE t.service_order_id = so.id),
      (SELECT MAX(q.created_at) FROM quality_events q
         JOIN service_order_items i ON i.id = q.service_order_item_id WHERE i.service_order_id = so.id),
      so.material_purchased_at
    ) AS at
    FROM service_orders so WHERE so.id = ANY(${serviceOrderIds}::uuid[])`;
  for (const r of rows) if (r.at) out.set(r.id, r.at);
  return out;
}

/** Serviços começados sem movimento há STOPPED_SERVICE_DAYS dias ou mais (aviso do sininho). */
export async function stoppedServices(db: Tx | PrismaClient) {
  const sos = await db.serviceOrder.findMany({
    where: { status: 'ABERTA', productionTasks: { some: { startedAt: { not: null } } } },
    select: { id: true, number: true, customer: { select: { name: true } } },
  });
  const states = await loadOperationalStates(
    db,
    sos.map((s) => s.id),
  );
  const started = sos.filter((s) => {
    const st = states.get(s.id)?.state;
    return st === 'EM_PRODUCAO' || st === 'CORRECAO_NECESSARIA';
  });
  const moves = await lastMovesOf(
    db,
    started.map((s) => s.id),
  );
  const now = clockNow().getTime();
  return started
    .map((s) => {
      const at = moves.get(s.id) ?? null;
      return { ...s, since: at, days: at ? Math.floor((now - at.getTime()) / DAY) : 0 };
    })
    .filter((s) => s.since && s.days >= STOPPED_SERVICE_DAYS);
}

/** "Hoje na oficina": tudo que está na oficina e ainda não foi entregue, por tapeceiro. */
export async function loadShopFloor(db: PrismaClient): Promise<ShopFloorDto> {
  const sos = await db.serviceOrder.findMany({
    where: { status: 'ABERTA' },
    include: {
      customer: { select: { id: true, name: true, phone: true, whatsapp: true } },
      order: { select: { rework: { select: { id: true } } } },
      technicalLead: {
        select: {
          user: { select: { id: true } },
          displayName: true,
          color: true,
          photoFileId: true,
        },
      },
      items: {
        orderBy: { position: 'asc' },
        select: {
          description: true,
          quantity: true,
          upholsterer: {
            select: {
              id: true,
              displayName: true,
              employee: { select: { color: true, photoFileId: true } },
            },
          },
        },
      },
    },
    orderBy: [{ promisedDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
  });
  const states = await loadOperationalStates(
    db,
    sos.map((s) => s.id),
  );
  const nexts = await nextStepsOf(db, sos, states);
  const moves = await lastMovesOf(
    db,
    sos.map((s) => s.id),
  );
  const deadlines = await serviceDeadlines(db, { id: { in: sos.map((s) => s.id) } });
  const now = clockNow().getTime();
  const groups = new Map<string, ShopFloorGroupDto>();
  const counts = { started: 0, ready: 0, delivery: 0, waiting: 0 };
  for (const so of sos) {
    const st = states.get(so.id);
    if (!st || ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'].includes(st.state)) continue;
    const inProduction = st.state === 'EM_PRODUCAO' || st.state === 'CORRECAO_NECESSARIA';
    if (inProduction) counts.started++;
    else if (st.state === 'AGUARDANDO_QUALIDADE') counts.ready++;
    else if (st.state === 'PRONTA_PARA_ENTREGA' || st.state === 'EM_ENTREGA') counts.delivery++;
    else counts.waiting++;
    const owner = so.items.find((i) => i.upholsterer)?.upholsterer;
    const person = owner
      ? {
          id: owner.id,
          displayName: owner.displayName,
          color: owner.employee?.color ?? null,
          photoUrl: owner.employee?.photoFileId ? `/api/files/${owner.employee.photoFileId}` : null,
        }
      : so.technicalLead
        ? {
            id: so.technicalLead.user.id,
            displayName: so.technicalLead.displayName,
            color: so.technicalLead.color,
            photoUrl: so.technicalLead.photoFileId
              ? `/api/files/${so.technicalLead.photoFileId}`
              : null,
          }
        : null;
    const key = person?.id ?? '-';
    if (!groups.has(key)) groups.set(key, { upholsterer: person, services: [] });
    const at = moves.get(so.id) ?? null;
    const deadline = deadlines.get(so.id);
    const service: ShopFloorServiceDto = {
      id: so.id,
      code: serviceOrderCode(so.number),
      customer: {
        id: so.customer.id,
        name: so.customer.name,
        phone: so.customer.whatsapp || so.customer.phone || null,
      },
      pieces: so.items
        .map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.description}` : i.description))
        .join(', '),
      promisedDate: dateOnly(so.promisedDate),
      priority: so.priority,
      state: st.state,
      next: nexts.get(so.id) ?? null,
      materialPurchased: Boolean(so.materialPurchasedAt),
      rework: Boolean(so.order.rework),
      version: so.version,
      lastMoveAt: at?.toISOString() ?? null,
      stoppedDays: inProduction && at ? Math.floor((now - at.getTime()) / DAY) : null,
      late: deadline?.state === 'ATRASADO',
    };
    groups.get(key)!.services.push(service);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    !a.upholsterer
      ? 1
      : !b.upholsterer
        ? -1
        : a.upholsterer.displayName.localeCompare(b.upholsterer.displayName),
  );
  return { withoutTablet: await withoutTablet(db), groups: ordered, counts };
}

export async function shopFloorRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/shop-floor', { config: { access: VIEW } }, async () => loadShopFloor(prisma));

  app.post(
    '/api/v1/service-orders/:id/next-step',
    { config: { access: ACCESS, idempotent: true } },
    async (request): Promise<AdvanceServiceOrderResultDto> => {
      const { id } = idParams.parse(request.params);
      const input = advanceServiceOrderSchema.parse(request.body);
      const actor = actorFrom(request);
      const permissions = request.auth!.permissions as ReadonlySet<string>;
      const r = await prisma.$transaction(
        (tx) =>
          advanceServiceOrder(
            tx,
            { ...actor, userId: request.auth!.userId },
            id,
            input,
            permissions,
          ),
        { timeout: 30_000 },
      );
      if (r.touchedUsers.length)
        await prisma.$transaction(async (tx) => {
          for (const u of r.touchedUsers) await refreshAvailabilityOfUser(tx, actor, u);
        });
      const so = await prisma.serviceOrder.findUniqueOrThrow({
        where: { id },
        select: { number: true, status: true, materialPurchasedAt: true },
      });
      const state = (await loadOperationalState(prisma, id))!;
      const inspection =
        r.done === 'PRONTA' || r.done === 'APROVADA'
          ? await prisma.qualityInspection.findFirst({
              where: { serviceOrderId: id, status: { not: 'CANCELADA' } },
              orderBy: [{ createdAt: 'desc' }],
              select: { id: true },
            })
          : null;
      return {
        serviceOrderId: id,
        code: serviceOrderCode(so.number),
        done: r.done,
        next: so.status === 'ABERTA' ? nextOf(state, Boolean(so.materialPurchasedAt)) : null,
        state: state.state,
        upholsterer: await nameOf(prisma, r.upholsterer),
        photoTarget: inspection
          ? { entityType: 'QUALITY_INSPECTION', entityId: inspection.id }
          : null,
      };
    },
  );
}
