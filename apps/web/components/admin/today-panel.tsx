'use client';

import { plural, type Permission, type TodayDeadlineDto, type TodayDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  Hammer,
  Lightbulb,
  PackageCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';

/**
 * Reformulação, Fase 4 — "Hoje" no Início: o que está acontecendo agora, quem está na oficina,
 * peças prontas aguardando entrega, pendências, alertas internos e ações sugeridas.
 * Somente leitura: as sugestões explicam o porquê e levam à tela certa; nada é executado daqui.
 * Nenhum valor financeiro aparece (a rota não devolve nenhum).
 */
export const useToday = (enabled = true) =>
  useQuery({
    queryKey: ['today'],
    queryFn: () => api<TodayDto>('/api/v1/management/today'),
    enabled,
    refetchInterval: 60_000,
  });

const hhmm = (iso: string | null) => (iso ? formatTime(iso) : '—');

function Section({
  icon,
  title,
  count,
  children,
  testid,
  countTestId,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
  testid: string;
  countTestId?: string;
}) {
  // Melhoria 138: o mesmo cartão dos números do Início (título em cima, número grande embaixo).
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-5" data-testid={testid}>
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
          <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">{icon}</span>
          {title}
        </h3>
        {count !== undefined && (
          <p
            className="mt-3 text-3xl font-semibold tracking-tight tabular-nums"
            data-testid={countTestId}
          >
            {count}
          </p>
        )}
      </div>
      {children}
    </Card>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-ink-muted">{children}</p>
);

export function TodayPanel({ deadlines }: { deadlines?: React.ReactNode } = {}) {
  const can = useCan();
  const enabled = (
    [
      'os.ver',
      'producao.ver',
      'producao.planejar',
      'presenca.ver',
      'presenca.gerenciar',
      'entregas.ver',
      'entregas.gerenciar',
      'ocorrencias.ver',
    ] as Permission[]
  ).some((p) => can(p));
  const q = useToday(enabled);
  if (!enabled) return null;
  if (q.isPending) return <Spinner />;
  if (q.isError) return null;
  const t = q.data;
  // O bloco de prazos já mostra os avisos de prazo: no cartão de alertas ficam os demais.
  const alerts = t.deadlines
    ? t.alerts.filter((a) => a.kind !== 'PRAZO_PROXIMO' && a.kind !== 'PRAZO_EM_RISCO')
    : t.alerts;
  // Tudo zerado: uma frase no lugar de vários zeros.
  const allClear =
    t.suggestions.length === 0 &&
    alerts.length === 0 &&
    (t.deadlines?.length ?? 0) === 0 &&
    (t.inExecution?.length ?? 0) === 0 &&
    (t.readyPieces?.length ?? 0) === 0 &&
    (t.pendencies?.total ?? 0) === 0;

  return (
    <section className="space-y-4" data-testid="today-panel" aria-labelledby="today-title">
      <h2 id="today-title" className="text-xl font-semibold tracking-tight">
        Hoje
      </h2>

      {t.suggestions.length > 0 && (
        <Card className="space-y-3 p-5" data-testid="today-suggestions">
          <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
            <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">
              <Lightbulb className="size-4" aria-hidden />
            </span>
            Ações sugeridas hoje
          </h3>
          <ul className="divide-y divide-line">
            {t.suggestions.map((s) => (
              <li
                key={s.key}
                className="py-2.5 first:pt-0 last:pb-0"
                data-testid="today-suggestion"
              >
                <Link
                  href={s.link}
                  className="group flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium group-hover:underline">{s.title}</span>
                    <span className="block text-sm text-ink-muted">{s.why}</span>
                  </span>
                  {s.priority === 'ALTA' && <Badge tone="warn">Prioridade</Badge>}
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">
            Sugestões só indicam o caminho: nada é alterado até você decidir na tela indicada.
          </p>
        </Card>
      )}

      {t.deadlines && t.deadlines.length > 0 && <DeliveryDeadlines list={t.deadlines} />}

      {allClear && (
        <Card className="flex items-center gap-3 p-5" data-testid="today-all-clear">
          <span className="rounded-lg bg-ok-50 p-1.5 text-ok-600">
            <CheckCircle2 className="size-4" aria-hidden />
          </span>
          <p className="font-medium">
            Tudo em dia hoje.
            {t.present && t.present.total > 0 && (
              <span className="font-normal text-ink-muted">
                {' '}
                {plural(t.present.total, 'pessoa', 'pessoas')} na oficina.
              </span>
            )}
          </p>
          {t.pendencies && (
            <span className="sr-only" data-testid="dashboard-attention-total">
              0
            </span>
          )}
          {deadlines && <div className="ml-auto">{deadlines}</div>}
        </Card>
      )}

      {!allClear && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {t.inExecution && (
            <Section
              icon={<Hammer className="size-4" aria-hidden />}
              title="Em execução"
              count={t.inExecution.length}
              testid="today-in-execution"
            >
              {t.inExecution.length === 0 ? (
                <Empty>Nenhum serviço em andamento agora.</Empty>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {t.inExecution.slice(0, 6).map((x) => (
                    <li key={x.taskId} className="flex items-baseline gap-2">
                      <Link
                        href={`/painel/os/${x.serviceOrder.id}?tab=producao`}
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        <span className="font-mono text-xs font-semibold">
                          {x.serviceOrder.code}
                        </span>{' '}
                        {x.title}
                      </Link>
                      <span className="shrink-0 text-ink-muted">
                        {x.assignee ?? '—'}
                        {x.status === 'PAUSADA' && ' · pausada'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {t.present && (
            <Section
              icon={<Users className="size-4" aria-hidden />}
              title="Na oficina"
              count={t.present.total}
              testid="today-present"
            >
              {t.present.total === 0 ? (
                <Empty>Ninguém com chegada registrada ainda.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {t.present.people.slice(0, 8).map((p) => (
                    <li key={p.displayName} className="flex justify-between gap-2">
                      <span className="truncate">{p.displayName}</span>
                      <span className="text-ink-muted tabular-nums">desde {hhmm(p.arrivedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {t.readyPieces && (
            <Section
              icon={<PackageCheck className="size-4" aria-hidden />}
              title="Prontas aguardando entrega"
              count={t.readyPieces.length}
              testid="today-ready"
            >
              {t.readyPieces.length === 0 ? (
                <Empty>Nenhuma peça pronta parada.</Empty>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {t.readyPieces.slice(0, 6).map((r) => (
                    <li key={r.itemId} className="flex items-baseline gap-2">
                      <Link
                        href={`/painel/os/${r.serviceOrderId}?tab=qualidade`}
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        <span className="font-mono text-xs font-semibold">{r.code}</span>{' '}
                        {r.description} · {r.customer}
                      </Link>
                      <span className="shrink-0 text-ink-muted tabular-nums">
                        {r.days === 0 ? 'hoje' : `${r.days} d`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {t.pendencies && (
            <Section
              icon={<TriangleAlert className="size-4" aria-hidden />}
              title="Pendências"
              count={t.pendencies.total}
              testid="today-pendencies"
              countTestId="dashboard-attention-total"
            >
              {deadlines}
              {t.pendencies.top.length === 0 ? (
                <Empty>Nada pedindo ação.</Empty>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {t.pendencies.top.map((p, i) => (
                    <li key={`${p.link}-${i}`}>
                      <Link href={p.link} className="hover:underline">
                        {p.category === 'CRITICO' && (
                          <span className="mr-1 font-semibold text-danger-600">Crítico ·</span>
                        )}
                        {p.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href="/painel/atencao"
                className="mt-auto text-sm text-brand-700 hover:underline"
              >
                Abrir a Central de atenção
              </Link>
            </Section>
          )}
        </div>
      )}

      {alerts.length > 0 && (
        <Card className="space-y-2 p-5" data-testid="today-alerts">
          <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
            <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">
              <BellRing className="size-4" aria-hidden />
            </span>
            Alertas internos
          </h3>
          <ul className="space-y-1.5 text-sm">
            {alerts.map((a, i) => (
              <li key={`${a.kind}-${i}`} data-testid="today-alert" data-kind={a.kind}>
                <Link href={a.link} className="hover:underline">
                  <span className="font-medium">{a.title}:</span> {a.body}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dayLabel = (iso: string) =>
  `${WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const LATE = new Set(['ATRASADO', 'PRAZO_VENCIDO']);

/**
 * 2026-11-18: serviços com entrega combinada nos próximos 7 dias (ou já vencida) — OS e pedidos
 * que ainda não viraram OS —, para o gestor agir pelo menos uma semana antes.
 */
function DeliveryDeadlines({ list }: { list: TodayDeadlineDto[] }) {
  const late = list.filter((d) => LATE.has(d.state)).length;
  return (
    <Card className="space-y-3 p-5" data-testid="today-deadlines">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex flex-1 items-center gap-2 text-sm font-medium text-ink-muted">
          <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">
            <CalendarClock className="size-4" aria-hidden />
          </span>
          Entregas da próxima semana
        </h3>
        {late > 0 && <Badge tone="danger">{plural(late, 'atrasado', 'atrasados')}</Badge>}
      </div>
      <ul className="divide-y divide-line">
        {list.map((d) => {
          const isLate = LATE.has(d.state);
          return (
            <li key={`${d.kind}-${d.id}`} data-testid="today-deadline" data-state={d.state}>
              <Link
                href={d.link}
                className="group flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
              >
                <span
                  className={`w-20 shrink-0 text-sm font-semibold tabular-nums ${isLate ? 'text-danger-600' : d.days <= 2 ? 'text-warn-600' : 'text-ink-soft'}`}
                >
                  {dayLabel(d.promisedDate)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium group-hover:underline">
                    <span className="font-mono text-xs font-semibold">{d.code}</span> {d.customer}
                  </span>
                  {d.reasons.length > 0 && (
                    <span className="block truncate text-sm text-ink-muted">
                      {d.reasons.join(' · ')}
                    </span>
                  )}
                </span>
                <span className="flex w-full shrink-0 items-center gap-2 pl-[5.75rem] sm:w-auto sm:pl-0">
                  <span className="text-sm text-ink-muted tabular-nums">
                    {d.days < 0
                      ? `${plural(-d.days, 'dia', 'dias')} de atraso`
                      : d.days === 0
                        ? 'hoje'
                        : `em ${plural(d.days, 'dia', 'dias')}`}
                  </span>
                  <Badge tone={isLate ? 'danger' : d.state === 'EM_RISCO' ? 'warn' : 'neutral'}>
                    {d.stateLabel}
                  </Badge>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-ink-muted">
        O sininho também avisa quando um serviço entra nesta lista.
      </p>
    </Card>
  );
}
