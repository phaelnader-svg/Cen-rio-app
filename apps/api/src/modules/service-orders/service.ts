import { plural } from '@cenario/shared';
import { EVENT_TYPES, type createServiceOrderSchema } from '@cenario/shared';
import type { ServiceOrder, Tx } from '@cenario/db';
import type { z } from 'zod';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import {
  lockOrder,
  lockOrderItems,
  orderCode,
  parseDateOnly,
  serviceOrderCode,
} from '../commercial/common';
import { itemAllocations } from '../commercial/status';
import { createLabor } from '../finance/labor';
import { syncPickupCostsOfOrder } from '../finance/trip-costs';
import { emitOrderEvent } from '../orders/routes';
import { setUpholsterer } from '../production/distribution';
import { materialDescription, quoteWork } from './quote-work';
import { recordChange } from './routes';

/**
 * Serviço de domínio da criação da OS (`POST /api/v1/service-orders`). Fluxo da OS (2026-11-18):
 * a OS é gerada à mão no pedido, depois que a peça chega (o fechamento do serviço não cria OS).
 * A OS aceita peças do pedido ainda não incluídas em outra OS. Nasce "aguardando material", salvo
 * se `materialPurchased` vier marcado.
 */
export type NewServiceOrderInput = z.output<typeof createServiceOrderSchema>;

export async function createServiceOrder(
  tx: Tx,
  actor: ActorContext,
  perms: { has(permission: string): boolean },
  input: NewServiceOrderInput,
  opts: { summary?: (code: string) => string; locked?: boolean } = {},
): Promise<ServiceOrder> {
  // Correção global: titular e mão de obra opcionais NA CRIAÇÃO, cada parte com a permissão
  // da tela própria (nada é concedido por estar na criação da OS).
  if (input.items.some((i) => i.upholstererUserId) && !perms.has('producao.planejar'))
    throw Errors.forbidden('Definir o tapeceiro titular exige a permissão de planejar a produção.');
  if (
    input.items.some((i) => i.labor) &&
    !(perms.has('financeiro.ver') && perms.has('financeiro.gerenciar'))
  )
    throw Errors.forbidden('Combinar a mão de obra exige a permissão de gerenciar o financeiro.');
  if (!opts.locked) {
    if (!(await lockOrder(tx, input.orderId))) throw Errors.notFound('Pedido');
    await lockOrderItems(tx, input.orderId);
  }
  const order = await tx.commercialOrder.findUniqueOrThrow({
    where: { id: input.orderId },
    include: { items: true },
  });
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  const alloc = await itemAllocations(tx, order.id);
  const requested = new Map<string, number>();
  for (const it of input.items) {
    requested.set(it.orderItemId, (requested.get(it.orderItemId) ?? 0) + it.quantity);
  }
  for (const [orderItemId, qty] of requested) {
    const item = order.items.find((i) => i.id === orderItemId);
    if (!item) throw Errors.validation(undefined, 'Peça não pertence a este pedido.');
    const available = item.quantity - item.returnedQuantity - alloc.inServiceOrders(item.id);
    if (qty > available) {
      throw Errors.business(
        available <= 0
          ? `"${item.description}" já está em outra OS.`
          : `"${item.description}": apenas ${plural(available, 'peça disponível', 'peças disponíveis')} para OS.`,
      );
    }
  }
  if (input.technicalLeadId) {
    const lead = await tx.employee.findUnique({ where: { id: input.technicalLeadId } });
    if (!lead || !lead.active) throw Errors.validation(undefined, 'Responsável técnico inválido.');
  }
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
      ...(input.materialPurchased
        ? { materialPurchasedAt: new Date(), materialPurchasedById: actor.userId }
        : {}),
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
  // Correção global: titular e mão de obra por peça na MESMA transação — qualquer recusa
  // (titular inelegível, valor inválido, duplicidade) desfaz a OS inteira.
  const created = await tx.serviceOrderItem.findMany({
    where: { serviceOrderId: so.id },
    orderBy: { position: 'asc' },
  });
  for (const [idx, it] of input.items.entries()) {
    const item = created[idx]!;
    if (it.upholstererUserId)
      await setUpholsterer(tx, actor, item.id, {
        userId: it.upholstererUserId,
        expectedUserId: null,
        confirm: false,
      });
    if (it.labor)
      await createLabor(tx, actor, {
        professionalUserId: it.upholstererUserId!,
        serviceOrderId: so.id,
        serviceOrderItemId: item.id,
        service: it.labor.service?.trim() || `Tapeçaria — ${it.description}`,
        agreedCents: it.labor.agreedCents,
        eligibility: it.labor.eligibility,
        notes: it.labor.notes ?? null,
      });
  }
  // 2026-11-19 (Raphael): os materiais do orçamento (com as medidas da espuma) entram na lista
  // da OS, sem custo — o tapeceiro vê o que vai usar e a compra segue pelo "Material comprado".
  if (input.materialsFromQuote) {
    const quote = await tx.quote.findFirst({
      where: { orderId: order.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { number: true, snapshot: true, workOrder: true },
    });
    const bought = Boolean(input.materialPurchased);
    for (const m of quote ? quoteWork(quote).materials : [])
      await tx.serviceOrderMaterial.create({
        data: {
          serviceOrderId: so.id,
          description: materialDescription(m),
          quantity: m.quantity,
          unit: m.unit.slice(0, 20) || null,
          notes: `Do orçamento nº ${quote!.number}`,
          purchased: bought,
          available: bought,
          createdById: actor.userId,
        },
      });
  }
  // Evolução Fase 6: a OS entra no rateio automático da retirada do pedido.
  await syncPickupCostsOfOrder(tx, actor, order.id);
  await recordChange(
    tx,
    actor,
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
      summary: opts.summary
        ? opts.summary(serviceOrderCode(so.number))
        : `OS ${serviceOrderCode(so.number)} criada a partir do pedido ${orderCode(order.number)}.`,
      action: 'service_order.created',
    },
    EVENT_TYPES.SERVICE_ORDER_CREATED,
  );
  await emitOrderEvent(tx, actor, order.id);
  return so;
}
