import {
  EVENT_TYPES,
  MATERIALS_PENDING_NOTICE,
  anyPermissionAudience,
  osMaterialCreateSchema,
  osMaterialRemoveSchema,
  osMaterialUpdateSchema,
  summarizeOsMaterials,
  type OsMaterialDto,
  type OsMaterialsDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { syncOsMaterialCosts } from '../finance/costs';
import { lockRow } from '../finance/common';
import { idParams } from '../presenters';

/**
 * Reformulação, Fase 1 — materiais necessários da OS (lista simples).
 *
 * O gestor lista o que a OS precisa e marca, de forma independente, "comprado" e "na oficina".
 * Nada aqui cria compra formal, reserva, movimento de estoque, conta a pagar ou pagamento, e nada
 * aqui trava a produção (a disponibilidade é só informação de planejamento). O custo é opcional e
 * só aparece para quem vê o financeiro; o realizado vai ao livro de custos (ver finance/costs.ts).
 */
const VIEW = { session: 'any', permissions: ['os.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['os.gerenciar'] } as const;
const FINANCE_PERMISSION = 'financeiro.ver' as const;
/** Quem vê OS recebe a atualização (sem valores no evento). */
const AUDIENCE = anyPermissionAudience('os.ver', 'os.gerenciar');

const lineParams = z.object({ id: z.string().uuid(), materialId: z.string().uuid() });
const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));

const canSeeCosts = (request: FastifyRequest) =>
  request.auth!.kind !== 'DEVICE' && request.auth!.permissions.has(FINANCE_PERMISSION);

const include = {
  category: { select: { name: true } },
  inventoryItem: { select: { name: true } },
  updatedBy: { select: { id: true, displayName: true } },
  createdBy: { select: { id: true, displayName: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadRows>>[number];

function loadRows(db: Tx | PrismaClient, serviceOrderId: string) {
  return db.serviceOrderMaterial.findMany({
    where: { serviceOrderId, removedAt: null },
    include,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

function toDto(r: Row, withCosts: boolean): OsMaterialDto {
  return {
    id: r.id,
    serviceOrderId: r.serviceOrderId,
    description: r.description,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? null,
    inventoryItemId: r.inventoryItemId,
    inventoryItemName: r.inventoryItem?.name ?? null,
    quantity: num(r.quantity),
    unit: r.unit,
    notes: r.notes,
    purchased: r.purchased,
    available: r.available,
    ...(withCosts ? { costCents: r.costCents } : {}),
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy ?? r.createdBy ?? null,
  };
}

export async function loadOsMaterials(
  db: Tx | PrismaClient,
  serviceOrderId: string,
  withCosts: boolean,
): Promise<OsMaterialsDto> {
  const rows = await loadRows(db, serviceOrderId);
  const summary = summarizeOsMaterials(rows);
  return {
    materials: rows.map((r) => toDto(r, withCosts)),
    summary,
    notice: summary.notAvailable > 0 ? MATERIALS_PENDING_NOTICE : null,
    canSeeCosts: withCosts,
  };
}

/** Trava a OS e confere que ela aceita alterações (OS cancelada fica só para consulta). */
async function lockServiceOrder(tx: Tx, id: string) {
  await lockRow(tx, 'service_orders', id, 'Ordem de serviço');
  const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
  if (so.status === 'CANCELADA') throw Errors.business('OS cancelada não pode ser alterada.');
  return so;
}

/** Categoria e material de estoque de referência: precisam existir e estar ativos. */
async function checkReferences(
  tx: Tx,
  input: { categoryId?: string | null; inventoryItemId?: string | null },
) {
  if (input.categoryId) {
    const c = await tx.inventoryCategory.findUnique({ where: { id: input.categoryId } });
    if (!c) throw Errors.validation([{ path: 'categoryId', message: 'Categoria não encontrada.' }]);
    if (c.archivedAt) throw Errors.business(`A categoria "${c.name}" está arquivada.`);
  }
  if (input.inventoryItemId) {
    const i = await tx.inventoryItem.findUnique({ where: { id: input.inventoryItemId } });
    if (!i)
      throw Errors.validation([
        { path: 'inventoryItemId', message: 'Material do estoque não encontrado.' },
      ]);
    if (i.archivedAt) throw Errors.business(`O material "${i.name}" do estoque está arquivado.`);
  }
}

async function announce(tx: Tx, actor: ActorContext, serviceOrderId: string) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.OS_MATERIALS_CHANGED,
    aggregateType: 'service_order',
    aggregateId: serviceOrderId,
    payload: { serviceOrderId },
    audience: AUDIENCE,
  });
}

/** Valores auditáveis de uma linha (o custo só entra quando informado). */
const snapshot = (r: {
  description: string;
  quantity: unknown;
  unit: string | null;
  purchased: boolean;
  available: boolean;
  costCents: number | null;
  notes: string | null;
  categoryId: string | null;
  inventoryItemId: string | null;
}) => ({
  description: r.description,
  quantity: num(r.quantity),
  unit: r.unit,
  purchased: r.purchased,
  available: r.available,
  costCents: r.costCents,
  notes: r.notes,
  categoryId: r.categoryId,
  inventoryItemId: r.inventoryItemId,
});

export async function osMaterialRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/service-orders/:id/material-list',
    { config: { access: VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      if (!(await prisma.serviceOrder.count({ where: { id } })))
        throw Errors.notFound('Ordem de serviço');
      return loadOsMaterials(prisma, id, canSeeCosts(request));
    },
  );

  app.post(
    '/api/v1/service-orders/:id/material-list',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = osMaterialCreateSchema.parse(request.body);
      const withCosts = canSeeCosts(request);
      if (input.costCents !== undefined && input.costCents !== null && !withCosts)
        throw Errors.forbidden('Informar custo exige acesso ao financeiro.');
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const so = await lockServiceOrder(tx, id);
        await checkReferences(tx, input);
        const m = await tx.serviceOrderMaterial.create({
          data: {
            serviceOrderId: id,
            description: input.description,
            categoryId: input.categoryId ?? null,
            inventoryItemId: input.inventoryItemId ?? null,
            quantity: input.quantity ?? null,
            unit: input.unit ?? null,
            notes: input.notes ?? null,
            purchased: input.purchased ?? false,
            available: input.available ?? false,
            costCents: input.costCents ?? null,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'service_order.material_list_added',
          entityType: 'service_order_material',
          entityId: m.id,
          summary: `Material "${m.description}" na OS ${serviceOrderCode(so.number)}.`,
          changes: { added: snapshot(m) },
        });
        await syncOsMaterialCosts(tx, actor, id);
        await announce(tx, actor, id);
      });
      return reply.status(201).send(await loadOsMaterials(prisma, id, withCosts));
    },
  );

  app.patch(
    '/api/v1/service-orders/:id/material-list/:materialId',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id, materialId } = lineParams.parse(request.params);
      const input = osMaterialUpdateSchema.parse(request.body);
      const withCosts = canSeeCosts(request);
      if (input.costCents !== undefined && !withCosts)
        throw Errors.forbidden('Alterar custo exige acesso ao financeiro.');
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const so = await lockServiceOrder(tx, id);
        const before = await tx.serviceOrderMaterial.findFirst({
          where: { id: materialId, serviceOrderId: id },
        });
        if (!before || before.removedAt) throw Errors.notFound('Material');
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        await checkReferences(tx, {
          categoryId: input.categoryId !== before.categoryId ? input.categoryId : undefined,
          inventoryItemId:
            input.inventoryItemId !== before.inventoryItemId ? input.inventoryItemId : undefined,
        });
        const data: Record<string, unknown> = {};
        for (const k of [
          'description',
          'categoryId',
          'inventoryItemId',
          'quantity',
          'unit',
          'notes',
          'purchased',
          'available',
          'costCents',
        ] as const)
          if (input[k] !== undefined) data[k] = input[k];
        const after = await tx.serviceOrderMaterial.update({
          where: { id: materialId },
          data: { ...data, updatedById: actor.userId, version: { increment: 1 } },
        });
        const a = snapshot(before);
        const b = snapshot(after);
        const changes = Object.fromEntries(
          (Object.keys(a) as (keyof typeof a)[])
            .filter((k) => a[k] !== b[k])
            .map((k) => [k, { from: a[k], to: b[k] }]),
        );
        if (Object.keys(changes).length)
          await audit(tx, actor, {
            action: 'service_order.material_list_updated',
            entityType: 'service_order_material',
            entityId: materialId,
            summary: `Material "${after.description}" atualizado na OS ${serviceOrderCode(so.number)}.`,
            changes,
          });
        await syncOsMaterialCosts(tx, actor, id);
        await announce(tx, actor, id);
      });
      return loadOsMaterials(prisma, id, withCosts);
    },
  );

  /**
   * Remove um material lançado por engano. Remoção lógica: a linha sai da lista, mas continua no
   * banco (com quem removeu e quando); um custo já realizado é estornado no livro de custos.
   */
  app.post(
    '/api/v1/service-orders/:id/material-list/:materialId/remove',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id, materialId } = lineParams.parse(request.params);
      const input = osMaterialRemoveSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const so = await lockServiceOrder(tx, id);
        const before = await tx.serviceOrderMaterial.findFirst({
          where: { id: materialId, serviceOrderId: id },
        });
        if (!before) throw Errors.notFound('Material');
        if (before.removedAt) return; // repetição: já removido
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        await tx.serviceOrderMaterial.update({
          where: { id: materialId },
          data: { removedAt: new Date(), removedById: actor.userId, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'service_order.material_list_removed',
          entityType: 'service_order_material',
          entityId: materialId,
          summary: `Material "${before.description}" removido da OS ${serviceOrderCode(so.number)}.`,
          changes: { removed: snapshot(before) },
        });
        await syncOsMaterialCosts(tx, actor, id);
        await announce(tx, actor, id);
      });
      return loadOsMaterials(prisma, id, canSeeCosts(request));
    },
  );
}
