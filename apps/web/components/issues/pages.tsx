'use client';

import type { AttentionCategory, AttentionType, IssueDto, Priority } from '@cenario/shared';
import {
  ATTENTION_CATEGORIES,
  ATTENTION_CATEGORY_LABEL,
  ATTENTION_TYPES,
  ATTENTION_TYPE_LABEL,
  ISSUE_IMPACT_LABEL,
  ISSUE_KIND_LABEL,
  ISSUE_STATUS_LABEL,
  MATERIAL_UNIT_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SKILLS,
  SKILL_LABEL,
  TASK_STATUS_LABEL,
  type Skill,
} from '@cenario/shared';
import clsx from 'clsx';
import { ArrowRight, Siren } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { BackLink, Section } from '@/components/commercial/section';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useAttention, useIssue, useIssueImpacts } from '@/lib/issues';
import { useWorkers } from '@/lib/production';

const CATEGORY_TONE: Record<AttentionCategory, 'danger' | 'warn' | 'info' | 'neutral'> = {
  CRITICO: 'danger',
  ACAO: 'warn',
  ATENCAO: 'info',
  INFO: 'neutral',
};
const CATEGORY_CARD: Record<AttentionCategory, string> = {
  CRITICO: 'border-danger-600/40 bg-danger-50',
  ACAO: 'border-warn-600/40 bg-warn-50',
  ATENCAO: 'border-info-600/30 bg-info-50',
  INFO: 'border-line bg-surface',
};

// ─────────────────────────── Central de atenção ───────────────────────────

