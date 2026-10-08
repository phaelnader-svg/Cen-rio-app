'use client';

import clsx from 'clsx';
import { useRealtime, type ConnectionStatus } from '@/lib/realtime';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Conectando…',
  online: 'Tempo real ativo',
  reconnecting: 'Reconectando…',
  offline: 'Sem conexão',
  ended: 'Sessão encerrada',
};

export function ConnectionIndicator({
  compact,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { status } = useRealtime();
  const color =
    status === 'online'
      ? 'bg-ok-600'
      : status === 'connecting' || status === 'reconnecting'
        ? 'bg-warn-600 animate-pulse'
        : 'bg-danger-600';
  return (
    <span
      role="status"
      data-testid="connection-status"
      data-status={status}
      className={clsx(
        'inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-soft',
        className,
      )}
      title={LABELS[status]}
    >
      <span className={clsx('size-2 rounded-full', color)} aria-hidden />
      <span className={clsx(compact && 'sr-only sm:not-sr-only')}>{LABELS[status]}</span>
    </span>
  );
}
