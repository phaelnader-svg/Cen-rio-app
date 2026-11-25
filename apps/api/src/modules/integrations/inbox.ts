/**
 * Caixa de entrada (WhatsApp, Instagram Direct e Messenger) dentro do escritório do jogo.
 *
 * Entrada: webhook oficial da Meta com assinatura verificada; cada mensagem é única por canal e
 * id da plataforma (reenvios não duplicam). Saída: regras de cada canal — texto livre só dentro
 * de 24 h da última mensagem do cliente; fora disso, WhatsApp exige modelo aprovado e
 * Instagram/Messenger recusam. O agente de Atendimento prepara rascunhos; envio automático só
 * nos casos liberados pelo gestor e nunca com a conversa assumida por uma pessoa.
 */
import { companyName } from '../game/agent-office';
import { PLATFORM_COMPANY_ID, requireCompanyId, runAsCompany } from '../../core/tenant';
import { EVENT_TYPES, anyPermissionAudience } from '@cenario/shared';
import type { InboxConversation, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { registerOfficeHook } from '../game/command';
import { idParams } from '../presenters';
import { connectionOf, requireConnection } from './connections';
import {
  type InboundMessage,
  parseWebhook,
  sendPageMessage,
  sendWhatsApp,
  signBody,
  verifySignature,
  webhookSecret,
} from './meta';
import { testModeAllowed } from './registry';

const VIEW = { session: 'WEB', permissions: ['jogo.acessar', 'atendimento.ver'] } as const;
const REPLY = { session: 'WEB', permissions: ['jogo.acessar', 'atendimento.responder'] } as const;
const AUDIENCE = anyPermissionAudience('atendimento.ver');
const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
const WINDOW_MS = 24 * 3600_000;
const CHANNEL_KEY: Record<string, string> = {
  WHATSAPP: 'WHATSAPP',
  INSTAGRAM: 'INSTAGRAM',
  MESSENGER: 'MESSENGER',
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Resumo do pedido do cliente: intenção, fotos recebidas e medidas citadas/pendentes. */
export function summarize(messages: { direction: string; text: string | null; kind: string }[]) {
  const inbound = messages.filter((m) => m.direction === 'IN');
  const text = inbound.map((m) => m.text ?? '').join(' ');
  const t = norm(text);
  const photos = inbound.filter((m) => m.kind === 'IMAGE').length;
  const measures = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(cm|m)\b/gi)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  const what = /cabeceira/.test(t)
    ? 'cabeceira'
    : /poltrona/.test(t)
      ? 'poltrona'
      : /cadeira/.test(t)
        ? 'cadeiras'
        : /sofa/.test(t)
          ? 'sofá'
          : 'móvel';
  const service = /reforma/.test(t)
    ? 'reforma'
    : /tecido|trocar|troca/.test(t)
      ? 'troca de tecido'
      : /espuma/.test(t)
        ? 'troca de espuma'
        : /fabric|fazer|sob medida/.test(t)
          ? 'fabricação'
          : 'serviço';
  const quote = /orcamento|valor|preco|quanto (custa|fica|sai)/.test(t);
  const pending = [
    ...(photos ? [] : ['fotos do móvel (frente e lateral)']),
    ...(measures.length >= 2 ? [] : ['medidas (largura, profundidade e altura)']),
    ...(/bairro|endereco|rua|cidade/.test(t) ? [] : ['bairro/cidade para a retirada']),
  ];
  return {
    quote,
    text: `${quote ? 'Pede orçamento' : 'Contato'} de ${service} de ${what}. Fotos: ${photos}. Medidas: ${measures.length ? measures.join(', ') : 'nenhuma'}.${pending.length ? ` Faltam: ${pending.join('; ')}.` : ' Tem o necessário para orçar.'}`,
    pending,
    photos,
  };
}

function draftReply(name: string | null, s: ReturnType<typeof summarize>, company: string) {
  const first = name?.split(' ')[0];
  if (!s.pending.length)
    return `Olá${first ? `, ${first}` : ''}! Recebemos as fotos e as medidas. Vamos preparar o seu orçamento e te enviamos ainda hoje. Obrigado pela confiança na ${company}!`;
  return `Olá${first ? `, ${first}` : ''}! Obrigado pelo contato com a ${company}. Para preparar o orçamento, pode nos enviar ${s.pending.join(', ')}? Assim já calculamos tecido, espuma e prazo.`;
}

async function emit(tx: Tx, actor: ActorContext, id: string) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.INBOX_MESSAGE,
    aggregateType: 'inbox_conversation',
    aggregateId: id,
    payload: { id },
    audience: AUDIENCE,
  });
}

