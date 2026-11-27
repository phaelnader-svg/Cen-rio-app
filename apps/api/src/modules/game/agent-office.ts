/**
 * Agentes do escritório que trabalham com os dados do Cenário e o WhatsApp sem precisar de conta
 * na Meta: Compras (lista de materiais das OS → pedido ao fornecedor), Financeiro (vencidos,
 * semana e cobrança), Orçamentos (retorno ao cliente) e os agentes criados pelo dono (instruções
 * próprias, com IA no servidor quando houver chave).
 *
 * Como nos demais agentes, nada sai daqui: o agente devolve PROPOSTAS. Mensagens viram um link
 * do WhatsApp com o texto pronto (o dono aperta "enviar") ou, com o WhatsApp conectado na Central,
 * saem pelo número da empresa depois da aprovação.
 */
import { plural } from '@cenario/shared';
import Anthropic from '@anthropic-ai/sdk';
import {
  type AgentReference,
  type PurchaseNeedDto,
  customerMessage,
  supplierOrderMessage,
  whatsappLink,
  whatsappNumber,
} from '@cenario/shared';
import type { AiAgent, PrismaClient, Tx } from '@cenario/db';
import { requireCompanyId } from '../../core/tenant';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { connectionOf } from '../integrations/connections';
import { sendWhatsApp } from '../integrations/meta';
import { announce } from '../os-materials/routes';
import { serviceOrderCode } from '../commercial/common';
import { shopTimezone, todayIso } from '../finance/common';
import { dueContext, dueOf } from '../finance/revenue';
import type { AgentAnswer, AgentContext, ProposalDraft } from './agent-engines';
import { listSuppliers, materialCategory, pickSupplier } from './suppliers';

type Db = PrismaClient | Tx;

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso: string) => iso.split('-').reverse().join('/');
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const qty = (q: unknown, unit: string | null) => {
  if (q === null || q === undefined) return unit || null;
  const n = Number(q);
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
};
const has = (ctx: AgentContext, scope: string, ...perms: string[]) =>
  ctx.dataScopes.includes(scope) && perms.some((p) => ctx.permissions.has(p));
const osHref = (id: string, tab?: string) => `/painel/os/${id}${tab ? `?aba=${tab}` : ''}`;

/** Nome da empresa da requisição (as mensagens saem em nome dela, nunca de outra). */
export async function companyName(db: Db): Promise<string> {
  let id: number | null = null;
  try {
    id = requireCompanyId();
  } catch {
    id = null; // fora de uma requisição (webhook): a leitura já é da empresa do contexto do banco
  }
  const s = id
    ? await db.companySettings.findUnique({ where: { id }, select: { tradeName: true } })
    : await db.companySettings.findFirst({ select: { tradeName: true }, orderBy: { id: 'asc' } });
  return s?.tradeName?.trim() || 'nossa empresa';
}

function blocked(role: string, scope: string, perm: string): AgentAnswer {
  return {
    content: `Como ${role}, preciso do escopo de dados "${scope}" liberado na minha configuração e de uma conta com a permissão ${perm}.`,
    references: [],
    proposals: [],
    tasks: [
      { label: 'Configuração incompleta', detail: `Liberar escopo ${scope}`, tone: 'atencao' },
    ],
  };
}

// ───────────────────────────── Compras ─────────────────────────────

