'use client';

import {
  Activity,
  ClipboardList,
  FileSignature,
  PackageCheck,
  Truck,
  ArrowRight,
  CheckCircle2,
  Lock,
  MonitorSmartphone,
  RadioTower,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { Avatar, Badge, Card, Spinner } from '@/components/ui/misc';
import { relativeTime } from '@/lib/format';
import { useCan, useMe } from '@/lib/hooks';
import { todayIso, useOrders, usePickups, useServiceOrders } from '@/lib/commercial';
import { useDevices, useEmployees, useRecentAudit, useSessions } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime';
import { UPCOMING } from './nav';

function greeting() {
  const h = Number(
    new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', timeZone: 'America/Sao_Paulo' }).format(
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
  const openOs = useServiceOrders({ status: 'ABERTA' }, can('os.ver'));

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
    timeZone: 'America/Sao_Paulo',
  }).format(new Date());

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-medium text-ink-muted first-letter:uppercase">{todayLabel}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {greeting()}, {me.data?.user.displayName}.
        </h1>
      </div>

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
              label="OS abertas"
              value={openOs.data?.total ?? '—'}
              detail="aguardando as próximas fases"
            />
          )}
        </div>
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

          <Card className="p-5">
            <h2 className="font-semibold">Implantação</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Fases 1 e 2 em uso. Os módulos abaixo serão liberados nas próximas fases.
            </p>
            <p className="mt-4 flex items-center gap-2 text-sm font-medium text-ok-600">
              <CheckCircle2 className="size-4" aria-hidden /> Pessoas, acessos, dispositivos e
              sincronização
            </p>
            <p className="mt-1 flex items-center gap-2 text-sm font-medium text-ok-600">
              <CheckCircle2 className="size-4" aria-hidden /> Clientes, pedidos, retiradas,
              recebimentos e OS
            </p>
            <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {UPCOMING.map((m) => (
                <li key={m.label} className="flex items-center gap-2 text-sm text-ink-muted">
                  <Lock className="size-3.5 shrink-0" aria-hidden /> {m.label}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
