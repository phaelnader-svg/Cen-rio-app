'use client';

import {
  CASH_SOURCE_LABEL,
  MANUAL_REVENUE_CATEGORIES,
  PAYMENT_METHOD_LABEL,
  payableCategoryLabel,
  type CashLedgerDto,
  type CashLineDto,
  type PaymentMethod,
} from '@cenario/shared';
import clsx from 'clsx';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import {
  brDate,
  localToday,
  money,
  useCashLedger,
  useExpenseCategories,
  type Period,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Table } from './common';
import { NEW_CATEGORY_LABEL, categoryOptions, chosenCategory } from './payables';

/**
 * 2026-11-18: Despesas (tudo que foi pago) e Receitas (tudo que entrou), numa lista por período.
 * Nada é digitado duas vezes: as linhas vêm de A pagar, Mão de obra, A receber e dos lançamentos
 * avulsos feitos aqui.
 */
export function CashLedgerTab({ kind, period }: { kind: 'in' | 'out'; period: Period }) {
  const can = useCan();
  const q = useCashLedger(kind, period);
  const [create, setCreate] = useState(false);
  const [cancel, setCancel] = useState<CashLineDto | null>(null);
  const [filter, setFilter] = useState<CashLineDto['source'] | null>(null);
  const isIn = kind === 'in';
  const word = isIn ? 'receita' : 'despesa';
  return (
    <div className="space-y-4" data-testid={isIn ? 'fin-cash-in' : 'fin-cash-out'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          {isIn
            ? 'Tudo o que entrou no período: pagamentos dos clientes e receitas avulsas. Estornos e reembolsos aparecem em negativo.'
            : 'Tudo o que foi pago no período, de qualquer forma: contas, gastos fixos, logística, mão de obra e despesas avulsas.'}
        </p>
        {can('financeiro.gerenciar') && (
          <Button
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setCreate(true)}
            data-testid={isIn ? 'cash-in-new' : 'cash-out-new'}
          >
            Incluir {word}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <Ledger
          data={q.data}
          isIn={isIn}
          filter={filter}
          onFilter={setFilter}
          onCancel={can('financeiro.gerenciar') ? setCancel : undefined}
        />
      )}
      {create &&
        (isIn ? (
          <NewRevenue onClose={() => setCreate(false)} />
        ) : (
          <NewExpense onClose={() => setCreate(false)} />
        ))}
      {cancel && (
        <FormDialog
          title="Cancelar receita avulsa"
          description={`${cancel.description} — ${money(cancel.amountCents)}`}
          submitLabel="Cancelar receita"
          onClose={() => setCancel(null)}
          okMessage="Receita cancelada."
          fields={[{ name: 'reason', label: 'Motivo', required: true }]}
          onSubmit={(v) =>
            api(`/api/v1/finance/cash-in/${cancel.id}/cancel`, {
              method: 'POST',
              body: { reason: v.reason },
            })
          }
        />
      )}
    </div>
  );
}

