/**
 * Orçamento pelo pedido (agente de Orçamentos, 2026-11-25): o dono conta o pedido do cliente
 * (texto e até 3 fotos); a IA escolhe na tabela da empresa o serviço, os materiais com as medidas,
 * a mão de obra, a logística da cidade e o lucro (pelos orçamentos parecidos já feitos). A API
 * recalcula com as mesmas regras da tela de Orçamentos. Ao aprovar, o orçamento é salvo e o link
 * da proposta sai no WhatsApp do cliente; "Abrir no orçamento" leva o rascunho para a tela.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  EVENT_TYPES,
  QUOTE_OTHER_SERVICE,
  QUOTE_SERVICES,
  calcQuote,
  emptyQuoteDraft,
  officeQuoteRequestSchema,
  quoteCategoryEnabled,
  quoteDraftSchema,
  quoteSaveBlocker,
  quoteSendMessage,
  whatsappLink,
  whatsappNumber,
  type QuoteCatalogItemDto,
  type QuoteDraft,
} from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { publicLink } from '../../core/public-links';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { shopTimezone, todayIso } from '../finance/common';
import { catalogDtos, saveNewQuote, settingsDto } from '../quotes/routes';
import { aiAvailable, companyName } from './agent-office';
import { OFFICE_ACCESS, doAlone, officeGuard, officeOverview, routeOfNow } from './office';

/** O que a IA devolve (ids conferidos depois contra a tabela). */
export interface QuotePlan {
  service: string;
  serviceOther?: string | null;
  fabricChange: boolean;
  foamChange: boolean;
  sofaCount: number;
  items: {
    catalogItemId: string;
    qty: number;
    heightCm?: number;
    widthCm?: number;
    lengthCm?: number;
  }[];
  logisticsId: string | null;
  upholsteryServiceId: string | null;
  helperServiceId: string | null;
  profitReais: number;
  deliveryDays: number | null;
  feeId: string | null;
  /** Para o dono: como chegou no valor, em 2 a 4 linhas. */
  summary: string;
  /** O que faltou saber do cliente (medida, tecido escolhido…). */
  questions: string[];
}

interface PlanInput {
  request: string;
  city: string;
  photos: { mime: string; data: string }[];
  catalog: QuoteCatalogItemDto[];
  history: string;
}

type Planner = (i: PlanInput) => Promise<QuotePlan>;

const PLAN_TOOL = {
  name: 'montar_orcamento',
  description: 'Monta o orçamento com os itens da tabela da empresa.',
  input_schema: {
    type: 'object' as const,
    properties: {
      servico: { type: 'string', description: 'um dos serviços da lista, ou "Outro serviço"' },
      servico_outro: { type: ['string', 'null'] },
      troca_tecido: { type: 'boolean' },
      troca_espuma: { type: 'boolean' },
      quantidade_pecas: { type: 'integer', minimum: 1 },
      materiais: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            quantidade: { type: 'number', description: 'na unidade do material (espuma: peças)' },
            altura_cm: { type: 'number', description: 'só espuma' },
            largura_cm: { type: 'number', description: 'só espuma' },
            comprimento_cm: { type: 'number', description: 'só espuma' },
          },
          required: ['id', 'quantidade'],
        },
      },
      logistica_id: { type: ['string', 'null'] },
      tapeceiro_id: { type: ['string', 'null'] },
      ajudante_id: { type: ['string', 'null'] },
      lucro_reais: { type: 'number' },
      prazo_dias: { type: ['integer', 'null'] },
      taxa_id: { type: ['string', 'null'], description: 'modalidade parcelada mais comum' },
      resumo: { type: 'string', description: 'como chegou no valor, 2 a 4 linhas' },
      perguntas: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'servico',
      'troca_tecido',
      'troca_espuma',
      'quantidade_pecas',
      'materiais',
      'lucro_reais',
      'resumo',
      'perguntas',
    ],
  },
};

const catalogText = (c: QuoteCatalogItemDto[]) =>
  c
    .map((x) => {
      const price = x.priceCents === null ? 'sem preço' : `R$ ${(x.priceCents / 100).toFixed(2)}`;
      const extra =
        x.kind === 'MATERIAL'
          ? ` · ${x.category ?? ''} · ${x.unit ?? ''}`
          : x.kind === 'TAXA_MAQUINA'
            ? ` · taxa ${((x.rateBps ?? 0) / 100).toFixed(2)}%`
            : x.kind === 'LOGISTICA'
              ? ` · ${x.km ?? 0} km`
              : '';
      return `${x.kind} | ${x.id} | ${x.name}${extra} | ${price}`;
    })
    .join('\n');

