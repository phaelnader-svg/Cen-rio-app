'use client';

import {
  ELIGIBILITY_LABEL,
  LABOR_SITUATION_LABEL,
  type LaborPayableDto,
  type LaborReviewDto,
  type LaborSituation,
} from '@cenario/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { Section } from '@/components/commercial/section';
import { api, newIdempotencyKey } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { money, parseMoney, useFinPeople, useFinSend, useServiceOrderLabor } from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS } from './common';
import { LaborDialog } from './labor';

export const SITUATION_TONE: Record<LaborSituation, 'neutral' | 'brand' | 'ok' | 'warn' | 'info'> =
  {
    PREVISTO: 'neutral',
    AGUARDANDO_QUALIDADE: 'info',
    LIBERADO: 'brand',
    PAGO_PARCIAL: 'brand',
    PAGO: 'ok',
    EM_REVISAO: 'warn',
    CANCELADO: 'neutral',
  };

export function SituationBadge({ l }: { l: Pick<LaborPayableDto, 'situation' | 'code'> }) {
  return (
    <span data-testid={`labor-situation-${l.code}`}>
      <Badge tone={SITUATION_TONE[l.situation]}>{LABOR_SITUATION_LABEL[l.situation]}</Badge>
    </span>
  );
}

/**
 * Evolução Fase 5 — mão de obra por peça na OS (somente financeiro). Cada peça mostra o
 * tapeceiro titular e o valor combinado com ele; "sem valor combinado" nunca é R$ 0. Troca de
 * titular com valor já combinado abre revisão financeira, resolvida aqui pelo gestor.
 */
