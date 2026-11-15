/**
 * Marketing (Instagram) e Tráfego (Meta Ads) pelo escritório do jogo.
 * - Marketing prepara posts com fotos reais das OS e legenda; publicar exige marketing.publicar.
 * - Tráfego lê campanhas e propõe mudança de orçamento (campanha, valor atual → novo, motivo);
 *   a alteração só é executada quando o gestor aprova (anuncios.gerenciar).
 */
import { EVENT_TYPES } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { connectionOf, requireConnection } from './connections';
import { campaigns, publishInstagram } from './meta';

const VIEW = { session: 'WEB', permissions: ['jogo.acessar', 'agentes.usar'] } as const;
const PUBLISH = { session: 'WEB', permissions: ['jogo.acessar', 'marketing.publicar'] } as const;
const ADS = { session: 'WEB', permissions: ['jogo.acessar', 'anuncios.gerenciar'] } as const;
const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export async function marketingRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const conn = (key: string) => connectionOf(prisma, key);
  const asConn = (c: NonNullable<Awaited<ReturnType<typeof conn>>>) => ({
    providerKey: c.providerKey,
    mode: c.mode,
    config: c.config,
    secret: c.secret as never,
  });

  app.get('/api/v1/marketing/posts', { config: { access: VIEW } }, async () =>
    (await prisma.marketingPost.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })).map(
      (p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        publishedAt: p.publishedAt?.toISOString() ?? null,
      }),
    ),
  );

  /** Agente de Marketing: rascunho de post a partir de uma OS com fotos (legenda + calendário). */
  app.post('/api/v1/marketing/draft', { config: { access: VIEW } }, async (request) => {
    const b = z
      .object({
        serviceOrderId: z.string().uuid().optional(),
        scheduledFor: z.string().datetime().optional(),
      })
      .parse(request.body ?? {});
    const photos = await prisma.attachment.findMany({
      where: {
        deletedAt: null,
        entityType: { in: ['SERVICE_ORDER', 'SERVICE_ORDER_ITEM', 'PRODUCTION_TASK', 'PACKAGING'] },
        ...(b.serviceOrderId ? { entityId: b.serviceOrderId } : {}),
        file: { mimeType: { startsWith: 'image/' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 4,
    });
    const so = b.serviceOrderId
      ? await prisma.serviceOrder.findUnique({
          where: { id: b.serviceOrderId },
          include: { items: true },
        })
      : null;
    const piece = so?.items[0]?.description ?? 'sofá';
    const caption = `Antes e depois que dá gosto de ver ✨ ${piece} renovado na oficina da Cenário Estofados, com tecido novo e espuma no ponto certo.\n\nQuer um orçamento? Mande fotos e medidas pelo WhatsApp. 📲\n\n#reformadesofa #estofados #saojosedoscampos #tapecaria #cenarioestofados`;
    const agent = await prisma.aiAgent.findFirst({
      where: { roleKey: 'MARKETING', status: 'ATIVO' },
    });
    const post = await prisma.marketingPost.create({
      data: {
        caption,
        mediaUrls: photos.map((p) => `/api/files/${p.fileId}`),
        scheduledFor: b.scheduledFor ? new Date(b.scheduledFor) : null,
        agentId: agent?.id ?? null,
      },
    });
    await prisma.agentAction.create({
      data: {
        agentId: agent?.id ?? null,
        channel: 'INSTAGRAM',
        accountLabel: (await conn('INSTAGRAM'))?.accountLabel ?? null,
        kind: 'RASCUNHO_POST',
        summary: `Post preparado${so ? ` com ${serviceOrderCode(so.number)}` : ''}`,
        content: caption,
        status: 'RASCUNHO',
        ref: { postId: post.id },
      },
    });
    return { id: post.id, caption, mediaUrls: post.mediaUrls, photos: photos.length };
  });

  app.put('/api/v1/marketing/posts/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const b = z
      .object({
        caption: z.string().trim().min(1).max(2200),
        mediaUrls: z.array(z.string().max(500)).max(10),
        scheduledFor: z.string().datetime().nullable().optional(),
      })
      .parse(request.body);
    const p = await prisma.marketingPost.findUnique({ where: { id } });
    if (!p || p.status !== 'RASCUNHO') throw Errors.business('Só rascunhos podem ser editados.');
    return prisma.marketingPost.update({
      where: { id },
      data: {
        caption: b.caption,
        mediaUrls: b.mediaUrls,
        scheduledFor: b.scheduledFor ? new Date(b.scheduledFor) : null,
      },
    });
  });

  /** Publicação aprovada pelo gestor. Fora do teste, a Meta exige imagem com endereço público HTTPS. */
  app.post(
    '/api/v1/marketing/posts/:id/publish',
    { config: { access: PUBLISH, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorFrom(request);
      const p = await prisma.marketingPost.findUnique({ where: { id } });
      if (!p || p.status !== 'RASCUNHO') throw Errors.business('Post já publicado ou inexistente.');
      const c = await requireConnection(prisma, 'INSTAGRAM');
      const image = p.mediaUrls[0];
      if (!image) throw Errors.business('Escolha ao menos uma foto.');
      const publicUrl = /^https:\/\//.test(image)
        ? image
        : `${process.env.PUBLIC_MEDIA_BASE_URL ?? ''}${image}`;
      let result: { externalId: string; test: boolean };
      try {
        result = await publishInstagram(
          asConn(c),
          c.mode === 'TESTE_LOCAL' ? image : publicUrl,
          p.caption,
        );
      } catch (e) {
        await prisma.marketingPost.update({
          where: { id },
          data: { status: 'FALHOU', error: (e as Error).message.slice(0, 480) },
        });
        throw e;
      }
      await prisma.$transaction(async (tx) => {
        await tx.marketingPost.update({
          where: { id },
          data: {
            status: result.test ? 'PUBLICADO_TESTE' : 'PUBLICADO',
            externalId: result.externalId,
            approvedById: actor.userId,
            publishedAt: new Date(),
          },
        });
        await tx.agentAction.create({
          data: {
            agentId: p.agentId,
            channel: 'INSTAGRAM',
            accountLabel: c.accountLabel,
            kind: 'PUBLICACAO',
            summary: 'Post publicado no Instagram',
            content: p.caption,
            status: result.test ? 'PUBLICADO_TESTE' : 'PUBLICADO',
            approvedById: actor.userId,
            ref: { postId: id, externalId: result.externalId },
          },
        });
        await audit(tx, actor, {
          action: 'marketing.published',
          entityType: 'marketing_post',
          entityId: id,
          summary: `Publicação no Instagram${result.test ? ' (teste)' : ''}.`,
        });
      });
      return { ok: true, test: result.test, externalId: result.externalId };
    },
  );

  app.get('/api/v1/ads/campaigns', { config: { access: VIEW } }, async () => {
    const c = await requireConnection(prisma, 'META_ADS');
    const list = await campaigns(asConn(c));
    await prisma.integrationConnection.update({
      where: { providerKey: 'META_ADS' },
      data: { lastSyncAt: new Date() },
    });
    return { account: c.accountLabel, test: c.mode === 'TESTE_LOCAL', campaigns: list };
  });

  /** Agente de Tráfego: explica o desempenho e propõe mudanças de orçamento (para aprovação). */
  app.post('/api/v1/ads/analyze', { config: { access: VIEW } }, async (request) => {
    const c = await requireConnection(prisma, 'META_ADS');
    const list = (await campaigns(asConn(c))).filter((x) => x.status === 'ACTIVE');
    const agent = await prisma.aiAgent.findFirst({
      where: { roleKey: 'TRAFEGO', status: 'ATIVO' },
    });
    if (!agent)
      throw Errors.business('Crie um agente de Tráfego no escritório para analisar as campanhas.');
    const cpl = (x: (typeof list)[number]) => (x.leads7d ? x.spendCents7d / x.leads7d : Infinity);
    const sorted = [...list].sort((a, b) => cpl(a) - cpl(b));
    const best = sorted[0];
    const worst = sorted.at(-1);
    const lines = list.map(
      (x) =>
        `• ${x.name}: gasto 7 dias ${brl(x.spendCents7d)}, ${x.clicks7d} cliques, ${x.leads7d} contatos (${x.leads7d ? `${brl(Math.round(cpl(x)))} por contato` : 'sem contatos'}).`,
    );
    const proposals = [];
    if (best && worst && best !== worst && best.dailyBudgetCents && worst.dailyBudgetCents) {
      const move = Math.min(Math.round(worst.dailyBudgetCents * 0.3), 2000);
      for (const [x, to, why] of [
        [
          best,
          best.dailyBudgetCents + move,
          `Menor custo por contato (${brl(Math.round(cpl(best)))}).`,
        ],
        [
          worst,
          worst.dailyBudgetCents - move,
          worst.leads7d
            ? `Custo por contato alto (${brl(Math.round(cpl(worst)))}).`
            : 'Sem contatos na semana.',
        ],
      ] as const)
        proposals.push(
          await prisma.aiAgentProposal.create({
            data: {
              agentId: agent.id,
              kind: 'ALTERAR_ORCAMENTO',
              title: `Orçamento diário de "${x.name}": ${brl(x.dailyBudgetCents!)} → ${brl(to)}`,
              detail: `${why} Mudança exata: daily_budget de ${x.dailyBudgetCents} para ${to} centavos na campanha ${x.id} (${c.accountLabel}).`,
              payload: {
                campaignId: x.id,
                campaignName: x.name,
                fromCents: x.dailyBudgetCents,
                toCents: to,
                account: c.accountLabel,
                test: c.mode === 'TESTE_LOCAL',
              },
              evidence: [],
            },
          }),
        );
    }
    const content = [
      `Campanhas ativas em ${c.accountLabel}:`,
      ...lines,
      proposals.length
        ? 'Proponho remanejar orçamento (veja as ações para revisão). Nada muda sem a sua aprovação.'
        : 'Sem mudança recomendada agora.',
    ].join('\n');
    await prisma.$transaction(async (tx) => {
      await tx.aiAgentMessage.create({ data: { agentId: agent.id, author: 'AGENTE', content } });
      await tx.agentAction.create({
        data: {
          agentId: agent.id,
          channel: 'META_ADS',
          accountLabel: c.accountLabel,
          kind: 'ANALISE',
          summary: 'Análise de campanhas (7 dias)',
          content,
          status: proposals.length ? 'PROPOSTO' : 'RASCUNHO',
          ref: {},
        },
      });
      await appendEvent(tx, actorFrom(request), {
        type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
        aggregateType: 'ai_agent',
        aggregateId: agent.id,
        payload: { id: agent.id },
        audience: 'permission:agentes.usar',
      });
    });
    return { content, proposals: proposals.map((p) => p.id) };
  });

  void ADS;
}
