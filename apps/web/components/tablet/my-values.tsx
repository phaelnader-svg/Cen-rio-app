'use client';

import { ELIGIBILITY_LABEL, LABOR_STATUS_LABEL } from '@cenario/shared';
import { Alert, Badge, Card, Spinner } from '@/components/ui/misc';
import { money, useMyProduction } from '@/lib/finance';

/**
 * Fase 11 — "Meus valores" (Ricardo, Márcio): só os próprios valores de produção e pagamentos,
 * e só quando o gestor concede `financeiro.producao_propria`. Nunca valores de clientes, de
 * outras pessoas nem margens.
 */
export function MyValues() {
  const q = useMyProduction(true);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const t = q.data.totals;
  return (
    <div className="space-y-5" data-testid="my-values">
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
      {!q.data.items.length ? (
        <p className="text-lg text-ink-muted">Nenhum valor de produção combinado.</p>
      ) : (
        <ul className="space-y-3">
          {q.data.items.map((i) => (
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
                <Badge
                  tone={i.status === 'PAGO' ? 'ok' : i.status === 'PREVISTO' ? 'neutral' : 'brand'}
                >
                  {LABOR_STATUS_LABEL[i.status]}
                </Badge>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
