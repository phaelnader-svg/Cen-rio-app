import {
  EVENT_TYPES,
  MATERIALS_PENDING_NOTICE,
  anyPermissionAudience,
  formatCents,
  osMaterialCreateSchema,
  osMaterialReconcileSchema,
  osMaterialReconciliationStatus,
  osMaterialRemoveSchema,
  osMaterialUpdateSchema,
  realizedOsMaterialCost,
  summarizeOsMaterials,
  type FormalCostRecordDto,
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
import {
  effectiveReconciliation,
  osFormalCostRecords,
  reconciliationSelect,
  syncOsMaterialCosts,
} from '../finance/costs';
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
/** Conciliar muda o resultado da OS: decisão do financeiro. */
const RECONCILE = {
  session: 'WEB',
  permissions: ['financeiro.ver', 'financeiro.gerenciar'],
} as const;
/** Quem vê OS recebe a atualização (sem valores no evento). */
const AUDIENCE = anyPermissionAudience('os.ver', 'os.gerenciar');

const lineParams = z.object({ id: z.string().uuid(), materialId: z.string().uuid() });
const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));

const canSeeCosts = (request: FastifyRequest) =>
  request.auth!.kind !== 'DEVICE' && request.auth!.permissions.has(FINANCE_PERMISSION);
const canReconcile = (request: FastifyRequest) =>
  canSeeCosts(request) && request.auth!.permissions.has('financeiro.gerenciar');

const include = {
  category: { select: { name: true } },
  inventoryItem: { select: { name: true } },
  updatedBy: { select: { id: true, displayName: true } },
  createdBy: { select: { id: true, displayName: true } },
  reconciledBy: { select: { id: true, displayName: true } },
  linkedPurchaseItem: reconciliationSelect.linkedPurchaseItem,
} as const;

type Row = Awaited<ReturnType<typeof loadRows>>[number];

function loadRows(db: Tx | PrismaClient, serviceOrderId: string) {
  return db.serviceOrderMaterial.findMany({
    where: { serviceOrderId, removedAt: null },
    include,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

type Costs = { formal: FormalCostRecordDto[]; hasFormal: boolean };

function reconciliationOf(r: Row, costs: Costs) {
  const effective = effectiveReconciliation(r);
  const linkedId = effective === 'VINCULADO' ? (r.linkedPurchaseItemId ?? r.linkedCostId) : null;
  return {
    status: osMaterialReconciliationStatus(
      { costCents: r.costCents, removed: false, reconciliation: effective },
      costs.hasFormal,
    ),
    linked: (linkedId && costs.formal.find((f) => f.id === linkedId)) || null,
    reconciledBy: effective ? (r.reconciledBy ?? null) : null,
    reconciledAt: effective ? (r.reconciledAt?.toISOString() ?? null) : null,
  };
}

function toDto(r: Row, costs: Costs | null): OsMaterialDto {
  const withCosts = costs !== null;
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
    ...(withCosts ? { costCents: r.costCents, reconciliation: reconciliationOf(r, costs) } : {}),
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy ?? r.createdBy ?? null,
  };
}

export async function loadOsMaterials(
  db: Tx | PrismaClient,
  serviceOrderId: string,
  withCosts: boolean,
  reconcile = false,
): Promise<OsMaterialsDto> {
  const rows = await loadRows(db, serviceOrderId);
  const summary = summarizeOsMaterials(rows);
  const formal = withCosts ? await osFormalCostRecords(db, serviceOrderId) : [];
  const costs: Costs | null = withCosts ? { formal, hasFormal: formal.length > 0 } : null;
  const materials = rows.map((r) => toDto(r, costs));
  const pending = materials.filter((m) => m.reconciliation?.status === 'PENDENTE');
  return {
    materials,
    summary,
    notice: summary.notAvailable > 0 ? MATERIALS_PENDING_NOTICE : null,
    canSeeCosts: withCosts,
    canReconcile: withCosts && reconcile,
    ...(withCosts
      ? {
          formalRecords: formal,
          pendingReconciliation: {
            lines: pending.length,
            realizedCents: pending.reduce(
              (a, m) =>
                a +
                realizedOsMaterialCost({
                  purchased: m.purchased,
                  costCents: m.costCents ?? null,
                  removed: false,
                }),
              0,
            ),
          },
        }
      : {}),
  };
}

/** Trava a OS e confere que ela aceita alterações (OS cancelada fica só para consulta). */
export async function lockServiceOrder(tx: Tx, id: string) {
  await lockRow(tx, 'service_orders', id, 'Ordem de serviço');
  const so = await tx.serviceOrder.findUniqueOrThrow({ where: { id } });
  if (so.status === 'CANCELADA') throw Errors.business('OS cancelada não pode ser alterada.');
  return so;
}

/** Categoria e material de estoque de referência: precisam existir e estar ativos. */
export async function checkReferences(
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

export async function announce(tx: Tx, actor: ActorContext, serviceOrderId: string) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.OS_MATERIALS_CHANGED,
    aggregateType: 'service_order',
    aggregateId: serviceOrderId,
    payload: { serviceOrderId },
    audience: AUDIENCE,
  });
}

