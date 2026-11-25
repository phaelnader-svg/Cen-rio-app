'use client';

import {
  NEXT_STEP_LABEL,
  OPERATIONAL_STATE_LABEL,
  SERVICE_TYPE_LABEL,
  type FinanceDashboardDto,
  type NotificationDto,
  type ShopFloorDto,
  type ShopFloorServiceDto,
  type TodayDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Bot,
  ChevronRight,
  CircleCheckBig,
  CirclePause,
  CirclePlay,
  House,
  Settings,
  Wallet,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentCard, ProposalCard, useOffice, useOfficeSend } from '@/components/office/office-page';
import { InstallBanner, PushCard } from '@/components/tablet/install';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Spinner } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { brDate, money } from '@/lib/finance';
import { formatHourMinute, relativeTime } from '@/lib/format';
import { useMe } from '@/lib/hooks';

/**
 * App do dono (2026-11-25, pedido do Raphael): simples, sem a cara do sistema da web. Quatro telas
 * (Hoje, Aprovar, Oficina, Dinheiro) e "O que a IA pode fazer". Só lê das rotas que o painel já usa
 * (Início, Hoje na oficina, Financeiro, Escritório, sininho): nada é calculado duas vezes.
 */

type Tab = 'hoje' | 'aprovar' | 'oficina' | 'dinheiro' | 'ia';
const TABS: { key: Exclude<Tab, 'ia'>; label: string; icon: typeof House }[] = [
  { key: 'hoje', label: 'Hoje', icon: House },
  { key: 'aprovar', label: 'Aprovar', icon: CircleCheckBig },
  { key: 'oficina', label: 'Oficina', icon: Wrench },
  { key: 'dinheiro', label: 'Dinheiro', icon: Wallet },
];

function readTab(): Tab {
  if (typeof window === 'undefined') return 'hoje';
  const h = window.location.hash.replace('#', '');
  return (['hoje', 'aprovar', 'oficina', 'dinheiro', 'ia'] as const).includes(h as Tab)
    ? (h as Tab)
    : 'hoje';
}

const LIVE = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;

