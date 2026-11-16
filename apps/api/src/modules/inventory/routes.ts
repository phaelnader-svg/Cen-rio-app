import {
  EVENT_TYPES,
  anyPermissionAudience,
  archiveSchema,
  fabricRollCreateSchema,
  fabricRollUpdateSchema,
  inventoryAdjustSchema,
  inventoryCategoryCreateSchema,
  inventoryCategoryUpdateSchema,
  inventoryItemCreateSchema,
  inventoryItemUpdateSchema,
  removeVersionSchema,
  type FabricRollDto,
  type InventoryAdjustmentDto,
  type InventoryCategoryDto,
  type InventoryItemDto,
} from '@cenario/shared';
import { Prisma, type PrismaClient, type Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { lockRow } from '../finance/common';
import { idParams } from '../presenters';

/**
 * Reformulação, Fase 1 — estoque simples, independente da OS.
 *
 * Categorias personalizadas, materiais com quantidade e rolos de tecido com metragem. Quantidade e
 * metragem só mudam por AJUSTE manual (valor anterior, novo, quem, quando e motivo — imutável).
 * Nada aqui é movido por uma OS: marcar "na oficina" não baixa estoque e marcar "comprado" não
 * aumenta. Sem histórico, o cadastro pode ser excluído; com histórico, só arquivado.
 * Não tem relação com o estoque formal de compras (reservas, recebimentos), que continua igual.
 */
const VIEW = {
  session: 'WEB',
  anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'os.gerenciar'],
} as const;
const MANAGE = { session: 'WEB', permissions: ['estoque.gerenciar'] } as const;
const AUDIENCE = anyPermissionAudience('estoque.ver', 'estoque.gerenciar', 'os.gerenciar');

const num = (d: unknown) => Number(d ?? 0);
const canSeeCosts = (request: FastifyRequest) => request.auth!.permissions.has('financeiro.ver');

const listQuery = z.object({
  archived: z.enum(['true', 'false', 'all']).default('false'),
  categoryId: z.string().uuid().optional(),
});
const adjustmentsQuery = z
  .object({ itemId: z.string().uuid().optional(), rollId: z.string().uuid().optional() })
  .refine((q) => Boolean(q.itemId) !== Boolean(q.rollId), 'Informe o material OU o rolo.');

/** Nome repetido (índice único sem diferenciar maiúsculas) vira mensagem clara. */
async function uniqueOr<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw Errors.conflict(`${what} já existe.`);
    if (e instanceof Prisma.PrismaClientUnknownRequestError && /23505/.test(e.message))
      throw Errors.conflict(`${what} já existe.`);
    throw e;
  }
}

async function announce(tx: Tx, actor: ActorContext, kind: string, id: string) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.INVENTORY_CHANGED,
    aggregateType: kind,
    aggregateId: id,
    payload: { kind, id },
    audience: AUDIENCE,
  });
}

// ------------------------------------------------------------------ DTOs
const itemInclude = {
  category: { select: { name: true } },
  rolls: { orderBy: [{ archivedAt: 'asc' }, { code: 'asc' }] },
  _count: { select: { adjustments: true, osMaterials: true, rolls: true } },
} satisfies Prisma.InventoryItemInclude;
type ItemRow = Prisma.InventoryItemGetPayload<{ include: typeof itemInclude }>;

