'use client';

import { plural } from '@cenario/shared';
import {
  SERVICE_TYPE_LABEL,
  payableCategoryLabel,
  type BillDueDto,
  type ServiceType,
} from '@cenario/shared';
import clsx from 'clsx';
import { useFocusParam } from '@/lib/focus-param';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { Field, Select } from '@/components/ui/field';
import { Tabs } from '@/components/ui/tabs';
import { useTabParam } from '@/lib/tab-param';
import {
  localToday,
  money,
  monthStart,
  reportCsvUrl,
  useFinDashboard,
  useReport,
  type Period,
} from '@/lib/finance';
import { PeriodPicker, Stat, Table } from './common';
import { CashLedgerTab } from './cash-ledger';
import { CostsTab } from './costs';
import { ExpensesTab, PayablesTab } from './payables';
import { LaborTab } from './labor';
import { RevenueTab } from './revenue';
import { WeeklyClosingTab } from './weekly-closing';
import { useCompany } from '@/lib/queries';

// 2026-11-18 (pedido do dono): Despesas e Receitas logo depois do Resumo. Revisão geral
// (2026-11-18, item 9): de 10 abas para 4; as outras viraram vistas dentro delas. As chaves antigas
// continuam (endereços salvos seguem abrindo a mesma vista).
const GROUPS: { key: string; label: string; views: { key: string; label: string }[] }[] = [
  {
    key: 'painel',
    label: 'Resumo',
    views: [
      { key: 'painel', label: 'Números do mês' },
      { key: 'custos', label: 'Por OS' },
      { key: 'relatorios', label: 'Relatórios' },
    ],
  },
  {
    key: 'saidas',
    label: 'Despesas',
    views: [
      { key: 'saidas', label: 'O que saiu' },
      { key: 'pagar', label: 'A pagar' },
      { key: 'despesas', label: 'Gastos fixos' },
    ],
  },
  {
    key: 'entradas',
    label: 'Receitas',
    views: [
      { key: 'entradas', label: 'O que entrou' },
      { key: 'receitas', label: 'A receber' },
    ],
  },
  {
    key: 'producao',
    label: 'Equipe',
    views: [
      { key: 'producao', label: 'Mão de obra' },
      { key: 'fechamento', label: 'Semana da equipe' },
    ],
  },
];
const VIEWS = GROUPS.flatMap((g) => g.views.map((v) => v.key));
const groupOf = (view: string) => GROUPS.find((g) => g.views.some((v) => v.key === view))!;

/**
 * Fase 11 — financeiro operacional (só o gestor). Registros de recebimentos e pagamentos, sem
 * integração bancária, sem pagamentos automáticos e sem emissão de notas fiscais.
 */
export function FinancePage() {
  useFocusParam();
  const [view, setView] = useTabParam('painel', VIEWS, { equipe: 'producao' });
  const [period, setPeriod] = useState<Period>(() => ({ from: monthStart(), to: localToday() }));
  const group = groupOf(view);
  const withPeriod = ['painel', 'saidas', 'entradas', 'custos', 'despesas', 'relatorios'].includes(
    view,
  );
  return (
    <>
      <PageHeader
        title="Financeiro"
        description="Quanto entrou, quanto saiu e quanto sobrou."
        help="Só registro: o sistema não faz transferência, boleto nem nota fiscal."
      />
      <Tabs
        tabs={GROUPS.map((g) => ({ key: g.key, label: g.label }))}
        active={group.key}
        onChange={(k) => setView(k)}
      >
        <div className="space-y-4 pt-4">
          <Tabs tabs={group.views} active={view} onChange={setView} variant="pills">
            <div className="pt-4">
              {withPeriod && <PeriodPicker value={period} onChange={setPeriod} />}
              {view === 'painel' && (
                <Dashboard period={period} onOpenPayables={() => setView('pagar')} />
              )}
              {view === 'saidas' && <CashLedgerTab kind="out" period={period} />}
              {view === 'entradas' && <CashLedgerTab kind="in" period={period} />}
              {view === 'receitas' && <RevenueTab />}
              {view === 'fechamento' && <WeeklyClosingTab />}
              {view === 'pagar' && <PayablesTab />}
              {view === 'producao' && <LaborTab />}
              {view === 'custos' && <CostsTab period={period} />}
              {view === 'despesas' && <ExpensesTab period={period} />}
              {view === 'relatorios' && <Reports period={period} />}
            </div>
          </Tabs>
        </div>
      </Tabs>
    </>
  );
}

