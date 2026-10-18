'use client';

import {
  AlarmClock,
  ClipboardPlus,
  Activity,
  ClipboardList,
  FileSignature,
  PackageCheck,
  Truck,
  ArrowRight,
  CheckCircle,
  MonitorSmartphone,
  RadioTower,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { Avatar, Badge, Card, Spinner } from '@/components/ui/misc';
import { relativeTime } from '@/lib/format';
import { useCan, useMe } from '@/lib/hooks';
import { todayIso, useOrders, usePickups } from '@/lib/commercial';
import { useAttention } from '@/lib/issues';
import { money } from '@/lib/finance';
import { useDevices, useEmployees, useOverview, useRecentAudit, useSessions } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime';

function greeting(timeZone: string) {
  const h = Number(
    new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
      new Date(),
    ),
  );
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

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
  const realtime = useRealtime();
  const employees = useEmployees(can('funcionarios.ver'));
  const devices = useDevices(can('dispositivos.ver'));
  const sessions = useSessions(can('sessoes.ver'));
  const audit = useRecentAudit(6, can('auditoria.ver'));
  const today = todayIso(me.data?.company.timezone);
  const pickupsToday = usePickups({ from: today, to: today }, can('retiradas.ver'));
  const awaiting = useOrders({ status: 'AGUARDANDO_RETIRADA' }, can('pedidos.ver'));
  const partial = useOrders({ status: 'RECEBIDO_PARCIAL' }, can('pedidos.ver'));
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
        {can('pedidos.gerenciar') && can('retiradas.gerenciar') && (
          <Link
            href="/painel/servicos/novo"
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-medium text-white shadow-sm hover:bg-brand-800"
            data-testid="dashboard-new-service"
          >
            <ClipboardPlus className="size-4" aria-hidden />
            Novo serviço
          </Link>
        )}
      </div>

      {deadlinesVisible && (
        <Link
          href="/painel/atencao?type=PRAZO_OS"
          className="block rounded-2xl"
          data-testid="dashboard-deadlines"
        >
          <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 p-5 transition-shadow hover:shadow-[var(--shadow-pop)]">
            <span className="flex items-center gap-2 text-sm font-medium text-ink-muted">
              <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700">
                <AlarmClock className="size-4" aria-hidden />
              </span>
              Prazos
            </span>
            <span className="text-lg font-semibold tabular-nums">
              <span data-testid="dashboard-deadlines-late">
                {osDeadlines.data?.counts.CRITICO ?? '—'}
              </span>{' '}
              atrasado(s) ·{' '}
              <span data-testid="dashboard-deadlines-risk">
                {osDeadlines.data?.counts.ACAO ?? '—'}
              </span>{' '}
              em risco
            </span>
            {(orderDeadlines.data?.items.length ?? 0) > 0 && (
              <span className="text-sm text-ink-muted" data-testid="dashboard-deadlines-orders">
                {orderDeadlines.data!.items.length} pedido(s) com peça ainda não recebida
              </span>
            )}
          </Card>
        </Link>
      )}

      {(can('retiradas.ver') || can('pedidos.ver') || can('os.ver')) && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="flow-stats">
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
              <Stat
                href="/painel/recebimentos"
                icon={<PackageCheck className="size-4" aria-hidden />}
                label="Recebidos parcialmente"
                value={partial.data?.total ?? '—'}
                detail="pedidos com peças pendentes"
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

      {ops && (
        <section data-testid="dashboard-operations">
          <h2 className="mb-3 font-semibold">Operação agora</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              href="/painel/prontidao"
              icon={<PackageCheck className="size-4" aria-hidden />}
              label="Aguardando material"
              value={<span data-testid="ops-materials">{ops.awaitingMaterials}</span>}
              detail="OS com material que ainda segura a produção"
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
              detail={`${ops.pieces.rework} em retrabalho · ${ops.pieces.packaging} na embalagem`}
            />
            <Stat
              href="/painel/entregas?tab=ready"
              icon={<Truck className="size-4" aria-hidden />}
              label="Prontas para entrega"
              value={<span data-testid="ops-ready">{ops.pieces.ready}</span>}
              detail={
                dl
                  ? `${dl.upcoming} entrega(s) nos próximos 2 dias${dl.frustrated ? ` · ${dl.frustrated} frustrada(s)` : ''}`
                  : `${ops.pieces.scheduled} agendada(s)`
              }
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
              detail={`${money(fin.receivables.overdueCents)} vencido (${fin.receivables.overdueCount} cobrança(s))`}
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
              href="/painel/atencao?type=FINANCEIRO"
              icon={<AlarmClock className="size-4" aria-hidden />}
              label="Decisões financeiras"
              value={
                <span data-testid="fin-decisions">
                  {fin.decisions.valueRequests +
                    fin.decisions.laborReviews +
                    fin.decisions.paymentReports}
                </span>
              }
              detail={`${fin.decisions.valueRequests} negociação(ões) · ${fin.decisions.laborReviews} revisão(ões) · ${fin.decisions.paymentReports} pagamento(s) informado(s)`}
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
            detail={devices.data ? `${online} conectado(s) agora` : 'Carregando…'}
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
        <Stat
          href={can('sincronizacao.diagnosticar') ? '/painel/sincronizacao' : undefined}
          icon={<RadioTower className="size-4" aria-hidden />}
          label="Tempo real"
          value={
            realtime.status === 'online' ? (
              <span className="text-ok-600">Ativo</span>
            ) : (
              <span className="text-warn-600">Reconectando</span>
            )
          }
          detail={`Último evento nº ${realtime.lastSeq ?? '—'}`}
        />
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
