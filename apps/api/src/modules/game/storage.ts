/**
 * Estoque dentro do mapa: o que há em cada posição (estante → prateleira), com saldo físico,
 * reservado e disponível, reservas por OS, OS aguardando o material, compras em aberto e o
 * histórico de movimentações — tudo lido do estoque oficial. Movimentações feitas pelo jogo usam
 * as rotas oficiais (/api/v1/stock-items/:id/adjust, /issue, /stock-reservations…), nunca esta.
 */
import {
  type GameMaterialSearchDto,
  type GameSlotDetailDto,
  type GameSlotMaterialDto,
  purchaseOrderCode,
  slotAddress,
  specKey,
  stockItemCode,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { requirementsWithProgress, specOf, stockSpecKey } from '../purchasing/common';
import { GAME_ACCESS, num } from './common';

const STOCK_ACCESS = {
  ...GAME_ACCESS,
  anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'compras.ver', 'compras.gerenciar'],
} as const;
const OPEN_PO = ['RASCUNHO', 'CONFIRMADO', 'PARCIALMENTE_RECEBIDO'] as const;

export async function gameStorageRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  async function materialDetail(
    stockItemId: string,
    address: string,
  ): Promise<GameSlotMaterialDto | null> {
    const it = await prisma.stockItem.findUnique({ where: { id: stockItemId } });
    if (!it) return null;
    const [reservations, poItems, movements] = await Promise.all([
      prisma.stockReservation.findMany({
        where: { stockItemId, status: 'ATIVA' },
        include: { serviceOrder: { select: { number: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.purchaseOrderItem.findMany({
        where: { stockItemId, purchaseOrder: { status: { in: [...OPEN_PO] } } },
        include: { purchaseOrder: true },
        orderBy: { purchaseOrder: { number: 'asc' } },
      }),
      prisma.stockMovement.findMany({
        where: { stockItemId },
        include: {
          serviceOrder: { select: { number: true } },
          actor: { select: { displayName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ]);
    // OS aguardando: necessidades ativas de estoque (mesma especificação) ainda não cobertas.
    const key = stockSpecKey(specOf(it, it.unit));
    const reqs = await requirementsWithProgress(prisma, {
      status: 'ATIVA',
      sourcing: 'ESTOQUE',
      kind: it.kind,
      serviceOrder: { status: 'ABERTA' },
    });
    const waiting = reqs
      .filter(
        ({ r }) =>
          r.unitCode && specKey({ ...specOf(r, r.unitCode), color: null, reference: null }) === key,
      )
      .map(({ r, p }) => ({
        serviceOrderId: r.serviceOrderId!,
        requirementId: r.id,
        osNumber: (r as unknown as { serviceOrder?: { number: number } }).serviceOrder?.number,
        missing: Math.max(0, Math.round((p.need - p.covered) * 1000) / 1000),
      }))
      .filter((w) => w.missing > 0);
    const osNumbers = new Map(
      (
        await prisma.serviceOrder.findMany({
          where: { id: { in: waiting.map((w) => w.serviceOrderId) } },
          select: { id: true, number: true },
        })
      ).map((s) => [s.id, s.number]),
    );
    return {
      stockItemId: it.id,
      code: stockItemCode(it.number),
      description: it.description,
      kind: it.kind,
      unit: it.unit,
      onHand: num(it.onHand),
      reserved: num(it.reserved),
      available: Math.round((num(it.onHand) - num(it.reserved)) * 1000) / 1000,
      minQuantity: it.minQuantity === null ? null : num(it.minQuantity),
      address,
      reservations: reservations.map((r) => ({
        serviceOrderId: r.serviceOrderId,
        osCode: serviceOrderCode(r.serviceOrder.number),
        quantity: num(r.quantity),
        status: r.status,
      })),
      waiting: waiting.map((w) => ({
        serviceOrderId: w.serviceOrderId,
        osCode: serviceOrderCode(osNumbers.get(w.serviceOrderId) ?? 0),
        requirementId: w.requirementId,
        missing: w.missing,
      })),
      purchases: poItems.map((p) => ({
        purchaseOrderId: p.purchaseOrderId,
        code: purchaseOrderCode(p.purchaseOrder.number),
        status: p.purchaseOrder.status,
        quantity: num(p.quantity) - num(p.closedQuantity),
        received: num(p.receivedQuantity),
        expectedDate: p.purchaseOrder.expectedDate?.toISOString().slice(0, 10) ?? null,
      })),
      movements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: num(m.quantity),
        balanceAfter: num(m.balanceAfter),
        reason: m.reason,
        osCode: m.serviceOrder ? serviceOrderCode(m.serviceOrder.number) : null,
        at: m.createdAt.toISOString(),
        actor: m.actor?.displayName ?? null,
      })),
      version: it.version,
    };
  }

  app.get(
    '/api/v1/game/slots/:id',
    { config: { access: STOCK_ACCESS } },
    async (request): Promise<GameSlotDetailDto> => {
      const { id } = idParams.parse(request.params);
      const slot = await prisma.gameStorageSlot.findUnique({
        where: { id },
        include: { materials: true, unit: { include: { area: true, space: true } } },
      });
      if (!slot || !slot.active) throw Errors.notFound('Posição de estoque');
      const address = slotAddress(
        slot.unit.space.name,
        slot.unit.area?.name ?? null,
        slot.unit.label,
        slot.label,
      );
      const materials: GameSlotMaterialDto[] = [];
      for (const m of slot.materials) {
        const d = await materialDetail(m.stockItemId, address);
        if (d) materials.push(d);
      }
      return {
        slotId: slot.id,
        address,
        unitLabel: slot.unit.label,
        slotLabel: slot.label,
        materials,
      };
    },
  );

  app.get('/api/v1/game/materials/:id', { config: { access: STOCK_ACCESS } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const where = await prisma.gameSlotMaterial.findFirst({
      where: { stockItemId: id, slot: { active: true, unit: { active: true } } },
      include: { slot: { include: { unit: { include: { area: true, space: true } } } } },
    });
    const address = where
      ? slotAddress(
          where.slot.unit.space.name,
          where.slot.unit.area?.name ?? null,
          where.slot.unit.label,
          where.slot.label,
        )
      : 'Sem posição no mapa';
    const d = await materialDetail(id, address);
    if (!d) throw Errors.notFound('Material');
    return d;
  });

  /** Pesquisa de material (tecido, espuma, ferragem) com as posições no mapa. */
  app.get(
    '/api/v1/game/materials',
    { config: { access: STOCK_ACCESS } },
    async (request): Promise<GameMaterialSearchDto[]> => {
      const q = z.object({ q: z.string().trim().max(80).default('') }).parse(request.query);
      const items = await prisma.stockItem.findMany({
        where: {
          active: true,
          ...(q.q
            ? {
                OR: [
                  { description: { contains: q.q, mode: 'insensitive' } },
                  { foamDensity: { contains: q.q, mode: 'insensitive' } },
                  { location: { contains: q.q, mode: 'insensitive' } },
                  ...(/^\d+$/.test(q.q.replace(/^MT-?/i, ''))
                    ? [{ number: Number(q.q.replace(/^MT-?/i, '')) }]
                    : []),
                ],
              }
            : {}),
        },
        orderBy: { description: 'asc' },
        take: 50,
      });
      const links = await prisma.gameSlotMaterial.findMany({
        where: {
          stockItemId: { in: items.map((i) => i.id) },
          slot: { active: true, unit: { active: true } },
        },
        include: { slot: { include: { unit: { include: { area: true, space: true } } } } },
      });
      return items.map((it) => ({
        stockItemId: it.id,
        code: stockItemCode(it.number),
        description: it.description + (it.foamDensity ? ` ${it.foamDensity}` : ''),
        kind: it.kind,
        unit: it.unit,
        available: Math.round((num(it.onHand) - num(it.reserved)) * 1000) / 1000,
        locations: links
          .filter((l) => l.stockItemId === it.id)
          .map((l) => ({
            spaceKey: l.slot.unit.space.key,
            unitId: l.slot.unitId,
            slotId: l.slotId,
            address: slotAddress(
              l.slot.unit.space.name,
              l.slot.unit.area?.name ?? null,
              l.slot.unit.label,
              l.slot.label,
            ),
          })),
        legacyLocation: it.location && !it.location.startsWith('▦ ') ? it.location : null,
      }));
    },
  );
}