const anthropicPlanner: Planner = async (i) => {
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  const r = await client.messages.create({
    model: process.env.GAME_AI_MODEL || 'claude-opus-5-5',
    max_tokens: 2000,
    tools: [PLAN_TOOL],
    tool_choice: { type: 'tool', name: PLAN_TOOL.name },
    system: [
      'Você monta orçamentos de uma tapeçaria brasileira (reforma e fabricação de estofados).',
      'Use SOMENTE itens da tabela abaixo, pelo id. Materiais: quantidade na unidade do material; espuma vai por peça com altura, largura e comprimento em cm (o volume é calculado).',
      'Tecido: some os metros pela peça (ex.: sofá 3 lugares ~ 8 a 10 m; poltrona ~ 3 a 4 m; cadeira ~ 0,6 m de assento). Só coloque tecido se troca_tecido, e espuma se troca_espuma.',
      'Escolha a logística da cidade do cliente, o serviço do tapeceiro e, se precisar, o do ajudante. O lucro segue os orçamentos parecidos já feitos.',
      `Serviços: ${QUOTE_SERVICES.join('; ')}; ${QUOTE_OTHER_SERVICE}.`,
      `Tabela (tipo | id | nome | preço):\n${catalogText(i.catalog)}`,
      i.history
        ? `Orçamentos parecidos já feitos:\n${i.history}`
        : 'Ainda não há orçamentos salvos.',
      'Se faltar informação (medida, modelo, tecido), estime pelo comum e coloque em perguntas.',
    ].join('\n\n'),
    messages: [
      {
        role: 'user',
        content: [
          ...i.photos.map((p) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: p.mime as 'image/jpeg' | 'image/png' | 'image/webp',
              data: p.data,
            },
          })),
          {
            type: 'text' as const,
            text: `Cidade do cliente: ${i.city || 'não informada'}\nPedido: ${i.request}`,
          },
        ],
      },
    ],
  });
  const block = r.content.find((b) => b.type === 'tool_use');
  const x = (block && 'input' in block ? block.input : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    service: s(x.servico) ?? QUOTE_OTHER_SERVICE,
    serviceOther: s(x.servico_outro),
    fabricChange: x.troca_tecido === true,
    foamChange: x.troca_espuma === true,
    sofaCount: Math.max(1, Math.round(n(x.quantidade_pecas))),
    items: (Array.isArray(x.materiais) ? x.materiais : []).map((m: Record<string, unknown>) => ({
      catalogItemId: String(m.id ?? ''),
      qty: n(m.quantidade),
      heightCm: n(m.altura_cm),
      widthCm: n(m.largura_cm),
      lengthCm: n(m.comprimento_cm),
    })),
    logisticsId: s(x.logistica_id),
    upholsteryServiceId: s(x.tapeceiro_id),
    helperServiceId: s(x.ajudante_id),
    profitReais: n(x.lucro_reais),
    deliveryDays: typeof x.prazo_dias === 'number' ? Math.round(x.prazo_dias) : null,
    feeId: s(x.taxa_id),
    summary: s(x.resumo) ?? '',
    questions: (Array.isArray(x.perguntas) ? x.perguntas : []).map(String).slice(0, 5),
  };
};

let planner: Planner = anthropicPlanner;
/** Testes: troca a IA por um plano fixo (null volta ao normal). */
export function setQuotePlanner(p: Planner | null) {
  planner = p ?? anthropicPlanner;
}

/** Link da proposta (o servidor assina); registrado junto com as rotas. */
let proposalLink: ((id: string) => string) | null = null;

