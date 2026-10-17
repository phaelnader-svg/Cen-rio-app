import { EVENT_TYPES, itemValuesProblem, type PieceType, type ServiceType } from '@cenario/shared';
import type { CommercialOrder, Prisma, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { activeAddress, orderCode, parseDateOnly, snapshotAddress } from '../commercial/common';
import { recordAgreedValue } from '../finance/revenue';
import { assertPlannedIntent } from './planned-intent';
import { emitOrderEvent } from './routes';

/**
 * Serviço de domínio do pedido comercial (Simplificação Fase 2). O pedido é o registro do
 * SERVIÇO FECHADO antes da chegada das peças; não há segundo cadastro de serviços.
 * Valores comerciais exigem `pedidos.valores` — verificado aqui, não só na tela.
 */
export interface NewOrderInput {
  customerId: string;
  pickupAddressId?: string | null;
  contractedService: string;
  description?: string | null;
  agreedValueCents?: number | null;
  paymentTerms?: string | null;
  notes?: string | null;
  /** Fase 2: prazo combinado e observações técnicas (copiados para a OS gerada). */
  promisedDate?: string | null;
  technicalNotes?: string | null;
  /** Fase 2: pedido do fluxo Novo serviço — a OS nasce na confirmação da chegada. */
  autoServiceOrder?: boolean;
  /** Estabilização da Fase 2: o cliente entrega as peças na tapeçaria (sem retirada). */
  customerDropOff?: boolean;
  items: {
    pieceType: PieceType;
    description: string;
    quantity: number;
    notes?: string | null;
    serviceType?: ServiceType | null;
    fabricName?: string | null;
    fabricColor?: string | null;
    fabricReference?: string | null;
    technicalNotes?: string | null;
    /** Cobrança (AM-2): valor fechado da peça (todas ou nenhuma; soma = valor fechado). */
    agreedValueCents?: number | null;
    /** Estabilização da Fase 2: titular e mão de obra (por unidade) PREVISTOS — intenção. */
    plannedUpholstererUserId?: string | null;
    plannedLaborUnitCents?: number | null;
  }[];
}

export async function createOrder(
  tx: Tx,
  actor: ActorContext,
  perms: { has(permission: string): boolean },
  input: NewOrderInput,
): Promise<CommercialOrder> {
  const hasValues =
    (input.agreedValueCents !== null && input.agreedValueCents !== undefined) ||
    Boolean(input.paymentTerms) ||
    input.items.some((i) => i.agreedValueCents !== null && i.agreedValueCents !== undefined);
  if (hasValues && !perms.has('pedidos.valores')) {
    throw Errors.forbidden('Você não tem permissão para informar valores e condições comerciais.');
  }
  const itemProblem = itemValuesProblem(
    input.items.map((i) => i.agreedValueCents),
    input.agreedValueCents ?? null,
  );
  if (itemProblem) throw Errors.business(itemProblem);
  await assertPlannedIntent(tx, perms, input.items);
  const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
  if (!customer || !customer.active)
    throw Errors.validation(undefined, 'Cliente inválido ou arquivado.');
  const address = input.pickupAddressId
    ? await activeAddress(tx, customer.id, input.pickupAddressId)
    : null;
  const order = await tx.commercialOrder.create({
    data: {
      customerId: customer.id,
      pickupAddressId: address?.id ?? null,
      pickupAddressSnapshot: address
        ? (snapshotAddress(address) as unknown as Prisma.InputJsonValue)
        : undefined,
      contractedService: input.contractedService,
      description: input.description ?? null,
      agreedValueCents: input.agreedValueCents ?? null,
      paymentTerms: input.paymentTerms ?? null,
      notes: input.notes ?? null,
      promisedDate: parseDateOnly(input.promisedDate ?? undefined),
      technicalNotes: input.technicalNotes ?? null,
      autoServiceOrder: input.autoServiceOrder ?? false,
      customerDropOff: input.customerDropOff ?? false,
      createdById: actor.userId,
      items: {
        create: input.items.map((i, idx) => ({
          position: idx + 1,
          pieceType: i.pieceType,
          description: i.description,
          quantity: i.quantity,
          notes: i.notes ?? null,
          serviceType: i.serviceType ?? null,
          fabricName: i.fabricName ?? null,
          fabricColor: i.fabricColor ?? null,
          fabricReference: i.fabricReference ?? null,
          technicalNotes: i.technicalNotes ?? null,
          plannedUpholstererUserId: i.plannedUpholstererUserId ?? null,
          plannedLaborUnitCents: i.plannedLaborUnitCents ?? null,
          agreedValueCents: i.agreedValueCents ?? null,
        })),
      },
    },
  });
  if (order.agreedValueCents !== null)
    await recordAgreedValue(tx, actor, order.id, null, order.agreedValueCents);
  await audit(tx, actor, {
    action: 'order.created',
    entityType: 'commercial_order',
    entityId: order.id,
    summary: `Pedido ${orderCode(order.number)} criado para ${customer.name}.`,
    changes: {
      items: input.items.map((i) => `${i.quantity}× ${i.description}`),
      agreedValueCents: order.agreedValueCents,
      paymentTerms: order.paymentTerms,
      ...(input.items.some((i) => i.agreedValueCents !== null && i.agreedValueCents !== undefined)
        ? { itemValues: input.items.map((i) => `${i.description}: ${i.agreedValueCents}`) }
        : {}),
      ...(order.autoServiceOrder ? { autoServiceOrder: true } : {}),
      ...(order.customerDropOff ? { customerDropOff: true } : {}),
      ...(input.items.some((i) => i.plannedUpholstererUserId)
        ? {
            plannedIntent: input.items.map((i) => ({
              description: i.description,
              plannedUpholstererUserId: i.plannedUpholstererUserId ?? null,
              plannedLaborUnitCents: i.plannedLaborUnitCents ?? null,
            })),
          }
        : {}),
    },
  });
  await emitOrderEvent(tx, actor, order.id, EVENT_TYPES.ORDER_CREATED);
  return order;
}
