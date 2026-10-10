'use client';

import {
  ALL_LOGISTICS_COST_KIND_LABEL,
  TRIP_COST_SITUATION_LABEL,
  type LogisticsCostDto,
  type TripCostSituation,
} from '@cenario/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { MoneyInput } from '@/components/commercial/money-input';
import { api } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { brDate, money, useLogisticsDefaults, useTripCost } from '@/lib/finance';
import { FormDialog } from './common';

/**
 * Evolução Fase 6 — custo da viagem (retirada/entrega). Valor TOTAL por viagem (nunca por
 * participante ou por OS), recebedor único configurado (André) e participantes só como
 * execução. Visível e editável apenas com permissão do financeiro.
 */

const TONE: Record<TripCostSituation, 'neutral' | 'brand' | 'ok' | 'warn' | 'info'> = {
  COMBINADO: 'info',
  PENDENTE_RECEBEDOR: 'warn',
  DEVIDO: 'brand',
  PAGO_PARCIAL: 'brand',
  PAGO: 'ok',
  CANCELADO: 'neutral',
  LANCADO: 'neutral',
};
export function TripSituation({ c }: { c: Pick<LogisticsCostDto, 'situation'> }) {
  return (
    <span data-testid="trip-situation">
      <Badge tone={TONE[c.situation]}>{TRIP_COST_SITUATION_LABEL[c.situation]}</Badge>
    </span>
  );
}

export type TripCostValue = { amountCents: number; participantUserIds: string[] } | undefined;

