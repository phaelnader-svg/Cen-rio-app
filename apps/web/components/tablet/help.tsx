'use client';

import type { HelpKind, HelpRequestDto, ProductionTaskDto } from '@cenario/shared';
import {
  HELP_KINDS,
  HELP_KIND_LABEL,
  HELP_KIND_MINUTES,
  HELP_OPEN,
  HELP_STATUS_LABEL,
  PRODUCTION_ACTIVITY_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import { HandHelping, Siren, Undo2, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useAlternatives, useMyHelp } from '@/lib/help';
import { useOnline } from './tasks';

/**
 * Fase 8 — ajuda no tablet: "Solicitar ajudante" e "Preciso de ajuda agora" na tarefa
 * própria, acompanhamento e cancelamento do pedido, apoio recebido e tarefas alternativas.
 * Botões grandes, poucas escolhas; nenhum valor financeiro.
 */

const STATUS_TONE: Record<string, string> = {
  PENDENTE: 'border-warn-600/40 bg-warn-50',
  ESCALADA: 'border-warn-600/40 bg-warn-50',
  ATRIBUIDA: 'border-ok-600/40 bg-ok-50',
  EM_EXECUCAO: 'border-ok-600/40 bg-ok-50',
  CONCLUIDA: 'border-line bg-subtle',
  CANCELADA: 'border-line bg-subtle',
};

const DURATIONS = [10, 15, 20, 30, 45, 60];

const isOpen = (r: HelpRequestDto) => (HELP_OPEN as readonly string[]).includes(r.status);

function statusText(r: HelpRequestDto) {
  if (r.status === 'ATRIBUIDA') return `${r.helper?.displayName} vai ajudar`;
  if (r.status === 'EM_EXECUCAO') return `${r.helper?.displayName} está ajudando`;
  if (r.status === 'CONCLUIDA') return `Apoio concluído por ${r.helper?.displayName}`;
  if (r.status === 'PENDENTE') return 'Na fila: aguardando alguém ficar livre';
  if (r.status === 'ESCALADA') return 'Encaminhado ao gestor para decidir';
  return HELP_STATUS_LABEL[r.status];
}

/** Cartão de um pedido (com Cancelar enquanto o apoio não começou). */
export function HelpRequestCard({ r, compact }: { r: HelpRequestDto; compact?: boolean }) {
  const online = useOnline();
  const { m, error } = useSend();
  const [key] = useState(newIdempotencyKey);
  const [confirm, setConfirm] = useState(false);
  const cancellable = ['PENDENTE', 'ATRIBUIDA', 'ESCALADA'].includes(r.status);
  return (
    <div
      className={clsx('rounded-2xl border p-4', STATUS_TONE[r.status])}
      data-testid={`help-${r.code}`}
      data-status={r.status}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <span className="font-mono font-semibold text-ink-soft">{r.code}</span>
        <span>· {r.task.code}</span>
        {r.urgent && (
          <span className="rounded-full bg-danger-600 px-2 py-0.5 font-semibold text-white">
            Urgente
          </span>
        )}
      </p>
      <p className={clsx('mt-1 font-semibold', compact ? 'text-lg' : 'text-xl')}>
        {HELP_KIND_LABEL[r.kind]} · {r.estimatedMinutes} min
      </p>
      <p className="mt-1 text-lg" data-testid="help-status">
        {statusText(r)}
      </p>
      {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
      {cancellable && !compact && (
        <Button
          size="lg"
          variant={confirm ? 'danger' : 'secondary'}
          className="mt-3 w-full"
          disabled={!online}
          loading={m.isPending}
          icon={<X className="size-5" aria-hidden />}
          onClick={() =>
            confirm
              ? m.mutate({
                  run: () =>
                    api(`/api/v1/help-requests/${r.id}/cancel`, {
                      method: 'POST',
                      body: { version: r.version },
                      idempotencyKey: key,
                    }),
                  ok: 'Pedido de ajuda cancelado.',
                })
              : setConfirm(true)
          }
        >
          {confirm ? 'Toque de novo para cancelar o pedido' : 'Cancelar pedido'}
        </Button>
      )}
    </div>
  );
}

/** Ajuda na tarefa própria (detalhe da tarefa). */
export function HelpPanel({ t }: { t: ProductionTaskDto }) {
  const q = useMyHelp();
  const online = useOnline();
  const [mode, setMode] = useState<'normal' | 'urgent' | null>(null);
  const eligible = ['LIBERADA', 'EM_EXECUCAO', 'PAUSADA'].includes(t.status) && !t.supportFor;
  if (!eligible) return null;
  const mine = (q.data ?? []).filter((r) => r.task.id === t.id);
  const open = mine.find(isOpen);
  return (
    <section className="space-y-3" data-testid="help-panel">
      <h2 className="text-xl font-semibold">Ajuda</h2>
      {open ? (
        <HelpRequestCard r={open} />
      ) : mode ? (
        <HelpForm t={t} urgent={mode === 'urgent'} onClose={() => setMode(null)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Button
            size="xl"
            variant="secondary"
            disabled={!online}
            icon={<HandHelping className="size-6" aria-hidden />}
            onClick={() => setMode('normal')}
          >
            Solicitar ajudante
          </Button>
          <Button
            size="xl"
            variant="danger"
            disabled={!online}
            icon={<Siren className="size-6" aria-hidden />}
            onClick={() => setMode('urgent')}
          >
            Preciso de ajuda agora
          </Button>
        </div>
      )}
      {mine
        .filter((r) => !isOpen(r))
        .slice(0, 2)
        .map((r) => (
          <HelpRequestCard key={r.id} r={r} compact />
        ))}
    </section>
  );
}

function HelpForm({
  t,
  urgent,
  onClose,
}: {
  t: ProductionTaskDto;
  urgent: boolean;
  onClose: () => void;
}) {
  const online = useOnline();
  const { m, error, setError } = useSend(onClose);
  const [key] = useState(newIdempotencyKey);
  const [kind, setKind] = useState<HelpKind | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const suggested = kind ? HELP_KIND_MINUTES[kind] : null;
  const send = () => {
    if (!kind) return setError('Escolha o tipo de apoio.');
    if (urgent && why.trim().length < 5)
      return setError('Diga em poucas palavras por que é urgente.');
    m.mutate({
      run: () =>
        api('/api/v1/help-requests', {
          method: 'POST',
          body: {
            taskId: t.id,
            kind,
            ...(minutes ? { estimatedMinutes: minutes } : {}),
            urgent,
            justification: urgent ? why : undefined,
            note: note || undefined,
          },
          idempotencyKey: key,
        }),
      ok: urgent ? 'Pedido urgente enviado.' : 'Pedido de ajuda enviado.',
    });
  };
  return (
    <div
      className={clsx(
        'space-y-5 rounded-2xl border bg-surface p-5',
        urgent ? 'border-danger-600/50' : 'border-line',
      )}
      data-testid={urgent ? 'help-form-urgent' : 'help-form'}
    >
      <p className="text-xl font-semibold">
        {urgent ? 'Preciso de ajuda agora' : 'Solicitar ajudante'}
      </p>
      <div>
        <p className="mb-2 text-base font-semibold text-ink-soft">Tipo de apoio</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {HELP_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setMinutes(null);
              }}
              className={clsx(
                'min-h-14 rounded-xl border px-4 py-3 text-left text-lg font-semibold active:scale-[0.99]',
                kind === k
                  ? 'border-brand-700 bg-brand-50 text-brand-800'
                  : 'border-line bg-surface',
              )}
            >
              {HELP_KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      {kind && (
        <div>
          <p className="mb-2 text-base font-semibold text-ink-soft">
            Tempo estimado (sugestão: {suggested} min)
          </p>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => {
              const active = (minutes ?? suggested) === d;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setMinutes(d === suggested ? null : d)}
                  className={clsx(
                    'min-h-12 min-w-20 rounded-xl border px-4 text-lg font-semibold',
                    active
                      ? 'border-brand-700 bg-brand-50 text-brand-800'
                      : 'border-line bg-surface',
                  )}
                >
                  {d} min
                </button>
              );
            })}
          </div>
        </div>
      )}
      {urgent && (
        <label className="block">
          <span className="mb-2 block text-base font-semibold text-ink-soft">
            Por que é urgente? (obrigatório)
          </span>
          <input
            className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg"
            value={why}
            maxLength={300}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="Ex.: peça pesada apoiada só de um lado"
            data-testid="help-justification"
          />
        </label>
      )}
      <label className="block">
        <span className="mb-2 block text-base font-semibold text-ink-soft">
          Observação (opcional)
        </span>
        <input
          className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          size="xl"
          variant={urgent ? 'danger' : 'primary'}
          disabled={!online || !kind}
          loading={m.isPending}
          icon={<Users className="size-6" aria-hidden />}
          onClick={send}
        >
          {urgent ? 'Pedir ajuda agora' : 'Pedir ajuda'}
        </Button>
        <Button size="xl" variant="secondary" onClick={onClose} icon={<Undo2 className="size-6" />}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

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

/** Meus pedidos abertos (no "Meu dia"). */
export function MyOpenHelp() {
  const q = useMyHelp();
  const open = (q.data ?? []).filter(isOpen);
  if (!open.length) return null;
  return (
    <section data-testid="my-help">
      <h2 className="mb-3 text-xl font-semibold">Meus pedidos de ajuda</h2>
      <ul className="grid gap-3 lg:grid-cols-2">
        {open.map((r) => (
          <li key={r.id}>
            <HelpRequestCard r={r} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}
