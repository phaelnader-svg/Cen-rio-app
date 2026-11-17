'use client';
/**
 * Firma Viva: mapa isométrico da empresa com dois modos.
 * - Gestão: andar, consultar a operação, clicar em sofás, pessoas, estantes e agentes.
 * - Construção: editar a planta (com o Mestre de Obras), salvar com versão e impacto.
 * A interface nunca "simula" a operação: tudo que muda no mapa vem do servidor (tempo real).
 */
import {
  type ClearanceProblem,
  type CommandEffect,
  type GamePieceDto,
  type GameSpaceDto,
  type LayoutContent,
  type MestreReply,
  type RemovalImpact,
  QUICK_FILTERS,
  brlCents,
  signedBrl,
  signedPct,
  askMestre,
  catalogOf,
  clearanceAround,
  dragTip,
  footprint,
  pieceWorkflow,
  rectOfArea,
} from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  FlaskConical,
  Hammer,
  Map as MapIcon,
  MessageCircle,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useCan, useMe } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import {
  ImpactDialog,
  MestrePanel,
  Palette,
  type PaletteItem,
  Properties,
  RoomSettings,
} from './build-panels';
import {
  type Selection,
  addArea,
  addDecor,
  addStation,
  addStorage,
  addWall,
  applyPatch,
  dragHandle,
  duplicateObj,
  moveObj,
  moveWall,
  removeObj,
  rotateObj,
  useLayoutDraft,
} from './editor';
import { CenariaChat } from './cenaria-chat';
import { GameEngine, type Overlays, type PickTarget, type Quality } from './engine';
import {
  FirmaLogo,
  LoadingScreen,
  MissionsPanel,
  ReplayBar,
  SettingsMenu,
  ShortcutsDialog,
  useIsMobile,
  useMuted,
  useRemembered,
} from './game-hud';
import {
  type Mission,
  type Progress,
  type ProgressDelta,
  type ProgressStore,
  deltaEmpty,
  emptyStore,
  forgetLegacy,
  legacyStore,
  mergeStores,
  progressOf,
  updateProgress,
} from './progress';
import {
  AvatarPanel,
  DEFAULT_LOOK,
  GoalShare,
  GoodMorning,
  LogisticsPanel,
  ShareDialog,
  type ShareCard,
  SimulatorPanel,
  logisticsView,
  markMorningSeen,
  morningItems,
  morningSeenToday,
  useTabNotifications,
  useTodayLogistics,
} from './extras';
import type { AvatarLook } from './models';
import { replayRange, snapshotAt } from './replay';
import { sound } from './sound';
import { TUTORIAL_KEY, Tutorial, type TutorialEvent, buildSteps, tutorialSeen } from './tutorial';
import {
  useAgents,
  useAvatarLook,
  useIntegrations,
  useProgressStore,
  useMaterialSearch,
  usePeople,
  useSnapshot,
  useSpaces,
} from './game-api';
import { FichaPanel, FinancePanel } from './office-finance';
import { type Drill, GoalsPanel, nextGoalOf, useCash } from './office-goals';
import { AdsPanel, ConnectionsPanel, InboxPanel, MarketingPanel, useInbox } from './office-panels';
import { AgentConfigPanel, AgentPanel, EmployeePanel } from './people-panels';
import { PiecePanel } from './piece-panel';
import { isLate, peopleOnMap, piecesOnMap } from './placement';
import { MaterialPanel, StoragePanel } from './storage-panel';
import { Ic, iconText } from './icons';
import { GBtn, KV, Panel, Tone, fmtClock, fmtDate } from './ui';
import { useServiceOrder } from './game-api';
import { ACTIVITY_LABEL_GAME } from '@cenario/shared';
import { cenarioUrl } from '@/lib/links';

type Side =
  | { t: 'piece'; id: string }
  | { t: 'employee'; id: string }
  | { t: 'agent'; id: string }
  | { t: 'agentConfig'; agentId: string | null; deskId: string | null }
  | { t: 'desk'; id: string }
  | { t: 'station'; id: string }
  | { t: 'storage'; unitId: string; slotId: string | null }
  | { t: 'material'; id: string }
  | { t: 'mestre' }
  | { t: 'room' }
  | { t: 'integrations' }
  | { t: 'central' }
  | { t: 'inbox'; conv: string | null }
  | { t: 'ads' }
  | { t: 'marketing' }
  | { t: 'ficha'; so: string; focus: string | null }
  | { t: 'finance'; filter: string | null }
  | { t: 'quick'; f: MapFilter }
  | { t: 'goals'; tab: string | null; drill: Drill | null }
  | { t: 'os'; id: string }
  | { t: 'missions' }
  | { t: 'avatar' }
  | { t: 'logistics' }
  | { t: 'simulator' }
  | null;

/** Filtros rápidos do mapa (situação da etapa; o material fica na ficha da peça). */
type MapFilter = 'EM_EXECUCAO' | 'PARADOS' | 'ATRASADAS' | 'PRONTOS';
const MAP_FILTER_LABEL: Record<MapFilter, string> = {
  EM_EXECUCAO: '▶️ Em execução',
  PARADOS: '⏸️ Parados',
  ATRASADAS: '⚠️ Atrasadas',
  PRONTOS: '🚚 Prontas',
};
const MAP_FILTERS: Record<MapFilter, (p: GamePieceDto) => boolean> = {
  EM_EXECUCAO: QUICK_FILTERS.EM_EXECUCAO,
  PARADOS: QUICK_FILTERS.PARADOS,
  ATRASADAS: (p) => isLate(p),
  PRONTOS: QUICK_FILTERS.PRONTOS,
};

const SNAPSHOT_EVENTS = [
  'production.',
  'stock.',
  'material',
  'quality.',
  'item.',
  'purchase_order.',
  'attendance.',
  'help.',
  'issue.',
  'packaging',
  'delivery.',
  'service_order.',
  'notification.',
];

/** "Atualizado agora" / "Atualizado há 3 min": não parece cronômetro. */
function updatedAgo(at: number | undefined) {
  if (!at) return 'Atualizado';
  const min = Math.floor((Date.now() - at) / 60_000);
  return min < 1 ? 'Atualizado agora' : `Atualizado há ${min} min`;
}

