'use client';

import type { ProductionTaskDto } from '@cenario/shared';
import { PRODUCTION_ACTIVITY_LABEL } from '@cenario/shared';
import clsx from 'clsx';
import { HandHelping, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useAlternatives } from '@/lib/help';
import { useOnline } from './tasks';

/**
 * Apoio da tarefa no tablet (os pedidos de ajuda foram removidos): tarefa de apoio antiga,
 * tarefas alternativas quando a própria está parada e o pedido de transferência ao gestor.
 */

/** Tarefa de apoio: para quem e quanto tempo (no cartão e no detalhe). */
export function SupportInfo({ t, large }: { t: ProductionTaskDto; large?: boolean }) {
  if (!t.supportFor) return null;
  return (
    <span
      className={clsx(
        'mt-2 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 font-semibold text-brand-800',
        large ? 'text-lg' : 'text-sm',
      )}
      data-testid="support-info"
    >
      <HandHelping className="size-4" aria-hidden />
      Apoio para {t.supportFor.requester ?? 'colega'} · {t.supportFor.code}
      {t.estimatedMinutes ? ` · ${t.estimatedMinutes} min` : ''}
    </span>
  );
}

/** Tarefa bloqueada ou parada por impedimento: outras tarefas que já podem ser feitas. */
export function AlternativeTasks({
  t,
  onOpen,
}: {
  t: ProductionTaskDto;
  onOpen?: (id: string) => void;
}) {
  const show = t.status === 'BLOQUEADA' || (t.status === 'PAUSADA' && t.pauseImpediment);
  const q = useAlternatives(show);
  if (!show) return null;
  const list = (q.data ?? []).filter((x) => x.id !== t.id);
  return (
    <section className="space-y-3" data-testid="alternatives">
      <h2 className="text-xl font-semibold">Enquanto isso, você pode fazer</h2>
      {list.length === 0 ? (
        <p className="text-base text-ink-muted">
          Nenhuma outra tarefa sua liberada agora. O gestor foi avisado pelo quadro.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onOpen?.(a.id)}
                className="flex min-h-14 w-full items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-left text-lg"
              >
                <span>
                  <span className="font-mono text-sm text-ink-muted">{a.code}</span>{' '}
                  <span className="font-semibold">{a.title}</span>
                  <span className="block text-sm text-ink-muted">
                    {PRODUCTION_ACTIVITY_LABEL[a.activity]} ·{' '}
                    {a.status === 'LIBERADA' ? 'Liberada' : `Hoje às ${a.scheduledTime}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Simplificação Fase 7: o responsável pede para transferir uma tarefa que ainda não começou.
 * O gestor aprova (quem assume) ou recusa; até lá a tarefa continua com quem está.
 */
export function TransferPanel({ t, me }: { t: ProductionTaskDto; me: string | null | undefined }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const { m, error, setError } = useSend(() => {
    setOpen(false);
    setWhy('');
    setKey(newIdempotencyKey());
  });
  if (!me || t.assignee?.userId !== me) return null;
  if (!['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'].includes(t.status)) return null;
  if (!open)
    return (
      <Button
        size="lg"
        variant="ghost"
        disabled={!online}
        onClick={() => setOpen(true)}
        data-testid="transfer-open"
      >
        Pedir transferência desta tarefa
      </Button>
    );
  return (
    <section
      className="space-y-3 rounded-2xl border border-line bg-surface p-5"
      data-testid="transfer-panel"
    >
      <p className="text-xl font-semibold">Pedir transferência</p>
      <p className="text-base text-ink-muted">
        O gestor escolhe quem assume. Até a decisão, a tarefa continua com você.
      </p>
      <input
        className="input input-lg"
        value={why}
        maxLength={300}
        onChange={(e) => setWhy(e.target.value)}
        placeholder="Por que precisa transferir?"
        data-testid="transfer-why"
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          size="xl"
          loading={m.isPending}
          disabled={!online}
          onClick={() => {
            if (why.trim().length < 5) return setError('Explique o motivo em poucas palavras.');
            m.mutate({
              run: () =>
                api(`/api/v1/production-tasks/${t.id}/transfer-request`, {
                  method: 'POST',
                  body: { reason: why, version: t.version },
                  idempotencyKey: key,
                }),
              ok: 'Pedido de transferência enviado ao gestor.',
            });
          }}
          data-testid="transfer-send"
        >
          Enviar ao gestor
        </Button>
        <Button
          size="xl"
          variant="secondary"
          onClick={() => setOpen(false)}
          icon={<Undo2 className="size-6" />}
        >
          Voltar
        </Button>
      </div>
    </section>
  );
}
