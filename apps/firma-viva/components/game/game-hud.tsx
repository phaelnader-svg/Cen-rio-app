'use client';
/**
 * Peças da interface sobre o mapa: tela de carregamento, atalhos, ajustes (som, qualidade, luz),
 * missões do dia com nível da oficina e placar, barra do replay da semana e avisos recolhíveis.
 */
import clsx from 'clsx';
import { Pause, Play, X } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { Quality } from './engine';
import type { Mission, Progress } from './progress';
import { REWARDS } from './progress';
import { fmtReplayTime } from './replay';
import { sound } from './sound';
import { Ic } from './icons';
import { GBtn, Panel } from './ui';

/** Tela pequena (celular em pé ou janela estreita). */
export function useIsMobile() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(max-width: 640px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(max-width: 640px)').matches,
    () => false,
  );
}

export function useMuted() {
  return useSyncExternalStore(
    (cb) => sound().subscribe(cb),
    () => sound().isMuted(),
    () => true,
  );
}

/** Lembra no navegador (ex.: aviso dispensado, resumo recolhido). */
export function useRemembered<T extends string | boolean>(key: string, initial: T) {
  // O jogo só é montado no navegador (depois da sessão), então dá para ler direto.
  const [v, setV] = useState<T>(() => {
    try {
      const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (n: T) => {
    setV(n);
    try {
      window.localStorage.setItem(key, JSON.stringify(n));
    } catch {
      /* ignora */
    }
  };
  return [v, set] as const;
}

/** Marca do jogo: sofá em blocos (mesma ideia do logo do Cenário), em SVG. */
export function FirmaLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="16" fill="#1d4a45" />
      <rect x="12" y="22" width="40" height="14" rx="3" fill="#a8743f" />
      <rect x="9" y="30" width="9" height="16" rx="3" fill="#c89b68" />
      <rect x="46" y="30" width="9" height="16" rx="3" fill="#c89b68" />
      <rect x="16" y="33" width="15" height="9" rx="2" fill="#f5ebdf" />
      <rect x="33" y="33" width="15" height="9" rx="2" fill="#f5ebdf" />
      <rect x="14" y="46" width="4" height="5" rx="1" fill="#f5ebdf" />
      <rect x="46" y="46" width="4" height="5" rx="1" fill="#f5ebdf" />
    </svg>
  );
}

export function LoadingScreen({
  steps,
  hidden,
}: {
  steps: { label: string; done: boolean }[];
  hidden: boolean;
}) {
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);
  const current = steps.find((s) => !s.done);
  return (
    <div
      className={clsx(
        'absolute inset-0 z-50 grid place-items-center bg-gradient-to-b from-[#1d4a45] to-[#12302d] transition-opacity duration-700',
        hidden ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      data-testid="loading-screen"
      aria-hidden={hidden}
    >
      <div className="flex w-[min(360px,80vw)] flex-col items-center text-center text-[#f5ebdf]">
        <FirmaLogo className="size-20 animate-[bob_1.6s_ease-in-out_infinite] drop-shadow-xl" />
        <div className="mt-4 text-2xl font-black tracking-tight">Firma Viva</div>
        <div className="text-xs font-semibold tracking-[0.2em] text-[#d9b98c] uppercase">
          a sua oficina, ao vivo
        </div>
        <div className="mt-6 h-2.5 w-full overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full rounded-full bg-[#d9b98c] transition-[width] duration-500"
            style={{ width: `${Math.max(6, pct)}%` }}
          />
        </div>
        <div className="mt-2 text-xs text-[#f5ebdf]/80">
          {current ? `${current.label}…` : 'Pronto!'}
        </div>
      </div>
    </div>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['W A S D ou setas', 'Andar com o seu boneco'],
    ['Clique no chão', 'Ir até lá'],
    ['Q / E', 'Girar a câmera'],
    ['Roda do mouse', 'Aproximar no ponto do mouse'],
    ['Arrastar o fundo', 'Mover a câmera'],
    ['Duplo clique', 'Aproximar a peça ou pessoa'],
    ['C', 'Centralizar (visão geral)'],
    ['Arrastar peça → funcionário', 'Passar a etapa para ele'],
    ['M', 'Ligar/desligar o som'],
    ['?', 'Mostrar estes atalhos'],
    ['Esc', 'Fechar painéis'],
    ['Construção: R / D / Delete', 'Girar, duplicar, remover'],
    ['Construção: Ctrl+Z / Ctrl+Y', 'Desfazer / refazer'],
    ['Celular: dois dedos', 'Mover, aproximar e girar (gire os dedos)'],
  ];
  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-black/35 p-4"
      onClick={onClose}
      data-testid="shortcuts"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-[min(480px,100%)]">
        <Panel title="Atalhos" icon="⌨️" onClose={onClose}>
          <table className="w-full text-xs">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 pr-3 font-bold whitespace-nowrap">
                    <kbd className="rounded-md border border-line bg-white px-1.5 py-0.5 font-mono text-[11px] shadow-sm">
                      {k}
                    </kbd>
                  </td>
                  <td className="py-1.5 text-ink-soft">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

export function SettingsMenu({
  quality,
  auto,
  onQuality,
  hour,
  onHour,
  onShortcuts,
  onTutorial,
  onClose,
  extra,
}: {
  quality: Quality;
  auto: boolean;
  onQuality: (q: Quality | null) => void;
  hour: number | null;
  onHour: (h: number | null) => void;
  onShortcuts: () => void;
  onTutorial: () => void;
  onClose: () => void;
  extra?: React.ReactNode;
}) {
  const muted = useMuted();
  const opt = (on: boolean) =>
    clsx(
      'rounded-lg border px-2 py-1 text-xs font-semibold',
      on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white hover:bg-subtle',
    );
  return (
    <div
      className="pointer-events-auto absolute top-full right-0 z-30 mt-1 w-72 rounded-2xl border border-line bg-white p-3 text-xs shadow-pop"
      data-testid="settings-menu"
      onMouseLeave={onClose}
    >
      {extra}
      <div className="mb-1 font-bold">Som</div>
      <div className="mb-3 flex gap-1">
        <button className={opt(!muted)} onClick={() => sound().setMuted(false)}>
          <Ic e="🔊" /> Ligado
        </button>
        <button className={opt(muted)} onClick={() => sound().setMuted(true)}>
          <Ic e="🔇" /> Mudo
        </button>
      </div>
      <div className="mb-1 font-bold">Qualidade gráfica</div>
      <div className="mb-1 flex flex-wrap gap-1">
        <button className={opt(auto)} onClick={() => onQuality(null)}>
          Automática
        </button>
        {(['alta', 'media', 'baixa'] as const).map((q) => (
          <button key={q} className={opt(!auto && quality === q)} onClick={() => onQuality(q)}>
            {q === 'alta' ? 'Alta' : q === 'media' ? 'Média' : 'Leve'}
          </button>
        ))}
      </div>
      <div className="mb-3 text-[11px] text-ink-muted">
        Agora: {quality === 'alta' ? 'alta' : quality === 'media' ? 'média' : 'leve'}
        {auto ? ' (ajustada sozinha pelo desempenho)' : ''}
      </div>
      <div className="mb-1 font-bold">Luz do dia</div>
      <div className="mb-3 flex flex-wrap gap-1">
        {(
          [
            [null, 'Hora real'],
            [8, 'Manhã'],
            [15, 'Tarde'],
            [18, 'Fim do dia'],
            [21, 'Noite'],
          ] as const
        ).map(([h, l]) => (
          <button key={l} className={opt(hour === h)} onClick={() => onHour(h)}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <GBtn tone="ghost" onClick={onShortcuts}>
          <Ic e="⌨️" /> Atalhos
        </GBtn>
        <GBtn tone="ghost" onClick={onTutorial}>
          <Ic e="🎓" /> Ver tutorial
        </GBtn>
      </div>
    </div>
  );
}

export function MissionsPanel({
  missions,
  progress,
  week,
  onClose,
  onReplay,
  canReplay,
}: {
  missions: Mission[];
  progress: Progress;
  week: { total: number; people: { id: string; name: string; n: number }[] };
  onClose: () => void;
  onReplay: () => void;
  canReplay: boolean;
}) {
  const [showPeople, setShowPeople] = useRemembered<boolean>('firma-placar-pessoas', false);
  const pct = Math.round((progress.into / progress.span) * 100);
  return (
    <Panel
      title="Missões do dia"
      subtitle={`Nível ${progress.level} · ${progress.levelName}`}
      icon="🎯"
      onClose={onClose}
      testId="missions-panel"
    >
      <div className="mb-3 rounded-xl border border-bronze-500/30 bg-bronze-100/60 p-2.5">
        <div className="flex items-center justify-between text-xs font-bold">
          <span>
            <Ic e="⭐" /> Nível {progress.level} · {progress.levelName}
          </span>
          <span className="text-ink-soft">{progress.xp} XP</span>
        </div>
        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white">
          <div className="h-full rounded-full bg-bronze-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-[11px] text-ink-soft">
          {progress.nextReward
            ? `No nível ${progress.nextReward.level}: ${progress.nextReward.label}.`
            : 'Todas as recompensas conquistadas.'}
        </div>
      </div>
      <ul className="space-y-1.5">
        {missions.map((m) => (
          <li
            key={m.id}
            className={clsx(
              'rounded-xl border p-2 text-xs',
              m.done ? 'border-ok-600/30 bg-ok-50' : 'border-line bg-white',
            )}
            data-testid={`mission-${m.id}`}
          >
            <div className="flex items-center gap-2">
              <span className={m.done ? 'text-ok-600' : 'text-bronze-600'}>
                <Ic e={m.done ? '✅' : m.icon} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-bold">{m.title}</div>
                <div className="text-ink-soft">{m.detail}</div>
              </div>
              <span className="font-semibold text-bronze-600">+{m.xp} XP</span>
            </div>
            {m.goal > 1 ? (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-subtle">
                <div
                  className={clsx('h-full rounded-full', m.done ? 'bg-ok-600' : 'bg-brand-600')}
                  style={{ width: `${(m.current / m.goal) * 100}%` }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="mt-4 mb-1 text-[11px] font-bold tracking-wider text-bronze-600 uppercase">
        Recompensas da oficina
      </div>
      <div className="flex flex-wrap gap-1">
        {REWARDS.map((r) => (
          <span
            key={r.id}
            className={clsx(
              'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
              progress.rewards.includes(r.id)
                ? 'border-ok-600/30 bg-ok-50 text-ok-600'
                : 'border-line bg-white text-ink-muted',
            )}
          >
            {progress.rewards.includes(r.id) ? <Ic e="✓" /> : `Nv ${r.level}`} · {r.label}
          </span>
        ))}
      </div>
      <div className="mt-4 mb-1 flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wider text-bronze-600 uppercase">
          Placar da semana
        </span>
        <label className="flex items-center gap-1 text-[11px] text-ink-soft">
          <input
            type="checkbox"
            checked={showPeople}
            onChange={(e) => setShowPeople(e.target.checked)}
          />
          mostrar por pessoa
        </label>
      </div>
      <div className="rounded-xl border border-line bg-white p-2 text-xs">
        <div className="font-bold">
          <Ic e="🏁" /> A equipe concluiu {week.total} etapa(s) nesta semana
        </div>
        {showPeople ? (
          <ul className="mt-1 space-y-0.5">
            {week.people.map((p) => (
              <li key={p.id} className="flex justify-between">
                <span>{p.name}</span>
                <span className="font-semibold">{p.n}</span>
              </li>
            ))}
            {!week.people.length ? <li className="text-ink-muted">Nada ainda.</li> : null}
          </ul>
        ) : (
          <div className="mt-0.5 text-ink-muted">
            Sem expor ninguém: o número por pessoa só aparece se você marcar.
          </div>
        )}
      </div>
      <GBtn
        tone="bronze"
        className="mt-3 w-full"
        onClick={onReplay}
        disabled={!canReplay}
        testId="replay-open"
      >
        <Ic e="⏪" /> Replay da semana
      </GBtn>
      <p className="mt-2 text-[11px] text-ink-muted">
        Tudo calculado com o trabalho real registrado no tablet. O progresso fica guardado neste
        navegador.
      </p>
    </Panel>
  );
}

export function ReplayBar({
  at,
  from,
  to,
  playing,
  speed,
  onSeek,
  onPlay,
  onSpeed,
  onClose,
}: {
  at: number;
  from: number;
  to: number;
  playing: boolean;
  speed: number;
  onSeek: (t: number) => void;
  onPlay: (p: boolean) => void;
  onSpeed: (s: number) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="pointer-events-auto absolute inset-x-2 bottom-3 z-20 mx-auto flex max-w-2xl flex-wrap items-center gap-2 rounded-2xl border-2 border-bronze-500/60 bg-[#fffaf2]/97 p-2 shadow-pop sm:flex-nowrap"
      data-testid="replay-bar"
      data-hud
    >
      <button
        className="grid size-9 place-items-center rounded-xl bg-brand-600 text-white"
        onClick={() => onPlay(!playing)}
        aria-label={playing ? 'Pausar' : 'Reproduzir'}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex justify-between text-[11px] font-semibold">
          <span>
            <Ic e="⏪" /> Replay da semana
          </span>
          <span className="text-bronze-600">{fmtReplayTime(at)}</span>
        </div>
        <input
          type="range"
          min={from}
          max={to}
          step={60_000}
          value={at}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="w-full accent-[#a8743f]"
          aria-label="Momento da semana"
        />
      </div>
      <div className="flex gap-1">
        {[1, 4, 12].map((s) => (
          <button
            key={s}
            onClick={() => onSpeed(s)}
            className={clsx(
              'rounded-lg border px-1.5 py-1 text-[11px] font-bold',
              speed === s ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white',
            )}
          >
            {s}×
          </button>
        ))}
      </div>
      <button
        className="rounded-lg p-1.5 hover:bg-subtle"
        onClick={onClose}
        aria-label="Sair do replay"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
