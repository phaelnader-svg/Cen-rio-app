'use client';

import { type BillingCycle, type PlanKey, type SubscriptionDto } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, CreditCard, ExternalLink, Gamepad2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatCents, formatDay } from '@/lib/billing';
import { useMe } from '@/lib/hooks';
import { CancelSubscriptionCard } from '@/components/improvements/company-extras';
import { ManualPaymentCard } from './billing-notice';

const STATUS_TONE = {
  CORTESIA: 'info',
  TESTE: 'info',
  ATIVA: 'ok',
  ATRASADA: 'warn',
  VENCIDA: 'danger',
} as const;

const INVOICE_LABEL = {
  PENDENTE: 'Em aberto',
  PAGA: 'Paga',
  VENCIDA: 'Vencida',
  CANCELADA: 'Cancelada',
} as const;

/**
 * Assinatura (melhoria 1): plano, situação, cobranças e o botão que abre a página de pagamento
 * do Asaas (Pix, boleto ou cartão). Abre mesmo com a assinatura vencida.
 */
export function SubscriptionPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const canManage = me.data?.permissions.includes('empresa.configurar') ?? false;
  const q = useQuery({
    queryKey: ['subscription'],
    queryFn: () => api<SubscriptionDto>('/api/v1/subscription'),
  });
  const [cycle, setCycle] = useState<BillingCycle>('MENSAL');
  const [chosen, setChosen] = useState<PlanKey | null>(null);
  const [document, setDocument] = useState('');
  const [docError, setDocError] = useState<string | null>(null);

  const checkout = useMutation({
    mutationFn: (plan: PlanKey) =>
      api<{ paymentUrl: string | null; subscription: SubscriptionDto }>(
        '/api/v1/subscription/checkout',
        { method: 'POST', body: { plan, cycle, ...(document ? { document } : {}) } },
      ),
    onSuccess: (r) => {
      qc.setQueryData(['subscription'], r.subscription);
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (r.paymentUrl) window.open(r.paymentUrl, '_blank', 'noopener');
      toast(
        'ok',
        'Cobrança gerada. A página de pagamento abriu em outra guia; quando o pagamento for confirmado, a assinatura atualiza sozinha.',
      );
      setChosen(null);
    },
    onError: (e) => {
      const msg = errorMessage(e);
      if (/CPF|CNPJ/.test(msg)) setDocError(msg);
      else toast('danger', msg);
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  const s = q.data!;
  const open = s.invoices.find((i) => i.paymentUrl);

  return (
    <>
      <PageHeader
        title="Assinatura"
        description="O plano do Cenário Gestão da sua empresa, as cobranças e o pagamento."
      />

      <Card className="mb-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-muted">Plano atual</p>
          <p className="text-lg font-semibold">{s.planLabel}</p>
          <p className="mt-1 text-sm text-ink-muted">
            {s.status === 'CORTESIA'
              ? 'Cortesia: não há o que pagar.'
              : s.status === 'TESTE'
                ? `Teste grátis até ${formatDay(s.trialEndsAt)}.`
                : s.status === 'ATIVA'
                  ? `Pago até ${formatDay(s.paidUntil)}.`
                  : s.status === 'ATRASADA'
                    ? `Venceu em ${formatDay(s.paidUntil)}. Bloqueia em ${formatDay(s.blocksAt)}.`
                    : 'Vencida: o sistema volta a funcionar assim que o pagamento for confirmado.'}
          </p>
        </div>
        <Badge tone={STATUS_TONE[s.status]}>{s.statusLabel}</Badge>
        {open?.paymentUrl && (
          <a
            href={open.paymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-700 px-4 font-semibold text-white hover:bg-brand-800"
          >
            <CreditCard className="size-4" aria-hidden /> Pagar {formatCents(open.amountCents)}
          </a>
        )}
      </Card>

      {/* Cobrança feita pelo Cenário Gestão (sem pagamento online): PIX e WhatsApp. */}
      {s.status !== 'CORTESIA' && !s.canPayOnline && s.manual && canManage && (
        <div className="mb-6 max-w-md">
          <h2 className="mb-2 text-lg font-semibold">Como pagar</h2>
          <ManualPaymentCard manual={s.manual} cycle={s.cycle} planLabel={s.planLabel} />
          <p className="mt-2 text-sm text-ink-muted">
            Para mudar de plano ou passar para o anual, é só falar pelo WhatsApp.
          </p>
        </div>
      )}

      {s.status !== 'CORTESIA' && (
        <>
          <div className="mb-4 flex items-center gap-3">
            <div
              role="radiogroup"
              aria-label="Ciclo"
              className="inline-flex rounded-xl border border-line-strong p-1"
            >
              {(['MENSAL', 'ANUAL'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={cycle === c}
                  onClick={() => setCycle(c)}
                  className={clsx(
                    'h-9 rounded-lg px-4 text-sm font-semibold',
                    cycle === c ? 'bg-brand-700 text-white' : 'text-ink-soft hover:bg-subtle',
                  )}
                >
                  {c === 'MENSAL' ? 'Mensal' : 'Anual'}
                </button>
              ))}
            </div>
            <span className="text-sm text-ink-muted">
              No anual, {s.annualDiscountPct}% de desconto.
            </span>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {s.plans.map((p) => {
              const current = p.key === s.plan;
              const price = cycle === 'MENSAL' ? p.monthlyCents : p.annualCents;
              return (
                <Card
                  key={p.key}
                  className={clsx('flex flex-col p-5', current && 'ring-2 ring-brand-500')}
                >
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-lg font-semibold">{p.label}</p>
                    {current && <Badge tone="info">Seu plano</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">{p.description}</p>
                  <p className="mt-4 text-2xl font-semibold tracking-tight">
                    {formatCents(price)}
                    <span className="text-sm font-normal text-ink-muted">
                      {cycle === 'MENSAL' ? ' / mês' : ' / ano'}
                    </span>
                  </p>
                  {cycle === 'ANUAL' && (
                    <p className="text-sm text-ink-muted">
                      Equivale a {formatCents(Math.round(price / 12))} por mês.
                    </p>
                  )}
                  <ul className="mt-4 space-y-1.5 text-sm">
                    <li className="flex gap-2">
                      <Check className="size-4 text-ok-600" aria-hidden /> Painel, tablets da
                      oficina e orçamentos
                    </li>
                    {p.includesGame && (
                      <li className="flex gap-2">
                        <Gamepad2 className="size-4 text-ok-600" aria-hidden /> Ambiente interativo
                        Firma Viva
                      </li>
                    )}
                  </ul>
                  {canManage && s.canPayOnline && (
                    <Button
                      className="mt-5"
                      variant={current ? 'primary' : 'secondary'}
                      loading={checkout.isPending && checkout.variables === p.key}
                      disabled={!s.canPayOnline}
                      onClick={() => {
                        setChosen(p.key);
                        setDocError(null);
                        checkout.mutate(p.key);
                      }}
                    >
                      {current ? 'Assinar este plano' : 'Mudar para este plano'}
                    </Button>
                  )}
                </Card>
              );
            })}
          </div>

          {docError && chosen && (
            <Card className="mt-4 p-5">
              <Field label="CPF ou CNPJ de quem paga" error={docError}>
                {(f) => (
                  <Input
                    {...f}
                    inputMode="numeric"
                    value={document}
                    onChange={(e) => setDocument(e.target.value)}
                    autoFocus
                  />
                )}
              </Field>
              <Button
                className="mt-3"
                loading={checkout.isPending}
                onClick={() => {
                  setDocError(null);
                  checkout.mutate(chosen);
                }}
              >
                Continuar para o pagamento
              </Button>
            </Card>
          )}

          {!s.canPayOnline && !s.manual && (
            <Alert tone="info" className="mt-4">
              O pagamento online ainda não está ligado. Para assinar agora, fale com o Cenário
              Gestão pelo WhatsApp.
            </Alert>
          )}
          {s.canPayOnline && (
            <p className="mt-4 text-sm text-ink-muted">
              O pagamento é feito no Asaas, por Pix, boleto ou cartão. Mudar de plano gera uma
              cobrança nova; o plano novo vale assim que ela for paga.
            </p>
          )}
        </>
      )}

      {s.invoices.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Cobranças</h2>
          <Card className="divide-y divide-line">
            {s.invoices.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="w-24 text-ink-muted">{formatDay(i.dueDate + 'T12:00:00Z')}</span>
                <span className="flex-1">
                  {s.plans.find((p) => p.key === i.plan)?.label ?? i.plan} ·{' '}
                  {i.cycle === 'ANUAL' ? 'anual' : 'mensal'}
                </span>
                <span className="font-medium">{formatCents(i.amountCents)}</span>
                <Badge
                  tone={
                    i.status === 'PAGA'
                      ? 'ok'
                      : i.status === 'VENCIDA'
                        ? 'danger'
                        : i.status === 'PENDENTE'
                          ? 'warn'
                          : 'neutral'
                  }
                >
                  {INVOICE_LABEL[i.status]}
                </Badge>
                {i.paymentUrl && (
                  <a
                    href={i.paymentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline"
                  >
                    Pagar <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </div>
            ))}
          </Card>
        </section>
      )}
      {canManage && <CancelSubscriptionCard />}
    </>
  );
}
