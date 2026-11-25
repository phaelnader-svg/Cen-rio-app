'use client';

import { plural } from '@cenario/shared';
import type { NotificationDto } from '@cenario/shared';
import clsx from 'clsx';
import { ArrowRight, Bell, CheckCheck, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useNotifications, useResolvedNotifications } from '@/lib/production';

const PRESENCE_KINDS = new Set([
  'AUSENCIA_PRESUMIDA',
  'ATRASO_OPERACIONAL',
  'CHEGADA_APOS_AUSENCIA',
  'TAREFA_PENDENTE_ENCERRAMENTO',
]);

/**
 * Revisão geral (item 2): o sininho é a lista única de avisos. Cada aviso mostra a cor pela
 * regra do sistema (vermelho = atrasado, laranja = atenção) e o que acontece ao tocar.
 */
function look(n: NotificationDto): { chip?: [string, 'danger' | 'warn']; action: string } {
  switch (n.kind) {
    case 'CONTA_VENCIDA':
      return { chip: ['Atrasada', 'danger'], action: 'Pagar' };
    case 'CONTA_A_VENCER':
      return { chip: ['Vence logo', 'warn'], action: 'Ver conta' };
    case 'PRAZO_EM_RISCO':
      return { chip: ['Em risco', 'warn'], action: 'Ver OS' };
    case 'PRAZO_PROXIMO':
      return { chip: ['Prazo perto', 'warn'], action: 'Ver OS' };
    case 'SERVICO_PARADO':
      return { chip: ['Parado', 'warn'], action: 'Ver OS' };
    case 'AGENTES_PEDEM':
      return { chip: ['Aprovar', 'warn'], action: 'Abrir o Escritório' };
    case 'AGENTES_RESUMO':
      return { action: 'Abrir o Escritório' };
    default:
      if (PRESENCE_KINDS.has(n.kind)) return { action: 'Ver presença' };
      return { action: n.taskId ? 'Ver tarefa' : 'Abrir' };
  }
}

/** Avisos do gestor no painel (alertas que exigem ação, persistentes e em tempo real). */
export function PanelNotifications() {
  const q = useNotifications();
  const [open, setOpen] = useState(false);
  // Rodada 2 (F10-19): avisos ativos por padrão; os resolvidos ficam no histórico.
  const [resolved, setResolved] = useState(false);
  const r = useResolvedNotifications(open && resolved);
  const router = useRouter();
  const { m, error } = useSend();
  const unread = q.data?.unread ?? 0;
  const list = resolved ? r : q;
  const go = (n: NotificationDto) => {
    if (!n.readAt)
      m.mutate({ run: () => api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' }) });
    setOpen(false);
    if (PRESENCE_KINDS.has(n.kind)) router.push('/painel/presenca');
    else if (n.kind === 'AGENTES_PEDEM' || n.kind === 'AGENTES_RESUMO')
      router.push('/painel/escritorio');
    else if (n.taskId) router.push(`/painel/producao/tarefas/${n.taskId}`);
    // 2026-11-18: contas a pagar vão ao Resumo do financeiro; prazos, à OS ou ao Início.
    else if (n.kind === 'CONTA_A_VENCER' || n.kind === 'CONTA_VENCIDA')
      router.push('/painel/financeiro?tab=painel');
    else if (n.kind === 'PRAZO_PROXIMO' || n.kind === 'PRAZO_EM_RISCO')
      router.push(n.serviceOrderId ? `/painel/os/${n.serviceOrderId}` : '/painel');
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="panel-notifications"
        aria-label={`Avisos: ${plural(unread, 'não lido', 'não lidos')}`}
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
        description="Tudo o que pede a sua atenção, num lugar só."
        footer={
          <>
            <Button
              variant="ghost"
              icon={<MessageCircle className="size-4" aria-hidden />}
              data-testid="panel-notifications-whatsapp"
              onClick={() => {
                // Abre a janela já no clique (bloqueadores de pop-up) e preenche quando o resumo chega.
                const w = window.open('', '_blank');
                api<{ href: string }>('/api/v1/notifications/daily-summary')
                  .then((r) => {
                    if (w) w.location.href = r.href;
                    else window.location.href = r.href;
                  })
                  .catch(() => w?.close());
              }}
            >
              Resumo do dia no WhatsApp
            </Button>
            <Button
              variant="ghost"
              onClick={() => setResolved(!resolved)}
              data-testid="panel-notifications-toggle"
            >
              {resolved ? 'Ver avisos ativos' : 'Ver resolvidos'}
            </Button>
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
          </>
        }
      >
        {error && (
          <Alert tone="danger" className="mb-3">
            {error}
          </Alert>
        )}
        <Link
          href="/painel/atencao"
          onClick={() => setOpen(false)}
          className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
          data-testid="panel-notifications-all"
        >
          Ver todos os avisos e pendências <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        {list.isPending ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <p className="text-sm text-ink-muted">
            {resolved ? 'Nenhum aviso resolvido.' : 'Nenhum aviso.'}
          </p>
        ) : (
          <ul
            className="space-y-2"
            data-testid={resolved ? 'panel-notification-resolved-list' : 'panel-notification-list'}
          >
            {list.data.items.map((n) => {
              const l = look(n);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => go(n)}
                    data-testid={`panel-notification-${n.kind}`}
                    className={clsx(
                      'w-full rounded-xl border px-4 py-3 text-left text-sm',
                      n.readAt || n.resolvedAt
                        ? 'border-line text-ink-soft'
                        : 'border-brand-600/40 bg-brand-50',
                    )}
                  >
                    <span className="flex items-start gap-3">
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          {l.chip && !n.resolvedAt && <Badge tone={l.chip[1]}>{l.chip[0]}</Badge>}
                          <span className="font-semibold">{n.title}</span>
                        </span>
                        <span className="mt-0.5 block">{n.body}</span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          {formatDateTime(n.createdAt)}
                          {n.resolvedAt && ` · resolvido em ${formatDateTime(n.resolvedAt)}`}
                        </span>
                      </span>
                      {!n.resolvedAt && (
                        <span className="shrink-0 self-center rounded-lg bg-brand-700 px-2.5 py-1 text-xs font-semibold text-white">
                          {l.action}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </>
  );
}
