'use client';

import type { LogisticsJobDto, LogisticsKind } from '@cenario/shared';
import {
  DELIVERY_ITEM_STATUS_LABEL,
  DELIVERY_STATUS_LABEL,
  LOGISTICS_KINDS,
  LOGISTICS_KIND_LABEL,
  PICKUP_STATUS_LABEL,
  type DeliveryStatus,
  type PickupStatus,
} from '@cenario/shared';
import clsx from 'clsx';
import { MapPin, Phone, Truck } from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useLogisticsJobs } from '@/lib/quality';
import { useOnline } from './tasks';

/**
 * Fase 10 — logística terceirizada (André e Izaías) e equipe própria: só as próprias
 * retiradas e entregas, com endereço, contato operacional, peças, data, horário e instruções.
 * Nunca exibe valores ou dados comerciais. Nada é marcado como entregue automaticamente.
 */

const day = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : 'sem data');

function statusLabel(j: LogisticsJobDto) {
  return j.kind === 'ENTREGA'
    ? DELIVERY_STATUS_LABEL[j.status as DeliveryStatus]
    : PICKUP_STATUS_LABEL[j.status as PickupStatus];
}

export function LogisticsJobs() {
  const q = useLogisticsJobs();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!q.data.length)
    return (
      <p className="rounded-2xl bg-subtle p-6 text-lg text-ink-muted" data-testid="no-jobs">
        Nenhuma retirada ou entrega atribuída a você.
      </p>
    );
  return (
    <ul className="space-y-5" data-testid="logistics-jobs">
      {q.data.map((j) => (
        <li key={`${j.kind}:${j.id}`}>
          <JobCard j={j} />
        </li>
      ))}
    </ul>
  );
}

