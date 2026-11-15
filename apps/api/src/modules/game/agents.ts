/**
 * Agentes do escritório: configuração (função, instruções, dados consultáveis, política de
 * ações), conversa, tarefas e propostas pendentes de aprovação.
 *
 * Regras:
 * - o agente só lê o que o escopo dele libera E o que a conta de quem pergunta pode ver;
 * - ações (comprar, enviar mensagem, publicar, pagar, emitir nota) nunca são executadas pelo
 *   agente: viram propostas. Aprovar leva ao fluxo oficial do Cenário Gestão (já preenchido) ou,
 *   para integrações externas não configuradas, fica registrada como execução de TESTE.
 */
import {
  type AgentConversationDto,
  type AgentDto,
  type AgentMessageDto,
  type AgentProposalDto,
  type AgentReference,
  EVENT_TYPES,
  type IntegrationDto,
  agentMessageSchema,
  agentSchema,
  decideProposalSchema,
  updateAgentSchema,
} from '@cenario/shared';
import type { AiAgent, Prisma, PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  type AgentAnswer,
  integrationPendingAnswer,
  managerAnswer,
  purchasingAnswer,
} from './agent-engines';
import { requireConnection } from '../integrations/connections';
import { updateDailyBudget } from '../integrations/meta';
import { PROVIDERS, missingEnv } from '../integrations/registry';
import { channelAgentAnswer } from './agent-channels';
import { AGENT_TEMPLATES } from './agent-templates';
import { obsoleteReason, refreshPending } from './proposal-validity';
import { AGENT_MANAGE, AGENT_USE, GAME_ACCESS, ensureDefaultSpaces } from './common';

const AGENT_AUDIENCE = 'permission:agentes.usar|permission:agentes.gerenciar' as const;

/** Estado das conexões da Central (mesma fonte que o painel), no formato dos agentes. */
async function integrations(prisma: PrismaClient): Promise<IntegrationDto[]> {
  const rows = await prisma.integrationConnection.findMany();
  const list: IntegrationDto[] = PROVIDERS.filter((p) => p.auth !== 'PLANEJADA').map((p) => {
    const c = rows.find((r) => r.providerKey === p.key);
    if (p.auth === 'SESSAO')
      return { key: p.key, label: p.label, status: 'CONECTADA', detail: p.capabilities.join('; ') };
    if (c?.status === 'CONECTADA')
      return {
        key: p.key,
        label: p.label,
        status: c.mode === 'TESTE_LOCAL' ? 'MODO_TESTE' : 'CONECTADA',
        detail: c.accountLabel ?? p.provider,
      };
    const missing = missingEnv(p).map((m) => m.name);
    return {
      key: p.key,
      label: p.label,
      status: 'PRECISA_CONFIGURAR',
      detail: missing.length
        ? `Conecte na Central de Conexões. Falta no servidor: ${missing.join(', ')}.`
        : 'Conecte na Central de Conexões.',
    };
  });
  list.push({
    key: 'LLM',
    label: 'Modelo de linguagem (respostas livres)',
    status: process.env.ANTHROPIC_API_KEY?.trim() ? 'CONECTADA' : 'PRECISA_CONFIGURAR',
    detail:
      'Opcional: os agentes usam regras sobre os dados do Cenário; o modelo só interpreta frases livres.',
  });
  return list;
}

const engineOf = (a: AiAgent): AgentDto['engine'] =>
  ['GERENTE', 'COMPRAS', 'ATENDIMENTO', 'MARKETING', 'TRAFEGO', 'DOCUMENTOS'].includes(a.roleKey)
    ? 'DADOS_CENARIO'
    : a.roleKey === 'PERSONALIZADA'
      ? 'INSTRUCOES'
      : 'AGUARDANDO_INTEGRACAO';

function toDto(a: AiAgent & { _count?: { proposals: number } }): AgentDto {
  return {
    id: a.id,
    name: a.name,
    roleKey: a.roleKey,
    roleLabel: a.roleLabel,
    instructions: a.instructions,
    dataScopes: a.dataScopes,
    actionPolicies: (a.actionPolicies ?? {}) as Record<string, string>,
    status: a.status as AgentDto['status'],
    color: a.color,
    deskStationId: a.deskStationId,
    version: a.version,
    pendingProposals: a._count?.proposals ?? 0,
    engine: engineOf(a),
    channelPolicies: (a.channelPolicies ?? {}) as Record<string, string>,
    autoSendRules: (a.autoSendRules ?? []) as string[],
  };
}

const pendingCount = {
  _count: { select: { proposals: { where: { status: 'PENDENTE' } } } },
} as const;

const msgDto = (m: {
  id: string;
  author: string;
  content: string;
  references: unknown;
  createdAt: Date;
}): AgentMessageDto => ({
  id: m.id,
  author: m.author as AgentMessageDto['author'],
  content: m.content,
  references: (m.references ?? []) as AgentReference[],
  createdAt: m.createdAt.toISOString(),
});

