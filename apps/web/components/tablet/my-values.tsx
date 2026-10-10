'use client';

import { useEffect, useState } from 'react';
import { ELIGIBILITY_LABEL, LABOR_SITUATION_LABEL, type MyProductionDto } from '@cenario/shared';
import { Alert, Badge, Card } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { money } from '@/lib/finance';

/** Tempo máximo com os valores na tela do tablet compartilhado. */
const VISIBLE_MS = 2 * 60_000;

/**
 * "Meus valores" (Ricardo, Márcio): só os próprios valores de produção e pagamentos, e só
 * quando o gestor concede `financeiro.producao_propria`.
 *
 * Evolução Fase 5: o tablet é compartilhado e a sessão do aparelho é longa, então a sessão não
 * prova quem está diante da tela. A cada abertura a pessoa redigita o PIN; a resposta fica só
 * neste componente (sem cache de consultas) e some ao sair, ao tocar em "Ocultar" ou após
 * 2 minutos.
 */
export function MyValues() {
  const [data, setData] = useState<MyProductionDto | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const t = window.setTimeout(() => setData(null), VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, [data]);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin) || busy) {
      setError('Digite os 6 dígitos do seu PIN.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setData(
        await api<MyProductionDto>('/api/v1/finance/my-production/unlock', {
          method: 'POST',
          body: { pin },
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível abrir seus valores.');
    } finally {
      setPin('');
      setBusy(false);
    }
  };

  if (!data)
    return (
      <form onSubmit={unlock} className="max-w-sm space-y-4" data-testid="my-values-lock">
        <p className="text-lg text-ink-muted">
          Este tablet é usado por toda a equipe. Para ver seus valores, confirme seu PIN.
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
            className="mt-1 block h-14 w-full rounded-xl border border-line-strong bg-surface px-4 text-2xl tracking-[0.5em]"
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
          {busy ? 'Verificando…' : 'Ver meus valores'}
        </button>
      </form>
    );

  const t = data.totals;
  return (
    <div className="space-y-5" data-testid="my-values">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-base text-ink-muted">Os valores somem da tela em 2 minutos.</p>
        <button
          type="button"
          onClick={() => setData(null)}
          className="rounded-xl border border-line px-4 py-2 text-base font-medium"
          data-testid="my-values-hide"
        >
          Ocultar valores
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-base text-ink-muted">Liberado a receber</p>
          <p className="text-3xl font-semibold tabular-nums" data-testid="my-values-released">
            {money(t.releasedOpenCents)}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-base text-ink-muted">Previsto (aguardando condição)</p>
          <p className="text-3xl font-semibold tabular-nums">{money(t.forecastCents)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-base text-ink-muted">Já pago</p>
          <p className="text-3xl font-semibold tabular-nums">{money(t.paidCents)}</p>
        </Card>
      </div>
      {!data.items.length ? (
        <p className="text-lg text-ink-muted">Nenhum valor de produção combinado.</p>
      ) : (
        <ul className="space-y-3">
          {data.items.map((i) => (
            <li key={i.id}>
              <Card
                className="flex flex-wrap items-center gap-4 p-5"
                data-testid={`my-value-${i.code}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-semibold">
                    {i.serviceOrder}
                    {i.piece ? ` · ${i.piece}` : ''} — {i.service}
                  </p>
                  <p className="text-base text-ink-muted">
                    {ELIGIBILITY_LABEL[i.eligibility]}
                    {i.payments.length
                      ? ` · pagamentos: ${i.payments.map((p) => `${money(p.amountCents)} em ${p.paidAt.split('-').reverse().join('/')}`).join(', ')}`
                      : ''}
                  </p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">{money(i.dueCents)}</p>
                <span data-testid={`my-value-situation-${i.code}`}>
                  <Badge
                    tone={
                      i.situation === 'PAGO'
                        ? 'ok'
                        : i.situation === 'EM_REVISAO'
                          ? 'warn'
                          : i.situation === 'LIBERADO' || i.situation === 'PAGO_PARCIAL'
                            ? 'brand'
                            : 'neutral'
                    }
                  >
                    {LABOR_SITUATION_LABEL[i.situation]}
                  </Badge>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {data.items.some((i) => i.situation === 'EM_REVISAO') && (
        <Alert tone="warn">
          Há valor em revisão pelo gestor (troca de responsável pela peça). Nada muda até ele
          concluir a revisão.
        </Alert>
      )}
    </div>
  );
}