export function OsLabor({ serviceOrderId }: { serviceOrderId: string }) {
  const can = useCan();
  const q = useServiceOrderLabor(serviceOrderId);
  const [open, setOpen] = useState<string | null>(null);
  const [agree, setAgree] = useState<{ itemId: string; userId: string; label: string } | null>(
    null,
  );
  const [resolve, setResolve] = useState<LaborReviewDto | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const d = q.data;
  const manage = can('financeiro.gerenciar');
  const adjust = can('financeiro.ajustes');
  return (
    <div className="space-y-6" data-testid="os-labor">
      {d.openReviews.map((r) => (
        <Alert
          key={r.id}
          tone="warn"
          title={`Revisão financeira pendente — ${r.code}${r.piece ? ` (${r.piece.code})` : ' (OS inteira)'}`}
        >
          <p>{r.reason}</p>
          <p className="mt-1">
            Liberação, pagamentos, ajustes e novos valores ficam travados neste escopo até a
            resolução. Nada foi transferido automaticamente.
          </p>
          {adjust && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => setResolve(r)}
              data-testid={`resolve-${r.code}`}
            >
              Resolver revisão
            </Button>
          )}
        </Alert>
      ))}
      <Section title="Mão de obra por peça" bodyClassName="p-0">
        <ul className="divide-y divide-line">
          {d.pieces.map((p) => (
            <li key={p.id} className="px-5 py-4" data-testid={`os-labor-piece-${p.code}`}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="mr-auto font-semibold">
                  {p.code} — {p.description}
                </p>
                <span className="text-sm text-ink-muted">
                  Titular: {p.upholsterer?.displayName ?? 'não definido'}
                </span>
              </div>
              {p.payables.length ? (
                <ul className="mt-2 space-y-1.5">
                  {p.payables.map((l) => (
                    <PayableLine key={l.id} l={l} onOpen={() => setOpen(l.id)} />
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-muted" data-testid={`no-value-${p.code}`}>
                  {p.missingValue ? 'Sem valor combinado.' : 'Sem titular de tapeçaria definido.'}
                </p>
              )}
              {manage && p.missingValue && !p.openReview && p.upholsterer && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() =>
                    setAgree({
                      itemId: p.id,
                      userId: p.upholsterer!.userId,
                      label: `${p.code} — ${p.upholsterer!.displayName}`,
                    })
                  }
                  data-testid={`agree-${p.code}`}
                >
                  Combinar valor
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {d.wholeOrder.length > 0 && (
        <Section title="Valor da OS inteira (legado)">
          <ul className="space-y-1.5">
            {d.wholeOrder.map((l) => (
              <PayableLine key={l.id} l={l} onOpen={() => setOpen(l.id)} />
            ))}
          </ul>
          {d.wholeOrder.some((l) => l.needsPieceReview) && (
            <p className="mt-2 text-sm text-warn-600">
              Há peças com outro titular: o valor da OS inteira não é dividido automaticamente.
            </p>
          )}
        </Section>
      )}
      {open && <LaborDialog id={open} onClose={() => setOpen(null)} />}
      {agree && (
        <FormDialog
          title={`Combinar valor — ${agree.label}`}
          description="Valor da mão de obra desta peça com o tapeceiro titular. O pagamento só é liberado na condição escolhida."
          submitLabel="Combinar"
          onClose={() => setAgree(null)}
          fields={[
            { name: 'service', label: 'Serviço', required: true },
            { name: 'amount', label: 'Valor combinado (R$)', type: 'money', required: true },
            {
              name: 'eligibility',
              label: 'Liberar o pagamento quando',
              type: 'select',
              options: PAYMENT_OPTIONS(ELIGIBILITY_LABEL),
              initial: 'QUALIDADE_APROVADA',
            },
          ]}
          onSubmit={(v, cents, key) =>
            api('/api/v1/finance/labor', {
              method: 'POST',
              body: {
                professionalUserId: agree.userId,
                serviceOrderId,
                serviceOrderItemId: agree.itemId,
                service: v.service,
                agreedCents: cents('amount'),
                eligibility: v.eligibility,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {resolve && <ResolveReviewDialog review={resolve} onClose={() => setResolve(null)} />}
    </div>
  );
}

function PayableLine({ l, onOpen }: { l: LaborPayableDto; onOpen: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 text-sm" data-testid={`os-labor-${l.code}`}>
      <span className="font-mono font-semibold">{l.code}</span>
      <span>{l.professional.displayName}</span>
      <span className="tabular-nums">
        devido <strong>{money(l.dueCents)}</strong> · pago {money(l.paidCents)}
      </span>
      <SituationBadge l={l} />
      <span className="text-xs text-ink-muted">{ELIGIBILITY_LABEL[l.eligibility]}</span>
      <Button size="sm" variant="ghost" onClick={onOpen} className="ml-auto">
        Abrir
      </Button>
    </li>
  );
}

/**
 * Resolução explícita: o gestor informa quanto é devido a cada profissional. Quem já tem valor
 * precisa constar (nunca abaixo do já pago); nada é rateado automaticamente.
 */
export function ResolveReviewDialog({
  review,
  onClose,
}: {
  review: LaborReviewDto;
  onClose: () => void;
}) {
  const people = useFinPeople();
  const tapeceiros = (people.data ?? []).filter((p) => p.isTapeceiro);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      review.lines.map((l) => [
        l.professionalUserId,
        (l.dueCents / 100).toFixed(2).replace('.', ','),
      ]),
    ),
  );
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error, setError } = useFinSend(onClose);
  const before = review.lines.reduce((a, l) => a + l.dueCents, 0);
  const parsed = Object.entries(values)
    .filter(([, v]) => v.trim() !== '')
    .map(([id, v]) => ({ professionalUserId: id, amountCents: parseMoney(v) }));
  const after = parsed.reduce((a, l) => a + (l.amountCents ?? 0), 0);
  const submit = () => {
    if (parsed.some((l) => l.amountCents === null || l.amountCents < 0))
      return setError('Valores em reais, sem valores negativos.');
    if (reason.trim().length < 3) return setError('Informe a justificativa.');
    m.mutate({
      run: () =>
        api(`/api/v1/finance/labor-reviews/${review.id}/resolve`, {
          method: 'POST',
          body: { lines: parsed, reason, version: review.version },
          idempotencyKey: key,
        }),
      ok: 'Revisão resolvida.',
    });
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Resolver ${review.code}`}
      description="Defina o valor devido a cada profissional. Valores já pagos são preservados; quem já tinha valor precisa constar."
      footer={
        <Button loading={m.isPending} onClick={submit} data-testid="resolve-submit">
          Resolver revisão
        </Button>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="space-y-3">
        {tapeceiros.map((t) => {
          const line = review.lines.find((l) => l.professionalUserId === t.userId);
          return (
            <Field
              key={t.userId}
              label={`${t.displayName} — devido (R$)`}
              hint={
                line
                  ? `Antes: ${money(line.dueCents)} · já pago: ${money(line.paidCents)} (mínimo)`
                  : 'Deixe vazio se não houver valor para esta pessoa.'
              }
            >
              {(f) => (
                <Input
                  {...f}
                  inputMode="decimal"
                  placeholder="0,00"
                  value={values[t.userId] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [t.userId]: e.target.value }))}
                  data-testid={`resolve-amount-${t.displayName}`}
                />
              )}
            </Field>
          );
        })}
        <p className="text-sm" data-testid="resolve-totals">
          Total antes: <strong>{money(before)}</strong> · total depois:{' '}
          <strong>{money(after)}</strong>
          {after !== before && ' (diferença registrada como ajuste justificado)'}
        </p>
        <Field label="Justificativa" required>
          {(f) => (
            <Textarea
              {...f}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="resolve-reason"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
