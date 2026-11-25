/**
 * Conversar (app do dono, 2026-11-25): o dono escreve ou fala e a IA responde com os dados da
 * empresa dele. A IA não vê o banco: ela chama as ferramentas abaixo, que leem com as permissões
 * de quem pergunta (e só a empresa da sessão, pelo isolamento do banco). Os números chegam na tela
 * em cartões montados aqui, não pelo texto da IA. Pedidos de tarefa ("faz um orçamento para a
 * Maria", "manda uma mensagem para o João") viram cartões no Aprovar; nada sai sem aprovação.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  DELIVERY_STATUS_LABEL,
  EVENT_TYPES,
  PICKUP_STATUS_LABEL,
  FULFILLMENT_STAGE_LABEL,
  normalizeSearch,
  ownerChatRequestSchema,
  whatsappNumber,
  type DeliveryStatus,
  type FulfillmentStage,
  type PickupStatus,
  type OwnerChatCard,
  type OwnerChatReplyDto,
  type OwnerChatRequest,
} from '@cenario/shared';
import type { Prisma, PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { asSnapshot, orderCode, serviceOrderCode } from '../commercial/common';
import { shopTimezone, todayIso } from '../finance/common';
import { dashboard } from '../finance/results';
import { aiAvailable, companyName, purchaseNeeds } from './agent-office';
import { OFFICE_ACCESS, officeGuard } from './office';
import { cashForecast } from './office-finance';
import { planQuoteProposal } from './office-quote';

type Tools = Anthropic.Beta.BetaTool[];
type Msg = Anthropic.Beta.BetaMessageParam;
/** Uma volta da IA (trocável nos testes). */
export type ChatModel = (r: {
  system: string;
  tools: Tools;
  messages: Msg[];
}) => Promise<Anthropic.Beta.BetaMessage>;

const anthropicModel: ChatModel = async ({ system, tools, messages }) => {
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  return client.beta.messages.create({
    model: process.env.GAME_AI_MODEL || 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system,
    tools,
    messages,
  } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming) as Promise<Anthropic.Beta.BetaMessage>;
};
let model: ChatModel = anthropicModel;
export function setChatModel(m: ChatModel | null) {
  model = m ?? anthropicModel;
}

