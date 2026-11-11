import {
  OFF_WORKSHOP_STAGES,
  WORKSHOP_MAP_PERMISSIONS,
  formatServiceOrderItemCode,
  type FulfillmentStage,
  type WorkshopMapDto,
  type WorkshopMapPieceDto,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { serviceOrderCode } from '../commercial/common';

/**
 * Reformulação, Fase 2 — mapa interno da oficina (somente leitura).
 *
 * Reúne as localizações existentes e as peças das OS abertas que ainda estão na oficina. Mover
 * uma peça continua sendo a rota já existente (POST /api/v1/pieces/:id/move), com as mesmas
 * permissões e o mesmo histórico imutável de movimentações; cadastrar áreas continua em Qualidade.
 */
const VIEW = { session: 'WEB', anyPermissions: [...WORKSHOP_MAP_PERMISSIONS] } as const;
/** As mesmas da rota de movimentação (quality/routes.ts › MOVE_ACCESS). */
const MOVE = ['producao.executar', 'qualidade.gerenciar', 'entregas.gerenciar'] as const;

export async function workshopMapRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/workshop-map', { config: { access: VIEW } }, async (request) => {
    const [locations, items] = await Promise.all([
      prisma.itemLocation.findMany({ orderBy: [{ position: 'asc' }, { label: 'asc' }] }),
      prisma.serviceOrderItem.findMany({
        where: {
          serviceOrder: { status: 'ABERTA' },
          fulfillmentStage: { notIn: [...OFF_WORKSHOP_STAGES] },
        },
        include: {
          serviceOrder: { select: { number: true, customer: { select: { name: true } } } },
          orderItem: { select: { receiptLines: { select: { location: true } } } },
        },
        orderBy: [{ serviceOrder: { number: 'asc' } }, { position: 'asc' }],
      }),
    ]);
    // Última movimentação de cada peça (quem e quando), numa consulta só.
    const moves = items.length
      ? await prisma.itemLocationEvent.findMany({
          where: { serviceOrderItemId: { in: items.map((i) => i.id) } },
          orderBy: { createdAt: 'desc' },
          distinct: ['serviceOrderItemId'],
          include: { actor: { select: { displayName: true } } },
        })
      : [];
    const lastMove = new Map(moves.map((m) => [m.serviceOrderItemId, m]));
    const dto = (i: (typeof items)[number]): WorkshopMapPieceDto => {
      const m = lastMove.get(i.id);
      return {
        id: i.id,
        code: formatServiceOrderItemCode(i.serviceOrder.number, i.position),
        description: i.description,
        pieceType: i.pieceType,
        quantity: i.quantity,
        serviceOrderId: i.serviceOrderId,
        serviceOrderCode: serviceOrderCode(i.serviceOrder.number),
        customerName: i.serviceOrder.customer.name,
        stage: i.fulfillmentStage as FulfillmentStage,
        receiptLocations: [...new Set(i.orderItem.receiptLines.map((l) => l.location))],
        movedAt: m?.createdAt.toISOString() ?? null,
        movedBy: m?.actor?.displayName ?? null,
      };
    };
    const perms = request.auth!.permissions;
    return {
      // Área desativada só aparece se ainda tiver peça (para ninguém "perder" a peça de vista).
      areas: locations
        .map((l) => ({
          id: l.id,
          key: l.key,
          label: l.label,
          position: l.position,
          active: l.active,
          pieces: items.filter((i) => i.currentLocationId === l.id).map(dto),
        }))
        .filter((a) => a.active || a.pieces.length > 0),
      unplaced: items.filter((i) => !i.currentLocationId).map(dto),
      can: {
        move: MOVE.some((p) => perms.has(p)),
        manageAreas: perms.has('qualidade.gerenciar'),
      },
    } satisfies WorkshopMapDto;
  });
}
