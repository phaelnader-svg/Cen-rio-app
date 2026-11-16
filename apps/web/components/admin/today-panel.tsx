'use client';

import type { Permission, TodayDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { BellRing, Hammer, Lightbulb, PackageCheck, TriangleAlert, Users } from 'lucide-react';
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
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-5" data-testid={testid}>
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">{icon}</span>
        {title}
        {count !== undefined && (
          <span className="ml-auto text-lg font-semibold text-ink tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </Card>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-ink-muted">{children}</p>
);

export function TodayPanel() {
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
                      <span className="font-mono text-xs font-semibold">{x.serviceOrder.code}</span>{' '}
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
          >
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
            <Link href="/painel/atencao" className="mt-auto text-sm text-brand-700 hover:underline">
              Abrir a Central de atenção
            </Link>
          </Section>
        )}
      </div>

      {t.alerts.length > 0 && (
        <Card className="space-y-2 p-5" data-testid="today-alerts">
          <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
            <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">
              <BellRing className="size-4" aria-hidden />
            </span>
            Alertas internos
          </h3>
          <ul className="space-y-1.5 text-sm">
            {t.alerts.map((a, i) => (
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