const GONE = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];
const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso: string) => iso.split('-').reverse().join('/');
const d10 = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) =>
  d10(new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000));
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const weekday = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]!;
const day = (iso: string) => `${weekday(iso)} ${br(iso).slice(0, 5)}`;
const isIso = (v: string | undefined): v is string => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
/** Período pedido pela IA (de/até); sem data, hoje; "até" antes do "de" vira o mesmo dia. Até 62 dias. */
function period(c: { today: string }, input: Record<string, string>) {
  const from = isIso(input.de) ? input.de : c.today;
  let to = isIso(input.ate) ? input.ate : from;
  if (to < from) to = from;
  if (to > addDays(from, 62)) to = addDays(from, 62);
  return {
    from,
    to,
    title: (what: string) =>
      from === to
        ? `${what} de ${day(from)}`
        : `${what} de ${br(from).slice(0, 5)} a ${br(to).slice(0, 5)}`,
  };
}
const dayRange = (from: string, to: string) => ({
  gte: new Date(`${from}T00:00:00Z`),
  lte: new Date(`${to}T00:00:00Z`),
});
const isoDate = { type: 'string', description: 'Data no formato AAAA-MM-DD.' } as const;
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): Anthropic.Beta.BetaTool => ({
  name,
  description,
  strict: true,
  input_schema: {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const TOOLS: Tools = [
  tool(
    'dinheiro',
    'Dinheiro de um período: quanto fechou (serviços combinados), quanto entrou e saiu do caixa, o lucro dos serviços entregues, as despesas e o que está atrasado para receber e pagar. Use para lucro, faturamento, quanto entrou, quanto gastou.',
    { de: isoDate, ate: isoDate },
  ),
  tool(
    'caixa_proximas_semanas',
    'O que vai entrar e sair do caixa nas próximas 4 semanas (parcelas de clientes, contas a pagar, maquininha).',
  ),
  tool(
    'agenda',
    'Tudo o que está marcado num dia ou período: retiradas, entregas, serviços com prazo de entrega para o cliente e contas a pagar que vencem. Use para "o que tem amanhã?", "como está a semana?", "tem alguma coisa sábado?".',
    { de: isoDate, ate: isoDate },
  ),
  tool(
    'retiradas',
    'Retiradas (buscar peças na casa do cliente) marcadas entre duas datas, com cliente, horário, bairro e o que levar (maquininha, mostruário). Também diz quantas ainda esperam data marcada.',
    { de: isoDate, ate: isoDate },
  ),
  tool('entregas', 'Entregas marcadas entre duas datas, com cliente, horário e situação.', {
    de: isoDate,
    ate: isoDate,
  }),
  tool(
    'prazos',
    'Serviços com prazo de entrega prometido ao cliente entre duas datas e que ainda não foram entregues, com a etapa em que estão.',
    { de: isoDate, ate: isoDate },
  ),
  tool(
    'contas_a_pagar',
    'Contas a pagar (fornecedores, aluguel, impostos e outras) que vencem entre duas datas e ainda não foram pagas.',
    { de: isoDate, ate: isoDate },
  ),
  tool(
    'atrasados',
    'Serviços com o prazo prometido vencido e ainda não entregues, e clientes com pagamento vencido.',
  ),
  tool('comprar', 'Materiais que faltam comprar para as OS abertas, com o fornecedor de cada um.'),
  tool('producao', 'Peças na oficina agora: quantas em cada etapa e quais são.'),
  tool('cliente', 'Procura um cliente pelo nome e mostra os últimos serviços dele.', {
    nome: { type: 'string', description: 'Nome ou parte do nome.' },
  }),
  tool(
    'pedir_orcamento',
    'Pede ao agente de Orçamentos para montar um orçamento. O orçamento vai para o Aprovar; nada é enviado ao cliente sem o dono aprovar.',
    {
      cliente: { type: 'string', description: 'Nome do cliente.' },
      telefone: { type: 'string', description: 'Telefone, ou vazio se não souber.' },
      cidade: { type: 'string', description: 'Cidade, ou vazio se não souber.' },
      pedido: {
        type: 'string',
        description: 'O que o cliente quer, com peças, medidas e tecido, como o dono contou.',
      },
    },
  ),
  tool(
    'pedir_mensagem',
    'Prepara uma mensagem de WhatsApp para um cliente já cadastrado (use antes a ferramenta cliente para achar o id). A mensagem vai para o Aprovar; nada sai sem o dono aprovar.',
    {
      cliente_id: { type: 'string', description: 'O id do cliente (da ferramenta cliente).' },
      mensagem: { type: 'string', description: 'O texto da mensagem, pronto para enviar.' },
    },
  ),
];

function systemPrompt(company: string, today: string) {
  return [
    `Você é a assistente da ${company}, uma tapeçaria. Quem fala com você é o dono, pelo celular.`,
    `Hoje é ${weekday(today)}, ${br(today)}. Amanhã é ${weekday(addDays(today, 1))}, ${br(addDays(today, 1))}.`,
    'Quando o dono falar de um dia ("hoje", "amanhã", "sábado", "semana que vem"), calcule as datas a partir de hoje e chame a ferramenta com essas datas. Para "o que tem" num dia, use agenda; para uma coisa só (retirada, entrega, prazo, conta), use a ferramenta dela.',
    'Responda o que foi perguntado com os nomes e horários que a ferramenta trouxe. Se não tiver nada no dia, diga isso claramente (por exemplo: "Amanhã não tem retirada marcada").',
    'Responda em português simples, como se fala numa oficina: frases curtas, sem jargão, sem inglês, sem "(s)" para plural.',
    'Para qualquer número, prazo, cliente ou lista, use as ferramentas. Nunca invente nem estime um valor que a ferramenta não trouxe.',
    'Os números e as listas que as ferramentas trazem já aparecem na tela em cartões, logo abaixo da sua resposta. Não repita tudo: diga em uma ou duas frases o que importa (o total, o que chama atenção, o que fazer).',
    'Quando o dono pedir uma tarefa (orçamento, mensagem para cliente), use pedir_orcamento ou pedir_mensagem e diga que deixou no Aprovar. Você não muda preço, não dá desconto, não apaga nada e não envia nada sozinha.',
    'Se faltar um dado para a tarefa (o nome do cliente, o que ele quer), pergunte antes.',
    'Para lançar um gasto, o dono manda a foto do comprovante pelo botão da câmera, ao lado do campo de escrever: o sistema lê e deixa a despesa no Aprovar.',
    'Se a pergunta não tiver ferramenta (por exemplo, algo fora da oficina), diga que ainda não consegue ver isso pelo sistema.',
    'Se uma ferramenta disser que falta permissão, explique isso ao dono em uma frase.',
  ].join('\n');
}

type Ctx = {
  prisma: PrismaClient;
  perms: ReadonlySet<string>;
  actor: ActorContext;
  today: string;
  cards: OwnerChatCard[];
};

class NoPermission extends Error {}
const need = (c: Ctx, perm: string, what: string) => {
  if (!c.perms.has(perm)) throw new NoPermission(`Sua conta não tem permissão para ver ${what}.`);
};

async function runTool(c: Ctx, name: string, input: Record<string, string>): Promise<string> {
  const { prisma } = c;
  switch (name) {
    case 'dinheiro': {
      need(c, 'financeiro.ver', 'o financeiro');
      const from = /^\d{4}-\d{2}-\d{2}$/.test(input.de ?? '') ? input.de! : c.today;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(input.ate ?? '') ? input.ate! : c.today;
      const d = await prisma.$transaction((tx) => dashboard(tx, c.actor, { from, to }), {
        timeout: 30_000,
      });
      const a = d.accrual;
      const cash = d.cash;
      const rows: { label: string; value: string; tone?: 'bom' | 'ruim' }[] = [
        {
          label: `Fechou (${a.contractedOrders} ${a.contractedOrders === 1 ? 'serviço' : 'serviços'})`,
          value: brl(a.contractedCents),
        },
        { label: 'Entrou no caixa', value: brl(cash.receivedCents) },
        { label: 'Saiu do caixa', value: brl(cash.paidPayablesCents + cash.paidLaborCents) },
        {
          label: 'Sobra do caixa',
          value: brl(cash.netCents),
          tone: cash.netCents < 0 ? 'ruim' : 'bom',
        },
        { label: 'Despesas da oficina', value: brl(a.operationalExpensesCents + a.fixedTeamCents) },
        {
          label: 'Resultado do período',
          value: brl(a.managementResultCents),
          tone: a.managementResultCents < 0 ? 'ruim' : 'bom',
        },
      ];
      // Sem serviço entregue no período não tem lucro de serviço para mostrar.
      if (a.completedOrders)
        rows.splice(4, 0, {
          label: `Lucro dos ${a.completedOrders} ${a.completedOrders === 1 ? 'serviço entregue' : 'serviços entregues'}`,
          value: brl(a.contributionMarginCents),
        });
      if (d.open.receivableOverdueCents)
        rows.push({
          label: 'Clientes atrasados',
          value: brl(d.open.receivableOverdueCents),
          tone: 'ruim',
        });
      if (d.open.payableOverdueCents)
        rows.push({
          label: 'Contas vencidas',
          value: brl(d.open.payableOverdueCents),
          tone: 'ruim',
        });
      c.cards.push({
        kind: 'numeros',
        title: from === to ? `Dinheiro de ${br(from)}` : `Dinheiro de ${br(from)} a ${br(to)}`,
        rows,
      });
      return JSON.stringify({
        periodo: { de: from, ate: to },
        ...Object.fromEntries(rows.map((r) => [r.label, r.value])),
        observacoes: d.notes,
      });
    }
    case 'caixa_proximas_semanas': {
      need(c, 'financeiro.ver', 'o financeiro');
      const f = await cashForecast(prisma, c.today);
      c.cards.push({
        kind: 'numeros',
        title: 'Caixa das próximas 4 semanas',
        rows: f.weeks.map((w) => ({
          label: `${br(w.from).slice(0, 5)} a ${br(w.to).slice(0, 5)}`,
          value: `entra ${brl(w.inCents)} · sai ${brl(w.outCents)}`,
          tone: w.inCents - w.outCents < 0 ? ('ruim' as const) : undefined,
        })),
      });
      return JSON.stringify(f);
    }
    case 'agenda': {
      const p = period(c, input);
      const one = { de: p.from, ate: p.to };
      const parts: Record<string, unknown> = { periodo: one };
      const sub: [string, string, string][] = [
        ['retiradas', 'retiradas.ver', 'retiradas'],
        ['entregas', '', 'entregas'],
        ['prazos', '', 'prazos'],
        ['contas_a_pagar', 'financeiro.ver', 'contas_a_pagar'],
      ];
      const before = c.cards.length;
      for (const [toolName, perm, key] of sub) {
        if (perm && !c.perms.has(perm)) continue;
        parts[key] = JSON.parse(await runTool(c, toolName, one));
      }
      // Na tela, só os cartões com alguma coisa; dia sem nada vira um cartão só.
      const added = c.cards.splice(before);
      const filled = added.filter((k) => k.kind !== 'lista' || k.items.length > 0);
      c.cards.push(
        ...(filled.length
          ? filled
          : [
              {
                kind: 'lista' as const,
                title: p.title('Agenda'),
                items: [],
                empty: 'Nada marcado.',
              },
            ]),
      );
      return JSON.stringify(parts);
    }
    case 'retiradas': {
      need(c, 'retiradas.ver', 'as retiradas');
      const p = period(c, input);
      const rows = await prisma.pickupRequest.findMany({
        where: { status: { not: 'CANCELADA' }, scheduledDate: dayRange(p.from, p.to) },
        orderBy: [{ scheduledDate: 'asc' }, { routeSequence: 'asc' }, { windowStart: 'asc' }],
        select: {
          scheduledDate: true,
          windowStart: true,
          windowEnd: true,
          status: true,
          bringCardMachine: true,
          bringSamples: true,
          addressSnapshot: true,
          order: { select: { number: true, customer: { select: { name: true } } } },
        },
        take: 40,
      });
      const waiting = await prisma.pickupRequest.count({
        where: { status: 'AGUARDANDO_AGENDAMENTO' },
      });
      const items = rows.map((r) => {
        const a = asSnapshot(r.addressSnapshot);
        const when =
          `${p.from === p.to ? '' : `${day(d10(r.scheduledDate!))} `}${r.windowStart ? `${r.windowStart}${r.windowEnd ? ` às ${r.windowEnd}` : ''}` : 'sem horário'}`.trim();
        const take = [
          r.bringCardMachine && 'levar maquininha',
          r.bringSamples && 'levar mostruário',
        ]
          .filter(Boolean)
          .join(', ');
        return {
          title: `${r.order.customer.name} · ${orderCode(r.order.number)}`,
          detail: [
            when,
            a ? [a.district, a.city].filter(Boolean).join(', ') : '',
            PICKUP_STATUS_LABEL[r.status as PickupStatus] ?? r.status,
            take,
          ]
            .filter(Boolean)
            .join(' · '),
        };
      });
      c.cards.push({
        kind: 'lista',
        title: p.title('Retiradas'),
        items,
        empty: 'Nenhuma retirada marcada.',
      });
      return JSON.stringify({
        retiradas: items,
        total: items.length,
        esperando_data_marcada: waiting,
      });
    }
    case 'prazos': {
      const p = period(c, input);
      const orders = await prisma.commercialOrder.findMany({
        where: { status: { not: 'CANCELADO' }, promisedDate: dayRange(p.from, p.to) },
        orderBy: { promisedDate: 'asc' },
        select: {
          id: true,
          number: true,
          promisedDate: true,
          contractedService: true,
          customer: { select: { name: true } },
          serviceOrders: { select: { items: { select: { fulfillmentStage: true } } } },
        },
        take: 60,
      });
      const label = (s: string) => FULFILLMENT_STAGE_LABEL[s as FulfillmentStage] ?? s;
      const open = orders
        .map((o) => ({ o, items: o.serviceOrders.flatMap((s) => s.items) }))
        .filter(
          ({ items }) => !items.length || items.some((i) => !GONE.includes(i.fulfillmentStage)),
        );
      const items = open.slice(0, 30).map(({ o, items: its }) => {
        const stages = [
          ...new Set(
            its
              .filter((i) => !GONE.includes(i.fulfillmentStage))
              .map((i) => label(i.fulfillmentStage)),
          ),
        ];
        return {
          title: `${orderCode(o.number)} · ${o.customer.name}`,
          detail: `${o.contractedService} · prazo ${day(d10(o.promisedDate!))} · ${stages.length ? stages.join(', ') : 'OS ainda não gerada'}`,
          href: `/painel/pedidos/${o.id}`,
        };
      });
      c.cards.push({
        kind: 'lista',
        title: p.title('Prazos'),
        items,
        empty: 'Nenhum serviço com prazo nesse dia.',
      });
      return JSON.stringify(items);
    }
    case 'contas_a_pagar': {
      need(c, 'financeiro.ver', 'o financeiro');
      const p = period(c, input);
      const rows = await prisma.accountPayable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: dayRange(p.from, p.to) },
        orderBy: { dueDate: 'asc' },
        select: {
          beneficiary: true,
          description: true,
          amountCents: true,
          paidCents: true,
          dueDate: true,
        },
        take: 40,
      });
      const total = rows.reduce((t, r) => t + r.amountCents - r.paidCents, 0);
      const items = rows.map((r) => ({
        title: `${r.beneficiary} · ${brl(r.amountCents - r.paidCents)}`,
        detail: `${r.description} · vence ${day(d10(r.dueDate))}`,
      }));
      c.cards.push({
        kind: 'lista',
        title: `${p.title('Contas a pagar')}${rows.length ? ` · ${brl(total)}` : ''}`,
        items,
        empty: 'Nenhuma conta vencendo.',
      });
      return JSON.stringify({ contas: items, total: brl(total) });
    }
    case 'entregas': {
      const p = period(c, input);
      const { from, to } = p;
      const rows = await prisma.delivery.findMany({
        where: {
          status: { not: 'CANCELADA' },
          scheduledDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        orderBy: [{ scheduledDate: 'asc' }, { windowStart: 'asc' }],
        select: {
          scheduledDate: true,
          windowStart: true,
          status: true,
          customer: { select: { name: true } },
        },
        take: 40,
      });
      const items = rows.map((r) => ({
        title: r.customer.name,
        detail: `${day(d10(r.scheduledDate))}${r.windowStart ? ` a partir das ${r.windowStart}` : ''} · ${DELIVERY_STATUS_LABEL[r.status as DeliveryStatus] ?? r.status}`,
      }));
      c.cards.push({
        kind: 'lista',
        title: p.title('Entregas'),
        items,
        empty: 'Nenhuma entrega marcada.',
      });
      return JSON.stringify(items);
    }
    case 'atrasados': {
      const orders = await prisma.commercialOrder.findMany({
        where: {
          status: { not: 'CANCELADO' },
          promisedDate: { lt: new Date(`${c.today}T00:00:00Z`) },
        },
        orderBy: { promisedDate: 'asc' },
        select: {
          id: true,
          number: true,
          promisedDate: true,
          contractedService: true,
          customer: { select: { name: true } },
          serviceOrders: { select: { items: { select: { fulfillmentStage: true } } } },
        },
        take: 100,
      });
      const late = orders.filter((o) => {
        const items = o.serviceOrders.flatMap((s) => s.items);
        return !items.length || items.some((i) => !GONE.includes(i.fulfillmentStage));
      });
      const items = late.slice(0, 20).map((o) => {
        const days = Math.round(
          (new Date(`${c.today}T00:00:00Z`).getTime() - o.promisedDate!.getTime()) / 86_400_000,
        );
        return {
          title: `${orderCode(o.number)} · ${o.customer.name}`,
          detail: `${o.contractedService} · prometido para ${br(d10(o.promisedDate!))} (${days} ${days === 1 ? 'dia' : 'dias'} de atraso)`,
          href: `/painel/pedidos/${o.id}`,
        };
      });
      c.cards.push({
        kind: 'lista',
        title: 'Serviços atrasados',
        items,
        empty: 'Nenhum serviço passou do prazo.',
      });
      let payers: { nome: string; valor: string; venceu: string }[] = [];
      if (c.perms.has('financeiro.ver')) {
        const rec = await prisma.customerReceivable.findMany({
          where: {
            status: { in: ['ABERTO', 'PARCIAL'] },
            dueDate: { lt: new Date(`${c.today}T00:00:00Z`) },
          },
          orderBy: { dueDate: 'asc' },
          select: {
            dueDate: true,
            amountCents: true,
            receivedCents: true,
            customer: { select: { name: true } },
          },
          take: 20,
        });
        payers = rec.map((r) => ({
          nome: r.customer.name,
          valor: brl(r.amountCents - r.receivedCents),
          venceu: r.dueDate ? br(d10(r.dueDate)) : '',
        }));
        if (payers.length)
          c.cards.push({
            kind: 'lista',
            title: 'Clientes com pagamento vencido',
            items: payers.map((p) => ({
              title: p.nome,
              detail: `${p.valor} · venceu ${p.venceu}`,
            })),
          });
      }
      return JSON.stringify({
        servicos_atrasados: items,
        total: late.length,
        pagamentos_vencidos: payers,
      });
    }
    case 'comprar': {
      const needs = (await purchaseNeeds(prisma)).filter((n) => !n.available);
      const items = needs.slice(0, 30).map((n) => ({
        title: `${n.description}${n.quantity ? ` · ${n.quantity}` : ''}`,
        detail: `${n.osCode}${n.customerName ? ` (${n.customerName})` : ''}${n.supplierName ? ` · ${n.supplierName}` : ''}`,
      }));
      c.cards.push({
        kind: 'lista',
        title: 'Falta comprar',
        items,
        empty: 'Nada para comprar agora.',
      });
      return JSON.stringify(items);
    }
    case 'producao': {
      const rows = await prisma.serviceOrderItem.findMany({
        where: { fulfillmentStage: { notIn: GONE }, serviceOrder: { status: 'ABERTA' } },
        select: {
          description: true,
          fulfillmentStage: true,
          serviceOrder: { select: { number: true, customer: { select: { name: true } } } },
        },
        take: 200,
      });
      const label = (s: string) => FULFILLMENT_STAGE_LABEL[s as FulfillmentStage] ?? s;
      const by = new Map<string, number>();
      for (const r of rows)
        by.set(label(r.fulfillmentStage), (by.get(label(r.fulfillmentStage)) ?? 0) + 1);
      c.cards.push({
        kind: 'numeros',
        title: `Na oficina agora: ${rows.length} ${rows.length === 1 ? 'peça' : 'peças'}`,
        rows: [...by.entries()].map(([k, n]) => ({ label: k, value: String(n) })),
      });
      return JSON.stringify(
        rows.slice(0, 60).map((r) => ({
          os: serviceOrderCode(r.serviceOrder.number),
          cliente: r.serviceOrder.customer.name,
          peca: r.description,
          etapa: label(r.fulfillmentStage),
        })),
      );
    }
    case 'cliente': {
      const q = normalizeSearch(input.nome ?? '').trim();
      if (q.length < 2) return 'Diga pelo menos duas letras do nome.';
      const found = await prisma.customer.findMany({
        where: { active: true, AND: q.split(/\s+/).map((t) => ({ searchText: { contains: t } })) },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          phone: true,
          whatsapp: true,
          orders: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: {
              number: true,
              contractedService: true,
              agreedValueCents: true,
              status: true,
              createdAt: true,
            },
          },
        },
        take: 5,
      });
      const money = c.perms.has('financeiro.ver') || c.perms.has('pedidos.gerenciar');
      c.cards.push({
        kind: 'lista',
        title: found.length === 1 ? found[0]!.name : `Clientes com "${input.nome}"`,
        items: found.flatMap((f) =>
          f.orders.length
            ? f.orders.map((o) => ({
                title: `${orderCode(o.number)} · ${found.length > 1 ? `${f.name} · ` : ''}${o.contractedService}`,
                detail: `${br(d10(o.createdAt))}${money && o.agreedValueCents ? ` · ${brl(o.agreedValueCents)}` : ''}${o.status === 'CANCELADO' ? ' · cancelado' : ''}`,
              }))
            : [{ title: f.name, detail: 'Sem serviços ainda.' }],
        ),
        empty: 'Nenhum cliente com esse nome.',
      });
      return JSON.stringify(
        found.map((f) => ({
          id: f.id,
          nome: f.name,
          tem_whatsapp: !!whatsappNumber(f.whatsapp || f.phone),
          servicos: f.orders.map((o) => ({
            pedido: orderCode(o.number),
            servico: o.contractedService,
            valor: money && o.agreedValueCents ? brl(o.agreedValueCents) : undefined,
            data: d10(o.createdAt),
            cancelado: o.status === 'CANCELADO',
          })),
        })),
      );
    }
    case 'pedir_orcamento': {
      need(c, 'orcamentos.gerenciar', 'e montar orçamentos');
      const r = await planQuoteProposal(prisma, c.actor, {
        customerName: (input.cliente ?? '').trim().slice(0, 160),
        phone: (input.telefone ?? '').trim().slice(0, 20),
        city: (input.cidade ?? '').trim().slice(0, 120),
        request: (input.pedido ?? '').trim().slice(0, 3000),
        photos: [],
      });
      c.cards.push({ kind: 'aprovar', proposalId: r.proposalId, title: r.title });
      return `Orçamento montado e deixado no Aprovar: ${r.title}`;
    }
    case 'pedir_mensagem': {
      const customer = await prisma.customer.findFirst({
        where: {
          id: /^[0-9a-f-]{36}$/i.test(input.cliente_id ?? '') ? input.cliente_id : undefined,
          active: true,
        },
        select: { id: true, name: true, phone: true, whatsapp: true },
      });
      if (!customer || !input.cliente_id)
        return 'Cliente não encontrado. Procure com a ferramenta cliente.';
      const phone = whatsappNumber(customer.whatsapp || customer.phone);
      if (!phone) return `${customer.name} não tem WhatsApp no cadastro.`;
      const text = (input.mensagem ?? '').trim().slice(0, 2000);
      if (!text) return 'Falta o texto da mensagem.';
      // Quem fala com cliente é o Atendimento; sem ele, o WhatsApp ou o Gerente.
      const agents = await prisma.aiAgent.findMany({
        where: { status: 'ATIVO', roleKey: { in: ['ATENDIMENTO', 'WHATSAPP', 'GERENTE'] } },
        orderBy: { createdAt: 'asc' },
      });
      const agent =
        ['ATENDIMENTO', 'WHATSAPP', 'GERENTE']
          .map((k) => agents.find((a) => a.roleKey === k))
          .find(Boolean) ?? null;
      if (!agent)
        return 'Contrate o Atendimento ou o Gerente no Escritório para preparar mensagens.';
      const title = `Mensagem para ${customer.name}`;
      const p = await prisma.$transaction(async (tx) => {
        const row = await tx.aiAgentProposal.create({
          data: {
            agentId: agent.id,
            kind: 'MENSAGEM_CLIENTE',
            title,
            detail: text,
            payload: {
              task: 'MENSAGEM_PEDIDA',
              channel: 'WHATSAPP',
              customerId: customer.id,
              customerName: customer.name,
              phone,
              text,
              fromChat: true,
            } as Prisma.InputJsonValue,
            evidence: [
              {
                type: 'CLIENTE',
                id: customer.id,
                label: customer.name,
                href: `/painel/clientes/${customer.id}`,
              },
            ] as Prisma.InputJsonValue,
          },
        });
        await audit(tx, c.actor, {
          action: 'game.chat_message_prepared',
          entityType: 'ai_agent_proposal',
          entityId: row.id,
          summary: `Mensagem para ${customer.name} pedida na conversa.`,
        });
        await appendEvent(tx, c.actor, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: agent.id,
          payload: { id: agent.id },
          audience: 'permission:agentes.usar|permission:agentes.gerenciar',
        });
        return row;
      });
      c.cards.push({ kind: 'aprovar', proposalId: p.id, title });
      return `Mensagem deixada no Aprovar: ${title}`;
    }
    default:
      return 'Ferramenta desconhecida.';
  }
}

