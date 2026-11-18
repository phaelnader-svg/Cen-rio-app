'use client';

import { formatCents } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Card } from '@/components/ui/misc';
import { api } from '@/lib/api';

interface ChartsDto {
  cash: { weekStart: string; inCents: number; outCents: number }[] | null;
  stages: { key: string; label: string; pieces: number }[] | null;
  quotes: { month: string; sent: number; approved: number }[] | null;
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
const shortMoney = (cents: number) => {
  const v = cents / 100;
  if (Math.abs(v) >= 1000)
    return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
};
const KEY = 'inicio-graficos-aberto';

/**
 * 2026-11-18 (Raphael): gráficos no Início, poucos e organizados. Cada um só aparece para quem pode
 * ver o assunto; a seção recolhe (e lembra a escolha neste aparelho).
 */
export function HomeCharts() {
  const q = useQuery({
    queryKey: ['inicio-graficos'],
    queryFn: () => api<ChartsDto>('/api/v1/management/charts'),
    staleTime: 5 * 60_000,
  });
  // A seção só aparece depois dos dados (no navegador), então ler a preferência aqui é seguro.
  const [open, setOpen] = useState(() => {
    try {
      return typeof window === 'undefined' || localStorage.getItem(KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY, o ? '0' : '1');
      } catch {
        /* ignora */
      }
      return !o;
    });
  };
  const d = q.data;
  if (!d || (!d.cash && !d.stages && !d.quotes)) return null;
  return (
    <section data-testid="home-charts">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-[0.12em] text-ink-muted uppercase hover:text-ink"
      >
        Gráficos
        <ChevronDown className={clsx('size-4 transition', !open && '-rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className="grid gap-4 lg:grid-cols-3">
          {d.cash && (
            <ChartCard title="Entrou e saiu" subtitle="Últimas 8 semanas" href="/painel/financeiro">
              <GroupedBars
                series={[
                  { label: 'Entrou', color: 'var(--color-chart-1)' },
                  { label: 'Saiu', color: 'var(--color-chart-2)' },
                ]}
                groups={d.cash.map((w) => ({
                  label: ddmm(w.weekStart),
                  title: `Semana de ${ddmm(w.weekStart)}`,
                  values: [w.inCents, w.outCents],
                }))}
                format={(v) => formatCents(v)}
                axisFormat={shortMoney}
              />
            </ChartCard>
          )}
          {d.stages && (
            <ChartCard title="Peças por etapa" subtitle="Agora" href="/painel/pedidos">
              <StageBars rows={d.stages} />
            </ChartCard>
          )}
          {d.quotes && (
            <ChartCard
              title="Orçamentos"
              subtitle="Últimos 6 meses"
              href="/painel/orcamentos?aba=salvos"
            >
              <GroupedBars
                series={[
                  { label: 'Enviados', color: 'var(--color-chart-2)' },
                  { label: 'Aprovados', color: 'var(--color-chart-1)' },
                ]}
                groups={d.quotes.map((m) => ({
                  label: monthLabel(m.month),
                  title: monthLabel(m.month),
                  values: [m.sent, m.approved],
                }))}
                format={(v) => String(v)}
                axisFormat={(v) => String(v)}
              />
            </ChartCard>
          )}
        </div>
      )}
    </section>
  );
}

function ChartCard({
  title,
  subtitle,
  href,
  children,
}: {
  title: string;
  subtitle: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-5">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-ink">{title}</h3>
        <Link href={href} className="text-xs text-ink-muted hover:text-ink hover:underline">
          {subtitle}
        </Link>
      </div>
      {children}
    </Card>
  );
}

/** Teto "redondo" do eixo (1, 2, 2,5 ou 5 × 10ⁿ). */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function GroupedBars({
  series,
  groups,
  format,
  axisFormat,
}: {
  series: { label: string; color: string }[];
  groups: { label: string; title: string; values: number[] }[];
  format: (v: number) => string;
  axisFormat: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...groups.flatMap((g) => g.values)));
  const H = 140;
  const ticks = [max, max / 2, 0];
  const g = hover !== null ? groups[hover] : null;
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-4 text-xs text-ink-soft">
        {series.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="relative flex gap-2">
        <div
          className="flex flex-col justify-between text-right text-[11px] text-ink-muted tabular-nums"
          style={{ height: H }}
          aria-hidden
        >
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {axisFormat(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            className="absolute inset-x-0 top-0 flex flex-col justify-between"
            style={{ height: H }}
            aria-hidden
          >
            {ticks.map((t) => (
              <div key={t} className="border-t border-line" />
            ))}
          </div>
          <div className="relative flex items-end" style={{ height: H }} role="list">
            {groups.map((grp, gi) => (
              <div
                key={grp.label + gi}
                role="listitem"
                aria-label={`${grp.title}: ${series.map((s, i) => `${s.label} ${format(grp.values[i] ?? 0)}`).join(', ')}`}
                className={clsx(
                  'flex h-full flex-1 items-end justify-center gap-0.5 rounded-t-md px-0.5',
                  hover === gi && 'bg-subtle',
                )}
                onMouseEnter={() => setHover(gi)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(gi)}
                onBlur={() => setHover(null)}
                tabIndex={0}
              >
                {grp.values.map((v, i) => (
                  <div
                    key={i}
                    className="w-full max-w-3.5 rounded-t-[4px]"
                    style={{
                      height: v > 0 ? Math.max(2, (v / max) * H) : 0,
                      background: series[i]!.color,
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex text-[11px] text-ink-muted">
            {groups.map((grp, gi) => (
              <span key={grp.label + gi} className="flex-1 text-center">
                {grp.label}
              </span>
            ))}
          </div>
          {g && hover !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 min-w-36 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow-card)]"
              style={{
                left: `${((hover + 0.5) / groups.length) * 100}%`,
                transform: `translate(${hover > groups.length / 2 ? '-100%' : '0'}, -100%)`,
              }}
            >
              <p className="mb-1 font-semibold text-ink">{g.title}</p>
              {series.map((s, i) => (
                <p key={s.label} className="flex items-center justify-between gap-3 text-ink-soft">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-sm"
                      style={{ background: s.color }}
                      aria-hidden
                    />
                    {s.label}
                  </span>
                  <span className="font-medium text-ink tabular-nums">
                    {format(g.values[i] ?? 0)}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StageBars({ rows }: { rows: { key: string; label: string; pieces: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.pieces));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label}: ${r.pieces} ${r.pieces === 1 ? 'peça' : 'peças'}`}>
          <div className="flex justify-between text-sm">
            <span className="text-ink-soft">{r.label}</span>
            <span className="font-semibold text-ink tabular-nums">{r.pieces}</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-subtle">
            <div
              className="h-2 rounded-full"
              style={{
                width: r.pieces ? `${Math.max(2, (r.pieces / max) * 100)}%` : 0,
                background: 'var(--color-chart-1)',
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