/** Grava uma mensagem recebida (idempotente), atualiza a conversa e aciona o agente de Atendimento. */
export async function ingest(prisma: PrismaClient, m: InboundMessage) {
  return prisma.$transaction(async (tx) => {
    const dup = await tx.integrationWebhookEvent.findUnique({
      where: {
        companyId_providerKey_eventId: {
          companyId: requireCompanyId(),
          providerKey: `META_${m.channel}`,
          eventId: m.externalId,
        },
      },
    });
    if (dup) return { duplicate: true, conversationId: null as string | null };
    await tx.integrationWebhookEvent.create({
      data: {
        providerKey: `META_${m.channel}`,
        eventId: m.externalId,
        payload: m as never,
        processedAt: new Date(),
        result: 'MENSAGEM',
      },
    });
    const conv = await tx.inboxConversation.upsert({
      where: {
        companyId_channel_externalThreadId: {
          companyId: requireCompanyId(),
          channel: m.channel,
          externalThreadId: m.threadId,
        },
      },
      create: {
        channel: m.channel,
        externalThreadId: m.threadId,
        contactName: m.contactName,
        contactHandle: m.threadId,
        lastInboundAt: m.at,
        lastMessageAt: m.at,
        unread: 1,
      },
      update: {
        contactName: m.contactName ?? undefined,
        lastInboundAt: m.at,
        lastMessageAt: m.at,
        unread: { increment: 1 },
        version: { increment: 1 },
      },
    });
    await tx.inboxMessage.create({
      data: {
        conversationId: conv.id,
        direction: 'IN',
        externalId: m.externalId,
        kind: m.kind,
        text: m.text,
        media: m.media as never,
        status: 'RECEBIDA',
      }, // ordem de chegada (o horário da plataforma tem só segundos)
    });
    const all = await tx.inboxMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    const s = summarize(all);
    await tx.inboxConversation.update({
      where: { id: conv.id },
      data: {
        summary: s.text,
        ...(s.quote && conv.status === 'ABERTA' ? { status: 'AGUARDANDO_ORCAMENTO' } : {}),
      },
    });
    await agentDraft(tx, conv.id, true);
    await emit(tx, SYSTEM, conv.id);
    return { duplicate: false, conversationId: conv.id };
  });
}

/** Agente de Atendimento: rascunho (e envio automático só nos casos liberados). */
async function agentDraft(tx: Tx, conversationId: string, fromInbound: boolean) {
  const conv = await tx.inboxConversation.findUniqueOrThrow({ where: { id: conversationId } });
  const agents = await tx.aiAgent.findMany({ where: { roleKey: 'ATENDIMENTO', status: 'ATIVO' } });
  const agent = agents.find((a) => {
    const pol = (a.channelPolicies as Record<string, string>)[conv.channel];
    return pol === 'RASCUNHO' || pol === 'EXECUTAR';
  });
  if (!agent || conv.humanTakeover) return null;
  const msgs = await tx.inboxMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
  const s = summarize(msgs);
  await tx.inboxMessage.updateMany({
    where: { conversationId, status: 'RASCUNHO' },
    data: { status: 'DESCARTADA' },
  });
  const text = draftReply(conv.contactName, s, await companyName(tx));
  const draft = await tx.inboxMessage.create({
    data: {
      conversationId,
      direction: 'OUT',
      kind: 'TEXT',
      text,
      status: 'RASCUNHO',
      agentId: agent.id,
    },
  });
  const conn = await connectionOf(tx, CHANNEL_KEY[conv.channel]!);
  await tx.agentAction.create({
    data: {
      agentId: agent.id,
      channel: conv.channel,
      accountLabel: conn?.accountLabel ?? null,
      kind: 'RASCUNHO_RESPOSTA',
      summary: `Rascunho para ${conv.contactName ?? conv.externalThreadId}`,
      content: text,
      status: 'RASCUNHO',
      ref: { conversationId },
    },
  });
  // Envio automático: só política EXECUTAR + caso liberado + dentro da janela.
  const rules = (agent.autoSendRules as string[]) ?? [];
  const pol = (agent.channelPolicies as Record<string, string>)[conv.channel];
  const lastIn = msgs.filter((m) => m.direction === 'IN').at(-1);
  const autoCase =
    fromInbound &&
    pol === 'EXECUTAR' &&
    ((rules.includes('PEDIR_FOTOS_MEDIDAS') && s.pending.length > 0) ||
      (rules.includes('CONFIRMAR_RECEBIMENTO') && lastIn?.kind === 'IMAGE'));
  if (
    autoCase &&
    conn?.status === 'CONECTADA' &&
    conv.lastInboundAt &&
    Date.now() - conv.lastInboundAt.getTime() < WINDOW_MS
  ) {
    const sent = await deliver(conn, conv, { text });
    await tx.inboxMessage.update({
      where: { id: draft.id },
      data: {
        status: sent.test ? 'ENVIADA_TESTE' : 'ENVIADA',
        externalId: sent.externalId,
        sentAt: new Date(),
      },
    });
    await tx.agentAction.create({
      data: {
        agentId: agent.id,
        channel: conv.channel,
        accountLabel: conn.accountLabel,
        kind: 'ENVIO_AUTOMATICO',
        summary: `Resposta automática (regra liberada) para ${conv.contactName ?? conv.externalThreadId}`,
        content: text,
        status: sent.test ? 'ENVIADO_TESTE' : 'ENVIADO',
        ref: { conversationId },
      },
    });
  }
  return draft;
}

