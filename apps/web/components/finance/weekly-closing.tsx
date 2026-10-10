'use client';

import {
  CLOSING_CATEGORY_LABEL,
  CLOSING_ITEM_STATE_LABEL,
  PAYMENT_METHOD_LABEL,
  closingWeekStart,
  type ClosingRowDto,
  type WeeklyClosingDto,
} from '@cenario/shared';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import {
  brDate,
  localToday,
  money,
  parseMoney,
  useFinSend,
  useWeeklyClosing,
  weeklyClosingCsvUrl,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Stat, Table } from './common';

const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const STATUS_LABEL: Record<WeeklyClosingDto['status'], string> = {
  ABERTO: 'Em aberto (não conferido)',
  CONFERIDO: 'Conferido',
  REABERTO: 'Reaberto',
};

/**
 * Evolução Fase 7 — fechamento semanal único (tapeçaria + logística). Visão sobre as obrigações
 * reais: o “Registrar Pix” só registra um pagamento feito fora do sistema e dá baixa nas
 * obrigações originais (mais antigas primeiro). Previsão nunca entra no pagável.
 */
export function WeeklyClosingTab() {
  const can = useCan();
  const [week, setWeek] = useState(() => closingWeekStart(localToday()));
  const [filters, setFilters] = useState<{
    beneficiaryUserId?: string;
    category?: string;
    state?: string;
  }>({});
  const [open, setOpen] = useState<string | null>(null);
  const [pay, setPay] = useState<ClosingRowDto | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [reverse, setReverse] = useState<{ id: string; code: string } | null>(null);
  const q = useWeeklyClosing(week, filters);
  const manage = can('financeiro.gerenciar');
  const adjust = can('financeiro.ajustes');
  const d = q.data;
  const rowKey = (r: ClosingRowDto) =>
    `${r.beneficiary.userId ?? r.beneficiary.displayName}|${r.category}`;
  return (
    <div className="space-y-5" data-testid="weekly-closing">
      <div className="flex flex-wrap items-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label="Semana anterior"
          onClick={() => setWeek(shift(week, -7))}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Field label="Semana (segunda)" className="w-44">
          {(f) => (
            <Input
              {...f}
              type="date"
              value={week}
              onChange={(e) => e.target.value && setWeek(closingWeekStart(e.target.value))}
              data-testid="closing-week"
            />
          )}
        </Field>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Próxima semana"
          onClick={() => setWeek(shift(week, 7))}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeek(closingWeekStart(localToday()))}>
          Esta semana
        </Button>
        <Field label="Tipo" className="w-40">
          {(f) => (
            <Select
              {...f}
              value={filters.category ?? ''}
              onChange={(e) => setFilters({ ...filters, category: e.target.value || undefined })}
            >
              <option value="">Todos</option>
              <option value="TAPECARIA">Tapeçaria</option>
              <option value="LOGISTICA">Logística</option>
            </Select>
          )}
        </Field>
        <Field label="Situação" className="w-56">
          {(f) => (
            <Select
              {...f}
              value={filters.state ?? ''}
              onChange={(e) => setFilters({ ...filters, state: e.target.value || undefined })}
            >
              <option value="">Todas</option>
              {Object.entries(CLOSING_ITEM_STATE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {d && (
          <Field label="Profissional" className="w-48">
            {(f) => (
              <Select
                {...f}
                value={filters.beneficiaryUserId ?? ''}
                onChange={(e) =>
                  setFilters({ ...filters, beneficiaryUserId: e.target.value || undefined })
                }
              >
                <option value="">Todos</option>
                {[
                  ...new Map(
                    d.rows
                      .filter((r) => r.beneficiary.userId)
                      .map((r) => [r.beneficiary.userId!, r.beneficiary.displayName]),
                  ).entries(),
                ].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <a
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-sm font-medium"
          href={weeklyClosingCsvUrl(week, filters)}
          data-testid="closing-csv"
        >
          <Download className="size-4" aria-hidden /> CSV
        </a>
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        d && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="closing-status">
              <Badge
                tone={
                  d.status === 'CONFERIDO' ? 'ok' : d.status === 'REABERTO' ? 'warn' : 'neutral'
                }
              >
                {STATUS_LABEL[d.status]}
              </Badge>
              <span className="text-ink-muted">
                {brDate(d.weekStart)} a {brDate(d.weekEnd)} ({d.timezone}) · semana pela data em que
                o valor ficou devido (liberação/realização)
                {d.checkedBy
                  ? ` · conferido por ${d.checkedBy} em ${new Date(d.checkedAt!).toLocaleString('pt-BR')}`
                  : ''}
                {d.version ? ` · versão ${d.version}` : ''}
              </span>
              <span className="ml-auto flex gap-2">
                {manage && d.status !== 'CONFERIDO' && (
                  <Button size="sm" onClick={() => setConfirm(true)} data-testid="closing-confirm">
                    Conferir semana
                  </Button>
                )}
                {adjust && d.status === 'CONFERIDO' && (
                  <Button size="sm" variant="secondary" onClick={() => setReopen(true)}>
                    Reabrir
                  </Button>
                )}
              </span>
            </div>
            {d.reopenReason && d.status === 'REABERTO' && (
              <Alert tone="warn">Reaberto: {d.reopenReason}</Alert>
            )}
            {d.divergent && (
              <Alert tone="warn" title="Mudou depois da conferência">
                <ul className="list-disc pl-5">
                  {d.divergences.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {d.pendencies.length > 0 && (
              <Alert
                tone={d.pendencies.some((p) => p.blocking) ? 'danger' : 'warn'}
                title="Pendências"
              >
                <ul className="list-disc pl-5" data-testid="closing-pendencies">
                  {d.pendencies.map((p, i) => (
                    <li key={i}>
                      {p.blocking ? '[bloqueia a conferência] ' : ''}
                      {p.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="closing-totals">
              <Stat
                label="Total devido (semana + saldo anterior)"
                value={money(d.totals.dueCents)}
              />
              <Stat label="Pago na semana" value={money(d.totals.paidInWeekCents)} />
              <Stat label="Saldo a pagar (fim da semana)" value={money(d.totals.openAtEndCents)} />
              <Stat label="Saldo hoje" value={money(d.totals.currentOpenCents)} />
              <Stat label="Saldo anterior incluído" value={money(d.totals.previousOpenCents)} />
              <Stat label="Previsto (não pagável)" value={money(d.totals.forecastCents)} />
              <Stat label="Aguardando qualidade/revisão" value={money(d.totals.awaitingCents)} />
              <Stat label="Ajustes nos itens" value={money(d.totals.adjustmentsCents)} />
            </div>

            {!d.rows.length ? (
              <p className="text-ink-muted" data-testid="closing-empty">
                Nenhum valor nesta semana.
              </p>
            ) : (
              <Table
                testId="closing-rows"
                head={[
                  'Profissional',
                  'Tipo',
                  'Itens',
                  'Previsto',
                  'Aguardando',
                  'Devido na semana',
                  'Saldo anterior',
                  'Pago na semana',
                  'Saldo',
                  '',
                ]}
              >
                {d.rows.map((r) => (
                  <tr
                    key={rowKey(r)}
                    data-testid={`closing-row-${r.beneficiary.displayName}-${r.category}`}
                  >
                    <td className="px-4 py-2.5 font-medium">{r.beneficiary.displayName}</td>
                    <td className="px-4 py-2.5">{CLOSING_CATEGORY_LABEL[r.category]}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.items}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-muted">
                      {money(r.forecastCents)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-muted">
                      {money(r.awaitingCents)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{money(r.weekDueCents)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{money(r.previousOpenCents)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{money(r.paidInWeekCents)}</td>
                    <td
                      className="px-4 py-2.5 font-semibold tabular-nums"
                      data-testid="closing-row-open"
                    >
                      {money(r.openAtEndCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpen(open === rowKey(r) ? null : rowKey(r))}
                      >
                        {open === rowKey(r) ? 'Ocultar' : 'Detalhar'}
                      </Button>
                      {manage && r.canPay && r.currentOpenCents > 0 && (
                        <Button size="sm" onClick={() => setPay(r)} data-testid="closing-pay">
                          Registrar Pix
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="bg-subtle/60 font-semibold" data-testid="closing-total-row">
                  <td className="px-4 py-2.5">Total</td>
                  <td />
                  <td className="px-4 py-2.5 tabular-nums">{d.totals.items}</td>
                  <td className="px-4 py-2.5 tabular-nums">{money(d.totals.forecastCents)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{money(d.totals.awaitingCents)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{money(d.totals.weekDueCents)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{money(d.totals.previousOpenCents)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{money(d.totals.paidInWeekCents)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{money(d.totals.openAtEndCents)}</td>
                  <td />
                </tr>
              </Table>
            )}

            {open && (
              <Table
                testId="closing-items"
                head={[
                  'Código',
                  'Origem',
                  'Situação',
                  'Competência',
                  'Devido',
                  'Pago na semana',
                  'Saldo',
                  'Pagamentos',
                ]}
              >
                {d.items
                  .filter(
                    (i) =>
                      `${i.beneficiary.userId ?? i.beneficiary.displayName}|${i.category}` === open,
                  )
                  .map((i) => (
                    <tr key={i.id}>
                      <td className="px-4 py-2.5 font-mono font-semibold">{i.code}</td>
                      <td className="px-4 py-2.5">
                        {i.description}
                        <p className="text-xs text-ink-muted">
                          {i.piece ? `${i.piece.code} · ` : ''}
                          {i.serviceOrders
                            .map(
                              (s) =>
                                `${s.code}${s.amountCents !== null ? ` ${money(s.amountCents)}` : ''}`,
                            )
                            .join(' · ')}
                        </p>
                        {i.notes.map((n) => (
                          <p key={n} className="text-xs text-ink-muted">
                            {n}
                          </p>
                        ))}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {CLOSING_ITEM_STATE_LABEL[i.state]}
                        {i.bucket === 'PREVIOUS' && (
                          <Badge tone="warn" className="ml-1">
                            Saldo anterior
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{i.competence ? brDate(i.competence) : '—'}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {i.bucket === 'FORECAST'
                          ? `(${money(i.currentOpenCents)})`
                          : money(i.dueCents)}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{money(i.paidInWeekCents)}</td>
                      <td className="px-4 py-2.5 tabular-nums">{money(i.openAtEndCents)}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {i.payments
                          .map(
                            (p) =>
                              `${brDate(p.paidAt)} ${money(p.amountCents)}${p.reversed ? ' (estornado)' : ''}`,
                          )
                          .join(' · ') || '—'}
                      </td>
                    </tr>
                  ))}
              </Table>
            )}

            <section>
              <h3 className="mb-2 font-semibold">Pagamentos registrados nesta semana</h3>
              {d.payments.length ? (
                <ul
                  className="divide-y divide-line rounded-xl border border-line text-sm"
                  data-testid="closing-payments"
                >
                  {d.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="font-mono font-semibold">{p.code}</span>
                      <span>{p.beneficiary}</span>
                      <span className="tabular-nums">{money(p.amountCents)}</span>
                      <span className="text-ink-muted">
                        {brDate(p.paidAt)} · {PAYMENT_METHOD_LABEL[p.method]}
                        {p.reference ? ` · ${p.reference}` : ''} ·{' '}
                        {p.parts.map((x) => `${x.code} ${money(x.amountCents)}`).join(', ')}
                      </span>
                      {p.reversed ? (
                        <Badge tone="danger">Estornado</Badge>
                      ) : (
                        adjust && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            onClick={() => setReverse({ id: p.id, code: p.code })}
                          >
                            Estornar
                          </Button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">
                  Nenhum pagamento registrado por este fechamento.
                </p>
              )}
            </section>

            <section>
              <h3 className="mb-2 font-semibold">Histórico do fechamento</h3>
              {d.history.length ? (
                <ol className="space-y-1 text-sm" data-testid="closing-history">
                  {d.history.map((h, i) => (
                    <li key={i}>
                      {new Date(h.createdAt).toLocaleString('pt-BR')} · {h.kind}
                      {h.actor ? ` · ${h.actor}` : ''}
                      {h.note ? ` · ${h.note}` : ''}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-ink-muted">Sem eventos.</p>
              )}
            </section>
          </>
        )
      )}

      {pay && d && <PayDialog week={week} row={pay} onClose={() => setPay(null)} />}
      {confirm && d && (
        <FormDialog
          title={`Conferir semana de ${brDate(d.weekStart)}`}
          description="Registra quem conferiu, quando e o retrato dos valores devidos. Pendências bloqueantes precisam ser resolvidas antes."
          submitLabel="Conferir"
          onClose={() => setConfirm(false)}
          fields={[{ name: 'note', label: 'Observação', type: 'textarea' }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/weekly-closings/${week}/confirm`, {
              method: 'POST',
              body: { version: d.version, note: v.note || null },
              idempotencyKey: key,
            })
          }
        />
      )}
      {reopen && d && (
        <FormDialog
          title="Reabrir fechamento"
          description="A conferência anterior continua no histórico."
          submitLabel="Reabrir"
          onClose={() => setReopen(false)}
          fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/weekly-closings/${week}/reopen`, {
              method: 'POST',
              body: { reason: v.reason, version: d.version },
              idempotencyKey: key,
            })
          }
        />
      )}
      {reverse && (
        <FormDialog
          title={`Estornar ${reverse.code}`}
          description="Estorna cada baixa feita por este pagamento nas obrigações originais; nada é apagado."
          submitLabel="Estornar"
          onClose={() => setReverse(null)}
          fields={[
            { name: 'reason', label: 'Motivo do estorno', type: 'textarea', required: true },
          ]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/closing-payments/${reverse.id}/reverse`, {
              method: 'POST',
              body: { reason: v.reason },
              idempotencyKey: key,
            })
          }
        />
      )}
    </div>
  );
}

/** Registro de Pix feito fora do sistema, com revisão antes de confirmar a baixa. */
function PayDialog({
  week,
  row,
  onClose,
}: {
  week: string;
  row: ClosingRowDto;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState((row.currentOpenCents / 100).toFixed(2).replace('.', ','));
  const [date, setDate] = useState(localToday());
  const [method, setMethod] = useState('PIX');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [review, setReview] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const { m, error, setError } = useFinSend(onClose);
  const cents = parseMoney(amount);
  const next = () => {
    if (cents === null || cents <= 0) return setError('Informe um valor válido.');
    if (cents > row.currentOpenCents)
      return setError(`O valor passa do saldo (${money(row.currentOpenCents)}).`);
    setError(null);
    setReview(true);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Registrar pagamento — ${row.beneficiary.displayName}`}
      description="Somente registro de um Pix/transferência já feito fora do sistema. Nenhuma transação bancária é iniciada."
      footer={
        review ? (
          <>
            <Button variant="ghost" onClick={() => setReview(false)}>
              Voltar
            </Button>
            <Button
              loading={m.isPending}
              data-testid="closing-pay-confirm"
              onClick={() =>
                m.mutate({
                  run: () =>
                    api(`/api/v1/finance/weekly-closings/${week}/payments`, {
                      method: 'POST',
                      body: {
                        beneficiaryUserId: row.beneficiary.userId,
                        category: row.category,
                        amountCents: cents,
                        paidAt: date,
                        method,
                        reference: reference || null,
                        note: note || null,
                      },
                      idempotencyKey: key,
                    }),
                  ok: 'Pagamento registrado.',
                })
              }
            >
              Confirmar baixa
            </Button>
          </>
        ) : (
          <Button onClick={next} data-testid="closing-pay-review">
            Revisar
          </Button>
        )
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {review ? (
        <div className="space-y-2 text-sm" data-testid="closing-pay-summary" aria-live="polite">
          <p>
            Registrar <strong>{money(cents ?? 0)}</strong> pago a{' '}
            <strong>{row.beneficiary.displayName}</strong> em {brDate(date)} (
            {PAYMENT_METHOD_LABEL[method as keyof typeof PAYMENT_METHOD_LABEL]}).
          </p>
          <p>
            Saldo antes: {money(row.currentOpenCents)} · saldo depois:{' '}
            <strong>{money(row.currentOpenCents - (cents ?? 0))}</strong>
          </p>
          <p className="text-ink-muted">
            A baixa é feita nas obrigações mais antigas primeiro; nenhuma nova conta ou despesa é
            criada.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Valor pago (R$)"
            required
            hint={`Saldo hoje: ${money(row.currentOpenCents)}`}
          >
            {(f) => (
              <Input
                {...f}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="closing-pay-amount"
              />
            )}
          </Field>
          <Field label="Data do pagamento" required>
            {(f) => (
              <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <Field label="Forma">
            {(f) => (
              <Select {...f} value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_OPTIONS(PAYMENT_METHOD_LABEL).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Referência do comprovante"
            hint="Opcional (ex.: ID do Pix). Não informe dados bancários."
          >
            {(f) => (
              <Input {...f} value={reference} onChange={(e) => setReference(e.target.value)} />
            )}
          </Field>
          <Field label="Observação" className="sm:col-span-2">
            {(f) => <Textarea {...f} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      )}
    </Dialog>
  );
}