/** Materiais da lista das OS abertas que ainda não foram comprados (o mais urgente primeiro). */
export async function purchaseNeeds(db: Db): Promise<PurchaseNeedDto[]> {
  const [rows, suppliers] = await Promise.all([
    db.serviceOrderMaterial.findMany({
      where: { removedAt: null, purchased: false, serviceOrder: { status: 'ABERTA' } },
      include: {
        category: { select: { name: true } },
        serviceOrder: {
          select: {
            id: true,
            number: true,
            promisedDate: true,
            customer: { select: { name: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 300,
    }),
    listSuppliers(db),
  ]);
  const out = rows.map((r): PurchaseNeedDto => {
    const category = materialCategory(r.category?.name ?? null, r.description);
    const s = pickSupplier(suppliers, category);
    return {
      materialId: r.id,
      serviceOrderId: r.serviceOrderId,
      osCode: serviceOrderCode(r.serviceOrder.number),
      customerName: r.serviceOrder.customer.name,
      promisedDate: r.serviceOrder.promisedDate?.toISOString().slice(0, 10) ?? null,
      description: r.description,
      quantity: qty(r.quantity, r.unit),
      category,
      available: r.available,
      supplierId: s?.id ?? null,
      supplierName: s?.name ?? null,
    };
  });
  // Já na oficina não precisa comprar; prazo mais perto primeiro, sem prazo no fim.
  return out
    .filter((n) => !n.available)
    .sort((a, b) => (a.promisedDate ?? '9999').localeCompare(b.promisedDate ?? '9999'));
}

export async function supplierOrderText(
  db: Db,
  supplier: { contactName: string | null } | null,
  needs: PurchaseNeedDto[],
) {
  return supplierOrderMessage({
    supplierContact: supplier?.contactName ?? null,
    companyName: await companyName(db),
    items: needs.map((n) => ({
      description: n.description,
      quantity: n.quantity,
      osCode: n.osCode,
    })),
  });
}

export async function purchasingAnswer(ctx: AgentContext, question: string): Promise<AgentAnswer> {
  if (!has(ctx, 'compras', 'os.ver', 'estoque.ver')) return blocked('Compras', 'compras', 'os.ver');
  const { prisma } = ctx;
  const [needs, suppliers] = await Promise.all([purchaseNeeds(prisma), listSuppliers(prisma)]);
  const refs: AgentReference[] = [];
  const lines: string[] = [];
  const tasks: AgentAnswer['tasks'] = [];
  const proposals: ProposalDraft[] = [];
  if (!needs.length) {
    lines.push(
      'Nada para comprar: todos os materiais das listas das OS abertas estão comprados ou já na oficina.',
      'Para eu acompanhar uma OS, cadastre os materiais dela na aba Materiais da OS (no painel ou na ficha da peça aqui no jogo).',
    );
  } else {
    lines.push(
      `Faltam comprar ${plural(needs.length, 'material', 'materiais')} das listas das OS:`,
    );
    for (const n of needs.slice(0, 15))
      lines.push(
        `• ${n.description}${n.quantity ? ` — ${n.quantity}` : ''} para ${n.osCode}` +
          `${n.promisedDate ? ` (prazo ${br(n.promisedDate)})` : ''}` +
          ` → ${n.supplierName ?? 'sem fornecedor'}.`,
      );
    if (needs.length > 15) lines.push(`… e mais ${needs.length - 15}.`);
  }
  // Um pedido por fornecedor (até 5), com o texto pronto para o WhatsApp dele.
  const bySupplier = new Map<string, PurchaseNeedDto[]>();
  for (const n of needs)
    if (n.supplierId) bySupplier.set(n.supplierId, [...(bySupplier.get(n.supplierId) ?? []), n]);
  const noSupplier = needs.filter((n) => !n.supplierId);
  const policy = ctx.policies.pedir_fornecedor ?? ctx.policies.criar_compra ?? 'PROPOR';
  if (policy !== 'NUNCA')
    for (const [supplierId, items] of [...bySupplier.entries()].slice(0, 5)) {
      const s = suppliers.find((x) => x.id === supplierId)!;
      const text = await supplierOrderText(prisma, s, items);
      const phone = whatsappNumber(s.phone);
      proposals.push({
        kind: 'PEDIR_FORNECEDOR',
        title: `Pedido para ${s.name} (${items.length} ${items.length === 1 ? 'item' : 'itens'})`,
        detail: text,
        payload: {
          supplierId,
          supplierName: s.name,
          phone,
          materialIds: items.map((i) => i.materialId),
          text,
          href: whatsappLink(s.phone, text),
          channel: 'WHATSAPP',
        },
        evidence: [...new Map(items.map((i) => [i.serviceOrderId, i])).values()].map((i) => ({
          type: 'OS',
          id: i.serviceOrderId,
          label: i.osCode,
          href: osHref(i.serviceOrderId, 'materiais'),
        })),
      });
      tasks.push({
        label: `Pedir a ${s.name}`,
        detail: `${plural(items.length, 'material', 'materiais')}${phone ? '' : ' · cadastre o WhatsApp do fornecedor'}`,
        tone: items.some((i) => i.promisedDate && i.promisedDate <= weekAhead())
          ? 'risco'
          : 'atencao',
      });
    }
  if (!suppliers.length && needs.length)
    lines.push(
      '',
      'Nenhum fornecedor cadastrado: cadastre em Fornecedores (no meu painel) com o WhatsApp e o que cada um vende, que eu preparo o pedido de cada um.',
    );
  else if (noSupplier.length)
    lines.push(
      '',
      `Sem fornecedor para: ${noSupplier.map((n) => n.description).join(', ')}. Marque em Fornecedores quem vende ${[...new Set(noSupplier.map((n) => n.category.toLowerCase()))].join(' e ')}.`,
    );
  if (proposals.length)
    lines.push(
      '',
      'Deixei o pedido de cada fornecedor para você aprovar. Ao aprovar, o WhatsApp abre com o texto pronto e os itens ficam marcados como comprados.',
    );
  for (const n of needs)
    refs.push({
      type: 'OS',
      id: n.serviceOrderId,
      label: n.osCode,
      href: osHref(n.serviceOrderId, 'materiais'),
    });
  void question;
  return {
    content: lines.join('\n'),
    references: dedupe(refs),
    proposals,
    tasks: tasks.slice(0, 8),
  };
}

function weekAhead() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

const dedupe = (refs: AgentReference[]) =>
  refs.filter((r, i) => refs.findIndex((x) => x.type === r.type && x.id === r.id) === i);

// ───────────────────────────── Financeiro ─────────────────────────────

export async function financeAnswer(ctx: AgentContext, question: string): Promise<AgentAnswer> {
  if (!has(ctx, 'financeiro', 'financeiro.ver'))
    return blocked('Financeiro', 'financeiro', 'financeiro.ver');
  const { prisma } = ctx;
  const today = todayIso(await shopTimezone(prisma));
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  const [payables, receivables, company] = await Promise.all([
    prisma.accountPayable.findMany({
      where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lte: end } },
      orderBy: { dueDate: 'asc' },
      take: 50,
    }),
    prisma.customerReceivable.findMany({
      where: { status: { in: ['ABERTO', 'PARCIAL'] } },
      include: {
        customer: { select: { name: true, phone: true, whatsapp: true } },
        order: { select: { number: true } },
      },
      orderBy: { dueDate: 'asc' },
      take: 200,
    }),
    companyName(prisma),
  ]);
  const dctx = await dueContext(
    prisma,
    receivables.map((r) => r.orderId),
  );
  const open = (r: (typeof receivables)[number]) => Math.max(0, r.amountCents - r.receivedCents);
  const overdue = receivables.filter((r) => dueOf(r, dctx).overdue);
  const week = receivables.filter(
    (r) => !overdue.includes(r) && r.dueTrigger === 'DATA' && r.dueDate && r.dueDate <= end,
  );
  const onDelivery = receivables.filter((r) => !overdue.includes(r) && r.dueTrigger !== 'DATA');
  const sum = (xs: { amountCents: number; receivedCents?: number; paidCents?: number }[]) =>
    xs.reduce((s, x) => s + x.amountCents - (x.receivedCents ?? x.paidCents ?? 0), 0);
  const overduePay = payables.filter((p) => p.dueDate.toISOString().slice(0, 10) < today);
  const t = norm(question);
  const lines: string[] = [];
  if (/pagar|conta|boleto|fornecedor/.test(t) && !/receb|cobr/.test(t)) {
    lines.push(
      payables.length
        ? `Contas até ${br(end.toISOString().slice(0, 10))}: ${brl(sum(payables))} em ${payables.length}.`
        : 'Nenhuma conta a pagar nos próximos 7 dias.',
    );
    for (const p of payables.slice(0, 10))
      lines.push(
        `• ${p.description}: ${brl(p.amountCents - p.paidCents)}, vence ${br(p.dueDate.toISOString().slice(0, 10))}${overduePay.includes(p) ? ' (vencida)' : ''}.`,
      );
  } else {
    lines.push(`Resumo do financeiro (${br(today)}):`);
    lines.push(`• A receber vencido: ${brl(sum(overdue))} (${overdue.length}).`);
    lines.push(`• A receber com data nos próximos 7 dias: ${brl(sum(week))} (${week.length}).`);
    lines.push(
      `• A receber na entrega ou retirada: ${brl(sum(onDelivery))} (${onDelivery.length}).`,
    );
    lines.push(
      `• A pagar nos próximos 7 dias: ${brl(sum(payables))} (${payables.length})${overduePay.length ? `, ${plural(overduePay.length, 'já vencida', 'já vencidas')}` : ''}.`,
    );
    const net = sum(overdue) + sum(week) - sum(payables);
    lines.push(
      net >= 0
        ? `• Recebendo o vencido e o da semana, sobra ${brl(net)} depois das contas.`
        : `• Mesmo recebendo o vencido e o da semana, faltam ${brl(-net)} para as contas; as entregas com saldo ajudam a cobrir.`,
    );
    if (overdue.length) {
      lines.push('', 'Quem cobrar primeiro (mais antigo primeiro):');
      for (const r of overdue.slice(0, 8))
        lines.push(
          `• ${r.customer.name}: ${brl(open(r))} — ${r.description} (PED-${String(r.order.number).padStart(5, '0')}).`,
        );
    }
  }
  const proposals: ProposalDraft[] = [];
  if ((ctx.policies.cobrar_cliente ?? 'PROPOR') !== 'NUNCA')
    for (const r of overdue.slice(0, 5)) {
      const phone = r.customer.whatsapp || r.customer.phone;
      const first = r.customer.name.trim().split(/\s+/)[0];
      const text = `Olá, ${first}! Tudo bem? Aqui é da ${company}. Consta em aberto ${brl(open(r))} referente a ${r.description.toLowerCase()} do pedido PED-${String(r.order.number).padStart(5, '0')}. Consegue verificar para nós? Se já pagou, pode desconsiderar e nos enviar o comprovante. Obrigado!`;
      proposals.push({
        kind: 'COBRAR_CLIENTE',
        title: `Cobrar ${r.customer.name} (${brl(open(r))})`,
        detail: text,
        payload: {
          receivableId: r.id,
          customerName: r.customer.name,
          phone: whatsappNumber(phone),
          text,
          href: whatsappLink(phone, text),
          channel: 'WHATSAPP',
          openCents: open(r),
        },
        evidence: [
          {
            type: 'RECEBIVEL',
            id: r.id,
            label: `PED-${String(r.order.number).padStart(5, '0')} ${r.description}`,
            href: '/painel/financeiro?aba=receitas',
          },
        ],
      });
    }
  const tasks: AgentAnswer['tasks'] = [
    ...overdue.slice(0, 4).map((r) => ({
      label: `Cobrar ${r.customer.name}`,
      detail: brl(open(r)),
      tone: 'risco' as const,
    })),
    ...overduePay.slice(0, 3).map((p) => ({
      label: `Conta vencida: ${p.description}`,
      detail: brl(p.amountCents - p.paidCents),
      tone: 'risco' as const,
    })),
  ];
  if (!tasks.length) tasks.push({ label: 'Financeiro em dia', detail: 'Nada vencido', tone: 'ok' });
  const references: AgentReference[] = [
    ...overdue.slice(0, 6).map((r) => ({
      type: 'RECEBIVEL' as const,
      id: r.id,
      label: `${r.customer.name}: ${brl(open(r))}`,
      href: '/painel/financeiro?aba=receitas',
    })),
    ...payables.slice(0, 6).map((p) => ({
      type: 'CONTA' as const,
      id: p.id,
      label: `${p.description} (${brl(p.amountCents - p.paidCents)})`,
      href: '/painel/financeiro?aba=contas',
    })),
  ];
  lines.push('', 'Os números vêm do financeiro do Cenário; nada foi alterado.');
  return { content: lines.join('\n'), references, proposals, tasks };
}

// ───────────────────────────── Orçamentos ─────────────────────────────

export async function quotesAnswer(ctx: AgentContext, question: string): Promise<AgentAnswer> {
  if (!has(ctx, 'orcamentos', 'orcamentos.ver') && !has(ctx, 'clientes', 'orcamentos.ver'))
    return blocked('Orçamentos', 'orcamentos', 'orcamentos.ver');
  const { prisma } = ctx;
  const since = new Date(Date.now() - 45 * 86_400_000);
  const [quotes, waiting, company] = await Promise.all([
    prisma.quote.findMany({
      where: { deletedAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    ctx.permissions.has('atendimento.ver')
      ? prisma.inboxConversation.findMany({
          where: { status: 'AGUARDANDO_ORCAMENTO' },
          orderBy: { lastInboundAt: 'asc' },
          take: 10,
        })
      : Promise.resolve([]),
    companyName(prisma),
  ]);
  // Sem ordem de serviço gerada = ainda esperando a resposta do cliente.
  const pending = quotes.filter((q) => !q.workOrder);
  const closed = quotes.length - pending.length;
  const days = (d: Date) => Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const lines: string[] = [];
  lines.push(
    quotes.length
      ? `Últimos 45 dias: ${plural(quotes.length, 'orçamento', 'orçamentos')}, ${closed} ${closed === 1 ? 'virou' : 'viraram'} OS e ${pending.length} ${pending.length === 1 ? 'aguarda' : 'aguardam'} resposta.`
      : 'Nenhum orçamento nos últimos 45 dias. Faça um em Orçamentos, no painel.',
  );
  if (quotes.length)
    lines.push(
      `Taxa de fechamento: ${Math.round((closed / quotes.length) * 100)}%. Valor esperando resposta: ${brl(pending.reduce((s, q) => s + q.totalCents, 0))}.`,
    );
  const followUp = pending.filter((q) => days(q.createdAt) >= 2);
  if (followUp.length) {
    lines.push('', 'Vale dar retorno (enviados há 2 dias ou mais):');
    for (const q of followUp.slice(0, 10))
      lines.push(
        `• Nº ${q.number} — ${q.customerName}, ${q.service}, ${brl(q.totalCents)} (há ${plural(days(q.createdAt), 'dia', 'dias')}).`,
      );
  }
  if (waiting.length) {
    lines.push('', 'Pediram orçamento pelas conversas e ainda não receberam:');
    for (const c of waiting)
      lines.push(`• ${c.contactName ?? c.contactHandle}: ${c.summary ?? ''}`.trim());
  }
  const proposals: ProposalDraft[] = [];
  if ((ctx.policies.enviar_mensagem ?? 'PROPOR') !== 'NUNCA')
    for (const q of followUp.slice(0, 5)) {
      const text = customerMessage({
        kind: 'ORCAMENTO_ENVIADO',
        customerName: q.customerName,
        companyName: company,
        piece: q.service.toLowerCase(),
        code: `orçamento nº ${q.number}`,
      });
      proposals.push({
        kind: 'ENVIAR_MENSAGEM',
        title: `Retorno do orçamento nº ${q.number} (${q.customerName})`,
        detail: text,
        payload: {
          quoteId: q.id,
          customerName: q.customerName,
          phone: whatsappNumber(q.phone),
          text,
          href: whatsappLink(q.phone, text),
          channel: 'WHATSAPP',
        },
        evidence: [
          {
            type: 'OS',
            id: q.id,
            label: `Orçamento nº ${q.number}`,
            href: `/painel/orcamentos?id=${q.id}`,
          },
        ],
      });
    }
  void question;
  return {
    content: lines.join('\n'),
    references: followUp.slice(0, 8).map((q) => ({
      type: 'OS' as const,
      id: q.id,
      label: `Orçamento nº ${q.number}`,
      href: `/painel/orcamentos?id=${q.id}`,
    })),
    proposals,
    tasks: [
      ...followUp.slice(0, 5).map((q) => ({
        label: `Retorno: ${q.customerName}`,
        detail: `Nº ${q.number} · ${brl(q.totalCents)}`,
        tone: 'atencao' as const,
      })),
      ...waiting.slice(0, 3).map((c) => ({
        label: `Orçar: ${c.contactName ?? c.contactHandle}`,
        detail: 'Pediu pela conversa',
        tone: 'atencao' as const,
      })),
    ],
  };
}

// ───────────────────────────── Avisos ao cliente ─────────────────────────────

/** Peças prontas: aviso ao cliente com o texto pronto (WhatsApp / Atendimento). */
export async function readyNoticeProposals(db: Db, limit = 5): Promise<ProposalDraft[]> {
  const ready = await db.serviceOrder.findMany({
    where: { status: 'ABERTA', items: { some: { fulfillmentStage: 'PRONTA_ENTREGA' } } },
    include: {
      customer: { select: { name: true, phone: true, whatsapp: true } },
      items: { select: { description: true, fulfillmentStage: true } },
    },
    orderBy: { promisedDate: 'asc' },
    take: limit,
  });
  const company = await companyName(db);
  return ready.map((so) => {
    const phone = so.customer.whatsapp || so.customer.phone;
    const pieces = so.items.filter((i) => i.fulfillmentStage === 'PRONTA_ENTREGA');
    const text = customerMessage({
      kind: 'PRONTO',
      customerName: so.customer.name,
      companyName: company,
      piece: pieces.length === 1 ? `o seu ${pieces[0]!.description.toLowerCase()}` : 'o seu pedido',
      code: serviceOrderCode(so.number),
    });
    return {
      kind: 'ENVIAR_MENSAGEM',
      title: `Avisar ${so.customer.name}: ${serviceOrderCode(so.number)} pronta`,
      detail: text,
      payload: {
        serviceOrderId: so.id,
        customerName: so.customer.name,
        phone: whatsappNumber(phone),
        text,
        href: whatsappLink(phone, text),
        channel: 'WHATSAPP',
      },
      evidence: [
        { type: 'OS', id: so.id, label: serviceOrderCode(so.number), href: osHref(so.id) },
      ],
    };
  });
}

// ───────────────────────────── Agente criado pelo dono ─────────────────────────────

export const aiAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

/**
 * Agente personalizado: responde seguindo as instruções do dono, com os dados que os escopos dele
 * liberam (os mesmos textos que os outros agentes leem). Precisa de IA no servidor; sem ela, o
 * agente lista os dados que tem e diz o que falta.
 */
export async function customAnswer(
  ctx: AgentContext,
  agent: AiAgent,
  question: string,
  dataOf: (scope: string) => Promise<string | null>,
): Promise<AgentAnswer> {
  const scopes = ctx.dataScopes;
  const blocks: string[] = [];
  for (const s of scopes) {
    const text = await dataOf(s).catch(() => null);
    if (text) blocks.push(`## Dados: ${s}\n${text}`);
  }
  if (!aiAvailable() || !question.trim()) {
    return {
      content: [
        `Sou o agente ${agent.name}. ${aiAvailable() ? 'Pergunte o que quiser sobre os dados que você liberou para mim.' : 'Para conversar em texto livre seguindo as suas instruções, preciso da IA ligada no servidor do Cenário (é configurada uma vez, para todas as empresas).'}`,
        instructionsLine(agent.instructions),
        blocks.length
          ? `Dados que já consigo ler: ${scopes.join(', ')}.`
          : 'Libere ao menos um escopo de dados na minha configuração.',
      ].join('\n'),
      references: [],
      proposals: [],
      tasks: aiAvailable()
        ? []
        : [{ label: 'IA do servidor', detail: 'Ligar a IA no Cenário', tone: 'atencao' }],
    };
  }
  try {
    const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: process.env.GAME_AI_MODEL || 'claude-opus-5-5',
      max_tokens: 1200,
      system: [
        `Você é o agente "${agent.name}" (${agent.roleLabel}) do escritório de uma tapeçaria (${await companyName(ctx.prisma)}).`,
        'Responda em português do Brasil, curto e prático, usando SOMENTE os dados fornecidos abaixo. Se faltar dado, diga qual.',
        'Você nunca envia, compra, paga, publica nem altera nada: no máximo sugere o texto de uma mensagem para o dono revisar.',
        `Instruções do dono:\n${agent.instructions || '(sem instruções)'}`,
        blocks.join('\n\n').slice(0, 30_000),
      ].join('\n\n'),
      messages: [{ role: 'user', content: question.slice(0, 2000) }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return {
      content: text || 'Não consegui montar uma resposta agora. Tente perguntar de outro jeito.',
      references: [],
      proposals: [],
      tasks: [],
    };
  } catch {
    return {
      content:
        'A IA do servidor não respondeu agora. Tente de novo em instantes; enquanto isso, os outros agentes continuam funcionando com os dados do Cenário.',
      references: [],
      proposals: [],
      tasks: [],
    };
  }
}

const instructionsLine = (i: string) =>
  i
    ? `Minhas instruções: "${i.slice(0, 300)}${i.length > 300 ? '…' : ''}"`
    : 'Sem instruções ainda: edite minha configuração.';

// ───────────────────────────── Aprovação de mensagens ─────────────────────────────

export interface WhatsAppApproval {
  status: 'APROVADA' | 'EXECUTADA_TESTE';
  payload: Record<string, unknown>;
}

/**
 * Aprovar uma mensagem do agente (pedido ao fornecedor, cobrança, aviso ao cliente):
 * aplica os ajustes do dono, marca os materiais do pedido como comprados e envia pelo WhatsApp
 * da empresa se ele estiver conectado; senão devolve o link com o texto pronto para o dono enviar.
 */
export async function approveWhatsApp(
  tx: Tx,
  perms: ReadonlySet<string>,
  actor: ActorContext,
  p: { id: string; agentId: string; kind: string; payload: unknown; detail: string },
  edits: { text?: string; supplierId?: string } | undefined,
): Promise<WhatsAppApproval> {
  const pl = { ...((p.payload ?? {}) as Record<string, unknown>) };
  let phone = (pl.phone as string | null) ?? null;
  let text = edits?.text ?? (pl.text as string | undefined) ?? p.detail;
  if (p.kind === 'PEDIR_FORNECEDOR') {
    const supplierId = edits?.supplierId ?? String(pl.supplierId ?? '');
    const s = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!s || !s.active) throw Errors.validation(undefined, 'Fornecedor não encontrado.');
    const ids = ((pl.materialIds as string[] | undefined) ?? []).filter(Boolean);
    if (supplierId !== pl.supplierId && !edits?.text) {
      const needs = (await purchaseNeeds(tx)).filter((n) => ids.includes(n.materialId));
      text = await supplierOrderText(tx, s, needs);
    }
    phone = whatsappNumber(s.phone);
    Object.assign(pl, { supplierId: s.id, supplierName: s.name });
    // O pedido aprovado conta como "comprado" na lista da OS (como o gestor marcaria no painel).
    if (perms.has('os.gerenciar') && ids.length) {
      const rows = await tx.serviceOrderMaterial.findMany({
        where: { id: { in: ids }, removedAt: null, purchased: false },
        select: { id: true, serviceOrderId: true },
      });
      for (const r of rows)
        await tx.serviceOrderMaterial.update({
          where: { id: r.id },
          data: { purchased: true, updatedById: actor.userId, version: { increment: 1 } },
        });
      for (const so of new Set(rows.map((r) => r.serviceOrderId))) await announce(tx, actor, so);
      pl.markedPurchased = rows.length;
    } else pl.markedPurchased = 0;
  }
  pl.text = text;
  pl.phone = phone;
  pl.href = whatsappLink(phone, text);
  let status: WhatsAppApproval['status'] = 'APROVADA';
  const conn = await connectionOf(tx, 'WHATSAPP');
  let sent = false;
  let actionStatus = 'APROVADO';
  if (conn?.status === 'CONECTADA' && phone) {
    try {
      const r = await sendWhatsApp(
        {
          providerKey: conn.providerKey,
          mode: conn.mode,
          config: conn.config,
          secret: conn.secret as never,
        },
        phone,
        { text },
      );
      sent = true;
      status = r.test ? 'EXECUTADA_TESTE' : 'APROVADA';
      actionStatus = r.test ? 'ENVIADO_TESTE' : 'ENVIADO';
    } catch (e) {
      // Fora da janela de 24 h a Meta só aceita modelo aprovado: fica o link para o dono enviar.
      pl.sendError = e instanceof Error ? e.message.slice(0, 300) : 'Falha no envio';
    }
  }
  if (!sent && !phone) pl.sendError = 'Sem WhatsApp cadastrado para este contato.';
  pl.sent = sent;
  await tx.agentAction.create({
    data: {
      agentId: p.agentId,
      channel: 'WHATSAPP',
      accountLabel: conn?.accountLabel ?? null,
      kind: p.kind,
      summary:
        `${p.kind === 'PEDIR_FORNECEDOR' ? `Pedido para ${String(pl.supplierName)}` : String(pl.customerName ?? 'Mensagem')}${sent ? ' (enviado pelo WhatsApp da empresa)' : ' (link do WhatsApp com o texto pronto)'}`.slice(
          0,
          500,
        ),
      content: text.slice(0, 4096),
      status: actionStatus,
      approvedById: actor.userId,
      ref: { proposalId: p.id, phone },
    },
  });
  return { status, payload: pl };
}
