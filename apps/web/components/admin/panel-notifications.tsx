'use client';

import type { NotificationDto } from '@cenario/shared';
import clsx from 'clsx';
import { Bell, CheckCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useNotifications } from '@/lib/production';

const PRESENCE_KINDS = new Set([
  'AUSENCIA_PRESUMIDA',
  'ATRASO_OPERACIONAL',
  'CHEGADA_APOS_AUSENCIA',
  'TAREFA_PENDENTE_ENCERRAMENTO',
]);

/** Avisos do gestor no painel (alertas que exigem ação, persistentes e em tempo real). */
export function PanelNotifications() {
  const q = useNotifications();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { m, error } = useSend();
  const unread = q.data?.unread ?? 0;
  const go = (n: NotificationDto) => {
    if (!n.readAt)
      m.mutate({ run: () => api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' }) });
    setOpen(false);
    if (PRESENCE_KINDS.has(n.kind)) router.push('/painel/presenca');
    else if (n.taskId) router.push(`/painel/producao/tarefas/${n.taskId}`);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="panel-notifications"
        aria-label={`Avisos: ${unread} não lido(s)`}
        className="relative rounded-lg p-2 text-ink-soft hover:bg-subtle"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span
            data-testid="panel-notifications-unread"
            className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full bg-danger-600 px-1 text-[11px] font-bold text-white"
          >
            {unread}
          </span>
        )}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Avisos"
        description="Alertas que pedem atenção: ausências presumidas, atrasos relevantes e pendências de encerramento."
        footer={
          <Button
            variant="secondary"
            disabled={unread === 0}
            loading={m.isPending}
            icon={<CheckCheck className="size-4" aria-hidden />}
            onClick={() =>
              m.mutate({ run: () => api('/api/v1/notifications/read-all', { method: 'POST' }) })
            }
          >
            Marcar todos como lidos
          </Button>
        }
      >
        {error && (
          <Alert tone="danger" className="mb-3">
            {error}
          </Alert>
        )}
        {q.isPending ? (
          <Spinner />
        ) : !q.data?.items.length ? (
          <p className="text-sm text-ink-muted">Nenhum aviso.</p>
        ) : (
          <ul className="space-y-2" data-testid="panel-notification-list">
            {q.data.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => go(n)}
                  data-testid={`panel-notification-${n.kind}`}
                  className={clsx(
                    'w-full rounded-xl border px-4 py-3 text-left text-sm',
                    n.readAt ? 'border-line text-ink-soft' : 'border-brand-600/40 bg-brand-50',
                  )}
                >
                  <span className="font-semibold">{n.title}</span>
                  <span className="mt-0.5 block">{n.body}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {formatDateTime(n.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
