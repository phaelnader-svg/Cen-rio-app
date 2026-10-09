'use client';

import { EXPENSE_CATEGORY_LABEL, SERVICE_TYPE_LABEL, type ServiceType } from '@cenario/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { Field, Select } from '@/components/ui/field';
import { Tabs } from '@/components/ui/tabs';
import {
  localToday,
  money,
  monthStart,
  reportCsvUrl,
  useFinDashboard,
  useProductivity,
  useReport,
  type Period,
} from '@/lib/finance';
import { PeriodPicker, Stat, Table } from './common';
import { CostsTab } from './costs';
import { ExpensesTab, PayablesTab } from './payables';
import { LaborTab } from './labor';
import { RevenueTab } from './revenue';

const TABS = [
  { key: 'painel', label: 'Painel' },
  { key: 'receitas', label: 'Receitas e recebimentos' },
  { key: 'pagar', label: 'Contas a pagar' },
  { key: 'producao', label: 'Produção e equipe' },
  { key: 'custos', label: 'Custos e resultado por OS' },
  { key: 'despesas', label: 'Despesas' },
  { key: 'produtividade', label: 'Produtividade' },
  { key: 'relatorios', label: 'Relatórios' },
];

/**
 * Fase 11 — financeiro operacional (só o gestor). Registros de recebimentos e pagamentos, sem
 * integração bancária, sem pagamentos automáticos e sem emissão de notas fiscais.
 */
export function FinancePage() {
  const [tab, setTab] = useState('painel');
  const [period, setPeriod] = useState<Period>(() => ({ from: monthStart(), to: localToday() }));
  const withPeriod = ['painel', 'custos', 'despesas', 'produtividade', 'relatorios'].includes(tab);
  return (
    <>
      <PageHeader
        title="Financeiro"
        description="Receita por OS, recebimentos, contas a pagar, custos, mão de obra por produção, margens e indicadores. Valores apenas registrados: nenhuma transferência bancária é feita pelo sistema."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab}>
        <div className="pt-5">
          {withPeriod && <PeriodPicker value={period} onChange={setPeriod} />}
          {tab === 'painel' && <Dashboard period={period} />}
          {tab === 'receitas' && <RevenueTab />}
          {tab === 'pagar' && <PayablesTab />}
          {tab === 'producao' && <LaborTab />}
          {tab === 'custos' && <CostsTab period={period} />}
          {tab === 'despesas' && <ExpensesTab period={period} />}
          {tab === 'produtividade' && <Productivity period={period} />}
          {tab === 'relatorios' && <Reports period={period} />}
        </div>
      </Tabs>
    </>
  );
}

