/**
 * Converte o retrato da operação (posição representada de cada peça e de cada pessoa) em
 * coordenadas do mapa, sem sobrepor peças: estação → faixa de trabalho; fila → fila ao lado da
 * estação; área → grade dentro da área.
 */
import {
  type AgentDto,
  type GameEmployeeDto,
  type GamePieceDto,
  type LayoutContent,
  type Rect,
  footprint,
  frontRect,
  obstaclesOf,
  overlaps,
  pieceWorkflow,
  rectOfArea,
} from '@cenario/shared';
import { type BuildStage, FURNITURE_SIZE, OFFICE_SEAT, fabricColorFor } from './models';
import type { PersonVisual, PieceVisual } from './engine';

const TONE_COLOR = {
  ok: '#1f7a46',
  atencao: '#a15c07',
  risco: '#b42323',
  info: '#2c5ea8',
} as const;

const ACT_LEVEL: Record<string, number> = {
  DESMONTAGEM: 1,
  PREPARACAO: 2,
  PREPARACAO_MDF: 2,
  CORTE: 2,
  CORTE_TECIDO: 2,
  CORTE_ESPUMA: 3,
  COSTURA: 3,
  REVESTIMENTO: 4,
  MONTAGEM: 4,
  ACABAMENTO: 4,
  CORRECAO: 4,
  EMBALAGEM: 5,
};
const LEVEL_STAGE: BuildStage[] = [
  'ANTIGA',
  'DESMONTADA',
  'ESTRUTURA',
  'ESPUMA',
  'CAPA',
  'EMBALADA',
];

/**
 * Aparência da peça pela etapa real: chega usada (reforma) ou só na estrutura (fabricação), é
 * desmontada, ganha espuma, capa nova e sai embalada. Usa a etapa mais avançada já iniciada ou
 * concluída; inspeção mostra a capa pronta; expedição, embalada.
 */
export function buildStageOf(p: Pick<GamePieceDto, 'stage' | 'tasks' | 'serviceType'>): BuildStage {
  if (
    [
      'AGUARDANDO_EMBALAGEM',
      'EM_EMBALAGEM',
      'PRONTA_ENTREGA',
      'ENTREGA_AGENDADA',
      'EM_TRANSPORTE',
      'BLOQUEIO_EXPEDICAO',
      'ENTREGUE',
    ].includes(p.stage)
  )
    return 'EMBALADA';
  if (['AGUARDANDO_INSPECAO', 'EM_INSPECAO', 'EM_CORRECAO'].includes(p.stage)) return 'CAPA';
  let level = /REFORMA|RESTAUR/i.test(p.serviceType ?? '') ? 0 : 2;
  for (const t of p.tasks) {
    const l = ACT_LEVEL[t.activity];
    if (l === undefined) continue;
    if (t.status === 'CONCLUIDA') level = Math.max(level, l === 1 ? 2 : Math.min(4, l));
    else if (t.status === 'EM_EXECUCAO' || t.status === 'PAUSADA') level = Math.max(level, l);
  }
  return LEVEL_STAGE[Math.min(5, level)]!;
}

const ATTENDANCE_AWAY = [
  'AUSENCIA_PRESUMIDA',
  'AUSENCIA_CONFIRMADA',
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
  'ENCERRADO',
];