function Ledger({
  data,
  isIn,
  filter,
  onFilter,
  onCancel,
}: {
  data: CashLedgerDto;
  isIn: boolean;
  filter: CashLineDto['source'] | null;
  onFilter: (s: CashLineDto['source'] | null) => void;
  onCancel?: (l: CashLineDto) => void;
}) {
  const lines = filter ? data.lines.filter((l) => l.source === filter) : data.lines;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => onFilter(null)}
          className={clsx(
            'card p-4 text-left transition hover:bg-subtle',
            !filter && 'ring-2 ring-brand-500',
          )}
        >
          <p className="text-sm font-medium text-ink-muted">
            {isIn ? 'Total recebido' : 'Total pago'}
          </p>
          <p
            className={clsx(
              'money mt-1 text-2xl font-semibold',
              isIn ? 'text-ok-600' : 'text-danger-600',
            )}
            data-testid="cash-total"
          >
            {money(data.totalCents)}
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {brDate(data.from)} a {brDate(data.to)}
          </p>
        </button>
        {data.bySource.map((s) => (
          <button
            key={s.source}
            type="button"
            onClick={() => onFilter(filter === s.source ? null : s.source)}
            className={clsx(
              'card p-4 text-left transition hover:bg-subtle',
              filter === s.source && 'ring-2 ring-brand-500',
            )}
          >
            <p className="text-sm font-medium text-ink-muted">{CASH_SOURCE_LABEL[s.source]}</p>
            <p className="money mt-1 text-xl font-semibold">{money(s.totalCents)}</p>
          </button>
        ))}
      </div>
      {lines.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-muted">
          Nada {isIn ? 'recebido' : 'pago'} neste período.
        </Card>
      ) : (
        <Table
          testId="cash-lines"
          head={['Data', 'Descrição', isIn ? 'De quem' : 'Para quem', 'Tipo', 'Forma', 'Valor', '']}
        >
          {lines.map((l) => (
            <tr key={l.id} className={clsx(l.cancelled && 'text-ink-muted line-through')}>
              <td className="px-4 py-2.5 whitespace-nowrap tabular-nums">{brDate(l.date)}</td>
              <td className="px-4 py-2.5">
                {l.description}
                <span className="block text-xs text-ink-muted">
                  {[l.reference, l.category && payableCategoryLabel(l.category)]
                    .filter(Boolean)
                    .join(' · ')}
                  {l.cancelled ? (isIn ? ' · cancelada' : ' · estornado') : ''}
                </span>
              </td>
              <td className="px-4 py-2.5">{l.party ?? '—'}</td>
              <td className="px-4 py-2.5 text-ink-soft">{CASH_SOURCE_LABEL[l.source]}</td>
              <td className="px-4 py-2.5 text-ink-soft">
                {l.method ? (PAYMENT_METHOD_LABEL[l.method as PaymentMethod] ?? l.method) : '—'}
              </td>
              <td
                className={clsx(
                  'px-4 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums',
                  l.amountCents < 0 && 'text-danger-600',
                )}
              >
                {money(l.amountCents)}
              </td>
              <td className="px-4 py-2.5 text-right">
                {l.manual && !l.cancelled && onCancel && (
                  <Button size="sm" variant="ghost" onClick={() => onCancel(l)}>
                    Cancelar
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

const METHOD_OPTIONS = PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL);

function NewExpense({ onClose }: { onClose: () => void }) {
  const can = useCan();
  const cats = useExpenseCategories();
  return (
    <FormDialog
      title="Incluir despesa"
      description="Algo que já foi pago (uma compra, um conserto...). Entra em Despesas e fica registrado em A pagar como paga."
      onClose={onClose}
      okMessage="Despesa incluída."
      fields={[
        { name: 'description', label: 'O que foi pago', required: true },
        { name: 'beneficiary', label: 'Para quem (loja, fornecedor, pessoa)', required: true },
        {
          name: 'category',
          label: 'Categoria',
          type: 'select',
          required: true,
          options: categoryOptions(cats.data, { payable: true }),
          allowNew: can('financeiro.gerenciar') ? NEW_CATEGORY_LABEL : undefined,
        },
        { name: 'amount', label: 'Valor (R$)', type: 'money', required: true },
        {
          name: 'date',
          label: 'Data do pagamento',
          type: 'date',
          required: true,
          initial: localToday(),
        },
        { name: 'method', label: 'Forma de pagamento', type: 'select', options: METHOD_OPTIONS },
        { name: 'notes', label: 'Observações', type: 'textarea' },
      ]}
      onSubmit={async (v, cents, key) =>
        api('/api/v1/finance/cash-out', {
          method: 'POST',
          body: {
            description: v.description,
            beneficiary: v.beneficiary,
            category: await chosenCategory(v),
            amountCents: cents('amount'),
            date: v.date,
            method: v.method,
            notes: v.notes || null,
          },
          idempotencyKey: key,
        })
      }
    />
  );
}

function NewRevenue({ onClose }: { onClose: () => void }) {
  return (
    <FormDialog
      title="Incluir receita"
      description="Dinheiro que entrou fora das cobranças dos serviços (venda de sobra de tecido, reembolso...). O pagamento de um cliente se registra em A receber."
      onClose={onClose}
      okMessage="Receita incluída."
      fields={[
        { name: 'description', label: 'O que entrou', required: true },
        {
          name: 'category',
          label: 'Categoria',
          type: 'select',
          required: true,
          options: MANUAL_REVENUE_CATEGORIES.map((c) => ({ value: c, label: c })),
        },
        { name: 'amount', label: 'Valor (R$)', type: 'money', required: true },
        { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
        { name: 'method', label: 'Forma', type: 'select', options: METHOD_OPTIONS },
        { name: 'notes', label: 'Observações', type: 'textarea' },
      ]}
      onSubmit={(v, cents, key) =>
        api('/api/v1/finance/cash-in', {
          method: 'POST',
          body: {
            description: v.description,
            category: v.category,
            amountCents: cents('amount'),
            date: v.date,
            method: v.method,
            notes: v.notes || null,
          },
          idempotencyKey: key,
        })
      }
    />
  );
}
