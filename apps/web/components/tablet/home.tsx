'use client';

import type { MeDto } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertOctagon,
  ArrowLeft,
  ClipboardCheck,
  Clock3,
  LogOut,
  PackageSearch,
  RadioTower,
  Ruler,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConnectionIndicator } from '@/components/connection-indicator';
import { SyncPanel } from '@/components/sync-panel';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { MyMeasurementDetail, MyMeasurements, useMyOpenCount } from './measurements';

type Screen = 'home' | 'sync' | 'measurements' | 'measurement';

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

/** Módulos da produção que chegam nas próximas fases (exibidos como indisponíveis). */
const UPCOMING = [
  {
    icon: ClipboardCheck,
    title: 'Minhas tarefas',
    text: 'Serviços programados para você, etapas e pedidos de ajuda.',
  },
  {
    icon: Clock3,
    title: 'Presença',
    text: 'Botões “Cheguei” e “Encerrar expediente”.',
  },
  {
    icon: PackageSearch,
    title: 'Materiais',
    text: 'Conferência de recebimento e falta de materiais.',
  },
  {
    icon: AlertOctagon,
    title: 'Ocorrências',
    text: 'Registro de impedimentos para a central de atenção.',
  },
];

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
  const openCount = useMyOpenCount(canMeasure);
  const [measurementId, setMeasurementId] = useState<string | null>(null);

  async function logout() {
    setLeaving(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      qc.removeQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['tablet-status'] });
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="border-b border-line bg-surface"
        style={{ borderTop: `8px solid ${color}` }}
      >
        <div className="flex items-center gap-4 px-6 py-4 sm:px-8">
          <Avatar
            name={me.user.displayName}
            color={color}
            photoUrl={me.employee?.photoUrl}
            size={60}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-2xl font-semibold tracking-tight" data-testid="tablet-user">
              {me.employee?.displayName ?? me.user.displayName}
            </p>
            <p className="truncate text-base text-ink-muted">
              {me.employee?.jobTitle} · {me.device?.name}
            </p>
          </div>
          <div className="hidden text-right sm:block">
            <p className="text-3xl font-semibold tabular-nums">{clock.time}</p>
            <p className="text-sm text-ink-muted first-letter:uppercase">{clock.date}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle/60 px-6 py-2.5 sm:px-8">
          <ConnectionIndicator />
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
      </header>

      <main className="flex-1 px-6 py-8 sm:px-8">
        {screen === 'home' ? (
          <>
            <h1 className="sr-only">Início</h1>
            <ul className="grid gap-5 md:grid-cols-2">
              {canMeasure && (
                <li className="md:col-span-2">
                  <button
                    type="button"
                    onClick={() => setScreen('measurements')}
                    data-testid="tile-measurements"
                    className={clsx(
                      'flex w-full items-center gap-5 rounded-2xl border border-line bg-surface p-6 text-left shadow-[var(--shadow-card)] transition',
                      'hover:border-brand-200 hover:shadow-[var(--shadow-pop)] active:scale-[0.99]',
                    )}
                  >
                    <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700">
                      <Ruler className="size-8" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-2xl font-semibold">Medições atribuídas</span>
                      <span className="mt-1 block text-base text-ink-muted">
                        Medir peças, informar tecidos, espumas e materiais e enviar ao gestor.
                      </span>
                    </span>
                    {openCount !== undefined && (
                      <span
                        className={clsx(
                          'grid min-w-14 place-items-center rounded-2xl px-3 py-2 text-2xl font-semibold tabular-nums',
                          openCount ? 'bg-brand-700 text-white' : 'bg-subtle text-ink-muted',
                        )}
                        aria-label={`${openCount} medição(ões) para fazer`}
                        data-testid="measurements-count"
                      >
                        {openCount}
                      </span>
                    )}
                  </button>
                </li>
              )}
              {UPCOMING.map((m) => (
                <li key={m.title}>
                  <div
                    aria-disabled="true"
                    className="flex h-full min-h-40 items-start gap-5 rounded-2xl border border-dashed border-line-strong bg-surface/60 p-6"
                  >
                    <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-subtle text-ink-muted">
                      <m.icon className="size-7" aria-hidden />
                    </span>
                    <div>
                      <p className="text-xl font-semibold text-ink-soft">{m.title}</p>
                      <p className="mt-1 text-base text-ink-muted">{m.text}</p>
                      <p className="mt-3 inline-block rounded-full bg-subtle px-3 py-1 text-sm font-medium text-ink-muted">
                        Disponível na próxima fase
                      </p>
                    </div>
                  </div>
                </li>
              ))}
              {canSync && (
                <li className="md:col-span-2">
                  <button
                    type="button"
                    onClick={() => setScreen('sync')}
                    className={clsx(
                      'flex w-full items-center gap-5 rounded-2xl border border-line bg-surface p-6 text-left shadow-[var(--shadow-card)] transition',
                      'hover:border-brand-200 hover:shadow-[var(--shadow-pop)] active:scale-[0.99]',
                    )}
                  >
                    <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700">
                      <RadioTower className="size-7" aria-hidden />
                    </span>
                    <span>
                      <span className="block text-xl font-semibold">Teste de sincronização</span>
                      <span className="mt-1 block text-base text-ink-muted">
                        Confirme que este tablet recebe as atualizações do painel em tempo real.
                      </span>
                    </span>
                  </button>
                </li>
              )}
            </ul>
          </>
        ) : screen === 'measurements' ? (
          <>
            <BackButton label="Voltar ao início" onClick={() => setScreen('home')} />
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">Medições atribuídas</h1>
            <MyMeasurements
              onOpen={(id) => {
                setMeasurementId(id);
                setScreen('measurement');
              }}
            />
          </>
        ) : screen === 'measurement' && measurementId ? (
          <>
            <BackButton label="Voltar às medições" onClick={() => setScreen('measurements')} />
            <MyMeasurementDetail
              key={measurementId}
              id={measurementId}
              onBack={() => setScreen('measurements')}
            />
          </>
        ) : (
          <>
            <BackButton label="Voltar ao início" onClick={() => setScreen('home')} />
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">Teste de sincronização</h1>
            <SyncPanel large />
          </>
        )}
      </main>
    </div>
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
