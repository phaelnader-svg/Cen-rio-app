import {
  QUOTE_CATALOG_KINDS,
  QUOTE_FOLLOW_UP_DAYS,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABEL,
  buildQuoteSnapshot,
  normalizeSearch,
  onlyDigits,
  isQuoteStatus,
  quoteStatusSchema,
  calcQuote,
  quoteBackupSchema,
  quoteCatalogCreateSchema,
  quoteCatalogUpdateSchema,
  quoteDraftSchema,
  quoteUpdateSchema,
  quoteSaveBlocker,
  quoteSettingsUpdateSchema,
  workOrderSchema,
  type QuoteBackup,
  type QuoteCatalogItemDto,
  type QuoteCatalogKind,
  type QuoteDto,
  type QuoteCustomerLookupDto,
  type QuoteDraft,
  type QuoteFunnelDto,
  type QuoteStatus,
  type QuoteMaterialCategory,
  type QuoteSettingsDto,
  type QuoteSnapshot,
  type QuoteSummaryDto,
  type QuoteWorkOrder,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import { requireCompanyId } from '../../core/tenant';
import { publicLink } from '../../core/public-links';

/**
 * Módulo Orçamentos — proposta comercial com materiais automáticos.
 *
 * Base de dados própria (preços, logística, mão de obra, taxas da máquina, tapeceiros), alíquota,
 * nome e logotipo da proposta, orçamentos salvos (cópia completa, nunca recalculada) e a O.S. do
 * orçamento. O cálculo vem de @cenario/shared: a API recalcula ao salvar, com os preços atuais,
 * em vez de confiar no total enviado pela tela.
 */
const VIEW = {
  session: 'WEB',
  anyPermissions: ['orcamentos.ver', 'orcamentos.gerenciar'],
} as const;
const MANAGE = { session: 'WEB', permissions: ['orcamentos.gerenciar'] } as const;
/** Logotipo e foto da O.S. vêm em data URL (já reduzidos pela tela). */
const LARGE_BODY = 3 * 1024 * 1024;

const KIND_ORDER = Object.fromEntries(QUOTE_CATALOG_KINDS.map((k, i) => [k, i]));

type CatalogRow = Prisma.QuoteCatalogItemGetPayload<object>;

function catalogDto(r: CatalogRow): QuoteCatalogItemDto {
  return {
    id: r.id,
    kind: r.kind as QuoteCatalogKind,
    category: (r.category as QuoteMaterialCategory | null) ?? null,
    name: r.name,
    priceCents: r.priceCents,
    unit: r.unit,
    km: r.km === null ? null : Number(r.km),
    rateBps: r.rateBps,
    phone: r.phone,
    linkedItemId: r.linkedItemId,
    position: r.position,
  };
}

async function catalogDtos(db: Tx | PrismaClient): Promise<QuoteCatalogItemDto[]> {
  const rows = await db.quoteCatalogItem.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(catalogDto).sort((a, b) => (KIND_ORDER[a.kind] ?? 0) - (KIND_ORDER[b.kind] ?? 0));
}

/** Maior número já usado (inclusive orçamentos excluídos, que continuam no histórico). */
async function quoteNumbers(db: Tx | PrismaClient) {
  const [counter, max] = await Promise.all([
    db.companyCounter.findUnique({
      where: { companyId_key: { companyId: requireCompanyId(), key: 'quotes' } },
    }),
    db.quote.aggregate({ _max: { number: true } }),
  ]);
  const used = max._max.number ?? 0;
  return { used, next: Math.max(counter?.lastValue ?? 0, used) + 1 };
}

async function settingsDto(db: Tx | PrismaClient): Promise<QuoteSettingsDto> {
  const [s, company, numbers] = await Promise.all([
    db.quoteSettings.upsert({
      where: { companyId: requireCompanyId() },
      create: {},
      update: {},
    }),
    db.companySettings.findUnique({
      where: { id: requireCompanyId() },
      select: { tradeName: true },
    }),
    quoteNumbers(db),
  ]);
  return {
    taxRateBps: s.taxRateBps,
    companyName: s.companyNameOverride || company?.tradeName || 'Empresa',
    companyNameOverride: s.companyNameOverride,
    logoDataUrl: s.logoDataUrl,
    proposalTitle: s.proposalTitle,
    proposalIntro: s.proposalIntro,
    proposalThanks: s.proposalThanks,
    nextNumber: numbers.next,
    defaultDeliveryDays: s.defaultDeliveryDays,
    version: s.version,
  };
}

const summarySelect = {
  id: true,
  number: true,
  createdAt: true,
  customerName: true,
  phone: true,
  service: true,
  totalCents: true,
  workOrder: true,
  status: true,
  statusChangedAt: true,
  followUpAt: true,
  lostReason: true,
  approvedAt: true,
  approvedVia: true,
  linkViewedAt: true,
  orderId: true,
  pickupDate: true,
  pickupShift: true,
} satisfies Prisma.QuoteSelect;

const quoteStatusOf = (v: string): QuoteStatus => (isQuoteStatus(v) ? v : 'ENVIADO');

function summaryDto(
  r: Prisma.QuoteGetPayload<{ select: typeof summarySelect }>,
  now = new Date(),
): QuoteSummaryDto {
  const status = quoteStatusOf(r.status);
  const followUpAt = status === 'ENVIADO' ? r.followUpAt : null;
  return {
    id: r.id,
    number: r.number,
    createdAt: r.createdAt.toISOString(),
    customerName: r.customerName,
    phone: r.phone,
    service: r.service,
    totalCents: r.totalCents,
    hasWorkOrder: r.workOrder !== null,
    status,
    statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
    followUpAt: followUpAt?.toISOString() ?? null,
    followUpDue: Boolean(followUpAt && followUpAt <= now),
    lostReason: r.lostReason,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedVia: r.approvedVia === 'LINK' || r.approvedVia === 'PAINEL' ? r.approvedVia : null,
    linkViewedAt: r.linkViewedAt?.toISOString() ?? null,
    orderId: r.orderId,
    pickupDate: r.pickupDate?.toISOString().slice(0, 10) ?? null,
    pickupShift: r.pickupShift === 'MANHA' || r.pickupShift === 'TARDE' ? r.pickupShift : null,
  };
}

/** Data AAAA-MM-DD → meio-dia em São Paulo (lembrete aparece no dia, sem depender do fuso). */
const followUpFromDate = (iso: string) => new Date(`${iso}T15:00:00.000Z`);
const DAY_MS = 86_400_000;

async function loadQuote(db: Tx | PrismaClient, id: string): Promise<QuoteDto> {
  const r = await db.quote.findFirst({ where: { id, deletedAt: null } });
  if (!r) throw Errors.notFound('Orçamento');
  return {
    ...summaryDto(r),
    snapshot: r.snapshot as unknown as QuoteSnapshot,
    workOrder: (r.workOrder as unknown as QuoteWorkOrder | null) ?? null,
    version: r.version,
  };
}

/** Campos que cada tipo de cadastro aceita (o resto fica vazio). */
function catalogFields(
  kind: QuoteCatalogKind,
  v: z.infer<typeof quoteCatalogUpdateSchema> & { category?: string | null },
) {
  const material = kind === 'MATERIAL';
  return {
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.priceCents !== undefined && kind !== 'TAXA_MAQUINA' && kind !== 'TAPECEIRO'
      ? { priceCents: v.priceCents }
      : {}),
    ...(v.unit !== undefined && material ? { unit: v.unit } : {}),
    ...(v.km !== undefined && kind === 'LOGISTICA' ? { km: v.km } : {}),
    ...(v.rateBps !== undefined && kind === 'TAXA_MAQUINA' ? { rateBps: v.rateBps } : {}),
    ...(v.phone !== undefined && kind === 'TAPECEIRO' ? { phone: v.phone || null } : {}),
  };
}

