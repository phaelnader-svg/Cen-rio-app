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
  rectOfArea,
} from '@cenario/shared';
import { FURNITURE_SIZE } from './models';
import type { PersonVisual, PieceVisual } from './engine';

const ATTENDANCE_AWAY = ['AUSENCIA_PRESUMIDA', 'AUSENCIA_CONFIRMADA', 'AUSENCIA_JUSTIFICADA', 'ATESTADO', 'FOLGA', 'FERIAS', 'ENCERRADO'];

export function piecesOnMap(l: LayoutContent, pieces: GamePieceDto[], highlightId: string | null): PieceVisual[] {
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
    r.x >= 0 && r.y >= 0 && r.x + r.w <= l.widthCm && r.y + r.d <= l.depthCm && !taken.some((t) => overlaps(t, r, 10));

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
    const zones = [first, espera, ...l.areas.filter((a) => a !== first && a !== espera)].filter(Boolean).map((a) => rectOfArea(a!));
    zones.push({ x: 0, y: 0, w: l.widthCm, d: l.depthCm });
    for (const z of zones) {
      const r = freeIn(z, s);
      if (r) return r;
    }
    const zone = zones[0]!;
    const n = taken.filter((t) => overlaps(t, zone)).length;
    return { x: zone.x + 20 + (n % 3) * 40, y: zone.y + 60 + Math.floor(n / 3) * 40, w: s.w, d: s.d };
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
        ? { x: st.rotation === 90 ? fr.x : fr.x + fr.w - s.w, y: fr.y + (fr.d - s.d) / 2, w: s.w, d: s.d }
        : { x: fr.x + (fr.w - s.w) / 2 + n * 30, y: st.rotation === 0 ? fr.y + fr.d - s.d : fr.y, w: s.w, d: s.d };
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
          text: `${conf.label} (${new Date(conf.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`,
        };
    }
    out.push({
      id: p.id,
      model: p.model,
      osCode: p.itemCode,
      tone: p.tone,
      x: rect.x + rect.w / 2,
      y: rect.y + rect.d / 2,
      rot,
      label: p.placement.label,
      highlight: p.id === highlightId,
      confirmed,
    });
  }
  return out;
}

function rank(p: GamePieceDto) {
  return p.placement.kind === 'ESTACAO' ? 0 : p.placement.kind === 'FILA' ? 1 : 2;
}

export function peopleOnMap(
  l: LayoutContent,
  spaceKind: string,
  employees: GameEmployeeDto[],
  agents: AgentDto[],
): PersonVisual[] {
  const out: PersonVisual[] = [];
  if (spaceKind !== 'ESCRITORIO') {
    const used = new Map<string, number>();
    for (const e of employees) {
      const st = l.stations.find((s) => s.id === e.stationId) ?? l.stations.find((s) => e.stationIds.includes(s.id));
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
      out.push({
        id: e.userId,
        kind: 'employee',
        name: e.name,
        color: e.color,
        x,
        y,
        face,
        status: e.currentTask ? (e.currentTask.status === 'PAUSADA' ? 'pausado' : 'trabalhando') : away ? 'ausente' : e.queue.length ? `${e.queue.length} na fila` : 'livre',
        dim: Boolean(away),
      });
    }
  }
  for (const a of agents) {
    if (a.status === 'DESATIVADO') continue;
    const desk = l.stations.find((s) => s.id === a.deskStationId);
    if (!desk) continue;
    const fr = frontRect(desk, 50);
    out.push({
      id: a.id,
      kind: 'agent',
      name: a.name,
      color: a.color,
      x: fr.x + fr.w / 2,
      y: fr.y + fr.d / 2,
      face: Math.PI - (desk.rotation * Math.PI) / 180,
      seated: true,
      status: a.status === 'PAUSADO' ? 'pausado' : a.pendingProposals ? `${a.pendingProposals} proposta(s)` : undefined,
      dim: a.status === 'PAUSADO',
    });
  }
  return out;
}
