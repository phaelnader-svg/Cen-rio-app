'use client';

import type {
  PlanCandidateDto,
  PlanItemDto,
  Priority,
  ProductionActivity,
  ProductionPlanDto,
  ProductionTaskDto,
  WorkerDto,
} from '@cenario/shared';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  PRODUCTION_ACTIVITIES,
  PRODUCTION_ACTIVITY_LABEL,
  mondayOf,
} from '@cenario/shared';
import {
  AlertTriangle,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Link2,
  Plus,
  Send,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { Section } from '@/components/commercial/section';
import { ReadinessBadge } from '@/components/purchasing/badges';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { HelpAndRescheduleBanner } from '@/components/help/pages';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { addDays, formatDay, todayIso } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { useCandidates, usePlan, usePlansOfWeek, useWorkers } from '@/lib/production';
import { TaskStatusBadge, blockersText } from './badges';
import { useSend } from './use-send';

/** Planejamento semanal de produção (sexta é o dia padrão; qualquer dia é permitido). */
export function ProductionPlanningPage() {
  const me = useMe();
  const today = todayIso(me.data?.company.timezone);
  const [week, setWeek] = useState(() => mondayOf(addDays(today, 3)));
  const plans = usePlansOfWeek(week);
  const plan = plans.data?.[0] ?? null;
  const { m, error } = useSend();
  const [key] = useState(newIdempotencyKey);

  return (
    <>
      <PageHeader
        title="Planejamento de produção"
        description="Selecione as OS da semana, defina responsáveis, dias e dependências e publique. Material disponível não inicia a produção: só a programação publicada libera as tarefas."
        actions={
          <Link
            href="/painel/producao"
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Quadro de produção →
          </Link>
        }
      />
      <HelpAndRescheduleBanner />
      <Card className="mb-6 flex flex-wrap items-center gap-3 p-4">
        <Button
          variant="secondary"
          size="sm"
          aria-label="Semana anterior"
          icon={<ChevronLeft className="size-4" aria-hidden />}
          onClick={() => setWeek(addDays(week, -7))}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Semana de</span>
          <Input
            type="date"
            aria-label="Semana"
            className="w-44"
            value={week}
            onChange={(e) => e.target.value && setWeek(mondayOf(e.target.value))}
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Próxima semana"
          icon={<ChevronRight className="size-4" aria-hidden />}
          onClick={() => setWeek(addDays(week, 7))}
        />
        <span className="text-sm text-ink-muted">
          {formatDay(week)} a {formatDay(addDays(week, 6))}
        </span>
      </Card>
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {plans.isPending ? (
        <Spinner />
      ) : !plan ? (
        <Card>
          <EmptyState
            icon={<CalendarRange className="size-6" aria-hidden />}
            title="Nenhum planejamento para esta semana"
            description="Crie o rascunho, escolha as OS e publique quando estiver pronto."
            action={
              <Button
                loading={m.isPending}
                onClick={() =>
                  m.mutate({
                    run: () =>
                      api('/api/v1/production-plans', {
                        method: 'POST',
                        idempotencyKey: key,
                        body: { weekStart: week },
                      }),
                    ok: 'Rascunho criado.',
                  })
                }
              >
                Criar planejamento da semana
              </Button>
            }
          />
        </Card>
      ) : (
        <PlanEditor key={plan.id} planId={plan.id} />
      )}
    </>
  );
}

function PlanEditor({ planId }: { planId: string }) {
  const q = usePlan(planId);
  const workers = useWorkers();
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState<PlanCandidateDto | null>(null);
  const [publishing, setPublishing] = useState(false);
  const { m, error } = useSend();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const plan = q.data;
  const published = plan.status === 'PUBLICADO';
  const why = published ? reason : undefined;
  const send = (run: () => Promise<unknown>, ok?: string) => {
    if (published && reason.trim().length < 3) {
      m.reset();
      alertNeedReason();
      return;
    }
    m.mutate({ run, ok });
  };
  const alertNeedReason = () => document.getElementById('plan-reason')?.focus();

  return (
    <div className="space-y-6" data-testid="plan-editor">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        {published ? (
          <Badge tone="ok" dot>
            Publicado · revisão {plan.revision}
          </Badge>
        ) : (
          <Badge dot>Rascunho</Badge>
        )}
        <span className="text-sm text-ink-muted">
          {plan.items.length} OS · {plan.tasks.filter((t) => t.status !== 'CANCELADA').length}{' '}
          tarefa(s)
          {plan.publishedAt ? ` · publicado em ${formatDateTime(plan.publishedAt)}` : ''}
        </span>
        <span className="flex-1" />
        {published ? (
          <label className="flex min-w-72 flex-1 items-center gap-2 text-sm">
            <span className="shrink-0 font-medium">Motivo das alterações</span>
            <Input
              id="plan-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Obrigatório após publicar (vai para o histórico)"
            />
          </label>
        ) : (
          <Button
            icon={<Send className="size-4" aria-hidden />}
            onClick={() => setPublishing(true)}
            disabled={plan.tasks.length === 0}
          >
            Revisar e publicar
          </Button>
        )}
      </Card>
      {(error || (m.isError && !error)) && <Alert tone="danger">{error}</Alert>}
      {published && reason.trim().length < 3 && (
        <p className="-mt-3 text-sm text-ink-muted">
          Para alterar a programação publicada, informe o motivo acima.
        </p>
      )}

      {plan.conflicts.length > 0 && (
        <Alert tone="warn" title={`Conflitos e avisos (${plan.conflicts.length})`}>
          <ul className="mt-1 list-disc pl-5" data-testid="plan-conflicts">
            {plan.conflicts.slice(0, 12).map((c, i) => (
              <li key={i}>{c.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <CandidatesSection planId={planId} onAdd={setAdding} />

      {plan.items.map((item) => (
        <ItemSection
          key={item.id}
          plan={plan}
          item={item}
          workers={workers.data ?? []}
          reason={why}
          send={send}
        />
      ))}

      {plan.revisions.length > 0 && (
        <Section title="Histórico de revisões" bodyClassName="p-0">
          <ol className="divide-y divide-line" data-testid="plan-revisions">
            {plan.revisions.map((r) => (
              <li key={r.id} className="px-5 py-3 text-sm">
                <strong>Revisão {r.revision}</strong> · {formatDateTime(r.createdAt)} ·{' '}
                {r.createdBy}
                {r.offSchedule && (
                  <Badge tone="warn" className="ml-2">
                    fora da sexta
                  </Badge>
                )}
                <span className="block text-ink-muted">
                  {r.reason} · {r.taskCount} tarefa(s)
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {adding && (
        <AddOsDialog
          plan={plan}
          candidate={adding}
          workers={workers.data ?? []}
          reason={why}
          onClose={() => setAdding(null)}
        />
      )}
      {publishing && <PublishDialog plan={plan} onClose={() => setPublishing(false)} />}
    </div>
  );
}

function CandidatesSection({
  planId,
  onAdd,
}: {
  planId: string;
  onAdd: (c: PlanCandidateDto) => void;
}) {
  const q = useCandidates(planId);
  const list = (q.data ?? []).filter((c) => !c.inPlan);
  return (
    <Section title={`OS abertas disponíveis (${list.length})`} bodyClassName="p-0">
      {q.isPending ? (
        <Spinner className="p-5" />
      ) : list.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Todas as OS abertas já estão na semana.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="plan-candidates">
          {list.map((c) => (
            <li
              key={c.serviceOrder.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3"
              data-testid={`candidate-${c.serviceOrder.code}`}
            >
              <Link
                href={`/painel/os/${c.serviceOrder.id}`}
                className="w-24 font-mono text-sm font-semibold text-brand-700 hover:underline"
              >
                {c.serviceOrder.code}
              </Link>
              <span className="min-w-0 flex-1">
                {c.customerName}
                <span className="block text-xs text-ink-muted">
                  {c.items.map((i) => i.description).join(', ')} · prazo{' '}
                  {formatDay(c.serviceOrder.promisedDate)}
                </span>
              </span>
              <PriorityBadge priority={c.serviceOrder.priority} />
              <ReadinessBadge state={c.materialsState} />
              <Button
                size="sm"
                icon={<Plus className="size-3.5" aria-hidden />}
                onClick={() => onAdd(c)}
              >
                Adicionar à semana
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AddOsDialog({
  plan,
  candidate,
  workers,
  reason,
  onClose,
}: {
  plan: ProductionPlanDto;
  candidate: PlanCandidateDto;
  workers: WorkerDto[];
  reason: string | undefined;
  onClose: () => void;
}) {
  const hasSofa = candidate.items.some((i) => i.pieceType === 'SOFA');
  const [principal, setPrincipal] = useState(candidate.technicalLead?.userId ?? '');
  const [priority, setPriority] = useState<Priority>(candidate.serviceOrder.priority);
  const [date, setDate] = useState(plan.weekStart);
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Adicionar ${candidate.serviceOrder.code} à semana`}
      description="As tarefas são sugeridas pelos modelos de cada peça; depois ajuste responsáveis, horários e etapas."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-plans/${plan.id}/items`, {
                    method: 'POST',
                    idempotencyKey: key,
                    body: {
                      serviceOrderId: candidate.serviceOrder.id,
                      principalUserId: principal || null,
                      priority,
                      date,
                      reason,
                    },
                  }),
                ok: `${candidate.serviceOrder.code} adicionada.`,
              })
            }
          >
            Adicionar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {candidate.materialsState !== 'COMPLETO' && (
        <Alert tone="warn" className="mb-4">
          Materiais: as etapas que exigem material ficarão bloqueadas até a prontidão completa.
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label={hasSofa ? 'Tapeceiro principal (sofá)' : 'Responsável principal'}
          className="sm:col-span-3"
          hint="Corte e costura ficam com o responsável principal."
        >
          {(p) => (
            <Select {...p} value={principal} onChange={(e) => setPrincipal(e.target.value)}>
              <option value="">{hasSofa ? 'Selecione…' : 'A definir'}</option>
              {workers
                .filter((w) => !hasSofa || w.isTapeceiro)
                .map((w) => (
                  <option key={w.userId} value={w.userId}>
                    {w.displayName}
                    {w.jobTitle ? ` — ${w.jobTitle}` : ''}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Prioridade">
          {(p) => (
            <Select
              {...p}
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {PRIORITY_LABEL[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Começar em" className="sm:col-span-2">
          {(p) => (
            <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function ItemSection({
  plan,
  item,
  workers,
  reason,
  send,
}: {
  plan: ProductionPlanDto;
  item: PlanItemDto;
  workers: WorkerDto[];
  reason: string | undefined;
  send: (run: () => Promise<unknown>, ok?: string) => void;
}) {
  const tasks = plan.tasks.filter((t) => t.serviceOrder.id === item.serviceOrder.id);
  const [deps, setDeps] = useState<ProductionTaskDto | null>(null);
  const [activity, setActivity] = useState<ProductionActivity>('APOIO');
  const [key] = useState(newIdempotencyKey);
  const put = (t: ProductionTaskDto, body: Record<string, unknown>) =>
    send(() =>
      api(`/api/v1/production-tasks/${t.id}`, {
        method: 'PUT',
        body: { ...body, version: t.version, reason },
      }),
    );
  return (
    <Section
      title={`${item.serviceOrder.code} · ${item.customerName}`}
      actions={
        <>
          <ReadinessBadge state={item.materialsState} />
          <PriorityBadge priority={item.priority} />
          <Select
            aria-label={`Responsável principal da ${item.serviceOrder.code}`}
            className="h-8 w-48 py-0 text-sm"
            value={item.principal?.userId ?? ''}
            onChange={(e) =>
              send(
                () =>
                  api(`/api/v1/production-plans/${plan.id}/items/${item.id}`, {
                    method: 'PUT',
                    body: { principalUserId: e.target.value || null, reason },
                  }),
                'Responsável principal alterado.',
              )
            }
          >
            <option value="">Principal: a definir</option>
            {workers
              .filter((w) => !item.hasSofa || w.isTapeceiro)
              .map((w) => (
                <option key={w.userId} value={w.userId}>
                  Principal: {w.displayName}
                </option>
              ))}
          </Select>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" aria-hidden />}
            onClick={() =>
              send(
                () =>
                  api(`/api/v1/production-plans/${plan.id}/items/${item.id}/remove`, {
                    method: 'POST',
                    body: { reason },
                  }),
                'OS retirada da semana.',
              )
            }
          >
            Retirar
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[1200px] text-sm"
          data-testid={`plan-tasks-${item.serviceOrder.code}`}
        >
          <thead className="bg-subtle/60 text-left text-xs text-ink-muted uppercase">
            <tr>
              <th className="sticky left-0 z-10 min-w-56 bg-subtle px-3 py-2 font-semibold">
                Tarefa
              </th>
              <th className="px-3 py-2 font-semibold">Responsável</th>
              <th className="px-3 py-2 font-semibold">Dia</th>
              <th className="px-3 py-2 font-semibold">Hora</th>
              <th className="px-3 py-2 font-semibold">Prazo interno</th>
              <th className="px-3 py-2 font-semibold">Prioridade</th>
              <th className="px-3 py-2 font-semibold">Depende de</th>
              <th className="px-3 py-2 font-semibold">Situação</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {tasks.map((t) => {
              const locked = ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA'].includes(
                t.status,
              );
              return (
                <tr
                  key={t.id}
                  data-testid={`plan-task-${t.title}`}
                  className={t.status === 'CANCELADA' ? 'opacity-50' : undefined}
                >
                  <td className="sticky left-0 z-10 min-w-56 bg-surface px-3 py-2 shadow-[1px_0_0_var(--color-line)]">
                    <Link
                      href={`/painel/producao/tarefas/${t.id}`}
                      className="font-medium hover:underline"
                    >
                      {t.title}
                    </Link>
                    <span className="block font-mono text-xs text-ink-muted">
                      {t.code}
                      {t.requiresMaterials ? ' · exige materiais' : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Responsável de ${t.title}`}
                      className="h-9 min-w-32 py-0 text-sm"
                      disabled={locked}
                      value={t.assignee?.userId ?? ''}
                      onChange={(e) => put(t, { assigneeUserId: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {workers.map((w) => (
                        <option key={w.userId} value={w.userId}>
                          {w.displayName}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Dia de ${t.title}`}
                      type="date"
                      className="h-9 w-40 py-0 text-sm"
                      disabled={locked}
                      value={t.scheduledDate ?? ''}
                      onChange={(e) => put(t, { date: e.target.value || null })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Hora de ${t.title}`}
                      type="time"
                      className="h-9 w-28 py-0 text-sm"
                      disabled={locked || !t.scheduledDate}
                      value={t.scheduledTime ?? ''}
                      onChange={(e) =>
                        e.target.value && put(t, { date: t.scheduledDate, time: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Prazo de ${t.title}`}
                      type="date"
                      className="h-9 w-40 py-0 text-sm"
                      disabled={locked}
                      value={t.dueDate ?? ''}
                      onChange={(e) => put(t, { dueDate: e.target.value || null })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Prioridade de ${t.title}`}
                      className="h-9 min-w-28 py-0 text-sm"
                      disabled={locked}
                      value={t.priority}
                      onChange={(e) => put(t, { priority: e.target.value })}
                    >
                      {PRIORITIES.map((x) => (
                        <option key={x} value={x}>
                          {PRIORITY_LABEL[x]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-brand-700 hover:underline disabled:text-ink-muted"
                      disabled={locked}
                      onClick={() => setDeps(t)}
                    >
                      <Link2 className="size-3.5" aria-hidden />
                      {t.dependsOn.length ? t.dependsOn.map((d) => d.code).join(', ') : 'nenhuma'}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <TaskStatusBadge status={t.status} />
                    {t.blockers.length > 0 && (
                      <span className="block text-xs text-danger-600">
                        {blockersText(t.blockers)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {!locked && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remover ${t.title}`}
                        icon={<Trash2 className="size-3.5" aria-hidden />}
                        onClick={() =>
                          send(() =>
                            api(`/api/v1/production-tasks/${t.id}/cancel`, {
                              method: 'POST',
                              body: { reason: reason ?? 'Etapa não aplicável' },
                            }),
                          )
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2 border-t border-line px-5 py-3">
        <Field label="Incluir etapa">
          {(p) => (
            <Select
              {...p}
              className="h-9 py-0 text-sm"
              value={activity}
              onChange={(e) => setActivity(e.target.value as ProductionActivity)}
            >
              {PRODUCTION_ACTIVITIES.map((a) => (
                <option key={a} value={a}>
                  {PRODUCTION_ACTIVITY_LABEL[a]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus className="size-3.5" aria-hidden />}
          onClick={() =>
            send(() =>
              api(`/api/v1/production-plans/${plan.id}/tasks`, {
                method: 'POST',
                idempotencyKey: `${key}${activity}${tasks.length}`,
                body: { serviceOrderId: item.serviceOrder.id, activity, reason },
              }),
            )
          }
        >
          Incluir
        </Button>
      </div>
      {deps && (
        <DepsDialog task={deps} tasks={tasks} reason={reason} onClose={() => setDeps(null)} />
      )}
    </Section>
  );
}

export function DepsDialog({
  task,
  tasks,
  reason,
  onClose,
}: {
  task: ProductionTaskDto;
  tasks: Pick<ProductionTaskDto, 'id' | 'code' | 'title' | 'status'>[];
  reason: string | undefined;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(new Set(task.dependsOn.map((d) => d.id)));
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Dependências de ${task.code}`}
      description={`${task.title} só começa depois das etapas marcadas (ciclos são recusados).`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-tasks/${task.id}/dependencies`, {
                    method: 'PUT',
                    body: { dependsOn: [...sel], version: task.version, reason },
                  }),
                ok: 'Dependências salvas.',
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="space-y-2">
        {tasks
          .filter((t) => t.id !== task.id && t.status !== 'CANCELADA')
          .map((t) => (
            <Checkbox
              key={t.id}
              label={`${t.code} · ${t.title}`}
              checked={sel.has(t.id)}
              onChange={(e) => {
                const n = new Set(sel);
                if (e.target.checked) n.add(t.id);
                else n.delete(t.id);
                setSel(n);
              }}
            />
          ))}
      </div>
    </Dialog>
  );
}

function PublishDialog({ plan, onClose }: { plan: ProductionPlanDto; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  const byPerson = new Map<string, number>();
  for (const t of plan.tasks)
    byPerson.set(
      t.assignee?.displayName ?? 'Sem responsável',
      (byPerson.get(t.assignee?.displayName ?? 'Sem responsável') ?? 0) + 1,
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Publicar a programação da semana?"
      description="As tarefas vão para os tablets. Alterações posteriores exigem motivo e geram nova revisão."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-plans/${plan.id}/publish`, {
                    method: 'POST',
                    idempotencyKey: key,
                    body: { version: plan.version, notes },
                  }),
                ok: 'Programação publicada.',
              })
            }
          >
            Publicar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <ul className="mb-4 text-sm">
        {[...byPerson].map(([n, c]) => (
          <li key={n}>
            {n}: <strong>{c}</strong> tarefa(s)
          </li>
        ))}
      </ul>
      {plan.conflicts.length > 0 && (
        <Alert tone="warn" className="mb-4">
          <AlertTriangle className="mr-1 inline size-4" aria-hidden />
          {plan.conflicts.length} aviso(s): tarefas sem responsável, sem horário ou sem materiais
          ficarão bloqueadas.
        </Alert>
      )}
      <Field label="Observações (histórico)">
        {(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