async function rollDtos(db: Tx | PrismaClient, rolls: ItemRow['rolls']): Promise<FabricRollDto[]> {
  const adjusted = new Set(
    (
      await db.inventoryAdjustment.findMany({
        where: { rollId: { in: rolls.map((r) => r.id) } },
        select: { rollId: true },
        distinct: ['rollId'],
      })
    ).map((a) => a.rollId),
  );
  return rolls.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    code: r.code,
    color: r.color,
    reference: r.reference,
    meters: num(r.meters),
    notes: r.notes,
    archived: r.archivedAt !== null,
    deletable: !adjusted.has(r.id),
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function itemDto(
  db: Tx | PrismaClient,
  r: ItemRow,
  withCosts: boolean,
): Promise<InventoryItemDto> {
  const rolls = await rollDtos(db, r.rolls);
  const activeRolls = rolls.filter((x) => !x.archived);
  return {
    id: r.id,
    name: r.name,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? null,
    unit: r.unit,
    quantity: num(r.quantity),
    ...(withCosts ? { referenceCostCents: r.referenceCostCents } : {}),
    location: r.location,
    notes: r.notes,
    archived: r.archivedAt !== null,
    deletable: r._count.adjustments === 0 && r._count.osMaterials === 0 && r._count.rolls === 0,
    rolls,
    rollMeters: rolls.length
      ? Math.round(activeRolls.reduce((a, x) => a + x.meters, 0) * 1000) / 1000
      : null,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function loadItem(db: Tx | PrismaClient, id: string, withCosts: boolean) {
  const r = await db.inventoryItem.findUnique({ where: { id }, include: itemInclude });
  if (!r) throw Errors.notFound('Material do estoque');
  return itemDto(db, r, withCosts);
}

async function categoryDtos(db: Tx | PrismaClient): Promise<InventoryCategoryDto[]> {
  const rows = await db.inventoryCategory.findMany({
    include: { _count: { select: { items: true, osMaterials: true } } },
    orderBy: [{ archivedAt: 'asc' }, { position: 'asc' }, { name: 'asc' }],
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    position: c.position,
    archived: c.archivedAt !== null,
    itemCount: c._count.items,
    deletable: c._count.items === 0 && c._count.osMaterials === 0,
    version: c.version,
  }));
}

function checkVersion(row: { version: number }, version: number) {
  if (row.version !== version) throw Errors.versionConflict(row.version);
}

async function assertCategory(tx: Tx, id: string | null | undefined) {
  if (!id) return;
  const c = await tx.inventoryCategory.findUnique({ where: { id } });
  if (!c) throw Errors.validation([{ path: 'categoryId', message: 'Categoria não encontrada.' }]);
  if (c.archivedAt) throw Errors.business(`A categoria "${c.name}" está arquivada.`);
}

// ------------------------------------------------------------------ rotas
export async function inventoryRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // ---------------- categorias
  app.get('/api/v1/inventory/categories', { config: { access: VIEW } }, async () =>
    categoryDtos(prisma),
  );

  app.post(
    '/api/v1/inventory/categories',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = inventoryCategoryCreateSchema.parse(request.body);
      const actor = actorFrom(request);
      await uniqueOr('Uma categoria com esse nome', () =>
        prisma.$transaction(async (tx) => {
          const c = await tx.inventoryCategory.create({
            data: { name: input.name, position: input.position ?? 0 },
          });
          await audit(tx, actor, {
            action: 'inventory.category_created',
            entityType: 'inventory_category',
            entityId: c.id,
            summary: `Categoria de estoque "${c.name}" criada.`,
          });
          await announce(tx, actor, 'inventory_category', c.id);
        }),
      );
      return reply.status(201).send(await categoryDtos(prisma));
    },
  );

  app.patch('/api/v1/inventory/categories/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = inventoryCategoryUpdateSchema.parse(request.body);
    const actor = actorFrom(request);
    await uniqueOr('Uma categoria com esse nome', () =>
      prisma.$transaction(async (tx) => {
        await lockRow(tx, 'inventory_categories', id, 'Categoria');
        const before = await tx.inventoryCategory.findUniqueOrThrow({ where: { id } });
        checkVersion(before, input.version);
        const after = await tx.inventoryCategory.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.position !== undefined ? { position: input.position } : {}),
            version: { increment: 1 },
          },
        });
        await audit(tx, actor, {
          action: 'inventory.category_updated',
          entityType: 'inventory_category',
          entityId: id,
          summary: `Categoria de estoque "${after.name}" alterada.`,
          changes: { name: { from: before.name, to: after.name } },
        });
        await announce(tx, actor, 'inventory_category', id);
      }),
    );
    return categoryDtos(prisma);
  });

  app.post(
    '/api/v1/inventory/categories/:id/archive',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = archiveSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'inventory_categories', id, 'Categoria');
        const before = await tx.inventoryCategory.findUniqueOrThrow({ where: { id } });
        if ((before.archivedAt !== null) === input.archived) return;
        checkVersion(before, input.version);
        await tx.inventoryCategory.update({
          where: { id },
          data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: input.archived ? 'inventory.category_archived' : 'inventory.category_restored',
          entityType: 'inventory_category',
          entityId: id,
          summary: `Categoria de estoque "${before.name}" ${input.archived ? 'arquivada' : 'reativada'}.`,
        });
        await announce(tx, actor, 'inventory_category', id);
      });
      return categoryDtos(prisma);
    },
  );

  /** Exclusão só sem materiais e sem uso em OS (senão, arquivar). */
  app.post(
    '/api/v1/inventory/categories/:id/delete',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = removeVersionSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'inventory_categories', id, 'Categoria');
        const before = await tx.inventoryCategory.findUniqueOrThrow({
          where: { id },
          include: { _count: { select: { items: true, osMaterials: true } } },
        });
        checkVersion(before, input.version);
        if (before._count.items || before._count.osMaterials)
          throw Errors.business(
            `A categoria "${before.name}" tem materiais ou uso em OS: arquive em vez de excluir.`,
          );
        await tx.inventoryCategory.delete({ where: { id } });
        await audit(tx, actor, {
          action: 'inventory.category_deleted',
          entityType: 'inventory_category',
          entityId: id,
          summary: `Categoria de estoque "${before.name}" excluída (sem histórico).`,
        });
        await announce(tx, actor, 'inventory_category', id);
      });
      return categoryDtos(prisma);
    },
  );

  // ---------------- materiais
  app.get('/api/v1/inventory/items', { config: { access: VIEW } }, async (request) => {
    const q = listQuery.parse(request.query);
    const rows = await prisma.inventoryItem.findMany({
      where: {
        ...(q.archived === 'all'
          ? {}
          : { archivedAt: q.archived === 'true' ? { not: null } : null }),
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      },
      include: itemInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const withCosts = canSeeCosts(request);
    return Promise.all(rows.map((r) => itemDto(prisma, r, withCosts)));
  });

  app.get('/api/v1/inventory/items/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadItem(prisma, id, canSeeCosts(request));
  });

  app.post(
    '/api/v1/inventory/items',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = inventoryItemCreateSchema.parse(request.body);
      const withCosts = canSeeCosts(request);
      if (input.referenceCostCents !== undefined && input.referenceCostCents !== null && !withCosts)
        throw Errors.forbidden('Informar custo exige acesso ao financeiro.');
      const actor = actorFrom(request);
      const id = await prisma.$transaction(async (tx) => {
        await assertCategory(tx, input.categoryId);
        const r = await tx.inventoryItem.create({
          data: {
            name: input.name,
            categoryId: input.categoryId ?? null,
            unit: input.unit,
            quantity: input.quantity ?? 0,
            referenceCostCents: input.referenceCostCents ?? null,
            location: input.location ?? null,
            notes: input.notes ?? null,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'inventory.item_created',
          entityType: 'inventory_item',
          entityId: r.id,
          summary: `Material "${r.name}" cadastrado no estoque (${num(r.quantity)} ${r.unit}).`,
        });
        await announce(tx, actor, 'inventory_item', r.id);
        return r.id;
      });
      return reply.status(201).send(await loadItem(prisma, id, withCosts));
    },
  );

  app.patch('/api/v1/inventory/items/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = inventoryItemUpdateSchema.parse(request.body);
    const withCosts = canSeeCosts(request);
    if (input.referenceCostCents !== undefined && !withCosts)
      throw Errors.forbidden('Alterar custo exige acesso ao financeiro.');
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'inventory_items', id, 'Material do estoque');
      const before = await tx.inventoryItem.findUniqueOrThrow({ where: { id } });
      checkVersion(before, input.version);
      if (input.categoryId !== undefined && input.categoryId !== before.categoryId)
        await assertCategory(tx, input.categoryId);
      const data: Record<string, unknown> = {};
      for (const k of [
        'name',
        'categoryId',
        'unit',
        'referenceCostCents',
        'location',
        'notes',
      ] as const)
        if (input[k] !== undefined) data[k] = input[k];
      const after = await tx.inventoryItem.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
      const changes = Object.fromEntries(
        Object.keys(data)
          .filter(
            (k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k],
          )
          .map((k) => [
            k,
            {
              from: (before as Record<string, unknown>)[k],
              to: (after as Record<string, unknown>)[k],
            },
          ]),
      );
      await audit(tx, actor, {
        action: 'inventory.item_updated',
        entityType: 'inventory_item',
        entityId: id,
        summary: `Material "${after.name}" do estoque alterado.`,
        changes,
      });
      await announce(tx, actor, 'inventory_item', id);
    });
    return loadItem(prisma, id, withCosts);
  });

  /** Ajuste manual da quantidade: grava anterior × novo (imutável). */
  app.post(
    '/api/v1/inventory/items/:id/adjust',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = inventoryAdjustSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'inventory_items', id, 'Material do estoque');
        const before = await tx.inventoryItem.findUniqueOrThrow({ where: { id } });
        checkVersion(before, input.version);
        if (before.archivedAt) throw Errors.business('Material arquivado: reative para ajustar.');
        if (num(before.quantity) === input.newQuantity) return;
        await tx.inventoryAdjustment.create({
          data: {
            itemId: id,
            previousQuantity: before.quantity,
            newQuantity: input.newQuantity,
            reason: input.reason ?? null,
            actorId: actor.userId,
          },
        });
        await tx.inventoryItem.update({
          where: { id },
          data: { quantity: input.newQuantity, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'inventory.item_adjusted',
          entityType: 'inventory_item',
          entityId: id,
          summary: `Estoque de "${before.name}": ${num(before.quantity)} → ${input.newQuantity} ${before.unit}${input.reason ? ` (${input.reason})` : ''}.`,
          changes: { quantity: { from: num(before.quantity), to: input.newQuantity } },
        });
        await announce(tx, actor, 'inventory_item', id);
      });
      return loadItem(prisma, id, canSeeCosts(request));
    },
  );

  app.post(
    '/api/v1/inventory/items/:id/archive',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = archiveSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'inventory_items', id, 'Material do estoque');
        const before = await tx.inventoryItem.findUniqueOrThrow({ where: { id } });
        if ((before.archivedAt !== null) === input.archived) return;
        checkVersion(before, input.version);
        await tx.inventoryItem.update({
          where: { id },
          data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: input.archived ? 'inventory.item_archived' : 'inventory.item_restored',
          entityType: 'inventory_item',
          entityId: id,
          summary: `Material "${before.name}" ${input.archived ? 'arquivado' : 'reativado'} no estoque.`,
        });
        await announce(tx, actor, 'inventory_item', id);
      });
      return loadItem(prisma, id, canSeeCosts(request));
    },
  );

  /** Exclusão só sem histórico (ajustes, rolos, uso em OS). Com histórico: arquivar. */
  app.post(
    '/api/v1/inventory/items/:id/delete',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = removeVersionSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'inventory_items', id, 'Material do estoque');
        const before = await tx.inventoryItem.findUniqueOrThrow({
          where: { id },
          include: { _count: { select: { adjustments: true, rolls: true, osMaterials: true } } },
        });
        checkVersion(before, input.version);
        if (before._count.adjustments || before._count.rolls || before._count.osMaterials)
          throw Errors.business(
            `O material "${before.name}" tem histórico (ajustes, rolos ou uso em OS): arquive em vez de excluir.`,
          );
        await tx.inventoryItem.delete({ where: { id } });
        await audit(tx, actor, {
          action: 'inventory.item_deleted',
          entityType: 'inventory_item',
          entityId: id,
          summary: `Material "${before.name}" excluído do estoque (sem histórico).`,
        });
        await announce(tx, actor, 'inventory_item', id);
      });
      return { deleted: true };
    },
  );

  // ---------------- rolos de tecido
  app.post(
    '/api/v1/inventory/items/:id/rolls',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = fabricRollCreateSchema.parse(request.body);
      const actor = actorFrom(request);
      await uniqueOr('Um rolo com essa identificação', () =>
        prisma.$transaction(async (tx) => {
          await lockRow(tx, 'inventory_items', id, 'Material do estoque');
          const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id } });
          if (item.archivedAt)
            throw Errors.business('Material arquivado: reative para incluir rolos.');
          const r = await tx.fabricRoll.create({
            data: {
              itemId: id,
              code: input.code,
              color: input.color ?? null,
              reference: input.reference ?? null,
              meters: input.meters ?? 0,
              notes: input.notes ?? null,
              createdById: actor.userId,
            },
          });
          await audit(tx, actor, {
            action: 'inventory.roll_created',
            entityType: 'fabric_roll',
            entityId: r.id,
            summary: `Rolo ${r.code} de "${item.name}" cadastrado (${num(r.meters)} m).`,
          });
          await announce(tx, actor, 'fabric_roll', r.id);
        }),
      );
      return reply.status(201).send(await loadItem(prisma, id, canSeeCosts(request)));
    },
  );

  app.patch('/api/v1/inventory/rolls/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = fabricRollUpdateSchema.parse(request.body);
    const actor = actorFrom(request);
    const itemId = await uniqueOr('Um rolo com essa identificação', () =>
      prisma.$transaction(async (tx) => {
        await lockRow(tx, 'fabric_rolls', id, 'Rolo');
        const before = await tx.fabricRoll.findUniqueOrThrow({ where: { id } });
        checkVersion(before, input.version);
        const data: Record<string, unknown> = {};
        for (const k of ['code', 'color', 'reference', 'notes'] as const)
          if (input[k] !== undefined) data[k] = input[k];
        const after = await tx.fabricRoll.update({
          where: { id },
          data: { ...data, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'inventory.roll_updated',
          entityType: 'fabric_roll',
          entityId: id,
          summary: `Rolo ${after.code} alterado.`,
          changes: Object.fromEntries(
            Object.keys(data).map((k) => [
              k,
              {
                from: (before as Record<string, unknown>)[k],
                to: (after as Record<string, unknown>)[k],
              },
            ]),
          ),
        });
        await announce(tx, actor, 'fabric_roll', id);
        return before.itemId;
      }),
    );
    return loadItem(prisma, itemId, canSeeCosts(request));
  });

  /** Ajuste manual da metragem do rolo (sem corte, lote ou consumo automático). */
  app.post(
    '/api/v1/inventory/rolls/:id/adjust',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = inventoryAdjustSchema.parse(request.body);
      const actor = actorFrom(request);
      const itemId = await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'fabric_rolls', id, 'Rolo');
        const before = await tx.fabricRoll.findUniqueOrThrow({ where: { id } });
        checkVersion(before, input.version);
        if (before.archivedAt) throw Errors.business('Rolo arquivado: reative para ajustar.');
        if (num(before.meters) === input.newQuantity) return before.itemId;
        await tx.inventoryAdjustment.create({
          data: {
            rollId: id,
            previousQuantity: before.meters,
            newQuantity: input.newQuantity,
            reason: input.reason ?? null,
            actorId: actor.userId,
          },
        });
        await tx.fabricRoll.update({
          where: { id },
          data: { meters: input.newQuantity, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'inventory.roll_adjusted',
          entityType: 'fabric_roll',
          entityId: id,
          summary: `Rolo ${before.code}: ${num(before.meters)} → ${input.newQuantity} m${input.reason ? ` (${input.reason})` : ''}.`,
          changes: { meters: { from: num(before.meters), to: input.newQuantity } },
        });
        await announce(tx, actor, 'fabric_roll', id);
        return before.itemId;
      });
      return loadItem(prisma, itemId, canSeeCosts(request));
    },
  );

  app.post(
    '/api/v1/inventory/rolls/:id/archive',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = archiveSchema.parse(request.body);
      const actor = actorFrom(request);
      const itemId = await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'fabric_rolls', id, 'Rolo');
        const before = await tx.fabricRoll.findUniqueOrThrow({ where: { id } });
        if ((before.archivedAt !== null) === input.archived) return before.itemId;
        checkVersion(before, input.version);
        await tx.fabricRoll.update({
          where: { id },
          data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: input.archived ? 'inventory.roll_archived' : 'inventory.roll_restored',
          entityType: 'fabric_roll',
          entityId: id,
          summary: `Rolo ${before.code} ${input.archived ? 'arquivado' : 'reativado'}.`,
        });
        await announce(tx, actor, 'fabric_roll', id);
        return before.itemId;
      });
      return loadItem(prisma, itemId, canSeeCosts(request));
    },
  );

  app.post(
    '/api/v1/inventory/rolls/:id/delete',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = removeVersionSchema.parse(request.body);
      const actor = actorFrom(request);
      const itemId = await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'fabric_rolls', id, 'Rolo');
        const before = await tx.fabricRoll.findUniqueOrThrow({
          where: { id },
          include: { _count: { select: { adjustments: true } } },
        });
        checkVersion(before, input.version);
        if (before._count.adjustments)
          throw Errors.business(
            `O rolo ${before.code} tem ajustes registrados: arquive em vez de excluir.`,
          );
        await tx.fabricRoll.delete({ where: { id } });
        await audit(tx, actor, {
          action: 'inventory.roll_deleted',
          entityType: 'fabric_roll',
          entityId: id,
          summary: `Rolo ${before.code} excluído (sem histórico).`,
        });
        await announce(tx, actor, 'fabric_roll', id);
        return before.itemId;
      });
      return loadItem(prisma, itemId, canSeeCosts(request));
    },
  );

  // ---------------- histórico de ajustes
  app.get('/api/v1/inventory/adjustments', { config: { access: VIEW } }, async (request) => {
    const q = adjustmentsQuery.parse(request.query);
    const rows = await prisma.inventoryAdjustment.findMany({
      where: q.itemId ? { itemId: q.itemId } : { rollId: q.rollId },
      include: { actor: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(
      (a): InventoryAdjustmentDto => ({
        id: a.id,
        itemId: a.itemId,
        rollId: a.rollId,
        previousQuantity: num(a.previousQuantity),
        newQuantity: num(a.newQuantity),
        reason: a.reason,
        actor: a.actor,
        createdAt: a.createdAt.toISOString(),
      }),
    );
  });
}