async function nextPosition(tx: Tx, kind: string) {
  const last = await tx.quoteCatalogItem.aggregate({ where: { kind }, _max: { position: true } });
  return (last._max.position ?? 0) + 1;
}

const KIND_LABEL: Record<QuoteCatalogKind, string> = {
  MATERIAL: 'Material',
  LOGISTICA: 'Logística',
  MAO_TAPECEIRO: 'Serviço do tapeceiro',
  MAO_AJUDANTE: 'Serviço do ajudante',
  TAXA_MAQUINA: 'Taxa da máquina',
  TAPECEIRO: 'Tapeceiro responsável',
};

/**
 * Salva um orçamento novo (status "Enviado", retorno marcado): a API recalcula com a base atual.
 * Usado pela tela e pelo agente de Orçamentos (2026-11-25), sempre com as mesmas regras.
 */
export async function saveNewQuote(tx: Tx, actor: ActorContext, draft: QuoteDraft) {
  const [catalog, settings] = await Promise.all([catalogDtos(tx), settingsDto(tx)]);
  const totals = calcQuote(draft, catalog, settings.taxRateBps);
  const blocker = quoteSaveBlocker(draft, totals);
  if (blocker) throw Errors.business(blocker);
  const snapshot = buildQuoteSnapshot(draft, catalog, settings, new Date());
  if (!snapshot.service) throw Errors.business('Informe o serviço antes de salvar.');
  const q = await tx.quote.create({
    data: {
      customerName: snapshot.customerName,
      phone: snapshot.phone || null,
      service: snapshot.service,
      totalCents: snapshot.totals.totalCents,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      createdById: actor.userId,
      status: 'ENVIADO',
      statusChangedAt: new Date(),
      followUpAt: new Date(Date.now() + QUOTE_FOLLOW_UP_DAYS * DAY_MS),
    },
  });
  await audit(tx, actor, {
    action: 'quotes.saved',
    entityType: 'quote',
    entityId: q.id,
    summary: `Orçamento nº ${q.number} salvo (${q.customerName}).`,
  });
  return { id: q.id, number: q.number, snapshot };
}

