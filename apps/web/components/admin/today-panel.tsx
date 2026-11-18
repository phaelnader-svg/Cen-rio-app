'use client';

import { plural, type Permission, type TodayDeadlineDto, type TodayDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
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

/** Linha extra do "Precisa de você hoje", montada no Início a partir de outras contagens. */
export interface TodayExtra {
  key: string;
  title: string;
  why?: string;
  link: string;
  tone?: 'danger' | 'warn';
}

/**
 * Revisão geral (2026-11-18): o "Hoje" virou um cartão só, "Precisa de você hoje", com as
 * sugestões, as pendências, os alertas e as contagens que pedem ação — antes eram quatro quadros
 * que repetiam o mesmo número. As entregas da semana continuam logo abaixo.
 */
export function TodayPanel({
  deadlines,
  extra = [],
}: { deadlines?: React.ReactNode; extra?: TodayExtra[] } = {}) {
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
  // O bloco de prazos já mostra os avisos de prazo: aqui ficam os demais.
  const alerts = t.deadlines
    ? t.alerts.filter((a) => a.kind !== 'PRAZO_PROXIMO' && a.kind !== 'PRAZO_EM_RISCO')
    : t.alerts;
  // Uma linha por assunto: a sugestão que aponta para a mesma tela de uma pendência fica só uma vez.
  const seen = new Set(t.suggestions.map((s) => s.link));
  const pendencies = (t.pendencies?.top ?? []).filter((p) => !seen.has(p.link));
  const extras = extra;
  const lines = t.suggestions.length + pendencies.length + alerts.length + extras.length;

  return (
    <section className="space-y-4" data-testid="today-panel" aria-labelledby="today-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="today-title" className="text-xl font-semibold tracking-tight">
          Precisa de você hoje
        </h2>
        {t.present && t.present.total > 0 && (
          <Link
            href="/painel/presenca"
            className="text-sm text-ink-muted hover:underline"
            data-testid="today-present"
          >
            {plural(t.present.total, 'pessoa', 'pessoas')} na oficina
          </Link>
        )}
      </div>

      {lines === 0 ? (
        <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="today-all-clear">
          <span className="rounded-lg bg-ok-50 p-1.5 text-ok-600">
            <CheckCircle2 className="size-4" aria-hidden />
          </span>
          <p className="font-medium">Tudo em dia hoje.</p>
          {t.pendencies && (
            <span className="sr-only" data-testid="dashboard-attention-total">
              {t.pendencies.total}
            </span>
          )}
          {deadlines && <div className="ml-auto">{deadlines}</div>}
        </Card>
      ) : (
        <Card className="p-5" data-testid="today-suggestions">
          {t.pendencies && (
            <span className="sr-only" data-testid="dashboard-attention-total">
              {t.pendencies.total}
            </span>
          )}
          <ul className="divide-y divide-line">
            {t.suggestions.map((s) => (
              <Line
                key={s.key}
                testid="today-suggestion"
                href={s.link}
                title={s.title}
                why={s.why}
                badge={s.priority === 'ALTA' ? <Badge tone="warn">Prioridade</Badge> : null}
              />
            ))}
            {pendencies.map((p, i) => (
              <Line
                key={`${p.link}-${i}`}
                testid="today-pendency"
                href={p.link}
                title={p.title}
                badge={p.category === 'CRITICO' ? <Badge tone="danger">Atrasado</Badge> : null}
              />
            ))}
            {extras.map((x) => (
              <Line
                key={x.key}
                testid={`today-extra-${x.key}`}
                href={x.link}
                title={x.title}
                why={x.why}
                badge={
                  x.tone ? (
                    <Badge tone={x.tone}>{x.tone === 'danger' ? 'Atrasado' : 'Atenção'}</Badge>
                  ) : null
                }
              />
            ))}
            {alerts.map((a, i) => (
              <Line
                key={`${a.kind}-${i}`}
                testid="today-alert"
                kind={a.kind}
                href={a.link}
                title={a.title}
                why={a.body}
              />
            ))}
          </ul>
          {deadlines && <div className="mt-3 border-t border-line pt-3">{deadlines}</div>}
        </Card>
      )}

      {t.deadlines && t.deadlines.length > 0 && <DeliveryDeadlines list={t.deadlines} />}
    </section>
  );
}

function Line({
  href,
  title,
  why,
  badge,
  testid,
  kind,
}: {
  href: string;
  title: string;
  why?: string;
  badge?: React.ReactNode;
  testid: string;
  kind?: string;
}) {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0" data-testid={testid} data-kind={kind}>
      <Link href={href} className="group flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg">
        <span className="min-w-0 flex-1">
          <span className="block font-medium group-hover:underline">{title}</span>
          {why && <span className="block text-sm text-ink-muted">{why}</span>}
        </span>
        {badge}
        <ArrowRight className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden />
      </Link>
    </li>
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
    </Card>
  );
}
