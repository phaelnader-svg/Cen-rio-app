/**
 * Missões do dia, nível da oficina e placar da semana, calculados SÓ a partir do trabalho real
 * (etapas concluídas no tablet, peças prontas, atrasos). Nada aqui altera o Cenário Gestão: o
 * histórico do progresso fica guardado neste navegador, por empresa.
 */
import type { GamePieceDto, GameSnapshotDto } from '@cenario/shared';
import { pieceWorkflow } from '@cenario/shared';
import { isLate } from './placement';

export interface Mission {
  id: string;
  icon: string;
  title: string;
  detail: string;
  current: number;
  goal: number;
  done: boolean;
  xp: number;
}

export interface Progress {
  xp: number;
  level: number;
  levelName: string;
  /** XP no nível atual e o que falta para o próximo. */
  into: number;
  span: number;
  rewards: string[];
  nextReward: { level: number; label: string } | null;
}

interface Store {
  /** Etapas concluídas já contadas: id → [usuário, dia]. */
  tasks: Record<string, [string | null, string]>;
  /** Missões do dia já pagas (dia:missão). */
  paid: string[];
  /** Peças que ficaram prontas no prazo (já contadas). */
  onTime: string[];
  xp: number;
}

const LEVELS = [
  { xp: 0, name: 'Oficina iniciante' },
  { xp: 150, name: 'Oficina organizada' },
  { xp: 400, name: 'Oficina pontual' },
  { xp: 800, name: 'Oficina de confiança' },
  { xp: 1400, name: 'Oficina referência' },
  { xp: 2200, name: 'Oficina mestre' },
  { xp: 3300, name: 'Oficina lendária' },
];

/** Decoração que cada nível libera na oficina. */
export const REWARDS: { level: number; id: string; label: string }[] = [
  { level: 2, id: 'plantas', label: 'Mais plantas na oficina' },
  { level: 3, id: 'trofeu-1', label: 'Primeiro troféu na parede' },
  { level: 4, id: 'tapete', label: 'Tapete novo' },
  { level: 5, id: 'trofeu-2', label: 'Segundo troféu' },
  { level: 6, id: 'trofeu-3', label: 'Troféu de ouro' },
  { level: 7, id: 'trofeu-4', label: 'Galeria completa' },
];

const today = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

function weekStart(d = new Date()) {
  const s = new Date(`${today(d)}T12:00:00`);
  const dow = (s.getDay() + 6) % 7;
  s.setDate(s.getDate() - dow);
  return s.toISOString().slice(0, 10);
}

function load(orgId: string): Store {
  try {
    const raw = window.localStorage.getItem(`firma-progresso:${orgId}`);
    if (raw)
      return { tasks: {}, paid: [], onTime: [], xp: 0, ...(JSON.parse(raw) as Partial<Store>) };
  } catch {
    /* sem armazenamento */
  }
  return { tasks: {}, paid: [], onTime: [], xp: 0 };
}

function save(orgId: string, s: Store) {
  try {
    // Guarda só as últimas 8 semanas.
    const cut = new Date(Date.now() - 56 * 864e5).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries(s.tasks)) if (v[1] < cut) delete s.tasks[k];
    s.paid = s.paid.filter((p) => p.slice(0, 10) >= cut);
    s.onTime = s.onTime.slice(-500);
    window.localStorage.setItem(`firma-progresso:${orgId}`, JSON.stringify(s));
  } catch {
    /* sem armazenamento */
  }
}

const READY = ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE'];

