import {
  EVENT_TYPES,
  PIECE_TYPES,
  PIECE_TYPE_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  SUGGESTED_MATERIAL_NOTE,
  addQuantity,
  anyPermissionAudience,
  effectiveChecklist,
  modelMaterialsFor,
  osMaterialSuggestApplySchema,
  selectProductionTemplate,
  serviceModelMaterialArchiveSchema,
  serviceModelMaterialCreateSchema,
  serviceModelMaterialUpdateSchema,
  serviceModelQuerySchema,
  type OsMaterialSuggestionDto,
  type OsMaterialSuggestionsDto,
  type PieceType,
  type ServiceModelDto,
  type ServiceModelMaterialDto,
  type ServiceModelOverviewDto,
  type ServiceType,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { lockRow } from '../finance/common';
import { serviceOrderCode } from '../commercial/common';
import { syncOsMaterialCosts } from '../finance/costs';
import {
  announce as announceOsMaterials,
  checkReferences,
  loadOsMaterials,
  lockServiceOrder,
  snapshot,
} from '../os-materials/routes';
import { idParams } from '../presenters';

/**
 * Reformulação, Fase 2 — modelos de serviço (tipo de peça × tipo de serviço).
 *
 * Etapas e checklist NÃO são duplicados: são lidos dos modelos de produção e de qualidade que já
 * existem, pelas MESMAS regras usadas no planejamento e na inspeção, e cada parte só aparece para
 * quem já podia vê-la (etapas: producao.ver/planejar; checklist: qualidade.gerenciar). A lista padrão
 * de materiais é a única configuração nova.
 *
 * A sugestão na OS só cria linhas da lista simples SEM custo, NÃO compradas e NÃO disponíveis, com
 * auditoria. Não cria compra, despesa, custo realizado, reserva nem movimento de estoque.
 */
const PLAN = 'producao.planejar';
const QUALITY = 'qualidade.gerenciar';
const OS_MANAGE = 'os.gerenciar';
const VIEW = {
  session: 'WEB',
  anyPermissions: [PLAN, 'producao.ver', QUALITY, OS_MANAGE],
} as const;
const MANAGE = { session: 'WEB', anyPermissions: [PLAN, OS_MANAGE] } as const;
/** Sugerir/aplicar na OS: quem já pode lançar materiais na lista simples. */
const OS_APPLY = { session: 'WEB', permissions: [OS_MANAGE] } as const;
const AUDIENCE = anyPermissionAudience(PLAN, QUALITY, OS_MANAGE);

const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));
const comboLabel = (p: string, s: string | null) =>
  `${PIECE_TYPE_LABEL[p as PieceType]} · ${s ? SERVICE_TYPE_LABEL[s as ServiceType] : 'qualquer serviço'}`;

