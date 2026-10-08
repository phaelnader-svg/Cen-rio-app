'use client';

import type { RealtimeEvent } from '@cenario/shared';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { RefreshCw, Send, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, EmptyState } from '@/components/ui/misc';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface Signal {
  seq: string;
  message: string;
  from: string;
  surface: string;
  occurredAt: string;
  receivedAt: string;
  replayed: boolean;
}

/**
 * Diagnóstico de sincronização: cada sinal é um evento real gravado no banco e
 * entregue pelo servidor a todas as sessões conectadas. "Simular queda" fecha o
 * WebSocket; ao reconectar, os sinais perdidos são reenviados pelo servidor
 * (marcados como "recuperado").
 */
export function SyncPanel({ large }: { large?: boolean }) {
  const rt = useRealtime();
  const { subscribe } = rt;
  const [signals, setSignals] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);

  useEffect(
    () =>
      subscribe((event: RealtimeEvent, replayed) => {
        if (event.type !== 'sync.signal') return;
        const p = event.payload as {
          message: string;
          from: { displayName: string; surface: string; deviceName: string | null };
        };
        setSignals((list) =>
          list.some((s) => s.seq === event.seq)
            ? list
            : [
                {
                  seq: event.seq,
                  message: p.message,
                  from: p.from.deviceName
                    ? `${p.from.displayName} (${p.from.deviceName})`
                    : p.from.displayName,
                  surface: p.from.surface,
                  occurredAt: event.occurredAt,
                  receivedAt: new Date().toISOString(),
                  replayed,
                },
                ...list,
              ].slice(0, 30),
        );
      }),
    [subscribe],
  );

  const send = useMutation({
    mutationFn: () =>
      api('/api/sync/signal', {
        method: 'POST',
        body: { message: `Sinal de teste nº ${counter}` },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      setCounter((c) => c + 1);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const btn = large ? 'xl' : 'md';

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-sm text-ink-muted">Conexão</dt>
            <dd className="mt-1 font-semibold" data-testid="sync-status">
              {rt.status === 'online'
                ? 'Conectado'
                : rt.status === 'offline'
                  ? 'Sem rede'
                  : 'Reconectando…'}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Último evento</dt>
            <dd className="mt-1 font-mono font-semibold" data-testid="sync-last-seq">
              {rt.lastSeq ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Reconexões</dt>
            <dd className="mt-1 font-semibold tabular-nums" data-testid="sync-reconnects">
              {rt.stats.reconnects}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Recuperados após reconexão</dt>
            <dd className="mt-1 font-semibold tabular-nums" data-testid="sync-replayed">
              {rt.stats.totalReplayed}
            </dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            size={btn}
            loading={send.isPending}
            onClick={() => send.mutate()}
            icon={<Send className="size-4" aria-hidden />}
            data-testid="sync-send"
          >
            Enviar sinal de teste
          </Button>
          <Button
            size={btn}
            variant="secondary"
            onClick={rt.reconnectNow}
            icon={<Unplug className="size-4" aria-hidden />}
            data-testid="sync-drop"
          >
            Simular queda de conexão
          </Button>
        </div>
        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="font-semibold">Sinais recebidos nesta tela</h2>
          <RefreshCw className="size-4 text-ink-muted" aria-hidden />
        </div>
        {signals.length === 0 ? (
          <EmptyState
            title="Nenhum sinal ainda"
            description="Envie um sinal aqui ou em outro dispositivo conectado; ele aparece em todos ao mesmo tempo."
          />
        ) : (
          <ul className="divide-y divide-line" data-testid="sync-signals">
            {signals.map((s) => (
              <li
                key={s.seq}
                className={clsx('flex flex-wrap items-center gap-3 px-5', large ? 'py-4' : 'py-3')}
                data-seq={s.seq}
              >
                <span className="font-mono text-sm text-ink-muted">#{s.seq}</span>
                <span className={clsx('font-medium', large && 'text-lg')}>{s.message}</span>
                <span className="text-sm text-ink-muted">
                  de {s.from} · {s.surface}
                </span>
                {s.replayed && <Badge tone="warn">recuperado após reconexão</Badge>}
                <span className="ml-auto text-xs text-ink-muted">
                  enviado {formatTime(s.occurredAt)} · recebido {formatTime(s.receivedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