/** Plano da IA → rascunho válido: só ids da tabela, do tipo certo; o resto fica de fora. */
export function draftFromPlan(
  plan: QuotePlan,
  req: { customerName: string; phone: string; city: string },
  catalog: QuoteCatalogItemDto[],
): QuoteDraft {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const ofKind = (id: string | null, kind: string) =>
    id && byId.get(id)?.kind === kind ? id : null;
  const service = (QUOTE_SERVICES as readonly string[]).includes(plan.service)
    ? plan.service
    : QUOTE_OTHER_SERVICE;
  const d: QuoteDraft = {
    ...emptyQuoteDraft(),
    customerName: req.customerName,
    phone: req.phone,
    city: req.city,
    service,
    serviceOther:
      service === QUOTE_OTHER_SERVICE ? (plan.serviceOther || plan.service).slice(0, 120) : '',
    fabricChange: plan.fabricChange,
    foamChange: plan.foamChange,
    sofaCount: Math.min(1000, Math.max(1, plan.sofaCount)),
    items: plan.items
      .filter((i) => byId.get(i.catalogItemId)?.kind === 'MATERIAL' && i.qty > 0)
      .filter((i) => quoteCategoryEnabled(byId.get(i.catalogItemId)!.category, plan))
      .slice(0, 60)
      .map((i, n) => ({
        id: `ia-${n + 1}`,
        catalogItemId: i.catalogItemId,
        qty: Math.min(1_000_000, Math.round(i.qty * 100) / 100),
        heightCm: Math.max(0, i.heightCm ?? 0),
        widthCm: Math.max(0, i.widthCm ?? 0),
        lengthCm: Math.max(0, i.lengthCm ?? 0),
      })),
    logisticsId: ofKind(plan.logisticsId, 'LOGISTICA'),
    upholsteryServiceId: ofKind(plan.upholsteryServiceId, 'MAO_TAPECEIRO'),
    helperServiceId: ofKind(plan.helperServiceId, 'MAO_AJUDANTE'),
    feeId: ofKind(plan.feeId, 'TAXA_MAQUINA'),
    profitCents: Math.max(0, Math.round(plan.profitReais * 100)),
    deliveryDays:
      plan.deliveryDays && plan.deliveryDays > 0 ? Math.min(365, plan.deliveryDays) : null,
  };
  return quoteDraftSchema.parse(d);
}

/** Últimos orçamentos salvos, em linhas curtas (para o lucro seguir o que a empresa pratica). */
async function historyText(db: Tx | Prisma.TransactionClient) {
  const rows = await db.quote.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { service: true, totalCents: true, snapshot: true, status: true },
  });
  return rows
    .map((q) => {
      const s = (q.snapshot ?? {}) as {
        sofaCount?: number;
        totals?: { costCents?: number; profitCents?: number };
      };
      return `${q.service} · ${s.sofaCount ?? 1} peça(s) · custo R$ ${((s.totals?.costCents ?? 0) / 100).toFixed(0)} · lucro R$ ${((s.totals?.profitCents ?? 0) / 100).toFixed(0)} · total R$ ${(q.totalCents / 100).toFixed(0)} · ${q.status}`;
    })
    .join('\n');
}

/** Aprovar: salva o orçamento e põe o link na mensagem (que sai pelo WhatsApp a seguir). */
export async function saveApprovedQuote(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { payload: unknown; detail: string },
  editedText: string | undefined,
) {
  if (!perms.has('orcamentos.gerenciar'))
    throw Errors.forbidden('Salvar orçamento exige a permissão de orçamentos.');
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  if (pl.quoteId) throw Errors.conflict('Este orçamento já foi salvo.');
  const draft = quoteDraftSchema.parse(pl.draft);
  const q = await saveNewQuote(tx, actor, draft);
  const link = proposalLink ? proposalLink(q.id) : '';
  const text = String(editedText ?? pl.text ?? p.detail).replace('{link}', link);
  return {
    quoteId: q.id,
    quoteNumber: q.number,
    link,
    text,
    href: pl.phone ? whatsappLink(String(pl.phone), text) : null,
  };
}

