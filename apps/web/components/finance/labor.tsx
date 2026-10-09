'use client';

import {
  ELIGIBILITY_LABEL,
  LABOR_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  type LaborPayableDto,
} from '@cenario/shared';
import type { ServiceOrderDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useServiceOrders } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import {
  brDate,
  localToday,
  money,
  useFinPeople,
  useLabor,
  useLaborOne,
  useTeamCosts,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Table } from './common';
import { History, statusTone } from './revenue';

/**
 * Mão de obra por produção (Ricardo, Márcio): valor combinado por peça ou OS, liberado só
 * quando a condição combinada é atingida. Equipe fixa (João, Thiago): custo mensal, sem
 * descontos automáticos e sem virar pagamento por produção.
 */
export function LaborTab() {
  const can = useCan();
  const [filter, setFilter] = useState('PREVISTO,LIBERADO,PAGO_PARCIAL');
  const q = useLabor(filter || undefined);
  const team = useTeamCosts();
  const people = useFinPeople();
  const [create, setCreate] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [teamCost, setTeamCost] = useState(false);
  const manage = can('financeiro.gerenciar');
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Pagamentos por produção</h2>
          {[
            ['PREVISTO,LIBERADO,PAGO_PARCIAL', 'Em aberto'],
            ['LIBERADO,PAGO_PARCIAL', 'Liberados'],
            ['PAGO', 'Pagos'],
            ['', 'Todos'],
          ].map(([k, l]) => (
            <Button
              key={l}
              size="sm"
              variant={filter === k ? 'primary' : 'secondary'}
              onClick={() => setFilter(k!)}
            >
              {l}
            </Button>
          ))}
          {manage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
              Combinar valor
            </Button>
          )}
        </div>
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <Alert tone="danger">{q.error.message}</Alert>
        ) : (
          <Table
            testId="fin-labor"
            head={[
              'Código',
              'Tapeceiro',
              'OS / peça',
              'Serviço',
              'Devido',
              'Pago',
              'Condição',
              'Situação',
              '',
            ]}
          >
            {q.data.map((l) => (
              <tr key={l.id} data-testid={`labor-${l.code}`}>
                <td className="px-4 py-2.5 font-mono font-semibold">{l.code}</td>
                <td className="px-4 py-2.5">{l.professional.displayName}</td>
                <td className="px-4 py-2.5">
                  {l.serviceOrder.code}
                  <p className="text-xs text-ink-muted">
                    {l.piece ? `${l.piece.code} ${l.piece.description}` : 'OS inteira'}
                  </p>
                </td>
                <td className="px-4 py-2.5">{l.service}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(l.dueCents)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(l.paidCents)}</td>
                <td className="px-4 py-2.5 text-xs">{ELIGIBILITY_LABEL[l.eligibility]}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={l.status === 'LIBERADO' ? 'brand' : statusTone(l.status)}>
                    {LABOR_STATUS_LABEL[l.status]}
                  </Badge>
                  {l.withdrawn && (
                    <Badge tone="warn" className="ml-1">
                      Revisar: peça devolvida/OS cancelada
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(l.id)}>
                    Abrir
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto text-lg font-semibold">Equipe de remuneração fixa</h2>
          {manage && (
            <Button
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() => setTeamCost(true)}
            >
              Registrar custo mensal
            </Button>
          )}
        </div>
        <p className="mb-3 text-sm text-ink-muted">
          Custo mensal da equipe fixa (salário e encargos informados pelo gestor). Não é pagamento
          por produção e não sofre descontos automáticos por atraso, ausência ou produtividade. A
          alocação por OS é uma estimativa proporcional ao tempo de execução registrado.
        </p>
        {team.data && (
          <Table testId="fin-team" head={['Mês', 'Funcionário', 'Custo mensal', 'Observação']}>
            {team.data.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2.5">{t.month.split('-').reverse().join('/')}</td>
                <td className="px-4 py-2.5">{t.user.displayName}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(t.amountCents)}</td>
                <td className="px-4 py-2.5 text-ink-muted">{t.notes ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {create && <CreateLabor onClose={() => setCreate(false)} />}
      {open && <LaborDialog id={open} onClose={() => setOpen(null)} />}
      {teamCost && (
        <FormDialog
          title="Custo mensal da equipe fixa"
          onClose={() => setTeamCost(false)}
          fields={[
            {
              name: 'userId',
              label: 'Funcionário',
              type: 'select',
              options: (people.data ?? [])
                .filter((p) => !p.isTapeceiro)
                .map((p) => ({ value: p.userId, label: p.displayName })),
            },
            {
              name: 'month',
              label: 'Mês',
              type: 'month',
              required: true,
              initial: localToday().slice(0, 7),
            },
            { name: 'amount', label: 'Custo (R$)', type: 'money', required: true },
            { name: 'notes', label: 'Observação', type: 'textarea' },
          ]}
          onSubmit={(v, cents) =>
            api('/api/v1/finance/team-costs', {
              method: 'PUT',
              body: {
                userId: v.userId,
                month: v.month,
                amountCents: cents('amount'),
                notes: v.notes || null,
              },
            })
          }
        />
      )}
    </div>
  );
}

function CreateLabor({ onClose }: { onClose: () => void }) {
  const people = useFinPeople();
  const sos = useServiceOrders({ status: 'ABERTA' });
  const [soId, setSoId] = useState('');
  const so = useQuery({
    queryKey: ['service-order', soId],
    queryFn: () => api<ServiceOrderDto>(`/api/v1/service-orders/${soId}`),
    enabled: Boolean(soId),
  });
  const tapeceiros = (people.data ?? []).filter((p) => p.isTapeceiro);
  return (
    <FormDialog
      key={soId}
      title="Combinar valor de produção"
      description="Cada peça tem um único tapeceiro principal; o valor nunca é dividido automaticamente. O pagamento só é liberado na condição escolhida."
      onClose={onClose}
      submitLabel="Combinar"
      fields={[
        {
          name: 'professional',
          label: 'Tapeceiro principal',
          type: 'select',
          options: tapeceiros.map((p) => ({ value: p.userId, label: p.displayName })),
        },
        {
          name: 'item',
          label: 'Peça',
          type: 'select',
          options: [
            { value: '', label: 'OS inteira' },
            ...(soId && so.data
              ? so.data.items.map((i) => ({ value: i.id, label: `${i.code} ${i.description}` }))
              : []),
          ],
        },
        { name: 'service', label: 'Serviço', required: true },
        { name: 'amount', label: 'Valor combinado (R$)', type: 'money', required: true },
        {
          name: 'eligibility',
          label: 'Liberar o pagamento quando',
          type: 'select',
          options: PAYMENT_OPTIONS(ELIGIBILITY_LABEL),
          initial: 'QUALIDADE_APROVADA',
        },
        { name: 'notes', label: 'Observações', type: 'textarea' },
      ]}
      onSubmit={(v, cents, key) =>
        api('/api/v1/finance/labor', {
          method: 'POST',
          body: {
            professionalUserId: v.professional,
            serviceOrderId: soId,
            serviceOrderItemId: v.item || null,
            service: v.service,
            agreedCents: cents('amount'),
            eligibility: v.eligibility,
            notes: v.notes || null,
          },
          idempotencyKey: key,
        })
      }
    >
      <Field label="Ordem de serviço" required className="mb-3">
        {(f) => (
          <Select
            {...f}
            value={soId}
            onChange={(e) => setSoId(e.target.value)}
            data-testid="labor-os"
          >
            <option value="">Escolha a OS…</option>
            {(sos.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.customer.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </FormDialog>
  );
}

function LaborDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const q = useLaborOne(id);
  const [pay, setPay] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [cancel, setCancel] = useState(false);
  const l: LaborPayableDto | undefined = q.data;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={l ? `${l.code} — ${l.professional.displayName}` : 'Produção'}
    >
      {!l ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            <p>
              Combinado: <strong>{money(l.agreedCents)}</strong>
            </p>
            <p>
              Ajustes: <strong>{money(l.adjustmentsCents)}</strong>
            </p>
            <p>
              Devido: <strong>{money(l.dueCents)}</strong>
            </p>
            <p>
              Pago: <strong data-testid="labor-paid">{money(l.paidCents)}</strong>
            </p>
            <p className="sm:col-span-2">
              {l.serviceOrder.code} ·{' '}
              {l.piece ? `${l.piece.code} ${l.piece.description}` : 'OS inteira'} · {l.service}
            </p>
          </div>
          <Alert tone={l.eligible ? 'ok' : 'info'}>
            Condição: {ELIGIBILITY_LABEL[l.eligibility]} —{' '}
            {l.eligible
              ? `atingida${l.eligibleAt ? ` em ${brDate(l.eligibleAt)}` : ''}`
              : 'ainda não atingida (valor previsto).'}
          </Alert>
          <div className="flex gap-2">
            {can('financeiro.gerenciar') &&
              (l.status === 'PREVISTO' ||
                l.status === 'LIBERADO' ||
                l.status === 'PAGO_PARCIAL') && (
                <Button size="sm" onClick={() => setPay(true)}>
                  Registrar pagamento
                </Button>
              )}
            {can('financeiro.ajustes') && l.status !== 'PAGO' && l.status !== 'CANCELADO' && (
              <Button size="sm" variant="secondary" onClick={() => setAdjust(true)}>
                Ajustar valor
              </Button>
            )}
            {can('financeiro.gerenciar') && l.paidCents === 0 && l.status !== 'CANCELADO' && (
              <Button size="sm" variant="ghost" onClick={() => setCancel(true)}>
                Cancelar
              </Button>
            )}
          </div>
          {l.adjustments.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Ajustes autorizados</h3>
              <ul className="space-y-1">
                {l.adjustments.map((a) => (
                  <li key={a.id}>
                    {money(a.amountCents)} — {a.reason} ({a.authorizedBy})
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="mb-1 font-semibold">Pagamentos registrados</h3>
            {l.payments.length ? (
              <ul className="space-y-1">
                {l.payments.map((p) => (
                  <li key={p.id}>
                    {brDate(p.paidAt)} · {money(p.amountCents)} · {PAYMENT_METHOD_LABEL[p.method]}
                    {p.early ? ' · antecipado' : ''}
                    {p.note ? ` · ${p.note}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">Nenhum pagamento registrado.</p>
            )}
          </div>
          <History items={l.history} />
        </div>
      )}
      {l && pay && (
        <FormDialog
          title={`Registrar pagamento — ${l.code}`}
          description={
            l.eligible
              ? 'Somente registro: o sistema não faz transferências.'
              : 'A condição combinada ainda não foi atingida: para antecipar, informe a justificativa.'
          }
          onClose={() => setPay(false)}
          fields={[
            {
              name: 'amount',
              label: 'Valor (R$)',
              type: 'money',
              required: true,
              initial: ((l.dueCents - l.paidCents) / 100).toFixed(2).replace('.', ','),
            },
            { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
            {
              name: 'method',
              label: 'Forma',
              type: 'select',
              options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
            },
            { name: 'note', label: 'Observação', type: 'textarea' },
            ...(l.eligible
              ? []
              : [
                  {
                    name: 'early',
                    label: 'Justificativa da antecipação',
                    type: 'textarea' as const,
                    required: true,
                  },
                ]),
          ]}
          onSubmit={(v, cents, key) =>
            api(`/api/v1/finance/labor/${l.id}/payments`, {
              method: 'POST',
              body: {
                amountCents: cents('amount'),
                paidAt: v.date,
                method: v.method,
                note: v.note || null,
                earlyReason: v.early || null,
                version: l.version,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {l && adjust && (
        <FormDialog
          title={`Ajustar valor — ${l.code}`}
          description="Use valor negativo para reduzir. Nunca abaixo do que já foi pago."
          onClose={() => setAdjust(false)}
          fields={[
            { name: 'amount', label: 'Ajuste (R$)', type: 'money', required: true },
            { name: 'reason', label: 'Justificativa', type: 'textarea', required: true },
          ]}
          onSubmit={(v, cents, key) =>
            api(`/api/v1/finance/labor/${l.id}/adjustments`, {
              method: 'POST',
              body: { amountCents: cents('amount'), reason: v.reason, version: l.version },
              idempotencyKey: key,
            })
          }
        />
      )}
      {l && cancel && (
        <FormDialog
          title={`Cancelar ${l.code}`}
          onClose={() => setCancel(false)}
          fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/labor/${l.id}/cancel`, {
              method: 'POST',
              body: { reason: v.reason, version: l.version },
              idempotencyKey: key,
            })
          }
        />
      )}
    </Dialog>
  );
}