const proposalDto = (p: {
  id: string;
  kind: string;
  title: string;
  detail: string;
  payload: unknown;
  evidence: unknown;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}): AgentProposalDto => ({
  id: p.id,
  kind: p.kind,
  title: p.title,
  detail: p.detail,
  payload: (p.payload ?? {}) as Record<string, unknown>,
  evidence: (p.evidence ?? []) as AgentReference[],
  status: p.status as AgentProposalDto['status'],
  createdAt: p.createdAt.toISOString(),
  decidedAt: p.decidedAt?.toISOString() ?? null,
  decisionNote: p.decisionNote,
});

/** Gerente e Compras nascem junto com o escritório sugerido (ensureDefaultSpaces). */
const ensureDefaultAgents = (prisma: PrismaClient) => ensureDefaultSpaces(prisma);

async function answer(
  prisma: PrismaClient,
  agent: AiAgent,
  permissions: ReadonlySet<string>,
  question: string,
): Promise<AgentAnswer> {
  const ctx = {
    prisma,
    permissions,
    dataScopes: agent.dataScopes,
    policies: (agent.actionPolicies ?? {}) as Record<string, string>,
  };
  const channel = await channelAgentAnswer(prisma, agent, permissions, question);
  if (channel) return channel;
  if (agent.roleKey === 'GERENTE') return managerAnswer(ctx, question);
  if (agent.roleKey === 'COMPRAS') return purchasingAnswer(ctx, question);
  const t = AGENT_TEMPLATES.find((x) => x.roleKey === agent.roleKey);
  const pending = (await integrations(prisma)).filter(
    (i) => t?.integrations.includes(i.key) && i.status === 'PRECISA_CONFIGURAR',
  );
  return integrationPendingAnswer(
    agent.roleLabel,
    pending.map((p) => p.label),
    agent.instructions,
  );
}

