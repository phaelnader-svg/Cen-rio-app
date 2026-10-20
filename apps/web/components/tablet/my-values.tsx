'use client';

import { useCallback, useEffect, useState } from 'react';
import { MY_EARNINGS_SITUATION_LABEL, type MyEarningsDto } from '@cenario/shared';
import { Alert, Badge, Card } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { money } from '@/lib/finance';
import { RequestChange, RequestStatus, WeekConfirmation } from './earnings-actions';

type Unlock = { token: string; expiresAt: number };
const br = (iso: string) => iso.split('-').reverse().join('/');
const shiftWeek = (iso: string, weeks: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
};
const TONE = {
  PREVISTO: 'neutral',
  AGUARDANDO_LIBERACAO: 'neutral',
  EM_REVISAO: 'warn',
  LIBERADO: 'brand',
  PAGO_PARCIAL: 'brand',
  PAGO: 'ok',
} as const;

/**
 * R1 — "Meus Ganhos" (tapeceiro e logística): só a própria remuneração variável, por semana, com
 * os mesmos números do fechamento semanal.
 *
 * D12: o tablet é compartilhado, então a pessoa redigita o PIN; ele libera a consulta por 5
 * minutos NESTA sessão (token só em memória — some ao sair, ao ocultar ou ao recarregar). Dá
 * para navegar entre as semanas sem novo PIN; ao expirar, volta a pedir.
 */