function Dashboard({ period }: { period: Period }) {
  const q = useFinDashboard(period);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const d = q.data;
  const tone = (v: number): 'danger' | 'ok' => (v < 0 ? 'danger' : 'ok');
  return (
    <div className="space-y-6" data-testid="finance-dashboard">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">
          Competência (o que foi vendido e realizado)
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Faturamento contratado"
            value={money(d.accrual.contractedCents)}
            hint={`${d.accrual.contractedOrders} pedido(s) no período`}
            testId="fin-contracted"
          />
          <Stat
            label="Margem de contribuição"
            value={money(d.accrual.contributionMarginCents)}
            hint={`${d.accrual.completedOrders} OS concluída(s) · receita ${money(d.accrual.revenueCompletedCents)}`}
            tone={tone(d.accrual.contributionMarginCents)}
            testId="fin-margin"
          />
          <Stat
            label="Despesas operacionais"
            value={money(d.accrual.operationalExpensesCents)}
            hint={`Equipe fixa: ${money(d.accrual.fixedTeamCents)}`}
          />
          <Stat
            label="Resultado gerencial estimado"
            value={money(d.accrual.managementResultCents)}
            hint="Margem − despesas − equipe fixa (estimativa, não é lucro contábil)"
            tone={tone(d.accrual.managementResultCents)}
            testId="fin-result"
          />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">
          Caixa (o que entrou e saiu no período)
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Recebido" value={money(d.cash.receivedCents)} testId="fin-received" />
          <Stat label="Contas pagas" value={money(d.cash.paidPayablesCents)} />
          <Stat label="Pago por produção" value={money(d.cash.paidLaborCents)} />
          <Stat
            label="Saldo do período"
            value={money(d.cash.netCents)}
            tone={tone(d.cash.netCents)}
          />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">Saldos em aberto (hoje)</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="A receber"
            value={money(d.open.receivableCents)}
            hint={`Vencido: ${money(d.open.receivableOverdueCents)}`}
            tone={d.open.receivableOverdueCents ? 'warn' : 'neutral'}
            testId="fin-receivable"
          />
          <Stat
            label="A pagar"
            value={money(d.open.payableCents)}
            hint={`Vencido: ${money(d.open.payableOverdueCents)}`}
            tone={d.open.payableOverdueCents ? 'warn' : 'neutral'}
          />
          <Stat label="Produção liberada a pagar" value={money(d.open.laborReleasedCents)} />
          <Stat
            label="Produção prevista"
            value={money(d.open.laborForecastCents)}
            hint="Aguardando a condição combinada"
          />
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">OS em andamento</h2>
          <p className="text-sm text-ink-muted">
            {d.inProgress.orders} OS · receita {money(d.inProgress.revenueCents)} · margem prevista{' '}
            {money(d.inProgress.estimatedMarginCents)} (estimativa)
          </p>
          <h2 className="mt-4 mb-2 text-sm font-semibold">Despesas por categoria</h2>
          {d.expensesByCategory.length ? (
            <ul className="space-y-1 text-sm">
              {d.expensesByCategory.map((e) => (
                <li key={e.category} className="flex justify-between">
                  <span>{EXPENSE_CATEGORY_LABEL[e.category]}</span>
                  <span className="tabular-nums">{money(e.amountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">Nenhuma despesa no período.</p>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">Serviços mais rentáveis (OS concluídas)</h2>
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
      <Alert tone="info" title="Como ler">
        <ul className="list-disc space-y-0.5 pl-4">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}

function Productivity({ period }: { period: Period }) {
  const q = useProductivity(period);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const min = (v: number | null) => (v === null ? '—' : `${v} min`);
  return (
    <div className="space-y-4">
      <Alert tone="info">{q.data.notes.join(' ')}</Alert>
      <Table
        testId="productivity-table"
        head={[
          'Funcionário',
          'Concluídas',
          'Apoios',
          'Retrabalhos',
          'Execução média',
          'Espera média',
          'No prazo',
          'Atrasos',
          'Atrasos c/ impedimento',
          'Impedimentos',
          'Ocorrências',
          'Peças reprovadas',
        ]}
      >
        {q.data.rows.map((r) => (
          <tr key={r.userId}>
            <td className="px-4 py-2.5 font-medium">{r.displayName}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.tasksCompleted}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.supportTasks}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.reworkTasks}</td>
            <td className="px-4 py-2.5 tabular-nums">{min(r.avgExecutionMinutes)}</td>
            <td className="px-4 py-2.5 tabular-nums">{min(r.avgWaitingMinutes)}</td>
            <td className="px-4 py-2.5 tabular-nums">
              {r.withDueDate ? `${r.onTime}/${r.withDueDate}` : '—'}
            </td>
            <td className="px-4 py-2.5 tabular-nums">{r.late - r.lateWithImpediment}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.lateWithImpediment}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.impediments}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.issuesReported}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.rejectedPieces}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

const REPORTS: { key: string; label: string }[] = [
  { key: 'resultado-os', label: 'Resultado por OS' },
  { key: 'receita', label: 'Receita por período (recebida)' },
  { key: 'custos', label: 'Custos por categoria' },
  { key: 'producao', label: 'Pagamentos por produção' },
  { key: 'despesas', label: 'Despesas' },
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