function JobCard({ j }: { j: LogisticsJobDto }) {
  const online = useOnline();
  const { m, error } = useSend();
  const [panel, setPanel] = useState<'items' | 'install' | 'frustrate' | 'occurrence' | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const run = (path: string, body: Record<string, unknown>, ok: string) =>
    m.mutate(
      {
        run: () =>
          api(path, {
            method: 'POST',
            body: { ...body, version: j.version },
            idempotencyKey: key,
          }),
        ok,
      },
      {
        onSettled: () => setKey(newIdempotencyKey()),
        onSuccess: () => setPanel(null),
      },
    );
  const a = j.address;
  const base = `/api/v1/deliveries/${j.id}`;
  return (
    <article
      className="rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
      data-testid={`job-${j.code}`}
      data-status={j.status}
    >
      <p className="flex flex-wrap items-center gap-2 text-base text-ink-muted">
        <Truck className="size-5" aria-hidden />
        <span className="font-semibold text-ink-soft">
          {j.kind === 'ENTREGA' ? 'Entrega' : 'Retirada'} {j.code}
        </span>
        <span>
          · {day(j.scheduledDate)}
          {j.windowStart ? ` · ${j.windowStart}${j.windowEnd ? `–${j.windowEnd}` : ''}` : ''}
        </span>
        <span className="rounded-full bg-subtle px-3 py-0.5 font-semibold" data-testid="job-status">
          {statusLabel(j)}
        </span>
      </p>
      <h2 className="mt-2 text-2xl font-semibold">{j.customerName}</h2>
      {a && (
        <p className="mt-1 flex items-start gap-2 text-lg">
          <MapPin className="mt-1 size-5 shrink-0" aria-hidden />
          <span>
            {a.street}, {a.number}
            {a.complement ? ` — ${a.complement}` : ''} · {a.district ? `${a.district}, ` : ''}
            {a.city}/{a.state}
            {a.reference ? ` · ${a.reference}` : ''}
          </span>
        </p>
      )}
      {(j.contactName || j.contactPhone) && (
        <p className="mt-1 flex items-center gap-2 text-lg">
          <Phone className="size-5" aria-hidden /> {j.contactName}
          {j.contactPhone ? ` · ${j.contactPhone}` : ''}
        </p>
      )}
      {j.instructions && (
        <p
          className="mt-2 rounded-xl bg-warn-50 px-4 py-2 text-lg text-warn-600"
          data-testid="job-instructions"
        >
          {j.instructions}
        </p>
      )}
      <ul className="mt-3 space-y-1 text-lg">
        {j.pieces.map((p) => (
          <li key={p.id}>
            {p.code ? `${p.code} · ` : ''}
            {p.description} ({p.quantity})
            {p.status && p.status !== 'PENDENTE' && (
              <span className="ml-2 text-base text-ink-muted">
                — {DELIVERY_ITEM_STATUS_LABEL[p.status as keyof typeof DELIVERY_ITEM_STATUS_LABEL]}
              </span>
            )}
          </li>
        ))}
      </ul>
      {j.requiresInstallation && (
        <p className="mt-2 text-base font-semibold text-brand-700">
          Com instalação{j.installedAt ? ' — instalada' : ''}
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {j.kind === 'RETIRADA' && j.status === 'AGENDADA' && (
          <Button
            size="xl"
            disabled={!online}
            loading={m.isPending}
            onClick={() =>
              run(`/api/v1/logistics/pickups/${j.id}/step`, { step: 'SAIDA' }, 'Saída registrada.')
            }
          >
            Saí para a retirada
          </Button>
        )}
        {j.kind === 'RETIRADA' && j.status === 'EM_EXECUCAO' && (
          <Button
            size="xl"
            disabled={!online}
            loading={m.isPending}
            onClick={() =>
              run(
                `/api/v1/logistics/pickups/${j.id}/step`,
                { step: 'RETIRADA_REALIZADA' },
                'Retirada registrada.',
              )
            }
          >
            Peças retiradas
          </Button>
        )}
        {j.kind === 'ENTREGA' && j.status === 'AGENDADA' && (
          <Button
            size="xl"
            disabled={!online}
            loading={m.isPending}
            onClick={() => run(`${base}/depart`, {}, 'Saída registrada.')}
          >
            Saí para entrega
          </Button>
        )}
        {j.kind === 'ENTREGA' && j.status === 'EM_TRANSPORTE' && (
          <Button
            size="xl"
            disabled={!online}
            loading={m.isPending}
            onClick={() => run(`${base}/arrive`, {}, 'Chegada registrada.')}
          >
            Cheguei ao destino
          </Button>
        )}
        {j.kind === 'ENTREGA' && j.status === 'NO_DESTINO' && (
          <>
            <Button
              size="xl"
              disabled={!online}
              onClick={() => setPanel(panel === 'items' ? null : 'items')}
            >
              Confirmar peças
            </Button>
            {j.requiresInstallation && !j.installedAt && (
              <Button
                size="xl"
                variant="secondary"
                disabled={!online}
                onClick={() => setPanel(panel === 'install' ? null : 'install')}
              >
                Registrar instalação
              </Button>
            )}
            {j.pieces.every((p) => p.status && p.status !== 'PENDENTE') && (
              <Button
                size="xl"
                disabled={!online}
                loading={m.isPending}
                className="sm:col-span-2"
                onClick={() => run(`${base}/complete`, {}, 'Entrega concluída.')}
              >
                Concluir entrega
              </Button>
            )}
          </>
        )}
        {j.kind === 'ENTREGA' && (j.status === 'EM_TRANSPORTE' || j.status === 'NO_DESTINO') && (
          <Button
            size="xl"
            variant="danger"
            disabled={!online}
            onClick={() => setPanel(panel === 'frustrate' ? null : 'frustrate')}
          >
            Não foi possível entregar
          </Button>
        )}
        {['AGENDADA', 'EM_TRANSPORTE', 'NO_DESTINO', 'EM_EXECUCAO'].includes(j.status) && (
          <Button
            size="xl"
            variant="secondary"
            disabled={!online}
            onClick={() => setPanel(panel === 'occurrence' ? null : 'occurrence')}
          >
            Registrar ocorrência
          </Button>
        )}
      </div>
      {panel === 'items' && (
        <ItemsPanel
          j={j}
          busy={m.isPending}
          onSend={(items) => run(`${base}/items`, { items }, 'Peças registradas.')}
        />
      )}
      {panel === 'install' && (
        <NotePanel
          label="Como ficou a instalação"
          withComplete
          busy={m.isPending}
          onSend={(note, complete) =>
            run(`${base}/install`, { note, complete }, 'Instalação registrada.')
          }
        />
      )}
      {panel === 'frustrate' && (
        <KindPanel
          busy={m.isPending}
          label="O que aconteceu"
          onSend={(kind, text) =>
            run(`${base}/frustrate`, { kind, reason: text }, 'Tentativa registrada.')
          }
        />
      )}
      {panel === 'occurrence' && (
        <KindPanel
          busy={m.isPending}
          label="Descreva a ocorrência"
          onSend={(kind, text) =>
            m.mutate(
              {
                run: () =>
                  api('/api/v1/logistics-occurrences', {
                    method: 'POST',
                    body: {
                      kind,
                      description: text,
                      ...(j.kind === 'ENTREGA' ? { deliveryId: j.id } : { pickupId: j.id }),
                    },
                    idempotencyKey: key,
                  }),
                ok: 'Ocorrência registrada.',
              },
              { onSuccess: () => (setKey(newIdempotencyKey()), setPanel(null)) },
            )
          }
        />
      )}
    </article>
  );
}

function ItemsPanel({
  j,
  busy,
  onSend,
}: {
  j: LogisticsJobDto;
  busy: boolean;
  onSend: (items: { serviceOrderItemId: string; status: string; note: string | null }[]) => void;
}) {
  const [state, setState] = useState<Record<string, { status: string; note: string }>>(() =>
    Object.fromEntries(j.pieces.map((p) => [p.id, { status: 'ENTREGUE', note: '' }])),
  );
  return (
    <div className="mt-4 space-y-3 rounded-2xl bg-subtle p-4" data-testid="items-panel">
      {j.pieces.map((p) => (
        <div key={p.id}>
          <p className="text-lg font-semibold">
            {p.code} · {p.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['ENTREGUE', 'DIVERGENTE', 'NAO_ENTREGUE'] as const).map((s) => (
              <Button
                key={s}
                size="lg"
                variant={state[p.id]?.status === s ? 'primary' : 'secondary'}
                aria-pressed={state[p.id]?.status === s}
                onClick={() => setState((x) => ({ ...x, [p.id]: { ...x[p.id]!, status: s } }))}
              >
                {DELIVERY_ITEM_STATUS_LABEL[s]}
              </Button>
            ))}
          </div>
          {state[p.id]?.status !== 'ENTREGUE' && (
            <textarea
              aria-label={`Observação de ${p.code}`}
              className="input mt-2 min-h-16 w-full text-lg"
              value={state[p.id]?.note ?? ''}
              onChange={(e) =>
                setState((x) => ({ ...x, [p.id]: { ...x[p.id]!, note: e.target.value } }))
              }
            />
          )}
        </div>
      ))}
      <Button
        size="xl"
        className="w-full"
        loading={busy}
        disabled={Object.values(state).some(
          (s) => s.status !== 'ENTREGUE' && s.note.trim().length < 3,
        )}
        onClick={() =>
          onSend(
            Object.entries(state).map(([id, s]) => ({
              serviceOrderItemId: id,
              status: s.status,
              note: s.note.trim() || null,
            })),
          )
        }
      >
        Registrar peças
      </Button>
    </div>
  );
}

function NotePanel({
  label,
  busy,
  withComplete,
  onSend,
}: {
  label: string;
  busy: boolean;
  withComplete?: boolean;
  onSend: (note: string, complete: boolean) => void;
}) {
  const [note, setNote] = useState('');
  const [complete, setComplete] = useState(true);
  return (
    <div className="mt-4 space-y-3 rounded-2xl bg-subtle p-4">
      <label className="block text-base font-medium">
        {label}
        <textarea
          className="input mt-2 min-h-16 w-full text-lg"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {withComplete && (
        <div className="flex gap-2">
          <Button
            size="lg"
            variant={complete ? 'primary' : 'secondary'}
            onClick={() => setComplete(true)}
          >
            Instalação concluída
          </Button>
          <Button
            size="lg"
            variant={!complete ? 'danger' : 'secondary'}
            onClick={() => setComplete(false)}
          >
            Ficou incompleta
          </Button>
        </div>
      )}
      <Button
        size="xl"
        className="w-full"
        loading={busy}
        disabled={note.trim().length < 3}
        onClick={() => onSend(note.trim(), complete)}
      >
        Registrar
      </Button>
    </div>
  );
}

function KindPanel({
  label,
  busy,
  onSend,
}: {
  label: string;
  busy: boolean;
  onSend: (kind: LogisticsKind, text: string) => void;
}) {
  const [kind, setKind] = useState<LogisticsKind>('CLIENTE_INDISPONIVEL');
  const [text, setText] = useState('');
  return (
    <div className="mt-4 space-y-3 rounded-2xl bg-subtle p-4" data-testid="kind-panel">
      <div className="flex flex-wrap gap-2">
        {LOGISTICS_KINDS.map((k) => (
          <Button
            key={k}
            size="lg"
            variant={kind === k ? 'primary' : 'secondary'}
            aria-pressed={kind === k}
            className={clsx(kind === k && 'ring-2 ring-brand-700')}
            onClick={() => setKind(k)}
          >
            {LOGISTICS_KIND_LABEL[k]}
          </Button>
        ))}
      </div>
      <label className="block text-base font-medium">
        {label}
        <textarea
          className="input mt-2 min-h-16 w-full text-lg"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <Button
        size="xl"
        className="w-full"
        loading={busy}
        disabled={text.trim().length < 3}
        onClick={() => onSend(kind, text.trim())}
      >
        Registrar
      </Button>
    </div>
  );
}
