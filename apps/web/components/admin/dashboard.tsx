'use client';

import { plural, pluralWord } from '@cenario/shared';
import type { Permission, QuoteFunnelDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';

import {
  AlarmClock,
  Calculator,
  ClipboardPlus,
  Activity,
  ClipboardList,
  FileSignature,
  PackageCheck,
  Truck,
  ArrowRight,
  CheckCircle,
  MonitorSmartphone,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Avatar, Badge, Card, Spinner } from '@/components/ui/misc';
import { relativeTime } from '@/lib/format';
import { useCan, useMe } from '@/lib/hooks';
import { todayIso, useOrders, usePickups } from '@/lib/commercial';
import { useAttention } from '@/lib/issues';
import { money } from '@/lib/finance';
import { useDevices, useEmployees, useOverview, useRecentAudit, useSessions } from '@/lib/queries';
import { HomeCharts } from './home-charts';
import { TodayPanel } from './today-panel';

function greeting(timeZone: string) {
  const h = Number(
    new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
      new Date(),
    ),
  );
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function Stat({
  icon,
  label,
  value,
  detail,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  href?: string;
}) {
  const body = (
    <Card className="h-full p-5 transition-shadow hover:shadow-[var(--shadow-pop)]">
      <div className="flex items-center gap-2 text-sm font-medium text-ink-muted">
        <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">{icon}</span>
        {label}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-sm text-ink-muted">{detail}</p>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-2xl">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Dashboard() {
  const me = useMe();
  const can = useCan();
  const canQuotes = can('orcamentos.ver') || can('orcamentos.gerenciar');
  const funnel = useQuery({
    queryKey: ['quotes', 'funnel', 'inicio'],
    queryFn: () =>
      api<QuoteFunnelDto>(`/api/v1/quotes/funnel?from=${isoDaysAgo(90)}&to=${isoDaysAgo(-1)}`),
    enabled: canQuotes,
  });
  const approvedOpen = funnel.data
    ? Math.max(0, funnel.data.byStatus.APROVADO.count - funnel.data.converted.count)
    : null;
  const employees = useEmployees(can('funcionarios.ver'));
  const devices = useDevices(can('dispositivos.ver'));
  const sessions = useSessions(can('sessoes.ver'));
  const audit = useRecentAudit(6, can('auditoria.ver'));
  const today = todayIso(me.data?.company.timezone);
  const pickupsToday = usePickups({ from: today, to: today }, can('retiradas.ver'));
  const awaiting = useOrders({ status: 'AGUARDANDO_RETIRADA' }, can('pedidos.ver'));
  // Fase 10: visão do gestor pelas fontes canônicas (seção sem permissão = null, nunca zero).
  const overview = useOverview(
    can('os.ver') || can('entregas.ver') || can('entregas.gerenciar') || can('financeiro.ver'),
  );
  const ops = overview.data?.operations ?? null;
  const fin = overview.data?.finance ?? null;
  const dl = overview.data?.deliveries ?? null;
  const tz = me.data?.company.timezone ?? 'America/Sao_Paulo';
  // Prazos: as MESMAS contagens da Central de atenção (mesma rota, mesma regra; nada é
  // recalculado aqui). Só para quem gerencia a Central.
  const deadlinesVisible = can('ocorrencias.gerenciar');
  const osDeadlines = useAttention({ type: 'PRAZO_OS' }, deadlinesVisible);
  const orderDeadlines = useAttention({ type: 'PRAZO_PEDIDO' }, deadlinesVisible);

  const activeEmployees = employees.data?.filter((e) => e.active) ?? [];
  const withPin = activeEmployees.filter((e) => e.hasPin).length;
  const activeDevices = devices.data?.filter((d) => d.status === 'ACTIVE') ?? [];
  const online = activeDevices.filter((d) => d.online).length;
  const tabletSessions = sessions.data?.filter((s) => s.kind === 'DEVICE').length ?? 0;
  const webSessions = sessions.data?.filter((s) => s.kind === 'WEB').length ?? 0;

  const todayLabel = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz,
  }).format(new Date());

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-muted first-letter:uppercase">{todayLabel}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {greeting(tz)}, {me.data?.user.displayName}.
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {['os.ver', 'entregas.ver', 'financeiro.ver', 'pedidos.ver'].some((p) =>
            can(p as Permission),
          ) && (
            <Link
              href="/painel/resumo"
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-medium hover:bg-subtle"
              data-testid="dashboard-week"
            >
              Resumo da semana
            </Link>
          )}
          {can('orcamentos.gerenciar') && (
            <Link
              href="/painel/orcamentos"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-medium text-white shadow-sm hover:bg-brand-800"
              data-testid="dashboard-new-quote"
            >
              <ClipboardPlus className="size-4" aria-hidden />
              Novo orçamento
            </Link>
          )}
        </div>
      </div>

      {/* 2026-11-19 (Raphael): o Início volta a ter todas as informações de antes e os gráficos;
          sai só a lista longa de sugestões. Prazos entram no cartão Pendências do "Hoje". */}
      <TodayPanel
        deadlines={
          deadlinesVisible ? (
            <Link
              href="/painel/atencao?type=PRAZO_OS"
              className="block text-sm text-ink-soft hover:underline"
              data-testid="dashboard-deadlines"
            >
              Prazos de OS:{' '}
              <span
                className="font-semibold text-ink tabular-nums"
                data-testid="dashboard-deadlines-late"
              >
                {osDeadlines.data?.counts.CRITICO ?? '—'}
              </span>{' '}
              {pluralWord(osDeadlines.data?.counts.CRITICO ?? 0, 'atrasada', 'atrasadas')} ·{' '}
              <span
                className="font-semibold text-ink tabular-nums"
                data-testid="dashboard-deadlines-risk"
              >
                {osDeadlines.data?.counts.ACAO ?? '—'}
              </span>{' '}
              em risco
              {(orderDeadlines.data?.items.length ?? 0) > 0 && (
                <span className="block text-ink-muted" data-testid="dashboard-deadlines-orders">
                  {plural(orderDeadlines.data!.items.length, 'pedido', 'pedidos')} com peça ainda
                  não recebida
                </span>
              )}
            </Link>
          ) : null
        }
      />

      {(canQuotes || can('retiradas.ver') || can('pedidos.ver') || can('os.ver')) && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="flow-stats">
          {canQuotes && (
            <Stat
              href="/painel/orcamentos?tab=salvos"
              icon={<Calculator className="size-4" aria-hidden />}
              label="Orçamentos aprovados"
              value={<span data-testid="dashboard-quotes-approved">{approvedOpen ?? '—'}</span>}
              detail={
                funnel.data?.followUpDue
                  ? `sem fechar o serviço · ${plural(funnel.data.followUpDue, 'cliente', 'clientes')} para cobrar`
                  : 'sem fechar o serviço'
              }
            />
          )}
          {can('retiradas.ver') && (
            <Stat
              href="/painel/retiradas"
              icon={<Truck className="size-4" aria-hidden />}
              label="Retiradas de hoje"
              value={
                pickupsToday.data
                  ? pickupsToday.data.filter((p) => p.status !== 'CANCELADA').length
                  : '—'
              }
              detail={
                pickupsToday.data
                  ? `${pickupsToday.data.filter((p) => p.status === 'COM_OCORRENCIA').length} com ocorrência`
                  : ''
              }
            />
          )}
          {can('pedidos.ver') && (
            <>
              <Stat
                href="/painel/pedidos"
                icon={<FileSignature className="size-4" aria-hidden />}
                label="Aguardando retirada"
                value={awaiting.data?.total ?? '—'}
                detail="pedidos sem retirada agendada"
              />
            </>
          )}
          {can('os.ver') && (
            <Stat
              href="/painel/os"
              icon={<ClipboardList className="size-4" aria-hidden />}
              label="Serviços ativos"
              value={ops ? ops.activeServiceOrders : '—'}
              detail="OS com peça ainda não entregue"
            />
          )}
        </div>
      )}

      <HomeCharts />

      {ops && (
        <section data-testid="dashboard-operations">
          <h2 className="mb-3 font-semibold">Operação agora</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              href="/painel/os"
              icon={<PackageCheck className="size-4" aria-hidden />}
              label="Aguardando material"
              value={<span data-testid="ops-materials">{ops.awaitingMaterials}</span>}
              detail="OS com material da lista ainda fora da oficina"
            />
            <Stat
              href="/painel/producao"
              icon={<Activity className="size-4" aria-hidden />}
              label="Em produção"
              value={<span data-testid="ops-production">{ops.pieces.production}</span>}
              detail="peças com etapas em andamento"
            />
            <Stat
              href="/painel/qualidade"
              icon={<CheckCircle className="size-4" aria-hidden />}
              label="Na qualidade"
              value={<span data-testid="ops-quality">{ops.pieces.quality}</span>}
              detail={`${ops.pieces.rework} em retrabalho`}
            />
            <Stat
              href="/painel/producao/a-planejar"
              icon={<ClipboardList className="size-4" aria-hidden />}
              label="A planejar"
              value={<span data-testid="ops-to-plan">{ops.preProduction.toPlan}</span>}
              detail={`${ops.preProduction.plannedDraft} em rascunho · ${plural(ops.preProduction.plannedPublished, 'publicada', 'publicadas')} · ${ops.preProduction.awaitingCondition} aguardando condição`}
            />
            <Stat
              href="/painel/producao?status=BLOQUEADA"
              icon={<AlarmClock className="size-4" aria-hidden />}
              label="Bloqueios"
              value={<span data-testid="ops-blocked-tasks">{ops.blockedTasks}</span>}
              detail={`${pluralWord(ops.blockedTasks, 'tarefa bloqueada', 'tarefas bloqueadas')} · ${plural(ops.pieces.blocked, 'peça', 'peças')} com expedição bloqueada · ${ops.pieces.inTransit} em trânsito`}
            />
            <Stat
              href="/painel/entregas?tab=ready"
              icon={<Truck className="size-4" aria-hidden />}
              label="Prontas para entrega"
              value={<span data-testid="ops-ready">{ops.pieces.ready}</span>}
              detail={
                dl
                  ? `${plural(dl.upcoming, 'entrega', 'entregas')} nos próximos 2 dias${dl.frustrated ? ` · ${plural(dl.frustrated, 'frustrada', 'frustradas')}` : ''}`
                  : `${plural(ops.pieces.scheduled, 'agendada', 'agendadas')}`
              }
            />
          </div>
        </section>
      )}

      {dl && (
        <section data-testid="dashboard-deliveries">
          <h2 className="mb-3 font-semibold">Entregas</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              href={`/painel/roteiro?data=${overview.data?.today ?? today}`}
              icon={<Truck className="size-4" aria-hidden />}
              label="Próximos 2 dias"
              value={
                <span data-testid="dl-upcoming">{dl.upcoming + (dl.pickups?.upcoming ?? 0)}</span>
              }
              detail={`${plural(dl.upcoming, 'entrega', 'entregas')}${dl.pickups ? ` · ${plural(dl.pickups.upcoming, 'retirada', 'retiradas')}` : ''}`}
            />
            {dl.pickups && (
              <Stat
                href="/painel/retiradas"
                icon={<PackageCheck className="size-4" aria-hidden />}
                label="Aguardando chegada"
                value={<span data-testid="dl-awaiting-arrival">{dl.pickups.awaitingArrival}</span>}
                detail="retiradas feitas, peças ainda não recebidas na oficina"
              />
            )}
            <Stat
              href="/painel/entregas"
              icon={<Truck className="size-4" aria-hidden />}
              label="Entregues hoje"
              value={<span data-testid="dl-delivered">{dl.deliveredToday}</span>}
              detail="peças entregues em entregas concluídas hoje"
            />
          </div>
        </section>
      )}

      {fin && (
        <section data-testid="dashboard-finance">
          <h2 className="mb-3 font-semibold">Financeiro</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              href="/painel/financeiro?tab=receitas"
              icon={<FileSignature className="size-4" aria-hidden />}
              label="A receber"
              value={<span data-testid="fin-open">{money(fin.receivables.openCents)}</span>}
              detail={`${money(fin.receivables.overdueCents)} vencido (${plural(fin.receivables.overdueCount, 'cobrança', 'cobranças')})`}
            />
            <Stat
              href="/painel/financeiro?tab=pagar"
              icon={<ClipboardList className="size-4" aria-hidden />}
              label="Contas a pagar"
              value={money(fin.payables.openCents)}
              detail={`${money(fin.payables.overdueCents)} vencido`}
            />
            <Stat
              href="/painel/financeiro?tab=producao"
              icon={<Users className="size-4" aria-hidden />}
              label="Mão de obra liberada"
              value={money(fin.laborDueCents)}
              detail="liberada e ainda não paga"
            />
            <Stat
              href={`/painel/financeiro?tab=fechamento&semana=${fin.paid.weekStart}`}
              icon={<CheckCircle className="size-4" aria-hidden />}
              label="Pago na semana"
              value={<span data-testid="fin-paid">{money(fin.paid.paidInWeekCents)}</span>}
              detail="aos funcionários (tapeçaria e logística), estornos descontados"
            />
            {/* F10-14: cada contagem leva à tela onde ESSES itens aparecem. */}
            <Stat
              href="/painel/atencao?type=FINANCEIRO"
              icon={<AlarmClock className="size-4" aria-hidden />}
              label="Decisões financeiras"
              value={
                <span data-testid="fin-decisions">
                  {fin.decisions.valueRequests + fin.decisions.laborReviews}
                </span>
              }
              detail={`${plural(fin.decisions.valueRequests, 'negociação', 'negociações')} · ${plural(fin.decisions.laborReviews, 'revisão', 'revisões')}`}
            />
            <Stat
              href="/painel/financeiro?tab=receitas"
              icon={<FileSignature className="size-4" aria-hidden />}
              label="Pagamentos informados"
              value={<span data-testid="fin-payment-reports">{fin.decisions.paymentReports}</span>}
              detail="informados pela equipe, aguardando conferência"
            />
            <Stat
              href="/painel/financeiro?tab=pagar"
              icon={<Truck className="size-4" aria-hidden />}
              label="Obrigações logísticas"
              value={
                <span data-testid="fin-logistics">{money(fin.payables.logisticsOpenCents)}</span>
              }
              detail={`${money(fin.payables.logisticsOverdueCents)} vencido · parte das contas a pagar`}
            />
          </div>
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {can('funcionarios.ver') && (
          <Stat
            href="/painel/funcionarios"
            icon={<Users className="size-4" aria-hidden />}
            label="Funcionários ativos"
            value={employees.data ? activeEmployees.length : '—'}
            detail={employees.data ? `${withPin} com acesso aos tablets` : 'Carregando…'}
          />
        )}
        {can('dispositivos.ver') && (
          <Stat
            href="/painel/dispositivos"
            icon={<MonitorSmartphone className="size-4" aria-hidden />}
            label="Tablets vinculados"
            value={devices.data ? activeDevices.length : '—'}
            detail={
              devices.data ? `${plural(online, 'conectado', 'conectados')} agora` : 'Carregando…'
            }
          />
        )}
        {can('sessoes.ver') && (
          <Stat
            href="/painel/dispositivos#sessoes"
            icon={<Activity className="size-4" aria-hidden />}
            label="Sessões ativas"
            value={sessions.data ? sessions.data.length : '—'}
            detail={sessions.data ? `${tabletSessions} em tablets · ${webSessions} no painel` : ''}
          />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {can('funcionarios.ver') && (
          <Card className="lg:col-span-3">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="font-semibold">Equipe</h2>
              <Link
                href="/painel/funcionarios"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
              >
                Gerenciar <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
            {employees.isPending ? (
              <Spinner className="p-5" />
            ) : (
              <ul className="divide-y divide-line">
                {activeEmployees.map((e) => {
                  const tablet = devices.data?.find(
                    (d) => d.assignedEmployee?.id === e.id && d.status === 'ACTIVE',
                  );
                  return (
                    <li key={e.id} className="flex items-center gap-3 px-5 py-3">
                      <Avatar
                        name={e.displayName}
                        color={e.color}
                        photoUrl={e.photoUrl}
                        size={38}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{e.displayName}</p>
                        <p className="truncate text-sm text-ink-muted">{e.jobTitle}</p>
                      </div>
                      {tablet ? (
                        <Badge tone={tablet.online ? 'ok' : 'neutral'} dot>
                          {tablet.online ? 'Tablet conectado' : 'Tablet desconectado'}
                        </Badge>
                      ) : e.hasPin ? (
                        <Badge tone="info">Acesso por PIN</Badge>
                      ) : (
                        <Badge tone="neutral">Sem acesso ao tablet</Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        <div className="space-y-6 lg:col-span-2">
          {can('auditoria.ver') && (
            <Card>
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <h2 className="font-semibold">Atividade recente</h2>
                <Link
                  href="/painel/auditoria"
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  Ver tudo
                </Link>
              </div>
              {audit.isPending ? (
                <Spinner className="p-5" />
              ) : (
                <ul className="divide-y divide-line">
                  {audit.data?.items.map((a) => (
                    <li key={a.id} className="px-5 py-3">
                      <p className="text-sm text-ink">{a.summary}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {a.actor?.displayName ?? 'Sistema'} · {relativeTime(a.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