export async function quoteAgentRoutes(app: FastifyInstance) {
  const { prisma, env, hashToken } = app.ctx;
  proposalLink = (id) => publicLink(env, hashToken, 'proposta', id);

  app.post(
    '/api/v1/office/quote',
    {
      bodyLimit: 8 * 1024 * 1024,
      config: {
        access: {
          session: 'WEB',
          permissions: [...OFFICE_ACCESS.permissions, 'orcamentos.gerenciar'],
        },
      },
    },
    async (request, reply) => {
      await officeGuard(prisma);
      const input = officeQuoteRequestSchema.parse(request.body);
      const agent = await prisma.aiAgent.findFirst({
        where: { status: 'ATIVO', roleKey: 'ORCAMENTOS' },
        orderBy: { createdAt: 'asc' },
      });
      if (!agent)
        throw Errors.conflict(
          'Contrate o agente de Orçamentos no Escritório para montar pelo pedido.',
        );
      if (!aiAvailable() && planner === anthropicPlanner)
        throw Errors.conflict('Montar orçamento pelo pedido precisa da IA ligada no servidor.');
      const [catalog, settings, history, company] = await Promise.all([
        catalogDtos(prisma),
        settingsDto(prisma),
        historyText(prisma),
        companyName(prisma),
      ]);
      if (!catalog.some((c) => c.kind === 'MATERIAL' && c.priceCents !== null))
        throw Errors.business(
          'Cadastre os materiais com preço na Base de dados do orçamento antes de pedir ao agente.',
        );
      let plan: QuotePlan;
      try {
        plan = await planner({
          request: input.request,
          city: input.city,
          photos: input.photos.map((d) => ({
            mime: d.slice(5, d.indexOf(';')),
            data: d.slice(d.indexOf(',') + 1),
          })),
          catalog,
          history,
        });
      } catch {
        throw Errors.business('A IA não conseguiu montar agora. Tente de novo em instantes.');
      }
      const draft = draftFromPlan(plan, input, catalog);
      const totals = calcQuote(draft, catalog, settings.taxRateBps);
      const blocker = quoteSaveBlocker(draft, totals);
      const totalCents = Math.round((totals.total ?? 0) * 100);
      const service = draft.service === QUOTE_OTHER_SERVICE ? draft.serviceOther : draft.service;
      const fee = draft.feeId ? catalog.find((c) => c.id === draft.feeId) : null;
      const text = quoteSendMessage({
        customerName: input.customerName,
        service,
        totalCents,
        installments:
          totals.installments > 1 && totals.installmentTotal
            ? {
                count: totals.installments,
                totalCents: Math.round(totals.installmentTotal * 100),
              }
            : null,
        companyName: company,
      });
      const brl = (c: number) =>
        (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const phone = input.phone ? whatsappNumber(input.phone) : null;
      const actor = actorFrom(request);
      const today = todayIso(await shopTimezone(prisma));
      const row = await prisma.$transaction(async (tx) => {
        const p = await tx.aiAgentProposal.create({
          data: {
            agentId: agent.id,
            kind: 'MONTAR_ORCAMENTO',
            title:
              `Orçamento para ${input.customerName}: ${service} · ${totalCents ? brl(totalCents) : 'faltam preços'}`.slice(
                0,
                200,
              ),
            detail: text,
            payload: {
              task: 'MONTAR_ORCAMENTO',
              draft,
              request: input.request,
              customerName: input.customerName,
              phone,
              text,
              channel: 'WHATSAPP',
              totalCents,
              costCents: Math.round(totals.cost * 100),
              profitCents: Math.round(totals.profit * 100),
              materialsCents: Math.round(totals.materials * 100),
              laborCents: Math.round(totals.labor * 100),
              logisticsCents: Math.round(totals.logistics * 100),
              installments: totals.installments,
              installmentTotalCents: totals.installmentTotal
                ? Math.round(totals.installmentTotal * 100)
                : null,
              feeName: fee?.name ?? null,
              summary: plan.summary.slice(0, 1000),
              questions: plan.questions,
              blocker,
              lines: draft.items.map((i) => {
                const m = catalog.find((c) => c.id === i.catalogItemId)!;
                return m.category === 'Espumas'
                  ? `${m.name}: ${i.qty} peça(s) ${i.heightCm}×${i.widthCm}×${i.lengthCm} cm`
                  : `${m.name}: ${i.qty} ${m.unit ?? ''}`.trim();
              }),
              photoCount: input.photos.length,
            } as Prisma.InputJsonValue,
            evidence: [] as Prisma.InputJsonValue,
          },
        });
        await audit(tx, actor, {
          action: 'game.quote_planned',
          entityType: 'ai_agent_proposal',
          entityId: p.id,
          summary: `Orçamento montado pelo agente para ${input.customerName} (${service}).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: agent.id,
          payload: { id: agent.id },
          audience: 'permission:agentes.usar|permission:agentes.gerenciar',
        });
        return p;
      });
      let doneAlone = false;
      if (!blocker && (await routeOfNow(prisma, agent.id, row)) === 'SOZINHO')
        doneAlone = await doAlone(prisma, row, agent, today);
      return reply
        .status(201)
        .send({ proposalId: row.id, doneAlone, overview: await officeOverview(prisma) });
    },
  );
}
