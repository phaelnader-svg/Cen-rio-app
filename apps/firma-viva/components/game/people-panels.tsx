'use client';
import {
  ACTIVITY_LABEL_GAME,
  AGENT_ACTIONS,
  AGENT_DATA_SCOPES,
  AGENT_CHANNELS,
  AGENT_POLICY,
  pieceWorkflow,
  AUTO_SEND_RULES,
  CHANNEL_POLICY,
  type AgentDto,
  type AgentRoleTemplate,
  type GameEmployeeDto,
  type GameSnapshotDto,
  type LayoutContent,
} from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { iconText } from './icons';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useAgentTemplates, useConversation, useIntegrations, useSuppliers } from './game-api';
import { SuppliersSection, WhatsAppProposal } from './agent-whatsapp';
import { cenarioUrl } from '@/lib/links';
import { AgentActions } from './office-panels';
import { GBtn, KV, Panel, Section, TASK_STATUS_LABEL, Tone, fmtDateTime } from './ui';

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  MESSENGER: 'Messenger',
  META_ADS: 'Meta Ads',
};
const CHANNEL_POLICY_LABEL: Record<string, string> = {
  NENHUM: 'Sem acesso',
  CONSULTAR: 'Consultar',
  RASCUNHO: 'Preparar rascunho',
  EXECUTAR: 'Executar (regras liberadas)',
};
const AUTO_SEND_LABEL: Record<string, string> = {
  PEDIR_FOTOS_MEDIDAS: 'Pedir fotos e medidas quando faltarem',
  CONFIRMAR_RECEBIMENTO: 'Confirmar recebimento de fotos',
};

const ATTENDANCE: Record<string, string> = {
  PRESENTE: 'Presente',
  AUSENCIA_PRESUMIDA: 'Ausência presumida',
  AUSENCIA_CONFIRMADA: 'Ausente',
  AUSENCIA_JUSTIFICADA: 'Ausência justificada',
  ATESTADO: 'Atestado',
  FOLGA: 'Folga',
  FERIAS: 'Férias',
  TRABALHO_EXTERNO: 'Trabalho externo',
  ENCERRADO: 'Expediente encerrado',
};

