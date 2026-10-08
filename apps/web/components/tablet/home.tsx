'use client';

import type { MeDto } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertOctagon,
  ArrowLeft,
  Clock3,
  LogOut,
  PackageCheck,
  RadioTower,
  Ruler,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConnectionIndicator } from '@/components/connection-indicator';
import { SyncPanel } from '@/components/sync-panel';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { MaterialReceiving } from '@/components/purchasing/material-receiving';
import { usePendingReceipts } from '@/lib/purchasing';
import { MyMeasurementDetail, MyMeasurements, useMyOpenCount } from './measurements';
import {
  MyDay,
  MyTaskDetail,
  NotificationsButton,
  NotificationsInbox,
  OfflineBanner,
  useMyTodayCount,
} from './tasks';

type Screen =
  | 'home'
  | 'task'
  | 'notifications'
  | 'sync'
  | 'measurements'
  | 'measurement'
  | 'materials';

function useClock(timezone: string) {
  // Renderizado apenas no cliente (após autenticação), sem risco de divergência de hidratação.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return {
    time: new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(now),
    date: new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: timezone,
    }).format(now),
  };
}

/** Módulos que chegam nas próximas fases (apenas informativos, sem ação). */
const UPCOMING = [
  { icon: Clock3, title: 'Presença', text: 'Botões “Cheguei” e “Encerrar expediente”.' },
  {
    icon: AlertOctagon,
    title: 'Ocorrências',
    text: 'Registro de impedimentos para a central de atenção.',
  },
];

/**
 * Tablet individual (Ricardo, Márcio, Thiago, João): a tela inicial é o "Meu dia".
 * A sessão permanece válida entre expedientes (Fase 1) e pode ser revogada pelo painel.
 */