export function piecesOnMap(
  l: LayoutContent,
  pieces: GamePieceDto[],
  highlightId: string | null,
  matches?: (p: GamePieceDto) => boolean,
): PieceVisual[] {
  const out: PieceVisual[] = [];
  const taken: Rect[] = [];
  const obstacles = obstaclesOf(l);
  const queueCount = new Map<string, number>();
  const stationCount = new Map<string, number>();
  const sizeCm = (p: GamePieceDto) => {
    const [w, d] = FURNITURE_SIZE[p.model];
    return { w: w * 100, d: d * 100 };
  };
  const fits = (r: Rect) =>
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= l.widthCm &&
    r.y + r.d <= l.depthCm &&
    !taken.some((t) => overlaps(t, r, 10));

  const freeIn = (zone: Rect, s: { w: number; d: number }): Rect | null => {
    for (let y = zone.y + 40; y + s.d <= zone.y + zone.d - 10; y += 25)
      for (let x = zone.x + 20; x + s.w <= zone.x + zone.w - 10; x += 25) {
        const r = { x, y, w: s.w, d: s.d };
        if (fits(r) && !obstacles.some((o) => overlaps(o, r, 15))) return r;
      }
    return null;
  };
  /** Área da etapa; se lotada, a espera; depois qualquer área; por fim, o chão livre. */
  const inArea = (areaId: string | null, p: GamePieceDto): Rect | null => {
    const s = sizeCm(p);
    const first = l.areas.find((x) => x.id === areaId);
    const espera = l.areas.find((x) => x.function === 'ESPERA');
    const zones = [first, espera, ...l.areas.filter((a) => a !== first && a !== espera)]
      .filter(Boolean)
      .map((a) => rectOfArea(a!));
    zones.push({ x: 0, y: 0, w: l.widthCm, d: l.depthCm });
    for (const z of zones) {
      const r = freeIn(z, s);
      if (r) return r;
    }
    const zone = zones[0]!;
    const n = taken.filter((t) => overlaps(t, zone)).length;
    return {
      x: zone.x + 20 + (n % 3) * 40,
      y: zone.y + 60 + Math.floor(n / 3) * 40,
      w: s.w,
      d: s.d,
    };
  };

  // Primeiro quem está em estação (mais importante ficar no lugar certo), depois filas e áreas.
  const order = [...pieces].sort((a, b) => rank(a) - rank(b));
  for (const p of order) {
    const s = sizeCm(p);
    let rect: Rect | null = null;
    let rot = 0;
    const st = l.stations.find((x) => x.id === p.placement.stationId);
    if (p.placement.kind === 'ESTACAO' && st) {
      const n = stationCount.get(st.id) ?? 0;
      stationCount.set(st.id, n + 1);
      // Em cima/ao lado da bancada: faixa frontal (ou em cima, para peças pequenas).
      // Na frente da bancada, depois do lugar de quem trabalha (o funcionário fica de lado).
      const turned = st.rotation === 90 || st.rotation === 270;
      const fr = frontRect(st, 70 + (turned ? s.w : s.d) + n * 40);
      rect = turned
        ? {
            x: st.rotation === 90 ? fr.x : fr.x + fr.w - s.w,
            y: fr.y + (fr.d - s.d) / 2,
            w: s.w,
            d: s.d,
          }
        : {
            x: fr.x + (fr.w - s.w) / 2 + n * 30,
            y: st.rotation === 0 ? fr.y + fr.d - s.d : fr.y,
            w: s.w,
            d: s.d,
          };
      rot = (-st.rotation * Math.PI) / 180;
    } else if (p.placement.kind === 'FILA' && st) {
      const n = queueCount.get(st.id) ?? 0;
      queueCount.set(st.id, n + 1);
      // Fila: ao lado da estação, uma atrás da outra, afastando-se da bancada.
      const f = footprint(st);
      const fr = frontRect(st, 170 + n * (s.d + 40));
      const base = { x: fr.x + fr.w + 30, y: f.y + n * (s.d + 30), w: s.w, d: s.d };
      rect = fits(base) ? base : { x: f.x - s.w - 30, y: f.y + n * (s.d + 30), w: s.w, d: s.d };
      if (!fits(rect)) rect = inArea(st.areaId ?? p.placement.areaId, p);
    } else rect = inArea(p.placement.areaId, p);
    if (!rect) continue;
    taken.push(rect);
    const conf = p.confirmedLocation;
    let confirmed: PieceVisual['confirmed'] = null;
    if (conf && conf.areaId && conf.areaId !== p.placement.areaId) {
      const a = l.areas.find((x) => x.id === conf.areaId);
      if (a)
        confirmed = {
          x: a.xCm + a.wCm - 60,
          y: a.yCm + 60 + (out.filter((o) => o.confirmed).length % 4) * 50,
          text: `${conf.label} (${new Date(conf.at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`,
        };
    }
    out.push({
      id: p.id,
      model: p.model,
      osCode: p.itemCode,
      color: fabricColorFor(p.fabric, p.itemCode),
      stage: buildStageOf(p),
      x: rect.x + rect.w / 2,
      y: rect.y + rect.d / 2,
      rot,
      // A etapa já aparece em `phase`: tira a repetição do começo ("Em execução · …").
      label: p.placement.label.replace(/^(Em execução|Pausada|Parada|Aguardando[^·]*) · /, ''),
      ...(() => {
        const w = pieceWorkflow(p);
        const late = isLate(p);
        return {
          phase: `${w.icon} ${w.phaseLabel.replace(' (rascunho, não publicada)', '').replace('Parada (bloqueada)', 'Parada')}${late ? ' · ⚠ atrasada' : ''}`,
          icon: late && w.phase !== 'PRONTA_ENTREGA' ? '⚠' : w.icon,
          tone: late && w.phase !== 'PRONTA_ENTREGA' ? TONE_COLOR.risco : TONE_COLOR[w.tone],
        };
      })(),
      dimmed: matches ? !matches(p) : false,
      highlight: p.id === highlightId,
      confirmed,
    });
  }
  return out;
}