export function EmployeePanel({
  e,
  layout,
  snapshot,
  onClose,
  onOpenPiece,
}: {
  e: GameEmployeeDto;
  layout: LayoutContent;
  snapshot: GameSnapshotDto;
  onClose: () => void;
  onOpenPiece: (itemId: string) => void;
}) {
  const area = layout.areas.find((a) => a.id === e.areaId);
  const station = layout.stations.find((s) => s.id === e.stationId);
  const pieceOf = (taskId: string) =>
    snapshot.pieces.find((p) => p.tasks.some((t) => t.id === taskId));
  return (
    <Panel
      testId="employee-panel"
      icon="👷"
      title={e.name}
      subtitle={e.roles.join(', ')}
      onClose={onClose}
      className="h-full"
    >
      <Section title="Agora (conforme os registros)">
        <KV
          k="Presença hoje (registro de chegada)"
          v={e.attendance ? (ATTENDANCE[e.attendance] ?? e.attendance) : 'Sem registro de chegada'}
        />
        <KV
          k="Etapa em execução (tablet)"
          v={
            e.currentTask
              ? `${e.currentTask.status === 'PAUSADA' ? 'Pausada' : 'Sim'} · ${ACTIVITY_LABEL_GAME[e.currentTask.activity] ?? e.currentTask.activity}`
              : 'Nenhuma'
          }
        />
        {e.currentTask && (!e.attendance || e.attendance !== 'PRESENTE') ? (
          <p
            className="my-1 rounded-lg border border-warn-600/30 bg-warn-50 p-1.5 text-xs text-warn-600"
            data-testid="presence-mismatch"
          >
            Há etapa iniciada no tablet, mas{' '}
            {e.attendance
              ? `a presença está como "${ATTENDANCE[e.attendance] ?? e.attendance}"`
              : 'não há registro de chegada hoje'}
            . As duas informações vêm de registros diferentes.
          </p>
        ) : null}
        <KV k="Área" v={area?.name ?? '—'} />
        <KV k="Estação" v={station?.name ?? 'Sem estação vinculada'} />
        {e.currentTask ? (
          <button
            className="mt-2 w-full rounded-xl border-2 border-brand-500/40 bg-brand-50 p-2.5 text-left"
            onClick={() => {
              const p = pieceOf(e.currentTask!.id);
              if (p) onOpenPiece(p.id);
            }}
          >
            <div className="text-xs font-semibold text-brand-700">
              {iconText(e.currentTask.status === 'PAUSADA' ? '⏸ Pausada' : '▶ Iniciada')}{' '}
              {e.currentTask.startedAt ? `em ${fmtDateTime(e.currentTask.startedAt)}` : ''}
            </div>
            <div className="font-semibold">{e.currentTask.title}</div>
            <div className="text-xs text-ink-soft">
              {e.currentTask.itemCode ?? e.currentTask.osCode} ·{' '}
              {ACTIVITY_LABEL_GAME[e.currentTask.activity] ?? e.currentTask.activity}
            </div>
          </button>
        ) : (
          <p className="mt-2 text-xs text-ink-muted">Nenhum serviço iniciado no tablet.</p>
        )}
      </Section>
      <Section
        title={`Fila da semana: ${e.queue.length} etapa(s) em ${new Set(e.queue.map((q) => q.itemCode ?? q.osCode)).size} peça(s)`}
      >
        {e.queue.length ? (
          <ol className="space-y-1.5" data-testid="employee-queue">
            {e.queue.map((t, i) => {
              const p = pieceOf(t.id);
              const step = p ? pieceWorkflow(p).steps.find((s) => s.taskId === t.id) : null;
              const available = step ? step.available : t.status === 'LIBERADA';
              const title = t.title.replace(/\s+—\s+OS-[\d/]+$/, '');
              return (
                <li key={t.id}>
                  <button
                    className="flex w-full items-center gap-2 rounded-lg border border-line bg-white px-2 py-1.5 text-left text-xs hover:bg-subtle"
                    onClick={() => {
                      if (p) onOpenPiece(p.id);
                    }}
                    data-testid="queue-item"
                  >
                    <span className="w-5 text-center font-bold text-bronze-600">{i + 1}</span>
                    <span className="flex-1">
                      <b>{t.itemCode ?? t.osCode}</b> · {title}
                      <span className={`block ${available ? 'text-ok-600' : 'text-danger-700'}`}>
                        {iconText(
                          available
                            ? '✅ Disponível para iniciar no tablet'
                            : `⛔ ${TASK_STATUS_LABEL[t.status] ?? t.status}${step?.reason ? `: ${step.reason}` : ''}`,
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-xs text-ink-muted">Fila vazia nesta semana.</p>
        )}
      </Section>
      <p className="text-xs text-ink-muted">
        O avatar fica na estação da etapa iniciada no tablet. Sem tarefa iniciada, fica na estação
        vinculada.
      </p>
    </Panel>
  );
}

const SCOPE_LABEL: Record<string, string> = {
  producao: 'Produção e filas',
  os: 'Ordens de serviço',
  estoque: 'Estoque',
  compras: 'Materiais a comprar',
  financeiro: 'Financeiro',
  presenca: 'Presença',
  clientes: 'Clientes',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  fiscal: 'Fiscal',
  orcamentos: 'Orçamentos',
};
const ACTION_LABEL: Record<string, string> = {
  atribuir_tarefa: 'Planejar/atribuir tarefas',
  criar_compra: 'Criar pedido de compra',
  reservar_estoque: 'Reservar estoque',
  enviar_mensagem: 'Enviar mensagem',
  publicar_post: 'Publicar no Instagram',
  registrar_pagamento: 'Registrar pagamento',
  emitir_nota: 'Emitir nota fiscal',
  preparar_orcamento: 'Preparar orçamento',
  pedir_fornecedor: 'Pedir ao fornecedor (WhatsApp)',
  cobrar_cliente: 'Cobrar cliente (WhatsApp)',
};
const POLICY_LABEL: Record<string, string> = {
  NUNCA: 'Nunca',
  PROPOR: 'Só propor',
  EXECUTAR_APROVADO: 'Executar após aprovação',
};

export function AgentPanel({
  agent,
  canManage,
  onClose,
  onConfigure,
  onOpenConversation,
  onOpenCash,
  onOpenPanel,
}: {
  agent: AgentDto;
  canManage: boolean;
  onClose: () => void;
  onConfigure: () => void;
  onOpenConversation?: (id: string) => void;
  onOpenCash?: (query: string) => void;
  onOpenPanel?: (p: 'inbox' | 'ads' | 'marketing' | 'central') => void;
}) {
  const conv = useConversation(agent.id);
  const suppliers = useSuppliers(agent.roleKey === 'COMPRAS');
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [conv.data?.messages.length]);
  const send = async (content: string) => {
    if (!content.trim()) return;
    setSending(true);
    try {
      await api(`/api/v1/game/agents/${agent.id}/messages`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { content },
      });
      setText('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['game-agent', agent.id] }),
        qc.invalidateQueries({ queryKey: ['game-agents'] }),
      ]);
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Falha ao falar com o agente.');
    } finally {
      setSending(false);
    }
  };
  /** Links do agente: telas do painel abrem no Cenário Gestão (nunca no endereço do jogo). */
  const linkOf = (href?: string | null) =>
    href ? (href.startsWith('/painel') ? cenarioUrl(href) : href) : undefined;
  const decide = async (
    id: string,
    decision: 'APROVAR' | 'REJEITAR',
    href?: string,
    edits?: { text?: string; supplierId?: string },
  ) => {
    // Abre a aba já no clique (bloqueador de pop-up) e só leva ao destino se a aprovação passar.
    const win = decision === 'APROVAR' && href ? window.open('', '_blank') : null;
    try {
      const r = await api<{ payload: Record<string, unknown> }>(
        `/api/v1/game/proposals/${id}/decide`,
        {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: { decision, ...(edits ? { edits } : {}) },
        },
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['game-agent', agent.id] }),
        qc.invalidateQueries({ queryKey: ['game-agents'] }),
      ]);
      const sent = r.payload?.sent === true;
      const target = linkOf(String(r.payload?.href ?? href ?? ''));
      if (win) {
        if (target && !sent) win.location.href = target;
        else win.close();
      }
      toast(
        'ok',
        decision === 'APROVAR'
          ? sent
            ? 'Aprovado e enviado pelo WhatsApp da empresa.'
            : r.payload?.channel === 'WHATSAPP'
              ? 'Aprovado. O WhatsApp abriu com a mensagem pronta: é só enviar.'
              : href
                ? 'Aprovado. O fluxo oficial abriu para você concluir.'
                : 'Aprovado e executado (veja o histórico do agente).'
          : 'Proposta rejeitada.',
      );
    } catch (e) {
      win?.close();
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível decidir.');
      // Proposta desatualizada: recarrega para mostrar o motivo e a situação atual.
      await qc.invalidateQueries({ queryKey: ['game-agent', agent.id] });
    }
  };
  const quick =
    agent.roleKey === 'GERENTE'
      ? [
          'Monte o plano semanal',
          'O que cada pessoa está fazendo?',
          'Quais OS correm risco?',
          'Quanto preciso receber para cobrir as contas da semana?',
        ]
      : agent.roleKey === 'COMPRAS'
        ? ['O que preciso comprar?', 'Prepare os pedidos dos fornecedores']
        : agent.roleKey === 'FINANCEIRO'
          ? ['Como está o financeiro?', 'Quem preciso cobrar?', 'Quais contas vencem na semana?']
          : agent.roleKey === 'ORCAMENTOS'
            ? ['Quais orçamentos esperam resposta?', 'Quem pediu orçamento?']
            : agent.roleKey === 'ATENDIMENTO' || agent.roleKey === 'WHATSAPP'
              ? ['Quem está esperando orçamento?', 'Quais clientes avisar hoje?']
              : agent.roleKey === 'MARKETING' || agent.roleKey === 'INSTAGRAM'
                ? ['O que tenho para postar?']
                : agent.roleKey === 'TRAFEGO'
                  ? ['Como estão as campanhas?']
                  : ['O que você consegue ver?', 'O que eu faço hoje?'];
  const panelOf: Record<string, 'inbox' | 'ads' | 'marketing'> = {
    ATENDIMENTO: 'inbox',
    TRAFEGO: 'ads',
    MARKETING: 'marketing',
  };
  const d = conv.data;
  return (
    <Panel
      testId="agent-panel"
      icon="🤖"
      title={agent.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-1">
          {agent.roleLabel} ·{' '}
          {agent.engine === 'DADOS_CENARIO' ? (
            <Tone tone="ok">dados do Cenário Gestão</Tone>
          ) : agent.engine === 'AGUARDANDO_INTEGRACAO' ? (
            <Tone tone="atencao">aguardando integração</Tone>
          ) : (
            <Tone tone="info">suas instruções</Tone>
          )}
          {agent.status !== 'ATIVO' ? (
            <Tone tone="atencao">{agent.status.toLowerCase()}</Tone>
          ) : null}
        </span>
      }
      onClose={onClose}
      className="h-full"
      actions={
        <>
          {panelOf[agent.roleKey] && onOpenPanel ? (
            <GBtn tone="ghost" onClick={() => onOpenPanel(panelOf[agent.roleKey]!)}>
              {agent.roleKey === 'ATENDIMENTO'
                ? 'Caixa de entrada'
                : agent.roleKey === 'TRAFEGO'
                  ? 'Campanhas'
                  : 'Publicações'}
            </GBtn>
          ) : null}
          {canManage ? (
            <GBtn tone="ghost" onClick={onConfigure}>
              Configurar
            </GBtn>
          ) : null}
        </>
      }
    >
      <AgentActions agentId={agent.id} />
      {agent.roleKey === 'COMPRAS' ? <SuppliersSection canManage={canManage} /> : null}
      <Section title="Tarefas e pendências">
        {d?.tasks.length ? (
          <ul className="space-y-1">
            {d.tasks.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <Tone tone={t.tone}>
                  {t.tone === 'risco' ? 'Risco' : t.tone === 'atencao' ? 'Atenção' : 'Ok'}
                </Tone>
                <span>
                  <b>{t.label}</b> — {t.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">
            {conv.isPending ? 'Olhando os dados…' : 'Nada pendente.'}
          </p>
        )}
      </Section>
      <Section title="Ações prontas para revisão">
        {d?.proposals.filter((p) => p.status === 'PENDENTE').length ? (
          <ul className="space-y-2" data-testid="agent-proposals">
            {d.proposals
              .filter((p) => p.status === 'PENDENTE')
              .map((p) =>
                p.payload.channel === 'WHATSAPP' ? (
                  <WhatsAppProposal
                    key={p.id}
                    proposal={p}
                    canManage={canManage}
                    suppliers={suppliers.data ?? []}
                    linkOf={linkOf}
                    onDecide={(decision, edits) =>
                      decide(p.id, decision, String(p.payload.href ?? ''), edits)
                    }
                  />
                ) : (
                  <li key={p.id} className="rounded-lg border border-line bg-white p-2 text-xs">
                    <div className="font-semibold">{p.title}</div>
                    <div className="text-ink-soft">{p.detail}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.evidence.map((r) => (
                        <a
                          key={r.id}
                          href={linkOf(r.href)}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded bg-subtle px-1.5 py-0.5 underline"
                        >
                          {r.label}
                        </a>
                      ))}
                    </div>
                    {canManage ? (
                      <div className="mt-1.5 flex gap-1.5">
                        <GBtn
                          tone="primary"
                          className="!px-2 !py-1 text-xs"
                          onClick={() =>
                            decide(p.id, 'APROVAR', linkOf(String(p.payload.href ?? '')))
                          }
                          testId="proposal-approve"
                        >
                          {p.payload.href ? 'Aprovar e abrir fluxo' : 'Aprovar e executar'}
                        </GBtn>
                        <GBtn
                          tone="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => decide(p.id, 'REJEITAR')}
                        >
                          Rejeitar
                        </GBtn>
                      </div>
                    ) : (
                      <p className="mt-1 text-ink-muted">Aprovação exige agentes.gerenciar.</p>
                    )}
                  </li>
                ),
              )}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">
            Nenhuma ação aguardando. O agente só propõe; nada é executado sem aprovação.
          </p>
        )}
      </Section>
      {d?.proposals.some((p) => p.status === 'OBSOLETA') ? (
        <Section title="Propostas desatualizadas (os dados mudaram)">
          <ul className="space-y-1 text-xs" data-testid="agent-obsolete">
            {d.proposals
              .filter((p) => p.status === 'OBSOLETA')
              .slice(0, 5)
              .map((p) => (
                <li key={p.id} className="rounded-lg border border-line bg-subtle p-1.5">
                  <s className="text-ink-muted">{p.title}</s>
                  <div className="text-ink-soft">{p.decisionNote}</div>
                </li>
              ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Conversa">
        <div
          className="max-h-[38vh] space-y-2 overflow-y-auto rounded-xl bg-subtle p-2"
          data-testid="agent-chat"
        >
          {d?.messages.map((m) => (
            <div
              key={m.id}
              className={
                m.author === 'USUARIO'
                  ? 'ml-6 rounded-xl bg-brand-600 p-2 text-white'
                  : 'mr-4 rounded-xl border border-line bg-white p-2'
              }
            >
              <div className="whitespace-pre-wrap text-xs leading-relaxed">{m.content}</div>
              {m.references.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.references.slice(0, 16).map((r) => (
                    <a
                      key={`${r.type}${r.id}`}
                      href={linkOf(r.href)}
                      onClick={(ev) => {
                        if (r.type === 'CONVERSA' && onOpenConversation) {
                          ev.preventDefault();
                          onOpenConversation(r.id);
                        } else if (r.href?.startsWith('/jogo?caixa=moves:') && onOpenCash) {
                          ev.preventDefault();
                          onOpenCash(decodeURIComponent(r.href.slice('/jogo?caixa=moves:'.length)));
                        }
                      }}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded bg-bronze-100 px-1.5 py-0.5 text-[11px] text-bronze-600 underline"
                    >
                      {r.label}
                    </a>
                  ))}
                </div>
              ) : null}
              <div
                className={
                  m.author === 'USUARIO'
                    ? 'mt-1 text-[10px] text-white/70'
                    : 'mt-1 text-[10px] text-ink-muted'
                }
              >
                {fmtDateTime(m.createdAt)}
              </div>
            </div>
          ))}
          {!d?.messages.length ? (
            <p className="p-2 text-xs text-ink-muted">Comece com uma das perguntas abaixo.</p>
          ) : null}
          <div ref={end} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {quick.map((q) => (
            <button
              key={q}
              className="rounded-full border border-bronze-500/40 bg-bronze-100 px-2 py-0.5 text-xs"
              disabled={sending}
              onClick={() => send(q)}
            >
              {q}
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input
            className="flex-1 rounded-xl border border-line-strong px-3 py-2 text-sm"
            placeholder={`Pergunte ao ${agent.name}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending || agent.status === 'DESATIVADO'}
            aria-label="Mensagem para o agente"
          />
          <GBtn type="submit" tone="primary" disabled={sending || !text.trim()}>
            <Send className="size-4" />
          </GBtn>
        </form>
      </Section>
    </Panel>
  );
}

export function AgentConfigPanel({
  agent,
  deskId,
  desks,
  onClose,
  onSaved,
}: {
  agent: AgentDto | null;
  deskId: string | null;
  desks: { id: string; name: string; taken: string | null }[];
  onClose: () => void;
  onSaved: (a: AgentDto) => void;
}) {
  const templates = useAgentTemplates();
  const integrations = useIntegrations();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState(() => ({
    name: agent?.name ?? '',
    roleKey: agent?.roleKey ?? 'PERSONALIZADA',
    roleLabel: agent?.roleLabel ?? '',
    instructions: agent?.instructions ?? '',
    dataScopes: agent?.dataScopes ?? [],
    actionPolicies: (agent?.actionPolicies ?? {}) as Record<string, string>,
    channelPolicies: (agent?.channelPolicies ?? {}) as Record<string, string>,
    autoSendRules: (agent?.autoSendRules ?? []) as string[],
    deskStationId: agent?.deskStationId ?? deskId,
    color: agent?.color ?? '#7c3aed',
    status: agent?.status ?? 'ATIVO',
  }));
  const [saving, setSaving] = useState(false);
  const pickTemplate = (t: AgentRoleTemplate) =>
    setForm((f) => ({
      ...f,
      roleKey: t.roleKey,
      roleLabel: t.roleLabel,
      name: f.name || t.name,
      instructions: t.instructions,
      dataScopes: t.dataScopes,
      actionPolicies: t.actionPolicies,
      channelPolicies: t.channelPolicies ?? {},
      autoSendRules: t.autoSendRules ?? [],
      color: t.color,
    }));
  const save = async () => {
    setSaving(true);
    try {
      const body = {
        ...form,
        roleLabel: form.roleLabel || 'Função personalizada',
        deskStationId: form.deskStationId || null,
      };
      const res = agent
        ? await api<AgentDto>(`/api/v1/game/agents/${agent.id}`, {
            method: 'PUT',
            body: { ...body, version: agent.version },
          })
        : await api<AgentDto>('/api/v1/game/agents', {
            method: 'POST',
            idempotencyKey: newIdempotencyKey(),
            body: (({ status: _s, ...b }) => b)(body),
          });
      await qc.invalidateQueries({ queryKey: ['game-agents'] });
      toast('ok', agent ? 'Agente atualizado.' : 'Agente criado e sentado na mesa.');
      onSaved(res);
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível salvar o agente.');
    } finally {
      setSaving(false);
    }
  };
  const tpl = templates.data?.find((t) => t.roleKey === form.roleKey);
  const needs = (tpl?.integrations ?? [])
    .map((k) => integrations.data?.find((i) => i.key === k))
    .filter(Boolean);
  return (
    <Panel
      testId="agent-config"
      icon="⚙️"
      title={agent ? `Configurar ${agent.name}` : 'Novo agente'}
      subtitle="Função, instruções, dados e ações"
      onClose={onClose}
      className="h-full"
    >
      {!agent ? (
        <Section title="Começar de uma função">
          <div className="flex flex-wrap gap-1.5">
            {templates.data?.map((t) => (
              <button
                key={t.roleKey}
                onClick={() => pickTemplate(t)}
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${form.roleKey === t.roleKey ? 'border-bronze-600 bg-bronze-500 text-white' : 'border-line-strong bg-white'}`}
              >
                {t.roleLabel}
              </button>
            ))}
            <button
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  roleKey: 'PERSONALIZADA',
                  roleLabel: '',
                  instructions: '',
                }))
              }
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${form.roleKey === 'PERSONALIZADA' ? 'border-bronze-600 bg-bronze-500 text-white' : 'border-line-strong bg-white'}`}
            >
              + Função nova
            </button>
          </div>
        </Section>
      ) : null}
      <div className="space-y-2 text-xs">
        <label className="block">
          Nome
          <input
            className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1.5"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="block">
          Função (rótulo)
          <input
            className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1.5"
            value={form.roleLabel}
            placeholder="Ex.: Pós-venda"
            onChange={(e) => setForm({ ...form, roleLabel: e.target.value })}
          />
        </label>
        <label className="block">
          Instruções
          <textarea
            rows={4}
            className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1.5"
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
        </label>
        <label className="block">
          Mesa
          <select
            className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1.5"
            value={form.deskStationId ?? ''}
            onChange={(e) => setForm({ ...form, deskStationId: e.target.value || null })}
          >
            <option value="">Sem mesa</option>
            {desks.map((d) => (
              <option key={d.id} value={d.id} disabled={Boolean(d.taken && d.taken !== agent?.id)}>
                {d.name}
                {d.taken && d.taken !== agent?.id ? ' (ocupada)' : ''}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="font-semibold">Dados que pode consultar</legend>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {AGENT_DATA_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form.dataScopes.includes(s)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      dataScopes: e.target.checked
                        ? [...form.dataScopes, s]
                        : form.dataScopes.filter((x) => x !== s),
                    })
                  }
                />
                {SCOPE_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="font-semibold">Ações</legend>
          <div className="mt-1 space-y-1">
            {AGENT_ACTIONS.map((a) => (
              <label key={a} className="flex items-center justify-between gap-2">
                <span>{ACTION_LABEL[a]}</span>
                <select
                  className="rounded border border-line-strong px-1 py-0.5"
                  value={form.actionPolicies[a] ?? 'NUNCA'}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      actionPolicies: { ...form.actionPolicies, [a]: e.target.value },
                    })
                  }
                >
                  {AGENT_POLICY.map((p) => (
                    <option key={p} value={p}>
                      {POLICY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="mt-1 text-ink-muted">
            Compras, mensagens, publicações, pagamentos e notas sempre passam pela sua aprovação.
            Integrações não configuradas rodam em modo de teste.
          </p>
        </fieldset>
        <fieldset data-testid="agent-channels">
          <legend className="font-semibold">Canais</legend>
          <div className="mt-1 space-y-1">
            {AGENT_CHANNELS.map((c) => (
              <label key={c} className="flex items-center justify-between gap-2">
                <span>{CHANNEL_LABEL[c] ?? c}</span>
                <select
                  className="rounded border border-line-strong px-1 py-0.5"
                  value={form.channelPolicies[c] ?? 'NENHUM'}
                  onChange={(e) => {
                    const { [c]: _old, ...rest } = form.channelPolicies;
                    setForm({
                      ...form,
                      channelPolicies:
                        e.target.value === 'NENHUM' ? rest : { ...rest, [c]: e.target.value },
                    });
                  }}
                >
                  {['NENHUM', ...CHANNEL_POLICY].map((p) => (
                    <option key={p} value={p}>
                      {CHANNEL_POLICY_LABEL[p] ?? p}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-1.5 font-semibold">Envio automático (só com “Executar” no canal)</div>
          {AUTO_SEND_RULES.map((r) => (
            <label key={r} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.autoSendRules.includes(r)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    autoSendRules: e.target.checked
                      ? [...form.autoSendRules, r]
                      : form.autoSendRules.filter((x) => x !== r),
                  })
                }
              />
              {AUTO_SEND_LABEL[r] ?? r}
            </label>
          ))}
        </fieldset>
        {needs.length ? (
          <div className="rounded-lg border border-warn-600/30 bg-warn-50 p-2">
            {needs.map((n) => (
              <div key={n!.key}>
                <b>{n!.label}:</b>{' '}
                {n!.status === 'PRECISA_CONFIGURAR'
                  ? 'precisa configurar'
                  : n!.status === 'MODO_TESTE'
                    ? 'modo de teste'
                    : 'conectada'}{' '}
                — {n!.detail}
              </div>
            ))}
          </div>
        ) : null}
        {agent ? (
          <div className="flex gap-1.5">
            {(['ATIVO', 'PAUSADO', 'DESATIVADO'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setForm({ ...form, status: s })}
                className={`flex-1 rounded-lg border px-2 py-1 font-semibold ${form.status === s ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-white'}`}
              >
                {s === 'ATIVO' ? 'Ativo' : s === 'PAUSADO' ? 'Pausar' : 'Desativar'}
              </button>
            ))}
          </div>
        ) : null}
        <GBtn
          tone="primary"
          className="w-full"
          disabled={saving || !form.name.trim()}
          onClick={save}
          testId="agent-save"
        >
          {agent ? 'Salvar configuração' : 'Criar agente'}
        </GBtn>
      </div>
    </Panel>
  );
}