/** Valores auditáveis de uma linha (o custo só entra quando informado). */
export const snapshot = (r: {
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
      return loadOsMaterials(prisma, id, canSeeCosts(request), canReconcile(request));
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
      return reply
        .status(201)
        .send(await loadOsMaterials(prisma, id, withCosts, canReconcile(request)));
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
      return loadOsMaterials(prisma, id, withCosts, canReconcile(request));
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
      return loadOsMaterials(prisma, id, canSeeCosts(request), canReconcile(request));
    },
  );

  /**
   * Conciliação explícita com o custo formal (financeiro). VINCULADO: a linha é o MESMO material de
   * um registro formal desta OS (item de compra exclusiva ativo ou lançamento formal positivo) — o
   * custo informado deixa de contar, por lançamento compensatório. DISTINTO: é outro material — o
   * custo informado continua contando. `mode: null` desfaz a decisão (volta a pendente). Nunca é
   * automática nem deduzida por valores iguais; tudo fica auditado e o livro só recebe diferenças.
   */
  app.post(
    '/api/v1/service-orders/:id/material-list/:materialId/reconcile',
    { config: { access: RECONCILE, idempotent: true } },
    async (request) => {
      const { id, materialId } = lineParams.parse(request.params);
      const input = osMaterialReconcileSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const so = await lockServiceOrder(tx, id);
        const before = await tx.serviceOrderMaterial.findFirst({
          where: { id: materialId, serviceOrderId: id },
          include: { linkedPurchaseItem: reconciliationSelect.linkedPurchaseItem },
        });
        if (!before || before.removedAt) throw Errors.notFound('Material');
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        const formal = await osFormalCostRecords(tx, id);
        let linked: FormalCostRecordDto | null = null;
        if (input.mode === 'VINCULADO') {
          const wanted = input.purchaseItemId ?? input.costId!;
          const kind = input.purchaseItemId ? 'COMPRA' : 'LANCAMENTO';
          linked = formal.find((f) => f.id === wanted && f.kind === kind) ?? null;
          if (!linked)
            throw Errors.business(
              'O registro formal escolhido não pertence a esta OS ou não está ativo (só compra exclusiva ativa ou lançamento formal de compra, estoque ou sobra).',
            );
        } else if (input.mode === 'DISTINTO' && !formal.length)
          throw Errors.business('Esta OS não tem custo formal: não há o que conciliar.');
        const same =
          before.reconciliation === input.mode &&
          before.linkedPurchaseItemId === (input.purchaseItemId ?? null) &&
          before.linkedCostId === (input.costId ?? null);
        if (same) return;
        await tx.serviceOrderMaterial.update({
          where: { id: materialId },
          data: {
            reconciliation: input.mode,
            linkedPurchaseItemId: input.purchaseItemId ?? null,
            linkedCostId: input.costId ?? null,
            reconciledById: input.mode ? actor.userId : null,
            reconciledAt: input.mode ? new Date() : null,
            updatedById: actor.userId,
            version: { increment: 1 },
          },
        });
        const what =
          input.mode === 'VINCULADO'
            ? `vinculado a ${linked!.kind === 'COMPRA' ? 'compra' : 'lançamento'} ${linked!.reference} "${linked!.description}"${linked!.amountCents === null ? '' : ` (${formatCents(linked!.amountCents)})`} — custo informado deixa de contar`
            : input.mode === 'DISTINTO'
              ? 'marcado como material distinto do custo formal — custo informado continua contando'
              : 'conciliação desfeita — volta a pendente';
        await audit(tx, actor, {
          action: 'service_order.material_list_reconciled',
          entityType: 'service_order_material',
          entityId: materialId,
          summary: `Material "${before.description}" da OS ${serviceOrderCode(so.number)}: ${what}.`,
          changes: {
            reconciliation: { from: before.reconciliation, to: input.mode },
            linkedPurchaseItemId: {
              from: before.linkedPurchaseItemId,
              to: input.purchaseItemId ?? null,
            },
            linkedCostId: { from: before.linkedCostId, to: input.costId ?? null },
            costCents: before.costCents,
          },
        });
        await syncOsMaterialCosts(tx, actor, id);
        await announce(tx, actor, id);
      });
      return loadOsMaterials(prisma, id, true, true);
    },
  );
}
