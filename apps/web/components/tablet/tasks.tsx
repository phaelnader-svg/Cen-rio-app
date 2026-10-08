'use client';

import type { PauseReason, ProductionTaskDto } from '@cenario/shared';
import {
  PAUSE_REASONS,
  PAUSE_REASON_LABEL,
  PIECE_TYPE_LABEL,
  PRIORITY_LABEL,
  PRODUCTION_ACTIVITY_LABEL,
  TASK_ROLE_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Lock,
  MessageSquarePlus,
  Pause,
  Play,
} from 'lucide-react';
import { useState } from 'react';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { TaskStatusBadge, blockersText } from '@/components/production/badges';
import { TaskHistory, TaskRefs } from '@/components/production/task-history';
import { useSend } from '@/components/production/use-send';
import { qtyText, specText } from '@/components/purchasing/format';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { useMyTasks, useTask } from '@/lib/production';

/** Quantidade de tarefas de hoje ainda abertas (bloco da tela inicial). */
export function useMyTodayCount(enabled: boolean) {
  const q = useMyTasks(enabled);
  return q.data?.today.filter((t) => t.status !== 'CONCLUIDA' && t.status !== 'CANCELADA').length;
}

/** Lista "Minhas tarefas": hoje (por prioridade) e próximas. */
export function MyTasks({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useMyTasks();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  return (
    <div className="space-y-8">
      {q.data.today.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
          <ClipboardCheck className="mx-auto size-10 text-ink-muted" aria-hidden />
          <p className="mt-3 text-xl font-semibold">Nenhuma tarefa para hoje</p>
          <p className="mt-1 text-base text-ink-muted">
            Quando o gestor publicar a programação, suas tarefas aparecem aqui na hora.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2" data-testid="my-tasks-today">
          {q.data.today.map((t) => (
            <li key={t.id}>
              <TaskCard t={t} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {q.data.upcoming.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink-soft">Próximos dias</h2>
          <ul className="grid gap-3 lg:grid-cols-2" data-testid="my-tasks-upcoming">
            {q.data.upcoming.map((t) => (
              <li key={t.id}>
                <TaskCard t={t} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const ACCENT: Partial<Record<ProductionTaskDto['status'], string>> = {
  LIBERADA: 'border-brand-600/50 ring-2 ring-brand-600/15',
  EM_EXECUCAO: 'border-bronze-600/50 ring-2 ring-bronze-600/15',
  PAUSADA: 'border-warn-600/40',
};

function TaskCard({ t, onOpen }: { t: ProductionTaskDto; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(t.id)}
      data-testid={`my-task-${t.code}`}
      className={clsx(
        'flex w-full items-center gap-4 rounded-2xl border bg-surface p-5 text-left shadow-[var(--shadow-card)] transition active:scale-[0.99]',
        ACCENT[t.status] ?? 'border-line',
        (t.status === 'CONCLUIDA' || t.status === 'CANCELADA') && 'opacity-60',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xl font-semibold">{t.title}</span>
        <span className="mt-0.5 block truncate text-base text-ink-muted">
          {t.serviceOrder.code} · {t.serviceOrderItem?.description ?? 'OS inteira'}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <TaskStatusBadge status={t.status} />
          {t.priority !== 'NORMAL' && (
            <span
              className={clsx(
                'rounded-full px-3 py-1 font-semibold',
                t.priority === 'URGENTE' || t.priority === 'ALTA'
                  ? 'bg-danger-50 text-danger-600'
                  : 'bg-subtle text-ink-soft',
              )}
            >
              Prioridade {PRIORITY_LABEL[t.priority].toLowerCase()}
            </span>
          )}
          {t.scheduledDate && (
            <span className="inline-flex items-center gap-1 text-ink-muted">
              <CalendarClock className="size-4" aria-hidden />
              {formatDay(t.scheduledDate)} {t.scheduledTime}
            </span>
          )}
          {t.dueDate && <span className="text-ink-muted">Prazo {formatDay(t.dueDate)}</span>}
        </span>
        {t.status === 'BLOQUEADA' && (
          <span className="mt-2 block text-sm text-danger-600">
            Aguardando: {t.blockedReason ?? blockersText(t.blockers)}
          </span>
        )}
      </span>
      <ChevronRight className="size-6 shrink-0 text-ink-muted" aria-hidden />
    </button>
  );
}

/** Detalhe da tarefa no tablet: ações grandes e informações técnicas (sem valores). */
export function MyTaskDetail({ id }: { id: string }) {
  const q = useTask(id);
  const { m, error } = useSend();
  const [panel, setPanel] = useState<'pause' | 'progress' | 'complete' | null>(null);
  const [startKey] = useState(newIdempotencyKey);
  const [completeKey] = useState(newIdempotencyKey);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const t = q.data;
  const post = (path: string, body: unknown, ok: string, idempotencyKey?: string) =>
    m.mutate(
      {
        run: () =>
          api(`/api/v1/production-tasks/${t.id}/${path}`, {
            method: 'POST',
            body,
            idempotencyKey,
          }),
        ok,
      },
      { onSuccess: () => setPanel(null) },
    );

  return (
    <div className="space-y-6" data-testid="my-task-detail">
      <div>
        <p className="text-base text-ink-muted">
          {t.code} · {t.serviceOrder.code} · {t.customerName}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-1 text-lg text-ink-soft">
          {t.serviceOrderItem?.description ?? 'OS inteira'} ·{' '}
          {PRODUCTION_ACTIVITY_LABEL[t.activity]} · {TASK_ROLE_LABEL[t.role]}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-base">
          <TaskStatusBadge status={t.status} />
          <span className="text-ink-muted">
            Prioridade {PRIORITY_LABEL[t.priority].toLowerCase()}
          </span>
          {t.scheduledDate && (
            <span className="text-ink-muted">
              {formatDay(t.scheduledDate)} às {t.scheduledTime}
            </span>
          )}
          {t.dueDate && <span className="text-ink-muted">Prazo {formatDay(t.dueDate)}</span>}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {t.status === 'BLOQUEADA' && (
        <Alert tone="warn" title="Ainda não liberada">
          Aguardando: {[t.blockedReason, blockersText(t.blockers)].filter(Boolean).join(' · ')}
        </Alert>
      )}
      {t.status === 'PROGRAMADA' && (
        <Alert tone="info" title="Programada">
          Libera em {t.scheduledDate ? formatDay(t.scheduledDate) : ''} às {t.scheduledTime}.
        </Alert>
      )}
      {t.status === 'PAUSADA' && t.pauseReason && (
        <Alert tone="warn" title={`Pausada — ${PAUSE_REASON_LABEL[t.pauseReason]}`}>
          {t.pauseNote ?? 'O andamento registrado foi mantido.'}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2" data-testid="task-actions">
        {t.can.start && (
          <Button
            size="xl"
            className="sm:col-span-2"
            loading={m.isPending}
            icon={<Play className="size-6" aria-hidden />}
            onClick={() => post('start', {}, 'Tarefa iniciada.', startKey)}
          >
            Iniciar
          </Button>
        )}
        {t.can.resume && (
          <Button
            size="xl"
            className="sm:col-span-2"
            loading={m.isPending}
            icon={<Play className="size-6" aria-hidden />}
            onClick={() => post('resume', {}, 'Tarefa retomada.')}
          >
            Retomar
          </Button>
        )}
        {t.can.complete && (
          <Button
            size="xl"
            icon={<CheckCircle2 className="size-6" aria-hidden />}
            onClick={() => setPanel('complete')}
          >
            Concluir
          </Button>
        )}
        {t.can.progress && (
          <Button
            size="xl"
            variant="secondary"
            icon={<MessageSquarePlus className="size-6" aria-hidden />}
            onClick={() => setPanel('progress')}
          >
            Registrar andamento
          </Button>
        )}
        {t.can.pause && (
          <Button
            size="xl"
            variant="secondary"
            icon={<Pause className="size-6" aria-hidden />}
            onClick={() => setPanel('pause')}
          >
            Pausar
          </Button>
        )}
        {!t.can.start &&
          !t.can.resume &&
          !t.can.complete &&
          (t.status === 'BLOQUEADA' || t.status === 'PROGRAMADA') && (
            <p className="flex items-center gap-2 text-base text-ink-muted sm:col-span-2">
              <Lock className="size-5" aria-hidden /> O botão Iniciar aparece quando a tarefa for
              liberada.
            </p>
          )}
      </div>

      {panel === 'complete' && (
        <div
          className="rounded-2xl border border-line bg-surface p-5"
          data-testid="confirm-complete"
        >
          <p className="text-xl font-semibold">Confirmar conclusão de “{t.title}”?</p>
          {t.dependents.length > 0 && (
            <p className="mt-1 text-base text-ink-muted">
              Libera:{' '}
              {t.dependents
                .map((d) => `${d.title} (${d.assignee ?? 'sem responsável'})`)
                .join(', ')}
            </p>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Button size="xl" variant="secondary" onClick={() => setPanel(null)}>
              Voltar
            </Button>
            <Button
              size="xl"
              loading={m.isPending}
              onClick={() => post('complete', {}, 'Tarefa concluída.', completeKey)}
            >
              Sim, concluir
            </Button>
          </div>
        </div>
      )}
      {panel === 'pause' && (
        <PausePanel
          busy={m.isPending}
          onCancel={() => setPanel(null)}
          onPause={(reason, note) => post('pause', { reason, note }, 'Tarefa pausada.')}
        />
      )}
      {panel === 'progress' && (
        <ProgressPanel
          busy={m.isPending}
          onCancel={() => setPanel(null)}
          onSend={(note, percent) => post('progress', { note, percent }, 'Andamento registrado.')}
        />
      )}

      {t.lastProgress && (
        <p className="rounded-xl bg-subtle px-4 py-3 text-base">
          Último andamento: {t.lastProgress.note}
          {t.lastProgress.percent !== null && ` (${t.lastProgress.percent}%)`}
        </p>
      )}

      {(t.instructions || t.serviceOrderInfo.technicalInstructions) && (
        <Block title="Instruções">
          {t.instructions && <p className="text-lg whitespace-pre-line">{t.instructions}</p>}
          {t.serviceOrderInfo.technicalInstructions && (
            <p className="mt-2 text-base whitespace-pre-line text-ink-soft">
              {t.serviceOrderInfo.technicalInstructions}
            </p>
          )}
        </Block>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Block title="Depende de">
          <TaskRefs large refs={t.dependsOn} empty="Nenhuma dependência." />
        </Block>
        <Block title="Ao concluir, libera">
          <TaskRefs large refs={t.dependents} empty="Nenhuma tarefa depende desta." />
        </Block>
      </div>

      <Block title="Peças e especificações">
        <ul className="space-y-4">
          {t.serviceOrderInfo.items.map((i) => (
            <li key={i.id} className={clsx(i.id === t.serviceOrderItem?.id && 'font-medium')}>
              <p className="text-lg font-semibold">
                {i.code} · {i.description}{' '}
                <span className="font-normal text-ink-muted">
                  ({PIECE_TYPE_LABEL[i.pieceType]}, {i.quantity} un.)
                </span>
              </p>
              <p className="text-base text-ink-soft">
                {[
                  i.fabricName &&
                    `Tecido: ${i.fabricName}${i.fabricColor ? ` ${i.fabricColor}` : ''}`,
                  i.foamSpecs && `Espuma: ${i.foamSpecs}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {i.measurements.length > 0 && (
                <p className="text-base">
                  {i.measurements.map((mm) => `${mm.label}: ${mm.valueCm} cm`).join(' · ')}
                </p>
              )}
              {i.technicalNotes && <p className="text-base text-ink-muted">{i.technicalNotes}</p>}
              <div className="mt-2">
                <PhotoGallery entityType="SERVICE_ORDER_ITEM" entityId={i.id} canManage={false} />
              </div>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="Materiais">
        {t.materials.length === 0 ? (
          <p className="text-base text-ink-muted">Nenhum material aprovado.</p>
        ) : (
          <ul className="space-y-2 text-base">
            {t.materials.map((l) => (
              <li key={l.requirementId}>
                <span className="font-medium">{specText(l)}</span>
                <span className="text-ink-muted"> · {qtyText(l.need, l.unit)}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Fotos da OS">
        <PhotoGallery entityType="SERVICE_ORDER" entityId={t.serviceOrder.id} canManage={false} />
      </Block>

      <Block title="Histórico">
        <TaskHistory large events={t.events} />
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="mb-3 text-lg font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  );
}

function PausePanel({
  busy,
  onCancel,
  onPause,
}: {
  busy: boolean;
  onCancel: () => void;
  onPause: (reason: PauseReason, note?: string) => void;
}) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState('');
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" data-testid="pause-panel">
      <p className="mb-3 text-xl font-semibold">Por que vai pausar?</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {PAUSE_REASONS.filter((r) => r !== 'OUTRO').map((r) => (
          <Button key={r} size="xl" variant="secondary" loading={busy} onClick={() => onPause(r)}>
            {PAUSE_REASON_LABEL[r]}
          </Button>
        ))}
        <Button size="xl" variant="secondary" onClick={() => setOther(true)}>
          {PAUSE_REASON_LABEL.OUTRO}
        </Button>
      </div>
      {other && (
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            aria-label="Motivo da pausa"
            className="h-16 min-w-0 flex-1 rounded-2xl border border-line-strong px-4 text-lg"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="xl"
            disabled={note.trim().length < 2}
            loading={busy}
            onClick={() => onPause('OUTRO', note.trim())}
          >
            Pausar
          </Button>
        </div>
      )}
      <Button size="lg" variant="ghost" className="mt-3" onClick={onCancel}>
        Voltar
      </Button>
    </div>
  );
}

function ProgressPanel({
  busy,
  onCancel,
  onSend,
}: {
  busy: boolean;
  onCancel: () => void;
  onSend: (note: string, percent: number | null) => void;
}) {
  const [note, setNote] = useState('');
  const [percent, setPercent] = useState<number | null>(null);
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" data-testid="progress-panel">
      <p className="mb-3 text-xl font-semibold">Como está o andamento?</p>
      <div className="mb-3 flex flex-wrap gap-3">
        {[25, 50, 75].map((p) => (
          <Button
            key={p}
            size="xl"
            variant={percent === p ? 'primary' : 'secondary'}
            aria-pressed={percent === p}
            onClick={() => setPercent(percent === p ? null : p)}
          >
            {p}%
          </Button>
        ))}
      </div>
      <input
        aria-label="Andamento"
        placeholder="Ex.: Braços cortados"
        className="h-16 w-full rounded-2xl border border-line-strong px-4 text-lg"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Button size="xl" variant="secondary" onClick={onCancel}>
          Voltar
        </Button>
        <Button
          size="xl"
          disabled={note.trim().length < 2}
          loading={busy}
          onClick={() => onSend(note.trim(), percent)}
        >
          Registrar
        </Button>
      </div>
    </div>
  );
}