export { catalogDtos, settingsDto };

export async function quoteRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // ---------------- base de dados
  app.get('/api/v1/quotes/catalog', { config: { access: VIEW } }, async () => catalogDtos(prisma));

  app.post(
    '/api/v1/quotes/catalog',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = quoteCatalogCreateSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const item = await tx.quoteCatalogItem.create({
          data: {
            kind: input.kind,
            category: input.kind === 'MATERIAL' ? (input.category ?? null) : null,
            ...catalogFields(input.kind, input),
            name: input.name,
            unit: input.kind === 'MATERIAL' ? (input.unit ?? 'un') : null,
            position: await nextPosition(tx, input.kind),
          },
        });
        // Cada serviço do tapeceiro ganha o serviço do ajudante correspondente (preço próprio).
        if (input.kind === 'MAO_TAPECEIRO')
          await tx.quoteCatalogItem.create({
            data: {
              kind: 'MAO_AJUDANTE',
              name: item.name,
              linkedItemId: item.id,
              position: await nextPosition(tx, 'MAO_AJUDANTE'),
            },
          });
        await audit(tx, actor, {
          action: 'quotes.catalog_created',
          entityType: 'quote_catalog_item',
          entityId: item.id,
          summary: `Orçamento — ${KIND_LABEL[input.kind]} "${item.name}" cadastrado.`,
        });
      });
      return reply.status(201).send(await catalogDtos(prisma));
    },
  );

  app.patch('/api/v1/quotes/catalog/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = quoteCatalogUpdateSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const before = await tx.quoteCatalogItem.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Cadastro');
      const kind = before.kind as QuoteCatalogKind;
      const after = await tx.quoteCatalogItem.update({
        where: { id },
        data: { ...catalogFields(kind, input), version: { increment: 1 } },
      });
      // O ajudante acompanha o nome do serviço do tapeceiro (o preço continua independente).
      if (kind === 'MAO_TAPECEIRO' && after.name !== before.name)
        await tx.quoteCatalogItem.updateMany({
          where: { linkedItemId: id },
          data: { name: after.name, version: { increment: 1 } },
        });
      await audit(tx, actor, {
        action: 'quotes.catalog_updated',
        entityType: 'quote_catalog_item',
        entityId: id,
        summary: `Orçamento — ${KIND_LABEL[kind]} "${after.name}" alterado.`,
        changes: {
          name: { from: before.name, to: after.name },
          priceCents: { from: before.priceCents, to: after.priceCents },
          rateBps: { from: before.rateBps, to: after.rateBps },
        },
      });
    });
    return catalogDtos(prisma);
  });

  app.post('/api/v1/quotes/catalog/:id/delete', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const before = await tx.quoteCatalogItem.findUnique({ where: { id } });
      if (!before) return;
      // Orçamentos salvos guardam cópia dos valores: excluir o cadastro não altera nenhum deles.
      await tx.quoteCatalogItem.delete({ where: { id } });
      await audit(tx, actor, {
        action: 'quotes.catalog_deleted',
        entityType: 'quote_catalog_item',
        entityId: id,
        summary: `Orçamento — ${KIND_LABEL[before.kind as QuoteCatalogKind]} "${before.name}" excluído.`,
      });
    });
    return catalogDtos(prisma);
  });

  app.get('/api/v1/quotes/catalog/export', { config: { access: MANAGE } }, async () => {
    const [items, s] = await Promise.all([catalogDtos(prisma), settingsDto(prisma)]);
    const index = new Map(items.map((x, i) => [x.id, i]));
    const backup: QuoteBackup = {
      items: items.map((x) => ({
        kind: x.kind,
        category: x.category,
        name: x.name,
        priceCents: x.priceCents,
        unit: x.unit,
        km: x.km,
        rateBps: x.rateBps,
        phone: x.phone,
        linkedIndex: x.linkedItemId ? (index.get(x.linkedItemId) ?? null) : null,
      })),
      taxRateBps: s.taxRateBps,
    };
    return backup;
  });

  /** Substitui a base de dados inteira pelo backup (os orçamentos salvos não mudam). */
  app.post(
    '/api/v1/quotes/catalog/import',
    { config: { access: MANAGE }, bodyLimit: LARGE_BODY },
    async (request) => {
      const input = quoteBackupSchema.parse(request.body);
      for (const x of input.items) {
        if ((x.kind === 'MATERIAL') !== Boolean(x.category))
          throw Errors.business(`Cadastro "${x.name}": categoria inválida para o tipo.`);
        if (
          typeof x.linkedIndex === 'number' &&
          input.items[x.linkedIndex]?.kind !== 'MAO_TAPECEIRO'
        )
          throw Errors.business(`Cadastro "${x.name}": vínculo com o tapeceiro inválido.`);
      }
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await tx.quoteCatalogItem.updateMany({ data: { linkedItemId: null } });
        await tx.quoteCatalogItem.deleteMany({});
        const ids: string[] = [];
        const positions: Record<string, number> = {};
        for (const x of input.items) {
          positions[x.kind] = (positions[x.kind] ?? 0) + 1;
          const r = await tx.quoteCatalogItem.create({
            data: {
              kind: x.kind,
              category: x.kind === 'MATERIAL' ? x.category : null,
              ...catalogFields(x.kind, { ...x, unit: undefined }),
              name: x.name,
              unit: x.kind === 'MATERIAL' ? (x.unit ?? 'un') : null,
              position: positions[x.kind],
            },
          });
          ids.push(r.id);
        }
        for (const [i, x] of input.items.entries())
          if (typeof x.linkedIndex === 'number')
            await tx.quoteCatalogItem.update({
              where: { id: ids[i] },
              data: { linkedItemId: ids[x.linkedIndex] },
            });
        if (input.taxRateBps !== undefined)
          await tx.quoteSettings.upsert({
            where: { companyId: requireCompanyId() },
            create: { taxRateBps: input.taxRateBps },
            update: { taxRateBps: input.taxRateBps, version: { increment: 1 } },
          });
        await audit(tx, actor, {
          action: 'quotes.catalog_imported',
          entityType: 'quote_catalog_item',
          summary: `Orçamento — base de dados substituída por backup (${input.items.length} cadastros).`,
        });
      });
      return catalogDtos(prisma);
    },
  );

  // ---------------- configuração (alíquota, nome e logotipo da proposta)
  app.get('/api/v1/quotes/settings', { config: { access: VIEW } }, async () => settingsDto(prisma));

  app.patch(
    '/api/v1/quotes/settings',
    { config: { access: MANAGE }, bodyLimit: LARGE_BODY },
    async (request) => {
      const input = quoteSettingsUpdateSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const before = await tx.quoteSettings.upsert({
          where: { companyId: requireCompanyId() },
          create: {},
          update: {},
        });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        // Numeração: a empresa pode começar de onde já estava (ex.: talão de papel). Nunca abaixo
        // de um número já usado, porque o número do orçamento é único na empresa.
        let numberChange: { from: number; to: number } | undefined;
        if (input.nextNumber !== undefined) {
          const numbers = await quoteNumbers(tx);
          if (input.nextNumber !== numbers.next) {
            if (input.nextNumber <= numbers.used)
              throw Errors.business(
                `Já existe o orçamento nº ${numbers.used}. O próximo número precisa ser maior que ${numbers.used}.`,
              );
            await tx.companyCounter.upsert({
              where: { companyId_key: { companyId: requireCompanyId(), key: 'quotes' } },
              create: { key: 'quotes', lastValue: input.nextNumber - 1 },
              update: { lastValue: input.nextNumber - 1 },
            });
            numberChange = { from: numbers.next, to: input.nextNumber };
          }
        }
        await tx.quoteSettings.update({
          where: { companyId: requireCompanyId() },
          data: {
            ...(input.taxRateBps !== undefined ? { taxRateBps: input.taxRateBps } : {}),
            ...(input.companyNameOverride !== undefined
              ? { companyNameOverride: input.companyNameOverride || null }
              : {}),
            ...(input.logoDataUrl !== undefined ? { logoDataUrl: input.logoDataUrl } : {}),
            ...(input.proposalTitle !== undefined
              ? { proposalTitle: input.proposalTitle || null }
              : {}),
            ...(input.proposalIntro !== undefined
              ? { proposalIntro: input.proposalIntro || null }
              : {}),
            ...(input.proposalThanks !== undefined
              ? { proposalThanks: input.proposalThanks || null }
              : {}),
            version: { increment: 1 },
          },
        });
        await audit(tx, actor, {
          action: 'quotes.settings_updated',
          entityType: 'quote_settings',
          entityId: '1',
          summary: numberChange
            ? `Orçamento — numeração: o próximo orçamento passa a ser o nº ${numberChange.to}.`
            : 'Orçamento — configuração alterada (alíquota, nome, logotipo ou textos da proposta).',
          changes: {
            ...(numberChange ? { nextNumber: numberChange } : {}),
            ...(input.taxRateBps !== undefined
              ? { taxRateBps: { from: before.taxRateBps, to: input.taxRateBps } }
              : {}),
            ...(input.companyNameOverride !== undefined
              ? { companyName: { from: before.companyNameOverride, to: input.companyNameOverride } }
              : {}),
            ...(input.logoDataUrl !== undefined
              ? { logo: input.logoDataUrl ? 'alterado' : 'removido' }
              : {}),
            ...(input.proposalTitle !== undefined ||
            input.proposalIntro !== undefined ||
            input.proposalThanks !== undefined
              ? { textosDaProposta: 'alterados' }
              : {}),
          },
        });
      });
      return settingsDto(prisma);
    },
  );

  // ---------------- orçamentos salvos
  app.get('/api/v1/quotes', { config: { access: VIEW } }, async () => {
    const rows = await prisma.quote.findMany({
      where: { deletedAt: null },
      select: summarySelect,
      orderBy: [{ number: 'desc' }],
    });
    return rows.map((r) => summaryDto(r));
  });

  app.get('/api/v1/quotes/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return loadQuote(prisma, id);
  });

  app.post(
    '/api/v1/quotes',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const draft = quoteDraftSchema.parse(request.body);
      const actor = actorFrom(request);
      const id = await prisma.$transaction(async (tx) => (await saveNewQuote(tx, actor, draft)).id);
      return reply.status(201).send(await loadQuote(prisma, id));
    },
  );

  // Editar um orçamento salvo: mesmo número e mesmo link; a proposta é refeita com a base atual.
  app.put('/api/v1/quotes/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { version, draft } = quoteUpdateSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const q = await tx.quote.findFirst({ where: { id, deletedAt: null } });
      if (!q) throw Errors.notFound('Orçamento');
      if (q.version !== version) throw Errors.versionConflict(q.version);
      if (q.orderId)
        throw Errors.business(
          `O orçamento nº ${q.number} já virou um pedido. Altere os dados no pedido.`,
        );
      const [catalog, settings] = await Promise.all([catalogDtos(tx), settingsDto(tx)]);
      const totals = calcQuote(draft, catalog, settings.taxRateBps);
      const blocker = quoteSaveBlocker(draft, totals);
      if (blocker) throw Errors.business(blocker);
      const snapshot = buildQuoteSnapshot(draft, catalog, settings, new Date());
      if (!snapshot.service) throw Errors.business('Informe o serviço antes de salvar.');
      await tx.quote.update({
        where: { id },
        data: {
          customerName: snapshot.customerName,
          phone: snapshot.phone || null,
          service: snapshot.service,
          totalCents: snapshot.totals.totalCents,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'quotes.updated',
        entityType: 'quote',
        entityId: id,
        summary: `Orçamento nº ${q.number} alterado (${snapshot.customerName}).`,
        changes: { totalCents: { from: q.totalCents, to: snapshot.totals.totalCents } },
      });
    });
    return loadQuote(prisma, id);
  });

  app.put(
    '/api/v1/quotes/:id/work-order',
    { config: { access: MANAGE }, bodyLimit: LARGE_BODY },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ version: z.number().int().min(1), workOrder: workOrderSchema })
        .parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const q = await tx.quote.findFirst({ where: { id, deletedAt: null } });
        if (!q) throw Errors.notFound('Orçamento');
        if (q.version !== input.version) throw Errors.versionConflict(q.version);
        const responsible = await tx.quoteCatalogItem.findFirst({
          where: { id: input.workOrder.responsibleId, kind: 'TAPECEIRO' },
        });
        const previous = q.workOrder as unknown as QuoteWorkOrder | null;
        const responsibleName =
          responsible?.name ??
          (previous?.responsibleId === input.workOrder.responsibleId
            ? previous.responsibleName
            : undefined);
        if (!responsibleName)
          throw Errors.business('Selecione o tapeceiro responsável antes de salvar a OS.');
        const wo: QuoteWorkOrder = { ...input.workOrder, responsibleName };
        await tx.quote.update({
          where: { id },
          data: { workOrder: wo as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: previous ? 'quotes.work_order_updated' : 'quotes.work_order_created',
          entityType: 'quote',
          entityId: id,
          summary: `OS do orçamento nº ${q.number} ${previous ? 'alterada' : 'gerada'}.`,
        });
      });
      return loadQuote(prisma, id);
    },
  );

  /** Melhoria 77: situação do orçamento e lembrete de cobrar o cliente. */
  app.post('/api/v1/quotes/:id/status', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = quoteStatusSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const q = await tx.quote.findFirst({ where: { id, deletedAt: null } });
      if (!q) throw Errors.notFound('Orçamento');
      if (q.version !== input.version) throw Errors.versionConflict(q.version);
      const before = quoteStatusOf(q.status);
      if (before === 'APROVADO' && q.orderId && input.status !== 'APROVADO')
        throw Errors.business(
          'Este orçamento já virou pedido. Para desfazer, cancele o pedido em Pedidos comerciais.',
        );
      const changed = before !== input.status;
      const followUpAt =
        input.status !== 'ENVIADO'
          ? null
          : input.followUpDate !== undefined
            ? input.followUpDate
              ? followUpFromDate(input.followUpDate)
              : null
            : changed
              ? new Date(Date.now() + QUOTE_FOLLOW_UP_DAYS * DAY_MS)
              : q.followUpAt;
      await tx.quote.update({
        where: { id },
        data: {
          status: input.status,
          ...(changed ? { statusChangedAt: new Date() } : {}),
          followUpAt,
          lostReason: input.status === 'RECUSADO' ? (input.lostReason ?? null) : null,
          ...(input.status === 'APROVADO' && !q.approvedAt
            ? { approvedAt: new Date(), approvedVia: 'PAINEL' }
            : {}),
          ...(input.status !== 'APROVADO' ? { approvedAt: null, approvedVia: null } : {}),
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'quotes.status_changed',
        entityType: 'quote',
        entityId: id,
        summary: changed
          ? `Orçamento nº ${q.number}: ${QUOTE_STATUS_LABEL[before]} → ${QUOTE_STATUS_LABEL[input.status]}${input.status === 'RECUSADO' && input.lostReason ? ` (${input.lostReason})` : ''}.`
          : `Orçamento nº ${q.number}: lembrete alterado.`,
        changes: {
          status: { from: before, to: input.status },
          followUpAt: {
            from: q.followUpAt?.toISOString() ?? null,
            to: followUpAt?.toISOString() ?? null,
          },
        },
      });
    });
    return loadQuote(prisma, id);
  });

  /** Melhoria 79: link da proposta para o cliente abrir no celular e aprovar. */
  app.get('/api/v1/quotes/:id/link', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const q = await prisma.quote.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!q) throw Errors.notFound('Orçamento');
    return { url: publicLink(app.ctx.env, app.ctx.hashToken, 'proposta', q.id) };
  });

  /** Melhoria 81: funil de vendas do período (pela data em que o orçamento foi salvo). */
  app.get('/api/v1/quotes/funnel', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(request.query);
    const from = new Date(`${q.from}T03:00:00.000Z`);
    const to = new Date(new Date(`${q.to}T03:00:00.000Z`).getTime() + DAY_MS);
    const rows = await prisma.quote.findMany({
      where: { deletedAt: null, createdAt: { gte: from, lt: to } },
      select: { status: true, totalCents: true, lostReason: true, orderId: true, followUpAt: true },
    });
    const zero = () => ({ count: 0, cents: 0 });
    const byStatus = Object.fromEntries(
      QUOTE_STATUSES.map((s) => [s, zero()]),
    ) as QuoteFunnelDto['byStatus'];
    const total = zero();
    const converted = zero();
    const reasons = new Map<string, { count: number; cents: number }>();
    const now = new Date();
    let followUpDue = 0;
    for (const r of rows) {
      const s = quoteStatusOf(r.status);
      byStatus[s].count++;
      byStatus[s].cents += r.totalCents;
      total.count++;
      total.cents += r.totalCents;
      if (r.orderId) {
        converted.count++;
        converted.cents += r.totalCents;
      }
      if (s === 'RECUSADO' || s === 'SEM_RESPOSTA') {
        const reason =
          s === 'SEM_RESPOSTA' ? 'Sem retorno do cliente' : r.lostReason || 'Sem motivo informado';
        const cur = reasons.get(reason) ?? zero();
        cur.count++;
        cur.cents += r.totalCents;
        reasons.set(reason, cur);
      }
      if (s === 'ENVIADO' && r.followUpAt && r.followUpAt <= now) followUpDue++;
    }
    const answered =
      byStatus.APROVADO.count + byStatus.RECUSADO.count + byStatus.SEM_RESPOSTA.count;
    const funnel: QuoteFunnelDto = {
      from: q.from,
      to: q.to,
      total,
      byStatus,
      converted,
      approvalRateBps: answered ? Math.round((byStatus.APROVADO.count * 10_000) / answered) : null,
      lostReasons: [...reasons.entries()]
        .map(([reason, v]) => ({ reason, ...v }))
        .sort((a, b) => b.cents - a.cents),
      followUpDue,
    };
    return funnel;
  });

  /**
   * Revisão geral (item 5): ao digitar o nome ou o telefone no orçamento, os clientes já
   * cadastrados aparecem com o histórico (serviços, último serviço, orçamentos e quanto já fechou).
   */
  app.get('/api/v1/quotes/customer-lookup', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({ q: z.string().trim().max(100).default(''), id: z.string().uuid().optional() })
      .parse(request.query);
    const terms = normalizeSearch(q.q).split(' ').filter(Boolean);
    const digits = onlyDigits(q.q);
    // `id`: "Novo orçamento" a partir da ficha do cliente já abre preenchido.
    if (terms.length === 0 && !q.id) return [] satisfies QuoteCustomerLookupDto[];
    const rows = await prisma.customer.findMany({
      where: {
        active: true,
        ...(q.id ? { id: q.id } : {}),
        AND: terms.map((t) => ({
          OR: [
            { searchText: { contains: t } },
            ...(digits.length >= 4 && /^\d+$/.test(t)
              ? [{ searchText: { contains: digits } }]
              : []),
          ],
        })),
      },
      orderBy: { name: 'asc' },
      take: 6,
      include: {
        addresses: {
          where: { archivedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
          select: { city: true, state: true },
        },
        orders: {
          where: { status: { not: 'CANCELADO' } },
          select: { createdAt: true, agreedValueCents: true },
        },
      },
    });
    const phones = rows.map((r) => onlyDigits(r.phone ?? '')).filter((p) => p.length >= 8);
    const quotes = phones.length
      ? await prisma.quote.findMany({
          where: { deletedAt: null, phone: { not: null } },
          select: { phone: true, orderId: true },
        })
      : [];
    return rows.map((r): QuoteCustomerLookupDto => {
      const phone = onlyDigits(r.phone ?? '');
      const mine =
        phone.length >= 8 ? quotes.filter((x) => onlyDigits(x.phone ?? '') === phone) : [];
      const last = r.orders.reduce<Date | null>(
        (a, o) => (!a || o.createdAt > a ? o.createdAt : a),
        null,
      );
      return {
        id: r.id,
        name: r.name,
        phone: r.phone,
        city: r.addresses[0] ? `${r.addresses[0].city} - ${r.addresses[0].state}` : null,
        services: r.orders.length,
        lastServiceAt: last?.toISOString() ?? null,
        quotes: mine.length,
        quotesClosed: mine.filter((x) => x.orderId).length,
        spentCents: r.orders.reduce((a, o) => a + (o.agreedValueCents ?? 0), 0),
      };
    });
  });

  app.post('/api/v1/quotes/:id/delete', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const q = await tx.quote.findFirst({ where: { id, deletedAt: null } });
      if (!q) return;
      await tx.quote.update({
        where: { id },
        data: { deletedAt: new Date(), deletedById: actor.userId, version: { increment: 1 } },
      });
      await audit(tx, actor, {
        action: 'quotes.deleted',
        entityType: 'quote',
        entityId: id,
        summary: `Orçamento nº ${q.number} excluído (${q.customerName}).`,
      });
    });
    return { ok: true };
  });
}