export function MyValues() {
  const [unlock, setUnlock] = useState<Unlock | null>(null);
  const [data, setData] = useState<MyEarningsDto | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lock = useCallback((message: string | null = null) => {
    setUnlock(null);
    setData(null);
    setError(message);
  }, []);

  useEffect(() => {
    if (!unlock) return;
    const t = window.setTimeout(
      () => lock('O tempo de consulta terminou. Confirme seu PIN de novo.'),
      Math.max(0, unlock.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [unlock, lock]);

  const load = async (u: Unlock, week?: string) => {
    setBusy(true);
    try {
      setData(
        await api<MyEarningsDto>(`/api/v1/finance/my-earnings${week ? `?week=${week}` : ''}`, {
          headers: { 'x-earnings-unlock': u.token },
        }),
      );
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403)
        lock('Confirme seu PIN para ver seus ganhos.');
      else setError(err instanceof ApiError ? err.message : 'Não foi possível abrir seus ganhos.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin) || busy) {
      setError('Digite os 6 dígitos do seu PIN.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ unlockToken: string; expiresAt: string }>(
        '/api/v1/finance/my-earnings/unlock',
        { method: 'POST', body: { pin } },
      );
      const u = { token: r.unlockToken, expiresAt: new Date(r.expiresAt).getTime() };
      setUnlock(u);
      setPin('');
      await load(u);
    } catch (err) {
      setPin('');
      setBusy(false);
      setError(err instanceof ApiError ? err.message : 'Não foi possível abrir seus ganhos.');
    }
  };

  if (!unlock || !data)
    return (
      <form onSubmit={submit} className="max-w-sm space-y-4" data-testid="my-values-lock">
        <p className="text-lg text-ink-muted">
          Este tablet é usado por toda a equipe. Para ver seus ganhos, confirme seu PIN (vale por{' '}
          {5} minutos).
        </p>
        <label className="block">
          <span className="text-base font-medium">Seu PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="input input-lg mt-1 text-2xl tracking-[0.5em]"
            aria-describedby="my-values-error"
            data-testid="my-values-pin"
          />
        </label>
        <p
          id="my-values-error"
          role="alert"
          className="min-h-7 text-lg font-medium text-danger-600"
        >
          {error}
        </p>
        <button
          type="submit"
          disabled={busy}
          className="h-14 w-full rounded-xl bg-brand-700 text-lg font-semibold text-white disabled:opacity-50"
          data-testid="my-values-unlock"
        >
          {busy ? 'Verificando…' : 'Ver meus ganhos'}
        </button>
      </form>
    );

  const s = data.summary;
  const isCurrent = data.weekStart >= data.currentWeekStart;
  const cards: [string, number, string][] = [
    ['Previsto', s.forecastCents, 'forecast'],
    ['Aguardando liberação', s.awaitingCents, 'awaiting'],
    ['Em revisão', s.inReviewCents, 'review'],
    ['Liberado', s.releasedCents, 'released'],
    ['Pago na semana', s.paidInWeekCents, 'paid'],
    ['Saldo a receber', s.balanceCents, 'balance'],
  ];
  return (
    <div className="space-y-5" data-testid="my-values">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="my-values-week">
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(unlock, shiftWeek(data.weekStart, -1))}
            className="rounded-xl border border-line px-4 py-2 text-base font-medium disabled:opacity-50"
            data-testid="my-values-prev"
          >
            ← Semana anterior
          </button>
          <p className="px-2 text-lg font-semibold tabular-nums">
            {br(data.weekStart)} a {br(data.weekEnd)}
            {isCurrent ? ' (atual)' : ''}
          </p>
          <button
            type="button"
            disabled={busy || isCurrent}
            onClick={() => void load(unlock, shiftWeek(data.weekStart, 1))}
            className="rounded-xl border border-line px-4 py-2 text-base font-medium disabled:opacity-50"
            data-testid="my-values-next"
          >
            Próxima semana →
          </button>
        </div>
        <button
          type="button"
          onClick={() => lock()}
          className="rounded-xl border border-line px-4 py-2 text-base font-medium"
          data-testid="my-values-hide"
        >
          Ocultar valores
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map(([label, cents, key]) => (
          <Card key={key} className="p-5">
            <p className="text-base text-ink-muted">{label}</p>
            <p className="text-3xl font-semibold tabular-nums" data-testid={`my-values-${key}`}>
              {money(cents)}
            </p>
          </Card>
        ))}
      </div>
      <p className="text-base text-ink-muted">
        Previsto, aguardando liberação e em revisão mostram a situação de agora e não entram no
        saldo a receber. Os valores da semana são os mesmos do fechamento.
      </p>
      <WeekConfirmation
        data={data}
        token={unlock.token}
        onDone={() => load(unlock, data.weekStart)}
      />
      {!data.items.length ? (
        <p className="text-lg text-ink-muted">Nenhum ganho nesta semana.</p>
      ) : (
        <ul className="space-y-3">
          {data.items.map((i) => (
            <li key={i.id}>
              <Card className="space-y-2 p-5" data-testid={`my-value-${i.code}`}>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold">
                      {i.serviceOrders.join(', ')}
                      {i.piece ? ` · ${i.piece}` : ''} — {i.description}
                    </p>
                    <p className="text-base text-ink-muted">
                      {i.category === 'LOGISTICA' ? 'Logística' : 'Tapeçaria'} · {i.code}
                      {i.releasedAt ? ` · liberado em ${br(i.releasedAt)}` : ''}
                      {i.bucket === 'PREVIOUS' ? ' · saldo de semana anterior' : ''}
                    </p>
                  </div>
                  <p className="text-2xl font-semibold tabular-nums">{money(i.totalDueCents)}</p>
                  <span data-testid={`my-value-situation-${i.code}`}>
                    <Badge tone={TONE[i.situation]}>
                      {MY_EARNINGS_SITUATION_LABEL[i.situation]}
                    </Badge>
                  </span>
                </div>
                <p className="text-base text-ink-muted" data-testid={`my-value-terms-${i.code}`}>
                  Combinado {money(i.agreedCents)}
                  {i.adjustmentsCents ? ` · ajustes ${money(i.adjustmentsCents)}` : ''}
                  {/* F8-11: só o que já entrou no fechamento é devido; o resto ainda é previsão. */}
                  {i.bucket === 'FORECAST'
                    ? ` · previsto ${money(i.totalDueCents)} (ainda não é devido)`
                    : ` · devido ${money(i.totalDueCents)} · a receber ${money(i.currentOpenCents)}`}
                </p>
                {i.adjustments.length > 0 && (
                  <ul className="text-base text-ink-muted" data-testid={`my-value-adj-${i.code}`}>
                    {i.adjustments.map((a, n) => (
                      <li key={n}>
                        Ajuste de {money(a.amountCents)} em {br(a.date)}: {a.reason}
                        {a.afterWeek ? ' (entra na semana em que foi feito)' : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {i.payments.length > 0 && (
                  <p className="text-base text-ink-muted">
                    Pagamentos:{' '}
                    {i.payments
                      .map(
                        (p) =>
                          `${money(p.amountCents)} em ${br(p.paidAt)}${p.reversed ? ' (estornado)' : ''}${p.administrative ? ' (liberado administrativamente)' : ''}`,
                      )
                      .join(', ')}
                  </p>
                )}
                <RequestStatus item={i} />
                <RequestChange
                  item={i}
                  token={unlock.token}
                  onDone={() => load(unlock, data.weekStart)}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
      {data.items.some((i) => i.situation === 'EM_REVISAO') && (
        <Alert tone="warn">
          Há valor em revisão pelo gestor (troca de responsável ou devolução de peça). Ele não entra
          no saldo a receber até o gestor concluir a revisão.
        </Alert>
      )}
    </div>
  );
}