async function deliver(
  conn: NonNullable<Awaited<ReturnType<typeof connectionOf>>>,
  conv: InboxConversation,
  msg: { text?: string; template?: { name: string; language: string } },
) {
  const c = {
    providerKey: conn.providerKey,
    mode: conn.mode,
    config: conn.config,
    secret: conn.secret as never,
  };
  if (conv.channel === 'WHATSAPP') return sendWhatsApp(c, conv.externalThreadId, msg);
  if (!msg.text)
    throw Errors.business('Instagram e Messenger não usam modelos: envie texto dentro da janela.');
  return sendPageMessage(c, conv.externalThreadId, msg.text);
}

/** Regra de envio de cada canal (explica a restrição na tela). */
export function sendRule(
  conv: Pick<InboxConversation, 'channel' | 'lastInboundAt'>,
  now = Date.now(),
) {
  const open = Boolean(conv.lastInboundAt && now - conv.lastInboundAt.getTime() < WINDOW_MS);
  if (open)
    return {
      free: true,
      needsTemplate: false,
      blocked: false,
      detail: `Janela de 24 h aberta até ${new Date(conv.lastInboundAt!.getTime() + WINDOW_MS).toLocaleString('pt-BR')}.`,
    };
  if (conv.channel === 'WHATSAPP')
    return {
      free: false,
      needsTemplate: true,
      blocked: false,
      detail:
        'Fora da janela de 24 h: o WhatsApp só aceita um modelo de mensagem aprovado na Meta.',
    };
  return {
    free: false,
    needsTemplate: false,
    blocked: true,
    detail:
      'Fora da janela de 24 h: Instagram e Messenger não permitem resposta comum (só a etiqueta de agente humano, até 7 dias, com aprovação da Meta).',
  };
}