/** Campos do custo no agendamento (criação): valor total sugerido pelo padrão + participantes. */
export function TripCostFields({
  kind,
  onChange,
}: {
  kind: 'RETIRADA' | 'ENTREGA';
  onChange: (v: TripCostValue, valid: boolean) => void;
}) {
  const can = useCan();
  const allowed = can('financeiro.gerenciar');
  const d = useLogisticsDefaults(allowed);
  const suggested =
    kind === 'RETIRADA' ? d.data?.defaultPickupCostCents : d.data?.defaultDeliveryCostCents;
  const [on, setOn] = useState(true);
  const [cents, setCents] = useState<number | null>(null);
  const [valid, setValid] = useState(true);
  const [people, setPeople] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && d.data) {
      setCents(suggested ?? null);
      setPeople(d.data.payee ? [d.data.payee.userId] : []);
      setSeeded(true);
    }
  }, [d.data, seeded, suggested]);
  useEffect(() => {
    if (!allowed || !on) return onChange(undefined, true);
    onChange(
      cents && cents > 0 ? { amountCents: cents, participantUserIds: people } : undefined,
      valid && Boolean(cents && cents > 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, on, cents, people, valid]);
  if (!allowed) return null;
  if (d.isPending) return <Spinner />;
  return (
    <fieldset className="rounded-xl border border-line p-4" data-testid="trip-cost-fields">
      <legend className="px-1 text-sm font-semibold">Custo da viagem (financeiro)</legend>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Combinar o custo total agora
      </label>
      {on && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Custo total da viagem"
            required
            hint={
              suggested
                ? `Padrão: ${money(suggested)} — editável. Valor único da viagem, não por pessoa.`
                : 'Sem padrão configurado. Valor único da viagem, não por pessoa.'
            }
            error={!valid || !cents ? 'Informe um valor maior que zero.' : undefined}
          >
            {(p) => (
              <MoneyInput
                {...p}
                cents={cents}
                data-testid="trip-cost-amount"
                onCents={(v, ok) => {
                  setCents(v);
                  setValid(ok);
                }}
              />
            )}
          </Field>
          <div className="text-sm">
            <p className="font-medium">Participantes (execução)</p>
            {d.data?.people.map((p) => (
              <label key={p.userId} className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={people.includes(p.userId)}
                  onChange={(e) =>
                    setPeople((x) =>
                      e.target.checked ? [...x, p.userId] : x.filter((y) => y !== p.userId),
                    )
                  }
                  data-testid={`trip-participant-${p.displayName}`}
                />
                {p.displayName}
              </label>
            ))}
            <p className="mt-2 text-ink-muted" data-testid="trip-payee">
              {d.data?.payee
                ? `Recebedor financeiro: ${d.data.payee.displayName} (100%)${d.data.payee.active ? '' : ' — INATIVO'}`
                : 'Recebedor financeiro não configurado: a conta a pagar ficará pendente.'}
            </p>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-ink-muted">
        Agendar não gera pagamento: o valor só fica devido quando a viagem for realizada.
      </p>
    </fieldset>
  );
}

/** Cartão do custo na retirada/entrega (somente financeiro). */
export function TripCostCard({ pickupId, deliveryId }: { pickupId?: string; deliveryId?: string }) {
  const can = useCan();
  const visible = can('financeiro.ver');
  const q = useTripCost({ pickupId, deliveryId }, visible);
  const d = useLogisticsDefaults(visible);
  const [edit, setEdit] = useState(false);
  const [adjust, setAdjust] = useState<LogisticsCostDto | null>(null);
  const [fee, setFee] = useState(false);
  if (!visible) return null;
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const v = q.data;
  const c = v.cost;
  const manage = can('financeiro.gerenciar');
  const adjustOk = can('financeiro.ajustes');
  const frustrated = ['FRUSTRADA', 'COM_OCORRENCIA'].includes(v.trip.status);
  const ref = pickupId ? { pickupId } : { deliveryId };
  return (
    <section
      className="space-y-3 rounded-xl border border-line p-4 text-sm"
      data-testid="trip-cost-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-semibold">Custo da viagem</h3>
        {c && <TripSituation c={c} />}
      </div>
      {!c ? (
        <p className="text-ink-muted" data-testid="trip-cost-none">
          Sem custo combinado
          {v.suggestedCents ? ` (padrão ${money(v.suggestedCents)})` : ''}.
        </p>
      ) : (
        <>
          <p>
            Total combinado: <strong data-testid="trip-cost-total">{money(c.amountCents)}</strong>
            {c.adjustmentsCents ? ` · ajustes ${money(c.adjustmentsCents)}` : ''} · devido{' '}
            <strong>{money(c.dueCents)}</strong> · pago {money(c.paidCents)} · saldo{' '}
            {money(c.openCents)}
          </p>
          <p>
            Recebedor: {c.payee?.displayName ?? v.payee?.displayName ?? '—'} · Participantes:{' '}
            {c.participants.map((p) => p.displayName).join(', ') || '—'}
            {c.dueAt ? ` · devido desde ${brDate(c.dueAt)}` : ''}
          </p>
          {c.allocations.length > 0 ? (
            <p data-testid="trip-cost-allocations">
              Rateio: {c.allocations.map((a) => `${a.code} ${money(a.amountCents)}`).join(' · ')}
            </p>
          ) : (
            <p className="text-ink-muted">Rateio pendente (OS ainda não criada).</p>
          )}
          {c.pendingReason === 'RECEBEDOR_AUSENTE' && (
            <Alert tone="warn">
              Viagem realizada sem recebedor ativo: nenhuma conta a pagar foi criada. Configure o
              recebedor da logística e gere a conta.
            </Alert>
          )}
        </>
      )}
      {v.fees.map((f) => (
        <p key={f.id} data-testid={`trip-fee-${f.code}`}>
          {ALL_LOGISTICS_COST_KIND_LABEL[f.kind]}: {money(f.dueCents)} ({f.splitNote}) ·{' '}
          <TripSituation c={f} />
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {manage && (!c || c.status === 'PREVISTO') && v.trip.status !== 'CANCELADA' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEdit(true)}
            data-testid="trip-cost-edit"
          >
            {c ? 'Alterar custo' : 'Combinar custo'}
          </Button>
        )}
        {adjustOk && c && c.status === 'DEVIDO' && c.payable && (
          <Button size="sm" variant="secondary" onClick={() => setAdjust(c)}>
            Ajustar valor devido
          </Button>
        )}
        {manage && c?.pendingReason === 'RECEBEDOR_AUSENTE' && (
          <Button
            size="sm"
            onClick={() =>
              void api(`/api/v1/finance/logistics-costs/${c.id}/constitute`, {
                method: 'POST',
                body: {},
              }).then(() => q.refetch())
            }
          >
            Gerar conta a pagar
          </Button>
        )}
        {adjustOk && frustrated && (
          <Button size="sm" variant="ghost" onClick={() => setFee(true)} data-testid="trip-fee">
            Autorizar taxa de tentativa frustrada
          </Button>
        )}
      </div>
      {edit && (
        <FormDialog
          title={c ? 'Alterar custo da viagem' : 'Combinar custo da viagem'}
          description="Valor TOTAL da viagem (André e Izaías juntos = um valor só). Recebedor: o configurado. Nada é devido antes da realização."
          onClose={() => setEdit(false)}
          fields={[
            {
              name: 'amount',
              label: 'Custo total (R$)',
              type: 'money',
              required: true,
              initial: ((c?.amountCents ?? v.suggestedCents ?? 0) / 100 || '')
                .toString()
                .replace('.', ','),
            },
            ...(c
              ? [
                  {
                    name: 'reason',
                    label: 'Motivo da alteração',
                    type: 'textarea' as const,
                    required: true,
                  },
                ]
              : []),
          ]}
          onSubmit={(vals, cents, key) =>
            api('/api/v1/finance/trip-costs', {
              method: 'PUT',
              body: {
                ...ref,
                amountCents: cents('amount'),
                participantUserIds:
                  c?.participants.map((p) => p.userId) ??
                  (d.data?.payee ? [d.data.payee.userId] : []),
                ...(c ? { reason: vals.reason, version: c.version } : {}),
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {adjust && (
        <FormDialog
          title={`Ajustar valor devido — ${adjust.code}`}
          description="Use valor negativo para reduzir. Nunca abaixo do já pago (estorne antes, se preciso)."
          onClose={() => setAdjust(null)}
          fields={[
            { name: 'amount', label: 'Ajuste (R$)', type: 'money', required: true },
            { name: 'reason', label: 'Justificativa', type: 'textarea', required: true },
          ]}
          onSubmit={(vals, cents, key) =>
            api(`/api/v1/finance/logistics-costs/${adjust.id}/adjustments`, {
              method: 'POST',
              body: { amountCents: cents('amount'), reason: vals.reason, version: adjust.version },
              idempotencyKey: key,
            })
          }
        />
      )}
      {fee && (
        <FormDialog
          title="Taxa de tentativa frustrada"
          description="Cobrança excepcional autorizada pelo gestor. A viagem continua não realizada."
          onClose={() => setFee(false)}
          fields={[
            { name: 'amount', label: 'Valor da taxa (R$)', type: 'money', required: true },
            { name: 'reason', label: 'Justificativa', type: 'textarea', required: true },
          ]}
          onSubmit={(vals, cents, key) =>
            api('/api/v1/finance/trip-costs/fee', {
              method: 'POST',
              body: { ...ref, amountCents: cents('amount'), reason: vals.reason },
              idempotencyKey: key,
            })
          }
        />
      )}
    </section>
  );
}

/** Padrões de retirada/entrega e recebedor (aba de custos do financeiro). */
export function LogisticsDefaultsPanel() {
  const can = useCan();
  const d = useLogisticsDefaults();
  const [open, setOpen] = useState(false);
  if (d.isPending) return <Spinner />;
  if (d.isError) return <Alert tone="danger">{d.error.message}</Alert>;
  const x = d.data;
  return (
    <section className="rounded-xl border border-line p-4 text-sm" data-testid="logistics-defaults">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-semibold">Padrões da logística</h3>
        {can('financeiro.gerenciar') && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen(true)}
            data-testid="logistics-defaults-edit"
          >
            Configurar
          </Button>
        )}
      </div>
      <p className="mt-2">
        Retirada:{' '}
        <strong>{x.defaultPickupCostCents ? money(x.defaultPickupCostCents) : '—'}</strong> ·
        Entrega:{' '}
        <strong>{x.defaultDeliveryCostCents ? money(x.defaultDeliveryCostCents) : '—'}</strong> ·
        Recebedor:{' '}
        <strong>
          {x.payee
            ? `${x.payee.displayName}${x.payee.active ? '' : ' (inativo)'}`
            : 'não configurado'}
        </strong>
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Os padrões só sugerem o valor no agendamento; viagens já registradas não mudam.
      </p>
      {open && (
        <FormDialog
          title="Padrões da logística"
          onClose={() => setOpen(false)}
          fields={[
            {
              name: 'pickup',
              label: 'Padrão de retirada (R$)',
              type: 'money',
              initial: x.defaultPickupCostCents
                ? (x.defaultPickupCostCents / 100).toFixed(2).replace('.', ',')
                : '',
            },
            {
              name: 'delivery',
              label: 'Padrão de entrega (R$)',
              type: 'money',
              initial: x.defaultDeliveryCostCents
                ? (x.defaultDeliveryCostCents / 100).toFixed(2).replace('.', ',')
                : '',
            },
            {
              name: 'payee',
              label: 'Recebedor único da logística',
              type: 'select',
              initial: x.payee?.userId ?? '',
              options: [
                { value: '', label: 'Não configurado' },
                ...x.people.map((p) => ({ value: p.userId, label: p.displayName })),
              ],
            },
          ]}
          onSubmit={(vals, cents, key) =>
            api('/api/v1/finance/logistics-defaults', {
              method: 'PUT',
              body: {
                defaultPickupCostCents: vals.pickup ? cents('pickup') : null,
                defaultDeliveryCostCents: vals.delivery ? cents('delivery') : null,
                logisticsPayeeUserId: vals.payee || null,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
    </section>
  );
}