function Dashboard({ period, onOpenPayables }: { period: Period; onOpenPayables: () => void }) {
  const q = useFinDashboard(period);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const d = q.data;
  const tone = (v: number): 'danger' | 'ok' => (v < 0 ? 'danger' : 'ok');
  return (
    <div className="space-y-6" data-testid="finance-dashboard">
      {period.from === monthStart() && <MonthGoal receivedCents={d.cash.receivedCents} />}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">No período</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Entrou" value={money(d.cash.receivedCents)} testId="fin-received" />
          <Stat
            label="Saiu"
            value={money(d.cash.receivedCents - d.cash.netCents)}
            hint={`Contas ${money(d.cash.paidPayablesCents)} · equipe ${money(d.cash.paidLaborCents)}`}
            testId="fin-out"
          />
          <Stat
            label="Sobrou"
            value={money(d.cash.netCents)}
            tone={tone(d.cash.netCents)}
            testId="fin-net"
          />
          <Stat
            label="Falta receber"
            value={money(d.open.receivableCents)}
            hint={
              d.open.receivableOverdueCents
                ? `Atrasado: ${money(d.open.receivableOverdueCents)}`
                : 'Nada atrasado'
            }
            tone={d.open.receivableOverdueCents ? 'warn' : 'neutral'}
            testId="fin-receivable"
          />
        </div>
      </section>
      <Bills bills={d.bills} onOpen={onOpenPayables} />
      <section data-testid="fin-reworks">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">Retrabalhos no período</h2>
          <Link href="/painel/retrabalhos" className="text-sm font-medium text-brand-700">
            Abrir Retrabalhos
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Retrabalhos"
            value={String(d.reworks.count)}
            hint={d.reworks.count ? 'Serviços que voltaram para refazer' : 'Nenhum no período'}
            tone={d.reworks.count ? 'warn' : 'neutral'}
          />
          <Stat
            label="Gasto com retrabalhos"
            value={money(d.reworks.costCents)}
            hint={`Material ${money(d.reworks.materialsCents)} · mão de obra ${money(d.reworks.laborCents)}`}
            tone={d.reworks.costCents ? 'danger' : 'neutral'}
            testId="fin-rework-cost"
          />
          <Stat label="Logística dos retrabalhos" value={money(d.reworks.logisticsCents)} />
          <Stat
            label="Outros gastos"
            value={money(d.reworks.extraCents)}
            hint="Informados no próprio retrabalho"
          />
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">Para onde foi o dinheiro</h2>
          {d.paidByCategory.length ? (
            <ul className="space-y-1 text-sm" data-testid="fin-paid-by-category">
              {d.paidByCategory.map((e) => (
                <li key={e.category} className="flex justify-between">
                  <span>
                    {e.category === 'EQUIPE'
                      ? 'Equipe (produção)'
                      : payableCategoryLabel(e.category)}
                  </span>
                  <span className="tabular-nums">{money(e.amountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">Nada foi pago no período.</p>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">Serviços que mais deixaram dinheiro</h2>
          {d.topServices.length ? (
            <ul className="space-y-1 text-sm">
              {d.topServices.map((s) => (
                <li key={s.serviceType} className="flex justify-between gap-3">
                  <span>
                    {SERVICE_TYPE_LABEL[s.serviceType as ServiceType] ?? s.serviceType} · {s.orders}{' '}
                    OS
                  </span>
                  <span className="tabular-nums">{money(s.marginCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">Nenhuma OS concluída no período.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

const REPORTS: { key: string; label: string }[] = [
  { key: 'resultado-os', label: 'Resultado por OS' },
  { key: 'receita', label: 'Receita por período (recebida)' },
  { key: 'custos', label: 'Custos por categoria' },
  { key: 'producao', label: 'Pagamentos por produção' },
  { key: 'despesas', label: 'Gastos fixos' },
  { key: 'margens', label: 'Margens' },
  { key: 'produtividade', label: 'Produtividade' },
  { key: 'retrabalhos', label: 'Retrabalhos' },
  { key: 'servicos-rentaveis', label: 'Serviços mais rentáveis' },
];

function Reports({ period }: { period: Period }) {
  const [kind, setKind] = useState('resultado-os');
  const q = useReport(kind, period);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Relatório" className="w-72">
          {(f) => (
            <Select
              {...f}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              data-testid="report-kind"
            >
              {REPORTS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <a
          href={reportCsvUrl(kind, period)}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-subtle"
          data-testid="report-csv"
          download
        >
          <Download className="size-4" aria-hidden /> Exportar CSV
        </a>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <>
          <Table head={q.data.header} testId="report-table">
            {q.data.rows.length ? (
              q.data.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="px-4 py-2 tabular-nums">
                      {c ?? '—'}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={q.data.header.length} className="px-4 py-6 text-center text-ink-muted">
                  Nenhum registro no período.
                </td>
              </tr>
            )}
          </Table>
          {q.data.notes.length > 0 && (
            <p className="text-xs text-ink-muted">{q.data.notes.join(' ')}</p>
          )}
        </>
      )}
    </div>
  );
}

const brDay = (iso: string) => iso.split('-').reverse().slice(0, 2).join('/');
const when = (b: BillDueDto) =>
  b.days < 0
    ? `${plural(-b.days, 'dia', 'dias')} de atraso`
    : b.days === 0
      ? 'vence hoje'
      : b.days === 1
        ? 'vence amanhã'
        : `vence em ${b.days} dias`;

/** 2026-11-18: contas a pagar em atraso e as que vencem nos próximos dias, no topo do Resumo. */
function Bills({
  bills,
  onOpen,
}: {
  bills: { overdue: BillDueDto[]; upcoming: BillDueDto[]; upcomingDays: number };
  onOpen: () => void;
}) {
  const total = (l: BillDueDto[]) => money(l.reduce((a, b) => a + b.openCents, 0));
  const list = (l: BillDueDto[], late: boolean, empty: string) =>
    l.length ? (
      <ul className="divide-y divide-line">
        {l.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={onOpen}
              className="flex w-full items-center gap-3 py-2 text-left hover:bg-subtle"
              data-testid={`bill-${b.code}`}
            >
              <span
                className={clsx(
                  'w-12 shrink-0 text-sm font-semibold tabular-nums',
                  late ? 'text-danger-600' : b.days <= 1 ? 'text-warn-600' : 'text-ink-soft',
                )}
              >
                {brDay(b.dueDate)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{b.beneficiary}</span>
                <span className="block truncate text-xs text-ink-muted">
                  {b.description} · {when(b)}
                </span>
              </span>
              <span className="text-sm font-semibold tabular-nums">{money(b.openCents)}</span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="py-2 text-sm text-ink-muted">{empty}</p>
    );
  return (
    <section data-testid="finance-bills">
      <h2 className="mb-2 text-sm font-semibold text-ink-soft">Contas a pagar</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className={clsx('p-4', bills.overdue.length > 0 && 'border-danger-600/25')}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-danger-600">Em atraso</h3>
            {bills.overdue.length > 0 && (
              <span className="text-sm font-semibold text-danger-600 tabular-nums">
                {total(bills.overdue)}
              </span>
            )}
          </div>
          {list(bills.overdue, true, 'Nenhuma conta em atraso.')}
        </Card>
        <Card className="p-4">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold">A vencer nos próximos {bills.upcomingDays} dias</h3>
            {bills.upcoming.length > 0 && (
              <span className="text-sm font-semibold tabular-nums">{total(bills.upcoming)}</span>
            )}
          </div>
          {list(bills.upcoming, false, 'Nenhuma conta vence nos próximos dias.')}
        </Card>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        O sininho avisa um dia antes do vencimento, no dia e enquanto a conta estiver em atraso.
      </p>
    </section>
  );
}

/** Meta do mês (pergunta do começo, 26/11/2026): quanto já entrou perto da meta. */
function MonthGoal({ receivedCents }: { receivedCents: number }) {
  const company = useCompany();
  const goal = company.data?.monthlyGoalCents;
  if (!goal) return null;
  const pct = Math.min(100, Math.round((receivedCents / goal) * 100));
  return (
    <Card className="p-4" data-testid="fin-goal">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink-soft">Meta do mês</p>
        <p className="text-sm text-ink-muted">
          <span className="font-semibold text-ink tabular-nums">{money(receivedCents)}</span> de{' '}
          {money(goal)} · {pct}%
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-subtle">
        <div
          className={clsx('h-full rounded-full', pct >= 100 ? 'bg-ok-600' : 'bg-brand-700')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </Card>
  );
}
