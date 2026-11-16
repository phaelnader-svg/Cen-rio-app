'use client';

import {
  ADJUSTMENT_KIND_LABEL,
  DUE_TRIGGER_LABEL,
  FINANCIAL_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  RECEIVABLE_STATUS_LABEL,
  isCard,
  type OrderRevenueDto,
  type PaymentReportDto,
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
  useFinOrder,
  useFinOrders,
  usePaymentReports,
  useReceivable,
  useReceivables,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Table, type FormField } from './common';

const statusTone = (s: string) =>
  s === 'RECEBIDO' || s === 'QUITADO' || s === 'PAGO'
    ? 'ok'
    : s === 'PARCIAL' || s === 'PAGO_PARCIAL'
      ? 'warn'
      : s === 'CANCELADO'
        ? 'neutral'
        : s === 'VENCIDO'
          ? 'danger'
          : 'info';

/** "Na entrega", "20/10/2026", "Na entrega (entregue 18/10)". */
export function dueText(r: ReceivableDto) {
  if (r.dueTrigger === 'DATA') return brDate(r.dueDate);
  return r.effectiveDueDate
    ? `${DUE_TRIGGER_LABEL[r.dueTrigger]} (${brDate(r.effectiveDueDate)})`
    : DUE_TRIGGER_LABEL[r.dueTrigger];
}

const methodText = (m: keyof typeof PAYMENT_METHOD_LABEL, installments: number | null) =>
  `${PAYMENT_METHOD_LABEL[m]}${installments ? ` ${installments}×` : ''}`;

const toReais = (c: number) => (c / 100).toFixed(2).replace('.', ',');

/** Campos de valor por peça (obrigatórios quando o pedido usa valores por peça). */
const itemFields = (o: OrderRevenueDto): FormField[] =>
  o.itemValuesUsed
    ? o.pieces.map((p) => ({
        name: `item:${p.orderItemId}`,
        label: `${p.position}. ${p.description} (R$)`,
        type: 'money' as const,
        required: true,
        initial: toReais(p.valueCents ?? 0),
        hint: 'Nova distribuição: a soma precisa ser igual ao novo valor final.',
      }))
    : [];
const itemValuesOf = (o: OrderRevenueDto, cents: (n: string) => number) =>
  o.itemValuesUsed
    ? o.pieces.map((p) => ({
        orderItemId: p.orderItemId,
        agreedValueCents: cents(`item:${p.orderItemId}`),
      }))
    : null;