const include = {
  category: { select: { name: true } },
  inventoryItem: { select: { name: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadMaterials>>[number];

function loadMaterials(db: Tx | PrismaClient, where: { pieceType?: PieceType } = {}) {
  return db.serviceModelMaterial.findMany({
    where: { archivedAt: null, ...where },
    include,
    orderBy: [{ pieceType: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
}

function toDto(r: Row): ServiceModelMaterialDto {
  return {
    id: r.id,
    pieceType: r.pieceType,
    serviceType: r.serviceType,
    description: r.description,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? null,
    inventoryItemId: r.inventoryItemId,
    inventoryItemName: r.inventoryItem?.name ?? null,
    quantity: num(r.quantity),
    unit: r.unit,
    notes: r.notes,
    position: r.position,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const can = (request: FastifyRequest) => ({
  // Etapas: as mesmas permissões da tela de modelos de produção (ver ou planejar).
  production: request.auth!.permissions.has(PLAN) || request.auth!.permissions.has('producao.ver'),
  quality: request.auth!.permissions.has(QUALITY),
  materials: request.auth!.permissions.has(PLAN) || request.auth!.permissions.has(OS_MANAGE),
});

async function activeTemplates(db: Tx | PrismaClient) {
  const [production, quality] = await Promise.all([
    db.productionTemplate.findMany({
      where: { active: true },
      include: { steps: { orderBy: { position: 'asc' } } },
      // Mesma ordem do planejamento (desempate pelo mais antigo).
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.qualityTemplate.findMany({
      where: { active: true },
      include: { items: { orderBy: { position: 'asc' } } },
      // Mesma ordem da inspeção (primeiro por nome).
      orderBy: { name: 'asc' },
    }),
  ]);
  return { production, quality };
}

type Templates = Awaited<ReturnType<typeof activeTemplates>>;

const qualityFor = (t: Templates, pieceType: PieceType) =>
  t.quality.find((q) => q.pieceTypes.includes(pieceType)) ?? null;

const snap = (r: {
  pieceType: string;
  serviceType: string | null;
  description: string;
  quantity: unknown;
  unit: string | null;
  notes: string | null;
  categoryId: string | null;
  inventoryItemId: string | null;
  position: number;
}) => ({
  pieceType: r.pieceType,
  serviceType: r.serviceType,
  description: r.description,
  quantity: num(r.quantity),
  unit: r.unit,
  notes: r.notes,
  categoryId: r.categoryId,
  inventoryItemId: r.inventoryItemId,
  position: r.position,
});

async function announce(tx: Tx, actor: ActorContext, pieceType: PieceType) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.SERVICE_MODELS_CHANGED,
    aggregateType: 'service_model',
    aggregateId: pieceType,
    payload: { pieceType },
    audience: AUDIENCE,
  });
}

/** Peças ativas da OS com os materiais padrão de cada uma, somados por material. */
async function suggestionsFor(
  db: Tx | PrismaClient,
  serviceOrderId: string,
): Promise<OsMaterialSuggestionsDto> {
  const [items, materials, existing] = await Promise.all([
    db.serviceOrderItem.findMany({
      where: { serviceOrderId },
      select: { pieceType: true, serviceType: true, quantity: true },
      orderBy: { position: 'asc' },
    }),
    loadMaterials(db),
    db.serviceOrderMaterial.findMany({
      where: { serviceOrderId, removedAt: null, sourceModelMaterialId: { not: null } },
      select: { sourceModelMaterialId: true },
    }),
  ]);
  const added = new Set(existing.map((e) => e.sourceModelMaterialId));
  const byId = new Map<string, OsMaterialSuggestionDto>();
  const withoutModel = new Set<string>();
  for (const item of items) {
    const fits = modelMaterialsFor(materials, item);
    const label = `${comboLabel(item.pieceType, item.serviceType)}${item.quantity > 1 ? ` (${item.quantity})` : ''}`;
    if (!fits.length) withoutModel.add(comboLabel(item.pieceType, item.serviceType));
    for (const m of fits) {
      const qty =
        m.quantity === null ? null : Math.round(Number(m.quantity) * item.quantity * 1000) / 1000;
      const cur = byId.get(m.id);
      if (cur) {
        cur.quantity = addQuantity(cur.quantity, qty);
        if (!cur.sources.includes(label)) cur.sources.push(label);
      } else
        byId.set(m.id, {
          modelMaterialId: m.id,
          description: m.description,
          quantity: qty,
          unit: m.unit,
          categoryName: m.category?.name ?? null,
          inventoryItemName: m.inventoryItem?.name ?? null,
          sources: [label],
          alreadyAdded: added.has(m.id),
        });
    }
  }
  return { suggestions: [...byId.values()], withoutModel: [...withoutModel] };
}

export async function serviceModelRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Visão geral: uma linha por peça × serviço, com o que vale hoje. */
  app.get('/api/v1/service-models', { config: { access: VIEW } }, async (request) => {
    const c = can(request);
    const [t, materials] = await Promise.all([activeTemplates(prisma), loadMaterials(prisma)]);
    const rows: ServiceModelOverviewDto['rows'] = [];
    for (const pieceType of PIECE_TYPES)
      for (const serviceType of SERVICE_TYPES) {
        const p = selectProductionTemplate(t.production, { pieceType, serviceType });
        const q = qualityFor(t, pieceType);
        rows.push({
          pieceType,
          serviceType,
          ...(c.production
            ? {
                productionTemplate: p
                  ? { id: p.id, name: p.name, general: p.serviceTypes.length === 0 }
                  : null,
              }
            : {}),
          ...(c.quality
            ? {
                qualityTemplate: q
                  ? {
                      id: q.id,
                      name: q.name,
                      items: effectiveChecklist(q, serviceType).length,
                    }
                  : null,
              }
            : {}),
          materials: modelMaterialsFor(materials, { pieceType, serviceType }).length,
        });
      }
    return { rows, can: c } satisfies ServiceModelOverviewDto;
  });

  /** Detalhe de uma combinação: etapas, checklist e materiais que valem para ela. */
  app.get('/api/v1/service-models/detail', { config: { access: VIEW } }, async (request) => {
    const { pieceType, serviceType } = serviceModelQuerySchema.parse(request.query);
    const c = can(request);
    const [t, materials] = await Promise.all([
      activeTemplates(prisma),
      loadMaterials(prisma, { pieceType }),
    ]);
    const p = selectProductionTemplate(t.production, { pieceType, serviceType });
    const q = qualityFor(t, pieceType);
    const dto: ServiceModelDto = {
      pieceType,
      serviceType,
      ...(c.production
        ? {
            production: {
              template: p ? { id: p.id, name: p.name, general: p.serviceTypes.length === 0 } : null,
              steps: (p?.steps ?? []).map((s) => ({
                position: s.position,
                name: s.name,
                optional: s.optional,
              })),
            },
          }
        : {}),
      ...(c.quality
        ? {
            quality: {
              template: q ? { id: q.id, name: q.name } : null,
              items: effectiveChecklist(q, serviceType),
            },
          }
        : {}),
      materials: modelMaterialsFor(materials, { pieceType, serviceType }).map(toDto),
    };
    return dto;
  });

  /** Materiais padrão de um tipo de peça (todos os serviços), para edição. */
  app.get('/api/v1/service-models/materials', { config: { access: VIEW } }, async (request) => {
    const { pieceType } = serviceModelQuerySchema.pick({ pieceType: true }).parse(request.query);
    return (await loadMaterials(prisma, { pieceType })).map(toDto);
  });

  app.post(
    '/api/v1/service-models/materials',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = serviceModelMaterialCreateSchema.parse(request.body);
      const actor = actorFrom(request);
      const created = await prisma.$transaction(async (tx) => {
        await checkReferences(tx, input);
        const position =
          input.position ??
          (await tx.serviceModelMaterial.count({
            where: { pieceType: input.pieceType, archivedAt: null },
          }));
        const m = await tx.serviceModelMaterial.create({
          data: {
            pieceType: input.pieceType,
            serviceType: input.serviceType,
            description: input.description,
            categoryId: input.categoryId ?? null,
            inventoryItemId: input.inventoryItemId ?? null,
            quantity: input.quantity ?? null,
            unit: input.unit ?? null,
            notes: input.notes ?? null,
            position,
            createdById: actor.userId,
          },
          include,
        });
        await audit(tx, actor, {
          action: 'service_model.material_added',
          entityType: 'service_model_material',
          entityId: m.id,
          summary: `Material padrão "${m.description}" em ${comboLabel(m.pieceType, m.serviceType)}.`,
          changes: { added: snap(m) },
        });
        await announce(tx, actor, m.pieceType);
        return m;
      });
      return reply.status(201).send(toDto(created));
    },
  );

  app.patch(
    '/api/v1/service-models/materials/:id',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = serviceModelMaterialUpdateSchema.parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        await lockRow(tx, 'service_model_materials', id, 'Material padrão');
        const before = await tx.serviceModelMaterial.findUnique({ where: { id } });
        if (!before || before.archivedAt) throw Errors.notFound('Material padrão');
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        await checkReferences(tx, {
          categoryId: input.categoryId !== before.categoryId ? input.categoryId : undefined,
          inventoryItemId:
            input.inventoryItemId !== before.inventoryItemId ? input.inventoryItemId : undefined,
        });
        const data: Record<string, unknown> = {};
        for (const k of [
          'serviceType',
          'description',
          'categoryId',
          'inventoryItemId',
          'quantity',
          'unit',
          'notes',
          'position',
        ] as const)
          if (input[k] !== undefined) data[k] = input[k];
        const after = await tx.serviceModelMaterial.update({
          where: { id },
          data: { ...data, updatedById: actor.userId, version: { increment: 1 } },
          include,
        });
        const a = snap(before);
        const b = snap(after);
        const changes = Object.fromEntries(
          (Object.keys(a) as (keyof typeof a)[])
            .filter((k) => a[k] !== b[k])
            .map((k) => [k, { from: a[k], to: b[k] }]),
        );
        if (Object.keys(changes).length)
          await audit(tx, actor, {
            action: 'service_model.material_updated',
            entityType: 'service_model_material',
            entityId: id,
            summary: `Material padrão "${after.description}" de ${comboLabel(after.pieceType, after.serviceType)} atualizado.`,
            changes,
          });
        await announce(tx, actor, after.pieceType);
        return toDto(after);
      });
    },
  );

  /**
   * Arquiva (não apaga): o material deixa de ser sugerido, mas as linhas que já vieram dele nas
   * OS continuam com a referência e o histórico.
   */
  app.post(
    '/api/v1/service-models/materials/:id/archive',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = serviceModelMaterialArchiveSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'service_model_materials', id, 'Material padrão');
        const before = await tx.serviceModelMaterial.findUnique({ where: { id } });
        if (!before) throw Errors.notFound('Material padrão');
        if (before.archivedAt) return; // repetição
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        await tx.serviceModelMaterial.update({
          where: { id },
          data: { archivedAt: new Date(), updatedById: actor.userId, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'service_model.material_archived',
          entityType: 'service_model_material',
          entityId: id,
          summary: `Material padrão "${before.description}" de ${comboLabel(before.pieceType, before.serviceType)} arquivado.`,
          changes: { archived: snap(before) },
        });
        await announce(tx, actor, before.pieceType);
      });
      return { ok: true };
    },
  );

  // ─────────────────────────── Sugestão na OS ───────────────────────────

  /** Prévia: o que o modelo sugere para as peças da OS (nada é gravado). */
  app.get(
    '/api/v1/service-orders/:id/material-suggestions',
    { config: { access: OS_APPLY } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      if (!(await prisma.serviceOrder.count({ where: { id } })))
        throw Errors.notFound('Ordem de serviço');
      return suggestionsFor(prisma, id);
    },
  );

  /**
   * Aplica os materiais escolhidos: cada um vira UMA linha da lista simples (quantidade somada
   * entre as peças), sem custo, não comprada e não disponível. Os já aplicados (e não removidos)
   * são ignorados — repetir não duplica. Sem compra, despesa, custo ou estoque.
   */
  app.post(
    '/api/v1/service-orders/:id/material-suggestions/apply',
    { config: { access: OS_APPLY, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = osMaterialSuggestApplySchema.parse(request.body);
      const actor = actorFrom(request);
      const result = await prisma.$transaction(async (tx) => {
        const so = await lockServiceOrder(tx, id);
        const { suggestions } = await suggestionsFor(tx, id);
        const wanted = new Set(input.modelMaterialIds);
        const unknown = [...wanted].filter(
          (w) => !suggestions.some((s) => s.modelMaterialId === w),
        );
        if (unknown.length)
          throw Errors.business(
            'Algum material escolhido não é sugerido para as peças desta OS (arquivado ou de outro tipo de peça/serviço). Atualize a lista e tente de novo.',
          );
        const toAdd = suggestions.filter((s) => wanted.has(s.modelMaterialId) && !s.alreadyAdded);
        const models = await tx.serviceModelMaterial.findMany({
          where: { id: { in: toAdd.map((s) => s.modelMaterialId) } },
        });
        for (const s of toAdd) {
          const m = models.find((x) => x.id === s.modelMaterialId)!;
          const note = [SUGGESTED_MATERIAL_NOTE, m.notes].filter(Boolean).join(' ').slice(0, 500);
          const line = await tx.serviceOrderMaterial.create({
            data: {
              serviceOrderId: id,
              description: m.description,
              categoryId: m.categoryId,
              inventoryItemId: m.inventoryItemId,
              quantity: s.quantity,
              unit: m.unit,
              notes: note,
              // Sugestão nunca nasce comprada, disponível ou com custo.
              purchased: false,
              available: false,
              costCents: null,
              sourceModelMaterialId: m.id,
              createdById: actor.userId,
            },
          });
          await audit(tx, actor, {
            action: 'service_order.material_list_added',
            entityType: 'service_order_material',
            entityId: line.id,
            summary: `Material "${line.description}" sugerido pelo modelo de serviço na OS ${serviceOrderCode(so.number)} (${s.sources.join('; ')}).`,
            changes: { added: snapshot(line), sourceModelMaterialId: m.id, sources: s.sources },
          });
        }
        if (toAdd.length) {
          // Linhas sem custo não lançam nada no livro; a chamada só mantém a regra única do
          // livro de custos (idempotente) e confirma que não há diferença a lançar.
          await syncOsMaterialCosts(tx, actor, id);
          await announceOsMaterials(tx, actor, id);
        }
        return { added: toAdd.length, skipped: wanted.size - toAdd.length };
      });
      const withCosts =
        request.auth!.kind !== 'DEVICE' && request.auth!.permissions.has('financeiro.ver');
      return reply.status(result.added ? 201 : 200).send({
        ...result,
        list: await loadOsMaterials(
          prisma,
          id,
          withCosts,
          withCosts && request.auth!.permissions.has('financeiro.gerenciar'),
        ),
      });
    },
  );
}
