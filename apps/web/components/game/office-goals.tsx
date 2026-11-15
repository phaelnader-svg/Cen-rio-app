'use client';
/**
 * Quadro de Metas do escritório: saldo do caixa, metas, semana financeira e projeção.
 * Cada número abre os lançamentos que o compõem (registros oficiais, extrato ou manuais).
 */
import { type CashMoveDto, brlCents, signedBrl, signedPct } from '@cenario/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { GBtn, Panel, Section, Tone, fmtDateTime } from './ui';

const br = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
type Link = CashMoveDto['links'][number];
interface Goal {
  id: string;
  name: string;
  targetCents: number;
  deadline: string | null;
  accountIds: string[];
  active: boolean;
  version: number;
  balanceCents: number;
  pctOfGoal: number;
  missingCents: number;
  daysLeft: number | null;
  startCents: number;
  pctSinceStart: number | null;
  achieved: { at: string; balanceCents: number } | null;
  belowAfterAchieved: boolean;
  atDeadline: { balanceCents: number; reached: boolean } | null;
}
interface Week {
  weekStart: string;
  weekEnd: string;
  openingCents: number;
  closingCents: number;
  inCents: number;
  outCents: number;
  deltaCents: number;
  pct: number | null;
  operationalDeltaCents: number;
  contributionsCents: number;
  withdrawalsCents: number;
  partial: boolean;
  moveIds: string[];
  topIn: CashMoveDto[];
  topOut: CashMoveDto[];
  closedAt: string | null;
  corrections: {
    id: string;
    description: string;
    beforeCents: number | null;
    afterCents: number | null;
  }[];
}
interface Ob {
  id: string;
  label: string;
  amountCents: number;
  due?: string | null;
  bucket?: string;
  links: Link[];
  prepared?: string | null;
  overdue?: boolean;
  category?: string;
}
export interface CashBoard {
  today: string;
  startedAt: string | null;
  balanceCents: number;
  accounts: {
    id: string;
    label: string;
    bank: string;
    source: 'REGISTROS' | 'EXTRATO';
    isDefault: boolean;
    balanceCents: number;
    snapshot: {
      amountCents: number;
      takenAt: string;
      source: string;
      by: string | null;
      note: string | null;
    } | null;
    lastUpdate: { at: string | null; origin: string };
  }[];
  toReconcile: { id: string; date: string; amountCents: number; description: string }[];
  autoMatched: { entryId: string; txId: string; amountCents: number }[];
  goals: Goal[];
  nextGoalId: string | null;
  newlyAchieved: string[];
  weeks: Week[];
  obligations: {
    until: string;
    receivable: {
      totalCents: number;
      overdue: Ob[];
      confirmed: Ob[];
      conditional: Ob[];
      later: Ob[];
      cards: {
        id: string;
        provider: string;
        grossCents: number;
        feeCents: number;
        netCents: number;
        expected: string;
      }[];
    };
    payable: {
      totalCents: number;
      due: Ob[];
      later: Ob[];
      laborReleased: Ob[];
      laborForecast: Ob[];
    };
    totals: {
      confirmedInCents: number;
      overdueInCents: number;
      conditionalInCents: number;
      outCents: number;
      laborForecastCents: number;
    };
  };
  projection: {
    until: string;
    balanceCents: number;
    confirmedCents: number;
    withOverdueCents: number;
    withConditionalCents: number;
    premises: string[];
  };
  moveCount: number;
}

export const useCash = (enabled = true) =>
  useQuery({
    queryKey: ['office-cash'],
    queryFn: () => api<CashBoard>('/api/v1/office/cash'),
    enabled,
    staleTime: 5_000,
  });

export const nextGoalOf = (b: CashBoard | undefined) =>
  b?.goals.find((g) => g.id === b.nextGoalId) ?? null;

/** Pedido de detalhamento: abre a lista de lançamentos que compõem um número. */
export type Drill = { title: string; query: string; note?: string };

function Money({
  cents,
  onClick,
  testId,
  className,
}: {
  cents: number;
  onClick?: () => void;
  testId?: string;
  className?: string;
}) {
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={clsx(
        'font-bold underline decoration-dotted underline-offset-2 hover:text-brand-700',
        className,
      )}
      title="Ver os lançamentos"
    >
      {brlCents(cents)}
    </button>
  ) : (
    <b data-testid={testId} className={className}>
      {brlCents(cents)}
    </b>
  );
}

function useAct() {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(
    path: string,
    body: unknown,
    ok?: string,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<T | null> => {
    try {
      const r = await api<T>(path, { method, idempotencyKey: newIdempotencyKey(), body });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('office') });
      if (ok) toast('ok', ok);
      return r;
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível salvar.');
      return null;
    }
  };
}

