'use client';

import {
  ADJUSTMENT_KIND_LABEL,
  FINANCIAL_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  RECEIVABLE_STATUS_LABEL,
  type OrderRevenueDto,
  type ReceivableDto,
} from '@cenario/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import {
  brDate,
  localToday,
  money,
  useFinOrders,
  useReceivable,
  useReceivables,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Table } from './common';

const statusTone = (s: string) =>
  s === 'RECEBIDO' || s === 'QUITADO' || s === 'PAGO'
    ? 'ok'
    : s === 'PARCIAL' || s === 'PAGO_PARCIAL'
      ? 'warn'
      : s === 'CANCELADO'
        ? 'neutral'
        : 'info';

/** Receita negociada (do pedido), ajustes autorizados e contas a receber com recebimentos. */
export function RevenueTab() {
  const can = useCan();
  const [search, setSearch] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const orders = useFinOrders(search.trim(), onlyOpen);
  const receivables = useReceivables('ABERTO,PARCIAL,RECEBIDO');
  const [adjust, setAdjust] = useState<OrderRevenueDto | null>(null);
  const [charge, setCharge] = useState<OrderRevenueDto | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-end gap-4">
          <h2 className="mr-auto text-lg font-semibold">Receita por pedido</h2>
          <Field label="Cliente" className="w-64">
            {(f) => <Input {...f} value={search} onChange={(e) => setSearch(e.target.value)} />}
          </Field>
          <Checkbox
            label="Só com saldo em aberto"
            checked={onlyOpen}
            onChange={(e) => setOnlyOpen(e.target.checked)}
          />
        </div>
        {orders.isPending ? (
          <Spinner />
        ) : orders.isError ? (
          <Alert tone="danger">{orders.error.message}</Alert>
        ) : (
          <Table
            testId="fin-orders"
            head={[
              'Pedido',
              'Cliente',
              'Contratado',
              'Ajustes',
              'Valor final',
              'Lançado',
              'Recebido',
              'Situação',
              '',
            ]}
          >
            {orders.data.map((o) => (
              <tr key={o.orderId} data-testid={`fin-order-${o.orderCode}`}>
                <td className="px-4 py-2.5 font-mono font-semibold">{o.orderCode}</td>
                <td className="px-4 py-2.5">
                  {o.customer.name}
                  <p className="text-xs text-ink-muted">
                    {o.serviceOrders.map((s) => `${s.code}: ${money(s.revenueCents)}`).join(' · ')}
                  </p>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{money(o.contractedCents)}</td>
                <td className="px-4 py-2.5 tabular-nums">
                  {o.adjustmentsCents ? money(o.adjustmentsCents) : '—'}
                </td>
                <td className="px-4 py-2.5 font-semibold tabular-nums">{money(o.finalCents)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(o.billedCents)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(o.receivedCents)}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone(o.financialStatus)}>
                    {FINANCIAL_STATUS_LABEL[o.financialStatus]}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {can('financeiro.gerenciar') && o.finalCents !== null && (
                    <Button size="sm" variant="secondary" onClick={() => setCharge(o)}>
                      Lançar cobrança
                    </Button>
                  )}
                  {can('financeiro.ajustes') && o.finalCents !== null && (
                    <Button size="sm" variant="ghost" onClick={() => setAdjust(o)}>
                      Ajuste
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Contas a receber</h2>
        {receivables.isPending ? (
          <Spinner />
        ) : receivables.isError ? (
          <Alert tone="danger">{receivables.error.message}</Alert>
        ) : (
          <Table
            testId="fin-receivables"
            head={[
              'Código',
              'Cliente / pedido',
              'Descrição',
              'Valor',
              'Recebido',
              'Vencimento',
              'Situação',
              '',
            ]}
          >
            {receivables.data.map((r) => (
              <tr key={r.id} data-testid={`receivable-${r.code}`}>
                <td className="px-4 py-2.5 font-mono font-semibold">{r.code}</td>
                <td className="px-4 py-2.5">
                  {r.customer.name}
                  <p className="text-xs text-ink-muted">
                    {r.order.code}
                    {r.serviceOrder ? ` · ${r.serviceOrder.code}` : ''}
                  </p>
                </td>
                <td className="px-4 py-2.5">{r.description}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(r.amountCents)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(r.receivedCents)}</td>
                <td className={`px-4 py-2.5 ${r.overdue ? 'font-semibold text-danger-600' : ''}`}>
                  {brDate(r.dueDate)}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone(r.status)}>{RECEIVABLE_STATUS_LABEL[r.status]}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(r.id)}>
                    Abrir
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {adjust && (
        <FormDialog
          title={`Ajuste comercial — ${adjust.orderCode}`}
          description={`Valor final atual: ${money(adjust.finalCents)}. Desconto e acréscimo exigem justificativa e ficam no histórico.`}
          onClose={() => setAdjust(null)}
          submitLabel="Aplicar ajuste"
          fields={[
            {
              name: 'kind',
              label: 'Tipo',
              type: 'select',
              options: PAYMENT_OPTIONS(ADJUSTMENT_KIND_LABEL),
            },
            {
              name: 'amount',
              label: 'Valor (R$)',
              type: 'money',
              required: true,
              hint: 'Ajuste: use "-" para reduzir.',
            },
            { name: 'reason', label: 'Justificativa', type: 'textarea', required: true },
          ]}
          onSubmit={(v, cents, key) =>
            api(`/api/v1/finance/orders/${adjust.orderId}/adjustments`, {
              method: 'POST',
              body: { kind: v.kind, amountCents: cents('amount'), reason: v.reason },
              idempotencyKey: key,
            })
          }
        />
      )}
      {charge && (
        <FormDialog
          title={`Lançar cobrança — ${charge.orderCode}`}
          description={`Valor final ${money(charge.finalCents)}; já lançado ${money(charge.billedCents)}. A soma das cobranças não passa do valor final.`}
          onClose={() => setCharge(null)}
          submitLabel="Lançar"
          fields={[
            { name: 'description', label: 'Descrição', required: true, initial: 'Parcela' },
            {
              name: 'amount',
              label: 'Valor (R$)',
              type: 'money',
              required: true,
              initial: (((charge.finalCents ?? 0) - charge.billedCents) / 100)
                .toFixed(2)
                .replace('.', ','),
            },
            {
              name: 'dueDate',
              label: 'Vencimento',
              type: 'date',
              required: true,
              initial: localToday(),
            },
            {
              name: 'method',
              label: 'Forma prevista',
              type: 'select',
              options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
            },
            {
              name: 'serviceOrderId',
              label: 'OS (opcional)',
              type: 'select',
              options: [
                { value: '', label: 'Pedido inteiro' },
                ...charge.serviceOrders.map((s) => ({ value: s.id, label: s.code })),
              ],
            },
            { name: 'notes', label: 'Observações', type: 'textarea' },
          ]}
          onSubmit={(v, cents, key) =>
            api('/api/v1/finance/receivables', {
              method: 'POST',
              body: {
                orderId: charge.orderId,
                serviceOrderId: v.serviceOrderId || null,
                description: v.description,
                amountCents: cents('amount'),
                dueDate: v.dueDate,
                expectedMethod: v.method,
                notes: v.notes || null,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {open && <ReceivableDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ReceivableDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const q = useReceivable(id);
  const [receive, setReceive] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [reverse, setReverse] = useState<string | null>(null);
  const r: ReceivableDto | undefined = q.data;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={r ? `${r.code} — ${r.customer.name}` : 'Conta a receber'}
    >
      {!r ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            <p>
              Valor: <strong>{money(r.amountCents)}</strong>
            </p>
            <p>
              Recebido: <strong data-testid="receivable-received">{money(r.receivedCents)}</strong>
            </p>
            <p>
              Em aberto: <strong>{money(r.openCents)}</strong>
            </p>
            <p>Vencimento: {brDate(r.dueDate)}</p>
            <p>Forma prevista: {PAYMENT_METHOD_LABEL[r.expectedMethod]}</p>
            <p>
              <Badge tone={statusTone(r.status)}>{RECEIVABLE_STATUS_LABEL[r.status]}</Badge>
            </p>
          </div>
          {can('financeiro.gerenciar') && (
            <div className="flex gap-2">
              {(r.status === 'ABERTO' || r.status === 'PARCIAL') && (
                <Button size="sm" onClick={() => setReceive(true)}>
                  Registrar recebimento
                </Button>
              )}
              {r.status === 'ABERTO' && (
                <Button size="sm" variant="ghost" onClick={() => setCancel(true)}>
                  Cancelar
                </Button>
              )}
            </div>
          )}
          <div>
            <h3 className="mb-1 font-semibold">Recebimentos</h3>
            {r.payments.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {r.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <span className="w-24">{brDate(p.receivedAt)}</span>
                    <span className="w-28 font-semibold tabular-nums">{money(p.amountCents)}</span>
                    <span className="flex-1 text-ink-muted">
                      {PAYMENT_METHOD_LABEL[p.method]}
                      {p.note ? ` · ${p.note}` : ''}
                      {p.reversed ? ' · estornado' : ''}
                    </span>
                    {can('financeiro.gerenciar') && p.amountCents > 0 && !p.reversed && (
                      <Button size="sm" variant="ghost" onClick={() => setReverse(p.id)}>
                        Estornar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">Nenhum recebimento registrado.</p>
            )}
          </div>
          <History items={r.history} />
        </div>
      )}
      {r && receive && (
        <FormDialog
          title={`Registrar recebimento — ${r.code}`}
          description="Somente registro: nenhuma cobrança é feita pelo sistema."
          onClose={() => setReceive(false)}
          fields={[
            {
              name: 'amount',
              label: 'Valor recebido (R$)',
              type: 'money',
              required: true,
              initial: (r.openCents / 100).toFixed(2).replace('.', ','),
            },
            { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
            {
              name: 'method',
              label: 'Forma',
              type: 'select',
              options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
              initial: r.expectedMethod,
            },
            { name: 'note', label: 'Observação', type: 'textarea' },
          ]}
          onSubmit={(v, cents, key) =>
            api(`/api/v1/finance/receivables/${r.id}/payments`, {
              method: 'POST',
              body: {
                amountCents: cents('amount'),
                receivedAt: v.date,
                method: v.method,
                note: v.note || null,
                version: r.version,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {r && cancel && (
        <FormDialog
          title={`Cancelar ${r.code}`}
          onClose={() => setCancel(false)}
          fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/receivables/${r.id}/cancel`, {
              method: 'POST',
              body: { reason: v.reason, version: r.version },
              idempotencyKey: key,
            })
          }
        />
      )}
      {r && reverse && (
        <FormDialog
          title="Estornar recebimento"
          description="O recebimento original continua no histórico; o estorno entra como valor negativo."
          onClose={() => setReverse(null)}
          fields={[
            { name: 'reason', label: 'Motivo do estorno', type: 'textarea', required: true },
          ]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/receivables/${r.id}/payments/${reverse}/reverse`, {
              method: 'POST',
              body: { reason: v.reason },
              idempotencyKey: key,
            })
          }
        />
      )}
    </Dialog>
  );
}

export function History({
  items,
}: {
  items: {
    id: string;
    kind: string;
    note: string | null;
    actor: string | null;
    createdAt: string;
  }[];
}) {
  return (
    <div>
      <h3 className="mb-1 font-semibold">Histórico</h3>
      <ul className="space-y-1 text-xs text-ink-muted">
        {items.map((h) => (
          <li key={h.id}>
            {formatDateTime(h.createdAt)} · {h.kind.replaceAll('_', ' ').toLowerCase()}
            {h.note ? ` — ${h.note}` : ''}
            {h.actor ? ` (${h.actor})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export { statusTone };
