'use client';

import {
  EXPENSE_CATEGORY_LABEL,
  PAYABLE_CATEGORY_LABEL,
  PAYABLE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  type PayableDto,
  type RecurringExpenseDto,
} from '@cenario/shared';
import { Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import {
  brDate,
  localToday,
  money,
  useExpenses,
  useFinSend,
  usePayable,
  usePayables,
  useRecurring,
  type Period,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Table } from './common';
import { History, statusTone } from './revenue';

/** Contas a pagar (fornecedores, despesas, logística): só registro, sem pagamento bancário. */
export function PayablesTab() {
  const can = useCan();
  const [filter, setFilter] = useState('ABERTO,PARCIAL');
  const q = usePayables(filter || undefined);
  const [create, setCreate] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[
          ['ABERTO,PARCIAL', 'Em aberto'],
          ['PAGO', 'Pagas'],
          ['', 'Todas'],
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
        {can('financeiro.gerenciar') && (
          <Button
            className="ml-auto"
            icon={<Plus className="size-4" />}
            onClick={() => setCreate(true)}
          >
            Nova conta a pagar
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <Table
          testId="fin-payables"
          head={[
            'Código',
            'Beneficiário',
            'Categoria',
            'Descrição',
            'Valor',
            'Pago',
            'Vencimento',
            'Situação',
            '',
          ]}
        >
          {q.data.map((p) => (
            <tr key={p.id} data-testid={`payable-${p.code}`}>
              <td className="px-4 py-2.5 font-mono font-semibold">{p.code}</td>
              <td className="px-4 py-2.5">{p.beneficiary}</td>
              <td className="px-4 py-2.5">
                {PAYABLE_CATEGORY_LABEL[p.category]}
                {p.origin && <p className="text-xs text-ink-muted">{p.origin.code}</p>}
              </td>
              <td className="px-4 py-2.5">{p.description}</td>
              <td className="px-4 py-2.5 tabular-nums">{money(p.amountCents)}</td>
              <td className="px-4 py-2.5 tabular-nums">{money(p.paidCents)}</td>
              <td className={`px-4 py-2.5 ${p.overdue ? 'font-semibold text-danger-600' : ''}`}>
                {brDate(p.dueDate)}
              </td>
              <td className="px-4 py-2.5">
                <Badge tone={statusTone(p.status)}>{PAYABLE_STATUS_LABEL[p.status]}</Badge>
              </td>
              <td className="px-4 py-2.5 text-right">
                <Button size="sm" variant="secondary" onClick={() => setOpen(p.id)}>
                  Abrir
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {create && (
        <FormDialog
          title="Nova conta a pagar"
          onClose={() => setCreate(false)}
          fields={[
            { name: 'beneficiary', label: 'Fornecedor ou beneficiário', required: true },
            {
              name: 'category',
              label: 'Categoria',
              type: 'select',
              options: PAYMENT_OPTIONS(PAYABLE_CATEGORY_LABEL),
            },
            { name: 'description', label: 'Descrição', required: true },
            { name: 'amount', label: 'Valor (R$)', type: 'money', required: true },
            {
              name: 'dueDate',
              label: 'Vencimento',
              type: 'date',
              required: true,
              initial: localToday(),
            },
            { name: 'notes', label: 'Observações', type: 'textarea' },
          ]}
          onSubmit={(v, cents, key) =>
            api('/api/v1/finance/payables', {
              method: 'POST',
              body: {
                beneficiary: v.beneficiary,
                category: v.category,
                description: v.description,
                amountCents: cents('amount'),
                dueDate: v.dueDate,
                notes: v.notes || null,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {open && <PayableDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PayableDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const q = usePayable(id);
  const [pay, setPay] = useState(false);
  const [cancel, setCancel] = useState(false);
  const p: PayableDto | undefined = q.data;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={p ? `${p.code} — ${p.beneficiary}` : 'Conta a pagar'}
    >
      {!p ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            <p>
              Valor: <strong>{money(p.amountCents)}</strong>
            </p>
            <p>
              Pago: <strong data-testid="payable-paid">{money(p.paidCents)}</strong>
            </p>
            <p>
              Em aberto: <strong>{money(p.openCents)}</strong>
            </p>
            <p>Vencimento: {brDate(p.dueDate)}</p>
            <p>{PAYABLE_CATEGORY_LABEL[p.category]}</p>
            <p>
              <Badge tone={statusTone(p.status)}>{PAYABLE_STATUS_LABEL[p.status]}</Badge>
            </p>
          </div>
          {can('financeiro.gerenciar') && (
            <div className="flex gap-2">
              {(p.status === 'ABERTO' || p.status === 'PARCIAL') && (
                <Button size="sm" onClick={() => setPay(true)}>
                  Registrar pagamento
                </Button>
              )}
              {p.status === 'ABERTO' && !p.origin && (
                <Button size="sm" variant="ghost" onClick={() => setCancel(true)}>
                  Cancelar
                </Button>
              )}
            </div>
          )}
          <div>
            <h3 className="mb-1 font-semibold">Pagamentos registrados</h3>
            {p.payments.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {p.payments.map((x) => (
                  <li key={x.id} className="flex gap-3 px-3 py-2">
                    <span className="w-24">{brDate(x.paidAt)}</span>
                    <span className="w-28 font-semibold tabular-nums">{money(x.amountCents)}</span>
                    <span className="text-ink-muted">
                      {PAYMENT_METHOD_LABEL[x.method]}
                      {x.note ? ` · ${x.note}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">Nenhum pagamento registrado.</p>
            )}
          </div>
          <div>
            <h3 className="mb-1 font-semibold">Comprovantes (opcional)</h3>
            <PhotoGallery
              entityType="FINANCE_PAYABLE"
              entityId={p.id}
              canManage={can('financeiro.gerenciar')}
            />
          </div>
          <History items={p.history} />
        </div>
      )}
      {p && pay && (
        <FormDialog
          title={`Registrar pagamento — ${p.code}`}
          description="Somente registro: o sistema não faz transferências nem pagamentos."
          onClose={() => setPay(false)}
          fields={[
            {
              name: 'amount',
              label: 'Valor pago (R$)',
              type: 'money',
              required: true,
              initial: (p.openCents / 100).toFixed(2).replace('.', ','),
            },
            { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
            {
              name: 'method',
              label: 'Forma',
              type: 'select',
              options: PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL),
            },
            { name: 'note', label: 'Observação', type: 'textarea' },
          ]}
          onSubmit={(v, cents, key) =>
            api(`/api/v1/finance/payables/${p.id}/payments`, {
              method: 'POST',
              body: {
                amountCents: cents('amount'),
                paidAt: v.date,
                method: v.method,
                note: v.note || null,
                version: p.version,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {p && cancel && (
        <FormDialog
          title={`Cancelar ${p.code}`}
          onClose={() => setCancel(false)}
          fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/payables/${p.id}/cancel`, {
              method: 'POST',
              body: { reason: v.reason, version: p.version },
              idempotencyKey: key,
            })
          }
        />
      )}
    </Dialog>
  );
}

const thisMonth = () => localToday().slice(0, 7);

/** Despesas operacionais (competência mensal) e modelos recorrentes. Sem contabilidade fiscal. */
export function ExpensesTab({ period }: { period: Period }) {
  const can = useCan();
  const q = useExpenses(period);
  const rec = useRecurring();
  const [create, setCreate] = useState(false);
  const [recurring, setRecurring] = useState<RecurringExpenseDto | 'new' | null>(null);
  const [cancel, setCancel] = useState<{ id: string; version: number; code: string } | null>(null);
  const gen = useFinSend();
  const manage = can('financeiro.gerenciar');
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Despesas do período</h2>
          {manage && (
            <>
              <Button
                variant="secondary"
                icon={<RefreshCw className="size-4" />}
                loading={gen.m.isPending}
                onClick={() =>
                  gen.m.mutate({
                    run: () =>
                      api('/api/v1/finance/recurring-expenses/generate', {
                        method: 'POST',
                        body: { month: thisMonth() },
                        idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
                      }),
                    ok: 'Despesas recorrentes do mês geradas.',
                  })
                }
              >
                Gerar recorrentes do mês
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
                Nova despesa
              </Button>
            </>
          )}
        </div>
        {gen.error && (
          <Alert tone="danger" className="mb-3">
            {gen.error}
          </Alert>
        )}
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <Alert tone="danger">{q.error.message}</Alert>
        ) : (
          <Table
            testId="fin-expenses"
            head={['Código', 'Competência', 'Categoria', 'Descrição', 'Valor', 'Conta a pagar', '']}
          >
            {q.data.map((e) => (
              <tr key={e.id} className={e.cancelled ? 'opacity-50' : undefined}>
                <td className="px-4 py-2.5 font-mono font-semibold">{e.code}</td>
                <td className="px-4 py-2.5">{e.competence.split('-').reverse().join('/')}</td>
                <td className="px-4 py-2.5">
                  {EXPENSE_CATEGORY_LABEL[e.category]}
                  {e.recurring && <p className="text-xs text-ink-muted">recorrente</p>}
                </td>
                <td className="px-4 py-2.5">{e.description}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(e.amountCents)}</td>
                <td className="px-4 py-2.5">
                  {e.cancelled
                    ? 'Cancelada'
                    : e.payable
                      ? `${e.payable.code} · ${PAYABLE_STATUS_LABEL[e.payable.status]} · vence ${brDate(e.payable.dueDate)}`
                      : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {manage && !e.cancelled && e.payable?.status === 'ABERTO' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setCancel({ id: e.id, version: e.version, code: e.code })}
                    >
                      Cancelar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <section>
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto text-lg font-semibold">Despesas recorrentes</h2>
          {manage && (
            <Button
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() => setRecurring('new')}
            >
              Nova recorrente
            </Button>
          )}
        </div>
        {rec.data && (
          <Table
            head={['Descrição', 'Categoria', 'Valor', 'Vencimento', 'Vigência', 'Situação', '']}
          >
            {rec.data.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5">{r.description}</td>
                <td className="px-4 py-2.5">{EXPENSE_CATEGORY_LABEL[r.category]}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(r.amountCents)}</td>
                <td className="px-4 py-2.5">dia {r.dayOfMonth}</td>
                <td className="px-4 py-2.5">
                  {r.startMonth} → {r.endMonth ?? 'sem fim'}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={r.active ? 'ok' : 'neutral'}>{r.active ? 'Ativa' : 'Inativa'}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {manage && (
                    <Button size="sm" variant="ghost" onClick={() => setRecurring(r)}>
                      Editar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      {create && (
        <FormDialog
          title="Nova despesa operacional"
          description="Gera a conta a pagar correspondente."
          onClose={() => setCreate(false)}
          fields={[
            {
              name: 'category',
              label: 'Categoria',
              type: 'select',
              options: PAYMENT_OPTIONS(EXPENSE_CATEGORY_LABEL),
            },
            { name: 'description', label: 'Descrição', required: true },
            { name: 'amount', label: 'Valor (R$)', type: 'money', required: true },
            {
              name: 'competence',
              label: 'Competência',
              type: 'month',
              required: true,
              initial: thisMonth(),
            },
            {
              name: 'dueDate',
              label: 'Vencimento',
              type: 'date',
              required: true,
              initial: localToday(),
            },
            { name: 'beneficiary', label: 'Beneficiário', required: true },
          ]}
          onSubmit={(v, cents, key) =>
            api('/api/v1/finance/expenses', {
              method: 'POST',
              body: {
                category: v.category,
                description: v.description,
                amountCents: cents('amount'),
                competence: v.competence,
                dueDate: v.dueDate,
                beneficiary: v.beneficiary,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
      {recurring && (
        <FormDialog
          title={
            recurring === 'new' ? 'Nova despesa recorrente' : `Editar — ${recurring.description}`
          }
          description="Alterar o modelo não muda as despesas já geradas."
          onClose={() => setRecurring(null)}
          fields={[
            {
              name: 'category',
              label: 'Categoria',
              type: 'select',
              options: PAYMENT_OPTIONS(EXPENSE_CATEGORY_LABEL),
              initial: recurring === 'new' ? undefined : recurring.category,
            },
            {
              name: 'description',
              label: 'Descrição',
              required: true,
              initial: recurring === 'new' ? '' : recurring.description,
            },
            {
              name: 'amount',
              label: 'Valor mensal (R$)',
              type: 'money',
              required: true,
              initial:
                recurring === 'new'
                  ? ''
                  : (recurring.amountCents / 100).toFixed(2).replace('.', ','),
            },
            {
              name: 'day',
              label: 'Dia do vencimento',
              type: 'number',
              required: true,
              initial: recurring === 'new' ? '10' : String(recurring.dayOfMonth),
            },
            {
              name: 'beneficiary',
              label: 'Beneficiário',
              required: true,
              initial: recurring === 'new' ? '' : (recurring.beneficiary ?? ''),
            },
            {
              name: 'start',
              label: 'Início',
              type: 'month',
              required: true,
              initial: recurring === 'new' ? thisMonth() : recurring.startMonth,
            },
            {
              name: 'end',
              label: 'Fim (opcional)',
              type: 'month',
              initial: recurring === 'new' ? '' : (recurring.endMonth ?? ''),
            },
            {
              name: 'active',
              label: 'Situação',
              type: 'select',
              options: [
                { value: '1', label: 'Ativa' },
                { value: '0', label: 'Inativa' },
              ],
              initial: recurring === 'new' || recurring.active ? '1' : '0',
            },
          ]}
          onSubmit={(v, cents, key) => {
            const body = {
              category: v.category,
              description: v.description,
              amountCents: cents('amount'),
              dayOfMonth: Number(v.day),
              beneficiary: v.beneficiary,
              startMonth: v.start,
              endMonth: v.end || null,
              active: v.active === '1',
            };
            return recurring === 'new'
              ? api('/api/v1/finance/recurring-expenses', {
                  method: 'POST',
                  body,
                  idempotencyKey: key,
                })
              : api(`/api/v1/finance/recurring-expenses/${recurring.id}`, {
                  method: 'PUT',
                  body: { ...body, version: recurring.version },
                });
          }}
        />
      )}
      {cancel && (
        <FormDialog
          title={`Cancelar ${cancel.code}`}
          description="A conta a pagar ligada também é cancelada (só se nada foi pago)."
          onClose={() => setCancel(null)}
          fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/expenses/${cancel.id}/cancel`, {
              method: 'POST',
              body: { reason: v.reason, version: cancel.version },
              idempotencyKey: key,
            })
          }
        />
      )}
    </div>
  );
}
