/**
 * Etapa 3 da lista de 53 (2026-11-27):
 * - Item 22: "Como ficou?" depois da entrega. O cliente recebe um link (WhatsApp) e dá de 1 a 5
 *   estrelas, com um comentário se quiser. Nota baixa vira alerta vermelho para o dono. As notas
 *   viram estatística na Qualidade.
 * - Item 23: a mesma página mostra os cuidados com cada tecido (texto padrão pela palavra do nome
 *   do tecido, ou o texto que a tapeçaria escreveu na Base de dados).
 */
import {
  LOW_RATING,
  careTextFor,
  careTextsSchema,
  publicReviewSchema,
  whatsappLink,
  type PublicReviewDto,
  type RatingsSummaryDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { publicLink, validPublicLink } from '../../core/public-links';
import { requireCompanyId, runAsCompany } from '../../core/tenant';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { notifyUsersWith } from './common';

const idParam = z.object({ id: z.guid() });
const PUBLIC = { public: true } as const;
const CUSTOMER: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
const LINK_VIEW = {
  session: 'any',
  anyPermissions: ['entregas.ver', 'entregas.gerenciar', 'logistica.executar'],
} as const;
const QUALITY_VIEW = {
  session: 'WEB',
  anyPermissions: ['qualidade.gerenciar', 'entregas.ver', 'financeiro.ver'],
} as const;
const CARE_EDIT = { session: 'WEB', permissions: ['orcamentos.gerenciar'] } as const;
const CARE_VIEW = {
  session: 'WEB',
  anyPermissions: ['orcamentos.ver', 'orcamentos.gerenciar'],
} as const;
const DAY_MS = 86_400_000;

const code = (n: number) => `EN-${String(n).padStart(5, '0')}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
const noStore = (reply: FastifyReply) =>
  reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow');

async function careTexts(db: Tx | PrismaClient): Promise<Record<string, string>> {
  const s = await db.quoteSettings.findFirst({ select: { careTexts: true } });
  const parsed = careTextsSchema.safeParse(s?.careTexts ?? {});
  return parsed.success ? parsed.data : {};
}

async function reviewDto(db: Tx | PrismaClient, id: string): Promise<PublicReviewDto> {
  const d = await db.delivery.findUniqueOrThrow({
    where: { id },
    include: {
      company: { select: { tradeName: true } },
      customer: { select: { name: true } },
      // Todas as peças da entrega (depois de concluída a peça deixa de estar "ativa" nela).
      items: {
        where: { status: { not: 'NAO_ENTREGUE' } },
        include: { serviceOrderItem: { select: { description: true, fabricName: true } } },
      },
    },
  });
  const qs = await db.quoteSettings.findFirst({
    select: { companyNameOverride: true, logoDataUrl: true },
  });
  const custom = await careTexts(db);
  const pieces = d.items.map((i) => ({
    description: i.serviceOrderItem.description,
    fabric: i.serviceOrderItem.fabricName?.trim() || null,
  }));
  const care = new Map<string, string>();
  for (const p of pieces) {
    const key = p.fabric ?? 'Cuidados gerais';
    if (!care.has(key)) care.set(key, careTextFor(p.fabric, custom));
  }
  if (care.size === 0) care.set('Cuidados gerais', careTextFor(null, custom));
  return {
    companyName: qs?.companyNameOverride || d.company.tradeName,
    logoDataUrl: qs?.logoDataUrl ?? null,
    customerFirstName: firstName(d.customer.name),
    deliveredOn: d.completedAt ? d.completedAt.toISOString().slice(0, 10) : null,
    pieces,
    care: [...care.entries()].map(([fabric, text]) => ({ fabric, text })),
    review:
      d.ratingStars && d.ratedAt
        ? { stars: d.ratingStars, comment: d.ratingComment, at: d.ratedAt.toISOString() }
        : null,
  };
}

export async function reviewRoutes(app: FastifyInstance) {
  const { prisma, system, hashToken, env } = app.ctx;

  async function deliveryCompany(id: string, t: string | undefined) {
    if (!validPublicLink(hashToken, 'avaliar', id, t)) throw Errors.notFound('Entrega');
    const d = await system.delivery.findUnique({
      where: { id },
      select: { companyId: true, status: true },
    });
    if (!d || d.status !== 'CONCLUIDA') throw Errors.notFound('Entrega');
    return d.companyId;
  }

  // ---------------- página do cliente
  app.get('/api/public/avaliar/:id', { config: { access: PUBLIC } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { t } = z.object({ t: z.string().max(64).optional() }).parse(request.query);
    const companyId = await deliveryCompany(id, t);
    noStore(reply);
    return runAsCompany(companyId, () => reviewDto(prisma, id));
  });

  app.post('/api/public/avaliar/:id', { config: { access: PUBLIC } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = publicReviewSchema
      .extend({ t: z.string().max(64) })
      .strict()
      .parse(request.body ?? {});
    const companyId = await deliveryCompany(id, body.t);
    noStore(reply);
    return runAsCompany(companyId, () =>
      prisma.$transaction(async (tx) => {
        // Robô (campo-isca preenchido): responde como se tivesse gravado, sem gravar.
        if (body.website) return reviewDto(tx, id);
        const cur = await tx.delivery.findUniqueOrThrow({
          where: { id },
          select: { ratedAt: true, number: true, customer: { select: { name: true } } },
        });
        // Uma resposta só: o link continua abrindo e mostra o que o cliente já respondeu.
        if (cur.ratedAt) return reviewDto(tx, id);
        const comment = body.comment?.trim() || null;
        await tx.delivery.update({
          where: { id },
          data: { ratingStars: body.stars, ratingComment: comment, ratedAt: new Date() },
        });
        await audit(tx, CUSTOMER, {
          action: 'delivery.rated',
          entityType: 'Delivery',
          entityId: id,
          summary: `Cliente avaliou a entrega ${code(cur.number)}: ${body.stars} de 5.`,
          changes: { stars: body.stars, comment },
        });
        if (body.stars <= LOW_RATING) {
          await notifyUsersWith(
            tx,
            CUSTOMER,
            'qualidade.gerenciar',
            'AVALIACAO_BAIXA',
            `avaliacao:${id}`,
            `${cur.customer.name} deu nota ${body.stars} de 5 para a entrega ${code(cur.number)}` +
              (comment ? `: "${comment.slice(0, 140)}"` : '.'),
          );
        }
        return reviewDto(tx, id);
      }),
    );
  });

  // ---------------- link para mandar ao cliente (tablet e escritório)
  app.get(
    '/api/v1/deliveries/:id/review-link',
    { config: { access: LINK_VIEW } },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const d = await prisma.delivery.findUnique({
        where: { id },
        select: {
          status: true,
          ratedAt: true,
          contactPhone: true,
          customer: { select: { name: true, phone: true } },
        },
      });
      if (!d) throw Errors.notFound('Entrega');
      if (d.status !== 'CONCLUIDA')
        throw Errors.business('O link de avaliação fica pronto depois que a entrega é concluída.');
      const url = publicLink(env, hashToken, 'avaliar', id);
      const text =
        `Olá, ${firstName(d.customer.name)}! Sua peça já está em casa. ` +
        `Conta pra gente: como ficou? Leva 10 segundos: ${url}\n` +
        `No link também estão os cuidados para a peça durar mais.`;
      const phone = d.contactPhone || d.customer.phone;
      return {
        url,
        text,
        whatsappUrl: phone ? whatsappLink(phone, text) : null,
        rated: d.ratedAt !== null,
      };
    },
  );

  // ---------------- resumo das notas (Qualidade)
  app.get('/api/v1/reports/ratings', { config: { access: QUALITY_VIEW } }, async (request) => {
    const q = z
      .object({ days: z.coerce.number().int().min(7).max(365).default(90) })
      .parse(request.query);
    const since = new Date(Date.now() - q.days * DAY_MS);
    const [rated, delivered] = await Promise.all([
      prisma.delivery.findMany({
        where: { ratedAt: { gte: since }, ratingStars: { not: null } },
        select: {
          id: true,
          number: true,
          ratingStars: true,
          ratingComment: true,
          ratedAt: true,
          customer: { select: { name: true } },
        },
        orderBy: { ratedAt: 'desc' },
      }),
      prisma.delivery.count({ where: { status: 'CONCLUIDA', completedAt: { gte: since } } }),
    ]);
    const byStars: RatingsSummaryDto['byStars'] = [0, 0, 0, 0, 0];
    let sum = 0;
    for (const r of rated) {
      byStars[r.ratingStars! - 1]! += 1;
      sum += r.ratingStars!;
    }
    const out: RatingsSummaryDto = {
      days: q.days,
      count: rated.length,
      average: rated.length ? Math.round((sum / rated.length) * 10) / 10 : null,
      byStars,
      delivered,
      low: rated
        .filter((r) => r.ratingStars! <= LOW_RATING)
        .slice(0, 20)
        .map((r) => ({
          deliveryId: r.id,
          code: code(r.number),
          customerName: r.customer.name,
          stars: r.ratingStars!,
          comment: r.ratingComment,
          at: r.ratedAt!.toISOString(),
        })),
    };
    return out;
  });

  // ---------------- cuidados com a peça (Base de dados do orçamento)
  app.get('/api/v1/quotes/care-texts', { config: { access: CARE_VIEW } }, async () => {
    const custom = await careTexts(prisma);
    const fabrics = await prisma.serviceOrderItem.findMany({
      where: { fabricName: { not: null } },
      select: { fabricName: true },
      distinct: ['fabricName'],
      orderBy: { fabricName: 'asc' },
      take: 200,
    });
    const names = new Set<string>(Object.keys(custom));
    for (const f of fabrics) if (f.fabricName?.trim()) names.add(f.fabricName.trim());
    return {
      items: [...names]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((fabric) => ({
          fabric,
          text: careTextFor(fabric, custom),
          custom: Boolean(custom[fabric]?.trim()),
        })),
    };
  });

  app.put('/api/v1/quotes/care-texts', { config: { access: CARE_EDIT } }, async (request) => {
    const input = z.object({ texts: careTextsSchema }).strict().parse(request.body);
    const clean = Object.fromEntries(
      Object.entries(input.texts).filter(([, v]) => v.trim().length > 0),
    );
    await prisma.$transaction(async (tx) => {
      await tx.quoteSettings.upsert({
        where: { companyId: requireCompanyId() },
        create: { careTexts: clean },
        update: { careTexts: clean },
      });
      await audit(tx, actorFrom(request), {
        action: 'quote_settings.care_texts',
        entityType: 'QuoteSettings',
        entityId: String(requireCompanyId()),
        summary: 'Orçamento — cuidados com os tecidos alterados.',
        changes: { tecidos: Object.keys(clean).length },
      });
    });
    return { ok: true };
  });
}
