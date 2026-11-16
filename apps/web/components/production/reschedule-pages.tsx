'use client';

import type { ProposalAlternative, RescheduleProposalDto } from '@cenario/shared';
import { useFocusParam } from '@/lib/focus-param';
import {
  PLANNING_ACTION_LABEL,
  PROPOSAL_KIND_LABEL,
  PROPOSAL_STATUS_LABEL,
  SKILLS,
  SKILL_LABEL,
  type Skill,
} from '@cenario/shared';
import clsx from 'clsx';
import { CalendarClock, GitPullRequestArrow } from 'lucide-react';
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
import { usePlanningActions, useProposals, useSkills } from '@/lib/help';
import { useCan } from '@/lib/hooks';
import { useWorkers } from '@/lib/production';

/** Reprogramação: propostas do motor e histórico (os pedidos de ajuda foram removidos). */
export function ReschedulePage() {
  useFocusParam();
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
    <Card className="p-5" data-testid={`proposal-${p.code}`} data-focus-id={p.id}>
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
          {alt &&
            alt.actions.some(
              (x) => x.type !== 'INTERRUPT_FOR_HELP' && x.type !== 'ASSIGN_PROLONGED_SUPPORT',
            ) && (
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
        <table className="data-table" data-testid="planning-history">
          <thead>
            <tr>
              <th>Quando</th>
              <th>O quê</th>
              <th>Quem</th>
              <th>Por quê</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                <td>
                  {PLANNING_ACTION_LABEL[a.kind]}
                  <span className="block font-mono text-xs text-ink-muted">
                    {[a.task?.code, a.proposalCode].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td>{a.automatic ? <Badge tone="info">Automática</Badge> : (a.actor ?? '—')}</td>
                <td>{a.reason}</td>
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

/** Aviso no quadro e no planejamento: reprogramações aguardando decisão. */
export function RescheduleBanner() {
  const can = useCan();
  const proposals = useProposals('PENDENTE');
  if (!can('producao.ver') && !can('producao.planejar')) return null;
  const pending = proposals.data?.length ?? 0;
  if (!pending) return null;
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-4 p-4 text-sm" data-testid="help-banner">
      <Link
        href="/painel/reprogramacao"
        className="inline-flex items-center gap-2 font-semibold text-danger-600"
      >
        <CalendarClock className="size-4" aria-hidden /> {pending} reprogramação(ões) aguardando sua
        decisão
      </Link>
    </Card>
  );
}
