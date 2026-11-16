/**
 * Respostas dos agentes ligados aos canais (Atendimento, Marketing, Tráfego) e a pergunta do
 * Gerente sobre quem espera orçamento. Só leitura: envios, publicações e mudanças de orçamento
 * continuam passando pela caixa de entrada / propostas com aprovação.
 */
import type { AiAgent, PrismaClient } from '@cenario/db';
import { requireConnection } from '../integrations/connections';
import { campaigns } from '../integrations/meta';
import type { AgentAnswer } from './agent-engines';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const CH: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  MESSENGER: 'Messenger',
};
const empty = (content: string): AgentAnswer => ({
  content,
  references: [],
  proposals: [],
  tasks: [],
});

async function conversations(prisma: PrismaClient, question: string, perms: ReadonlySet<string>) {
  if (!perms.has('atendimento.ver'))
    return empty('Ver conversas de clientes exige a permissão atendimento.ver.');
  const t = norm(question);
  const channel = /whats|zap/.test(t)
    ? 'WHATSAPP'
    : /insta|direct/.test(t)
      ? 'INSTAGRAM'
      : /messenger|facebook/.test(t)
        ? 'MESSENGER'
        : null;
  const waiting = await prisma.inboxConversation.findMany({
    where: { status: 'AGUARDANDO_ORCAMENTO', ...(channel ? { channel } : {}) },
    orderBy: { lastInboundAt: 'asc' },
    take: 15,
  });
  const unread = await prisma.inboxConversation.count({
    where: { unread: { gt: 0 }, ...(channel ? { channel } : {}) },
  });
  const where = channel ? ` no ${CH[channel]}` : '';
  return {
    content: waiting.length
      ? [
          `${waiting.length} esperando orçamento${where} (mais antigos primeiro):`,
          ...waiting.map(
            (c) => `• ${c.contactName ?? c.contactHandle} (${CH[c.channel]}): ${c.summary ?? ''}`,
          ),
          unread ? `${unread} conversa(s) com mensagem não lida.` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : `Ninguém esperando orçamento${where}.${unread ? ` ${unread} conversa(s) com mensagem não lida.` : ''}`,
    references: waiting.map((c) => ({
      type: 'CONVERSA' as const,
      id: c.id,
      label: `${c.contactName ?? c.contactHandle} · ${CH[c.channel]}`,
      href: `/jogo?conversa=${c.id}`,
    })),
    proposals: [],
    tasks: waiting.map((c) => ({
      label: `Orçamento: ${c.contactName ?? c.contactHandle}`,
      detail: c.summary ?? CH[c.channel]!,
      tone: 'atencao' as const,
    })),
  };
}

export async function channelAgentAnswer(
  prisma: PrismaClient,
  agent: AiAgent,
  perms: ReadonlySet<string>,
  question: string,
): Promise<AgentAnswer | null> {
  const t = norm(question);
  const asksConversations =
    /orcamento|conversa|whats|zap|direct|mensage|cliente.*esperando|esperando/.test(t);
  if (agent.roleKey === 'GERENTE')
    return asksConversations &&
      /whats|zap|direct|instagram|messenger|conversa|mensage|esperando orcamento/.test(t)
      ? conversations(prisma, question, perms)
      : null;
  if (agent.roleKey === 'ATENDIMENTO')
    return conversations(prisma, question || 'esperando orçamento', perms);
  if (agent.roleKey === 'MARKETING') {
    const [drafts, published, photos] = await Promise.all([
      prisma.marketingPost.count({ where: { status: 'RASCUNHO' } }),
      prisma.marketingPost.findMany({
        where: { status: { in: ['PUBLICADO', 'PUBLICADO_TESTE'] } },
        orderBy: { publishedAt: 'desc' },
        take: 3,
      }),
      prisma.attachment.count({
        where: {
          deletedAt: null,
          file: { mimeType: { startsWith: 'image/' } },
          createdAt: { gte: new Date(Date.now() - 30 * 86400_000) },
        },
      }),
    ]);
    return {
      content: [
        `Tenho ${photos} foto(s) de OS dos últimos 30 dias para usar em posts.`,
        drafts
          ? `${drafts} post(s) esperando sua aprovação em Publicações.`
          : 'Nenhum post esperando aprovação: peça um em Publicações.',
        published.length
          ? `Últimos publicados: ${published.map((p) => p.caption.split('\n')[0]!.slice(0, 50)).join(' | ')}`
          : 'Nada publicado ainda.',
        'Publicar só com a sua aprovação (permissão marketing.publicar).',
      ].join('\n'),
      references: [],
      proposals: [],
      tasks: drafts
        ? [{ label: 'Aprovar posts', detail: `${drafts} rascunho(s)`, tone: 'atencao' }]
        : [],
    };
  }
  if (agent.roleKey === 'TRAFEGO') {
    let c;
    try {
      c = await requireConnection(prisma, 'META_ADS');
    } catch {
      return empty(
        'Conecte a conta de anúncios na Central de Conexões (Meta Business e Anúncios) para eu ler campanhas, gastos e resultados.',
      );
    }
    const list = await campaigns({
      providerKey: c.providerKey,
      mode: c.mode,
      config: c.config,
      secret: c.secret as never,
    });
    const spend = list.reduce((a, x) => a + x.spendCents7d, 0);
    const leads = list.reduce((a, x) => a + x.leads7d, 0);
    return {
      content: [
        `${c.accountLabel}${c.mode === 'TESTE_LOCAL' ? ' (dados de teste)' : ''} — últimos 7 dias: gasto ${brl(spend)}, ${leads} contatos${leads ? `, ${brl(Math.round(spend / leads))} por contato` : ''}.`,
        ...list.map(
          (x) =>
            `• ${x.name} (${x.status === 'ACTIVE' ? 'ativa' : 'pausada'}): ${brl(x.spendCents7d)}, ${x.clicks7d} cliques, ${x.leads7d} contatos.`,
        ),
        'Para propor mudanças de orçamento, use "Pedir análise ao Tráfego" em Campanhas. Nada muda sem aprovação.',
      ].join('\n'),
      references: list.map((x) => ({ type: 'CAMPANHA' as const, id: x.id, label: x.name })),
      proposals: [],
      tasks: [],
    };
  }
  return null;
}