export function DonoApp() {
  const me = useMe();
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(null, '', t === 'hoje' ? '/dono' : `/dono#${t}`);
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    // O app instalado do dono tem o próprio manifesto (abre em /dono) e o próprio service worker.
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]'))
      link.setAttribute('href', '/dono/manifest');
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production')
      void navigator.serviceWorker.register('/sw.js', { scope: '/dono' }).catch(() => undefined);
  }, []);

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) window.location.replace('/entrar?proximo=/dono');
  }, [unauthenticated]);

  const perms = new Set(me.data?.permissions ?? []);
  const web = me.data?.session.kind === 'WEB';
  const office = useOffice();
  const officeOk = office.isSuccess;
  const seesMoney = perms.has('financeiro.ver');

  if (me.isPending || unauthenticated)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  if (!web)
    return (
      <main className="mx-auto max-w-md p-8">
        <Alert tone="warn" title="Este é o app do dono">
          Entre com o seu e-mail e senha. O app da equipe fica em /tablet.
        </Alert>
      </main>
    );

  const tabs = TABS.filter(
    (t) => (t.key !== 'aprovar' || officeOk) && (t.key !== 'dinheiro' || seesMoney),
  );
  const pending = office.data?.pending.filter((p) => !p.suggestion).length ?? 0;
  const firstName = me.data!.user.displayName.split(' ')[0];

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col bg-canvas" data-testid="dono-app">
      <main className="flex-1 px-4 pt-[max(env(safe-area-inset-top),16px)] pb-28">
        {tab === 'hoje' && (
          <Hoje
            name={firstName ?? ''}
            pending={officeOk ? pending : null}
            onApprove={() => setTab('aprovar')}
            onIa={officeOk ? () => setTab('ia') : null}
          />
        )}
        {tab === 'aprovar' && <Aprovar />}
        {tab === 'oficina' && <Oficina />}
        {tab === 'dinheiro' && seesMoney && <Dinheiro />}
        {tab === 'ia' && <Ia onBack={() => setTab('hoje')} />}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
        aria-label="Telas"
      >
        <ul
          className="mx-auto grid max-w-xl"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}
        >
          {tabs.map(({ key, label, icon: Icon }) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => setTab(key)}
                aria-current={tab === key ? 'page' : undefined}
                className={clsx(
                  'relative flex h-16 w-full flex-col items-center justify-center gap-0.5 text-xs font-semibold',
                  tab === key ? 'text-brand-700' : 'text-ink-muted',
                )}
              >
                <Icon className="size-6" aria-hidden />
                {label}
                {key === 'aprovar' && pending > 0 && (
                  <span className="absolute top-1.5 left-1/2 ml-1 rounded-full bg-danger-600 px-1.5 text-[11px] text-white">
                    {pending}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Title({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <header className="mb-4 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] leading-tight font-bold tracking-tight text-ink">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-ink-muted">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-6">
    <h2 className="mb-2 px-1 text-[13px] font-semibold text-ink-muted">{title}</h2>
    {children}
  </section>
);

const Box = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={clsx('rounded-2xl border border-line bg-surface', className)}>{children}</div>
);

function Row({
  left,
  right,
  dot,
}: {
  left: React.ReactNode;
  right?: React.ReactNode;
  dot?: 'ok' | 'danger' | 'brand' | 'warn';
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-[15px]">
      {dot && (
        <span
          aria-hidden
          className={clsx('size-2 shrink-0 rounded-full', {
            'bg-ok-600': dot === 'ok',
            'bg-danger-600': dot === 'danger',
            'bg-brand-600': dot === 'brand',
            'bg-warn-600': dot === 'warn',
          })}
        />
      )}
      <span className="min-w-0 flex-1 text-ink">{left}</span>
      {right !== undefined && <span className="shrink-0 text-sm text-ink-muted">{right}</span>}
    </li>
  );
}

function Num({ n, label, tone }: { n: number | string; label: string; tone?: 'danger' | 'ok' }) {
  return (
    <div
      className={clsx(
        'rounded-2xl border bg-surface p-3',
        tone === 'danger' && Number(n) > 0 ? 'border-danger-600/30' : 'border-line',
      )}
    >
      <b
        className={clsx(
          'block text-2xl font-bold tracking-tight',
          tone === 'danger' && Number(n) > 0 && 'text-danger-600',
          tone === 'ok' && 'text-ok-600',
        )}
      >
        {n}
      </b>
      <span className="mt-0.5 block text-xs leading-tight text-ink-muted">{label}</span>
    </div>
  );
}

const useToday = () =>
  useQuery({
    queryKey: ['management', 'today'],
    queryFn: () => api<TodayDto>('/api/v1/management/today'),
    ...LIVE,
  });
const useShopFloor = () =>
  useQuery({
    queryKey: ['shop-floor'],
    queryFn: () => api<ShopFloorDto>('/api/v1/shop-floor'),
    ...LIVE,
  });

function todayLabel() {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Hoje: o que espera você, a oficina em três números, o que aconteceu e o que vem por aí. */
function Hoje({
  name,
  pending,
  onApprove,
  onIa,
}: {
  name: string;
  pending: number | null;
  onApprove: () => void;
  onIa: (() => void) | null;
}) {
  const today = useToday();
  const floor = useShopFloor();
  const notes = useQuery({
    queryKey: ['notifications', 'dono'],
    queryFn: () =>
      api<{ items: NotificationDto[]; unread: number }>('/api/v1/notifications?limit=6'),
    ...LIVE,
  });
  const services = floor.data?.groups.flatMap((g) => g.services) ?? [];
  const late = services.filter((s) => s.late).length;
  const deliveriesToday = (today.data?.deadlines ?? []).filter((d) => d.days === 0).length;
  const upcoming = (today.data?.deadlines ?? []).filter((d) => d.days > 0).slice(0, 4);
  const bills = (today.data?.alerts ?? []).filter(
    (a) => a.kind === 'CONTA_A_VENCER' || a.kind === 'CONTA_VENCIDA',
  );

  return (
    <>
      <Title
        title={`${greeting()}, ${name}`}
        sub={todayLabel()}
        right={
          onIa && (
            <button
              type="button"
              onClick={onIa}
              aria-label="O que a IA pode fazer"
              className="grid size-11 place-items-center rounded-xl border border-line bg-surface text-ink-soft"
            >
              <Settings className="size-5" />
            </button>
          )
        }
      />
      <InstallBanner subtitle="Ícone na tela e aviso no celular a cada pedido da IA." />
      <div className="mt-3">
        <PushCard
          which="dono"
          text="Cada pedido da IA, conta vencendo e entrega chegando avisa no seu celular."
        />
      </div>
      {pending !== null && (
        <button
          type="button"
          onClick={onApprove}
          data-testid="dono-pedidos"
          className="flex w-full items-center gap-3 rounded-2xl bg-brand-700 p-4 text-left text-white"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/15">
            <Bot className="size-6" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-semibold">
              {pending === 0
                ? 'Nada esperando você'
                : pending === 1
                  ? '1 pedido esperando você'
                  : `${pending} pedidos esperando você`}
            </span>
            <span className="block text-sm text-brand-100">
              {pending === 0 ? 'Os agentes avisam quando precisarem' : 'Toque para aprovar'}
            </span>
          </span>
          <ChevronRight className="size-5" aria-hidden />
        </button>
      )}

      {floor.data && (
        <Section title="Hoje na oficina">
          <div className="grid grid-cols-3 gap-2">
            <Num n={floor.data.counts.started} label="serviços em produção" />
            <Num
              n={deliveriesToday}
              label={deliveriesToday === 1 ? 'entrega hoje' : 'entregas hoje'}
            />
            <Num n={late} label={late === 1 ? 'atrasado' : 'atrasados'} tone="danger" />
          </div>
        </Section>
      )}

      <Section title="O que aconteceu">
        {notes.data && notes.data.items.length > 0 ? (
          <Box>
            <ul className="divide-y divide-line">
              {notes.data.items.map((n) => (
                <Row
                  key={n.id}
                  dot={/ATRAS|VENCID|RISCO|PARADO|DEFEITO/.test(n.kind) ? 'danger' : 'ok'}
                  left={
                    <>
                      <span className="block font-medium">{n.title}</span>
                      <span className="block text-sm text-ink-soft">{n.body}</span>
                    </>
                  }
                  right={relativeTime(n.createdAt)}
                />
              ))}
            </ul>
          </Box>
        ) : (
          <Box className="p-4 text-sm text-ink-muted">Nada de novo por enquanto.</Box>
        )}
      </Section>

      {(upcoming.length > 0 || bills.length > 0) && (
        <Section title="Vem por aí">
          <Box>
            <ul className="divide-y divide-line">
              {upcoming.map((d) => (
                <Row
                  key={d.id}
                  dot={d.reasons.length ? 'warn' : 'brand'}
                  left={`Entrega · ${d.customer} · ${d.code}`}
                  right={d.days === 1 ? 'amanhã' : `em ${d.days} dias`}
                />
              ))}
              {bills.map((b) => (
                <Row
                  key={b.title + b.at}
                  dot={b.kind === 'CONTA_VENCIDA' ? 'danger' : 'warn'}
                  left={b.title}
                  right={b.body}
                />
              ))}
            </ul>
          </Box>
        </Section>
      )}
    </>
  );
}

/** Aprovar: os mesmos cartões do Escritório (mesma fila, mesmas regras). */
function Aprovar() {
  const office = useOffice();
  const pending = office.data?.pending ?? [];
  return (
    <>
      <Title
        title="Aprovar"
        sub={
          pending.length === 0
            ? 'Nada esperando você'
            : pending.length === 1
              ? '1 pedido da IA'
              : `${pending.length} pedidos da IA`
        }
      />
      {office.isPending && <Spinner />}
      {office.data?.paused && (
        <Alert tone="warn" className="mb-3">
          Tudo parado: os agentes só preparam e pedem sua aprovação.
        </Alert>
      )}
      {office.isSuccess && pending.length === 0 && (
        <EmptyState
          title="Tudo aprovado"
          description="Quando um agente precisar de você, o pedido aparece aqui e avisa no celular."
        />
      )}
      <div className="space-y-3">
        {pending.map((p) => (
          <ProposalCard key={p.id} p={p} />
        ))}
      </div>
    </>
  );
}

const shortName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : name;
};

function ServiceRow({ s, who }: { s: ShopFloorServiceDto; who: string | null }) {
  const stage = s.next ? NEXT_STEP_LABEL[s.next] : OPERATIONAL_STATE_LABEL[s.state];
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-ink">
          {s.code} · {s.pieces}
        </p>
        <p className="truncate text-sm text-ink-muted">
          {shortName(s.customer.name)} · {OPERATIONAL_STATE_LABEL[s.state]}
          {who ? ` · ${who}` : ''}
        </p>
      </div>
      {s.late ? (
        <span className="shrink-0 rounded-full bg-danger-50 px-2.5 py-0.5 text-xs font-semibold text-danger-600">
          atrasado
        </span>
      ) : s.stoppedDays !== null && s.stoppedDays >= 3 ? (
        <span className="shrink-0 rounded-full bg-warn-50 px-2.5 py-0.5 text-xs font-semibold text-warn-600">
          parado {s.stoppedDays} dias
        </span>
      ) : (
        <span className="shrink-0 text-sm text-ink-muted" title={stage}>
          {s.promisedDate ? brDate(s.promisedDate).slice(0, 5) : ''}
        </span>
      )}
    </li>
  );
}

/** Oficina: atrasados primeiro, depois cada um com o que está fazendo; quem está na oficina. */
function Oficina() {
  const floor = useShopFloor();
  const today = useToday();
  const all =
    floor.data?.groups.flatMap((g) =>
      g.services.map((s) => ({ s, who: g.upholsterer?.displayName ?? null })),
    ) ?? [];
  const late = all.filter((x) => x.s.late);
  const rest = all
    .filter((x) => !x.s.late)
    .sort((a, b) => (a.s.promisedDate ?? '9').localeCompare(b.s.promisedDate ?? '9'));
  const working = today.data?.inExecution ?? [];
  const present = today.data?.present;
  return (
    <>
      <Title title="Oficina" sub={floor.data ? `${all.length} serviços em andamento` : undefined} />
      {floor.isPending && <Spinner />}
      {late.length > 0 && (
        <Section title="Atrasados">
          <Box className="border-danger-600/30">
            <ul className="divide-y divide-line">
              {late.map((x) => (
                <ServiceRow key={x.s.id} s={x.s} who={x.who} />
              ))}
            </ul>
          </Box>
        </Section>
      )}
      {rest.length > 0 && (
        <Section title="Em andamento, pelo prazo">
          <Box>
            <ul className="divide-y divide-line">
              {rest.map((x) => (
                <ServiceRow key={x.s.id} s={x.s} who={x.who} />
              ))}
            </ul>
          </Box>
        </Section>
      )}
      {floor.isSuccess && all.length === 0 && (
        <EmptyState title="Nenhum serviço em andamento" description="A oficina está livre." />
      )}
      {present && (
        <Section title={`Na oficina agora (${present.total})`}>
          <Box>
            <ul className="divide-y divide-line">
              {present.people.map((p) => {
                const doing = working.find((w) => w.assignee === p.displayName);
                return (
                  <Row
                    key={p.displayName}
                    dot={doing ? 'ok' : 'brand'}
                    left={
                      doing
                        ? `${p.displayName} · ${doing.title} (${doing.serviceOrder.code})`
                        : p.displayName
                    }
                    right={
                      doing
                        ? doing.status === 'PAUSADA'
                          ? 'pausado'
                          : 'trabalhando'
                        : p.arrivedAt
                          ? `chegou ${formatHourMinute(p.arrivedAt)}`
                          : ''
                    }
                  />
                );
              })}
              {present.people.length === 0 && <Row left="Ninguém marcou chegada ainda." />}
            </ul>
          </Box>
        </Section>
      )}
    </>
  );
}

/** Dinheiro: o que entrou e saiu no mês, o que vem nos próximos dias e quem está atrasado. */
function Dinheiro() {
  const q = useQuery({
    queryKey: ['finance', 'dashboard', 'dono'],
    queryFn: () => api<FinanceDashboardDto>('/api/v1/finance/dashboard'),
    ...LIVE,
  });
  const d = q.data;
  const out = d ? d.cash.paidPayablesCents + d.cash.paidLaborCents : 0;
  const top = d?.topServices[0];
  const month = new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date());
  return (
    <>
      <Title title="Dinheiro" sub={`${month[0]!.toUpperCase()}${month.slice(1)} até hoje`} />
      {q.isPending && <Spinner />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Num n={money(d.cash.receivedCents)} label="Entrou" tone="ok" />
            <Num n={money(out)} label="Saiu" />
          </div>
          <Box className="mt-2 p-4">
            <p className="text-sm text-ink-muted">Sobrou no mês</p>
            <p
              className={clsx(
                'text-3xl font-bold tracking-tight',
                d.cash.netCents < 0 && 'text-danger-600',
              )}
            >
              {money(d.cash.netCents)}
            </p>
          </Box>
          <Section title="Em aberto">
            <Box>
              <ul className="divide-y divide-line">
                <Row left="A receber dos clientes" right={money(d.open.receivableCents)} />
                <Row left="A pagar" right={money(d.open.payableCents)} />
                {d.bills.upcoming.slice(0, 4).map((b) => (
                  <Row
                    key={b.id}
                    dot={b.days <= 1 ? 'warn' : 'brand'}
                    left={`${b.beneficiary || b.description}`}
                    right={`${money(b.openCents)} · ${
                      b.days === 0
                        ? 'hoje'
                        : b.days === 1
                          ? 'amanhã'
                          : brDate(b.dueDate).slice(0, 5)
                    }`}
                  />
                ))}
              </ul>
            </Box>
          </Section>
          {(d.open.receivableOverdueCents > 0 || d.bills.overdue.length > 0) && (
            <Section title="Atrasado">
              <Box className="border-danger-600/30">
                <ul className="divide-y divide-line">
                  {d.open.receivableOverdueCents > 0 && (
                    <Row
                      dot="danger"
                      left="Clientes que não pagaram"
                      right={money(d.open.receivableOverdueCents)}
                    />
                  )}
                  {d.bills.overdue.slice(0, 4).map((b) => (
                    <Row
                      key={b.id}
                      dot="danger"
                      left={`Conta: ${b.beneficiary || b.description}`}
                      right={`${money(b.openCents)} · ${-b.days} dias`}
                    />
                  ))}
                </ul>
              </Box>
            </Section>
          )}
          {top && top.revenueCents > 0 && (
            <Section title="Serviço que mais deu lucro">
              <Box className="p-4">
                <p className="font-semibold text-ink">
                  {SERVICE_TYPE_LABEL[top.serviceType as keyof typeof SERVICE_TYPE_LABEL] ??
                    top.serviceType}
                </p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-subtle">
                  <i
                    className="block h-full bg-brand-600"
                    style={{
                      width: `${Math.max(4, Math.min(100, (top.marginCents / top.revenueCents) * 100))}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-sm text-ink-muted">
                  {Math.round((top.marginCents / top.revenueCents) * 100)}% de lucro · {top.orders}{' '}
                  {top.orders === 1 ? 'serviço' : 'serviços'} no mês
                </p>
              </Box>
            </Section>
          )}
        </>
      )}
    </>
  );
}

/** O que a IA pode fazer: o nível de cada tarefa (mesmo controle do Escritório) e Parar tudo. */
function Ia({ onBack }: { onBack: () => void }) {
  const office = useOffice();
  const { m, error } = useOfficeSend();
  const data = office.data;
  return (
    <>
      <button type="button" onClick={onBack} className="mb-2 text-sm font-semibold text-brand-700">
        ← Voltar
      </button>
      <Title title="O que a IA pode fazer" sub="Você decide tarefa por tarefa" />
      {office.isPending && <Spinner />}
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {data && (
        <>
          <Button
            size="xl"
            className="mb-1 w-full"
            variant={data.paused ? 'primary' : 'outline-danger'}
            loading={m.isPending}
            icon={
              data.paused ? (
                <CirclePlay className="size-5" aria-hidden />
              ) : (
                <CirclePause className="size-5" aria-hidden />
              )
            }
            onClick={() =>
              m.mutate({
                ok: data.paused
                  ? 'Os agentes voltaram a trabalhar.'
                  : 'Tudo parado: agora tudo pede sua aprovação.',
                run: () =>
                  api('/api/v1/office/settings', { method: 'PUT', body: { paused: !data.paused } }),
              })
            }
          >
            {data.paused ? 'Voltar a trabalhar' : 'Parar tudo'}
          </Button>
          <p className="mb-4 text-center text-sm text-ink-muted">
            {data.paused
              ? 'Tudo está pedindo sua aprovação.'
              : 'Parar tudo faz todas as tarefas voltarem a pedir sua aprovação.'}
          </p>
          <div className="space-y-3">
            {data.agents
              .filter((a) => a.agentId && a.tasks.length > 0)
              .map((a) => (
                <AgentCard key={a.roleKey} a={a} />
              ))}
          </div>
          {data.agents.some((a) => !a.agentId) && (
            <p className="mt-4 text-center text-sm text-ink-muted">
              Para contratar outro agente, use o Escritório no computador.
            </p>
          )}
        </>
      )}
    </>
  );
}