/** "Falar com a Cenário": perguntas sobre conversas (ex.: quem está esperando orçamento no WhatsApp?). */
registerOfficeHook(async (ctx, intent) => {
  if (intent.acao !== 'CONVERSAS') return { reply: '', effect: { kind: 'NADA' } };
  if (!ctx.perms.has('atendimento.ver'))
    return {
      reply: 'Ver conversas de clientes exige a permissão atendimento.ver.',
      effect: { kind: 'NADA' },
    };
  const t = norm(intent.pedido ?? '');
  const channel = /whats|zap/.test(t)
    ? 'WHATSAPP'
    : /insta|direct/.test(t)
      ? 'INSTAGRAM'
      : /messenger|facebook|pagina/.test(t)
        ? 'MESSENGER'
        : null;
  const waitingQuote = /orcamento|esperando|aguardando/.test(t);
  const unread = /nao lid|sem resposta|nova/.test(t);
  const rows = await ctx.prisma.inboxConversation.findMany({
    where: {
      ...(channel ? { channel } : {}),
      ...(waitingQuote ? { status: 'AGUARDANDO_ORCAMENTO' } : { status: { not: 'ENCERRADA' } }),
      ...(unread ? { unread: { gt: 0 } } : {}),
    },
    orderBy: { lastInboundAt: 'asc' },
    take: 20,
  });
  const where = channel
    ? ` no ${channel === 'WHATSAPP' ? 'WhatsApp' : channel === 'INSTAGRAM' ? 'Instagram' : 'Messenger'}`
    : '';
  if (!rows.length)
    return {
      reply: `Ninguém ${waitingQuote ? 'esperando orçamento' : 'com conversa aberta'}${where} agora.`,
      effect: { kind: 'ABRIR_PAINEL', panel: 'CAIXA_ENTRADA', filter: channel ?? undefined },
    };
  const since = (d: Date | null) => {
    if (!d) return '';
    const h = Math.round((Date.now() - d.getTime()) / 3600_000);
    return h < 1 ? 'há menos de 1 h' : h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
  };
  return {
    reply: `${rows.length} ${rows.length === 1 ? 'pessoa' : 'pessoas'} ${waitingQuote ? 'esperando orçamento' : 'com conversa aberta'}${where} (as mais antigas primeiro). Toque para abrir a conversa.`,
    effect: {
      kind: 'LISTA',
      title: waitingQuote ? `Esperando orçamento${where}` : `Conversas abertas${where}`,
      rows: rows.map((c) => ({
        label: `${c.contactName ?? c.contactHandle ?? 'Contato'} (${c.channel === 'WHATSAPP' ? 'WhatsApp' : c.channel === 'INSTAGRAM' ? 'Instagram' : 'Messenger'})`,
        detail: `${since(c.lastInboundAt)} · ${c.summary ?? ''}`.slice(0, 220),
        effect: { kind: 'ABRIR_CONVERSA', conversationId: c.id },
      })),
    },
  };
});

const ACCOUNT_FIELD: Record<InboundMessage['channel'], string[]> = {
  WHATSAPP: ['phoneNumberId'],
  INSTAGRAM: ['instagramId', 'pageId'],
  MESSENGER: ['pageId'],
};

/**
 * Empresa dona da conta que recebeu a mensagem (número do WhatsApp, Instagram ou página). Conexões
 * antigas da empresa nº 1 sem a conta gravada continuam recebendo o que não for de ninguém; fora
 * isso, mensagem de conta desconhecida é ignorada (nunca cai em outra empresa).
 */
export async function companyForInbound(
  system: PrismaClient,
  m: Pick<InboundMessage, 'channel' | 'account'>,
): Promise<number | null> {
  const rows = await system.integrationConnection.findMany({
    where: { providerKey: CHANNEL_KEY[m.channel]!, status: 'CONECTADA' },
    select: { companyId: true, config: true },
  });
  const fields = ACCOUNT_FIELD[m.channel];
  const value = (r: (typeof rows)[number], f: string) =>
    (r.config as Record<string, unknown> | null)?.[f];
  const owner = m.account
    ? rows.find((r) => fields.some((f) => String(value(r, f) ?? '') === m.account))
    : undefined;
  if (owner) return owner.companyId;
  const legacy = rows.find(
    (r) => r.companyId === PLATFORM_COMPANY_ID && fields.every((f) => !value(r, f)),
  );
  return legacy ? PLATFORM_COMPANY_ID : null;
}