const MAX_TURNS = 6;

export async function ownerChat(
  prisma: PrismaClient,
  perms: ReadonlySet<string>,
  actor: ActorContext,
  req: OwnerChatRequest,
): Promise<OwnerChatReplyDto> {
  const today = todayIso(await shopTimezone(prisma));
  const system = systemPrompt(await companyName(prisma), today);
  const ctx: Ctx = { prisma, perms, actor, today, cards: [] };
  const messages: Msg[] = req.messages.map((m) => ({ role: m.role, content: m.text }));
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let r: Anthropic.Beta.BetaMessage;
    try {
      r = await model({ system, tools: TOOLS, messages });
    } catch {
      throw Errors.business('A IA não respondeu agora. Tente de novo em instantes.');
    }
    if (r.stop_reason === 'refusal')
      return { reply: 'Isso eu não consigo responder.', cards: ctx.cards };
    const text = r.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const uses = r.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
    );
    if (r.stop_reason !== 'tool_use' || !uses.length)
      return { reply: text || 'Pronto.', cards: ctx.cards };
    messages.push({
      role: 'assistant',
      content: r.content as Anthropic.Beta.BetaContentBlockParam[],
    });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      try {
        const out = await runTool(ctx, u.name, (u.input ?? {}) as Record<string, string>);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out.slice(0, 20_000) });
      } catch (e) {
        const msg =
          e instanceof NoPermission
            ? e.message
            : e instanceof Error && 'statusCode' in e
              ? e.message
              : 'Não consegui buscar isso agora.';
        results.push({ type: 'tool_result', tool_use_id: u.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return {
    reply: 'Essa ficou comprida demais. Pergunte de novo de um jeito mais curto?',
    cards: ctx.cards,
  };
}

export async function ownerChatRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.post('/api/v1/office/chat', { config: { access: OFFICE_ACCESS } }, async (request) => {
    await officeGuard(prisma);
    const input = ownerChatRequestSchema.parse(request.body);
    if (!aiAvailable() && model === anthropicModel)
      throw Errors.conflict('A conversa precisa da IA ligada no servidor.');
    return ownerChat(prisma, request.auth!.permissions, actorFrom(request), input);
  });
}