export async function gameAgentRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/game/integrations', { config: { access: GAME_ACCESS } }, () =>
    integrations(prisma),
  );
  app.get(
    '/api/v1/game/agent-templates',
    { config: { access: GAME_ACCESS } },
    () => AGENT_TEMPLATES,
  );

  app.get('/api/v1/game/agents', { config: { access: GAME_ACCESS } }, async () => {
    await ensureDefaultAgents(prisma);
    const rows = await prisma.aiAgent.findMany({
      include: pendingCount,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toDto);
  });

  app.post(
    '/api/v1/game/agents',
    { config: { access: AGENT_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = agentSchema.parse(request.body);
      const actor = actorFrom(request);
      const a = await prisma.$transaction(async (tx) => {
        if (input.deskStationId) await assertDesk(tx, input.deskStationId, null);
        const created = await tx.aiAgent.create({
          data: {
            name: input.name,
            roleKey: input.roleKey,
            roleLabel: input.roleLabel,
            instructions: input.instructions,
            dataScopes: input.dataScopes,
            actionPolicies: input.actionPolicies as Prisma.InputJsonValue,
            channelPolicies: input.channelPolicies as Prisma.InputJsonValue,
            autoSendRules: input.autoSendRules as Prisma.InputJsonValue,
            color: input.color,
            deskStationId: input.deskStationId ?? null,
            createdById: actor.userId,
          },
          include: pendingCount,
        });
        await audit(tx, actor, {
          action: 'game.agent_created',
          entityType: 'ai_agent',
          entityId: created.id,
          summary: `Agente "${created.name}" (${created.roleLabel}) criado.`,
          changes: {
            dataScopes: input.dataScopes,
            actionPolicies: input.actionPolicies,
            channelPolicies: input.channelPolicies,
            autoSendRules: input.autoSendRules,
          },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_AGENT_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: created.id,
          payload: { id: created.id },
          audience: AGENT_AUDIENCE,
        });
        return created;
      });
      return reply.status(201).send(toDto(a));
    },
  );

  app.put(
    '/api/v1/game/agents/:id',
    { config: { access: AGENT_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = updateAgentSchema.parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ai_agents WHERE id = ${id}::uuid FOR UPDATE`;
        const cur = await tx.aiAgent.findUnique({ where: { id } });
        if (!cur) throw Errors.notFound('Agente');
        if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
        if (input.deskStationId) await assertDesk(tx, input.deskStationId, id);
        const { version: _v, ...rest } = input;
        void _v;
        const u = await tx.aiAgent.update({
          where: { id },
          data: {
            ...rest,
            actionPolicies: rest.actionPolicies as Prisma.InputJsonValue | undefined,
            channelPolicies: rest.channelPolicies as Prisma.InputJsonValue | undefined,
            autoSendRules: rest.autoSendRules as Prisma.InputJsonValue | undefined,
            version: { increment: 1 },
          },
          include: pendingCount,
        });
        const changed = Object.keys(rest).filter(
          (k) =>
            JSON.stringify((rest as Record<string, unknown>)[k]) !==
            JSON.stringify((cur as Record<string, unknown>)[k]),
        );
        await audit(tx, actor, {
          action: 'game.agent_updated',
          entityType: 'ai_agent',
          entityId: id,
          summary: `Agente "${u.name}" alterado: ${changed.join(', ') || 'sem mudanças'}${input.status && input.status !== cur.status ? ` (${cur.status} → ${input.status})` : ''}.`,
          changes: { fields: changed },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_AGENT_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: id,
          payload: { id },
          audience: AGENT_AUDIENCE,
        });
        return toDto(u);
      });
    },
  );

  app.get(
    '/api/v1/game/agents/:id/conversation',
    { config: { access: AGENT_USE } },
    async (request): Promise<AgentConversationDto> => {
      const { id } = idParams.parse(request.params);
      if (!(await prisma.aiAgent.findUnique({ where: { id } }))) throw Errors.notFound('Agente');
      // Propostas antigas que os dados já resolveram ficam marcadas como desatualizadas.
      await refreshPending(prisma, id);
      const a = await prisma.aiAgent.findUnique({ where: { id }, include: pendingCount });
      if (!a) throw Errors.notFound('Agente');
      const [messages, proposals] = await Promise.all([
        prisma.aiAgentMessage.findMany({
          where: { agentId: id },
          orderBy: { createdAt: 'desc' },
          take: 40,
        }),
        prisma.aiAgentProposal.findMany({
          where: { agentId: id },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
      ]);
      // Tarefas e pendências: leitura atual (sem gravar nada).
      const live =
        a.status === 'ATIVO' ? await answer(prisma, a, request.auth!.permissions, '') : null;
      return {
        agent: toDto(a),
        messages: messages.reverse().map(msgDto),
        proposals: proposals.map(proposalDto),
        tasks: live?.tasks ?? [
          {
            label: a.status === 'PAUSADO' ? 'Agente pausado' : 'Agente desativado',
            detail: 'Reative na configuração para ele voltar a trabalhar.',
            tone: 'atencao',
          },
        ],
      };
    },
  );

  app.post(
    '/api/v1/game/agents/:id/messages',
    { config: { access: AGENT_USE, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = agentMessageSchema.parse(request.body);
      const actor = actorFrom(request);
      const a = await prisma.aiAgent.findUnique({ where: { id } });
      if (!a) throw Errors.notFound('Agente');
      if (a.status === 'DESATIVADO') throw Errors.business('Este agente está desativado.');
      const result: AgentAnswer =
        a.status === 'PAUSADO'
          ? {
              content: 'Estou pausado. Quando você me reativar, eu volto a olhar os dados.',
              references: [],
              proposals: [],
              tasks: [],
            }
          : await answer(prisma, a, request.auth!.permissions, input.content);
      const saved = await prisma.$transaction(async (tx) => {
        const mine = await tx.aiAgentMessage.create({
          data: { agentId: id, userId: actor.userId, author: 'USUARIO', content: input.content },
        });
        const reply = await tx.aiAgentMessage.create({
          data: {
            agentId: id,
            author: 'AGENTE',
            content: result.content.slice(0, 20000),
            references: result.references as unknown as Prisma.InputJsonValue,
          },
        });
        await refreshPending(tx, id);
        // Propostas novas (não duplica proposta pendente igual).
        for (const p of result.proposals) {
          const same = await tx.aiAgentProposal.findFirst({
            where: { agentId: id, status: 'PENDENTE', kind: p.kind, title: p.title },
          });
          if (same) continue;
          await tx.aiAgentProposal.create({
            data: {
              agentId: id,
              kind: p.kind,
              title: p.title.slice(0, 200),
              detail: p.detail.slice(0, 4000),
              payload: p.payload as Prisma.InputJsonValue,
              evidence: p.evidence as unknown as Prisma.InputJsonValue,
            },
          });
        }
        await audit(tx, actor, {
          action: 'game.agent_consulted',
          entityType: 'ai_agent',
          entityId: id,
          summary: `Consulta ao agente "${a.name}": ${input.content.slice(0, 120)}`,
          changes: { references: result.references.length, proposals: result.proposals.length },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: id,
          payload: { id },
          audience: AGENT_AUDIENCE,
        });
        return [mine, reply];
      });
      return reply.status(201).send(saved.map(msgDto));
    },
  );

  app.post(
    '/api/v1/game/proposals/:id/decide',
    { config: { access: AGENT_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = decideProposalSchema.parse(request.body);
      const actor = actorFrom(request);
      // Revalida no momento da aprovação: se os dados mudaram, a proposta caduca (e não executa).
      const pre = await prisma.aiAgentProposal.findUnique({ where: { id } });
      if (pre?.status === 'PENDENTE' && input.decision === 'APROVAR') {
        const why = await obsoleteReason(prisma, pre);
        if (why) {
          await prisma.$transaction(async (tx) => {
            await tx.aiAgentProposal.updateMany({
              where: { id, status: 'PENDENTE' },
              data: {
                status: 'OBSOLETA',
                decidedAt: new Date(),
                decisionNote: `Desatualizada: ${why}`.slice(0, 500),
              },
            });
            await audit(tx, actor, {
              action: 'game.proposal_obsolete',
              entityType: 'ai_agent_proposal',
              entityId: id,
              summary: `Proposta "${pre.title}" não aprovada: ${why}`,
            });
            await appendEvent(tx, actor, {
              type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
              aggregateType: 'ai_agent',
              aggregateId: pre.agentId,
              payload: { id: pre.agentId },
              audience: AGENT_AUDIENCE,
            });
          });
          throw Errors.conflict(`Proposta desatualizada: ${why}`, { obsolete: true });
        }
      }
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ai_agent_proposals WHERE id = ${id}::uuid FOR UPDATE`;
        const p = await tx.aiAgentProposal.findUnique({ where: { id }, include: { agent: true } });
        if (!p) throw Errors.notFound('Proposta');
        if (p.status !== 'PENDENTE') throw Errors.conflict('Esta proposta já foi decidida.');
        // Ações externas sem integração configurada: a aprovação só registra a execução de teste.
        const external = [
          'ENVIAR_MENSAGEM',
          'PUBLICAR_POST',
          'EMITIR_NOTA',
          'REGISTRAR_PAGAMENTO',
        ].includes(p.kind);
        let status: 'REJEITADA' | 'EXECUTADA_TESTE' | 'APROVADA' =
          input.decision === 'REJEITAR' ? 'REJEITADA' : external ? 'EXECUTADA_TESTE' : 'APROVADA';
        // Tráfego: a mudança de orçamento só é aplicada no Meta Ads depois desta aprovação.
        if (p.kind === 'ALTERAR_ORCAMENTO' && input.decision !== 'REJEITAR') {
          if (!request.auth!.permissions.has('anuncios.gerenciar'))
            throw Errors.forbidden('Aprovar mudança de orçamento exige a permissão de anúncios.');
          const pl = p.payload as {
            campaignId: string;
            campaignName: string;
            fromCents: number;
            toCents: number;
          };
          const c = await requireConnection(tx, 'META_ADS');
          const r = await updateDailyBudget(
            {
              providerKey: c.providerKey,
              mode: c.mode,
              config: c.config,
              secret: c.secret as never,
            },
            pl.campaignId,
            pl.toCents,
          );
          status = r.test ? 'EXECUTADA_TESTE' : 'APROVADA';
          await tx.agentAction.create({
            data: {
              agentId: p.agentId,
              channel: 'META_ADS',
              accountLabel: c.accountLabel,
              kind: 'ALTERAR_ORCAMENTO',
              summary: `Orçamento diário de "${pl.campaignName}": ${pl.fromCents / 100} → ${pl.toCents / 100} reais`,
              content: p.detail,
              status: r.test ? 'EXECUTADO_TESTE' : 'EXECUTADO',
              approvedById: actor.userId,
              ref: { proposalId: p.id, campaignId: pl.campaignId },
            },
          });
        }
        const u = await tx.aiAgentProposal.update({
          where: { id },
          data: {
            status,
            decidedById: actor.userId,
            decidedAt: new Date(),
            decisionNote: input.note ?? null,
          },
        });
        await audit(tx, actor, {
          action: 'game.proposal_decided',
          entityType: 'ai_agent_proposal',
          entityId: id,
          summary: `Proposta "${p.title}" do agente ${p.agent.name}: ${status}.`,
          changes: { kind: p.kind, status },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: p.agentId,
          payload: { id: p.agentId },
          audience: AGENT_AUDIENCE,
        });
        return proposalDto(u);
      });
    },
  );
}

async function assertDesk(tx: Prisma.TransactionClient, stationId: string, agentId: string | null) {
  const st = await tx.gameStation.findUnique({ where: { id: stationId } });
  if (!st || !st.active) throw Errors.validation(undefined, 'Mesa não encontrada.');
  if (st.kind !== 'MESA_ESCRITORIO')
    throw Errors.validation(undefined, 'Agente só senta em mesa de escritório.');
  const other = await tx.aiAgent.findFirst({
    where: {
      deskStationId: stationId,
      status: { not: 'DESATIVADO' },
      id: agentId ? { not: agentId } : undefined,
    },
  });
  if (other) throw Errors.conflict(`A mesa já é do agente ${other.name}.`);
}
