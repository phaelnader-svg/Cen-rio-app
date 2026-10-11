import { PICKUP_RECEIVABLE, createReceiptSchema, type ReceiptDto } from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { idParams, toEmployeeSummary } from '../presenters';
import {
  orderCode,
  pickupCode,
  receiptCode,
  serviceOrderCode,
  toCustomerSummary,
} from '../commercial/common';
import { registerReceipt } from './service';
import { shortCustomerName } from '../../core/device-privacy';

/** Quem registra recebimentos pode usar painel ou (futuramente) tablet. */
const REGISTER = { session: 'any', permissions: ['recebimentos.registrar'] } as const;
const VIEW = { session: 'any', anyPermissions: ['pedidos.ver', 'recebimentos.registrar'] } as const;
/** Tolerância para relógios de dispositivos ligeiramente adiantados. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const fullInclude = {
  order: { include: { customer: true } },
  pickup: { select: { id: true, number: true } },
  serviceOrder: { select: { id: true, number: true } },
  device: { select: { name: true } },
  receivedBy: true,
  registeredBy: { select: { displayName: true } },
  lines: {
    include: {
      orderItem: true,
      corrections: { orderBy: { createdAt: 'desc' as const }, take: 1 },
    },
    orderBy: { orderItem: { position: 'asc' as const } },
  },
} satisfies Prisma.ReceiptInclude;

/** Simplificação Fase 3: nos tablets, o cliente aparece como "Primeiro I." (privacidade). */
function deviceSafe<T extends { name: string; tradeName: string | null }>(
  c: T,
  device: boolean,
): T {
  return device ? { ...c, name: shortCustomerName(c.name), tradeName: null } : c;
}

async function loadReceiptDto(
  db: PrismaClient | Tx,
  id: string,
  device = false,
): Promise<ReceiptDto> {
  const r = await db.receipt.findUnique({ where: { id }, include: fullInclude });
  if (!r) throw Errors.notFound('Recebimento');
  return {
    id: r.id,
    number: r.number,
    code: receiptCode(r.number),
    order: { id: r.orderId, code: orderCode(r.order.number) },
    customer: deviceSafe(toCustomerSummary(r.order.customer), device),
    pickup: r.pickup ? { id: r.pickup.id, code: pickupCode(r.pickup.number) } : null,
    origin: r.origin,
    receivedAt: r.receivedAt.toISOString(),
    receivedBy: r.receivedBy ? toEmployeeSummary(r.receivedBy) : null,
    registeredBy: r.registeredBy?.displayName ?? null,
    divergences: r.divergences,
    notes: r.notes,
    lines: r.lines.map((l) => ({
      id: l.id,
      orderItemId: l.orderItemId,
      pieceType: l.orderItem.pieceType,
      description: l.orderItem.description,
      quantity: l.quantity,
      condition: l.condition,
      conditionNotes: l.conditionNotes,
      location: l.location,
      correctedQuantity: l.corrections[0]?.newQuantity ?? null,
    })),
    generatedServiceOrder: r.serviceOrder
      ? { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) }
      : null,
    device: r.device?.name ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function receiptRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/receipts', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({
        orderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    const rows = await prisma.receipt.findMany({
      where: q.orderId ? { orderId: q.orderId } : {},
      select: { id: true },
      orderBy: { receivedAt: 'desc' },
      take: q.limit,
    });
    return Promise.all(
      rows.map((r) => loadReceiptDto(prisma, r.id, request.auth!.kind === 'DEVICE')),
    );
  });

  /**
   * Pedidos com peças ainda não recebidas — apenas o necessário para a
   * conferência (sem valores nem contatos do cliente).
   */
  app.get('/api/v1/receipts/pending', { config: { access: REGISTER } }, async (request) => {
    const device = request.auth!.kind === 'DEVICE';
    const orders = await prisma.commercialOrder.findMany({
      where: { status: { not: 'CANCELADO' }, items: { some: {} } },
      include: {
        customer: true,
        items: { orderBy: { position: 'asc' } },
        pickups: {
          where: { status: { in: [...PICKUP_RECEIVABLE] } },
          include: { items: true },
          orderBy: { scheduledDate: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return orders
      .filter((o) => o.items.some((i) => i.receivedQuantity < i.quantity))
      .map((o) => ({
        id: o.id,
        code: orderCode(o.number),
        status: o.status,
        customer: deviceSafe(toCustomerSummary(o.customer), device),
        items: o.items.map((i) => ({
          id: i.id,
          pieceType: i.pieceType,
          description: i.description,
          quantity: i.quantity,
          receivedQuantity: i.receivedQuantity,
          pending: i.quantity - i.receivedQuantity,
        })),
        pickups: o.pickups.map((p) => ({
          id: p.id,
          code: pickupCode(p.number),
          status: p.status,
          scheduledDate: p.scheduledDate?.toISOString().slice(0, 10) ?? null,
          items: p.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
        })),
      }));
  });

  app.get('/api/v1/receipts/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadReceiptDto(prisma, id, request.auth!.kind === 'DEVICE');
  });

  /**
   * Registro do recebimento físico. Proteções contra duplicidade:
   * 1. Idempotency-Key (reenvio/duplo clique devolve o mesmo recebimento);
   * 2. bloqueio das linhas do pedido + checagem do saldo pendente por peça
   *    (recebimentos simultâneos não ultrapassam a quantidade do pedido);
   * 3. restrição no banco: recebido ≤ quantidade;
   * 4. retirada já recebida não aceita novo recebimento.
   */
  app.post(
    '/api/v1/receipts',
    { config: { access: REGISTER, idempotent: true } },
    async (request, reply) => {
      const input = createReceiptSchema.parse(request.body);
      const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
      if (receivedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
        throw Errors.validation(
          [{ path: 'receivedAt', message: 'A data de recebimento não pode estar no futuro.' }],
          'A data de recebimento não pode estar no futuro.',
        );
      }
      if (input.origin === 'RETIRADA' && !input.pickupId) {
        throw Errors.validation(
          [{ path: 'pickupId', message: 'Selecione a retirada de origem.' }],
          'Selecione a retirada de origem.',
        );
      }
      const auth = request.auth!;
      const id = await prisma.$transaction(
        async (tx) =>
          (
            await registerReceipt(
              tx,
              actorFrom(request),
              { employeeId: auth.employeeId, deviceId: auth.deviceId ?? null },
              input,
            )
          ).id,
      );
      return reply
        .status(201)
        .send(await loadReceiptDto(prisma, id, request.auth!.kind === 'DEVICE'));
    },
  );
}