export function GoalsPanel({
  initialTab,
  initialDrill,
  canManage,
  onClose,
  onAnimateWeek,
}: {
  initialTab?: string | null;
  initialDrill?: Drill | null;
  canManage: boolean;
  onClose: () => void;
  onAnimateWeek: (w: Week, g: Goal | null) => void;
}) {
  const cash = useCash();
  const [tab, setTab] = useState(initialTab ?? 'RESUMO');
  const [drill, setDrill] = useState<Drill | null>(initialDrill ?? null);
  const b = cash.data;
  const g = nextGoalOf(b);
  const open = (d: Drill) => setDrill(d);
  if (drill)
    return (
      <MovesPanel
        drill={drill}
        onBack={() => setDrill(null)}
        onClose={onClose}
        canManage={canManage}
      />
    );
  return (
    <Panel
      title="Quadro de Metas"
      subtitle="Caixa da Cenário · semanas de segunda a domingo (São Paulo)"
      icon="🎯"
      onClose={onClose}
      testId="goals-panel"
      className="h-full"
    >
      {!b ? (
        <p className="text-xs">Carregando…</p>
      ) : (
        <>
          <div
            className="mb-2 rounded-xl border-2 border-bronze-500/40 bg-white p-2.5 text-xs"
            data-testid="goals-summary"
          >
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="text-ink-muted">Saldo disponível agora</div>
                <div className="text-2xl">
                  <Money
                    cents={b.balanceCents}
                    testId="goals-balance"
                    onClick={() =>
                      open({
                        title: 'Saldo disponível: lançamentos desde o saldo informado',
                        query: '',
                        note: 'Saldo = saldo informado de cada conta + lançamentos posteriores.',
                      })
                    }
                  />
                </div>
              </div>
              {g ? (
                <div className="text-right">
                  <div className="text-ink-muted">Próxima meta</div>
                  <div className="font-bold" data-testid="goals-next">
                    {g.name}
                  </div>
                </div>
              ) : null}
            </div>
            {!b.startedAt ? (
              <p className="mt-1 rounded bg-warn-50 p-1.5 text-warn-600">
                Informe o saldo de hoje de cada conta (aba Contas) para começar.
              </p>
            ) : null}
            {g ? (
              <>
                <div
                  className="mt-2 h-4 overflow-hidden rounded-full bg-subtle"
                  title="Saldo ÷ meta"
                >
                  <div
                    className={clsx(
                      'h-full rounded-full',
                      g.belowAfterAchieved ? 'bg-danger-600' : 'bg-ok-600',
                    )}
                    style={{ width: `${Math.min(100, Math.max(0, g.pctOfGoal))}%` }}
                  />
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-1">
                  <span data-testid="goals-pct">
                    <b>
                      {g.pctOfGoal.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta
                    </b>{' '}
                    (barra = saldo ÷ {brlCents(g.targetCents)})
                  </span>
                  <span>
                    Falta <b data-testid="goals-missing">{brlCents(g.missingCents)}</b>
                    {g.daysLeft !== null
                      ? ` · ${g.daysLeft >= 0 ? `${g.daysLeft} dia(s) até ${br(g.deadline)}` : `prazo venceu em ${br(g.deadline)}`}`
                      : ' · sem prazo'}
                  </span>
                </div>
                {g.pctSinceStart !== null ? (
                  <div className="text-ink-soft">
                    Evolução desde o início ({brlCents(g.startCents)} → {brlCents(g.targetCents)}):{' '}
                    <b>
                      {g.pctSinceStart.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do
                      caminho
                    </b>
                  </div>
                ) : null}
                {g.belowAfterAchieved && g.achieved ? (
                  <div
                    className="mt-1 rounded bg-danger-50 p-1.5 text-danger-700"
                    data-testid="goals-below"
                  >
                    Conquistada em {br(g.achieved.at)}, mas o saldo caiu: hoje{' '}
                    {brlCents(g.balanceCents)}; faltam {brlCents(g.missingCents)} para recuperar o
                    patamar.
                  </div>
                ) : null}
                {g.atDeadline ? (
                  <div className="mt-1 rounded bg-warn-50 p-1.5 text-warn-600">
                    Na data prevista ({br(g.deadline)}) o saldo era{' '}
                    {brlCents(g.atDeadline.balanceCents)} —{' '}
                    {g.atDeadline.reached
                      ? 'meta batida'
                      : `faltaram ${brlCents(g.targetCents - g.atDeadline.balanceCents)}`}
                    . Ajuste a meta na aba Metas.
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="mt-2 grid grid-cols-3 gap-1 text-center">
              <button
                type="button"
                className="rounded-lg bg-ok-50 p-1"
                onClick={() => setTab('RECEBER')}
                data-testid="goals-receivable"
              >
                <div className="text-ink-muted">A receber</div>
                <b>{brlCents(b.obligations.receivable.totalCents)}</b>
              </button>
              <button
                type="button"
                className="rounded-lg bg-danger-50 p-1"
                onClick={() => setTab('RECEBER')}
                data-testid="goals-payable"
              >
                <div className="text-ink-muted">A pagar</div>
                <b>{brlCents(b.obligations.payable.totalCents)}</b>
              </button>
              <button
                type="button"
                className="rounded-lg bg-subtle p-1"
                onClick={() => setTab('RECEBER')}
                data-testid="goals-projection"
              >
                <div className="text-ink-muted">Projeção {br(b.projection.until)}</div>
                <b>{brlCents(b.projection.confirmedCents)}</b>
              </button>
            </div>
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {[
              ['RESUMO', 'Semana'],
              ['METAS', 'Metas'],
              ['RECEBER', 'A receber / pagar'],
              ['CONTAS', 'Contas e saldo'],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k!)}
                data-testid={`goals-tab-${k}`}
                className={clsx(
                  'rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                  tab === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white',
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {tab === 'RESUMO' ? (
            <WeeksTab b={b} goal={g} open={open} onAnimate={onAnimateWeek} />
          ) : tab === 'METAS' ? (
            <GoalsTab b={b} canManage={canManage} open={open} />
          ) : tab === 'RECEBER' ? (
            <ObligationsTab b={b} />
          ) : (
            <AccountsTab b={b} canManage={canManage} open={open} />
          )}
        </>
      )}
    </Panel>
  );
}

function WeekChart({ weeks }: { weeks: Week[] }) {
  const list = weeks.slice(0, 8).reverse();
  const max = Math.max(1, ...list.map((w) => Math.abs(w.deltaCents)));
  return (
    <svg
      viewBox={`0 0 ${list.length * 40} 90`}
      className="h-24 w-full"
      role="img"
      aria-label="Variação por semana"
      data-testid="weeks-chart"
    >
      <line x1="0" x2={list.length * 40} y1="45" y2="45" stroke="#cfc6b6" />
      {list.map((w, i) => {
        const h = (Math.abs(w.deltaCents) / max) * 40;
        return (
          <g key={w.weekStart}>
            <rect
              x={i * 40 + 8}
              y={w.deltaCents >= 0 ? 45 - h : 45}
              width="24"
              height={Math.max(1, h)}
              fill={w.deltaCents >= 0 ? '#1f7a46' : '#b42323'}
              opacity={w.partial ? 0.5 : 1}
              rx="3"
            />
            <text x={i * 40 + 20} y="88" fontSize="8" textAnchor="middle" fill="#6b6255">
              {w.weekStart.slice(8, 10)}/{w.weekStart.slice(5, 7)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function WeekCard({
  w,
  open,
  onAnimate,
  goal,
}: {
  w: Week;
  open: (d: Drill) => void;
  onAnimate: (w: Week, g: Goal | null) => void;
  goal: Goal | null;
}) {
  const ids = (xs: CashMoveDto[]) => xs.map((m) => m.id).join(',');
  return (
    <div
      className={clsx(
        'rounded-xl border bg-white p-2 text-xs',
        w.partial ? 'border-info-600/40' : 'border-line',
      )}
      data-testid={w.partial ? 'week-current' : 'week-closed'}
    >
      <div className="flex items-center justify-between gap-1">
        <b>
          {br(w.weekStart)} a {br(w.weekEnd)} {w.partial ? '· parcial' : '· fechada'}
        </b>
        <Tone tone={w.deltaCents >= 0 ? 'ok' : 'risco'}>
          <span data-testid="week-delta">
            {signedBrl(w.deltaCents)} ·{' '}
            {w.openingCents > 0 ? signedPct(w.pct) : '% não se aplica (abertura ≤ 0)'}
          </span>
        </Tone>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-2">
        <span>
          Abertura: <b>{brlCents(w.openingCents)}</b>
        </span>
        <span>
          {w.partial ? 'Até agora' : 'Fechamento'}:{' '}
          <b data-testid="week-closing">{brlCents(w.closingCents)}</b>
        </span>
        <span>
          Entrou:{' '}
          <Money
            cents={w.inCents}
            onClick={() =>
              open({
                title: `Entradas de ${br(w.weekStart)} a ${br(w.weekEnd)}`,
                query: `week=${w.weekStart}&sign=in`,
              })
            }
          />
        </span>
        <span>
          Saiu:{' '}
          <Money
            cents={w.outCents}
            onClick={() =>
              open({
                title: `Saídas de ${br(w.weekStart)} a ${br(w.weekEnd)}`,
                query: `week=${w.weekStart}&sign=out`,
              })
            }
          />
        </span>
      </div>
      {w.contributionsCents || w.withdrawalsCents ? (
        <div className="text-ink-soft">
          Aportes {brlCents(w.contributionsCents)} · retiradas {brlCents(w.withdrawalsCents)} ·
          variação da operação <b>{signedBrl(w.operationalDeltaCents)}</b>
        </div>
      ) : null}
      {w.topIn.length || w.topOut.length ? (
        <div className="mt-1">
          {w.topIn.slice(0, 3).map((m) => (
            <button
              key={m.id}
              className="block w-full truncate text-left text-ok-600 hover:underline"
              onClick={() => open({ title: 'Maior entrada', query: `ids=${m.id}` })}
            >
              ▲ {brlCents(m.amountCents)} · {m.description}
            </button>
          ))}
          {w.topOut.slice(0, 3).map((m) => (
            <button
              key={m.id}
              className="block w-full truncate text-left text-danger-700 hover:underline"
              onClick={() => open({ title: 'Maior saída', query: `ids=${m.id}` })}
            >
              ▼ {brlCents(-m.amountCents)} · {m.description}
            </button>
          ))}
          <button
            className="mt-0.5 text-brand-700 underline"
            onClick={() =>
              open({
                title: `Todos os lançamentos de ${br(w.weekStart)} a ${br(w.weekEnd)}`,
                query: `week=${w.weekStart}`,
              })
            }
            data-testid="week-all"
          >
            Ver os {w.moveIds.length} lançamento(s) da semana
          </button>
        </div>
      ) : null}
      {w.corrections.length ? (
        <div className="mt-1 rounded bg-warn-50 p-1.5 text-warn-600" data-testid="week-corrections">
          Corrigida depois do fechamento:
          {w.corrections.map((c) => (
            <button
              key={c.id}
              className="block text-left underline"
              onClick={() => open({ title: 'Lançamento corrigido', query: `ids=${c.id}` })}
            >
              {c.description}: {c.beforeCents === null ? 'novo' : brlCents(c.beforeCents)} →{' '}
              {c.afterCents === null ? 'removido' : brlCents(c.afterCents)} (efeito{' '}
              {signedBrl((c.afterCents ?? 0) - (c.beforeCents ?? 0))})
            </button>
          ))}
        </div>
      ) : null}
      {!w.partial ? (
        <button
          className="mt-1 text-bronze-600 underline"
          onClick={() => onAnimate(w, goal)}
          data-testid="week-animate"
        >
          ▶ Ver a barra da abertura ao fechamento
        </button>
      ) : null}
    </div>
  );
}

function WeeksTab({
  b,
  goal,
  open,
  onAnimate,
}: {
  b: CashBoard;
  goal: Goal | null;
  open: (d: Drill) => void;
  onAnimate: (w: Week, g: Goal | null) => void;
}) {
  if (!b.weeks.length)
    return (
      <p className="text-xs text-ink-muted">
        As semanas aparecem depois do primeiro saldo informado.
      </p>
    );
  const [current, ...closed] = b.weeks;
  return (
    <div className="space-y-2">
      <WeekChart weeks={b.weeks} />
      {current ? <WeekCard w={current} open={open} onAnimate={onAnimate} goal={goal} /> : null}
      {closed.length ? (
        <Section title="Semanas anteriores">
          <div className="space-y-1.5">
            {closed.map((w) => (
              <WeekCard key={w.weekStart} w={w} open={open} onAnimate={onAnimate} goal={goal} />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function GoalsTab({
  b,
  canManage,
  open,
}: {
  b: CashBoard;
  canManage: boolean;
  open: (d: Drill) => void;
}) {
  const act = useAct();
  const [edit, setEdit] = useState<
    Record<string, { name: string; target: string; deadline: string; accountIds: string[] }>
  >({});
  const [nw, setNw] = useState({ name: '', target: '', deadline: '' });
  const reais = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
  return (
    <div className="space-y-1.5 text-xs" data-testid="goals-list">
      {b.goals.map((g) => {
        const e = edit[g.id];
        return (
          <div
            key={g.id}
            className={clsx(
              'rounded-xl border bg-white p-2',
              g.id === b.nextGoalId ? 'border-brand-600' : 'border-line',
            )}
            data-testid="goal-row"
          >
            <div className="flex items-center justify-between gap-1">
              <b>{g.name}</b>
              {g.achieved ? (
                <Tone tone={g.belowAfterAchieved ? 'atencao' : 'ok'}>
                  🏆 conquistada em {br(g.achieved.at)}
                  {g.belowAfterAchieved ? ' · abaixo hoje' : ''}
                </Tone>
              ) : g.id === b.nextGoalId ? (
                <Tone tone="info">próxima</Tone>
              ) : null}
            </div>
            <div>
              {brlCents(g.targetCents)} ·{' '}
              {g.pctOfGoal.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta · falta{' '}
              {brlCents(g.missingCents)}
              {g.deadline ? ` · prazo ${br(g.deadline)}` : ''} · contas:{' '}
              {g.accountIds.length
                ? b.accounts
                    .filter((a) => g.accountIds.includes(a.id))
                    .map((a) => a.label)
                    .join(', ')
                : 'todas incluídas'}
            </div>
            <button
              className="text-brand-700 underline"
              onClick={() =>
                open({
                  title: `Lançamentos que compõem o saldo da meta "${g.name}"`,
                  query: `goalId=${g.id}`,
                })
              }
            >
              Ver lançamentos
            </button>
            {canManage ? (
              e ? (
                <div className="mt-1 space-y-1 rounded-lg bg-subtle p-1.5">
                  <input
                    className="w-full rounded border px-1"
                    value={e.name}
                    onChange={(x) => setEdit({ ...edit, [g.id]: { ...e, name: x.target.value } })}
                    aria-label="Nome da meta"
                  />
                  <div className="flex gap-1">
                    <input
                      className="w-28 rounded border px-1"
                      value={e.target}
                      onChange={(x) =>
                        setEdit({ ...edit, [g.id]: { ...e, target: x.target.value } })
                      }
                      aria-label="Valor da meta (R$)"
                    />
                    <input
                      type="date"
                      className="rounded border px-1"
                      value={e.deadline}
                      onChange={(x) =>
                        setEdit({ ...edit, [g.id]: { ...e, deadline: x.target.value } })
                      }
                      aria-label="Prazo"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {b.accounts.map((a) => (
                      <label key={a.id} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={e.accountIds.length === 0 || e.accountIds.includes(a.id)}
                          onChange={(x) =>
                            setEdit({
                              ...edit,
                              [g.id]: {
                                ...e,
                                accountIds: x.target.checked
                                  ? [
                                      ...new Set([
                                        ...(e.accountIds.length
                                          ? e.accountIds
                                          : b.accounts.map((y) => y.id)),
                                        a.id,
                                      ]),
                                    ]
                                  : (e.accountIds.length
                                      ? e.accountIds
                                      : b.accounts.map((y) => y.id)
                                    ).filter((y) => y !== a.id),
                              },
                            })
                          }
                        />
                        {a.label}
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    <GBtn
                      className="!px-2 !py-0.5 text-xs"
                      tone="primary"
                      onClick={async () => {
                        const r = await act(
                          `/api/v1/office/cash/goals/${g.id}`,
                          {
                            name: e.name,
                            targetCents: reais(e.target),
                            deadline: e.deadline || null,
                            accountIds:
                              e.accountIds.length === b.accounts.length ? [] : e.accountIds,
                            active: true,
                            version: g.version,
                          },
                          'Meta ajustada.',
                          'PUT',
                        );
                        if (r) setEdit({ ...edit, [g.id]: undefined as never });
                      }}
                    >
                      Salvar
                    </GBtn>
                    <GBtn
                      className="!px-2 !py-0.5 text-xs"
                      tone="ghost"
                      onClick={() => setEdit({ ...edit, [g.id]: undefined as never })}
                    >
                      Cancelar
                    </GBtn>
                  </div>
                </div>
              ) : (
                <button
                  className="ml-2 underline"
                  onClick={() =>
                    setEdit({
                      ...edit,
                      [g.id]: {
                        name: g.name,
                        target: String(g.targetCents / 100),
                        deadline: g.deadline ?? '',
                        accountIds: g.accountIds,
                      },
                    })
                  }
                  data-testid="goal-edit"
                >
                  Editar valor, prazo e contas
                </button>
              )
            ) : null}
          </div>
        );
      })}
      {canManage ? (
        <div
          className="rounded-xl border border-dashed border-line-strong p-2"
          data-testid="goal-new"
        >
          <b>Nova meta</b>
          <div className="mt-1 flex flex-wrap gap-1">
            <input
              className="flex-1 rounded border px-1"
              placeholder="Nome (ex.: Reserva para máquina)"
              value={nw.name}
              onChange={(x) => setNw({ ...nw, name: x.target.value })}
            />
            <input
              className="w-28 rounded border px-1"
              placeholder="Valor (R$)"
              value={nw.target}
              onChange={(x) => setNw({ ...nw, target: x.target.value })}
            />
            <input
              type="date"
              className="rounded border px-1"
              value={nw.deadline}
              onChange={(x) => setNw({ ...nw, deadline: x.target.value })}
              aria-label="Prazo"
            />
            <GBtn
              className="!px-2 !py-0.5 text-xs"
              tone="primary"
              disabled={!nw.name || !nw.target}
              onClick={async () => {
                const r = await act(
                  '/api/v1/office/cash/goals',
                  {
                    name: nw.name,
                    targetCents: reais(nw.target),
                    deadline: nw.deadline || null,
                    accountIds: [],
                  },
                  'Meta criada.',
                );
                if (r) setNw({ name: '', target: '', deadline: '' });
              }}
            >
              Criar
            </GBtn>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ObList({ title, items, tone }: { title: string; items: Ob[]; tone: string }) {
  if (!items.length) return null;
  return (
    <Section title={`${title} · ${brlCents(items.reduce((s, x) => s + x.amountCents, 0))}`}>
      <ul className="space-y-0.5 text-xs">
        {items.map((x) => (
          <li key={x.id} className="flex justify-between gap-2">
            <span>
              {x.label}
              {x.due ? ` · ${br(x.due)}` : ''}
              {x.prepared ? ' · pagamento preparado' : ''}{' '}
              {x.links.map((l) => (
                <a
                  key={l.id + l.type}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1 text-brand-700 underline"
                >
                  {l.label}
                </a>
              ))}
            </span>
            <b className={tone}>{brlCents(x.amountCents)}</b>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ObligationsTab({ b }: { b: CashBoard }) {
  const o = b.obligations;
  const p = b.projection;
  return (
    <div className="space-y-1 text-xs" data-testid="goals-obligations">
      <div
        className="rounded-xl border-2 border-brand-600/30 bg-brand-50 p-2"
        data-testid="goals-projection-box"
      >
        <b>Projeção até {br(p.until)}</b>
        <div>
          Só o confirmado: <b>{brlCents(p.confirmedCents)}</b>
        </div>
        <div>
          Se cobrar os vencidos: <b>{brlCents(p.withOverdueCents)}</b>
        </div>
        <div>
          Se as entregas previstas acontecerem: <b>{brlCents(p.withConditionalCents)}</b>
        </div>
        <ul className="mt-1 list-disc pl-4 text-ink-soft">
          {p.premises.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <ObList
        title="A receber vencido (cobrar)"
        items={o.receivable.overdue}
        tone="text-danger-700"
      />
      <ObList
        title="A receber com data (confirmado)"
        items={o.receivable.confirmed}
        tone="text-ok-600"
      />
      <ObList
        title="Depende de entrega/retirada"
        items={o.receivable.conditional}
        tone="text-warn-600"
      />
      <ObList title="A receber depois do horizonte" items={o.receivable.later} tone="text-ink" />
      {o.receivable.cards.length ? (
        <Section title="Cartão a cair (maquininha)">
          {o.receivable.cards.map((c) => (
            <div key={c.id}>
              {br(c.expected)} · {c.provider}: bruto {brlCents(c.grossCents)} − taxas{' '}
              {brlCents(c.feeCents)} = <b>{brlCents(c.netCents)}</b>
            </div>
          ))}
        </Section>
      ) : null}
      <ObList title={`A pagar até ${br(o.until)}`} items={o.payable.due} tone="text-danger-700" />
      <ObList
        title="Mão de obra liberada (a pagar)"
        items={o.payable.laborReleased}
        tone="text-danger-700"
      />
      <ObList
        title="Mão de obra prevista (ainda não liberada)"
        items={o.payable.laborForecast}
        tone="text-ink-soft"
      />
      <ObList title="A pagar depois" items={o.payable.later} tone="text-ink" />
    </div>
  );
}

function AccountsTab({
  b,
  canManage,
  open,
}: {
  b: CashBoard;
  canManage: boolean;
  open: (d: Drill) => void;
}) {
  const act = useAct();
  const [snap, setSnap] = useState<Record<string, { amount: string; at: string }>>({});
  const [nwAcc, setNwAcc] = useState({ label: '', bank: '' });
  const [entry, setEntry] = useState({
    accountId: '',
    kind: 'DESPESA',
    amount: '',
    description: '',
    toAccountId: '',
  });
  const reais = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
  const nowLocal = () => {
    const d = new Date(Date.now() - 3 * 3600_000);
    return d.toISOString().slice(0, 16);
  };
  return (
    <div className="space-y-2 text-xs" data-testid="goals-accounts">
      {b.accounts.map((a) => {
        const s = snap[a.id];
        return (
          <div
            key={a.id}
            className="rounded-xl border border-line bg-white p-2"
            data-testid="cash-account"
          >
            <div className="flex justify-between gap-1">
              <b>
                {a.label} ({a.bank}){a.isDefault ? ' · conta padrão' : ''}
              </b>
              <Money
                cents={a.balanceCents}
                onClick={() =>
                  open({ title: `Lançamentos da conta ${a.label}`, query: `accountId=${a.id}` })
                }
              />
            </div>
            <div className="text-ink-soft">
              Fonte:{' '}
              {a.source === 'EXTRATO'
                ? 'extrato importado (conciliado com o financeiro)'
                : 'registros oficiais do financeiro'}
              {a.snapshot
                ? ` · saldo informado ${brlCents(a.snapshot.amountCents)} em ${fmtDateTime(a.snapshot.takenAt)}${a.snapshot.by ? ` por ${a.snapshot.by}` : ''}`
                : ' · sem saldo informado'}
            </div>
            <div className="text-ink-muted" data-testid="cash-last-update">
              Última atualização: {a.lastUpdate.at ? fmtDateTime(a.lastUpdate.at) : '—'} ·{' '}
              {a.lastUpdate.origin}
            </div>
            {canManage ? (
              s ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  <input
                    className="w-28 rounded border px-1"
                    placeholder="Saldo (R$)"
                    value={s.amount}
                    onChange={(x) => setSnap({ ...snap, [a.id]: { ...s, amount: x.target.value } })}
                    aria-label="Saldo informado"
                    data-testid="snapshot-amount"
                  />
                  <input
                    type="datetime-local"
                    className="rounded border px-1"
                    value={s.at}
                    onChange={(x) => setSnap({ ...snap, [a.id]: { ...s, at: x.target.value } })}
                    aria-label="Data e hora do saldo"
                  />
                  <GBtn
                    className="!px-2 !py-0.5 text-xs"
                    tone="primary"
                    testId="snapshot-save"
                    onClick={async () => {
                      const r = await act(
                        '/api/v1/office/cash/snapshots',
                        {
                          accountId: a.id,
                          amountCents: reais(s.amount),
                          takenAt: `${s.at}:00-03:00`,
                        },
                        'Saldo registrado.',
                      );
                      if (r) setSnap({ ...snap, [a.id]: undefined as never });
                    }}
                  >
                    Registrar
                  </GBtn>
                </div>
              ) : (
                <div className="mt-1 flex flex-wrap gap-2">
                  <button
                    className="underline"
                    onClick={() => setSnap({ ...snap, [a.id]: { amount: '', at: nowLocal() } })}
                    data-testid="snapshot-new"
                  >
                    Informar saldo (com data e hora)
                  </button>
                  {!a.isDefault ? (
                    <button
                      className="underline"
                      onClick={() =>
                        act(
                          `/api/v1/office/cash/accounts/${a.id}`,
                          { isDefault: true },
                          'Conta padrão definida.',
                          'PUT',
                        )
                      }
                    >
                      Tornar padrão
                    </button>
                  ) : null}
                  <button
                    className="underline"
                    onClick={() =>
                      act(
                        `/api/v1/office/cash/accounts/${a.id}`,
                        { includedInCash: false },
                        'Conta fora do caixa.',
                        'PUT',
                      )
                    }
                  >
                    Tirar do caixa
                  </button>
                </div>
              )
            ) : null}
          </div>
        );
      })}
      {b.toReconcile.length ? (
        <div className="rounded-lg bg-warn-50 p-2 text-warn-600" data-testid="cash-to-reconcile">
          <b>A conciliar (não somam até ligar à linha do extrato):</b>
          {b.toReconcile.map((x) => (
            <div key={x.id}>
              {br(x.date)} · {x.description} · {signedBrl(x.amountCents)}
            </div>
          ))}
        </div>
      ) : null}
      {b.autoMatched.length ? (
        <div className="rounded-lg bg-info-50 p-2 text-info-600">
          {b.autoMatched.length} lançamento(s) manual(is) casado(s) com o extrato: contados uma vez.
          Confirme na conciliação do Banco.
        </div>
      ) : null}
      {canManage ? (
        <>
          <div
            className="rounded-xl border border-dashed border-line-strong p-2"
            data-testid="cash-entry-form"
          >
            <b>Registrar movimentação manual</b>{' '}
            <span className="text-ink-muted">(enquanto a integração não estiver disponível)</span>
            <div className="mt-1 flex flex-wrap gap-1">
              <select
                className="rounded border px-1"
                value={entry.kind}
                onChange={(x) => setEntry({ ...entry, kind: x.target.value })}
                aria-label="Tipo"
              >
                {[
                  ['RECEBIMENTO', 'Recebimento'],
                  ['DESPESA', 'Despesa'],
                  ['MATERIAL', 'Material'],
                  ['MAO_DE_OBRA', 'Mão de obra'],
                  ['TRANSFERENCIA', 'Transferência entre contas'],
                  ['APORTE', 'Aporte'],
                  ['RETIRADA', 'Retirada'],
                ].map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                className="rounded border px-1"
                value={entry.accountId}
                onChange={(x) => setEntry({ ...entry, accountId: x.target.value })}
                aria-label="Conta"
              >
                <option value="">Conta…</option>
                {b.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              {entry.kind === 'TRANSFERENCIA' ? (
                <select
                  className="rounded border px-1"
                  value={entry.toAccountId}
                  onChange={(x) => setEntry({ ...entry, toAccountId: x.target.value })}
                  aria-label="Conta de destino"
                >
                  <option value="">Para…</option>
                  {b.accounts
                    .filter((a) => a.id !== entry.accountId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                </select>
              ) : null}
              <input
                className="w-24 rounded border px-1"
                placeholder="Valor (R$)"
                value={entry.amount}
                onChange={(x) => setEntry({ ...entry, amount: x.target.value })}
                aria-label="Valor"
              />
              <input
                className="flex-1 rounded border px-1"
                placeholder="Descrição"
                value={entry.description}
                onChange={(x) => setEntry({ ...entry, description: x.target.value })}
                aria-label="Descrição"
              />
              <GBtn
                className="!px-2 !py-0.5 text-xs"
                tone="primary"
                disabled={!entry.accountId || !entry.amount || entry.description.length < 2}
                testId="cash-entry-save"
                onClick={async () => {
                  const r = await act(
                    '/api/v1/office/cash/entries',
                    {
                      accountId: entry.accountId,
                      kind: entry.kind,
                      amountCents: reais(entry.amount),
                      description: entry.description,
                      ...(entry.kind === 'TRANSFERENCIA' ? { toAccountId: entry.toAccountId } : {}),
                    },
                    'Movimentação registrada.',
                  );
                  if (r) setEntry({ ...entry, amount: '', description: '' });
                }}
              >
                Registrar
              </GBtn>
            </div>
            <p className="mt-1 text-ink-muted">
              Recebimentos de clientes, contas e mão de obra já entram pelos registros oficiais do
              financeiro: use o manual só para o que não passa por eles (aportes, retiradas,
              transferências, despesas sem conta).
            </p>
          </div>
          <div className="flex gap-1">
            <input
              className="flex-1 rounded border px-1"
              placeholder="Nova conta (ex.: Conta PJ)"
              value={nwAcc.label}
              onChange={(x) => setNwAcc({ ...nwAcc, label: x.target.value })}
            />
            <input
              className="w-32 rounded border px-1"
              placeholder="Banco"
              value={nwAcc.bank}
              onChange={(x) => setNwAcc({ ...nwAcc, bank: x.target.value })}
            />
            <GBtn
              className="!px-2 !py-0.5 text-xs"
              disabled={nwAcc.label.length < 2 || nwAcc.bank.length < 2}
              onClick={async () => {
                const r = await act(
                  '/api/v1/office/cash/accounts',
                  nwAcc,
                  'Conta incluída no caixa.',
                );
                if (r) setNwAcc({ label: '', bank: '' });
              }}
            >
              Incluir conta
            </GBtn>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface MovesResp {
  moves: CashMoveDto[];
  totalCents: number;
  base: {
    account: string;
    snapshot: { amountCents: number; takenAt: string; origin: string } | null;
  }[];
}

export function MovesPanel({
  drill,
  onBack,
  onClose,
  canManage,
}: {
  drill: Drill;
  onBack: () => void;
  onClose: () => void;
  canManage: boolean;
}) {
  const params = new URLSearchParams(drill.query);
  const sign = params.get('sign');
  params.delete('sign');
  const q = useQuery({
    queryKey: ['office-cash-moves', drill.query],
    queryFn: () => api<MovesResp>(`/api/v1/office/cash/moves?${params.toString()}`),
  });
  const act = useAct();
  const [reason, setReason] = useState<Record<string, string>>({});
  const moves = (q.data?.moves ?? []).filter((m) =>
    sign === 'in'
      ? m.amountCents > 0 && m.kind !== 'TRANSFERENCIA'
      : sign === 'out'
        ? m.amountCents < 0 && m.kind !== 'TRANSFERENCIA'
        : true,
  );
  const total = moves.reduce((s, m) => s + m.amountCents, 0);
  return (
    <Panel
      title="Lançamentos"
      subtitle={drill.title}
      icon="🧾"
      onClose={onClose}
      testId="cash-moves"
      className="h-full"
      actions={
        <GBtn tone="ghost" onClick={onBack}>
          ← Quadro
        </GBtn>
      }
    >
      {drill.note ? <p className="mb-1 text-xs text-ink-soft">{drill.note}</p> : null}
      {!drill.query && q.data ? (
        <div className="mb-2 rounded-lg bg-subtle p-1.5 text-xs">
          Saldos informados (ponto de partida):{' '}
          {q.data.base
            .map(
              (x) =>
                `${x.account}: ${x.snapshot ? `${brlCents(x.snapshot.amountCents)} em ${fmtDateTime(x.snapshot.takenAt)}` : 'não informado'}`,
            )
            .join(' · ')}
        </div>
      ) : null}
      <div className="mb-1 text-xs">
        {moves.length} lançamento(s) · soma <b data-testid="cash-moves-total">{signedBrl(total)}</b>
      </div>
      <ul className="space-y-1 text-xs" data-testid="cash-moves-list">
        {moves.map((m) => (
          <li
            key={m.id}
            className="rounded-lg border border-line bg-white p-1.5"
            data-testid="cash-move"
          >
            <div className="flex justify-between gap-2">
              <span>
                {br(m.date)} · {m.accountLabel}
              </span>
              <b className={m.amountCents >= 0 ? 'text-ok-600' : 'text-danger-700'}>
                {signedBrl(m.amountCents)}
              </b>
            </div>
            <div>
              <b>{m.category}</b> — {m.description}
              {m.kind !== 'OPERACAO' ? (
                <span className="ml-1 rounded bg-info-50 px-1 text-info-600">
                  {m.kind === 'TRANSFERENCIA'
                    ? 'transferência (não altera o total)'
                    : m.kind === 'APORTE'
                      ? 'aporte'
                      : 'retirada'}
                </span>
              ) : null}
              {m.reversal ? (
                <span className="ml-1 rounded bg-warn-50 px-1 text-warn-600">estorno/correção</span>
              ) : null}
            </div>
            <div className="text-ink-muted">
              Origem: {m.sourceLabel}
              {m.links.map((l) => (
                <a
                  key={l.type + l.id}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1 text-brand-700 underline"
                >
                  {l.label}
                </a>
              ))}
            </div>
            {m.note ? <div className="text-ink-soft">{m.note}</div> : null}
            {canManage && m.source === 'MANUAL' && !m.reversal ? (
              <div className="mt-0.5 flex gap-1">
                <input
                  className="flex-1 rounded border px-1"
                  placeholder="Motivo do estorno"
                  value={reason[m.id] ?? ''}
                  onChange={(x) => setReason({ ...reason, [m.id]: x.target.value })}
                />
                <GBtn
                  className="!px-2 !py-0.5 text-xs"
                  tone="ghost"
                  disabled={(reason[m.id] ?? '').length < 3}
                  onClick={() =>
                    act(
                      `/api/v1/office/cash/entries/${m.id.replace('man:', '')}/reverse`,
                      { reason: reason[m.id] },
                      'Lançamento estornado (o original fica no histórico).',
                    )
                  }
                >
                  Estornar
                </GBtn>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