/** Central de atenção: só exceções (o que pede decisão ou acompanhamento do gestor). */
export function AttentionPage() {
  const workers = useWorkers();
  const [f, setF] = useState<Record<string, string | undefined>>({});
  const q = useAttention(f);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v || undefined }));
  const orders = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of q.data?.items ?? [])
      if (i.serviceOrder) m.set(i.serviceOrder.id, i.serviceOrder.code);
    return [...m.entries()];
  }, [q.data]);
  return (
    <>
      <PageHeader
        title="Central de atenção"
        description="Só o que pede atenção: ocorrências, pedidos de ajuda atrasados, reprogramações aguardando decisão, ausências com impacto, pausas por impedimento e prazos vencidos. A operação normal não aparece aqui."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4" data-testid="attention-counts">
        {ATTENTION_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => set('category', f.category === c ? '' : c)}
            aria-pressed={f.category === c}
            className={clsx(
              'rounded-2xl border p-4 text-left',
              CATEGORY_CARD[c],
              f.category === c && 'ring-2 ring-brand-700',
            )}
            data-testid={`attention-count-${c}`}
          >
            <span className="block text-sm text-ink-muted">{ATTENTION_CATEGORY_LABEL[c]}</span>
            <span className="text-2xl font-semibold">{q.data?.counts[c] ?? 0}</span>
          </button>
        ))}
      </div>
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <label className="text-sm">
          <span className="label">Tipo</span>
          <Select value={f.type ?? ''} onChange={(e) => set('type', e.target.value)}>
            <option value="">Todos</option>
            {ATTENTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {ATTENTION_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="label">Situação</span>
          <Select value={f.status ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Todas</option>
            {Object.entries(ISSUE_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="label">Funcionário</span>
          <Select
            value={f.employeeUserId ?? ''}
            onChange={(e) => set('employeeUserId', e.target.value)}
          >
            <option value="">Todos</option>
            {workers.data?.map((w) => (
              <option key={w.userId} value={w.userId}>
                {w.displayName}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="label">Responsável pela solução</span>
          <Select
            value={f.solverUserId ?? ''}
            onChange={(e) => set('solverUserId', e.target.value)}
          >
            <option value="">Todos</option>
            {workers.data?.map((w) => (
              <option key={w.userId} value={w.userId}>
                {w.displayName}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="label">OS</span>
          <Select
            value={f.serviceOrderId ?? ''}
            onChange={(e) => set('serviceOrderId', e.target.value)}
          >
            <option value="">Todas</option>
            {orders.map(([id, code]) => (
              <option key={id} value={id}>
                {code}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="label">Data</span>
          <Input type="date" value={f.date ?? ''} onChange={(e) => set('date', e.target.value)} />
        </label>
      </Card>
      {q.isPending ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <EmptyState
          icon={<Siren className="size-6" aria-hidden />}
          title="Nada pedindo atenção"
          description="Quando houver ocorrências, atrasos ou decisões pendentes, eles aparecem aqui."
        />
      ) : (
        <ul className="space-y-3" data-testid="attention-list">
          {q.data.items.map((i) => (
            <li key={i.key}>
              <Card
                className={clsx('p-4', CATEGORY_CARD[i.category])}
                data-testid={`attention-${i.key}`}
                data-category={i.category}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={CATEGORY_TONE[i.category]}>
                    {ATTENTION_CATEGORY_LABEL[i.category]}
                  </Badge>
                  <Badge tone="neutral">{ATTENTION_TYPE_LABEL[i.type as AttentionType]}</Badge>
                  <span className="font-semibold">{i.title}</span>
                  <span className="text-sm text-ink-muted">{i.statusLabel}</span>
                  <span className="ml-auto text-sm text-ink-muted">{formatDateTime(i.at)}</span>
                </div>
                <p className="mt-2 text-[15px]">{i.description}</p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-ink-soft sm:grid-cols-2 lg:grid-cols-4">
                  {i.serviceOrder && (
                    <div>
                      <dt className="inline text-ink-muted">OS: </dt>
                      <dd className="inline font-mono">{i.serviceOrder.code}</dd>
                    </div>
                  )}
                  {i.task && (
                    <div>
                      <dt className="inline text-ink-muted">Tarefa: </dt>
                      <dd className="inline">
                        {i.task.code} · {i.task.title}
                      </dd>
                    </div>
                  )}
                  {i.employee && (
                    <div>
                      <dt className="inline text-ink-muted">Funcionário: </dt>
                      <dd className="inline">{i.employee.displayName}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline text-ink-muted">Prioridade: </dt>
                    <dd className="inline">{PRIORITY_LABEL[i.priority as Priority]}</dd>
                  </div>
                  {i.deadline && (
                    <div>
                      <dt className="inline text-ink-muted">Prazo: </dt>
                      <dd className="inline">
                        {i.deadline.length > 10
                          ? formatDateTime(i.deadline)
                          : i.deadline.split('-').reverse().join('/')}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline text-ink-muted">Responsável pela solução: </dt>
                    <dd className="inline">{i.solver?.displayName ?? '—'}</dd>
                  </div>
                </dl>
                {i.impacts.length > 0 && (
                  <p className="mt-2 text-sm">
                    <span className="text-ink-muted">Impactos: </span>
                    {i.impacts.join(' · ')}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {i.nextActions.map((a) => (
                    <span
                      key={a}
                      className="rounded-lg bg-surface px-2 py-1 text-sm ring-1 ring-line"
                    >
                      {a}
                    </span>
                  ))}
                  <Link
                    href={i.link}
                    className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline"
                  >
                    Abrir <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ─────────────────────────── Detalhe da ocorrência ───────────────────────────

export function IssueDetailPage({ id }: { id: string }) {
  const q = useIssue(id);
  const impacts = useIssueImpacts(id);
  const can = useCan();
  const [dialog, setDialog] = useState<
    'assign' | 'action' | 'solution' | 'verify' | 'reopen' | 'cancel' | null
  >(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const i = q.data;
  const c = i.can;
  return (
    <>
      <BackLink href="/painel/atencao" label="Central de atenção" />
      <PageHeader
        title={`${i.code} · ${ISSUE_KIND_LABEL[i.kind]}`}
        description={i.description}
        actions={
          <div className="flex flex-wrap gap-2" data-testid="issue-actions">
            {c?.assign && <Button onClick={() => setDialog('assign')}>Delegar solução</Button>}
            {c?.record && (
              <Button variant="secondary" onClick={() => setDialog('action')}>
                Registrar ação
              </Button>
            )}
            {c?.requestVerification && (
              <Button variant="secondary" onClick={() => setDialog('solution')}>
                Registrar solução
              </Button>
            )}
            {c?.verify && <Button onClick={() => setDialog('verify')}>Verificar resolução</Button>}
            {c?.reopen && (
              <Button variant="secondary" onClick={() => setDialog('reopen')}>
                Reabrir
              </Button>
            )}
            {c?.cancel && (
              <Button variant="outline-danger" onClick={() => setDialog('cancel')}>
                Cancelar
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="issue-header">
        <Badge tone={CATEGORY_TONE[i.category]}>{ATTENTION_CATEGORY_LABEL[i.category]}</Badge>
        <Badge tone="info" dot>
          {ISSUE_STATUS_LABEL[i.status]}
        </Badge>
        <Badge tone="neutral">{ISSUE_IMPACT_LABEL[i.impact]}</Badge>
        <Badge tone={i.priority === 'URGENTE' || i.priority === 'ALTA' ? 'danger' : 'neutral'}>
          Prioridade {PRIORITY_LABEL[i.priority].toLowerCase()}
        </Badge>
        {i.deadlineRisk && <Badge tone="danger">Prazo em risco</Badge>}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title="Ocorrência">
            <dl className="grid gap-3 text-[15px] sm:grid-cols-2">
              <Info label="Registrada por">
                {i.reporter.displayName} · {formatDateTime(i.createdAt)}
              </Info>
              <Info label="OS e tarefa">
                {i.serviceOrder.code} · {i.task.code} · {i.task.title} (
                {TASK_STATUS_LABEL[i.task.status]})
              </Info>
              {i.material && (
                <Info label="Material">
                  {i.material.description} — {i.material.quantity}{' '}
                  {MATERIAL_UNIT_LABEL[i.material.unit].toLowerCase()}
                </Info>
              )}
              <Info label="Responsável pela solução">
                {i.assignee?.displayName ?? '—'}
                {i.actionTask
                  ? ` · ${i.actionTask.code} (${TASK_STATUS_LABEL[i.actionTask.status]})`
                  : ''}
              </Info>
              <Info label="Prazo de resolução">{i.dueAt ? formatDateTime(i.dueAt) : '—'}</Info>
              {i.resultNote && <Info label="Resultado">{i.resultNote}</Info>}
              {i.cancelReason && <Info label="Motivo do cancelamento">{i.cancelReason}</Info>}
            </dl>
          </Section>
          <Section title="Histórico">
            <ol className="space-y-2" data-testid="issue-history">
              {i.events?.map((e) => (
                <li key={e.id} className="rounded-xl border border-line p-3 text-sm">
                  <span className="text-ink-muted">
                    {formatDateTime(e.createdAt)} · {e.actor ?? '—'}
                  </span>
                  <span className="ml-2 font-semibold">
                    {e.toStatus
                      ? ISSUE_STATUS_LABEL[e.toStatus as IssueDto['status']]
                      : e.kind.replaceAll('_', ' ').toLowerCase()}
                  </span>
                  {e.note && <p className="mt-1">{e.note}</p>}
                </li>
              ))}
            </ol>
          </Section>
        </div>
        <div className="space-y-4">
          <Section title="Tarefas afetadas">
            {!impacts.data ? (
              <Spinner />
            ) : (
              <div className="space-y-2 text-sm" data-testid="issue-impacts">
                <p>
                  <span className="font-mono">{impacts.data.task.code}</span>{' '}
                  {impacts.data.task.title} · {impacts.data.task.assignee}
                </p>
                {impacts.data.dependents.map((d) => (
                  <p key={d.id} className="pl-3 text-ink-soft" style={{ marginLeft: d.depth * 8 }}>
                    ↳ <span className="font-mono">{d.code}</span> {d.title} · {d.assignee ?? '—'}
                    {d.dueDate ? ` · prazo ${d.dueDate.split('-').reverse().join('/')}` : ''}
                  </p>
                ))}
                {impacts.data.reasons.map((r) => (
                  <p key={r} className="text-danger-600">
                    {r}
                  </p>
                ))}
              </div>
            )}
          </Section>
          <Section title="Fotos">
            <PhotoGallery
              entityType="PRODUCTION_ISSUE"
              entityId={i.id}
              canManage={can('ocorrencias.gerenciar')}
            />
          </Section>
        </div>
      </div>
      {dialog === 'assign' && <AssignDialog i={i} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'assign' && (
        <NoteDialog i={i} kind={dialog} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AssignDialog({ i, onClose }: { i: IssueDto; onClose: () => void }) {
  const workers = useWorkers();
  const [assignee, setAssignee] = useState(i.assignee?.userId ?? '');
  const [instructions, setInstructions] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<Priority>(i.priority);
  const [skill, setSkill] = useState<Skill | ''>('');
  const [conflict, setConflict] = useState<string | null>(null);
  const { m, error, setError } = useSend(onClose);
  const send = (confirmConflict: boolean) =>
    m.mutate(
      {
        run: () =>
          api(`/api/v1/issues/${i.id}/assign`, {
            method: 'POST',
            body: {
              assigneeUserId: assignee,
              instructions,
              dueAt: due ? new Date(due).toISOString() : null,
              priority,
              requiredSkill: skill || null,
              confirmConflict,
              version: i.version,
            },
            idempotencyKey: newIdempotencyKey(),
          }),
        ok: 'Solução delegada.',
      },
      {
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409 && e.code === 'CONFLICT') {
            setConflict(e.message);
            setError(null);
          }
        },
      },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Delegar a solução de ${i.code}`}
      description="Cria uma tarefa de resolução separada para quem vai resolver. Concluir a ação não encerra a ocorrência: você verifica antes."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          {conflict ? (
            <Button variant="danger" loading={m.isPending} onClick={() => send(true)}>
              Atribuir mesmo assim
            </Button>
          ) : (
            <Button
              loading={m.isPending}
              disabled={!assignee || instructions.trim().length < 3}
              onClick={() => send(false)}
            >
              Delegar
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Quem vai resolver" required>
          {(f) => (
            <Select
              {...f}
              value={assignee}
              onChange={(e) => (setAssignee(e.target.value), setConflict(null))}
            >
              <option value="">Escolha…</option>
              {workers.data?.map((w) => (
                <option key={w.userId} value={w.userId}>
                  {w.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="O que fazer" required>
          {(f) => (
            <Input
              {...f}
              value={instructions}
              maxLength={300}
              placeholder="Ex.: Verificar a máquina de costura do Márcio"
              onChange={(e) => setInstructions(e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Prazo da solução">
            {(f) => (
              <Input
                {...f}
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            )}
          </Field>
          <Field label="Prioridade">
            {(f) => (
              <Select
                {...f}
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Competência exigida">
            {(f) => (
              <Select {...f} value={skill} onChange={(e) => setSkill(e.target.value as Skill | '')}>
                <option value="">Nenhuma</option>
                {SKILLS.map((s) => (
                  <option key={s} value={s}>
                    {SKILL_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {conflict && (
          <Alert tone="warn" title="Conflito de agenda">
            {conflict}
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

const NOTE_DIALOG = {
  action: {
    title: 'Registrar ação',
    label: 'O que foi feito',
    path: 'actions',
    ok: 'Ação registrada.',
  },
  solution: {
    title: 'Registrar solução',
    label: 'Solução aplicada (vai para verificação)',
    path: 'request-verification',
    ok: 'Solução registrada: aguardando verificação.',
  },
  verify: {
    title: 'Verificar resolução',
    label: 'Resultado da verificação',
    path: 'verify',
    ok: '',
  },
  reopen: {
    title: 'Reabrir ocorrência',
    label: 'Motivo da reabertura',
    path: 'reopen',
    ok: 'Ocorrência reaberta.',
  },
  cancel: {
    title: 'Cancelar ocorrência',
    label: 'Motivo do cancelamento',
    path: 'cancel',
    ok: 'Ocorrência cancelada.',
  },
} as const;

function NoteDialog({
  i,
  kind,
  onClose,
}: {
  i: IssueDto;
  kind: keyof typeof NOTE_DIALOG;
  onClose: () => void;
}) {
  const d = NOTE_DIALOG[kind];
  const [note, setNote] = useState('');
  const { m, error } = useSend(onClose);
  const send = (resolved?: boolean) =>
    m.mutate({
      run: () =>
        api(`/api/v1/issues/${i.id}/${d.path}`, {
          method: 'POST',
          body: { note, version: i.version, ...(resolved === undefined ? {} : { resolved }) },
          idempotencyKey: newIdempotencyKey(),
        }),
      ok:
        kind === 'verify'
          ? resolved
            ? 'Resolução confirmada. Funcionário avisado.'
            : 'Não resolvida: a ocorrência voltou a aberta.'
          : d.ok,
    });
  const valid = note.trim().length >= 3;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${d.title} — ${i.code}`}
      description={
        kind === 'verify'
          ? `Resultado informado: ${i.resultNote ?? '—'}. Confirme só se a causa foi eliminada (materiais e dependências são reavaliados).`
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          {kind === 'verify' ? (
            <>
              <Button
                variant="outline-danger"
                disabled={!valid}
                loading={m.isPending}
                onClick={() => send(false)}
              >
                Não resolvida
              </Button>
              <Button disabled={!valid} loading={m.isPending} onClick={() => send(true)}>
                Confirmar resolução
              </Button>
            </>
          ) : (
            <Button
              variant={kind === 'cancel' ? 'danger' : 'primary'}
              disabled={!valid}
              loading={m.isPending}
              onClick={() => send()}
            >
              {d.title}
            </Button>
          )}
        </>
      }
    >
      <Field label={d.label} required>
        {(f) => (
          <Input {...f} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        )}
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  );
}
