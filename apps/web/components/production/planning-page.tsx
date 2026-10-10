'use client';

import type {
  PlanCandidateDto,
  PlanItemDto,
  PlanMode,
  Priority,
  ProductionActivity,
  ProductionPlanDto,
  ProductionTaskDto,
  WorkerDto,
} from '@cenario/shared';
import {
  PLAN_MODES,
  PLAN_MODE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  PLANNABLE_ACTIVITIES,
  PRODUCTION_ACTIVITY_LABEL,
  compareQueue,
  mondayOf,
} from '@cenario/shared';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Forward,
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
import {
  useCandidates,
  useDistribution,
  usePlan,
  usePlansOfWeek,
  useWorkers,
} from '@/lib/production';
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
  // Evolução Fase 2 (D-1): planos novos nascem em fila semanal; "por horário" só se escolhido.
  const [mode, setMode] = useState<PlanMode>('FILA_SEMANAL');

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
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Select
                  aria-label="Modo do planejamento"
                  className="w-56"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as PlanMode)}
                >
                  {PLAN_MODES.map((x) => (
                    <option key={x} value={x}>
                      {PLAN_MODE_LABEL[x]}
                    </option>
                  ))}
                </Select>
                <Button
                  loading={m.isPending}
                  onClick={() =>
                    m.mutate({
                      run: () =>
                        api('/api/v1/production-plans', {
                          method: 'POST',
                          idempotencyKey: `${key}${mode}`,
                          body: { weekStart: week, mode },
                        }),
                      ok: 'Rascunho criado.',
                    })
                  }
                >
                  Criar planejamento da semana
                </Button>
              </div>
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
  const [carrying, setCarrying] = useState(false);
  const { m, error } = useSend();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const plan = q.data;
  const published = plan.status === 'PUBLICADO';
  const fila = plan.mode === 'FILA_SEMANAL';
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
        <span data-testid="plan-mode">
          <Badge tone={fila ? 'info' : undefined}>{PLAN_MODE_LABEL[plan.mode]}</Badge>
        </span>
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

      {fila && published && plan.weekEnded && plan.pendingCount > 0 && (
        <Alert tone="warn" title={`Semana encerrada com ${plan.pendingCount} pendência(s)`}>
          <p className="mt-1">
            As pendências continuam nesta semana até você decidir. Nada é transferido
            automaticamente.
          </p>
          <Button
            size="sm"
            className="mt-2"
            icon={<Forward className="size-3.5" aria-hidden />}
            onClick={() => setCarrying(true)}
          >
            Transferir pendências…
          </Button>
        </Alert>
      )}

      {fila && <DistributionSection plan={plan} workers={workers.data ?? []} reason={why} />}
      {fila && <QueuesSection plan={plan} workers={workers.data ?? []} reason={why} send={send} />}

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
      {carrying && <CarryOverDialog plan={plan} onClose={() => setCarrying(false)} />}
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
  // Evolução Fase 3 (fila): titular por peça; vazio = usa o principal acima como proposta.
  const fila = plan.mode === 'FILA_SEMANAL';
  const [owners, setOwners] = useState<Record<string, string>>({});
  const tapeceiros = workers.filter((w) => w.isTapeceiro);
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
                      ...(fila ? {} : { date }),
                      ...(fila
                        ? {
                            pieces: Object.entries(owners)
                              .filter(([, v]) => v)
                              .map(([serviceOrderItemId, upholstererUserId]) => ({
                                serviceOrderItemId,
                                upholstererUserId,
                              })),
                          }
                        : {}),
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
          label={
            fila
              ? 'Tapeceiro titular (proposta para todas as peças)'
              : hasSofa
                ? 'Tapeceiro principal (sofá)'
                : 'Responsável principal'
          }
          className="sm:col-span-3"
          hint={
            fila
              ? 'Toda a tapeçaria de cada peça fica com o seu titular. Sem titular, a peça fica pendente.'
              : 'Corte e costura ficam com o responsável principal.'
          }
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
        {fila &&
          candidate.items.map((it) => (
            <Field
              key={it.id}
              label={`Titular de ${it.code} · ${it.description}`}
              className="sm:col-span-3"
            >
              {(p) => (
                <Select
                  {...p}
                  value={owners[it.id] ?? ''}
                  onChange={(e) => setOwners({ ...owners, [it.id]: e.target.value })}
                >
                  <option value="">Usar a proposta acima / titular já definido</option>
                  {tapeceiros.map((w) => (
                    <option key={w.userId} value={w.userId}>
                      {w.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ))}
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
        {plan.mode !== 'FILA_SEMANAL' && (
          <Field label="Começar em" className="sm:col-span-2">
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
        )}
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
  const timed = plan.mode !== 'FILA_SEMANAL';
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
            className="input-sm w-48"
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
          className="data-table min-w-[1200px]"
          data-testid={`plan-tasks-${item.serviceOrder.code}`}
        >
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-56 bg-subtle">Tarefa</th>
              <th>Responsável</th>
              {timed && <th>Dia</th>}
              {timed && <th>Hora</th>}
              <th>Prazo interno</th>
              <th>Prioridade</th>
              <th>Depende de</th>
              <th>Situação</th>
              <th />
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
                  <td className="sticky left-0 z-10 min-w-56 bg-surface shadow-[1px_0_0_var(--color-line)]">
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
                  <td>
                    <Select
                      aria-label={`Responsável de ${t.title}`}
                      className="input-sm min-w-32"
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
                  {timed && (
                    <td>
                      <Input
                        aria-label={`Dia de ${t.title}`}
                        type="date"
                        className="input-sm w-40"
                        disabled={locked}
                        value={t.scheduledDate ?? ''}
                        onChange={(e) => put(t, { date: e.target.value || null })}
                      />
                    </td>
                  )}
                  {timed && (
                    <td>
                      <Input
                        aria-label={`Hora de ${t.title}`}
                        type="time"
                        className="input-sm w-28"
                        disabled={locked || !t.scheduledDate}
                        value={t.scheduledTime ?? ''}
                        onChange={(e) =>
                          e.target.value && put(t, { date: t.scheduledDate, time: e.target.value })
                        }
                      />
                    </td>
                  )}
                  <td>
                    <Input
                      aria-label={`Prazo de ${t.title}`}
                      type="date"
                      className="input-sm w-40"
                      disabled={locked}
                      value={t.dueDate ?? ''}
                      onChange={(e) => put(t, { dueDate: e.target.value || null })}
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`Prioridade de ${t.title}`}
                      className="input-sm min-w-28"
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
                  <td className="text-xs">
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
                  <td>
                    <TaskStatusBadge status={t.status} />
                    {t.blockers.length > 0 && (
                      <span className="block text-xs text-danger-600">
                        {blockersText(t.blockers)}
                      </span>
                    )}
                  </td>
                  <td>
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
              className="input-sm"
              value={activity}
              onChange={(e) => setActivity(e.target.value as ProductionActivity)}
            >
              {PLANNABLE_ACTIVITIES.map((a) => (
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

/**
 * Evolução Fase 2 — fila de cada funcionário neste planejamento (ordem da fila, sem horário).
 * Mover respeita faixas de prioridade e dependências (validado no servidor); publicado exige
 * motivo e gera revisão; a versão do plano impede sobrescrever a alteração de outro gestor.
 */
function QueuesSection({
  plan,
  workers,
  reason,
  send,
}: {
  plan: ProductionPlanDto;
  workers: WorkerDto[];
  reason: string | undefined;
  send: (run: () => Promise<unknown>, ok?: string) => void;
}) {
  const open = (t: ProductionTaskDto) =>
    !t.supportFor &&
    (plan.status === 'PUBLICADO'
      ? !['CONCLUIDA', 'CANCELADA', 'RASCUNHO'].includes(t.status)
      : t.status === 'RASCUNHO');
  const key = (t: ProductionTaskDto) => ({ ...t, weekStart: plan.weekStart });
  const queues = workers
    .map((w) => ({
      w,
      list: plan.tasks
        .filter((t) => t.assignee?.userId === w.userId && open(t))
        .sort((a, b) => compareQueue(key(a), key(b))),
    }))
    .filter((x) => x.list.length > 0);
  const done = plan.tasks.filter((t) => t.status === 'CONCLUIDA' && !t.supportFor).length;
  const total = plan.tasks.filter((t) => t.status !== 'CANCELADA' && !t.supportFor).length;
  const move = (userId: string, list: ProductionTaskDto[], i: number, d: -1 | 1) => {
    const ids = list.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    send(
      () =>
        api(`/api/v1/production-plans/${plan.id}/queue`, {
          method: 'PUT',
          idempotencyKey: newIdempotencyKey(),
          body: { userId, taskIds: ids, version: plan.version, reason },
        }),
      'Fila reordenada.',
    );
  };
  return (
    <Section title={`Filas da semana · ${done} de ${total} concluída(s)`} bodyClassName="p-0">
      {queues.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">
          Nenhuma tarefa com responsável. Defina os responsáveis nas OS abaixo.
        </p>
      ) : (
        <div className="grid gap-0 divide-y divide-line lg:grid-cols-2 lg:divide-x">
          {queues.map(({ w, list }) => (
            <div key={w.userId} className="p-4" data-testid={`queue-${w.displayName}`}>
              <h3 className="mb-2 font-semibold">
                {w.displayName} <span className="text-ink-muted">({list.length})</span>
              </h3>
              <ol className="space-y-1">
                {list.map((t, i) => (
                  <li key={t.id} className="flex items-center gap-2 text-sm">
                    <span className="w-6 text-right font-mono text-ink-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <Link href={`/painel/producao/tarefas/${t.id}`} className="hover:underline">
                        {t.code} · {t.title}
                      </Link>
                      {t.carriedFromWeek && (
                        <Badge tone="warn" className="ml-1">
                          da semana {formatDay(t.carriedFromWeek)}
                        </Badge>
                      )}
                    </span>
                    <PriorityBadge priority={t.priority} />
                    <TaskStatusBadge status={t.status} />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Subir ${t.code}`}
                      disabled={i === 0}
                      icon={<ArrowUp className="size-3.5" aria-hidden />}
                      onClick={() => move(w.userId, list, i, -1)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Descer ${t.code}`}
                      disabled={i === list.length - 1}
                      icon={<ArrowDown className="size-3.5" aria-hidden />}
                      onClick={() => move(w.userId, list, i, 1)}
                    />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** Pendências de uma semana encerrada → outra semana em fila já publicada (ação explícita). */
function CarryOverDialog({ plan, onClose }: { plan: ProductionPlanDto; onClose: () => void }) {
  const target = usePlansOfWeek(addDays(plan.weekStart, 7));
  const to = target.data?.[0];
  const pending = plan.tasks.filter(
    (t) => !t.supportFor && ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'PAUSADA'].includes(t.status),
  );
  const [sel, setSel] = useState(() => new Set(pending.map((t) => t.id)));
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  const ready = to && to.status === 'PUBLICADO' && to.mode === 'FILA_SEMANAL';
  return (
    <Dialog
      open
      onClose={onClose}
      title="Transferir pendências"
      description={`Para a semana de ${formatDay(addDays(plan.weekStart, 7))}. Responsável, andamento e histórico são mantidos; tarefas em execução não são transferidas.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!ready || sel.size === 0 || reason.trim().length < 3}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-plans/${plan.id}/carry-over`, {
                    method: 'POST',
                    idempotencyKey: key,
                    body: { toPlanId: to!.id, taskIds: [...sel], reason },
                  }),
                ok: 'Pendências transferidas.',
              })
            }
          >
            Transferir {sel.size}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {!target.isPending && !ready && (
        <Alert tone="warn" className="mb-3">
          Crie e publique o planejamento em fila da próxima semana antes de transferir.
        </Alert>
      )}
      <div className="mb-4 max-h-72 space-y-2 overflow-y-auto">
        {pending.map((t) => (
          <Checkbox
            key={t.id}
            label={`${t.code} · ${t.title} · ${t.assignee?.displayName ?? 'sem responsável'}`}
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
      <Field label="Motivo (histórico)">
        {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

/**
 * Evolução Fase 3 — distribuição por peça: titular, responsáveis, inspetor e pendências.
 * Definir o titular pela primeira vez é direto; trocar é substituição (motivo + confirmação).
 */
function DistributionSection({
  plan,
  workers,
  reason,
}: {
  plan: ProductionPlanDto;
  workers: WorkerDto[];
  reason: string | undefined;
}) {
  const q = useDistribution(plan.id);
  const { m, error } = useSend();
  const [replacing, setReplacing] = useState<{
    itemId: string;
    code: string;
    from: string;
    to: string;
  } | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const tapeceiros = workers.filter((w) => w.isTapeceiro);
  const define = (itemId: string, userId: string) =>
    m.mutate({
      run: () =>
        api(`/api/v1/service-order-items/${itemId}/upholsterer`, {
          method: 'PUT',
          idempotencyKey: newIdempotencyKey(),
          body: { userId, expectedUserId: null, reason },
        }),
      ok: 'Titular definido.',
    });
  return (
    <Section
      title={`Distribuição por peça · ${q.data.pendencyCount} pendência(s)`}
      bodyClassName="p-0"
      actions={plan.items.map((it) => (
        <Button
          key={it.id}
          size="sm"
          variant="secondary"
          loading={m.isPending}
          onClick={() =>
            m.mutate({
              run: () =>
                api(`/api/v1/production-plans/${plan.id}/items/${it.id}/distribute`, {
                  method: 'POST',
                  idempotencyKey: newIdempotencyKey(),
                  body: { reason },
                }),
              ok: 'Distribuição reprocessada.',
            })
          }
        >
          Reprocessar {it.serviceOrder.code}
        </Button>
      ))}
    >
      {error && (
        <Alert tone="danger" className="m-4">
          {error}
        </Alert>
      )}
      <ul className="divide-y divide-line" data-testid="distribution">
        {q.data.pieces.map((p) => (
          <li key={p.item.id} className="space-y-2 px-5 py-3" data-testid={`piece-${p.item.code}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm font-semibold">{p.item.code}</span>
              <span className="min-w-0 flex-1 text-sm">
                {p.item.description}
                <span className="block text-xs text-ink-muted">
                  {p.template ? `Modelo: ${p.template.name}` : 'Sem modelo'} · Inspeção:{' '}
                  {p.inspector?.displayName ?? 'sem inspetor'}
                </span>
              </span>
              {p.needsUpholstery && (
                <Select
                  aria-label={`Titular de ${p.item.code}`}
                  className="input-sm w-48"
                  value={p.upholsterer?.userId ?? ''}
                  onChange={(e) => {
                    const to = e.target.value;
                    if (!to) return;
                    if (!p.upholsterer) define(p.item.id, to);
                    else
                      setReplacing({
                        itemId: p.item.id,
                        code: p.item.code,
                        from: p.upholsterer.userId,
                        to,
                      });
                  }}
                >
                  <option value="">Titular: a definir</option>
                  {tapeceiros.map((w) => (
                    <option key={w.userId} value={w.userId}>
                      Titular: {w.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <p className="text-xs text-ink-muted">
              {p.tasks
                .map(
                  (t) => `${t.code} ${t.title.split(' — ')[0]}: ${t.assignee?.displayName ?? '—'}`,
                )
                .join(' · ')}
            </p>
            {p.pendencies.length > 0 && (
              <ul
                className="list-disc pl-5 text-sm text-warn-600"
                data-testid={`pendencies-${p.item.code}`}
              >
                {p.pendencies.map((x, i) => (
                  <li key={i}>{x.message}</li>
                ))}
              </ul>
            )}
            {p.ownerChanges.length > 0 && (
              <p className="text-xs text-ink-muted">
                {p.ownerChanges
                  .map(
                    (c) =>
                      `${c.kind === 'DEFINICAO' ? 'Definido' : 'Substituído'}: ${c.from ? `${c.from} → ` : ''}${c.to} (${formatDateTime(c.createdAt)}${c.reason ? `, ${c.reason}` : ''}${c.financialReviewRequired ? ', revisão financeira pendente' : ''})`,
                  )
                  .join(' · ')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {replacing && (
        <ReplaceOwnerDialog
          value={replacing}
          name={(id) => workers.find((w) => w.userId === id)?.displayName ?? '—'}
          onClose={() => setReplacing(null)}
        />
      )}
    </Section>
  );
}

function ReplaceOwnerDialog({
  value,
  name,
  onClose,
}: {
  value: { itemId: string; code: string; from: string; to: string };
  name: (id: string) => string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Substituir o titular de ${value.code}?`}
      description={`${name(value.from)} → ${name(value.to)}. Etapas concluídas e o histórico ficam como estão; só as pendentes passam ao novo titular. Valores combinados não mudam: havendo mão de obra com outra pessoa, fica sinalizada a revisão financeira.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!confirm || reason.trim().length < 3}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/service-order-items/${value.itemId}/upholsterer`, {
                    method: 'PUT',
                    idempotencyKey: key,
                    body: { userId: value.to, expectedUserId: value.from, reason, confirm },
                  }),
                ok: 'Titular substituído.',
              })
            }
          >
            Substituir
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Motivo (histórico e auditoria)">
        {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <div className="mt-3">
        <Checkbox
          label="Confirmo a substituição (ação excepcional)"
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
        />
      </div>
    </Dialog>
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