/** Receita negociada (do pedido), ajustes autorizados e contas a receber com recebimentos. */
export function RevenueTab() {
  const [search, setSearch] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const orders = useFinOrders(search.trim(), onlyOpen);
  const receivables = useReceivables(onlyOverdue ? 'ABERTO,PARCIAL' : 'ABERTO,PARCIAL,RECEBIDO', {
    overdue: onlyOverdue,
  });
  const [dialog, setDialog] = useState<{
    kind: 'adjust' | 'charge' | 'refund';
    order: OrderRevenueDto;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <PaymentReports />
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
                    {o.serviceOrders
                      .map(
                        (s) =>
                          `${s.code}: ${money(s.revenueCents)}${s.estimated ? ' (estimada)' : ''}`,
                      )
                      .join(' · ')}
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
                  {o.returnedPieces > 0 && (
                    <p className="mt-1 text-xs text-warn-600" data-testid="fin-order-returned">
                      {o.returnedPieces} peça(s) devolvida(s): o valor negociado só muda com ajuste.
                    </p>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <OrderActions order={o} onAction={(kind) => setDialog({ kind, order: o })} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end gap-4">
          <h2 className="mr-auto text-lg font-semibold">Contas a receber</h2>
          <Checkbox
            label="Só vencidas (inadimplência)"
            checked={onlyOverdue}
            onChange={(e) => setOnlyOverdue(e.target.checked)}
          />
        </div>
        {receivables.isPending ? (
          <Spinner />
        ) : receivables.isError ? (
          <Alert tone="danger">{receivables.error.message}</Alert>
        ) : (
          <ReceivablesTable rows={receivables.data} onOpen={setOpen} showCustomer />
        )}
      </section>

      {dialog && <OrderDialogs dialog={dialog} onClose={() => setDialog(null)} />}
      {open && <ReceivableDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function OrderActions({
  order: o,
  onAction,
}: {
  order: OrderRevenueDto;
  onAction: (k: 'adjust' | 'charge' | 'refund') => void;
}) {
  const can = useCan();
  if (o.finalCents === null) return null;
  return (
    <>
      {can('financeiro.gerenciar') && (
        <Button size="sm" variant="secondary" onClick={() => onAction('charge')}>
          Lançar cobrança
        </Button>
      )}
      {can('financeiro.ajustes') && (
        <Button size="sm" variant="ghost" onClick={() => onAction('adjust')}>
          Ajuste
        </Button>
      )}
      {can('financeiro.gerenciar') && o.receivedCents > 0 && (
        <Button size="sm" variant="ghost" onClick={() => onAction('refund')}>
          Reembolso
        </Button>
      )}
    </>
  );
}

function ReceivablesTable({
  rows,
  onOpen,
  showCustomer,
}: {
  rows: ReceivableDto[];
  onOpen: (id: string) => void;
  showCustomer?: boolean;
}) {
  return (
    <Table
      testId="fin-receivables"
      head={[
        'Código',
        ...(showCustomer ? ['Cliente / pedido'] : []),
        'Descrição',
        'Valor',
        'Recebido',
        'Saldo',
        'Vencimento',
        'Forma',
        'Situação',
        '',
      ]}
    >
      {rows.map((r) => (
        <tr key={r.id} data-testid={`receivable-${r.code}`}>
          <td className="px-4 py-2.5 font-mono font-semibold">{r.code}</td>
          {showCustomer && (
            <td className="px-4 py-2.5">
              {r.customer.name}
              <p className="text-xs text-ink-muted">
                {r.order.code}
                {r.serviceOrder ? ` · ${r.serviceOrder.code}` : ''}
              </p>
            </td>
          )}
          <td className="px-4 py-2.5">{r.description}</td>
          <td className="px-4 py-2.5 tabular-nums">{money(r.amountCents)}</td>
          <td className="px-4 py-2.5 tabular-nums">{money(r.receivedCents)}</td>
          <td className="px-4 py-2.5 tabular-nums">{money(r.openCents)}</td>
          <td className={`px-4 py-2.5 ${r.overdue ? 'font-semibold text-danger-600' : ''}`}>
            {dueText(r)}
            {r.overdue && (
              <p className="text-xs" data-testid={`overdue-${r.code}`}>
                {r.daysOverdue ? `${r.daysOverdue} dia(s) em atraso` : 'Vencida'}
              </p>
            )}
          </td>
          <td className="px-4 py-2.5">{methodText(r.expectedMethod, r.installments)}</td>
          <td className="px-4 py-2.5">
            <Badge tone={statusTone(r.status)}>{RECEIVABLE_STATUS_LABEL[r.status]}</Badge>
            {r.reports.some((x) => x.status === 'PENDENTE') && (
              <p className="mt-1 text-xs text-warn-600">Pagamento informado pela equipe</p>
            )}
          </td>
          <td className="px-4 py-2.5 text-right">
            <Button size="sm" variant="secondary" onClick={() => onOpen(r.id)}>
              Abrir
            </Button>
          </td>
        </tr>
      ))}
    </Table>
  );
}

function OrderDialogs({
  dialog: { kind, order },
  onClose,
}: {
  dialog: { kind: 'adjust' | 'charge' | 'refund'; order: OrderRevenueDto };
  onClose: () => void;
}) {
  if (kind === 'adjust')
    return (
      <FormDialog
        title={`Ajuste comercial — ${order.orderCode}`}
        description={`Valor final atual: ${money(order.finalCents)}. Desconto e acréscimo exigem justificativa e ficam no histórico.${order.itemValuesUsed ? ' O pedido tem valor por peça: informe a nova distribuição.' : ''}`}
        onClose={onClose}
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
          ...itemFields(order),
        ]}
        onSubmit={(v, cents, key) =>
          api(`/api/v1/finance/orders/${order.orderId}/adjustments`, {
            method: 'POST',
            body: {
              kind: v.kind,
              amountCents: cents('amount'),
              reason: v.reason,
              itemValues: itemValuesOf(order, cents),
            },
            idempotencyKey: key,
          })
        }
      />
    );
  if (kind === 'refund')
    return (
      <FormDialog
        title={`Reembolso — ${order.orderCode}`}
        description={`Dinheiro que entrou e foi devolvido ao cliente (não é estorno). Recebido líquido: ${money(order.receivedCents)}. O valor final é reduzido na mesma operação.`}
        onClose={onClose}
        submitLabel="Registrar reembolso"
        okMessage="Reembolso registrado."
        fields={[
          { name: 'amount', label: 'Valor devolvido (R$)', type: 'money', required: true },
          { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
          {
            name: 'method',
            label: 'Forma',
            type: 'select',
            options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
          },
          { name: 'reason', label: 'Motivo', type: 'textarea', required: true },
          ...itemFields(order),
        ]}
        onSubmit={(v, cents, key) =>
          api(`/api/v1/finance/orders/${order.orderId}/refunds`, {
            method: 'POST',
            body: {
              amountCents: cents('amount'),
              refundedAt: v.date,
              method: v.method,
              reason: v.reason,
              itemValues: itemValuesOf(order, cents),
            },
            idempotencyKey: key,
          })
        }
      />
    );
  return (
    <FormDialog
      title={`Lançar cobrança — ${order.orderCode}`}
      description={`Valor final ${money(order.finalCents)}; já lançado ${money(order.billedCents)}. A soma das cobranças não passa do valor final.`}
      onClose={onClose}
      submitLabel="Lançar"
      fields={[
        { name: 'description', label: 'Descrição', required: true, initial: 'Parcela' },
        {
          name: 'amount',
          label: 'Valor (R$)',
          type: 'money',
          required: true,
          initial: toReais(order.toBillCents),
        },
        {
          name: 'trigger',
          label: 'Vence',
          type: 'select',
          options: PAYMENT_OPTIONS(DUE_TRIGGER_LABEL),
        },
        {
          name: 'dueDate',
          label: 'Vencimento (na data)',
          type: 'date',
          initial: localToday(),
          hint: 'Na retirada/entrega: vence na conclusão real do evento.',
        },
        {
          name: 'method',
          label: 'Forma prevista',
          type: 'select',
          options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
        },
        {
          name: 'installments',
          label: 'Parcelas (cartão)',
          type: 'number',
          hint: 'De 1 a 12. Uma cobrança só.',
        },
        {
          name: 'serviceOrderId',
          label: 'OS (opcional)',
          type: 'select',
          options: [
            { value: '', label: 'Pedido inteiro' },
            ...order.serviceOrders.map((s) => ({ value: s.id, label: s.code })),
          ],
        },
        { name: 'notes', label: 'Observações', type: 'textarea' },
      ]}
      onSubmit={(v, cents, key) =>
        api('/api/v1/finance/receivables', {
          method: 'POST',
          body: {
            orderId: order.orderId,
            serviceOrderId: v.serviceOrderId || null,
            description: v.description,
            amountCents: cents('amount'),
            dueTrigger: v.trigger,
            dueDate: v.trigger === 'DATA' ? v.dueDate : null,
            expectedMethod: v.method,
            installments: isCard(v.method ?? '') && v.installments ? Number(v.installments) : null,
            notes: v.notes || null,
          },
          idempotencyKey: key,
        })
      }
    />
  );
}

/**
 * Pedido → Financeiro: valor fechado, recebido, saldo, vencido, condição, valores por peça,
 * cobranças e pagamentos, com as ações conforme a permissão.
 */
export function OrderFinance({ orderId }: { orderId: string }) {
  const q = useFinOrder(orderId);
  const receivables = useReceivables(undefined, { orderId });
  const [dialog, setDialog] = useState<'adjust' | 'charge' | 'refund' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const o = q.data;
  return (
    <div className="space-y-4" data-testid="order-finance">
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label="Valor fechado" value={money(o.finalCents)} testId="order-fin-final" />
        <Kpi label="Recebido" value={money(o.receivedCents)} testId="order-fin-received" />
        <Kpi label="Saldo" value={money(o.openCents)} testId="order-fin-open" />
        <Kpi
          label="Vencido"
          value={money(o.overdueCents)}
          testId="order-fin-overdue"
          danger={o.overdueCents > 0}
        />
      </div>
      <p className="text-sm">
        <Badge tone={statusTone(o.financialStatus)}>
          {FINANCIAL_STATUS_LABEL[o.financialStatus]}
        </Badge>
        {o.paymentTerms ? (
          <span className="ml-2 text-ink-muted">Condição: {o.paymentTerms}</span>
        ) : null}
        {o.toBillCents > 0 && o.finalCents !== null && (
          <span className="ml-2 text-warn-600">A lançar em cobranças: {money(o.toBillCents)}</span>
        )}
      </p>
      {o.itemValuesUsed ? (
        <ul className="text-sm text-ink-soft" data-testid="order-fin-pieces">
          {o.pieces.map((p) => (
            <li key={p.orderItemId}>
              {p.position}. {p.description}: {money(p.valueCents)}
              {p.pendingCents > 0 ? ` · ${money(p.pendingCents)} sem OS (aguardando chegada)` : ''}
            </li>
          ))}
        </ul>
      ) : (
        o.finalCents !== null &&
        o.serviceOrders.length > 0 && (
          <p className="text-xs text-ink-muted" data-testid="order-fin-estimated">
            Sem valor por peça: o Resultado de cada OS usa distribuição estimada (proporcional às
            peças).
          </p>
        )
      )}
      <div className="flex flex-wrap gap-2">
        <OrderActions order={o} onAction={setDialog} />
      </div>
      {receivables.isPending ? (
        <Spinner />
      ) : receivables.isError ? (
        <Alert tone="danger">{receivables.error.message}</Alert>
      ) : receivables.data.length ? (
        <ReceivablesTable rows={receivables.data} onOpen={setOpen} />
      ) : (
        <p className="text-sm text-ink-muted">Nenhuma cobrança lançada.</p>
      )}
      {dialog && (
        <OrderDialogs dialog={{ kind: dialog, order: o }} onClose={() => setDialog(null)} />
      )}
      {open && <ReceivableDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Kpi({
  label,
  value,
  testId,
  danger,
}: {
  label: string;
  value: string;
  testId: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className={`text-lg font-semibold tabular-nums ${danger ? 'text-danger-600' : ''}`}
        data-testid={testId}
      >
        {value}
      </p>
    </div>
  );
}

/** Pagamentos informados pela equipe (retirada/entrega) aguardando o escritório. */
function PaymentReports() {
  const can = useCan();
  const q = usePaymentReports(can('financeiro.ver'));
  const [confirm, setConfirm] = useState<PaymentReportDto | null>(null);
  const [discard, setDiscard] = useState<PaymentReportDto | null>(null);
  if (!q.data?.length) return null;
  return (
    <section data-testid="payment-reports">
      <h2 className="mb-3 text-lg font-semibold">Pagamento informado pela equipe — confirmar</h2>
      <ReportList
        rows={q.data}
        onConfirm={can('financeiro.gerenciar') ? setConfirm : undefined}
        onDiscard={can('financeiro.gerenciar') ? setDiscard : undefined}
      />
      {confirm && <ConfirmReport report={confirm} onClose={() => setConfirm(null)} />}
      {discard && <DiscardReport report={discard} onClose={() => setDiscard(null)} />}
    </section>
  );
}

function ReportList({
  rows,
  onConfirm,
  onDiscard,
}: {
  rows: PaymentReportDto[];
  onConfirm?: (r: PaymentReportDto) => void;
  onDiscard?: (r: PaymentReportDto) => void;
}) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line text-sm">
      {rows.map((p) => (
        <li
          key={p.id}
          className="flex flex-wrap items-center gap-3 px-3 py-2"
          data-testid={`payment-report-${p.id}`}
          data-focus-id={p.id}
        >
          <span className="font-mono font-semibold">{p.order.code}</span>
          <span>{p.customerName}</span>
          <span className="flex-1 text-ink-muted">
            {p.stop.code} · {p.collected ? 'pagamento informado' : 'NÃO houve pagamento'}
            {p.method ? ` · ${PAYMENT_METHOD_LABEL[p.method]}` : ''} · {p.reportedBy}{' '}
            {formatDateTime(p.reportedAt)}
            {p.note ? ` · ${p.note}` : ''}
            {p.status !== 'PENDENTE' ? ` · ${p.status.toLowerCase()}` : ''}
          </span>
          {p.status === 'PENDENTE' && onConfirm && p.collected && (
            <Button size="sm" onClick={() => onConfirm(p)}>
              Confirmar
            </Button>
          )}
          {p.status === 'PENDENTE' && onDiscard && (
            <Button size="sm" variant="ghost" onClick={() => onDiscard(p)}>
              Descartar
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConfirmReport({ report: p, onClose }: { report: PaymentReportDto; onClose: () => void }) {
  return (
    <FormDialog
      title={`Confirmar pagamento — ${p.order.code}`}
      description={`Informado por ${p.reportedBy} (${p.stop.code}). Ao confirmar, o recebimento é registrado em ${p.receivable.code}.`}
      onClose={onClose}
      submitLabel="Confirmar baixa"
      okMessage="Pagamento confirmado."
      fields={[
        {
          name: 'amount',
          label: 'Valor recebido (R$)',
          type: 'money',
          required: true,
          initial: toReais(p.receivable.openCents),
        },
        { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
        {
          name: 'method',
          label: 'Forma',
          type: 'select',
          options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
          initial: p.method ?? p.expectedMethod,
        },
        {
          name: 'installments',
          label: 'Parcelas (cartão)',
          type: 'number',
          initial: p.installments ? String(p.installments) : '',
        },
        { name: 'note', label: 'Observação', type: 'textarea' },
      ]}
      onSubmit={(v, cents, key) =>
        api(`/api/v1/finance/payment-reports/${p.id}/confirm`, {
          method: 'POST',
          body: {
            amountCents: cents('amount'),
            receivedAt: v.date,
            method: v.method,
            installments: isCard(v.method ?? '') && v.installments ? Number(v.installments) : null,
            note: v.note || null,
            version: p.version,
          },
          idempotencyKey: key,
        })
      }
    />
  );
}

function DiscardReport({ report: p, onClose }: { report: PaymentReportDto; onClose: () => void }) {
  return (
    <FormDialog
      title="Descartar pagamento informado"
      description="O registro da equipe fica no histórico; nenhum recebimento é criado."
      onClose={onClose}
      submitLabel="Descartar"
      fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
      onSubmit={(v, _c, key) =>
        api(`/api/v1/finance/payment-reports/${p.id}/discard`, {
          method: 'POST',
          body: { reason: v.reason, version: p.version },
          idempotencyKey: key,
        })
      }
    />
  );
}

function ReceivableDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const q = useReceivable(id);
  const [receive, setReceive] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [reverse, setReverse] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PaymentReportDto | null>(null);
  const [discard, setDiscard] = useState<PaymentReportDto | null>(null);
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
            <p>
              Vencimento: {dueText(r)}
              {r.overdue ? ` · ${r.daysOverdue} dia(s) em atraso` : ''}
            </p>
            <p>Forma prevista: {methodText(r.expectedMethod, r.installments)}</p>
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
          {r.reports.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Informado pela equipe</h3>
              <ReportList
                rows={r.reports}
                onConfirm={can('financeiro.gerenciar') ? setConfirm : undefined}
                onDiscard={can('financeiro.gerenciar') ? setDiscard : undefined}
              />
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
                      {methodText(p.method, p.installments)}
                      {p.refund ? ' · reembolso' : ''}
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
              initial: toReais(r.openCents),
            },
            { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
            {
              name: 'method',
              label: 'Forma',
              type: 'select',
              options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
              initial: r.expectedMethod,
            },
            {
              name: 'installments',
              label: 'Parcelas (cartão)',
              type: 'number',
              initial: r.installments ? String(r.installments) : '',
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
                installments:
                  isCard(v.method ?? '') && v.installments ? Number(v.installments) : null,
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
          description="Estorno corrige um lançamento que não deveria existir (o original fica no histórico). Dinheiro devolvido ao cliente é reembolso."
          onClose={() => setReverse(null)}
          fields={[
            { name: 'reason', label: 'Motivo do estorno', type: 'textarea', required: true },
          ]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/receivables/${r.id}/payments/${reverse}/reverse`, {
              method: 'POST',
              body: { reason: v.reason, version: r.version },
              idempotencyKey: key,
            })
          }
        />
      )}
      {confirm && <ConfirmReport report={confirm} onClose={() => setConfirm(null)} />}
      {discard && <DiscardReport report={discard} onClose={() => setDiscard(null)} />}
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
