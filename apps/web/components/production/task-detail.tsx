'use client';

import type { CompletionRequirement, Priority, ProductionTaskDetailDto } from '@cenario/shared';
import {
  COMPLETION_REQUIREMENTS,
  COMPLETION_REQUIREMENT_LABEL,
  LINE_STAGE_LABEL,
  PAUSE_REASON_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  PRODUCTION_ACTIVITY_LABEL,
  TASK_ROLE_LABEL,
  TASK_WAITING,
} from '@cenario/shared';
import { Ban, Link2, Lock, LockOpen } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { BackLink, Detail, Section } from '@/components/commercial/section';
import { ReadinessBadge } from '@/components/purchasing/badges';
import { qtyText, specText } from '@/components/purchasing/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useTask, useWorkers } from '@/lib/production';
import { TaskStatusBadge, blockersText } from './badges';
import { DepsDialog } from './planning-page';
import { TaskHistory, TaskRefs } from './task-history';
import { useSend } from './use-send';

/** Detalhe da tarefa no painel, com as ações do gestor. */
export function TaskAdminDetail({ id }: { id: string }) {
  const q = useTask(id);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [deps, setDeps] = useState(false);
  const [action, setAction] = useState<'cancel' | 'block' | null>(null);
  const { m, error } = useSend();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const t = q.data;
  const published = t.plan?.status === 'PUBLICADO';
  const open = t.status !== 'CONCLUIDA' && t.status !== 'CANCELADA';
  const waiting = (TASK_WAITING as readonly string[]).includes(t.status);
  return (
    <>
      <BackLink href="/painel/producao" label="Quadro de produção" />
      <PageHeader
        title={`${t.code} · ${t.title}`}
        description={`${t.serviceOrder.code} · ${t.customerName}${t.serviceOrderItem ? ` · ${t.serviceOrderItem.description}` : ''}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
          </span>
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {t.status === 'BLOQUEADA' && (
        <Alert tone="warn" className="mb-4" title="Bloqueada">
          {[t.blockedReason, blockersText(t.blockers)].filter(Boolean).join(' · ')}
        </Alert>
      )}
      {t.status === 'PAUSADA' && t.pauseReason && (
        <Alert
          tone="warn"
          className="mb-4"
          title={`Pausada — ${PAUSE_REASON_LABEL[t.pauseReason]}`}
        >
          {t.pauseNote}
        </Alert>
      )}
      {t.can.manage && open && (
        <div className="mb-6 flex flex-wrap gap-2" data-testid="task-admin-actions">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Reprogramar / editar
          </Button>
          <Button
            variant="secondary"
            icon={<Link2 className="size-4" aria-hidden />}
            onClick={() => setDeps(true)}
          >
            Dependências
          </Button>
          {waiting &&
            (t.blockedReason ? (
              <Button
                variant="secondary"
                loading={m.isPending}
                icon={<LockOpen className="size-4" aria-hidden />}
                onClick={() =>
                  m.mutate({
                    run: () =>
                      api(`/api/v1/production-tasks/${t.id}/unblock`, {
                        method: 'POST',
                        body: { reason: 'Bloqueio retirado pelo gestor' },
                      }),
                    ok: 'Bloqueio retirado.',
                  })
                }
              >
                Desbloquear
              </Button>
            ) : (
              <Button
                variant="secondary"
                icon={<Lock className="size-4" aria-hidden />}
                onClick={() => setAction('block')}
              >
                Bloquear
              </Button>
            ))}
          <Button
            variant="danger"
            icon={<Ban className="size-4" aria-hidden />}
            onClick={() => setAction('cancel')}
          >
            Cancelar tarefa
          </Button>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Section title="Tarefa">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail label="OS">
                <Link
                  href={`/painel/os/${t.serviceOrder.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {t.serviceOrder.code}
                </Link>
              </Detail>
              <Detail label="Peça">{t.serviceOrderItem?.description ?? 'OS inteira'}</Detail>
              <Detail label="Etapa">{PRODUCTION_ACTIVITY_LABEL[t.activity]}</Detail>
              <Detail label="Papel">{TASK_ROLE_LABEL[t.role]}</Detail>
              <Detail label="Responsável">{t.assignee?.displayName ?? 'A definir'}</Detail>
              <Detail label="Programada para">
                {t.scheduledDate
                  ? `${formatDay(t.scheduledDate)} às ${t.scheduledTime}`
                  : 'Sem horário'}
              </Detail>
              <Detail label="Prazo interno">{t.dueDate ? formatDay(t.dueDate) : null}</Detail>
              <Detail label="Prazo da OS">
                {t.serviceOrder.promisedDate ? formatDay(t.serviceOrder.promisedDate) : null}
              </Detail>
              <Detail label="Início real">
                {t.startedAt ? formatDateTime(t.startedAt) : null}
              </Detail>
              <Detail label="Conclusão">
                {t.completedAt ? formatDateTime(t.completedAt) : null}
              </Detail>
              <div className="sm:col-span-2">
                <Detail label="Instruções">{t.instructions}</Detail>
              </div>
              {t.lastProgress && (
                <div className="sm:col-span-2">
                  <Detail label="Último andamento">
                    {`${t.lastProgress.note}${t.lastProgress.percent !== null ? ` (${t.lastProgress.percent}%)` : ''} — ${formatDateTime(t.lastProgress.at)}`}
                  </Detail>
                </div>
              )}
            </dl>
          </Section>
          <Section title="Histórico">
            <TaskHistory events={t.events} />
          </Section>
        </div>
        <div className="space-y-6 lg:col-span-2">
          <Section title="Depende de">
            <TaskRefs refs={t.dependsOn} empty="Sem dependências: pode começar no horário." />
          </Section>
          <Section title="Libera">
            <TaskRefs refs={t.dependents} empty="Nenhuma tarefa depende desta." />
          </Section>
          <Section
            title="Materiais"
            actions={
              <>
                {t.requiresMaterials && <ReadinessBadge state={t.materialsState} />}
                {t.can.manage && waiting && t.materials.length > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => setLinking(true)}>
                    Materiais desta tarefa
                  </Button>
                )}
              </>
            }
          >
            {t.requiresMaterials && (
              <p className="mb-2 text-sm text-ink-soft" data-testid="task-materials-rule">
                {t.materialIds.length
                  ? `Liberação por tarefa: depende de ${t.materialIds.length} material(is) vinculado(s) — ${t.taskMaterials === 'DISPONIVEIS' ? 'disponíveis' : 'faltando'}.`
                  : 'Sem vínculo: depende de todos os materiais da OS (regra conservadora).'}
              </p>
            )}
            {!t.requiresMaterials && (
              <p className="mb-2 text-sm text-ink-muted">
                Esta etapa não exige materiais reservados.
              </p>
            )}
            {t.materials.length === 0 ? (
              <p className="text-sm text-ink-muted">Nenhum material aprovado.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {t.materials.map((l) => (
                  <li key={l.requirementId}>
                    {t.materialIds.includes(l.requirementId) && (
                      <span className="mr-1 rounded bg-brand-50 px-1.5 text-xs font-semibold text-brand-700">
                        desta tarefa
                      </span>
                    )}
                    <span className="font-medium">{specText(l)}</span>
                    <span className="text-ink-muted">
                      {' '}
                      · {qtyText(l.need, l.unit)} · {LINE_STAGE_LABEL[l.stage]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Produção da OS">
            <TaskRefs refs={t.osTasks} empty="—" />
          </Section>
        </div>
      </div>
      {linking && (
        <MaterialsDialog task={t} published={published} onClose={() => setLinking(false)} />
      )}
      {editing && (
        <EditTaskDialog task={t} published={published} onClose={() => setEditing(false)} />
      )}
      {deps && <ReasonDeps task={t} published={published} onClose={() => setDeps(false)} />}
      {action && <ReasonDialog task={t} kind={action} onClose={() => setAction(null)} />}
    </>
  );
}

function ReasonDeps({
  task,
  published,
  onClose,
}: {
  task: ProductionTaskDetailDto;
  published: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [ready, setReady] = useState(!published);
  if (!ready)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Motivo da alteração"
        description="O planejamento já foi publicado: a alteração gera nova revisão."
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button disabled={reason.trim().length < 3} onClick={() => setReady(true)}>
              Continuar
            </Button>
          </>
        }
      >
        <Field label="Motivo" required>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>
    );
  return (
    <DepsDialog
      task={task}
      tasks={task.osTasks}
      reason={published ? reason : undefined}
      onClose={onClose}
    />
  );
}

function EditTaskDialog({
  task,
  published,
  onClose,
}: {
  task: ProductionTaskDetailDto;
  published: boolean;
  onClose: () => void;
}) {
  const workers = useWorkers();
  const [f, setF] = useState({
    assigneeUserId: task.assignee?.userId ?? '',
    priority: task.priority,
    date: task.scheduledDate ?? '',
    time: task.scheduledTime ?? '',
    dueDate: task.dueDate ?? '',
    instructions: task.instructions ?? '',
    requiresMaterials: task.requiresMaterials,
    completionRequirement: task.completionRequirement,
    reason: '',
  });
  const { m, error } = useSend(onClose);
  const started = task.status === 'EM_EXECUCAO' || task.status === 'PAUSADA';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Editar ${task.code}`}
      description="Reprogramar não ignora as regras: a tarefa só é liberada quando todas as condições forem atendidas."
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
                  api(`/api/v1/production-tasks/${task.id}`, {
                    method: 'PUT',
                    body: {
                      ...(started ? {} : { assigneeUserId: f.assigneeUserId || null }),
                      priority: f.priority,
                      date: f.date || null,
                      time: f.time || null,
                      dueDate: f.dueDate || null,
                      instructions: f.instructions,
                      requiresMaterials: f.requiresMaterials,
                      completionRequirement: f.completionRequirement,
                      reason: published ? f.reason : undefined,
                      version: task.version,
                    },
                  }),
                ok: 'Tarefa atualizada.',
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Responsável" hint={started ? 'Tarefa já iniciada.' : undefined}>
          {(p) => (
            <Select
              {...p}
              disabled={started}
              value={f.assigneeUserId}
              onChange={(e) => setF({ ...f, assigneeUserId: e.target.value })}
            >
              <option value="">A definir</option>
              {workers.data?.map((w) => (
                <option key={w.userId} value={w.userId}>
                  {w.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Prioridade">
          {(p) => (
            <Select
              {...p}
              value={f.priority}
              onChange={(e) => setF({ ...f, priority: e.target.value as Priority })}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Dia">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={f.date}
              onChange={(e) => setF({ ...f, date: e.target.value })}
            />
          )}
        </Field>
        <Field label="Hora">
          {(p) => (
            <Input
              {...p}
              type="time"
              value={f.time}
              onChange={(e) => setF({ ...f, time: e.target.value })}
            />
          )}
        </Field>
        <Field label="Prazo interno">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={f.dueDate}
              onChange={(e) => setF({ ...f, dueDate: e.target.value })}
            />
          )}
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox
            label="Exige materiais reservados"
            checked={f.requiresMaterials}
            onChange={(e) => setF({ ...f, requiresMaterials: e.target.checked })}
          />
        </div>
        <Field label="Para concluir, exigir" className="sm:col-span-2">
          {(p) => (
            <Select
              {...p}
              value={f.completionRequirement}
              onChange={(e) =>
                setF({ ...f, completionRequirement: e.target.value as CompletionRequirement })
              }
            >
              {COMPLETION_REQUIREMENTS.map((c) => (
                <option key={c} value={c}>
                  {COMPLETION_REQUIREMENT_LABEL[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Instruções" className="sm:col-span-2">
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={f.instructions}
              onChange={(e) => setF({ ...f, instructions: e.target.value })}
            />
          )}
        </Field>
        {published && (
          <Field label="Motivo da alteração" required className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                value={f.reason}
                onChange={(e) => setF({ ...f, reason: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function ReasonDialog({
  task,
  kind,
  onClose,
}: {
  task: ProductionTaskDetailDto;
  kind: 'cancel' | 'block';
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title={kind === 'cancel' ? `Cancelar ${task.code}` : `Bloquear ${task.code}`}
      description={
        kind === 'cancel'
          ? 'As tarefas que dependem desta deixam de esperá-la. Fica registrado no histórico.'
          : 'A tarefa não será liberada enquanto o bloqueio estiver ativo.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            variant={kind === 'cancel' ? 'danger' : 'primary'}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-tasks/${task.id}/${kind}`, {
                    method: 'POST',
                    body: { reason },
                  }),
                ok: kind === 'cancel' ? 'Tarefa cancelada.' : 'Tarefa bloqueada.',
              })
            }
          >
            Confirmar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Motivo" required>
        {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

/** Vincula a tarefa a materiais aprovados da OS (liberação por tarefa). */
function MaterialsDialog({
  task,
  published,
  onClose,
}: {
  task: ProductionTaskDetailDto;
  published: boolean;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(new Set(task.materialIds));
  const [reason, setReason] = useState('');
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Materiais de ${task.code}`}
      description="Marque os materiais de que esta etapa depende. Ela só é liberada quando eles estiverem disponíveis; sem nenhum marcado, depende de todos os materiais da OS."
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
                  api(`/api/v1/production-tasks/${task.id}/materials`, {
                    method: 'PUT',
                    body: {
                      requirementIds: [...sel],
                      reason: published ? reason : undefined,
                      version: task.version,
                    },
                  }),
                ok: 'Materiais da tarefa salvos.',
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
        {task.materials.map((l) => (
          <Checkbox
            key={l.requirementId}
            label={specText(l)}
            description={`${qtyText(l.need, l.unit)} · ${LINE_STAGE_LABEL[l.stage]}`}
            checked={sel.has(l.requirementId)}
            onChange={(e) => {
              const n = new Set(sel);
              if (e.target.checked) n.add(l.requirementId);
              else n.delete(l.requirementId);
              setSel(n);
            }}
          />
        ))}
      </div>
      {published && (
        <Field label="Motivo da alteração" required className="mt-4">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      )}
    </Dialog>
  );
}
