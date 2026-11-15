/**
 * Fechamento mensal (contabilidade), entregas com saldo, contas a pagar por período e
 * cotações de compra para materiais que travam OS. Tudo leitura dos registros oficiais,
 * exceto as cotações (novas) — o pedido de compra continua no fluxo oficial de compras.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { orderBalances } from '../finance/revenue';
import { shopTimezone, todayIso } from '../finance/common';
import { readinessOf } from '../purchasing/common';
import { idParams } from '../presenters';
import { OFFICE_FIN, OFFICE_FIN_VIEW, OFFICE_VIEW, brl, osCodeOf } from './common';
import { zip } from './docs';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const d10 = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const KIND_LABEL: Record<string, string> = {
  NOTA_EMITIDA: 'Notas emitidas',
  NOTA_RECEBIDA: 'Notas recebidas',
  COMPROVANTE: 'Comprovantes',
  EXTRATO: 'Extratos',
  OUTRO: 'Outros documentos',
};

export async function monthClosing(prisma: FastifyInstance['ctx']['prisma'], month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const [docs, paidOrdersNoProof, payablePays, receivedPays, drafts, unreconciled] =
    await Promise.all([
      prisma.accountingDocument.findMany({ where: { month }, orderBy: { createdAt: 'asc' } }),
      prisma.paymentOrder.findMany({
        where: { status: 'PAGO', proofFileId: null, paidAt: { gte: start, lt: end } },
      }),
      prisma.payablePayment.findMany({
        where: { paidAt: { gte: start, lt: end } },
        include: { payable: true },
      }),
      prisma.customerPayment.findMany({
        where: { receivedAt: { gte: start, lt: end } },
        include: { receivable: { include: { customer: true } } },
      }),
      prisma.fiscalDocument.findMany({
        where: { status: 'RASCUNHO', createdAt: { lt: end } },
        include: { order: true },
      }),
      prisma.bankTransaction.count({
        where: { reconciledAt: null, date: { gte: start, lt: end } },
      }),
    ]);
  const payableProofs = await prisma.attachment.findMany({
    where: {
      entityType: 'FINANCE_PAYABLE',
      entityId: { in: payablePays.map((p) => p.payableId) },
      deletedAt: null,
    },
  });
  const pending = [
    ...drafts.map((d) => ({
      kind: 'NOTA',
      label: `Nota em revisão: pedido ${d.order.number} (${brl(d.amountCents)})`,
    })),
    ...payablePays
      .filter((p) => !payableProofs.some((a) => a.entityId === p.payableId))
      .map((p) => ({
        kind: 'COMPROVANTE',
        label: `Pagamento sem comprovante: ${p.payable.beneficiary} ${brl(p.amountCents)} (${d10(p.paidAt)})`,
      })),
    ...paidOrdersNoProof.map((o) => ({
      kind: 'COMPROVANTE',
      label: `Pagamento pelo banco sem comprovante: ${o.beneficiary} ${brl(o.amountCents)}`,
    })),
    ...(docs.some((d) => d.kind === 'EXTRATO')
      ? []
      : [{ kind: 'EXTRATO', label: 'Extrato bancário do mês não importado' }]),
    ...(unreconciled
      ? [{ kind: 'CONCILIACAO', label: `${unreconciled} lançamento(s) do extrato sem conciliação` }]
      : []),
  ];
  return {
    month,
    groups: Object.entries(KIND_LABEL).map(([k, label]) => ({
      kind: k,
      label,
      docs: docs
        .filter((d) => d.kind === k)
        .map((d) => ({
          id: d.id,
          title: d.title,
          url: d.fileId ? `/api/files/${d.fileId}` : null,
        })),
    })),
    totals: {
      receivedCents: receivedPays.reduce((a, p) => a + p.amountCents, 0),
      paidCents: payablePays.reduce((a, p) => a + p.amountCents, 0),
    },
    pending,
  };
}

export async function closingRoutes(app: FastifyInstance) {
  const { prisma, storage } = app.ctx;

  app.get(
    '/api/v1/office/accounting/:month',
    { config: { access: OFFICE_FIN_VIEW } },
    async (request) => {
      const { month } = z
        .object({ month: z.string().regex(/^\d{4}-\d{2}$/) })
        .parse(request.params);
      return monthClosing(prisma, month);
    },
  );

  /** Pacote do mês para o escritório contábil: índice CSV + arquivos guardados. */
  app.get(
    '/api/v1/office/accounting/:month/package',
    { config: { access: OFFICE_FIN_VIEW } },
    async (request, reply) => {
      const { month } = z
        .object({ month: z.string().regex(/^\d{4}-\d{2}$/) })
        .parse(request.params);
      const c = await monthClosing(prisma, month);
      const docs = await prisma.accountingDocument.findMany({ where: { month } });
      const files: { name: string; data: Buffer }[] = [];
      const index = ['tipo;titulo;arquivo'];
      for (const d of docs) {
        let name = '';
        if (d.fileId) {
          const f = await prisma.storedFile.findUnique({ where: { id: d.fileId } });
          if (f && !f.deletedAt) {
            const { stream } = await storage.read(f.storageKey);
            const chunks: Buffer[] = [];
            for await (const ch of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(ch));
            name = `${d.kind.toLowerCase()}/${f.originalName}`;
            files.push({ name, data: Buffer.concat(chunks) });
          }
        }
        index.push([d.kind, d.title.replace(/;/g, ','), name].join(';'));
      }
      index.push(
        '',
        'pendencias',
        ...c.pending.map((p) => `${p.kind};${p.label.replace(/;/g, ',')};`),
      );
      files.unshift({
        name: 'indice.csv',
        data: Buffer.from(`\uFEFF${index.join('\n')}\n`, 'utf8'),
      });
      await prisma.$transaction((tx) =>
        audit(tx, actorFrom(request), {
          action: 'office.accounting_package',
          entityType: 'accounting_month',
          entityId: null,
          summary: `Pacote contábil de ${month} baixado (${files.length - 1} arquivo(s)).`,
        }),
      );
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="cenario-contabil-${month}.zip"`)
        .send(zip(files));
    },
  );

  /** Entregas do dia com saldo a receber, paradas, fotos/comprovante e nota. */
  app.get('/api/v1/office/deliveries', { config: { access: OFFICE_VIEW } }, async (request) => {
    const q = z
      .object({ date: dateOnly.optional(), withBalance: z.coerce.boolean().default(false) })
      .parse(request.query);
    const date = q.date ?? todayIso(await shopTimezone(prisma));
    const rows = await prisma.delivery.findMany({
      where: { scheduledDate: new Date(`${date}T00:00:00Z`), status: { not: 'CANCELADA' } },
      include: {
        customer: true,
        items: {
          where: { active: true },
          include: { serviceOrderItem: { include: { serviceOrder: true } } },
        },
      },
      orderBy: [{ routeSequence: 'asc' }, { createdAt: 'asc' }],
    });
    const orderIds = [
      ...new Set(rows.flatMap((d) => d.items.map((i) => i.serviceOrderItem.serviceOrder.orderId))),
    ];
    const balances = await orderBalances(prisma, orderIds);
    const photos = await prisma.attachment.groupBy({
      by: ['entityId'],
      where: { entityType: 'DELIVERY', entityId: { in: rows.map((r) => r.id) }, deletedAt: null },
      _count: true,
    });
    const notes = await prisma.fiscalDocument.findMany({
      where: { orderId: { in: orderIds }, status: 'AUTORIZADA' },
    });
    const out = rows.map((d, i) => {
      const oids = [...new Set(d.items.map((x) => x.serviceOrderItem.serviceOrder.orderId))];
      const bal = balances.filter((b) => oids.includes(b.orderId));
      const open = bal.reduce((a, b) => a + b.openCents, 0);
      const addr = d.addressSnapshot as {
        street?: string;
        number?: string;
        district?: string;
        city?: string;
      };
      return {
        id: d.id,
        stop: d.routeSequence ?? i + 1,
        status: d.status,
        customer: d.customer.name,
        address: [addr.street, addr.number, addr.district, addr.city].filter(Boolean).join(', '),
        window: d.windowStart ? `${d.windowStart}–${d.windowEnd ?? ''}` : null,
        pieces: d.items.map(
          (x) =>
            `${osCodeOf(x.serviceOrderItem.serviceOrder.number)} ${x.serviceOrderItem.description}`,
        ),
        balanceCents: open,
        photos: photos.find((p) => p.entityId === d.id)?._count ?? 0,
        invoice:
          notes
            .filter((n) => oids.includes(n.orderId))
            .map((n) => n.number)
            .join(', ') || null,
        serviceOrderIds: [...new Set(d.items.map((x) => x.serviceOrderItem.serviceOrderId))],
      };
    });
    return { date, deliveries: q.withBalance ? out.filter((d) => d.balanceCents > 0) : out };
  });

  app.get('/api/v1/office/payables', { config: { access: OFFICE_FIN_VIEW } }, async (request) => {
    const q = z
      .object({ until: dateOnly.optional(), search: z.string().max(80).optional() })
      .parse(request.query);
    const rows = await prisma.accountPayable.findMany({
      where: {
        status: { in: ['ABERTO', 'PARCIAL'] },
        ...(q.until ? { dueDate: { lte: new Date(`${q.until}T00:00:00Z`) } } : {}),
        ...(q.search
          ? {
              OR: [
                { beneficiary: { contains: q.search, mode: 'insensitive' } },
                { description: { contains: q.search, mode: 'insensitive' } },
                { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        supplier: true,
        paymentOrders: { where: { status: { in: ['PREPARADO', 'AGUARDANDO_APP'] } } },
      },
      orderBy: { dueDate: 'asc' },
      take: 100,
    });
    return rows.map((p) => ({
      id: p.id,
      beneficiary: p.supplier?.name ?? p.beneficiary,
      description: p.description,
      amountCents: p.amountCents - p.paidCents,
      dueDate: d10(p.dueDate),
      status: p.status,
      version: p.version,
      paymentOrder: p.paymentOrders[0]
        ? {
            id: p.paymentOrders[0].id,
            status: p.paymentOrders[0].status,
            version: p.paymentOrders[0].version,
          }
        : null,
    }));
  });

  // ── Compras: necessidade da OS travada, cotações e pedido oficial ──
  app.get(
    '/api/v1/office/service-orders/:id/needs',
    { config: { access: OFFICE_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const r = await readinessOf(prisma, id);
      const reqIds = r.requirements.map((x) => x.id);
      const quotes = await prisma.purchaseQuote.findMany({
        where: { materialRequirementIds: { hasSome: reqIds } },
        include: { supplier: true },
        orderBy: { unitPriceCents: 'asc' },
      });
      return {
        state: r.state,
        lines: r.lines,
        quotes: quotes.map((q) => ({
          id: q.id,
          supplier: q.supplier.name,
          description: q.description,
          unitPriceCents: q.unitPriceCents,
          quantity: Number(q.quantity),
          totalCents: Math.round(q.unitPriceCents * Number(q.quantity)),
          leadDays: q.leadDays,
          chosen: q.chosen,
          requirementIds: q.materialRequirementIds,
        })),
        purchaseHref: reqIds.length ? `/painel/compras/novo?req=${reqIds.join(',')}` : null,
      };
    },
  );

  app.post(
    '/api/v1/office/quotes',
    {
      config: {
        access: { session: 'WEB', permissions: ['jogo.acessar', 'compras.gerenciar'] },
        idempotent: true,
      },
    },
    async (request) => {
      const b = z
        .object({
          supplierId: z.string().uuid(),
          materialRequirementIds: z.array(z.string().uuid()).min(1).max(20),
          description: z.string().trim().min(2).max(300),
          unitPriceCents: z.number().int().positive(),
          quantity: z.number().positive(),
          leadDays: z.number().int().min(0).max(180).optional(),
          notes: z.string().max(500).optional(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const q = await tx.purchaseQuote.create({ data: { ...b, createdById: actor.userId } });
        await audit(tx, actor, {
          action: 'office.quote_added',
          entityType: 'purchase_quote',
          entityId: q.id,
          summary: `Cotação: ${b.description} a ${brl(b.unitPriceCents)}/un.`,
        });
        return q;
      });
    },
  );

  /** Escolher a cotação abre o pedido de compra OFICIAL (pré-preenchido); nada é comprado aqui. */
  app.post(
    '/api/v1/office/quotes/:id/choose',
    {
      config: {
        access: { session: 'WEB', permissions: ['jogo.acessar', 'compras.gerenciar'] },
        idempotent: true,
      },
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const q = await tx.purchaseQuote.findUnique({ where: { id } });
        if (!q) throw Errors.notFound('Cotação');
        await tx.purchaseQuote.updateMany({
          where: { materialRequirementIds: { hasSome: q.materialRequirementIds } },
          data: { chosen: false },
        });
        await tx.purchaseQuote.update({ where: { id }, data: { chosen: true } });
        await audit(tx, actor, {
          action: 'office.quote_chosen',
          entityType: 'purchase_quote',
          entityId: id,
          summary: 'Cotação escolhida; pedido de compra aberto no fluxo oficial.',
        });
        return {
          href: `/painel/compras/novo?req=${q.materialRequirementIds.join(',')}&fornecedor=${q.supplierId}`,
        };
      });
    },
  );
  void OFFICE_FIN;
}
