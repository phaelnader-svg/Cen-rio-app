'use client';

import clsx from 'clsx';
import { useRealtime, type ConnectionStatus } from '@/lib/realtime';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Conectando…',
  online: 'Conectado',
  reconnecting: 'Sem conexão, tentando de novo',
  offline: 'Sem conexão, tentando de novo',
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
  // Melhoria 139: conectado é o normal e não precisa de aviso; o selo só aparece quando cai.
  if (status === 'online' || status === 'connecting')
    return (
      <span role="status" data-testid="connection-status" data-status={status} className="sr-only">
        {LABELS[status]}
      </span>
    );
  const color = status === 'ended' ? 'bg-danger-600' : 'bg-warn-600 animate-pulse';
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