export async function inboxRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // ── Webhook oficial da Meta (corpo bruto para verificar a assinatura) ──
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    sub.get(
      '/api/webhooks/meta',
      { config: { access: { webhook: true } } },
      async (request, reply) => {
        const q = request.query as Record<string, string>;
        const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
        if (q['hub.mode'] !== 'subscribe' || !expected || q['hub.verify_token'] !== expected)
          return reply.status(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Token de verificação inválido.' },
          });
        return reply.type('text/plain').send(q['hub.challenge'] ?? '');
      },
    );
    sub.post(
      '/api/webhooks/meta',
      { config: { access: { webhook: true } } },
      async (request, reply) => {
        const raw = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(JSON.stringify(request.body ?? {}));
        const testing =
          testModeAllowed() &&
          (await prisma.integrationConnection.count({
            where: {
              providerKey: { in: ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'] },
              mode: 'TESTE_LOCAL',
              status: 'CONECTADA',
            },
          })) > 0;
        if (
          !verifySignature(
            webhookSecret(testing),
            raw,
            request.headers['x-hub-signature-256'] as string | undefined,
          )
        )
          return reply
            .status(401)
            .send({ error: { code: 'UNAUTHENTICATED', message: 'Assinatura inválida.' } });
        const messages = parseWebhook(JSON.parse(raw.toString('utf8') || '{}'));
        const results = [];
        let ignored = 0;
        for (const m of messages) {
          const companyId = await companyForInbound(app.ctx.system, m);
          if (companyId === null) {
            ignored++;
            request.log.warn(
              { channel: m.channel, account: m.account },
              'Mensagem da Meta para conta que nenhuma empresa ligou: ignorada.',
            );
            continue;
          }
          results.push(await runAsCompany(companyId, () => ingest(prisma, m)));
        }
        return {
          received: messages.length,
          duplicates: results.filter((r) => r.duplicate).length,
          ignored,
        };
      },
    );
  });

  /** Modo de teste local: monta o corpo no formato oficial, assina e envia ao MESMO webhook. */
  app.post(
    '/api/v1/connections/:key/simulate',
    { config: { access: { session: 'WEB', permissions: ['jogo.acessar', 'conexoes.gerenciar'] } } },
    async (request) => {
      const { key } = z
        .object({ key: z.enum(['WHATSAPP', 'INSTAGRAM', 'MESSENGER']) })
        .parse(request.params);
      const b = z
        .object({
          from: z.string().min(3).max(40),
          name: z.string().max(80).optional(),
          text: z.string().max(1000).optional(),
          imageCaption: z.string().max(200).optional(),
          image: z.boolean().default(false),
          id: z.string().max(80).optional(),
        })
        .parse(request.body);
      const c = await connectionOf(prisma, key);
      if (!testModeAllowed() || c?.mode !== 'TESTE_LOCAL')
        throw Errors.business('Simulação só com a conexão em modo de teste local.');
      const id =
        b.id ??
        `${key === 'WHATSAPP' ? 'wamid' : 'mid'}.sim.${Date.now()}.${Math.round(Math.random() * 1e6)}`;
      const ts = Math.floor(Date.now() / 1000);
      const body =
        key === 'WHATSAPP'
          ? {
              object: 'whatsapp_business_account',
              entry: [
                {
                  id: 'waba-teste',
                  changes: [
                    {
                      field: 'messages',
                      value: {
                        messaging_product: 'whatsapp',
                        metadata: { phone_number_id: String(c.config.phoneNumberId ?? 'pn-teste') },
                        contacts: [{ wa_id: b.from, profile: { name: b.name ?? b.from } }],
                        messages: [
                          b.image
                            ? {
                                from: b.from,
                                id,
                                timestamp: String(ts),
                                type: 'image',
                                image: {
                                  id: `media-${id}`,
                                  mime_type: 'image/jpeg',
                                  caption: b.imageCaption ?? b.text ?? '',
                                },
                              }
                            : {
                                from: b.from,
                                id,
                                timestamp: String(ts),
                                type: 'text',
                                text: { body: b.text ?? '' },
                              },
                        ],
                      },
                    },
                  ],
                },
              ],
            }
          : {
              object: key === 'INSTAGRAM' ? 'instagram' : 'page',
              entry: [
                {
                  id: String(
                    (key === 'INSTAGRAM' ? c.config.instagramId : null) ??
                      c.config.pageId ??
                      'page-teste',
                  ),
                  time: Date.now(),
                  messaging: [
                    {
                      sender: { id: b.from },
                      recipient: { id: 'page-teste' },
                      timestamp: Date.now(),
                      message: { mid: id, text: b.text ?? '' },
                    },
                  ],
                },
              ],
            };
      const raw = JSON.stringify(body);
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/meta',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signBody(webhookSecret(true)!, raw),
        },
      });
      if (res.statusCode !== 200)
        throw Errors.business(`Webhook recusou a simulação (${res.statusCode}).`);
      return { ...(res.json() as object), id };
    },
  );

  app.get('/api/v1/inbox', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({ channel: z.string().optional(), status: z.string().optional() })
      .parse(request.query);
    const rows = await prisma.inboxConversation.findMany({
      where: {
        ...(q.channel ? { channel: q.channel } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      include: {
        customer: { select: { name: true } },
        serviceOrder: { select: { number: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
    });
    return rows.map((c) => ({
      id: c.id,
      channel: c.channel,
      contactName: c.contactName,
      contactHandle: c.contactHandle,
      status: c.status,
      unread: c.unread,
      summary: c.summary,
      humanTakeover: c.humanTakeover,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      lastText: c.messages[0]?.text ?? null,
      customerName: c.customer?.name ?? null,
      osNumber: c.serviceOrder?.number ?? null,
    }));
  });

  app.get('/api/v1/inbox/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const c = await prisma.inboxConversation.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true } },
        serviceOrder: { select: { id: true, number: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!c) throw Errors.notFound('Conversa');
    const conn = await connectionOf(prisma, CHANNEL_KEY[c.channel]!);
    const users = await prisma.user.findMany({
      where: {
        id: {
          in: c.messages
            .flatMap((m) => [m.createdById, m.approvedById])
            .filter((x): x is string => Boolean(x)),
        },
      },
      select: { id: true, displayName: true },
    });
    const agents = await prisma.aiAgent.findMany({
      where: {
        id: { in: c.messages.map((m) => m.agentId).filter((x): x is string => Boolean(x)) },
      },
      select: { id: true, name: true },
    });
    return {
      id: c.id,
      channel: c.channel,
      contactName: c.contactName,
      contactHandle: c.contactHandle,
      status: c.status,
      summary: c.summary,
      humanTakeover: c.humanTakeover,
      version: c.version,
      customer: c.customer,
      serviceOrder: c.serviceOrder
        ? { id: c.serviceOrder.id, number: c.serviceOrder.number }
        : null,
      orderId: c.orderId,
      connection: conn
        ? { status: conn.status, mode: conn.mode, accountLabel: conn.accountLabel }
        : null,
      rule: sendRule(c),
      messages: c.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        kind: m.kind,
        text: m.text,
        media: m.media,
        status: m.status,
        error: m.error,
        agent: agents.find((a) => a.id === m.agentId)?.name ?? null,
        createdBy: users.find((u) => u.id === m.createdById)?.displayName ?? null,
        approvedBy: users.find((u) => u.id === m.approvedById)?.displayName ?? null,
        at: (m.sentAt ?? m.createdAt).toISOString(),
      })),
    };
  });

  app.post('/api/v1/inbox/:id/read', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    await prisma.inboxConversation.update({ where: { id }, data: { unread: 0 } });
    return { ok: true };
  });

  /** Envia (texto, modelo ou rascunho do agente aprovado) respeitando as regras do canal. */
  app.post(
    '/api/v1/inbox/:id/send',
    { config: { access: REPLY, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          text: z.string().trim().min(1).max(4096).optional(),
          draftId: z.guid().optional(),
          template: z
            .object({ name: z.string().min(1).max(100), language: z.string().min(2).max(10) })
            .optional(),
        })
        .refine((v) => v.text || v.template, 'Escreva a mensagem ou escolha um modelo.')
        .parse(request.body);
      const actor = actorFrom(request);
      const conv = await prisma.inboxConversation.findUnique({ where: { id } });
      if (!conv) throw Errors.notFound('Conversa');
      const conn = await requireConnection(prisma, CHANNEL_KEY[conv.channel]!);
      const rule = sendRule(conv);
      if (rule.blocked || (b.text && !rule.free && !b.template))
        throw Errors.business(rule.detail, { rule });
      const sent = await deliver(
        conn,
        conv,
        b.template ? { template: b.template } : { text: b.text },
      );
      return prisma.$transaction(async (tx) => {
        const draft = b.draftId
          ? await tx.inboxMessage.findFirst({
              where: { id: b.draftId, conversationId: id, status: 'RASCUNHO' },
            })
          : null;
        const data = {
          text: b.template ? `[modelo ${b.template.name}]` : b.text!,
          kind: b.template ? 'TEMPLATE' : 'TEXT',
          status: sent.test ? 'ENVIADA_TESTE' : 'ENVIADA',
          externalId: sent.externalId,
          sentAt: new Date(),
          approvedById: draft ? actor.userId : null,
          createdById: actor.userId,
        };
        const m = draft
          ? await tx.inboxMessage.update({ where: { id: draft.id }, data })
          : await tx.inboxMessage.create({
              data: { conversationId: id, direction: 'OUT', ...data },
            });
        await tx.inboxMessage.updateMany({
          where: { conversationId: id, status: 'RASCUNHO', id: { not: m.id } },
          data: { status: 'DESCARTADA' },
        });
        await tx.inboxConversation.update({
          where: { id },
          data: {
            lastMessageAt: new Date(),
            unread: 0,
            status: conv.status === 'ABERTA' ? 'EM_ATENDIMENTO' : conv.status,
            version: { increment: 1 },
          },
        });
        await tx.agentAction.create({
          data: {
            agentId: draft?.agentId ?? null,
            channel: conv.channel,
            accountLabel: conn.accountLabel,
            kind: draft ? 'RESPOSTA_APROVADA' : 'RESPOSTA_MANUAL',
            summary: `Mensagem para ${conv.contactName ?? conv.externalThreadId}${draft ? ' (rascunho do agente aprovado)' : ''}`,
            content: data.text,
            status: sent.test ? 'ENVIADO_TESTE' : 'ENVIADO',
            approvedById: actor.userId,
            ref: { conversationId: id, messageId: m.id },
          },
        });
        await audit(tx, actor, {
          action: 'inbox.sent',
          entityType: 'inbox_conversation',
          entityId: id,
          summary: `Mensagem ${conv.channel} enviada${sent.test ? ' (teste)' : ''}.`,
        });
        await emit(tx, actor, id);
        return { id: m.id, status: m.status, test: sent.test };
      });
    },
  );

  /** Pede ao agente de Atendimento um novo rascunho com o resumo atual. */
  app.post('/api/v1/inbox/:id/draft', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const d = await prisma.$transaction((tx) => agentDraft(tx, id, false));
    if (!d)
      throw Errors.business(
        'Nenhum agente de Atendimento ativo com acesso a este canal (ou a conversa está assumida por você).',
      );
    return { id: d.id, text: d.text };
  });

  app.post('/api/v1/inbox/:id/takeover', { config: { access: REPLY } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { on } = z.object({ on: z.boolean() }).parse(request.body);
    await prisma.$transaction(async (tx) => {
      await tx.inboxConversation.update({
        where: { id },
        data: { humanTakeover: on, version: { increment: 1 } },
      });
      if (on)
        await tx.inboxMessage.updateMany({
          where: { conversationId: id, status: 'RASCUNHO' },
          data: { status: 'DESCARTADA' },
        });
      await audit(tx, actorFrom(request), {
        action: 'inbox.takeover',
        entityType: 'inbox_conversation',
        entityId: id,
        summary: on ? 'Conversa assumida pelo gestor.' : 'Conversa devolvida ao agente.',
      });
    });
    return { ok: true };
  });

  /** Vincula o atendimento a um cliente, pedido (orçamento aprovado) ou OS do Cenário Gestão. */
  app.post('/api/v1/inbox/:id/link', { config: { access: REPLY } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const b = z
      .object({
        customerId: z.guid().nullable().optional(),
        serviceOrderId: z.guid().nullable().optional(),
        orderId: z.guid().nullable().optional(),
        status: z
          .enum(['ABERTA', 'AGUARDANDO_ORCAMENTO', 'EM_ATENDIMENTO', 'ENCERRADA'])
          .optional(),
      })
      .parse(request.body);
    const actor = actorFrom(request);
    return prisma.$transaction(async (tx) => {
      let customerId = b.customerId;
      if (b.serviceOrderId) {
        const so = await tx.serviceOrder.findUnique({ where: { id: b.serviceOrderId } });
        if (!so) throw Errors.notFound('OS');
        customerId = customerId ?? so.customerId;
      }
      const c = await tx.inboxConversation.update({
        where: { id },
        data: {
          ...(customerId !== undefined ? { customerId } : {}),
          ...(b.serviceOrderId !== undefined ? { serviceOrderId: b.serviceOrderId } : {}),
          ...(b.orderId !== undefined ? { orderId: b.orderId } : {}),
          ...(b.status ? { status: b.status } : {}),
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'inbox.linked',
        entityType: 'inbox_conversation',
        entityId: id,
        summary: `Conversa vinculada${b.serviceOrderId ? ' à OS' : ''}${customerId ? ' ao cliente' : ''}.`,
        changes: b,
      });
      await emit(tx, actor, id);
      return { id: c.id };
    });
  });

  app.get(
    '/api/v1/game/agents/:id/actions',
    { config: { access: { session: 'WEB', permissions: ['jogo.acessar', 'agentes.usar'] } } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const rows = await prisma.agentAction.findMany({
        where: { agentId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const users = await prisma.user.findMany({
        where: {
          id: { in: rows.map((r) => r.approvedById).filter((x): x is string => Boolean(x)) },
        },
        select: { id: true, displayName: true },
      });
      return rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        approvedBy: users.find((u) => u.id === r.approvedById)?.displayName ?? null,
      }));
    },
  );
}