/** Missões de hoje a partir do retrato atual da oficina. */
export function missionsOf(snap: GameSnapshotDto, store?: Store): Mission[] {
  const d = today();
  const tasks = snap.pieces.flatMap((p) => p.tasks);
  const doneToday = new Set(
    tasks
      .filter(
        (t) => t.status === 'CONCLUIDA' && t.completedAt && today(new Date(t.completedAt)) === d,
      )
      .map((t) => t.id),
  );
  for (const [id, [, day]] of Object.entries(store?.tasks ?? {})) if (day === d) doneToday.add(id);
  const people = snap.employees.filter((e) => e.currentTask || e.queue.length).length;
  const stepsGoal = Math.max(3, Math.min(12, people * 2));
  const late = snap.pieces.filter((p) => isLate(p)).length;
  const paused = snap.employees.filter((e) => e.currentTask?.status === 'PAUSADA').length;
  const readyToday = snap.pieces.filter(
    (p) =>
      READY.includes(p.stage) &&
      p.tasks.some((t) => t.completedAt && today(new Date(t.completedAt)) === d),
  ).length;
  const waiting = snap.pieces.filter(
    (p) => pieceWorkflow(p).phase === 'AGUARDANDO_PLANEJAMENTO',
  ).length;
  const list: Mission[] = [
    {
      id: 'etapas',
      icon: '🛠️',
      title: `Concluir ${stepsGoal} etapas hoje`,
      detail: 'Cada etapa finalizada no tablet conta.',
      current: Math.min(stepsGoal, doneToday.size),
      goal: stepsGoal,
      done: doneToday.size >= stepsGoal,
      xp: 60,
    },
    {
      id: 'atrasos',
      icon: '⏰',
      title: 'Zerar os atrasos',
      detail: late ? `${late} peça(s) com o prazo vencido.` : 'Nenhuma peça com prazo vencido.',
      current: late ? 0 : 1,
      goal: 1,
      done: late === 0,
      xp: 50,
    },
    {
      id: 'parados',
      icon: '▶️',
      title: 'Ninguém parado',
      detail: paused ? `${paused} etapa(s) pausada(s) agora.` : 'Todas as etapas em andamento.',
      current: paused ? 0 : 1,
      goal: 1,
      done: paused === 0 && snap.employees.length > 0,
      xp: 30,
    },
    {
      id: 'prontas',
      icon: '🚚',
      title: 'Aprontar 2 peças para entrega',
      detail: 'Peças que chegaram à expedição hoje.',
      current: Math.min(2, readyToday),
      goal: 2,
      done: readyToday >= 2,
      xp: 60,
    },
  ];
  if (waiting)
    list.push({
      id: 'planejar',
      icon: '🗓️',
      title: 'Planejar as peças que chegaram',
      detail: `${waiting} peça(s) aguardando planejamento.`,
      current: 0,
      goal: 1,
      done: false,
      xp: 40,
    });
  return list;
}

function levelOf(xp: number) {
  let i = 0;
  while (i < LEVELS.length - 1 && xp >= LEVELS[i + 1]!.xp) i++;
  return i;
}

/**
 * Soma o XP do que aconteceu desde a última visita (etapas concluídas, peças prontas no prazo,
 * missões cumpridas) e devolve o progresso, as missões e o que é novidade (para comemorar).
 */
export function updateProgress(orgId: string, snap: GameSnapshotDto) {
  const s = load(orgId);
  const before = s.xp;
  const beforeLevel = levelOf(before);
  let steps = 0;
  for (const p of snap.pieces)
    for (const t of p.tasks)
      if (t.status === 'CONCLUIDA' && t.completedAt && !s.tasks[t.id]) {
        s.tasks[t.id] = [t.assigneeUserId, today(new Date(t.completedAt))];
        // Só conta XP do que terminou nos últimos 7 dias (não premia o histórico antigo de uma vez).
        if (Date.now() - new Date(t.completedAt).getTime() < 7 * 864e5) {
          s.xp += 10;
          steps++;
        }
      }
  const ready: GamePieceDto[] = [];
  for (const p of snap.pieces)
    if (READY.includes(p.stage) && !s.onTime.includes(p.id)) {
      s.onTime.push(p.id);
      if (!p.promisedDate || p.promisedDate.slice(0, 10) >= today()) {
        s.xp += 30;
        ready.push(p);
      }
    }
  const missions = missionsOf(snap, s);
  const fresh: Mission[] = [];
  for (const m of missions) {
    const key = `${today()}:${m.id}`;
    if (m.done && !s.paid.includes(key)) {
      s.paid.push(key);
      s.xp += m.xp;
      fresh.push(m);
    }
  }
  save(orgId, s);
  const lv = levelOf(s.xp);
  const progress = progressOf(s.xp);
  return {
    progress,
    missions,
    freshMissions: before === 0 && s.paid.length === fresh.length ? [] : fresh,
    leveledUp: lv > beforeLevel && before > 0,
    steps,
    readyOnTime: ready,
    week: weekBoard(s, snap),
  };
}

export function progressOf(xp: number): Progress {
  const lv = levelOf(xp);
  const cur = LEVELS[lv]!;
  const next = LEVELS[lv + 1];
  const rewards = REWARDS.filter((r) => r.level <= lv + 1).map((r) => r.id);
  const nr = REWARDS.find((r) => r.level > lv + 1);
  return {
    xp,
    level: lv + 1,
    levelName: cur.name,
    into: xp - cur.xp,
    span: next ? next.xp - cur.xp : 1,
    rewards,
    nextReward: nr ? { level: nr.level, label: nr.label } : null,
  };
}

/** Placar da semana: total da equipe e, se o dono quiser, por pessoa. */
function weekBoard(s: Store, snap: GameSnapshotDto) {
  const ws = weekStart();
  const names = new Map(snap.employees.map((e) => [e.userId, e.name]));
  const per = new Map<string, number>();
  let total = 0;
  for (const [, [user, day]] of Object.entries(s.tasks)) {
    if (day < ws) continue;
    total++;
    if (user) per.set(user, (per.get(user) ?? 0) + 1);
  }
  return {
    total,
    people: [...per.entries()]
      .map(([id, n]) => ({ id, name: names.get(id) ?? 'Equipe', n }))
      .sort((a, b) => b.n - a.n),
  };
}
