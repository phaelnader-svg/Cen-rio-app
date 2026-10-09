'use client';

import type { HelpStatus, ProposalAlternative, RescheduleProposalDto } from '@cenario/shared';
import {
  CANDIDATE_REASONS,
  HELP_KIND_LABEL,
  HELP_STATUSES,
  HELP_STATUS_LABEL,
  PLANNING_ACTION_LABEL,
  PROPOSAL_KIND_LABEL,
  PROPOSAL_STATUS_LABEL,
  SKILLS,
  SKILL_LABEL,
  type Skill,
} from '@cenario/shared';
import clsx from 'clsx';
import { CalendarClock, GitPullRequestArrow, HandHelping, RefreshCw, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useHelpCandidates } from '@/lib/issues';
import {
  useHelpRequest,
  useHelpRequests,
  usePlanningActions,
  useProposals,
  useSkills,
} from '@/lib/help';
import { useCan } from '@/lib/hooks';
import { useWorkers } from '@/lib/production';

const STATUS_TONE: Record<HelpStatus, 'warn' | 'ok' | 'info' | 'neutral' | 'danger' | 'brand'> = {
  PENDENTE: 'warn',
  ATRIBUIDA: 'brand',
  EM_EXECUCAO: 'info',
  CONCLUIDA: 'ok',
  CANCELADA: 'neutral',
  ESCALADA: 'danger',
};
const TAB_LABEL: Record<HelpStatus, string> = {
  PENDENTE: 'Pendentes',
  ATRIBUIDA: 'Atribuídas',
  EM_EXECUCAO: 'Em execução',
  CONCLUIDA: 'Concluídas',
  CANCELADA: 'Canceladas',
  ESCALADA: 'Escaladas',
};

// ─────────────────────────── Pedidos de ajuda ───────────────────────────