/** Prazo prometido já passou (dia de hoje em São Paulo). */
export function isLate(p: Pick<GamePieceDto, 'promisedDate' | 'stage'>, now = new Date()) {
  if (!p.promisedDate) return false;
  if (['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE', 'ENTREGUE'].includes(p.stage))
    return false;
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return p.promisedDate.slice(0, 10) < today;
}

function rank(p: GamePieceDto) {
  return p.placement.kind === 'ESTACAO' ? 0 : p.placement.kind === 'FILA' ? 1 : 2;
}

export function peopleOnMap(
  l: LayoutContent,
  spaceKind: string,
  employees: GameEmployeeDto[],
  agents: AgentDto[],
  pieces: GamePieceDto[] = [],
  now = Date.now(),
): PersonVisual[] {
  const out: PersonVisual[] = [];
  if (spaceKind !== 'ESCRITORIO') {
    const used = new Map<string, number>();
    for (const e of employees) {
      const st =
        l.stations.find((s) => s.id === e.stationId) ??
        l.stations.find((s) => e.stationIds.includes(s.id));
      let x = 120 + out.length * 80;
      let y = l.depthCm - 120;
      let face = Math.PI;
      if (st) {
        const n = used.get(st.id) ?? 0;
        used.set(st.id, n + 1);
        // De pé na frente da bancada, perto da ponta (deixa o meio para a peça).
        const fr = frontRect(st, 45);
        const horizontal = st.rotation === 0 || st.rotation === 180;
        x = horizontal ? fr.x + 35 + n * 55 : fr.x + fr.w / 2;
        y = horizontal ? fr.y + fr.d / 2 : fr.y + 35 + n * 55;
        face = Math.PI - (st.rotation * Math.PI) / 180;
      }
      const away = e.attendance && ATTENDANCE_AWAY.includes(e.attendance);
      const cur = e.currentTask;
      const working = cur && cur.status !== 'PAUSADA';
      out.push({
        id: e.userId,
        kind: 'employee',
        name: e.name,
        color: e.color,
        roles: e.roles,
        x,
        y,
        face,
        status: cur
          ? cur.status === 'PAUSADA'
            ? 'pausado'
            : undefined
          : away
            ? 'ausente'
            : e.queue.length
              ? `${e.queue.length} na fila`
              : 'livre',
        dim: Boolean(away),
        activity: working ? cur.activity : null,
        bubble: bubbleOf(e, pieces, now),
      });
    }
  }
  for (const a of agents) {
    if (a.status === 'DESATIVADO') continue;
    const desk = l.stations.find((s) => s.id === a.deskStationId);
    if (!desk) continue;
    // Ponto do assento da cadeira da mesa (mesma medida do modelo 3D): o agente senta nela.
    const fr = frontRect(desk, OFFICE_SEAT.depth * 200);
    out.push({
      id: a.id,
      kind: 'agent',
      name: a.name,
      color: a.color,
      x: fr.x + fr.w / 2,
      y: fr.y + fr.d / 2,
      face: Math.PI - (desk.rotation * Math.PI) / 180,
      seated: true,
      status:
        a.status === 'PAUSADO'
          ? 'pausado'
          : a.pendingProposals
            ? `${a.pendingProposals} proposta(s)`
            : undefined,
      dim: a.status === 'PAUSADO',
    });
  }
  return out;
}

/** Balão sobre o funcionário: parado por falta de algo, terminou agora, ou trabalhando em peça atrasada. */
export function bubbleOf(
  e: GameEmployeeDto,
  pieces: GamePieceDto[],
  now = Date.now(),
): PersonVisual['bubble'] {
  const cur = e.currentTask;
  if (cur?.status === 'PAUSADA') {
    const why = cur.blockers[0];
    return { text: `⏸ ${why ? short(why) : 'pausado'}`, tone: 'warn' };
  }
  if (cur) {
    const piece = pieces.find((p) => p.tasks.some((t) => t.id === cur.id));
    if (piece && isLate(piece)) return { text: '⚠ atrasado', tone: 'danger' };
    return null;
  }
  // Terminou uma etapa nos últimos 10 minutos.
  const done = pieces
    .flatMap((p) => p.tasks)
    .filter((t) => t.assigneeUserId === e.userId && t.status === 'CONCLUIDA' && t.completedAt)
    .some((t) => now - new Date(t.completedAt!).getTime() < 10 * 60_000);
  if (done) return { text: '✓ terminei', tone: 'ok' };
  return null;
}

function short(s: string) {
  const t = s.replace(/^Falta de /i, 'falta ').replace(/\.$/, '');
  return t.length > 22 ? `${t.slice(0, 21)}…` : t.charAt(0).toLowerCase() + t.slice(1);
}