export function TabletHome({ me }: { me: MeDto }) {
  const qc = useQueryClient();
  const [screen, setScreen] = useState<Screen>('home');
  const [leaving, setLeaving] = useState(false);
  const clock = useClock(me.company.timezone);
  const color = me.employee?.color ?? '#1d4a45';
  const canSync = me.permissions.includes('sincronizacao.diagnosticar');
  const canMeasure =
    me.permissions.includes('medicoes.extraordinarias') ||
    me.permissions.includes('medicoes.gerenciar');
  const canExecute = me.permissions.includes('producao.executar');
  const openCount = useMyOpenCount(canMeasure);
  const todayCount = useMyTodayCount(canExecute);
  const [measurementId, setMeasurementId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskFrom, setTaskFrom] = useState<Screen>('home');
  const pendingMaterials = usePendingReceipts();

  const openTask = (id: string, from: Screen = 'home') => {
    setTaskId(id);
    setTaskFrom(from);
    setScreen('task');
    window.scrollTo({ top: 0 });
  };

  async function logout() {
    setLeaving(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      qc.removeQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['tablet-status'] });
    }
  }

  const back = (label: string, to: Screen) => (
    <BackButton label={label} onClick={() => setScreen(to)} />
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="sticky top-0 z-20 border-b border-line bg-surface"
        style={{ borderTop: `8px solid ${color}` }}
      >
        <div className="flex items-center gap-4 px-4 py-3 sm:px-8 sm:py-4">
          <Avatar
            name={me.user.displayName}
            color={color}
            photoUrl={me.employee?.photoUrl}
            size={56}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-2xl font-semibold tracking-tight" data-testid="tablet-user">
              {me.employee?.displayName ?? me.user.displayName}
            </p>
            <p className="truncate text-base text-ink-muted first-letter:uppercase">
              <span data-testid="tablet-date">{clock.date}</span>
              <span className="hidden sm:inline"> · {me.device?.name}</span>
            </p>
          </div>
          <p className="hidden text-3xl font-semibold tabular-nums sm:block">{clock.time}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-subtle/60 px-4 py-2.5 sm:px-8">
          <ConnectionIndicator />
          <div className="flex flex-wrap items-center gap-2">
            {canExecute && (
              <NotificationsButton
                onClick={() => {
                  setScreen('notifications');
                  window.scrollTo({ top: 0 });
                }}
              />
            )}
            <Button
              variant="secondary"
              size="lg"
              loading={leaving}
              onClick={() => void logout()}
              icon={<LogOut className="size-5" aria-hidden />}
            >
              Sair
            </Button>
          </div>
        </div>
        <OfflineBanner />
      </header>

      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        {screen === 'home' ? (
          <>
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">
              {canExecute ? 'Meu dia' : 'Início'}
              {canExecute && todayCount !== undefined && (
                <span className="ml-3 align-middle text-base font-normal text-ink-muted">
                  <span data-testid="tasks-count">{todayCount}</span> tarefa(s) para hoje
                </span>
              )}
            </h1>
            {canExecute && <MyDay onOpen={(id) => openTask(id, 'home')} />}

            <h2 className={clsx('mb-3 text-lg font-semibold text-ink-soft', canExecute && 'mt-10')}>
              {canExecute ? 'Outras atividades' : 'Atividades'}
            </h2>
            <ul className="grid gap-4 md:grid-cols-2">
              {canMeasure && (
                <li>
                  <Tile
                    onClick={() => setScreen('measurements')}
                    testId="tile-measurements"
                    icon={<Ruler className="size-7" aria-hidden />}
                    title="Medições atribuídas"
                    text="Medir peças e informar materiais."
                    count={openCount}
                    countTestId="measurements-count"
                    countLabel="medição(ões) para fazer"
                  />
                </li>
              )}
              <li>
                <Tile
                  onClick={() => setScreen('materials')}
                  testId="tile-materials"
                  icon={<PackageCheck className="size-7" aria-hidden />}
                  title="Recebimento de materiais"
                  text="Conferir e registrar o que chegou."
                  count={pendingMaterials.data?.length}
                  countTestId="materials-count"
                  countLabel="pedido(s) aguardando chegada"
                  tone="bronze"
                />
              </li>
              {canSync && (
                <li>
                  <Tile
                    onClick={() => setScreen('sync')}
                    icon={<RadioTower className="size-7" aria-hidden />}
                    title="Teste de sincronização"
                    text="Confirme que o tablet recebe as atualizações."
                  />
                </li>
              )}
              {UPCOMING.map((m) => (
                <li key={m.title}>
                  <div
                    aria-disabled="true"
                    className="flex h-full items-start gap-4 rounded-2xl border border-dashed border-line-strong bg-surface/60 p-5"
                  >
                    <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-subtle text-ink-muted">
                      <m.icon className="size-6" aria-hidden />
                    </span>
                    <div>
                      <p className="text-lg font-semibold text-ink-soft">{m.title}</p>
                      <p className="text-base text-ink-muted">{m.text}</p>
                      <p className="mt-2 inline-block rounded-full bg-subtle px-3 py-1 text-sm font-medium text-ink-muted">
                        Disponível na próxima fase
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : screen === 'task' && taskId ? (
          <>
            {back(
              taskFrom === 'notifications' ? 'Voltar aos avisos' : 'Voltar ao Meu dia',
              taskFrom,
            )}
            <MyTaskDetail key={taskId} id={taskId} />
          </>
        ) : screen === 'notifications' ? (
          <>
            {back('Voltar ao Meu dia', 'home')}
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">Avisos</h1>
            <NotificationsInbox onOpenTask={(id) => openTask(id, 'notifications')} />
          </>
        ) : screen === 'measurements' ? (
          <>
            {back('Voltar ao início', 'home')}
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">Medições atribuídas</h1>
            <MyMeasurements
              onOpen={(id) => {
                setMeasurementId(id);
                setScreen('measurement');
              }}
            />
          </>
        ) : screen === 'materials' ? (
          <>
            {back('Voltar ao início', 'home')}
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">Recebimento de materiais</h1>
            <MaterialReceiving large />
          </>
        ) : screen === 'measurement' && measurementId ? (
          <>
            {back('Voltar às medições', 'measurements')}
            <MyMeasurementDetail
              key={measurementId}
              id={measurementId}
              onBack={() => setScreen('measurements')}
            />
          </>
        ) : (
          <>
            {back('Voltar ao início', 'home')}
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">Teste de sincronização</h1>
            <SyncPanel large />
          </>
        )}
      </main>
    </div>
  );
}

function Tile({
  onClick,
  testId,
  icon,
  title,
  text,
  count,
  countTestId,
  countLabel,
  tone = 'brand',
}: {
  onClick: () => void;
  testId?: string;
  icon: React.ReactNode;
  title: string;
  text: string;
  count?: number;
  countTestId?: string;
  countLabel?: string;
  tone?: 'brand' | 'bronze';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={clsx(
        'flex h-full w-full items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-[var(--shadow-card)] transition',
        'hover:border-brand-200 hover:shadow-[var(--shadow-pop)] active:scale-[0.99]',
      )}
    >
      <span
        className={clsx(
          'grid size-14 shrink-0 place-items-center rounded-2xl',
          tone === 'brand' ? 'bg-brand-50 text-brand-700' : 'bg-bronze-100 text-bronze-600',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xl font-semibold">{title}</span>
        <span className="mt-0.5 block text-base text-ink-muted">{text}</span>
      </span>
      {count !== undefined && (
        <span
          className={clsx(
            'grid min-w-12 place-items-center rounded-2xl px-3 py-2 text-xl font-semibold tabular-nums',
            count
              ? tone === 'brand'
                ? 'bg-brand-700 text-white'
                : 'bg-bronze-600 text-white'
              : 'bg-subtle text-ink-muted',
          )}
          aria-label={`${count} ${countLabel ?? ''}`}
          data-testid={countTestId}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="lg"
      className="mb-4 -ml-3"
      onClick={onClick}
      icon={<ArrowLeft className="size-5" aria-hidden />}
    >
      {label}
    </Button>
  );
}