/** Pedidos de ajuda por status, com a avaliação dos candidatos de cada atribuição. */
export function HelpRequestsPage() {
  const can = useCan();
  const q = useHelpRequests();
  const [tab, setTab] = useState<HelpStatus>('PENDENTE');
  const [open, setOpen] = useState<string | null>(null);
  const { m, error } = useSend();
  const list = q.data ?? [];
  const count = (s: HelpStatus) => list.filter((r) => r.status === s).length;
  const rows = list.filter((r) => r.status === tab);
  return (
    <>
      <PageHeader
        title="Pedidos de ajuda"
        description="Atribuição automática de ajudantes por regras fixas (competência, presença, ocupação, agenda e menor impacto). Cada escolha registra os candidatos avaliados e os motivos."
        actions={
          can('producao.planejar') && (
            <Button
              variant="secondary"
              icon={<RefreshCw className="size-4" aria-hidden />}
              loading={m.isPending}
              onClick={() =>
                m.mutate({
                  run: () =>
                    api('/api/v1/help-requests/process', {
                      method: 'POST',
                      body: {},
                      idempotencyKey: newIdempotencyKey(),
                    }),
                  ok: 'Fila reavaliada.',
                })
              }
            >
              Reavaliar fila
            </Button>
          )
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Tabs
        tabs={HELP_STATUSES.map((s) => ({ key: s, label: TAB_LABEL[s], count: count(s) }))}
        active={tab}
        onChange={(k) => setTab(k as HelpStatus)}
      >
        {q.isPending ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<HandHelping className="size-6" aria-hidden />}
            title={`Nenhum pedido ${TAB_LABEL[tab].toLowerCase()}`}
          />
        ) : (
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" data-testid="help-table">
              <thead className="bg-subtle text-left text-ink-muted">
                <tr>
                  <th className="px-4 py-2.5">Pedido</th>
                  <th className="px-4 py-2.5">Quem pediu</th>
                  <th className="px-4 py-2.5">Tarefa</th>
                  <th className="px-4 py-2.5">Apoio</th>
                  <th className="px-4 py-2.5">Ajudante</th>
                  <th className="px-4 py-2.5">Espera</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-line"
                    data-testid={`help-row-${r.code}`}
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono font-semibold">{r.code}</span>
                      {r.urgent && (
                        <Badge tone="danger" className="ml-2">
                          Urgente
                        </Badge>
                      )}
                      <span className="block text-xs text-ink-muted">
                        {formatDateTime(r.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">{r.requester.displayName}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-ink-muted">
                        {r.serviceOrder.code} · {r.task.code}
                      </span>
                      <span className="block">{r.task.title}</span>
                    </td>
                    <td className="px-4 py-3">
                      {HELP_KIND_LABEL[r.kind]} · {r.estimatedMinutes} min
                      {r.justification && (
                        <span className="block text-xs text-danger-600">{r.justification}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.helper?.displayName ?? '—'}
                      <Badge tone={STATUS_TONE[r.status]} className="ml-2">
                        {HELP_STATUS_LABEL[r.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{r.waitingMinutes} min</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="secondary" onClick={() => setOpen(r.id)}>
                        Detalhes
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Tabs>
      {open && <HelpDetailDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function HelpDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useHelpRequest(id);
  const can = useCan();
  const { m, error } = useSend();
  const [reason, setReason] = useState('');
  const r = q.data;
  const cancellable = r && ['PENDENTE', 'ATRIBUIDA', 'ESCALADA'].includes(r.status);
  return (
    <Dialog open onClose={onClose} title={r ? `Pedido ${r.code}` : 'Pedido'} size="lg">
      {!r ? (
        <Spinner />
      ) : (
        <div className="space-y-4" data-testid="help-detail">
          <p className="text-[15px]">
            <strong>{r.requester.displayName}</strong> pediu {HELP_KIND_LABEL[r.kind].toLowerCase()}{' '}
            ({r.estimatedMinutes} min) em {r.task.code} · {r.task.title}
            {r.note ? ` — ${r.note}` : ''}.
          </p>
          {r.proposalId && r.status === 'ESCALADA' && (
            <Alert tone="warn" title="Aguardando decisão">
              Sem ajudante livre: veja a proposta em{' '}
              <Link className="underline" href="/painel/reprogramacao">
                Reprogramação
              </Link>
              .
            </Alert>
          )}
          <ol className="space-y-3">
            {r.events?.map((e) => (
              <li key={e.id} className="rounded-xl border border-line p-3">
                <p className="text-sm text-ink-muted">
                  {formatDateTime(e.createdAt)} · {e.actor ?? '—'}
                </p>
                <p className="font-semibold">
                  {e.toStatus
                    ? (HELP_STATUS_LABEL[e.toStatus as HelpStatus] ?? e.kind)
                    : e.kind.replaceAll('_', ' ').toLowerCase()}
                </p>
                {e.note && <p className="text-sm">{e.note}</p>}
                {e.candidates && (
                  <table className="mt-2 w-full text-sm" data-testid="candidates">
                    <thead className="text-left text-ink-muted">
                      <tr>
                        <th className="py-1">Candidato</th>
                        <th className="py-1">Situação</th>
                        <th className="py-1">Impacto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.candidates.map((c) => (
                        <tr key={c.userId} className="border-t border-line">
                          <td className="py-1.5">{c.name}</td>
                          <td className="py-1.5">
                            {c.eligible ? (
                              <Badge tone="ok">Elegível</Badge>
                            ) : (
                              c.reasons.map((x) => CANDIDATE_REASONS[x]).join(', ')
                            )}
                            {c.notes.length > 0 && (
                              <span className="block text-xs text-ink-muted">
                                {c.notes.join(' · ')}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5">{c.eligible ? c.score : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ol>
          {(r.status === 'PENDENTE' || r.status === 'ESCALADA') && can('producao.planejar') && (
            <ManualHelper id={r.id} version={r.version} />
          )}
          {cancellable && can('producao.planejar') && (
            <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
              <Field label="Motivo do cancelamento (opcional)" className="min-w-64 flex-1">
                {(f) => <Input {...f} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <Button
                variant="outline-danger"
                loading={m.isPending}
                onClick={() =>
                  m.mutate({
                    run: () =>
                      api(`/api/v1/help-requests/${r.id}/cancel`, {
                        method: 'POST',
                        body: { reason: reason || undefined, version: r.version },
                        idempotencyKey: newIdempotencyKey(),
                      }),
                    ok: 'Pedido cancelado.',
                  })
                }
              >
                Cancelar pedido
              </Button>
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

// ─────────────────────────── Reprogramação ───────────────────────────

/** Propostas que exigem decisão do gestor e histórico de alterações (automáticas e aprovadas). */
export function ReschedulePage() {
  const [tab, setTab] = useState<'pending' | 'decided' | 'history'>('pending');
  const pending = useProposals('PENDENTE');
  const all = useProposals();
  const decided = (all.data ?? []).filter((p) => p.status !== 'PENDENTE');
  return (
    <>
      <PageHeader
        title="Reprogramação"
        description="Mudanças críticas (tarefa importante, prazo, cliente, tapeceiro principal, conflito ou prioridade) só acontecem com a sua aprovação. Mudanças simples automáticas ficam registradas no histórico."
      />
      <Tabs
        tabs={[
          { key: 'pending', label: 'Aguardando decisão', count: pending.data?.length ?? 0 },
          { key: 'decided', label: 'Decididas', count: decided.length },
          { key: 'history', label: 'Histórico de alterações' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      >
        <div className="mt-4 space-y-4">
          {tab === 'history' ? (
            <PlanningHistory />
          ) : (tab === 'pending' ? pending : all).isPending ? (
            <Spinner />
          ) : (tab === 'pending' ? (pending.data ?? []) : decided).length === 0 ? (
            <EmptyState
              icon={<GitPullRequestArrow className="size-6" aria-hidden />}
              title={tab === 'pending' ? 'Nenhuma proposta aguardando' : 'Nenhuma decisão ainda'}
            />
          ) : (
            (tab === 'pending' ? (pending.data ?? []) : decided).map((p) => (
              <ProposalCard key={p.id} p={p} />
            ))
          )}
        </div>
      </Tabs>
    </>
  );
}

function ProposalCard({ p }: { p: RescheduleProposalDto }) {
  const can = useCan();
  const manage = can('producao.planejar') && p.status === 'PENDENTE';
  const [choice, setChoice] = useState(p.proposedAlternativeId);
  const [dialog, setDialog] = useState<'adjust' | 'reject' | null>(null);
  const { m, error } = useSend();
  const alt = p.alternatives.find((a) => a.id === choice);
  return (
    <Card className="p-5" data-testid={`proposal-${p.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{p.code}</span>
        <Badge tone="info">{PROPOSAL_KIND_LABEL[p.kind]}</Badge>
        {p.critical && <Badge tone="danger">Crítica</Badge>}
        <Badge tone={p.status === 'PENDENTE' ? 'warn' : p.status === 'REJEITADA' ? 'danger' : 'ok'}>
          {PROPOSAL_STATUS_LABEL[p.status]}
        </Badge>
        <span className="text-sm text-ink-muted">{formatDateTime(p.createdAt)}</span>
      </div>
      <dl className="mt-3 grid gap-3 text-[15px] md:grid-cols-2">
        <div>
          <dt className="text-sm text-ink-muted">Situação</dt>
          <dd>{p.situation}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-muted">Problema</dt>
          <dd>{p.problem}</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-ink-muted">Tarefas afetadas</p>
      <ul className="mt-1 flex flex-wrap gap-2 text-sm">
        {p.affectedTasks.map((t) => (
          <li key={t.id} className="rounded-lg bg-subtle px-2 py-1">
            <span className="font-mono">{t.code}</span> {t.title} · {t.assignee ?? '—'}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-ink-muted">Alternativas</p>
      <div className="mt-1 grid gap-3 md:grid-cols-2" role="radiogroup">
        {p.alternatives.map((a) => (
          <AlternativeOption
            key={a.id}
            a={a}
            selected={choice === a.id}
            chosen={p.chosenAlternativeId === a.id}
            disabled={!manage}
            onSelect={() => setChoice(a.id)}
          />
        ))}
      </div>
      {p.decisionNote && (
        <p className="mt-3 text-sm">
          <span className="text-ink-muted">Decisão{p.decidedBy ? ` de ${p.decidedBy}` : ''}:</span>{' '}
          {p.decisionNote}
        </p>
      )}
      {p.helpRequest && (
        <p className="mt-2 text-sm text-ink-muted">Pedido de ajuda {p.helpRequest.code}</p>
      )}
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
      {manage && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            loading={m.isPending}
            className="max-w-full"
            title={`Aprovar: ${alt?.title ?? 'alternativa'}`}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/reschedule-proposals/${p.id}/approve`, {
                    method: 'POST',
                    body: { alternativeId: choice, version: p.version },
                    idempotencyKey: newIdempotencyKey(),
                  }),
                ok: 'Proposta aprovada e aplicada.',
              })
            }
          >
            <span className="min-w-0 truncate">Aprovar: {alt?.title ?? 'alternativa'}</span>
          </Button>
          {alt && alt.actions.some((x) => x.type !== 'INTERRUPT_FOR_HELP') && (
            <Button variant="secondary" onClick={() => setDialog('adjust')}>
              Ajustar
            </Button>
          )}
          <Button variant="outline-danger" onClick={() => setDialog('reject')}>
            Rejeitar
          </Button>
        </div>
      )}
      {dialog === 'reject' && <RejectDialog p={p} onClose={() => setDialog(null)} />}
      {dialog === 'adjust' && alt && (
        <AdjustDialog p={p} alt={alt} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}

function AlternativeOption({
  a,
  selected,
  chosen,
  disabled,
  onSelect,
}: {
  a: ProposalAlternative;
  selected: boolean;
  chosen: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={clsx(
        'rounded-xl border p-3 text-left text-sm',
        selected && !disabled ? 'border-brand-700 bg-brand-50' : 'border-line bg-surface',
        chosen && 'ring-2 ring-ok-600',
      )}
    >
      <span className="flex flex-wrap items-center gap-2 font-semibold">
        {a.title}
        {a.recommended && <Badge tone="brand">Proposta</Badge>}
        {a.critical && <Badge tone="danger">Crítica</Badge>}
        {chosen && <Badge tone="ok">Escolhida</Badge>}
      </span>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-soft">
        {a.impacts.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </button>
  );
}

function RejectDialog({ p, onClose }: { p: RescheduleProposalDto; onClose: () => void }) {
  const [note, setNote] = useState('');
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rejeitar ${p.code}`}
      description="Nada será alterado. Se houver pedido de ajuda, ele volta para a fila."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            variant="danger"
            loading={m.isPending}
            disabled={note.trim().length < 3}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/reschedule-proposals/${p.id}/reject`, {
                    method: 'POST',
                    body: { note, version: p.version },
                    idempotencyKey: newIdempotencyKey(),
                  }),
                ok: 'Proposta rejeitada.',
              })
            }
          >
            Rejeitar
          </Button>
        </>
      }
    >
      <Field label="Motivo" required>
        {(f) => (
          <Input
            {...f}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="reject-note"
          />
        )}
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  );
}

function AdjustDialog({
  p,
  alt,
  onClose,
}: {
  p: RescheduleProposalDto;
  alt: ProposalAlternative;
  onClose: () => void;
}) {
  const workers = useWorkers();
  const [note, setNote] = useState('');
  const [over, setOver] = useState<
    Record<string, { toUserId?: string; toDate?: string; toTime?: string }>
  >({});
  const { m, error } = useSend(onClose);
  const taskName = (id: string) => {
    const t = p.affectedTasks.find((x) => x.id === id);
    return t ? `${t.code} · ${t.title}` : id;
  };
  const set = (taskId: string, patch: Record<string, string>) =>
    setOver((o) => ({ ...o, [taskId]: { ...o[taskId], ...patch } }));
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Ajustar ${p.code}`}
      description={`Alternativa: ${alt.title}. Altere responsável ou data/hora antes de aplicar.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            disabled={note.trim().length < 3}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/reschedule-proposals/${p.id}/adjust`, {
                    method: 'POST',
                    body: {
                      alternativeId: alt.id,
                      overrides: Object.entries(over).map(([taskId, v]) => ({ taskId, ...v })),
                      note,
                      version: p.version,
                    },
                    idempotencyKey: newIdempotencyKey(),
                  }),
                ok: 'Proposta aprovada com ajuste.',
              })
            }
          >
            Aplicar com ajuste
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {alt.actions.map((a) => (
          <div key={a.taskId} className="rounded-xl border border-line p-3">
            <p className="text-sm font-semibold">{taskName(a.taskId)}</p>
            {a.type === 'RESCHEDULE' ? (
              <div className="mt-2 flex flex-wrap gap-3">
                <Field label="Data">
                  {(f) => (
                    <Input
                      {...f}
                      type="date"
                      defaultValue={a.toDate ?? ''}
                      onChange={(e) => set(a.taskId, { toDate: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Hora">
                  {(f) => (
                    <Input
                      {...f}
                      type="time"
                      defaultValue={a.toTime ?? ''}
                      onChange={(e) => set(a.taskId, { toTime: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            ) : a.type === 'REASSIGN' || a.type === 'CHANGE_PRINCIPAL' ? (
              <Field label="Responsável" className="mt-2">
                {(f) => (
                  <Select
                    {...f}
                    defaultValue={a.toUserId ?? ''}
                    onChange={(e) => set(a.taskId, { toUserId: e.target.value })}
                  >
                    {workers.data?.map((w) => (
                      <option key={w.userId} value={w.userId}>
                        {w.displayName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <p className="text-sm text-ink-muted">Sem ajuste possível.</p>
            )}
          </div>
        ))}
        <Field label="Motivo do ajuste" required>
          {(f) => <Input {...f} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

function PlanningHistory() {
  const [filter, setFilter] = useState<'all' | 'auto' | 'manual'>('all');
  const q = usePlanningActions(filter === 'all' ? undefined : filter === 'auto');
  return (
    <Section
      title="Alterações automáticas e aprovadas"
      actions={
        <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">Todas</option>
          <option value="auto">Automáticas</option>
          <option value="manual">Decisões do gestor</option>
        </Select>
      }
      bodyClassName="p-0"
    >
      {q.isPending ? (
        <Spinner />
      ) : !q.data?.length ? (
        <EmptyState title="Nenhuma alteração registrada" />
      ) : (
        <table className="w-full text-sm" data-testid="planning-history">
          <thead className="bg-subtle text-left text-ink-muted">
            <tr>
              <th className="px-4 py-2.5">Quando</th>
              <th className="px-4 py-2.5">O quê</th>
              <th className="px-4 py-2.5">Quem</th>
              <th className="px-4 py-2.5">Por quê</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <td className="px-4 py-2.5 whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                <td className="px-4 py-2.5">
                  {PLANNING_ACTION_LABEL[a.kind]}
                  <span className="block font-mono text-xs text-ink-muted">
                    {[a.task?.code, a.helpRequestCode, a.proposalCode].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  {a.automatic ? <Badge tone="info">Automática</Badge> : (a.actor ?? '—')}
                </td>
                <td className="px-4 py-2.5">{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ─────────────────────────── Competências ───────────────────────────

/** Competências da equipe (base da seleção de ajudantes). Só o gestor altera. */
export function SkillsPage() {
  const can = useCan();
  const q = useSkills();
  const edit = can('producao.planejar');
  return (
    <>
      <PageHeader
        title="Competências da equipe"
        description="Ninguém é escolhido para um apoio sem a competência marcada aqui. Cabeceiras, reparos e inspeção são especialidades preservadas: em condições iguais, o apoio geral vai para quem não as tem."
      />
      {q.isPending ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {q.data?.map((e) => (
            <SkillsCard key={e.employeeId} e={e} edit={edit} />
          ))}
        </div>
      )}
    </>
  );
}

function SkillsCard({
  e,
  edit,
}: {
  e: { employeeId: string; displayName: string; jobTitle: string; skills: Skill[] };
  edit: boolean;
}) {
  const [skills, setSkills] = useState<Skill[]>(e.skills);
  const { m, error } = useSend();
  const dirty = skills.slice().sort().join() !== e.skills.slice().sort().join();
  return (
    <Section
      title={`${e.displayName} · ${e.jobTitle}`}
      actions={
        edit && (
          <Button
            size="sm"
            disabled={!dirty}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/employees/${e.employeeId}/skills`, {
                    method: 'PUT',
                    body: { skills },
                  }),
                ok: `Competências de ${e.displayName} salvas.`,
              })
            }
          >
            Salvar
          </Button>
        )
      }
    >
      <div className="grid gap-2 sm:grid-cols-2" data-testid={`skills-${e.displayName}`}>
        {SKILLS.map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={skills.includes(s)}
              disabled={!edit}
              onChange={(ev) =>
                setSkills((list) =>
                  ev.target.checked ? [...list, s] : list.filter((x) => x !== s),
                )
              }
            />
            {SKILL_LABEL[s]}
          </label>
        ))}
      </div>
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
    </Section>
  );
}

// ─────────────────────────── Integração com o quadro ───────────────────────────

/** Aviso no quadro e no planejamento: decisões pendentes e pedidos de ajuda abertos. */
export function HelpAndRescheduleBanner() {
  const can = useCan();
  const proposals = useProposals('PENDENTE');
  const help = useHelpRequests();
  if (!can('producao.ver') && !can('producao.planejar')) return null;
  const waiting = (help.data ?? []).filter(
    (r) => r.status === 'PENDENTE' || r.status === 'ESCALADA',
  );
  const active = (help.data ?? []).filter(
    (r) => r.status === 'ATRIBUIDA' || r.status === 'EM_EXECUCAO',
  );
  const pending = proposals.data?.length ?? 0;
  if (!pending && !waiting.length && !active.length) return null;
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-4 p-4 text-sm" data-testid="help-banner">
      {pending > 0 && (
        <Link
          href="/painel/reprogramacao"
          className="inline-flex items-center gap-2 font-semibold text-danger-600"
        >
          <CalendarClock className="size-4" aria-hidden /> {pending} reprogramação(ões) aguardando
          sua decisão
        </Link>
      )}
      {waiting.length > 0 && (
        <Link
          href="/painel/ajuda"
          className="inline-flex items-center gap-2 font-semibold text-warn-600"
        >
          <HandHelping className="size-4" aria-hidden /> {waiting.length} pedido(s) de ajuda
          aguardando ajudante
        </Link>
      )}
      {active.length > 0 && (
        <Link href="/painel/ajuda" className="inline-flex items-center gap-2 text-ink-soft">
          <Users className="size-4" aria-hidden /> {active.length} apoio(s) em andamento
        </Link>
      )}
    </Card>
  );
}

/**
 * Fase 9 — escolha manual do ajudante: candidatos avaliados agora (competência, presença,
 * ocupação, agenda). Impossível não aparece como opção; conflito pede aprovação explícita.
 */
function ManualHelper({ id, version }: { id: string; version: number }) {
  const q = useHelpCandidates(id);
  const { m, error } = useSend();
  const [confirm, setConfirm] = useState<{ userId: string; name: string } | null>(null);
  const [note, setNote] = useState('');
  const IMPOSSIBLE = ['SEM_COMPETENCIA', 'NAO_CONFIRMOU', 'AUSENTE', 'EXTERNO', 'ENCERRADO'];
  const choose = (userId: string, confirmConflict: boolean) =>
    m.mutate({
      run: () =>
        api(`/api/v1/help-requests/${id}/assign`, {
          method: 'POST',
          body: { helperUserId: userId, confirmConflict, note: note || undefined, version },
          idempotencyKey: newIdempotencyKey(),
        }),
      ok: 'Ajudante escolhido.',
    });
  return (
    <div className="space-y-2 border-t border-line pt-4" data-testid="manual-helper">
      <p className="font-semibold">Escolher o ajudante manualmente</p>
      {!q.data ? (
        <Spinner />
      ) : (
        <ul className="space-y-2">
          {q.data.candidates.map((c) => {
            const impossible = c.reasons.some((x) => IMPOSSIBLE.includes(x));
            const conflict = !c.eligible && !impossible;
            return (
              <li
                key={c.userId}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm"
              >
                <span className="font-semibold">{c.name}</span>
                {c.eligible ? (
                  <Badge tone="ok">Livre · impacto {c.score}</Badge>
                ) : (
                  <span className={impossible ? 'text-ink-muted' : 'text-warn-600'}>
                    {c.reasons.map((x) => CANDIDATE_REASONS[x]).join(', ')}
                  </span>
                )}
                {!impossible && (
                  <Button
                    size="sm"
                    className="ml-auto"
                    variant={conflict ? 'secondary' : 'primary'}
                    loading={m.isPending}
                    onClick={() =>
                      conflict
                        ? setConfirm({ userId: c.userId, name: c.name })
                        : choose(c.userId, false)
                    }
                  >
                    Escolher {c.name}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <Alert tone="warn" title={`${confirm.name} tem conflito`}>
          <p>Explique por que aprova o conflito (fica registrado como impacto).</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motivo" />
            <Button
              variant="danger"
              disabled={note.trim().length < 3}
              loading={m.isPending}
              onClick={() => choose(confirm.userId, true)}
            >
              Aprovar e atribuir
            </Button>
          </div>
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
