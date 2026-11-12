import {
  READINESS_CHECK_LABEL,
  deliveryCode,
  directDeliveryRevertSchema,
  directDeliverySchema,
  type DirectDeliveryBlock,
  type DirectDeliveryRevertResultDto,
  type DirectDeliveryEligibilityDto,
  type DirectDeliveryResultDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { parseDateOnly, serviceOrderCode, snapshotAddress } from '../commercial/common';
import { lockRow } from '../finance/common';
import { todayIn } from '../measurements/service';
import { idParams } from '../presenters';
import { company } from '../production/common';
import {
  DELIVERED_ITEM,
  DELIVERY_MANAGE,
  moveItemToKey,
  pieceCode,
  pieceInclude,
  readinessOfItem,
  refreshItemStage,
} from './common';
import {
  DIRECT_REVERT_ACCESS,
  directDeliveryRevertPreview,
  revertDirectDelivery,
} from './direct-delivery-revert';
import { deliveryDomainEvent, deliveryEvent } from './shipping';

/**
 * Reformulação, Fase 1 — "Marcar como entregue" direto na OS.
 *
 * Substitui a dependência operacional da logística sem inventar uma viagem: grava uma entrega
 * JÁ CONCLUÍDA com origem DIRETA (sem roteiro, horário, responsável de transporte nem custo de
 * viagem). Por ser uma entrega concluída como as outras, todos os efeitos que já dependiam da
 * entrega acontecem pelos mesmos caminhos, uma única vez:
 *  - etapa da peça → ENTREGUE (refreshItemStage, que também libera a mão de obra com regra
 *    "entrega concluída" e resolve o aviso de "pronta para entrega");
 *  - vencimento das cobranças com gatilho ENTREGA, data de conclusão no resultado da OS, prazo
 *    encerrado e "serviço concluído" no pedido — todos lidos das entregas concluídas.
 * O que é de viagem fica de fora pela origem DIRETA: custo de frete, pendência de "custo não
 * informado" no fechamento semanal, roteiro e filas da logística.
 *
 * Regras de elegibilidade = as da logística (mesma função): tarefas obrigatórias concluídas,
 * inspeção de qualidade aprovada, sem correção aberta, embalagem concluída e sem bloqueio de
 * expedição. A qualidade obrigatória nunca é pulada.
 *
 * Concorrência e repetição: trava a OS e as peças (ordem fixa), e uma repetição depois de
 * concluída devolve `created: false` sem gravar nada. A rota também exige chave de idempotência
 * (repete a mesma resposta) e o índice único de "uma entrega ativa por peça" impede duplicidade.
 */

const VIEW = { session: 'WEB', anyPermissions: ['os.ver', 'entregas.ver'] } as const;
const FINAL_STAGES = ['DEVOLVIDA', 'CANCELADA'];

async function piecesOf(db: Tx | PrismaClient, serviceOrderId: string) {
  return db.serviceOrderItem.findMany({
    where: { serviceOrderId, fulfillmentStage: { notIn: FINAL_STAGES } },
    include: pieceInclude,
    orderBy: { position: 'asc' },
  });
}

async function lastDeliveryOf(db: Tx | PrismaClient, serviceOrderId: string) {
  const d = await db.delivery.findFirst({
    where: {
      status: 'CONCLUIDA',
      items: {
        some: { status: DELIVERED_ITEM.status, serviceOrderItem: { serviceOrderId } },
      },
    },
    orderBy: { completedAt: 'desc' },
    include: { createdBy: { select: { id: true, displayName: true } } },
  });
  return d;
}

export async function directDeliveryEligibility(
  db: Tx | PrismaClient,
  serviceOrderId: string,
): Promise<DirectDeliveryEligibilityDto> {
  const so = await db.serviceOrder.findUnique({ where: { id: serviceOrderId } });
  if (!so) throw Errors.notFound('Ordem de serviço');
  const pieces = await piecesOf(db, serviceOrderId);
  const pending = pieces.filter((p) => p.fulfillmentStage !== 'ENTREGUE');
  const blocks: DirectDeliveryBlock[] = [];
  for (const p of pending) {
    const reasons: string[] = [];
    if (so.status !== 'ABERTA') reasons.push('a OS não está ativa');
    const r = await readinessOfItem(db, p.id);
    for (const m of r.readiness.missing) reasons.push(READINESS_CHECK_LABEL[m].toLowerCase());
    const scheduled = await db.deliveryItem.findFirst({
      where: { serviceOrderItemId: p.id, active: true, delivery: { status: { not: 'CONCLUIDA' } } },
      include: { delivery: { select: { number: true } } },
    });
    if (scheduled)
      reasons.push(
        `já está na entrega ${deliveryCode(scheduled.delivery.number)} da logística (conclua ou cancele por lá)`,
      );
    if (reasons.length) blocks.push({ itemId: p.id, code: pieceCode(p), reasons });
  }
  const last = await lastDeliveryOf(db, serviceOrderId);
  // Fase 3 (D5): a última entrega direta desfeita (histórico visível na OS).
  const reverted = await db.delivery.findFirst({
    where: {
      origin: 'DIRETA',
      revertedAt: { not: null },
      items: { some: { serviceOrderItem: { serviceOrderId } } },
    },
    orderBy: { revertedAt: 'desc' },
    include: { revertedBy: { select: { displayName: true } } },
  });
  return {
    eligible: pending.length > 0 && blocks.length === 0,
    delivered: pieces.length > 0 && pending.length === 0,
    pendingItems: pending.map((p) => ({ itemId: p.id, code: pieceCode(p) })),
    blocks,
    lastDelivery: last
      ? {
          id: last.id,
          code: deliveryCode(last.number),
          origin: last.origin === 'DIRETA' ? 'DIRETA' : 'LOGISTICA',
          completedAt: last.completedAt?.toISOString() ?? null,
          confirmedBy: last.origin === 'DIRETA' ? (last.createdBy ?? null) : null,
        }
      : null,
    lastReverted: reverted
      ? {
          id: reverted.id,
          code: deliveryCode(reverted.number),
          revertedAt: reverted.revertedAt!.toISOString(),
          revertedBy: reverted.revertedBy?.displayName ?? null,
          reason: reverted.revertReason ?? '',
        }
      : null,
  };
}

/** Grava a entrega direta de todas as peças pendentes da OS (ver comentário do módulo). */
export async function deliverServiceOrderDirect(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  note: string | null,
): Promise<{
  created: boolean;
  deliveryId: string | null;
  deliveryCode: string | null;
  count: number;
}> {
  await lockRow(tx, 'service_orders', serviceOrderId, 'Ordem de serviço');
  const so = await tx.serviceOrder.findUniqueOrThrow({
    where: { id: serviceOrderId },
    include: { customer: true },
  });
  const pieces = await piecesOf(tx, serviceOrderId);
  for (const p of [...pieces].sort((a, b) => a.id.localeCompare(b.id)))
    await tx.$queryRaw`SELECT id FROM service_order_items WHERE id = ${p.id}::uuid FOR UPDATE`;
  // Releitura depois das travas: o que outra requisição concluiu enquanto esperávamos já conta.
  const fresh = await piecesOf(tx, serviceOrderId);
  const pending = fresh.filter((p) => p.fulfillmentStage !== 'ENTREGUE');
  if (!fresh.length) throw Errors.business('A OS não tem peças para entregar.');
  if (!pending.length) return { created: false, deliveryId: null, deliveryCode: null, count: 0 };
  const eligibility = await directDeliveryEligibility(tx, serviceOrderId);
  if (eligibility.blocks.length)
    throw Errors.business(
      `A OS ainda não pode ser entregue — ${eligibility.blocks
        .map((b) => `${b.code}: ${b.reasons.join(', ')}`)
        .join('; ')}.`,
      { blocks: eligibility.blocks },
    );

  const address = await tx.customerAddress.findFirst({
    where: { customerId: so.customerId, archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  const { timezone } = await company(tx);
  const now = new Date();
  const d = await tx.delivery.create({
    data: {
      origin: 'DIRETA',
      customerId: so.customerId,
      addressId: address?.id ?? null,
      // Só como referência do cliente (não houve viagem); sem endereço, fica vazio.
      addressSnapshot: (address
        ? snapshotAddress(address)
        : {}) as unknown as Prisma.InputJsonValue,
      contactName: so.customer.name,
      contactPhone: so.customer.phone ?? null,
      scheduledDate: parseDateOnly(todayIn(timezone))!,
      team: 'EQUIPE_PROPRIA',
      responsibleUserId: null,
      requiresInstallation: false,
      status: 'CONCLUIDA',
      completedAt: now,
      completionNote: note,
      createdById: actor.userId,
      items: {
        create: pending.map((p) => ({
          serviceOrderItemId: p.id,
          status: 'ENTREGUE',
          deliveredAt: now,
        })),
      },
    },
  });
  const code = deliveryCode(d.number);
  await deliveryEvent(tx, actor, d.id, {
    kind: 'ENTREGA_DIRETA',
    to: 'CONCLUIDA',
    note: `Entrega confirmada diretamente pela OS ${serviceOrderCode(so.number)} (sem roteiro nem viagem).${note ? ` ${note}` : ''}`,
    data: { origin: 'DIRETA', items: pending.map(pieceCode) },
  });
  for (const p of pending)
    await moveItemToKey(tx, actor, p.id, 'ENTREGUE', `Entregue (confirmação direta pela OS)`);
  for (const p of pending) await refreshItemStage(tx, actor, p.id);
  await audit(tx, actor, {
    action: 'delivery.direct_completed',
    entityType: 'delivery',
    entityId: d.id,
    summary: `${code}: OS ${serviceOrderCode(so.number)} marcada como entregue pela OS (confirmação direta) — ${so.customer.name}: ${pending.map(pieceCode).join(', ')}.`,
    changes: { origin: 'DIRETA', serviceOrderId, items: pending.map(pieceCode) },
  });
  await deliveryDomainEvent(tx, actor, d);
  return { created: true, deliveryId: d.id, deliveryCode: code, count: pending.length };
}

export async function directDeliveryRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/service-orders/:id/direct-delivery',
    { config: { access: VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return directDeliveryEligibility(prisma, id);
    },
  );

  // Fase 3 (D5): prévia e confirmação de "desfazer a entrega direta".
  app.get(
    '/api/v1/service-orders/:id/direct-delivery/revert-preview',
    { config: { access: DIRECT_REVERT_ACCESS } },
    async (request) => directDeliveryRevertPreview(prisma, idParams.parse(request.params).id),
  );

  app.post(
    '/api/v1/service-orders/:id/direct-delivery/revert',
    { config: { access: DIRECT_REVERT_ACCESS, idempotent: true } },
    async (request): Promise<DirectDeliveryRevertResultDto> => {
      const { id } = idParams.parse(request.params);
      const input = directDeliveryRevertSchema.parse(request.body);
      const actor = actorFrom(request);
      const r = await prisma.$transaction((tx) => revertDirectDelivery(tx, actor, id, input));
      return { ...r, eligibility: await directDeliveryEligibility(prisma, id) };
    },
  );

  app.post(
    '/api/v1/service-orders/:id/deliver',
    { config: { access: DELIVERY_MANAGE, idempotent: true } },
    async (request): Promise<DirectDeliveryResultDto> => {
      const { id } = idParams.parse(request.params);
      const input = directDeliverySchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      const r = await prisma.$transaction((tx) =>
        deliverServiceOrderDirect(tx, actor, id, input.note ?? null),
      );
      return {
        created: r.created,
        deliveryId: r.deliveryId,
        deliveryCode: r.deliveryCode,
        deliveredItems: r.count,
        eligibility: await directDeliveryEligibility(prisma, id),
      };
    },
  );
}