export function GameWorld() {
  const can = useCan();
  const me = useMe();
  const cenarioStatus = me.data?.organization?.cenario.status ?? 'NAO_CONECTADA';
  const canBuild = can('jogo.construir');
  const canManageAgents = can('agentes.gerenciar');
  const canUseAgents = can('agentes.usar');
  const canSeeProduction = can('producao.ver') || can('producao.planejar');
  const qc = useQueryClient();
  const toast = useToast();
  const realtime = useRealtime();
  const spaces = useSpaces();
  const snapshot = useSnapshot(canSeeProduction);
  const agents = useAgents();
  const people = usePeople();
  const integrations = useIntegrations();
  const canSeeInbox = can('atendimento.ver');
  const canOffice = can('financeiro.ver') || can('pedidos.ver');
  const canFinView = can('financeiro.ver');
  const cash = useCash(canFinView);
  const goal = nextGoalOf(cash.data);
  const inbox = useInbox(canSeeInbox);
  const unread = (inbox.data ?? []).reduce((a, r) => a + r.unread, 0);
  const [spaceKey, setSpaceKey] = useState('TAPECARIA');
  const [mode, setMode] = useState<'GESTAO' | 'CONSTRUCAO'>('GESTAO');
  const [preview, setPreview] = useState(false);
  const [side, setSide] = useState<Side>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [overlays, setOverlays] = useState<Overlays>({});
  const [tip, setTip] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [quick, setQuick] = useState<MapFilter | null>(null);
  const isMobile = useIsMobile();
  const muted = useMuted();
  const [legendOpen, setLegendOpen] = useRemembered<boolean>(
    isMobile ? 'firma-resumo-aberto-cel' : 'firma-resumo-aberto',
    !isMobile, // no celular começa recolhido para sobrar tela para a oficina
  );
  const [chatOpenMobile, setChatOpenMobile] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [quality, setQualityState] = useState<{ quality: Quality; auto: boolean }>({
    quality: 'alta',
    auto: true,
  });
  const [hour, setHour] = useState<number | null>(null);
  const [dismissed, setDismissed] = useRemembered<string>('firma-avisos-lidos', '');
  const [ready, setReady] = useState(false);
  const [fade, setFade] = useState(false);
  const [progress, setProgress] = useState<{
    progress: Progress;
    missions: Mission[];
    week: { total: number; people: { id: string; name: string; n: number }[] };
  } | null>(null);
  const [replay, setReplay] = useState<{
    at: number;
    from: number;
    to: number;
    playing: boolean;
    speed: number;
  } | null>(null);
  const [tutorial, setTutorial] = useState(false);
  const [tutEvents, setTutEvents] = useState<Set<TutorialEvent>>(new Set());
  const tutEvent = useCallback((e: TutorialEvent) => {
    setTutEvents((s) => (s.has(e) ? s : new Set([...s, e])));
  }, []);
  const [mestre, setMestre] = useState<{
    history: { who: 'eu' | 'mestre'; text: string }[];
    pending: MestreReply | null;
  }>({ history: [], pending: null });
  const [impacts, setImpacts] = useState<RemovalImpact[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const editor = useLayoutDraft();
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [pending, setPending] = useState<Extract<
    CommandEffect,
    { kind: 'MOVER_PREVIA' | 'PLANTA' }
  > | null>(null);
  const [movePrev, setMovePrev] = useState<
    | (Extract<CommandEffect, { kind: 'MOVER_PREVIA' }> & {
        before: LayoutContent;
        applied: boolean;
      })
    | null
  >(null);
  const [assignPrev, setAssignPrev] = useState<
    | (Extract<CommandEffect, { kind: 'ATRIBUIR_PREVIA' }> & {
        result?: string;
        planId?: string | null;
      })
    | null
  >(null);
  const [cardBusy, setCardBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<GameEngine | null>(null);
  const pickRef = useRef<(t: PickTarget | null, p: { x: number; y: number } | null) => void>(
    () => {},
  );
  const dragRef = useRef<(t: PickTarget, x: number, y: number, phase: 'move' | 'end') => void>(
    () => {},
  );
  const arriveRef = useRef<(tag: string) => void>(() => {});
  const assignDropRef = useRef<(pieceId: string, userId: string) => void>(() => {});

  const space: GameSpaceDto | undefined =
    spaces.data?.find((s) => s.key === spaceKey) ?? spaces.data?.[0];
  const building = mode === 'CONSTRUCAO';
  const layout: LayoutContent | null = building && editor.draft ? editor.draft : (space ?? null);

  // Motor 3D (uma vez).
  useEffect(() => {
    if (!host.current) return;
    const e = new GameEngine(host.current, {
      onPick: (t, p) => pickRef.current(t, p),
      onDrag: (t, x, y, ph) => dragRef.current(t, x, y, ph),
      onArrive: (tag) => arriveRef.current(tag),
      onAssignDrop: (pieceId, userId) => assignDropRef.current(pieceId, userId),
      onQuality: () => setQualityState(e.getQuality()),
      onReady: () => window.setTimeout(() => setReady(true), 350),
      onStep: () => sound().play('step'),
    });
    engine.current = e;
    setQualityState(e.getQuality());
    // ?hora=21 mostra a luz de outra hora (prévia); sem parâmetro, hora real.
    const h = new URLSearchParams(window.location.search).get('hora');
    if (h !== null && !Number.isNaN(Number(h))) {
      e.setHour(Number(h));
      setHour(Number(h));
    }
    // Apoio a testes automatizados em desenvolvimento (nunca em produção).
    if (process.env.NODE_ENV !== 'production')
      (window as unknown as { __cenarioGame?: GameEngine }).__cenarioGame = e;
    return () => e.dispose();
  }, []);

  // Links diretos: /jogo?conversa=<id> (respostas dos agentes) e /jogo?central=<conexão> (retorno OAuth).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const conv = q.get('conversa');
    const central = q.get('central');
    const caixa = q.get('caixa');
    // Retorno da tela oficial do Cenário Gestão (conectar/reconectar).
    const conexao = q.get('conexao');
    if (conexao) {
      void qc.invalidateQueries();
      const msg = q.get('mensagem');
      if (conexao === 'ok') toast('ok', 'Cenário Gestão conectado. A empresa já aparece no mapa.');
      else toast('danger', msg ?? 'A conexão com o Cenário Gestão não foi concluída.');
    }
    if (caixa) {
      setSpaceKey('ESCRITORIO');
      setSide({
        t: 'goals',
        tab: null,
        drill: caixa.startsWith('moves:')
          ? { title: 'Lançamentos citados', query: caixa.slice(6) }
          : null,
      });
      window.history.replaceState(null, '', window.location.pathname);
    } else if (conv || central) {
      setSpaceKey('ESCRITORIO');
      setSide(conv ? { t: 'inbox', conv } : { t: 'central' });
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [qc, toast]);

  // Quadro de Metas no escritório: barra avança/recua com cada movimentação confirmada.
  const lastWeekSeen = useRef<string | null>(null);
  useEffect(() => {
    const e = engine.current;
    const b = cash.data;
    if (!e || !b) return;
    const g = nextGoalOf(b);
    if (g)
      e.setGoalBoard({
        fraction: g.balanceCents / g.targetCents,
        text: `🎯 ${brlCents(g.balanceCents)} de ${brlCents(g.targetCents)} (${g.pctOfGoal.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%)`,
        tone: g.belowAfterAchieved ? '#b42323' : '#1f7a46',
      });
    // Conquista nova (ainda não comemorada neste navegador): confete e aviso.
    let seen: string[] = [];
    try {
      seen = JSON.parse(
        window.localStorage.getItem('cenario-metas-comemoradas') ?? '[]',
      ) as string[];
    } catch {
      seen = [];
    }
    const fresh = b.goals.filter((x) => x.achieved && !seen.includes(x.id));
    if (fresh.length) {
      e.celebrate();
      // Pronto para mandar no WhatsApp e no Instagram (o valor só aparece se marcar).
      setGoalShare(fresh[0]!);
      toast(
        'ok',
        `🏆 Meta conquistada: ${fresh.map((x) => `${x.name} em ${x.achieved!.at.slice(0, 10).split('-').reverse().join('/')}`).join(', ')}`,
      );
      try {
        window.localStorage.setItem(
          'cenario-metas-comemoradas',
          JSON.stringify([...seen, ...fresh.map((x) => x.id)]),
        );
      } catch {
        /* sem armazenamento: comemora de novo na próxima vez */
      }
    }
    // Entrega concluída (fluxo oficial): comemora uma vez; o saldo segue em A receber.
    let seenDel: string[] = [];
    try {
      seenDel = JSON.parse(
        window.localStorage.getItem('cenario-entregas-comemoradas') ?? '[]',
      ) as string[];
    } catch {
      seenDel = [];
    }
    const freshDel = (b.deliveries ?? []).filter((d) => !seenDel.includes(d.id));
    if (freshDel.length) {
      e.celebrate();
      toast(
        'ok',
        `🚚 Entrega concluída: ${freshDel.map((d) => `${d.osCodes.join(', ')} (${d.customer})${d.openCents > 0 ? ` — saldo ${brlCents(d.openCents)} em A receber` : ''}`).join('; ')}`,
      );
      try {
        window.localStorage.setItem(
          'cenario-entregas-comemoradas',
          JSON.stringify([...seenDel, ...freshDel.map((d) => d.id)]),
        );
      } catch {
        /* ignora */
      }
    }
    // Semana recém-fechada: anima a barra da abertura ao fechamento (uma vez).
    const closed = b.weeks.find((w) => !w.partial);
    if (closed && g && lastWeekSeen.current === null) {
      let last = '';
      try {
        last = window.localStorage.getItem('cenario-metas-semana') ?? '';
      } catch {
        last = '';
      }
      lastWeekSeen.current = closed.weekStart;
      if (last !== closed.weekStart) {
        e.setGoalBoard({
          from: closed.openingCents / g.targetCents,
          fraction: g.balanceCents / g.targetCents,
          text: `Semana fechada: ${signedBrl(closed.deltaCents)} (${signedPct(closed.pct)})`,
          tone: closed.deltaCents >= 0 ? '#1f7a46' : '#b42323',
        });
        try {
          window.localStorage.setItem('cenario-metas-semana', closed.weekStart);
        } catch {
          /* ignora */
        }
      }
    }
  }, [cash.data, layout, toast]);

  // Tempo real: qualquer mudança operacional recarrega o retrato; a planta e os agentes também.
  useEffect(
    () =>
      realtime.subscribe((ev) => {
        if (SNAPSHOT_EVENTS.some((p) => ev.type.startsWith(p)))
          void qc.invalidateQueries({ queryKey: ['game-snapshot'] });
        // Reserva, entrada, recebimento de compra: ficha (materiais) e estante na hora.
        if (/^(stock\.|material|purchase_order\.|receipt|reservation)/.test(ev.type))
          for (const k of ['game-readiness', 'game-slot', 'game-material', 'needs'])
            void qc.invalidateQueries({ queryKey: [k] });
        if (ev.type === 'game.layout_saved')
          void qc.invalidateQueries({ queryKey: ['game-spaces'] });
        if (ev.type === 'game.agent_changed' || ev.type === 'game.proposal_changed') {
          void qc.invalidateQueries({ queryKey: ['game-agents'] });
          void qc.invalidateQueries({ queryKey: ['game-agent'] });
          void qc.invalidateQueries({ queryKey: ['agent-actions'] });
        }
        if (ev.type.startsWith('inbox.')) {
          void qc.invalidateQueries({ queryKey: ['inbox'] });
          void qc.invalidateQueries({ queryKey: ['inbox-conv'] });
          void qc.invalidateQueries({ queryKey: ['agent-actions'] });
        }
        if (ev.type.startsWith('office.') || ev.type.startsWith('finance.'))
          void qc.invalidateQueries({
            predicate: (q) => String(q.queryKey[0]).startsWith('office'),
          });
        if (ev.type.startsWith('connection.')) {
          void qc.invalidateQueries({ queryKey: ['connections'] });
          void qc.invalidateQueries({ queryKey: ['game-integrations'] });
        }
      }),
    [realtime, qc],
  );
  // Ao reconectar, recupera o estado correto do servidor.
  const lastStatus = useRef(realtime.status);
  useEffect(() => {
    if (realtime.status === 'online' && lastStatus.current !== 'online') {
      void qc.invalidateQueries({ queryKey: ['game-snapshot'] });
      void qc.invalidateQueries({ queryKey: ['game-spaces'] });
      void qc.invalidateQueries({ queryKey: ['game-agents'] });
    }
    lastStatus.current = realtime.status;
  }, [realtime.status, qc]);

  const agentDesks = useMemo(
    () =>
      Object.fromEntries(
        (agents.data ?? [])
          .filter((a) => a.deskStationId && a.status !== 'DESATIVADO')
          .map((a) => [a.deskStationId!, { name: a.name, color: a.color, status: a.status }]),
      ),
    [agents.data],
  );

  // Cena estática (planta). Só reconstrói quando algo dela muda de fato: as recompensas e o replay
  // entram como valores simples (antes, cada atualização da produção refazia a sala inteira).
  const rewardsKey = (progress?.progress.rewards ?? []).join(',');
  const replayOn = Boolean(replay);
  useEffect(() => {
    if (!engine.current || !layout) return;
    engine.current.setLayout(layout, {
      mode,
      preview,
      selectedId: building
        ? (sel?.id ?? null)
        : side && 'id' in side
          ? side.id
          : side?.t === 'storage'
            ? side.unitId
            : null,
      slotTones: snapshot.data?.slotAlerts ?? {},
      editable: canBuild,
      snapCm: 10,
      agentDesks,
      canAssign: Boolean(snapshot.data?.canPlan) && !replayOn,
      rewards: rewardsKey ? rewardsKey.split(',') : [],
    });
  }, [
    layout,
    mode,
    preview,
    sel,
    side,
    snapshot.data?.slotAlerts,
    snapshot.data?.canPlan,
    canBuild,
    agentDesks,
    building,
    replayOn,
    rewardsKey,
  ]);

  // Destaque da seleção: o que está aberto no painel fica em evidência, o resto escurece.
  useEffect(() => {
    const id =
      building || !side
        ? null
        : side.t === 'piece' || side.t === 'employee' || side.t === 'agent' || side.t === 'station'
          ? side.id
          : side.t === 'storage'
            ? side.unitId
            : null;
    engine.current?.setFocus(id);
  }, [side, building]);

  // Peças e pessoas (dinâmico). No replay, o retrato é reconstruído no instante escolhido.
  const replayMinute = replay ? Math.floor(replay.at / 60_000) : null;
  useEffect(() => {
    const e = engine.current;
    if (!e || !layout || !space) return;
    const workshop = space.key === 'TAPECARIA';
    const snap =
      replay && snapshot.data && workshop
        ? snapshotAt(layout, snapshot.data, replay.at)
        : snapshot.data;
    const pieces =
      workshop && snap
        ? piecesOnMap(layout, snap.pieces, highlight, quick ? MAP_FILTERS[quick] : undefined)
        : [];
    e.setPieces(pieces);
    e.setPeople(
      peopleOnMap(
        layout,
        space.kind,
        workshop ? (snap?.employees ?? []) : [],
        space.kind === 'ESCRITORIO' || !workshop
          ? (agents.data ?? []).filter((a) => layout.stations.some((s) => s.id === a.deskStationId))
          : [],
        snap?.pieces ?? [],
        replay?.at ?? Date.now(),
      ),
    );
    // Ambiente de som acompanha quanta gente está trabalhando.
    sound().setActivity(
      (snap?.employees ?? []).filter((x) => x.currentTask && x.currentTask.status !== 'PAUSADA')
        .length,
    );
    // `replay` entra só pelo minuto (replayMinute), para não redesenhar a cada quadro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    snapshot.data,
    agents.data,
    layout,
    space,
    highlight,
    building,
    preview,
    quick,
    replayMinute,
  ]);

  // Replay: avança o relógio (1× = 1 hora por segundo).
  useEffect(() => {
    if (!replay?.playing) return;
    const id = window.setInterval(() => {
      setReplay((r) => {
        if (!r || !r.playing) return r;
        const at = Math.min(r.to, r.at + r.speed * 3600_000 * 0.1);
        return { ...r, at, playing: at < r.to };
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [replay?.playing]);

  // Novidades do retrato: etapa iniciada, peça pronta, atraso novo, etapa concluída.
  const prevSnap = useRef<typeof snapshot.data | null>(null);
  useEffect(() => {
    const cur = snapshot.data;
    const prev = prevSnap.current;
    prevSnap.current = cur ?? null;
    const e = engine.current;
    if (!cur || !prev || !e || replay || spaceKey !== 'TAPECARIA') return;
    const prevTasks = new Map(prev.pieces.flatMap((p) => p.tasks.map((t) => [t.id, t.status])));
    let started = false;
    for (const p of cur.pieces) {
      for (const t of p.tasks) {
        const before = prevTasks.get(t.id);
        if (
          t.status === 'EM_EXECUCAO' &&
          before &&
          before !== 'EM_EXECUCAO' &&
          before !== 'PAUSADA'
        )
          started = true;
        if (t.status === 'CONCLUIDA' && before && before !== 'CONCLUIDA' && t.assigneeUserId)
          e.celebrateAt(
            t.assigneeUserId,
            `✓ ${ACTIVITY_LABEL_GAME[t.activity] ?? 'Etapa'} concluída`,
          );
      }
      const old = prev.pieces.find((x) => x.id === p.id);
      const readyNow = ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE'];
      if (old && !readyNow.includes(old.stage) && readyNow.includes(p.stage)) {
        e.celebrateAt(p.id, p.stage === 'EM_TRANSPORTE' ? '🚚 Saiu para entrega!' : '🎉 Pronta!');
        sound().play('celebrate');
      }
      if (old && !isLate(old) && isLate(p)) sound().play('late');
    }
    if (started) sound().play('task');
  }, [snapshot.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Missões, nível e placar (a partir do trabalho real), guardados no servidor por empresa.
  const orgId = me.data?.organization?.id ?? null;
  const userId = me.data?.user.id ?? null;
  const progressQ = useProgressStore(Boolean(orgId));
  const storeRef = useRef<ProgressStore | null>(null);
  const legacyChecked = useRef(false);
  const sendProgress = useCallback(
    (delta: ProgressDelta & { importXp?: number }) =>
      api<ProgressStore>('/api/v1/game/progress', { method: 'POST', body: delta })
        .then((srv) => {
          storeRef.current = mergeStores(srv, storeRef.current ?? srv);
          qc.setQueryData(['game-progress'], srv);
          const xp = storeRef.current.xp;
          setProgress((p) => (p ? { ...p, progress: progressOf(xp) } : p));
          return true;
        })
        .catch(() => false),
    [qc],
  );
  useEffect(() => {
    if (!orgId) return;
    if (progressQ.data) {
      storeRef.current = storeRef.current
        ? mergeStores(progressQ.data, storeRef.current)
        : progressQ.data;
      // Progresso antigo deste navegador: vai para o servidor uma vez e sai daqui.
      if (!legacyChecked.current) {
        legacyChecked.current = true;
        const old = legacyStore(orgId);
        if (old && !progressQ.data.imported && old.xp > 0) {
          void sendProgress({
            importXp: old.xp,
            tasks: Object.entries(old.tasks).map(([id, [user, day]]) => ({ id, user, day, xp: 0 })),
            onTime: old.onTime.map((id) => ({ id, xp: 0 })),
            paid: old.paid.map((key) => ({ key, xp: 0 })),
          }).then((ok) => ok && forgetLegacy(orgId));
          storeRef.current = mergeStores(storeRef.current, old);
        } else if (old) forgetLegacy(orgId);
      }
    } else if (progressQ.isError && !storeRef.current) {
      // Servidor fora: segue com o que o navegador tiver (e tenta mandar depois).
      storeRef.current = legacyStore(orgId) ?? emptyStore();
    }
  }, [orgId, progressQ.data, progressQ.isError, sendProgress]);
  const storeReady = Boolean(progressQ.data || progressQ.isError);
  useEffect(() => {
    if (!orgId || !snapshot.data || replay || !storeRef.current) return;
    const r = updateProgress(storeRef.current, snapshot.data);
    storeRef.current = r.store;
    setProgress({ progress: r.progress, missions: r.missions, week: r.week });
    if (!deltaEmpty(r.delta)) void sendProgress(r.delta);
    for (const m of r.freshMissions) {
      toast('ok', `🎯 Missão cumprida: ${m.title} (+${m.xp} XP)`);
      engine.current?.celebrate();
      sound().play('celebrate');
    }
    if (r.leveledUp) {
      toast('ok', `⭐ A oficina subiu para o nível ${r.progress.level}: ${r.progress.levelName}!`);
      sound().play('celebrate');
    }
  }, [orgId, snapshot.data, storeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Boneco "Você": aparência salva na conta; o painel mostra a mudança na hora.
  const avatarQ = useAvatarLook();
  const [lookDraft, setLookDraft] = useState<AvatarLook | null>(null);
  const [lookSaving, setLookSaving] = useState(false);
  const savedLook = avatarQ.data?.look ?? null;
  const shownLook = lookDraft ?? savedLook;
  useEffect(() => {
    engine.current?.setPlayerLook(shownLook);
  }, [shownLook, layout]);
  const saveLook = async () => {
    if (!lookDraft) return;
    setLookSaving(true);
    try {
      const r = await api<{ look: AvatarLook }>('/api/v1/game/avatar', {
        method: 'PUT',
        body: lookDraft,
      });
      qc.setQueryData(['game-avatar'], r);
      setLookDraft(null);
      toast('ok', 'Boneco salvo. Ele aparece assim em qualquer computador.');
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível salvar o boneco.');
    } finally {
      setLookSaving(false);
    }
  };
  const openAvatar = () => {
    setSettingsOpen(false);
    setSide({ t: 'avatar' });
    const p = engine.current?.playerCm();
    if (p) engine.current?.focus(p.x, p.y, 5);
  };

  // Furgão e cliente na entrada: entregas e retiradas de hoje (rotas oficiais do Cenário).
  const logistics = useTodayLogistics(canSeeProduction && cenarioStatus === 'CONECTADA');
  useEffect(() => {
    engine.current?.setLogistics(logisticsView(logistics.data));
  }, [logistics.data, layout]);

  // Imagem para compartilhar (meta batida ou a semana da oficina).
  const [share, setShare] = useState<ShareCard | null>(null);
  const [goalShare, setGoalShare] = useState<NonNullable<typeof cash.data>['goals'][number] | null>(
    null,
  );
  const companyName = me.data?.organization?.name ?? '';

  // Aviso do navegador com o jogo em outra aba.
  useTabNotifications(snapshot.data, unread, (id) => {
    if (id) {
      if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
      setSide({ t: 'piece', id });
      setHighlight(id);
    } else if (canSeeInbox) setSide({ t: 'inbox', conv: null });
  });

  // Bom dia do Gerente: uma vez por dia, depois de carregar (e fora do tutorial).
  const [morning, setMorning] = useState(false);
  useEffect(() => {
    if (
      !ready ||
      tutorial ||
      !orgId ||
      !userId ||
      !snapshot.data ||
      morningSeenToday(orgId, userId)
    )
      return;
    const t = window.setTimeout(() => setMorning(true), 900);
    return () => window.clearTimeout(t);
  }, [ready, tutorial, orgId, userId, snapshot.data]);
  const closeMorning = () => {
    setMorning(false);
    if (orgId && userId) markMorningSeen(orgId, userId);
  };

  const prog = progress?.progress ?? progressOf(0);

  // Tutorial no primeiro acesso (depois de carregar).
  useEffect(() => {
    if (ready && !tutorialSeen()) {
      const t = window.setTimeout(() => setTutorial(true), 600);
      return () => window.clearTimeout(t);
    }
  }, [ready]);

  useEffect(() => {
    engine.current?.setOverlays(overlays);
  }, [overlays]);

  const viewCenter = () =>
    engine.current?.viewCenterCm() ?? {
      x: (layout?.widthCm ?? 600) / 2,
      y: (layout?.depthCm ?? 600) / 2,
    };

  const enterBuild = () => {
    if (!space) return;
    editor.load(space);
    setDraftKey(space.key);
    setMode('CONSTRUCAO');
    setPreview(false);
    setSide({ t: 'mestre' });
    setSel(null);
    if (!mestre.history.length)
      setMestre({
        history: [{ who: 'mestre', text: askMestre(space, 'ajuda').lines.join('\n') }],
        pending: null,
      });
  };
  const leaveBuild = () => {
    if (editor.dirty && !window.confirm('Há mudanças não salvas na planta. Sair e descartar?'))
      return;
    setMode('GESTAO');
    setSel(null);
    setSide(null);
    setOverlays({});
    setTip(null);
  };
  const switchSpace = (key: string) => {
    if (
      building &&
      editor.dirty &&
      !window.confirm('Há mudanças não salvas. Trocar de ambiente e descartar?')
    )
      return;
    if (key === spaceKey) return;
    const from = spaceKey;
    // Transição suave: escurece, troca e clareia.
    setFade(true);
    sound().play('whoosh');
    window.setTimeout(() => setFade(false), 380);
    if (key === 'ESCRITORIO') tutEvent('office');
    if (replay) setReplay(null);
    setSpaceKey(key);
    setSide(null);
    setSel(null);
    setOverlays({});
    const next = spaces.data?.find((s) => s.key === key);
    if (building && next) {
      editor.load(next);
      setDraftKey(next.key);
    }
    window.setTimeout(() => engine.current?.placePlayerAtDoorTo(from), 50);
  };

  // ───────────── Clique no mapa ─────────────
  pickRef.current = (t, p) => {
    const e = engine.current;
    if (!layout || !e) return;
    if (building && !preview) {
      if (!t) {
        setSel(null);
        setOverlays((o) => ({ ...o, problems: [] }));
        return;
      }
      if (t.kind === 'mestre') return setSide({ t: 'mestre' });
      if (t.kind === 'handle') return;
      if (t.kind === 'door') return setSide({ t: 'room' });
      if (['station', 'storage', 'decor', 'area', 'wall'].includes(t.kind)) {
        setSel({ kind: t.kind as 'station', id: t.id });
        setSide(null);
        const o = [...layout.stations, ...layout.storageUnits, ...layout.doc.decor].find(
          (x) => x.id === t.id,
        );
        if (o) {
          const probs = clearanceAround(
            layout,
            o.id,
            footprint(o),
            catalogOf(o.kind).frontClearCm,
            o.rotation,
          );
          setOverlays({ problems: probs });
          setTip(dragTip(probs));
        }
      }
      return;
    }
    if (!t) {
      if (p) {
        e.walkTo(p.x, p.y);
        setOverlays({ pulse: p });
      }
      return;
    }
    const walkNear = (x: number, y: number, tag: string | null = null) => e.walkTo(x, y, tag);
    if (t.kind !== 'area' && t.kind !== 'door') sound().play('open');
    switch (t.kind) {
      case 'piece': {
        tutEvent('piece');
        setSide({ t: 'piece', id: t.id });
        setHighlight(t.id);
        if (p) walkNear(p.x, p.y);
        break;
      }
      case 'employee':
        setSide({ t: 'employee', id: t.id });
        if (p) walkNear(p.x, p.y);
        break;
      case 'agent':
        tutEvent('agent');
        setSide(canUseAgents ? { t: 'agent', id: t.id } : null);
        if (!canUseAgents) toast('danger', 'Sua conta não conversa com agentes (agentes.usar).');
        break;
      case 'station': {
        const st = layout.stations.find((s) => s.id === t.id);
        const agent = agents.data?.find(
          (a) => a.deskStationId === t.id && a.status !== 'DESATIVADO',
        );
        if (st?.kind === 'QUADRO_METAS' && canFinView)
          setSide({ t: 'goals', tab: null, drill: null });
        else if (agent && canUseAgents) {
          tutEvent('agent');
          setSide({ t: 'agent', id: agent.id });
        } else if (st && catalogOf(st.kind).desk) setSide({ t: 'desk', id: t.id });
        else setSide({ t: 'station', id: t.id });
        if (p) walkNear(p.x, p.y);
        break;
      }
      case 'storage': {
        const u = layout.storageUnits.find((x) => x.id === t.id);
        const slot = u
          ? ([...u.slots].sort((a, b) => a.level - b.level)[(t.level ?? 1) - 1] ?? u.slots[0])
          : null;
        setSide({ t: 'storage', unitId: t.id, slotId: slot?.id ?? null });
        if (p) walkNear(p.x, p.y);
        break;
      }
      case 'door': {
        const d = layout.doc.doors.find((x) => x.id === t.id);
        if (d?.toSpaceKey && spaces.data?.some((s) => s.key === d.toSpaceKey)) {
          if (p && !walkNear(p.x, p.y, `door:${d.toSpaceKey}`)) switchSpace(d.toSpaceKey);
        } else if (p) walkNear(p.x, p.y);
        break;
      }
      case 'area':
        if (p) walkNear(p.x, p.y);
        break;
      case 'van':
      case 'visitor':
        setSide({ t: 'logistics' });
        break;
      case 'player':
        openAvatar();
        break;
      default:
        break;
    }
  };
  arriveRef.current = (tag) => {
    if (tag.startsWith('door:')) switchSpace(tag.slice(5));
  };

  // ───────────── Arrastar peça até funcionário (atribuir etapa) ─────────────
  assignDropRef.current = (pieceId, userId) => {
    const p = snapshot.data?.pieces.find((x) => x.id === pieceId);
    const emp = snapshot.data?.employees.find((x) => x.userId === userId);
    if (!p || !emp) return;
    tutEvent('assign');
    const task =
      p.nextTask ??
      p.tasks.find(
        (t) => !['CONCLUIDA', 'CANCELADA', 'EM_EXECUCAO', 'PAUSADA'].includes(t.status),
      ) ??
      null;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    if (p.currentTask && !task) {
      sound().play('error');
      toast(
        'danger',
        `${p.itemCode} já está em execução com ${p.currentTask.assigneeName ?? 'alguém'}. A troca acontece no tablet.`,
      );
      return;
    }
    sound().play('click');
    setAssignPrev(
      task
        ? {
            kind: 'ATRIBUIR_PREVIA',
            mode: 'TROCAR_RESPONSAVEL',
            serviceOrderId: p.serviceOrderId,
            osCode: p.osCode,
            pieceLabel: `${p.itemCode} · ${p.description}`,
            etapa: ACTIVITY_LABEL_GAME[task.activity] ?? task.title,
            funcionario: emp.name,
            userId,
            data: task.scheduledAt?.slice(0, 10) ?? today,
            taskId: task.id,
            taskVersion: task.version,
            published: task.status !== 'RASCUNHO',
            pieces: [],
          }
        : {
            kind: 'ATRIBUIR_PREVIA',
            mode: 'PLANEJAR',
            serviceOrderId: p.serviceOrderId,
            osCode: p.osCode,
            pieceLabel: `${p.itemCode} · ${p.description}`,
            etapa: 'Planejar o serviço',
            funcionario: emp.name,
            userId,
            data: today,
            taskId: null,
            taskVersion: null,
            published: false,
            pieces: [{ serviceOrderItemId: p.id, upholstererUserId: userId }],
          },
    );
    if (isMobile) setChatOpenMobile(true);
  };

  // ───────────── Arraste (Construção) ─────────────
  dragRef.current = (t, x, y, phase) => {
    const l = editor.draft;
    const e = engine.current;
    if (!l || !e) return;
    if (t.kind === 'handle') {
      if (phase === 'end') editor.live((d) => dragHandle(d, t.id, x, y), true);
      else {
        const tmp = JSON.parse(JSON.stringify(l)) as LayoutContent;
        dragHandle(tmp, t.id, x, y);
        const [aid] = t.id.split(':');
        const a = tmp.areas.find((z) => z.id === aid);
        setOverlays({
          highlights: [a ? rectOfArea(a) : { x: 0, y: 0, w: tmp.widthCm, d: tmp.depthCm }],
        });
      }
      return;
    }
    if (t.kind === 'wall') {
      if (phase === 'end') editor.live((d) => moveWall(d, t.id, x, y), true);
      return;
    }
    if (t.kind === 'area') {
      const a = l.areas.find((z) => z.id === t.id);
      if (!a) return;
      if (phase === 'end') {
        editor.live((d) => moveObj(d, t.id, x, y), true);
        setOverlays({});
      } else setOverlays({ highlights: [{ x, y, w: a.wCm, d: a.dCm }] });
      return;
    }
    const o = [...l.stations, ...l.storageUnits, ...l.doc.decor].find((z) => z.id === t.id);
    if (!o) return;
    const rect = footprint({ ...o, xCm: x, yCm: y });
    const probs: ClearanceProblem[] = clearanceAround(
      l,
      o.id,
      rect,
      catalogOf(o.kind).frontClearCm,
      o.rotation,
    );
    setOverlays({ problems: probs });
    setTip(dragTip(probs));
    if (phase === 'move') e.previewMove(o.id, x, y);
    else editor.live((d) => moveObj(d, o.id, x, y), true);
  };

  // ───────────── Teclado ─────────────
  const selRef = useRef(sel);
  selRef.current = sel;
  const doRotate = useCallback(
    () => selRef.current && editor.apply((l) => rotateObj(l, selRef.current!.id)),
    [editor],
  );
  const doDuplicate = useCallback(() => {
    if (!selRef.current) return;
    let nid: string | null = null;
    editor.apply((l) => {
      nid = duplicateObj(l, selRef.current!.id);
    });
    window.setTimeout(() => nid && setSel({ kind: selRef.current!.kind, id: nid }), 0);
  }, [editor]);
  const doRemove = useCallback(() => {
    if (!selRef.current) return;
    editor.apply((l) => removeObj(l, selRef.current!.id));
    setSel(null);
    setOverlays({});
  }, [editor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        setSel(null);
        setSide(null);
        setOverlays({});
        setShortcutsOpen(false);
        setSettingsOpen(false);
      }
      if (k === '+' || k === '=') engine.current?.zoomBy(1 / 1.15);
      if (k === '-') engine.current?.zoomBy(1.15);
      if (k === '?' || (k === '/' && e.shiftKey)) setShortcutsOpen((v) => !v);
      if (k === 'c' && !e.ctrlKey && !e.metaKey) engine.current?.overview();
      if (k === 'm' && !e.ctrlKey && !e.metaKey) sound().setMuted(!sound().isMuted());
      if (mode !== 'CONSTRUCAO' || preview) return;
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        editor.redo();
      } else if (k === 'r') doRotate();
      else if (k === 'd' && !e.ctrlKey) doDuplicate();
      else if (k === 'delete' || k === 'backspace') doRemove();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, preview, editor, doRotate, doDuplicate, doRemove]);

  // ───────────── Salvar ─────────────
  const save = async (
    transfers?: {
      areas: Record<string, string>;
      stations: Record<string, string>;
      slots: Record<string, string>;
    },
    override?: LayoutContent,
  ) => {
    const body0 = override ?? editor.draft;
    if (!body0 || !space) return;
    setSaving(true);
    try {
      const saved = await api<GameSpaceDto>(`/api/v1/game/spaces/${space.key}`, {
        method: 'PUT',
        idempotencyKey: newIdempotencyKey(),
        body: { ...body0, version: space.version, ...(transfers ? { transfers } : {}) },
      });
      qc.setQueryData<GameSpaceDto[]>(['game-spaces'], (old) =>
        old?.map((s) => (s.key === saved.key ? saved : s)),
      );
      editor.load(saved);
      setImpacts(null);
      toast('ok', `Planta salva (versão ${saved.version}).`);
      void qc.invalidateQueries({ queryKey: ['game-snapshot'] });
      void qc.invalidateQueries({ queryKey: ['game-revisions', saved.key] });
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        (e.details as { impacts?: RemovalImpact[] } | undefined)?.impacts
      ) {
        setImpacts((e.details as { impacts: RemovalImpact[] }).impacts);
      } else if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        toast(
          'danger',
          'Outra pessoa salvou esta planta antes. Recarregue o ambiente (suas mudanças ficam no rascunho até você sair).',
        );
        void qc.invalidateQueries({ queryKey: ['game-spaces'] });
      } else toast('danger', e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  const reset = async (start: 'SUGERIDA' | 'EM_BRANCO') => {
    if (
      !space ||
      !window.confirm(
        start === 'SUGERIDA'
          ? 'Recomeçar da planta sugerida? Os vínculos atuais serão desfeitos.'
          : 'Recomeçar do zero? A sala fica vazia (só a porta).',
      )
    )
      return;
    try {
      const saved = await api<GameSpaceDto>(`/api/v1/game/spaces/${space.key}/reset`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { version: space.version, start },
      });
      qc.setQueryData<GameSpaceDto[]>(['game-spaces'], (old) =>
        old?.map((s) => (s.key === saved.key ? saved : s)),
      );
      editor.load(saved);
      toast('ok', 'Planta recomeçada.');
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível recomeçar.');
    }
  };

  const createSpace = async () => {
    const name = window.prompt('Nome do novo ambiente (ex.: Depósito, Showroom, Escritório 2):');
    if (!name) return;
    const office = /escrit/i.test(name);
    const dims = window.prompt(
      'Medidas em metros (largura x profundidade):',
      office ? '8 x 6' : '6 x 5',
    );
    const m = /([\d.,]+)\s*[x×]\s*([\d.,]+)/i.exec(dims ?? '');
    if (!m) return;
    try {
      const s = await api<GameSpaceDto>('/api/v1/game/spaces', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: {
          name,
          kind: office ? 'ESCRITORIO' : 'OUTRO',
          widthCm: Math.round(Number(m[1]!.replace(',', '.')) * 100),
          depthCm: Math.round(Number(m[2]!.replace(',', '.')) * 100),
          start: 'EM_BRANCO',
        },
      });
      await qc.invalidateQueries({ queryKey: ['game-spaces'] });
      setSpaceKey(s.key);
      editor.load(s);
      toast('ok', `Ambiente ${s.name} criado. Abra uma porta para ligá-lo aos outros.`);
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível criar o ambiente.');
    }
  };

  const addFromPalette = (p: PaletteItem) => {
    const at = viewCenter();
    let id: string | null = null;
    editor.apply((l) => {
      id =
        p.type === 'station'
          ? addStation(l, p.kind, at)
          : p.type === 'storage'
            ? addStorage(l, p.kind, at)
            : p.type === 'decor'
              ? addDecor(l, p.kind, at)
              : p.type === 'area'
                ? addArea(l, p.fn, at)
                : addWall(l, at);
    });
    window.setTimeout(
      () =>
        id &&
        setSel({ kind: p.type === 'area' ? 'area' : p.type === 'wall' ? 'wall' : p.type, id }),
      0,
    );
  };

  const askTheMestre = (text: string) => {
    if (!editor.draft) return;
    const reply = askMestre(editor.draft, text);
    setMestre((m) => ({
      history: [...m.history, { who: 'eu', text }, { who: 'mestre', text: reply.lines.join('\n') }],
      pending: reply,
    }));
    const s = reply.suggestion;
    setOverlays(
      s
        ? {
            problems: s.problems,
            highlights: s.highlights,
            path: s.path ?? null,
            preview: [
              ...(s.patch.addStations ?? []).map(footprint),
              ...(s.patch.addAreas ?? []).map(rectOfArea),
            ],
          }
        : {},
    );
    // Enquadra tudo o que foi marcado (sugestões, caminho e apertos), inclusive a sala ampliada.
    const rects = [
      ...(s?.highlights ?? []),
      ...(s?.problems.map((p) => p.rect) ?? []),
      ...(s?.path?.map((p) => ({ x: p.x, y: p.y, w: 1, d: 1 })) ?? []),
    ];
    if (rects.length) {
      const x0 = Math.min(...rects.map((r) => r.x));
      const y0 = Math.min(...rects.map((r) => r.y));
      const x1 = Math.max(...rects.map((r) => r.x + r.w));
      const y1 = Math.max(...rects.map((r) => r.y + r.d));
      engine.current?.fitRect({
        x: x0,
        y: y0,
        w: Math.max(200, x1 - x0),
        d: Math.max(200, y1 - y0),
      });
    }
    if (
      reply.followUp === 'CONFIGURAR_AGENTE' &&
      spaceKey !== 'ESCRITORIO' &&
      spaces.data?.some((x) => x.key === 'ESCRITORIO')
    )
      setMestre((m) => ({
        ...m,
        history: [...m.history, { who: 'mestre', text: 'Dica: use a aba Escritório no topo.' }],
      }));
  };
  const applyMestre = () => {
    const s = mestre.pending?.suggestion;
    if (!s) return;
    editor.apply((l) => applyPatch(l, s.patch));
    setMestre((m) => ({
      history: [
        ...m.history,
        {
          who: 'mestre',
          text: 'Apliquei no rascunho. Ajuste à vontade e salve. Se não gostar: Ctrl+Z.',
        },
      ],
      pending: { ...m.pending!, suggestion: undefined },
    }));
    setOverlays({ path: s.path ?? null });
    const added = s.patch.addStations?.[0];
    if (added) setSel({ kind: 'station', id: added.id });
  };

  // ───────────── Busca ─────────────
  const term = q.trim().toLowerCase();
  const matSearch = useMaterialSearch(
    term,
    term.length >= 2 && (can('estoque.ver') || can('estoque.gerenciar') || can('compras.ver')),
  );
  const results = useMemo(() => {
    if (term.length < 2) return [];
    const pieces = (snapshot.data?.pieces ?? [])
      .filter((p) =>
        [p.itemCode, p.osCode, p.customerName ?? '', p.description].some((s) =>
          s.toLowerCase().includes(term),
        ),
      )
      .slice(0, 6)
      .map((p) => ({
        key: `p${p.id}`,
        icon: '🛋️',
        label: `${p.itemCode} · ${p.description}`,
        sub: `${p.customerName ?? ''} · ${p.placement.label}`,
        go: () => goPiece(p.id),
      }));
    const emp = (snapshot.data?.employees ?? [])
      .filter((e) => e.name.toLowerCase().includes(term))
      .map((e) => ({
        key: `e${e.userId}`,
        icon: '👷',
        label: e.name,
        sub: e.currentTask?.title ?? 'sem tarefa iniciada',
        go: () => goEmployee(e.userId),
      }));
    const ag = (agents.data ?? [])
      .filter((a) => `${a.name} ${a.roleLabel}`.toLowerCase().includes(term))
      .map((a) => ({
        key: `a${a.id}`,
        icon: '🤖',
        label: a.name,
        sub: a.roleLabel,
        go: () => goAgent(a.id),
      }));
    const mats = (matSearch.data ?? []).slice(0, 6).map((m) => ({
      key: `m${m.stockItemId}`,
      icon: '🧵',
      label: `${m.code} · ${m.description}`,
      sub:
        m.locations[0]?.address ??
        (m.legacyLocation ? `cadastro: ${m.legacyLocation}` : 'sem posição no mapa'),
      go: () => goMaterial(m.stockItemId, m.locations[0]),
    }));
    return [...pieces, ...emp, ...ag, ...mats];
  }, [term, snapshot.data, agents.data, matSearch.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const goPiece = (id: string) => {
    setSearchOpen(false);
    if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
    setHighlight(id);
    setSide({ t: 'piece', id });
    window.setTimeout(() => {
      const ws = spaces.data?.find((s) => s.key === 'TAPECARIA');
      const vis =
        ws && snapshot.data
          ? piecesOnMap(ws, snapshot.data.pieces, id).find((v) => v.id === id)
          : null;
      if (vis) {
        engine.current?.focus(vis.x, vis.y, 9);
        engine.current?.walkTo(vis.x, vis.y + 80);
        setOverlays({ pulse: { x: vis.x, y: vis.y } });
      }
    }, 120);
  };
  const goEmployee = (userId: string) => {
    setSearchOpen(false);
    if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
    setSide({ t: 'employee', id: userId });
    window.setTimeout(() => {
      const ws = spaces.data?.find((s) => s.key === 'TAPECARIA');
      const v =
        ws && snapshot.data
          ? peopleOnMap(ws, 'OFICINA', snapshot.data.employees, []).find((x) => x.id === userId)
          : null;
      if (v) {
        engine.current?.focus(v.x, v.y, 9);
        setOverlays({ pulse: { x: v.x, y: v.y } });
      }
    }, 120);
  };
  const goAgent = (id: string) => {
    setSearchOpen(false);
    const a = agents.data?.find((x) => x.id === id);
    const sp = spaces.data?.find((s) => s.stations.some((st) => st.id === a?.deskStationId));
    if (sp && sp.key !== spaceKey) switchSpace(sp.key);
    setSide({ t: 'agent', id });
  };
  const goMaterial = (
    stockItemId: string,
    loc?: { spaceKey: string; unitId: string; slotId: string },
  ) => {
    setSearchOpen(false);
    if (!loc) return setSide({ t: 'material', id: stockItemId });
    if (loc.spaceKey !== spaceKey) switchSpace(loc.spaceKey);
    setSide({ t: 'storage', unitId: loc.unitId, slotId: loc.slotId });
    window.setTimeout(() => {
      const sp = spaces.data?.find((s) => s.key === loc.spaceKey);
      const u = sp?.storageUnits.find((x) => x.id === loc.unitId);
      if (u) {
        const f = footprint(u);
        engine.current?.focus(f.x + f.w / 2, f.y + f.d / 2, 8);
        engine.current?.walkTo(f.x + f.w / 2, f.y + f.d + 60);
        setOverlays({ pulse: { x: f.x + f.w / 2, y: f.y + f.d / 2 }, highlights: [f] });
      }
    }, 120);
  };

  // ───────────── Falar com a Firma ─────────────
  const openBuild = (key: string) => {
    const sp = spaces.data?.find((s) => s.key === key);
    if (!sp) return false;
    if (building && draftKey === key && editor.draft) return true;
    if (
      building &&
      editor.dirty &&
      !window.confirm('Há mudanças não salvas na planta. Descartar para abrir a prévia?')
    )
      return false;
    if (key !== spaceKey) setSpaceKey(key);
    editor.load(sp);
    setDraftKey(key);
    setMode('CONSTRUCAO');
    setPreview(false);
    setSel(null);
    return true;
  };
  const objKind = (l: LayoutContent, id: string) =>
    l.stations.some((s) => s.id === id)
      ? 'station'
      : l.storageUnits.some((s) => s.id === id)
        ? 'storage'
        : 'decor';
  const goOffice = () => {
    if (!building && spaceKey !== 'ESCRITORIO') setSpaceKey('ESCRITORIO');
  };
  const handleEffect = (effect: CommandEffect) => {
    tutEvent('chat');
    switch (effect.kind) {
      case 'ABRIR_PECA':
        setSel(null);
        goPiece(effect.pieceId);
        break;
      case 'ABRIR_OS_SEM_POSICAO':
        setSel(null);
        setSide({ t: 'os', id: effect.serviceOrderId });
        break;
      case 'MATERIAL': {
        setSel(null);
        const withLoc = effect.items.find((i) => i.locations.length);
        if (withLoc) {
          const loc = withLoc.locations[0]!;
          goMaterial(withLoc.stockItemId, loc);
          // Destaca TODAS as posições do material no mesmo ambiente.
          window.setTimeout(() => {
            const sp = spaces.data?.find((s) => s.key === loc.spaceKey);
            const rects = effect.items
              .flatMap((i) => i.locations)
              .filter((l) => l.spaceKey === loc.spaceKey)
              .map((l) => sp?.storageUnits.find((u) => u.id === l.unitId))
              .filter((u): u is NonNullable<typeof u> => Boolean(u))
              .map((u) => footprint(u));
            const f = rects[0];
            setOverlays({
              highlights: rects,
              pulse: f ? { x: f.x + f.w / 2, y: f.y + f.d / 2 } : null,
            });
          }, 200);
        } else if (effect.items[0]) setSide({ t: 'material', id: effect.items[0].stockItemId });
        else if (effect.exclusive[0]) {
          const p = snapshot.data?.pieces.find(
            (x) => x.serviceOrderId === effect.exclusive[0]!.serviceOrderId,
          );
          if (p) goPiece(p.id);
          else setSide({ t: 'os', id: effect.exclusive[0].serviceOrderId });
        }
        break;
      }
      case 'MOVER_PREVIA':
      case 'PLANTA':
        if (openBuild(effect.spaceKey)) setPending(effect);
        break;
      case 'ATRIBUIR_PREVIA':
        setAssignPrev(effect);
        break;
      case 'ABRIR_CONVERSA':
        setSel(null);
        goOffice();
        setSide({ t: 'inbox', conv: effect.conversationId });
        break;
      case 'ABRIR_PAINEL':
        setSel(null);
        if (effect.panel === 'METAS') {
          goOffice();
          const f = effect.filter ?? '';
          setSide({
            t: 'goals',
            tab: f.startsWith('TAB:') ? f.slice(4) : null,
            drill: f.startsWith('MOVES:')
              ? { title: f.split('|')[1] ?? 'Lançamentos', query: f.slice(6).split('|')[0]! }
              : null,
          });
          break;
        }
        if (effect.panel === 'FINANCEIRO') {
          if (effect.serviceOrderId)
            setSide({ t: 'ficha', so: effect.serviceOrderId, focus: effect.filter ?? null });
          else {
            goOffice();
            setSide({ t: 'finance', filter: effect.filter ?? null });
          }
          break;
        }
        goOffice();
        setSide(
          effect.panel === 'CENTRAL'
            ? { t: 'central' }
            : effect.panel === 'CAMPANHAS'
              ? { t: 'ads' }
              : effect.panel === 'PUBLICACOES'
                ? { t: 'marketing' }
                : { t: 'inbox', conv: null },
        );
        break;
      default:
        break;
    }
  };
  // Prévias da planta esperam o rascunho do ambiente certo ficar pronto.
  useEffect(() => {
    if (!pending || !building || draftKey !== pending.spaceKey || !editor.draft) return;
    const p = pending;
    setPending(null);
    if (p.kind === 'PLANTA') {
      setSide({ t: 'mestre' });
      askTheMestre(p.text);
      return;
    }
    const before = JSON.parse(JSON.stringify(editor.draft)) as LayoutContent;
    editor.live((d) => {
      const o = [...d.stations, ...d.storageUnits, ...d.doc.decor].find((x) => x.id === p.objectId);
      if (o) o.rotation = p.to.rotation as typeof o.rotation;
      moveObj(d, p.objectId, p.to.xCm, p.to.yCm);
    }, false);
    setMovePrev({ ...p, before, applied: false });
    setSide(null);
    setSel({ kind: objKind(before, p.objectId) as 'station', id: p.objectId });
    const o = [...before.stations, ...before.storageUnits, ...before.doc.decor].find(
      (x) => x.id === p.objectId,
    );
    if (o) {
      const a = footprint(o);
      const b = footprint({ ...o, xCm: p.to.xCm, yCm: p.to.yCm, rotation: p.to.rotation as 0 });
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      engine.current?.fitRect({
        x: x0,
        y: y0,
        w: Math.max(a.x + a.w, b.x + b.w) - x0,
        d: Math.max(a.y + a.d, b.y + b.d) - y0,
      });
      setOverlays({
        preview: [b],
        highlights: [
          b,
          ...p.alternatives.map((alt) =>
            footprint({ ...o, xCm: alt.xCm, yCm: alt.yCm, rotation: alt.rotation as 0 }),
          ),
        ],
      });
    }
  }, [pending, building, draftKey, editor.draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveCheck = (() => {
    if (!movePrev || !editor.draft) return null;
    const o = [
      ...editor.draft.stations,
      ...editor.draft.storageUnits,
      ...editor.draft.doc.decor,
    ].find((x) => x.id === movePrev.objectId);
    if (!o) return null;
    const problems = clearanceAround(
      editor.draft,
      o.id,
      footprint(o),
      catalogOf(o.kind).frontClearCm,
      o.rotation,
    );
    return { o, problems, errors: problems.filter((x) => x.severity === 'erro') };
  })();
  const cancelMove = () => {
    if (!movePrev) return;
    if (!movePrev.applied)
      editor.live((d) => {
        const o = [...d.stations, ...d.storageUnits, ...d.doc.decor].find(
          (x) => x.id === movePrev.objectId,
        );
        if (o) o.rotation = movePrev.from.rotation as typeof o.rotation;
        moveObj(d, movePrev.objectId, movePrev.from.xCm, movePrev.from.yCm);
      }, false);
    setMovePrev(null);
    setOverlays({});
  };
  const applyMove = async () => {
    if (!movePrev || !editor.draft) return;
    const after = editor.draft;
    editor.commitFrom(movePrev.before, after);
    await save(undefined, after);
    setMovePrev({ ...movePrev, applied: true });
    setOverlays({});
  };
  const undoMove = async () => {
    if (!movePrev) return;
    editor.undo();
    await save(undefined, movePrev.before);
    setMovePrev(null);
  };
  const confirmAssign = async () => {
    if (!assignPrev) return;
    setCardBusy(true);
    try {
      if (assignPrev.mode === 'TROCAR_RESPONSAVEL') {
        await api(`/api/v1/production-tasks/${assignPrev.taskId}`, {
          method: 'PUT',
          body: {
            assigneeUserId: assignPrev.userId,
            version: assignPrev.taskVersion,
            ...(assignPrev.published ? { reason: 'Atribuído por Falar com o Gerente' } : {}),
          },
        });
        setAssignPrev({
          ...assignPrev,
          result: `Feito: ${assignPrev.etapa} com ${assignPrev.funcionario}. O início é confirmado no tablet.`,
        });
      } else {
        const r = await api<{ planned: { planId: string }[] }>('/api/v1/production/plan-services', {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            entries: [
              {
                serviceOrderId: assignPrev.serviceOrderId,
                startDate: assignPrev.data,
                pieces: assignPrev.pieces,
              },
            ],
          },
        });
        setAssignPrev({
          ...assignPrev,
          result: 'Planejado em rascunho. Publique a semana para ir à fila dos tablets.',
          planId: r.planned[0]?.planId ?? null,
        });
      }
      void qc.invalidateQueries({ queryKey: ['game-snapshot'] });
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível confirmar.');
    } finally {
      setCardBusy(false);
    }
  };
  const publishAssign = async () => {
    if (!assignPrev?.planId) return;
    setCardBusy(true);
    try {
      const plan = await api<{ version: number }>(`/api/v1/production-plans/${assignPrev.planId}`);
      await api(`/api/v1/production-plans/${assignPrev.planId}/publish`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { version: plan.version, notes: 'Publicado por Falar com o Gerente' },
      });
      setAssignPrev({
        ...assignPrev,
        planId: null,
        result: 'Semana publicada: a etapa está na fila do tablet.',
      });
      void qc.invalidateQueries({ queryKey: ['game-snapshot'] });
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível publicar.');
    } finally {
      setCardBusy(false);
    }
  };
  const chatCard = movePrev ? (
    <div
      className="rounded-xl border-2 border-bronze-500 bg-bronze-100 p-2.5"
      data-testid="move-card"
    >
      <div className="font-bold">
        {movePrev.applied ? 'Aplicado e salvo' : 'Prévia'}: {movePrev.objectName} →{' '}
        {movePrev.targetLabel}
      </div>
      {!movePrev.applied ? (
        <>
          <div className="text-ink-soft">
            Arraste o móvel para ajustar.{' '}
            {movePrev.occupied
              ? 'O lugar pedido está ocupado; mostrei o vão livre mais próximo (e outras opções tracejadas).'
              : ''}
          </div>
          {moveCheck?.problems.length ? (
            <ul className="mt-1 list-disc pl-4 text-[11px]" data-testid="move-problems">
              {moveCheck.problems.slice(0, 3).map((x, i) => (
                <li key={i} className={x.severity === 'erro' ? 'text-danger-700' : 'text-warn-600'}>
                  {x.message}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-[11px] text-ok-600">
              <Ic e="✅" /> Posição válida pelas regras do editor.
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            <GBtn
              tone="bronze"
              disabled={saving || Boolean(moveCheck?.errors.length)}
              onClick={() => void applyMove()}
              testId="move-apply"
            >
              Aplicar
            </GBtn>
            <GBtn tone="ghost" onClick={cancelMove} testId="move-cancel">
              Cancelar
            </GBtn>
          </div>
        </>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-ink-soft">
            Gravado na planta (mesmo fluxo do arrastar e salvar).
          </span>
          <GBtn tone="ghost" onClick={() => void undoMove()} testId="move-undo">
            Desfazer
          </GBtn>
          <GBtn tone="ghost" onClick={() => setMovePrev(null)}>
            Fechar
          </GBtn>
        </div>
      )}
    </div>
  ) : assignPrev ? (
    <div
      className="rounded-xl border-2 border-brand-500 bg-brand-50 p-2.5"
      data-testid="assign-card"
    >
      <div className="font-bold">
        {assignPrev.mode === 'PLANEJAR' ? 'Planejar serviço' : 'Atribuir etapa'} — confira
      </div>
      <KV k="OS" v={`${assignPrev.osCode} (${assignPrev.pieceLabel})`} />
      <KV k="Etapa" v={assignPrev.etapa} />
      <KV k="Funcionário" v={assignPrev.funcionario} />
      <KV k="Data" v={fmtDate(assignPrev.data)} />
      {assignPrev.result ? (
        <div className="mt-1 font-semibold text-ok-600">{assignPrev.result}</div>
      ) : null}
      <div className="mt-2 flex gap-1.5">
        {!assignPrev.result ? (
          <GBtn
            tone="primary"
            disabled={cardBusy || !snapshot.data?.canPlan}
            onClick={() => void confirmAssign()}
            testId="assign-confirm"
          >
            Confirmar
          </GBtn>
        ) : null}
        {assignPrev.planId ? (
          <GBtn
            tone="bronze"
            disabled={cardBusy}
            onClick={() => void publishAssign()}
            testId="assign-publish"
          >
            Publicar a semana
          </GBtn>
        ) : null}
        <GBtn tone="ghost" onClick={() => setAssignPrev(null)}>
          {assignPrev.result ? 'Fechar' : 'Cancelar'}
        </GBtn>
      </div>
    </div>
  ) : null;

  // ───────────── Render ─────────────
  const pieceSel = side?.t === 'piece' ? snapshot.data?.pieces.find((p) => p.id === side.id) : null;
  const empSel =
    side?.t === 'employee' ? snapshot.data?.employees.find((e) => e.userId === side.id) : null;
  const agentSel = side?.t === 'agent' ? agents.data?.find((a) => a.id === side.id) : null;
  const storageSel =
    side?.t === 'storage' ? layout?.storageUnits.find((u) => u.id === side.unitId) : null;
  const deskSel = side?.t === 'desk' ? layout?.stations.find((s) => s.id === side.id) : null;
  const stationSel = side?.t === 'station' ? layout?.stations.find((s) => s.id === side.id) : null;
  const allDesks = (spaces.data ?? []).flatMap((s) =>
    s.stations
      .filter((st) => st.kind === 'MESA_ESCRITORIO')
      .map((st) => ({
        id: st.id,
        name: `${s.name} · ${st.name}`,
        taken:
          agents.data?.find((a) => a.deskStationId === st.id && a.status !== 'DESATIVADO')?.id ??
          null,
      })),
  );
  const sync = snapshot.isError
    ? 'erro'
    : realtime.status !== 'online'
      ? 'offline'
      : snapshot.isFetching
        ? 'sync'
        : 'ok';
  const counts = useMemo(() => {
    const ps = snapshot.data?.pieces ?? [];
    return Object.fromEntries(
      (Object.keys(MAP_FILTERS) as MapFilter[]).map((f) => [f, ps.filter(MAP_FILTERS[f]).length]),
    ) as Record<MapFilter, number>;
  }, [snapshot.data]);

  // Espaço ocupado pela interface (para enquadrar a oficina sem nada por cima).
  const topBar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const top = (topBar.current?.getBoundingClientRect().bottom ?? 60) + 8;
    // No celular o resumo aberto ocupa a largura toda: a oficina fica abaixo dele.
    const legend = isMobile && legendOpen ? document.querySelector('[data-testid="legend"]') : null;
    e.setInsets({
      top: legend ? legend.getBoundingClientRect().bottom + 8 : top,
      left: 0,
      right: !isMobile && side ? 430 : 0,
      // No celular o painel abre de baixo (até 64% da tela): o que está em foco fica acima dele.
      bottom: isMobile ? (side ? window.innerHeight * 0.64 + 8 : 64) : 24,
    });
  }, [isMobile, side, legendOpen, space?.key, building, ready]);
  const firstOverview = useRef(false);
  useEffect(() => {
    if (ready && !firstOverview.current) {
      firstOverview.current = true;
      engine.current?.overview(false);
    }
  }, [ready]);

  const illustrativeKey = space ? `ilustrativa:${space.key}` : '';
  const showIllustrative =
    !building && Boolean(space?.illustrative) && !dismissed.split('|').includes(illustrativeKey);
  const workshopView = !building && space?.key === 'TAPECARIA';
  const panelOpen = Boolean(
    (building && (sel || side?.t === 'room' || side?.t === 'mestre')) || (!building && side),
  );
  const chatVisible = !isMobile || (chatOpenMobile && !panelOpen) || Boolean(chatCard);
  const loadingSteps = [
    { label: 'Abrindo a empresa', done: Boolean(me.data) },
    { label: 'Montando a planta', done: Boolean(spaces.data) || spaces.isError },
    {
      label: 'Trazendo a produção do Cenário',
      done: !canSeeProduction || Boolean(snapshot.data) || snapshot.isError,
    },
    { label: 'Chamando a equipe e os agentes', done: !agents.isPending },
    { label: 'Acendendo as luzes', done: ready },
  ];
  const tutorialSteps = useMemo(
    () =>
      buildSteps({
        pieceId:
          (
            snapshot.data?.pieces.find((p) => p.placement.kind === 'ESTACAO') ??
            snapshot.data?.pieces[0]
          )?.id ?? null,
        employeeName: snapshot.data?.employees[0]?.name ?? null,
        hasOffice: Boolean(spaces.data?.some((s) => s.key === 'ESCRITORIO')),
        gerenteId: agents.data?.find((a) => a.roleKey === 'GERENTE' && a.deskStationId)?.id ?? null,
        canAssign: Boolean(snapshot.data?.canPlan),
      }),
    [tutorial], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const locateForTutorial = useCallback(
    (id: string, heightM = 1.2) => engine.current?.screenOf(id, heightM) ?? null,
    [],
  );
  const closeTutorial = useCallback(() => {
    try {
      window.localStorage.setItem(TUTORIAL_KEY, 'visto');
    } catch {
      /* sem armazenamento */
    }
    setTutorial(false);
  }, []);
  const startReplay = () => {
    const r = snapshot.data ? replayRange(snapshot.data) : null;
    if (!r) return toast('danger', 'Ainda não há etapas registradas nesta semana para o replay.');
    if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
    setSide(null);
    setQuick(null);
    setReplay({ at: r.from, from: r.from, to: r.to, playing: true, speed: 4 });
    window.setTimeout(() => engine.current?.overview(), 50);
  };
  const mapBtn = 'grid size-9 place-items-center rounded-xl hover:bg-subtle';

  const settings = settingsOpen ? (
    <SettingsMenu
      quality={quality.quality}
      auto={quality.auto}
      onQuality={(q) => {
        engine.current?.setQuality(q);
        setQualityState(engine.current?.getQuality() ?? quality);
      }}
      hour={hour}
      onHour={(h) => {
        setHour(h);
        engine.current?.setHour(h);
      }}
      onShortcuts={() => {
        setSettingsOpen(false);
        setShortcutsOpen(true);
      }}
      onTutorial={() => {
        setSettingsOpen(false);
        setTutEvents(new Set());
        setTutorial(true);
      }}
      onClose={() => setSettingsOpen(false)}
      onAvatar={openAvatar}
      onMorning={
        snapshot.data
          ? () => {
              setSettingsOpen(false);
              setMorning(true);
            }
          : undefined
      }
      extra={
        <div className="mb-3 flex flex-wrap gap-1.5 border-b border-line pb-3">
          <GBtn
            tone={building ? 'bronze' : 'ghost'}
            disabled={!canBuild}
            onClick={() => {
              setSettingsOpen(false);
              if (building) leaveBuild();
              else enterBuild();
            }}
            testId="mode-construcao"
          >
            <Hammer className="size-4" /> {building ? 'Sair da Construção' : 'Construção'}
          </GBtn>
          <Link
            href="/organizacao"
            className="rounded-xl border border-line px-2.5 py-1.5 font-semibold"
          >
            Organização
          </Link>
        </div>
      }
    />
  ) : null;

  const searchBox = (
    <div className="pointer-events-auto relative min-w-0 flex-1 sm:max-w-xs">
      <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
      <input
        value={q}
        autoFocus={mobileSearch}
        onChange={(e) => {
          setQ(e.target.value);
          setSearchOpen(true);
        }}
        onFocus={() => setSearchOpen(true)}
        onBlur={() => window.setTimeout(() => setSearchOpen(false), 200)}
        placeholder="Buscar OS, cliente, material, pessoa…"
        className="w-full rounded-2xl border border-line bg-white/95 py-2 pr-3 pl-9 text-sm shadow-card"
        aria-label="Buscar no mapa"
        data-testid="game-search"
      />
      {searchOpen && results.length ? (
        <ul
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-2xl border border-line bg-white p-1 shadow-pop"
          data-testid="search-results"
        >
          {results.map((r) => (
            <li key={r.key}>
              <button
                className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-subtle"
                onClick={() => {
                  r.go();
                  setMobileSearch(false);
                }}
              >
                <span className="mt-0.5 text-bronze-600">
                  <Ic e={r.icon} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{r.label}</span>
                  <span className="block truncate text-xs text-ink-muted">{r.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const syncDot = (
    <span
      data-testid="sync-status"
      data-status={sync}
      className={clsx(
        'flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs font-semibold',
        sync === 'ok'
          ? 'text-ok-600'
          : sync === 'sync'
            ? 'text-info-600'
            : 'bg-danger-50 text-danger-700',
      )}
      title={
        snapshot.dataUpdatedAt
          ? `Última atualização: ${fmtClock(snapshot.dataUpdatedAt)}`
          : undefined
      }
    >
      <span
        className={clsx(
          'size-2 shrink-0 rounded-full',
          sync === 'ok'
            ? 'bg-ok-600'
            : sync === 'sync'
              ? 'animate-pulse bg-info-600'
              : 'animate-pulse bg-danger-600',
        )}
      />
      <span className={clsx(isMobile && sync === 'ok' && 'sr-only')}>
        {sync === 'ok'
          ? updatedAgo(snapshot.dataUpdatedAt)
          : sync === 'sync'
            ? 'Atualizando…'
            : sync === 'offline'
              ? `Sem conexão${snapshot.dataUpdatedAt ? ` (dados de ${fmtClock(snapshot.dataUpdatedAt)})` : ''}`
              : 'Falha ao atualizar'}
      </span>
    </span>
  );

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#cfe1dc] select-none">
      <div ref={host} className="absolute inset-0" data-testid="game-canvas" />
      {/* Transição entre ambientes */}
      <div
        className={clsx(
          'pointer-events-none absolute inset-0 z-30 bg-[#12302d] transition-opacity duration-300',
          fade ? 'opacity-70' : 'opacity-0',
        )}
        aria-hidden
      />

      {/* Barra superior */}
      <div
        ref={topBar}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-1.5 p-2 sm:flex-row sm:flex-wrap sm:items-start sm:gap-2 sm:p-3"
      >
        <div className="flex items-center gap-1.5 sm:contents">
          <div
            data-hud
            className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-2xl border-2 border-bronze-500/60 bg-[#fffaf2]/95 py-1 pr-3 pl-1 shadow-pop sm:py-1.5 sm:pl-1.5"
          >
            <FirmaLogo className="size-8 shrink-0 sm:size-9" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-black text-brand-800" data-testid="org-name">
                {me.data?.organization?.name ?? 'Firma Viva'}
              </div>
              <div className="text-[10px] font-semibold tracking-wide text-bronze-600 uppercase">
                Firma Viva
              </div>
            </div>
          </div>
          {isMobile ? (
            <div
              data-hud
              className="pointer-events-auto relative ml-auto flex items-center gap-0.5 rounded-2xl border border-line bg-white/95 p-1 shadow-card"
            >
              {syncDot}
              <button
                className={mapBtn}
                onClick={() => setMobileSearch((v) => !v)}
                aria-label="Buscar"
              >
                <Search className="size-4" />
              </button>
              <button
                className={mapBtn}
                onClick={() => sound().setMuted(!muted)}
                aria-label={muted ? 'Ligar som' : 'Desligar som'}
              >
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
              <button
                className={mapBtn}
                onClick={() => setSettingsOpen((v) => !v)}
                aria-label="Mais opções"
                data-testid="menu-button"
              >
                <MoreHorizontal className="size-4" />
              </button>
              {settings}
            </div>
          ) : null}
        </div>
        {isMobile && mobileSearch ? <div className="flex">{searchBox}</div> : null}
        {cenarioStatus !== 'CONECTADA' ? (
          <button
            data-hud
            className={clsx(
              'pointer-events-auto rounded-2xl border px-3 py-2 text-xs font-bold shadow-card',
              cenarioStatus === 'EXPIRADA' || cenarioStatus === 'REVOGADA'
                ? 'border-danger-600/30 bg-danger-50 text-danger-700'
                : 'border-brand-200 bg-brand-50 text-brand-800',
            )}
            onClick={() => {
              setSpaceKey('ESCRITORIO');
              setSide({ t: 'central' });
            }}
            data-testid="connect-cenario-chip"
          >
            {cenarioStatus === 'EXPIRADA' || cenarioStatus === 'REVOGADA'
              ? iconText('⚠ Reconectar Cenário Gestão')
              : iconText('🔌 Conectar Cenário Gestão')}
          </button>
        ) : null}
        {snapshot.data?.mode === 'CONSULTA' ? (
          <span
            data-hud
            className="pointer-events-auto rounded-2xl border border-info-600/20 bg-info-50 px-3 py-2 text-xs font-bold text-info-600 shadow-card"
            title="Conexão em modo consulta: o Firma Viva só lê as OS e a posição das peças no Cenário Gestão. Nada é alterado daqui."
            data-testid="consulta-chip"
          >
            <Ic e="👁️" /> Modo consulta · somente leitura
          </span>
        ) : null}
        <div className="flex items-center gap-1.5 sm:contents">
          <nav
            data-hud
            className="pointer-events-auto flex min-w-0 items-center gap-1 overflow-x-auto rounded-2xl border border-line bg-white/95 p-1 shadow-card"
            aria-label="Ambientes"
          >
            {spaces.data?.map((s) => (
              <button
                key={s.key}
                onClick={() => switchSpace(s.key)}
                data-testid={`space-${s.key}`}
                className={clsx(
                  'shrink-0 rounded-xl px-2.5 py-1.5 text-sm font-semibold whitespace-nowrap sm:px-3',
                  s.key === spaceKey ? 'bg-brand-600 text-white' : 'text-ink-soft hover:bg-subtle',
                )}
              >
                <Ic e={s.kind === 'ESCRITORIO' ? '🏢' : s.kind === 'OFICINA' ? '🪡' : '📦'} />{' '}
                {s.name}
              </button>
            ))}
            {building && canBuild ? (
              <button
                onClick={createSpace}
                className="shrink-0 rounded-xl px-2 py-1.5 text-sm font-semibold text-bronze-600 hover:bg-bronze-100"
                title="Adicionar ambiente"
              >
                + Ambiente
              </button>
            ) : null}
          </nav>
          {!building ? (
            <button
              data-hud
              className="pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-2xl border border-bronze-500/40 bg-[#fffaf2]/95 px-2.5 py-2 text-xs font-bold text-bronze-600 shadow-card sm:px-3"
              onClick={() => {
                tutEvent('missions');
                setSide(side?.t === 'missions' ? null : { t: 'missions' });
              }}
              data-testid="missions-chip"
              title="Missões do dia e nível da oficina"
            >
              <Ic e="🎯" /> <span className="max-sm:hidden">Missões ·</span> Nv {prog.level}
              {progress ? (
                <span className="rounded-full bg-bronze-500 px-1.5 text-[10px] text-white">
                  {progress.missions.filter((m) => m.done).length}/{progress.missions.length}
                </span>
              ) : null}
            </button>
          ) : null}
          {!building && canSeeProduction && snapshot.data?.mode !== 'CONSULTA' ? (
            <button
              data-hud
              className="pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-2xl border border-line bg-white/95 px-2.5 py-2 text-xs font-bold text-ink-soft shadow-card sm:px-3"
              onClick={() => setSide(side?.t === 'simulator' ? null : { t: 'simulator' })}
              data-testid="simulator-chip"
              title="Simulador: e se contratar, aceitar mais pedidos ou alguém faltar?"
            >
              <FlaskConical className="size-4" /> <span className="max-sm:hidden">E se…?</span>
            </button>
          ) : null}
        </div>
        {!isMobile ? (
          <>
            {building ? (
              <button
                data-hud
                onClick={leaveBuild}
                data-testid="mode-gestao"
                className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-bronze-500/50 bg-bronze-500 px-3 py-2 text-sm font-semibold text-white shadow-card"
              >
                <Hammer className="size-4" /> Sair da Construção
              </button>
            ) : null}
            <div data-hud className="contents">
              {searchBox}
            </div>
            <div
              data-hud
              className="pointer-events-auto relative ml-auto flex items-center gap-0.5 rounded-2xl border border-line bg-white/95 p-1 shadow-card"
            >
              {syncDot}
              <button
                className={mapBtn}
                onClick={() => setSettingsOpen((v) => !v)}
                aria-label="Mais opções"
                title="Construção, Organização, som, atalhos e luz"
                data-testid="settings-button"
              >
                <MoreHorizontal className="size-4" />
              </button>
              {settings}
            </div>
          </>
        ) : null}
      </div>

      {/* Controles do mapa (zoom, girar, centralizar) */}
      <div
        data-hud
        className={clsx(
          'pointer-events-auto absolute z-10 flex flex-col gap-0.5 rounded-2xl border border-line bg-white/95 p-1 shadow-card',
          isMobile ? 'right-2 bottom-20' : 'top-1/2 right-3 -translate-y-1/2',
          !isMobile && panelOpen && 'hidden',
          isMobile && panelOpen && 'hidden',
        )}
        data-testid="map-controls"
      >
        <button
          className={mapBtn}
          onClick={() => engine.current?.zoomBy(1 / 1.25)}
          aria-label="Aproximar"
          title="Aproximar (+)"
        >
          <Plus className="size-4" />
        </button>
        <button
          className={mapBtn}
          onClick={() => engine.current?.zoomBy(1.25)}
          aria-label="Afastar"
          title="Afastar (−)"
        >
          <Minus className="size-4" />
        </button>
        <button
          className={mapBtn}
          onClick={() => engine.current?.rotate(-1)}
          aria-label="Girar para a esquerda"
          title="Girar (Q)"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          className={mapBtn}
          onClick={() => engine.current?.rotate(1)}
          aria-label="Girar para a direita"
          title="Girar (E)"
        >
          <RotateCw className="size-4" />
        </button>
        <button
          className={mapBtn}
          onClick={() => engine.current?.overview()}
          aria-label="Centralizar"
          title="Centralizar: visão geral (C)"
          data-testid="overview"
        >
          <MapIcon className="size-4" />
        </button>
      </div>

      {/* Resumo da oficina (recolhível) */}
      {workshopView && !replay ? (
        legendOpen && !(isMobile && panelOpen) ? (
          <div
            data-hud
            className={clsx(
              'animate-pop-in pointer-events-auto absolute z-10 flex flex-col gap-1.5 rounded-2xl border border-line bg-white/95 p-2 text-xs shadow-card',
              isMobile ? 'inset-x-2' : 'left-3 w-[19rem]',
            )}
            style={{ top: (topBar.current?.getBoundingClientRect().bottom ?? 64) + 6 }}
            data-testid="legend"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink">Resumo da oficina</span>
              <button
                className="rounded-lg p-1 text-ink-muted hover:bg-subtle"
                onClick={() => setLegendOpen(false)}
                aria-label="Recolher resumo"
                data-testid="legend-collapse"
              >
                <ChevronUp className="size-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1" data-testid="quick-filters">
              {(Object.keys(MAP_FILTERS) as MapFilter[]).map((f) => (
                <button
                  key={f}
                  data-testid={`quick-${f}`}
                  onClick={() => {
                    const on = quick === f ? null : f;
                    setQuick(on);
                    setSide(on ? { t: 'quick', f: on as MapFilter } : null);
                    sound().play('click');
                  }}
                  className={clsx(
                    'rounded-full border px-2 py-0.5 font-semibold',
                    quick === f
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : f === 'ATRASADAS' && counts[f]
                        ? 'border-danger-600/30 bg-danger-50 text-danger-700'
                        : 'border-line bg-white',
                  )}
                >
                  {iconText(MAP_FILTER_LABEL[f])} · {counts[f]}
                </button>
              ))}
            </div>
            {canFinView && goal ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 border-t border-line pt-1.5 text-left"
                onClick={() => setSide({ t: 'goals', tab: null, drill: null })}
                data-testid="goals-compact"
                title="Quadro de Metas (barra = saldo ÷ meta)"
              >
                <Ic e="🎯" className="size-4 text-bronze-600" />
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-subtle">
                  <span
                    className={`block h-full ${goal.belowAfterAchieved ? 'bg-danger-600' : 'bg-ok-600'}`}
                    style={{ width: `${Math.min(100, Math.max(0, goal.pctOfGoal))}%` }}
                  />
                </span>
                <span className="font-semibold">
                  {brlCents(goal.balanceCents)} de {brlCents(goal.targetCents)}
                </span>
              </button>
            ) : null}
            {!canSeeProduction ? (
              <span className="text-danger-700">
                {cenarioStatus === 'CONECTADA'
                  ? 'Sem permissão de ver a produção.'
                  : 'Conecte o Cenário Gestão para ver as OS e a produção da empresa.'}
              </span>
            ) : null}
          </div>
        ) : !(isMobile && panelOpen) ? (
          <button
            data-hud
            className="pointer-events-auto absolute left-2 z-10 flex items-center gap-1.5 rounded-full border border-line bg-white/95 px-3 py-1.5 text-xs font-bold shadow-card sm:left-3"
            style={{ top: (topBar.current?.getBoundingClientRect().bottom ?? 64) + 6 }}
            onClick={() => setLegendOpen(true)}
            data-testid="legend-expand"
          >
            <Ic e="📋" /> Resumo · <Ic e="▶" /> {counts.EM_EXECUCAO} · <Ic e="⏸" />{' '}
            {counts.PARADOS}
            {counts.ATRASADAS ? (
              <span className="text-danger-700">
                · <Ic e="⚠" /> {counts.ATRASADAS}
              </span>
            ) : null}
            <ChevronDown className="size-3.5" />
          </button>
        ) : null
      ) : null}

      {/* Aviso da planta ilustrativa: some depois de lido */}
      {showIllustrative && !replay ? (
        <div
          data-hud
          className="animate-pop-in pointer-events-auto absolute left-1/2 z-10 flex w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-2xl border border-warn-600/30 bg-warn-50/97 py-1.5 pr-1.5 pl-3 text-xs text-warn-600 shadow-card"
          style={{ bottom: isMobile ? 76 : 16 }}
          data-testid="illustrative-notice"
        >
          <span>
            <Ic e="📐" /> Planta com medidas ilustrativas.
          </span>
          {canBuild && !isMobile ? (
            <button className="font-bold underline" onClick={enterBuild}>
              Ajustar no modo Construção
            </button>
          ) : null}
          <button
            className="rounded-lg p-1 hover:bg-warn-600/10"
            aria-label="Entendi"
            onClick={() => setDismissed([dismissed, illustrativeKey].filter(Boolean).join('|'))}
            data-testid="illustrative-dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {!building && space?.kind === 'ESCRITORIO' && !(isMobile && panelOpen) ? (
        <div
          data-hud
          className="pointer-events-auto absolute left-2 z-10 flex flex-wrap items-start gap-1.5 max-sm:right-2 sm:left-3 sm:flex-col"
          style={{ top: (topBar.current?.getBoundingClientRect().bottom ?? 64) + 6 }}
        >
          <button
            className="flex items-center gap-2 rounded-2xl border border-line bg-white/95 px-3 py-2 text-xs font-semibold shadow-card"
            onClick={() => setSide({ t: 'central' })}
            data-testid="central-chip"
          >
            <Ic e="🔌" /> Central de Conexões
            {integrations.data
              ? ` · ${integrations.data.filter((i) => i.status !== 'PRECISA_CONFIGURAR').length} ativa(s)`
              : ''}
          </button>
          {can('financeiro.ver') ? (
            <button
              className="flex items-center gap-2 rounded-2xl border border-line bg-white/95 px-3 py-2 text-xs font-semibold shadow-card"
              onClick={() => setSide({ t: 'finance', filter: null })}
              data-testid="finance-chip"
            >
              <Ic e="💼" /> Financeiro
            </button>
          ) : null}
          {canFinView ? (
            <button
              className="flex items-center gap-2 rounded-2xl border border-line bg-white/95 px-3 py-2 text-xs font-semibold shadow-card"
              onClick={() => setSide({ t: 'goals', tab: null, drill: null })}
              data-testid="goals-chip"
            >
              <Ic e="🎯" /> Quadro de Metas
              {goal
                ? ` · ${goal.pctOfGoal.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`
                : ''}
            </button>
          ) : null}
          {canSeeInbox ? (
            <button
              className="flex items-center gap-2 rounded-2xl border border-line bg-white/95 px-3 py-2 text-xs font-semibold shadow-card"
              onClick={() => setSide({ t: 'inbox', conv: null })}
              data-testid="inbox-chip"
            >
              <Ic e="📥" /> Caixa de entrada
              {unread ? (
                <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">
                  {unread}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Construção: paleta + barra de ferramentas */}
      {building ? (
        <>
          {!preview ? (
            <div className="pointer-events-none absolute top-20 left-3 flex max-h-[calc(100vh-34rem)] min-h-40 w-64 flex-col max-sm:hidden">
              <Palette onAdd={addFromPalette} kind={layout?.kind ?? 'OFICINA'} />
            </div>
          ) : null}
          <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex justify-center lg:right-[440px] lg:left-[470px]">
            <div
              className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border-2 border-bronze-500/60 bg-[#fffaf2]/97 p-1.5 shadow-pop"
              data-testid="build-toolbar"
            >
              <GBtn
                tone="ghost"
                onClick={editor.undo}
                disabled={!editor.canUndo || preview}
                title="Desfazer (Ctrl+Z)"
              >
                <Undo2 className="size-4" />
              </GBtn>
              <GBtn
                tone="ghost"
                onClick={editor.redo}
                disabled={!editor.canRedo || preview}
                title="Refazer (Ctrl+Y)"
              >
                <Redo2 className="size-4" />
              </GBtn>
              <GBtn tone="ghost" onClick={() => setSide({ t: 'room' })} disabled={preview}>
                <Ic e="🏠" /> Ambiente
              </GBtn>
              <GBtn
                tone="ghost"
                onClick={() => {
                  setSide({ t: 'mestre' });
                  askTheMestre('Verifique as passagens da planta.');
                }}
                disabled={preview}
              >
                <Ic e="✔" /> Verificar passagens
              </GBtn>
              <GBtn
                tone={preview ? 'primary' : 'ghost'}
                onClick={() => {
                  setPreview((v) => !v);
                  setSel(null);
                }}
                testId="preview-toggle"
              >
                <Eye className="size-4" /> {preview ? 'Voltar a editar' : 'Pré-visualizar'}
              </GBtn>
              <GBtn tone="bronze" onClick={() => setSide({ t: 'mestre' })}>
                <Ic e="🦺" /> Mestre de Obras
              </GBtn>
              <GBtn
                tone="primary"
                onClick={() => void save()}
                disabled={!editor.dirty || saving}
                testId="save-layout"
              >
                <Save className="size-4" />{' '}
                {saving ? 'Salvando…' : editor.dirty ? 'Salvar planta' : 'Salvo'}
              </GBtn>
            </div>
          </div>
          {tip && sel ? (
            <div
              className="pointer-events-auto absolute bottom-24 left-1/2 max-w-md -translate-x-1/2 rounded-2xl border border-[#e76f1a]/50 bg-[#fff3e6] px-3 py-2 text-xs shadow-pop"
              data-testid="drag-tip"
            >
              <Ic e="🦺" /> <b>Mestre de Obras:</b> {tip}{' '}
              <button
                className="underline"
                onClick={() => {
                  setSide({ t: 'mestre' });
                  askTheMestre('Verifique as passagens da planta.');
                }}
              >
                Ver opções
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Falar com a Firma (no celular, vira um botão) */}
      {!replay ? (
        chatVisible ? (
          <div
            data-hud
            className={clsx(
              'pointer-events-none absolute z-20',
              isMobile ? 'inset-x-2 bottom-2' : 'bottom-3 left-3',
            )}
          >
            {isMobile ? (
              <div className="pointer-events-auto mb-1 flex justify-end">
                <button
                  className="rounded-full bg-white/95 p-1.5 shadow-card"
                  onClick={() => setChatOpenMobile(false)}
                  aria-label="Fechar conversa"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : null}
            <CenariaChat spaceKey={spaceKey} onEffect={(e) => handleEffect(e)} card={chatCard} />
          </div>
        ) : !panelOpen ? (
          <button
            data-hud
            className="pointer-events-auto absolute bottom-3 left-2 z-20 flex items-center gap-2 rounded-full border-2 border-brand-600/50 bg-brand-700 px-4 py-2.5 text-sm font-bold text-[#f5ebdf] shadow-pop"
            onClick={() => setChatOpenMobile(true)}
            data-testid="chat-open"
          >
            <MessageCircle className="size-4" /> Falar com o Gerente
          </button>
        ) : null
      ) : null}

      {replay ? (
        <ReplayBar
          at={replay.at}
          from={replay.from}
          to={replay.to}
          playing={replay.playing}
          speed={replay.speed}
          onSeek={(t) => setReplay((r) => (r ? { ...r, at: t } : r))}
          onPlay={(p) =>
            setReplay((r) => (r ? { ...r, playing: p, at: p && r.at >= r.to ? r.from : r.at } : r))
          }
          onSpeed={(sp) => setReplay((r) => (r ? { ...r, speed: sp } : r))}
          onClose={() => setReplay(null)}
        />
      ) : null}

      <aside
        data-hud={panelOpen ? '' : undefined}
        className={clsx(
          'pointer-events-none absolute z-20 flex flex-col',
          isMobile
            ? 'inset-x-2 bottom-2 max-h-[64dvh]'
            : 'top-20 right-3 bottom-3 w-[min(420px,calc(100vw-1.5rem))]',
        )}
      >
        {building && sel && editor.draft && !preview ? (
          <Properties
            draft={editor.draft}
            sel={sel}
            people={people.data ?? []}
            apply={editor.apply}
            onRotate={doRotate}
            onDuplicate={doDuplicate}
            onRemove={doRemove}
            onClose={() => setSel(null)}
          />
        ) : building && side?.t === 'room' && editor.draft ? (
          <RoomSettings
            draft={editor.draft}
            spaceKey={spaceKey}
            apply={editor.apply}
            spaces={(spaces.data ?? []).map((s) => ({ key: s.key, name: s.name }))}
            onReset={reset}
            onClose={() => setSide(null)}
          />
        ) : building && side?.t === 'mestre' ? (
          <MestrePanel
            history={mestre.history}
            pending={mestre.pending}
            onAsk={askTheMestre}
            onApply={applyMestre}
            onDiscard={() => {
              setOverlays({});
              setMestre((m) => ({ ...m, pending: null }));
            }}
            onClose={() => setSide(null)}
          />
        ) : pieceSel && snapshot.data ? (
          <PiecePanel
            key={pieceSel.id}
            piece={pieceSel}
            snapshot={snapshot.data}
            people={people.data ?? []}
            onClose={() => {
              setSide(null);
              setHighlight(null);
            }}
            onLocateMaterial={(d) => {
              setQ(d.split(' ')[0] ?? d);
              setSearchOpen(true);
            }}
            onFocusEmployee={goEmployee}
            onOpenFicha={
              canOffice
                ? () => setSide({ t: 'ficha', so: pieceSel.serviceOrderId, focus: null })
                : undefined
            }
          />
        ) : empSel && layout && snapshot.data ? (
          <EmployeePanel
            e={empSel}
            layout={spaces.data?.find((s) => s.key === 'TAPECARIA') ?? layout}
            snapshot={snapshot.data}
            onClose={() => setSide(null)}
            onOpenPiece={goPiece}
          />
        ) : agentSel ? (
          <AgentPanel
            key={agentSel.id}
            agent={agentSel}
            canManage={canManageAgents}
            onClose={() => setSide(null)}
            onConfigure={() =>
              setSide({ t: 'agentConfig', agentId: agentSel.id, deskId: agentSel.deskStationId })
            }
            onOpenConversation={(id) => setSide({ t: 'inbox', conv: id })}
            onOpenCash={(query) =>
              setSide({
                t: 'goals',
                tab: null,
                drill: { title: 'Lançamentos citados pelo Gerente', query },
              })
            }
            onOpenPanel={(p) =>
              setSide(
                p === 'inbox'
                  ? { t: 'inbox', conv: null }
                  : p === 'ads'
                    ? { t: 'ads' }
                    : p === 'marketing'
                      ? { t: 'marketing' }
                      : { t: 'central' },
              )
            }
          />
        ) : side?.t === 'agentConfig' ? (
          <AgentConfigPanel
            key={side.agentId ?? `new${side.deskId}`}
            agent={agents.data?.find((a) => a.id === side.agentId) ?? null}
            deskId={side.deskId}
            desks={allDesks}
            onClose={() => setSide(null)}
            onSaved={(a) => setSide({ t: 'agent', id: a.id })}
          />
        ) : deskSel ? (
          <Panel
            title={deskSel.name}
            subtitle="Mesa vazia"
            icon="🪑"
            onClose={() => setSide(null)}
            testId="desk-panel"
          >
            <p className="mb-2 text-xs text-ink-soft">
              Uma mesa pode ficar vazia. Coloque um agente para trabalhar aqui ou mude um agente
              existente de mesa.
            </p>
            {canManageAgents ? (
              <>
                <GBtn
                  tone="primary"
                  className="w-full"
                  onClick={() => setSide({ t: 'agentConfig', agentId: null, deskId: deskSel.id })}
                  testId="desk-new-agent"
                >
                  Colocar agente nesta mesa
                </GBtn>
                <div className="mt-3 text-xs font-semibold">Mudar agente para cá</div>
                {(agents.data ?? [])
                  .filter((a) => a.status !== 'DESATIVADO')
                  .map((a) => (
                    <button
                      key={a.id}
                      className="mt-1 block w-full rounded-lg border border-line bg-white px-2 py-1 text-left text-xs"
                      onClick={async () => {
                        try {
                          await api(`/api/v1/game/agents/${a.id}`, {
                            method: 'PUT',
                            body: { deskStationId: deskSel.id, version: a.version },
                          });
                          await qc.invalidateQueries({ queryKey: ['game-agents'] });
                          toast('ok', `${a.name} mudou de mesa.`);
                        } catch (e) {
                          toast('danger', e instanceof ApiError ? e.message : 'Falhou.');
                        }
                      }}
                    >
                      {a.name} ({a.roleLabel})
                    </button>
                  ))}
              </>
            ) : (
              <p className="text-xs text-ink-muted">Configurar agentes exige agentes.gerenciar.</p>
            )}
          </Panel>
        ) : stationSel && layout ? (
          <Panel
            title={stationSel.name}
            subtitle={catalogOf(stationSel.kind).label}
            icon="🛠️"
            onClose={() => setSide(null)}
            testId="station-panel"
          >
            <div className="text-xs">
              <div className="mb-1 font-semibold">Funcionários vinculados</div>
              {stationSel.assigneeUserIds.length ? (
                stationSel.assigneeUserIds.map((u) => (
                  <div key={u}>{people.data?.find((p) => p.userId === u)?.name ?? '—'}</div>
                ))
              ) : (
                <div className="text-ink-muted">
                  Nenhum{stationSel.shared ? ' (compartilhada)' : ''}.
                </div>
              )}
              <div className="mt-2 mb-1 font-semibold">No momento</div>
              {(snapshot.data?.pieces ?? [])
                .filter((p) => p.placement.stationId === stationSel.id)
                .map((p) => (
                  <button key={p.id} className="block underline" onClick={() => goPiece(p.id)}>
                    {p.itemCode} · {p.placement.label}
                  </button>
                ))}
            </div>
          </Panel>
        ) : storageSel ? (
          <StoragePanel
            unit={storageSel}
            slotId={side?.t === 'storage' ? side.slotId : null}
            onSelectSlot={(id) => setSide({ t: 'storage', unitId: storageSel.id, slotId: id })}
            canMove={can('estoque.gerenciar')}
            onClose={() => setSide(null)}
            onOpenOs={(soId) => {
              const p = snapshot.data?.pieces.find((x) => x.serviceOrderId === soId);
              if (p) goPiece(p.id);
              else window.open(cenarioUrl(`/painel/os/${soId}`), '_blank');
            }}
          />
        ) : side?.t === 'os' ? (
          <OsPanel
            id={side.id}
            onClose={() => setSide(null)}
            onOpenFicha={
              canOffice ? () => setSide({ t: 'ficha', so: side.id, focus: null }) : undefined
            }
          />
        ) : side?.t === 'goals' ? (
          <GoalsPanel
            key={`${side.tab ?? ''}${side.drill?.query ?? ''}`}
            initialTab={side.tab}
            initialDrill={side.drill}
            canManage={can('financeiro.gerenciar')}
            onClose={() => setSide(null)}
            onAnimateWeek={(w, g) => {
              if (!g) return;
              engine.current?.setGoalBoard({
                from: w.openingCents / g.targetCents,
                fraction: w.closingCents / g.targetCents,
                text: `Semana ${w.weekStart.slice(8, 10)}/${w.weekStart.slice(5, 7)}: ${signedBrl(w.deltaCents)} (${signedPct(w.pct)})`,
                tone: w.deltaCents >= 0 ? '#1f7a46' : '#b42323',
              });
              if (spaceKey !== 'ESCRITORIO') switchSpace('ESCRITORIO');
            }}
          />
        ) : side?.t === 'quick' ? (
          <Panel
            title={MAP_FILTER_LABEL[side.f]}
            subtitle="O que pede decisão agora — toque para abrir a ficha"
            icon="🔎"
            onClose={() => {
              setSide(null);
              setQuick(null);
            }}
            testId="quick-panel"
          >
            <ul className="space-y-1.5 text-xs">
              {(snapshot.data?.pieces ?? []).filter(MAP_FILTERS[side.f]).map((p) => {
                const w = pieceWorkflow(p);
                return (
                  <li key={p.id}>
                    <button
                      className="w-full rounded-xl border border-line bg-white p-2 text-left hover:border-brand-600/50"
                      onClick={() => goPiece(p.id)}
                      data-testid="quick-row"
                    >
                      <div className="flex justify-between gap-2">
                        <b>
                          {p.itemCode} · {p.description}
                        </b>
                        <Ic e={w.icon} />
                      </div>
                      <div className="text-ink-soft">
                        {p.customerName ?? ''} · {w.phaseLabel}
                        {w.current ? ` · ${w.current.label} com ${w.current.assignee}` : ''}
                      </div>
                      {w.blockedReason || (w.next && !w.next.available && w.next.reason) ? (
                        <div className="text-danger-700">
                          <Ic e="⛔" /> {w.blockedReason ?? w.next?.reason}
                        </div>
                      ) : w.next ? (
                        <div className="text-ok-600">
                          Próxima: {w.next.label} · {w.next.assignee ?? 'sem responsável'}
                        </div>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {!(snapshot.data?.pieces ?? []).some(MAP_FILTERS[side.f]) ? (
                <li className="text-ink-muted">Nenhuma peça neste filtro.</li>
              ) : null}
            </ul>
          </Panel>
        ) : side?.t === 'missions' && progress ? (
          <MissionsPanel
            missions={progress.missions}
            progress={progress.progress}
            week={progress.week}
            onClose={() => setSide(null)}
            onReplay={startReplay}
            canReplay={Boolean(snapshot.data && replayRange(snapshot.data))}
            onShare={() =>
              setShare({
                kicker: 'Semana da oficina',
                title: `Nível ${progress.progress.level}: ${progress.progress.levelName}`,
                big: `${progress.week.total} ${progress.week.total === 1 ? 'etapa' : 'etapas'}`,
                lines: [
                  'concluídas pela equipe nesta semana.',
                  `${progress.missions.filter((m) => m.done).length} de ${progress.missions.length} missões do dia cumpridas.`,
                ],
                company: companyName,
                file: 'semana-da-oficina',
              })
            }
          />
        ) : side?.t === 'avatar' ? (
          <AvatarPanel
            look={shownLook ?? DEFAULT_LOOK}
            onChange={setLookDraft}
            onSave={() => void saveLook()}
            onReset={() => setLookDraft(DEFAULT_LOOK)}
            saving={lookSaving}
            dirty={Boolean(lookDraft) && JSON.stringify(lookDraft) !== JSON.stringify(savedLook)}
            onClose={() => {
              setLookDraft(null);
              setSide(null);
            }}
          />
        ) : side?.t === 'logistics' ? (
          <LogisticsPanel
            data={logistics.data}
            loading={logistics.isLoading}
            onClose={() => setSide(null)}
          />
        ) : side?.t === 'simulator' ? (
          <SimulatorPanel
            snap={snapshot.data}
            store={storeRef.current}
            onClose={() => setSide(null)}
            onPiece={(id) => {
              setSide({ t: 'piece', id });
              setHighlight(id);
            }}
          />
        ) : side?.t === 'ficha' ? (
          <FichaPanel
            key={`${side.so}${side.focus ?? ''}`}
            soId={side.so}
            focus={side.focus}
            onClose={() => setSide(null)}
            canFin={can('financeiro.gerenciar')}
            canDocs={can('pedidos.gerenciar')}
            canBuy={can('compras.gerenciar')}
          />
        ) : side?.t === 'finance' ? (
          <FinancePanel
            key={side.filter ?? ''}
            filter={side.filter}
            onClose={() => setSide(null)}
            onOpenFicha={(so) => setSide({ t: 'ficha', so, focus: null })}
          />
        ) : side?.t === 'central' ? (
          <ConnectionsPanel
            canManage={can('conexoes.gerenciar')}
            onClose={() => setSide(null)}
            onOpenInbox={() => setSide({ t: 'inbox', conv: null })}
            onOpenAds={() => setSide({ t: 'ads' })}
            onOpenMarketing={() => setSide({ t: 'marketing' })}
          />
        ) : side?.t === 'inbox' ? (
          <InboxPanel
            convId={side.conv}
            onSelect={(id) => setSide({ t: 'inbox', conv: id })}
            onClose={() => setSide(null)}
            canReply={can('atendimento.responder')}
          />
        ) : side?.t === 'ads' ? (
          <AdsPanel
            onClose={() => setSide(null)}
            onOpenAgent={() => {
              const a = agents.data?.find((x) => x.roleKey === 'TRAFEGO');
              if (a) setSide({ t: 'agent', id: a.id });
            }}
          />
        ) : side?.t === 'marketing' ? (
          <MarketingPanel onClose={() => setSide(null)} canPublish={can('marketing.publicar')} />
        ) : side?.t === 'integrations' ? (
          <Panel
            title="Integrações dos agentes"
            subtitle="O que já funciona e o que falta configurar"
            icon="🔌"
            onClose={() => setSide(null)}
            testId="integrations-panel"
          >
            <ul className="space-y-2">
              {integrations.data?.map((i) => (
                <li key={i.key} className="rounded-xl border border-line bg-white p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <b>{i.label}</b>
                    <Tone
                      tone={
                        i.status === 'CONECTADA'
                          ? 'ok'
                          : i.status === 'MODO_TESTE'
                            ? 'info'
                            : 'atencao'
                      }
                    >
                      {i.status === 'CONECTADA'
                        ? 'Conectada'
                        : i.status === 'MODO_TESTE'
                          ? 'Modo de teste'
                          : 'Precisa configurar'}
                    </Tone>
                  </div>
                  <div className="mt-1 text-ink-soft">{i.detail}</div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-muted">
              Mensagens, publicações, compras, pagamentos e notas só acontecem depois da sua
              aprovação. Sem integração configurada, a aprovação fica registrada como execução de
              teste.
            </p>
          </Panel>
        ) : side?.t === 'material' ? (
          <MaterialPanel
            id={side.id}
            canMove={can('estoque.gerenciar')}
            onClose={() => setSide(null)}
            onOpenOs={(soId) => {
              const p = snapshot.data?.pieces.find((x) => x.serviceOrderId === soId);
              if (p) goPiece(p.id);
            }}
          />
        ) : null}
      </aside>

      {impacts ? (
        <ImpactDialog
          impacts={impacts}
          onCancel={() => setImpacts(null)}
          onConfirm={(t) => void save(t)}
        />
      ) : null}
      <LoadingScreen steps={loadingSteps} hidden={ready || spaces.isError} />
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {morning && !tutorial && !replay ? (
        <GoodMorning
          name={me.data?.user.name ?? ''}
          items={morningItems(snapshot.data, logistics.data, {
            late: () => {
              if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
              setQuick('ATRASADAS');
              setSide({ t: 'quick', f: 'ATRASADAS' });
            },
            trips: () => {
              if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
              setSide({ t: 'logistics' });
            },
            people: () => {
              if (spaceKey !== 'TAPECARIA') switchSpace('TAPECARIA');
              setQuick(null);
            },
          })}
          onClose={closeMorning}
        />
      ) : null}
      {share ? <ShareDialog card={share} onClose={() => setShare(null)} /> : null}
      {goalShare ? (
        <GoalShare goal={goalShare} company={companyName} onClose={() => setGoalShare(null)} />
      ) : null}
      {tutorial && ready && !replay ? (
        <Tutorial
          steps={tutorialSteps}
          events={tutEvents}
          locate={locateForTutorial}
          onClose={closeTutorial}
        />
      ) : null}
      {spaces.isError ? (
        <div className="absolute inset-0 grid place-items-center">
          <Panel title="Não foi possível abrir o jogo">{spaces.error.message}</Panel>
        </div>
      ) : null}
    </div>
  );
}

/** Ficha resumida de uma OS sem posição no mapa (rotas oficiais). */
function OsPanel({
  id,
  onClose,
  onOpenFicha,
}: {
  id: string;
  onClose: () => void;
  onOpenFicha?: () => void;
}) {
  const so = useServiceOrder(id);
  const d = so.data;
  return (
    <Panel
      title={d ? `${d.code} · ${d.customer.name}` : 'Ordem de serviço'}
      subtitle="Sem posição no mapa"
      icon="📄"
      onClose={onClose}
      testId="os-panel"
    >
      {d ? (
        <>
          <p className="mb-2 rounded-lg bg-warn-50 p-2 text-xs text-warn-600">
            Esta OS não tem peça na oficina agora (cancelada, entregue ou sem peças em produção).
          </p>
          <KV k="Situação" v={d.status} />
          <KV k="Prazo" v={fmtDate(d.promisedDate)} />
          <KV k="Prioridade" v={d.priority} />
          <ul className="mt-2 space-y-1 text-xs">
            {d.items.map((i) => (
              <li key={i.id} className="rounded-lg border border-line bg-white px-2 py-1">
                <b>{i.code}</b> · {i.description}
              </li>
            ))}
          </ul>
          <a
            href={cenarioUrl(`/painel/os/${d.id}`)}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-xs font-semibold underline"
          >
            Abrir no painel
          </a>
          {onOpenFicha ? (
            <GBtn tone="bronze" className="mt-2 w-full" onClick={onOpenFicha}>
              <Ic e="💼" /> Ficha comercial (contrato, entrada, saldo, nota)
            </GBtn>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-ink-muted">{so.isError ? so.error.message : 'Carregando…'}</p>
      )}
    </Panel>
  );
}
