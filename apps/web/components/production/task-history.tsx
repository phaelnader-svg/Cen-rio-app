import type { TaskEventDto, TaskRefDto } from '@cenario/shared';
import {
  PAUSE_REASON_LABEL,
  TASK_STATUS_LABEL,
  type PauseReason,
  type TaskStatus,
} from '@cenario/shared';
import clsx from 'clsx';
import { formatDateTime } from '@/lib/format';

export const EVENT_LABEL: Record<string, string> = {
  PUBLICADA: 'Publicada',
  LIBERADA: 'Liberada',
  BLOQUEADA: 'Bloqueada',
  PROGRAMADA: 'Programada',
  REPROGRAMADA: 'Reprogramada',
  RESPONSAVEL_ALTERADO: 'Responsável alterado',
  DEPENDENCIAS: 'Dependências alteradas',
  MATERIAIS: 'Materiais da tarefa alterados',
  BLOQUEIO: 'Bloqueio manual',
  DESBLOQUEIO: 'Bloqueio retirado',
  INICIADA: 'Iniciada',
  PAUSADA: 'Pausada',
  RETOMADA: 'Retomada',
  ANDAMENTO: 'Andamento registrado',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};

/** Histórico imutável da tarefa (mais recente primeiro). */
export function TaskHistory({ events, large }: { events: TaskEventDto[]; large?: boolean }) {
  if (events.length === 0) return <p className="text-sm text-ink-muted">Sem eventos ainda.</p>;
  return (
    <ol className="space-y-3" data-testid="task-history">
      {[...events].reverse().map((e) => (
        <li key={e.id} className={clsx('border-l-2 border-line pl-3', large && 'text-base')}>
          <p className="font-medium">
            {EVENT_LABEL[e.kind] ?? e.kind}
            {e.toStatus && e.fromStatus && e.fromStatus !== e.toStatus && (
              <span className="font-normal text-ink-muted">
                {' '}
                · {TASK_STATUS_LABEL[e.fromStatus as TaskStatus] ?? e.fromStatus} →{' '}
                {TASK_STATUS_LABEL[e.toStatus as TaskStatus] ?? e.toStatus}
              </span>
            )}
          </p>
          {e.note && (
            <p className="text-sm text-ink-soft">
              {/* Pausas antigas gravavam o código do motivo. */}
              {PAUSE_REASON_LABEL[e.note as PauseReason] ?? e.note}
            </p>
          )}
          {e.extra && (
            <p className="text-sm text-ink-soft">
              {[
                e.extra.percent !== null && e.extra.percent !== undefined
                  ? `${e.extra.percent}%`
                  : null,
                e.extra.step ? `Etapa: ${e.extra.step}` : null,
                e.extra.nextStep ? `Próximo: ${e.extra.nextStep}` : null,
                e.extra.attachmentIds?.length ? `${e.extra.attachmentIds.length} foto(s)` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <p className="text-xs text-ink-muted">
            {formatDateTime(e.createdAt)} · {e.actor ?? 'Sistema'}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** Lista de tarefas relacionadas (dependências ou dependentes). */
export function TaskRefs({
  refs,
  empty,
  large,
}: {
  refs: TaskRefDto[];
  empty: string;
  large?: boolean;
}) {
  if (refs.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {refs.map((r) => (
        <li
          key={r.id}
          className={clsx('flex flex-wrap items-center gap-2', large ? 'text-base' : 'text-sm')}
        >
          <span
            className={clsx(
              'rounded-full px-2 py-0.5 text-xs font-semibold',
              r.status === 'CONCLUIDA'
                ? 'bg-ok-50 text-ok-600'
                : r.status === 'CANCELADA'
                  ? 'bg-subtle text-ink-muted'
                  : 'bg-warn-50 text-warn-600',
            )}
          >
            {TASK_STATUS_LABEL[r.status]}
          </span>
          <span className="font-medium">{r.title}</span>
          <span className="text-ink-muted">
            {r.code} · {r.assignee ?? 'sem responsável'}
          </span>
        </li>
      ))}
    </ul>
  );
}
