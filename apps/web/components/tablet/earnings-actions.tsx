'use client';

import { useState } from 'react';
import {
  VALUE_CHANGE_STATUS_LABEL,
  WEEK_CONFIRMATION_LABEL,
  type MyEarningsDto,
} from '@cenario/shared';
import { Alert, Badge } from '@/components/ui/misc';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { money } from '@/lib/finance';

type Item = MyEarningsDto['items'][number];
const cents = (v: string) => {
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/** R2 — situação do pedido de alteração do item (só do próprio profissional). */
export function RequestStatus({ item }: { item: Item }) {
  const r = item.request;
  if (!r) return null;
  const tone =
    r.status === 'APROVADA'
      ? 'ok'
      : r.status === 'RECUSADA'
        ? 'danger'
        : r.status === 'OBSOLETA'
          ? 'neutral'
          : 'warn';
  return (
    <div className="text-base" data-testid={`my-value-request-${item.code}`}>
      <Badge tone={tone}>
        Pedido {r.code}: {VALUE_CHANGE_STATUS_LABEL[r.status]}
      </Badge>{' '}
      <span className="text-ink-muted">
        de {money(r.currentCents)} para {money(r.requestedCents)}
        {r.decisionNote ? ` · ${r.decisionNote}` : ''}
      </span>
    </div>
  );
}

/** R2 — "Solicitar alteração": valor pedido e motivo; nada muda até o gestor decidir. */
export function RequestChange({
  item,
  token,
  onDone,
}: {
  item: Item;
  token: string;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!item.canRequest) return null;
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-line px-4 py-2 text-base font-medium"
        data-testid={`my-value-ask-${item.code}`}
      >
        Solicitar alteração
      </button>
    );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const requestedCents = cents(value);
    if (!requestedCents) return setError('Informe o valor pedido.');
    if (reason.trim().length < 5) return setError('Explique o motivo do pedido.');
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/finance/my-earnings/requests', {
        method: 'POST',
        headers: { 'x-earnings-unlock': token },
        idempotencyKey: newIdempotencyKey(),
        body: {
          targetKind: item.category === 'LOGISTICA' ? 'LOGISTICA' : 'PRODUCAO',
          targetId: item.id,
          requestedCents,
          reason: reason.trim(),
        },
      });
      setOpen(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar o pedido.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-line p-4"
      data-testid={`my-value-ask-form-${item.code}`}
    >
      <p className="text-base">
        Valor atual: <strong>{money(item.totalDueCents)}</strong>
      </p>
      <label className="block">
        <span className="text-base font-medium">Valor que você pede (R$)</span>
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="input input-lg mt-1"
          data-testid="ask-value"
        />
      </label>
      <label className="block">
        <span className="text-base font-medium">Motivo</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input mt-1 min-h-20"
          maxLength={500}
          data-testid="ask-reason"
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="h-12 rounded-xl bg-brand-700 px-5 text-base font-semibold text-white disabled:opacity-50"
          data-testid="ask-submit"
        >
          {busy ? 'Enviando…' : 'Enviar pedido'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-12 rounded-xl border border-line px-5 text-base font-medium"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** R2 — conferência da semana pelo profissional (D13: sem ela, o pagamento não sai). */
export function WeekConfirmation({
  data,
  token,
  onDone,
}: {
  data: MyEarningsDto;
  token: string;
  onDone: () => Promise<void>;
}) {
  const c = data.confirmation;
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tone =
    c.state === 'CONFIRMADA' ? 'ok' : c.state === 'LIBERADA_POR_EXCECAO' ? 'brand' : 'warn';
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/finance/my-earnings/confirm', {
        method: 'POST',
        headers: { 'x-earnings-unlock': token },
        idempotencyKey: newIdempotencyKey(),
        body: { week: data.weekStart, hash: c.currentHash, confirm: true },
      });
      setOpen(false);
      setChecked(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível confirmar a semana.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-line p-4" data-testid="week-confirmation">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={c.state === 'SEM_ITENS' ? 'neutral' : tone}>
          <span data-testid="week-confirmation-state">{WEEK_CONFIRMATION_LABEL[c.state]}</span>
        </Badge>
        {c.latest?.kind === 'EXCECAO_ADMINISTRATIVA' && c.latest.publicNote && (
          <span className="text-base text-ink-muted">{c.latest.publicNote}</span>
        )}
        {c.state === 'DESATUALIZADA' && c.changed.length > 0 && (
          <span className="text-base text-ink-muted">Mudaram: {c.changed.join(', ')}</span>
        )}
      </div>
      {c.state !== 'SEM_ITENS' && c.state !== 'CONFIRMADA' && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-12 rounded-xl bg-brand-700 px-5 text-base font-semibold text-white"
          data-testid="week-confirm-open"
        >
          Conferir semana
        </button>
      )}
      {open && (
        <div className="space-y-3" data-testid="week-confirm-panel">
          <ul className="text-base">
            {c.lines.map((l) => (
              <li key={l.code} className="flex justify-between gap-3 tabular-nums">
                <span>{l.code}</span>
                <span>{money(l.dueCents)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t border-line pt-2 font-semibold tabular-nums">
              <span>Total da semana</span>
              <span data-testid="week-confirm-total">{money(c.totalCents)}</span>
            </li>
          </ul>
          {c.pendingRequests.length > 0 ? (
            <Alert tone="warn">
              Há pedido de alteração pendente ({c.pendingRequests.join(', ')}): aguarde a decisão do
              gestor para confirmar a semana.
            </Alert>
          ) : (
            <label className="flex items-center gap-3 text-base">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="size-6"
                data-testid="week-confirm-check"
              />
              Conferi os itens e os valores desta semana.
            </label>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!checked || busy || c.pendingRequests.length > 0}
              onClick={() => void confirm()}
              className="h-12 rounded-xl bg-brand-700 px-5 text-base font-semibold text-white disabled:opacity-50"
              data-testid="week-confirm-submit"
            >
              {busy ? 'Confirmando…' : 'Confirmar semana'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-12 rounded-xl border border-line px-5 text-base font-medium"
            >
              Voltar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
