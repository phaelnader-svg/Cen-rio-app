/**
 * Jogo de gestão (empresa virtual da Cenário Estofados) — regras puras.
 *
 * A planta (espaços, áreas, estações, armazenagem) é representação editável. Os dados
 * operacionais continuam vindo do Cenário Gestão: OS, tarefas, estoque e compras. Aqui ficam:
 * - catálogos (funções de área, tipos de estação/armazenagem/decoração) com medidas padrão;
 * - plantas iniciais sugeridas (oficina ~180 m² e escritório), com medidas ILUSTRATIVAS;
 * - geometria em centímetros (origem no canto noroeste; x para leste, y para sul);
 * - grade de ocupação, caminho (A*) e análise de passagem para móveis;
 * - posição representada de cada peça conforme a etapa registrada;
 * - o Mestre de Obras (sugestões de layout com prévia aplicável).
 */

// ───────────────────────────── Catálogos ─────────────────────────────

export const AREA_FUNCTIONS = [
  'RECEBIMENTO',
  'ESPERA',
  'DESMANCHE',
  'CORTE',
  'COSTURA',
  'MARCENARIA',
  'MONTAGEM',
  'ACABAMENTO',
  'QUALIDADE',
  'EMBALAGEM',
  'EXPEDICAO',
  'ESTOQUE',
  'ESCRITORIO',
  'REUNIAO',
  'CIRCULACAO',
  'OUTRA',
] as const;
export type AreaFunction = (typeof AREA_FUNCTIONS)[number];

export const AREA_FUNCTION_LABEL: Record<AreaFunction, string> = {
  RECEBIMENTO: 'Recebimento',
  ESPERA: 'Espera',
  DESMANCHE: 'Desmanche',
  CORTE: 'Corte',
  COSTURA: 'Costura',
  MARCENARIA: 'Marcenaria',
  MONTAGEM: 'Montagem',
  ACABAMENTO: 'Acabamento',
  QUALIDADE: 'Controle de qualidade',
  EMBALAGEM: 'Embalagem',
  EXPEDICAO: 'Expedição',
  ESTOQUE: 'Estoque',
  ESCRITORIO: 'Escritório',
  REUNIAO: 'Reunião',
  CIRCULACAO: 'Circulação',
  OUTRA: 'Outra',
};

/** Paleta própria da Cenário (tons de terracota, linho, oliva e petróleo). */
export const AREA_FUNCTION_COLOR: Record<AreaFunction, string> = {
  RECEBIMENTO: '#e9c46a',
  ESPERA: '#f4d8a8',
  DESMANCHE: '#e7a977',
  CORTE: '#c9d6a3',
  COSTURA: '#a8c5bd',
  MARCENARIA: '#d4b48c',
  MONTAGEM: '#e8b4a0',
  ACABAMENTO: '#d8c3e0',
  QUALIDADE: '#b9d3ee',
  EMBALAGEM: '#cfe0b4',
  EXPEDICAO: '#9fc9c0',
  ESTOQUE: '#d9cbb6',
  ESCRITORIO: '#dfe3ec',
  REUNIAO: '#e6dcf0',
  CIRCULACAO: '#efe9df',
  OUTRA: '#e5e5e5',
};

/** Etapa de produção (production_activity) → função de área onde ela acontece. */
export const ACTIVITY_AREA: Record<string, AreaFunction> = {
  DESMONTAGEM: 'DESMANCHE',
  PREPARACAO: 'DESMANCHE',
  PREPARACAO_MDF: 'MARCENARIA',
  CORTE_TECIDO: 'CORTE',
  CORTE_ESPUMA: 'CORTE',
  CORTE: 'CORTE',
  COSTURA: 'COSTURA',
  REVESTIMENTO: 'MONTAGEM',
  MONTAGEM: 'MONTAGEM',
  ACABAMENTO: 'ACABAMENTO',
  APOIO: 'MONTAGEM',
  OUTRA: 'MONTAGEM',
  CORRECAO: 'ACABAMENTO',
  EMBALAGEM: 'EMBALAGEM',
};

export const ACTIVITY_LABEL_GAME: Record<string, string> = {
  DESMONTAGEM: 'Desmontagem',
  PREPARACAO: 'Preparação',
  PREPARACAO_MDF: 'Preparação de MDF',
  CORTE_TECIDO: 'Corte de tecido',
  CORTE_ESPUMA: 'Corte de espuma',
  CORTE: 'Corte',
  COSTURA: 'Costura',
  REVESTIMENTO: 'Revestimento',
  MONTAGEM: 'Montagem',
  ACABAMENTO: 'Acabamento',
  APOIO: 'Apoio',
  OUTRA: 'Outra',
  CORRECAO: 'Correção',
  EMBALAGEM: 'Embalagem',
};

/** Etapa derivada da peça (quality-domain) → área onde ela é representada. */
export const STAGE_AREA: Partial<Record<string, AreaFunction>> = {
  AGUARDANDO_INSPECAO: 'QUALIDADE',
  EM_INSPECAO: 'QUALIDADE',
  EM_CORRECAO: 'ACABAMENTO',
  AGUARDANDO_EMBALAGEM: 'EMBALAGEM',
  EM_EMBALAGEM: 'EMBALAGEM',
  BLOQUEIO_EXPEDICAO: 'EXPEDICAO',
  PRONTA_ENTREGA: 'EXPEDICAO',
  ENTREGA_AGENDADA: 'EXPEDICAO',
  EM_TRANSPORTE: 'EXPEDICAO',
};

export interface CatalogEntry {
  label: string;
  wCm: number;
  dCm: number;
  hCm: number;
  /** Espaço livre exigido na frente (lado sul quando rotação 0) para trabalhar. */
  frontClearCm: number;
  activities?: string[];
  areaHint?: AreaFunction;
  levels?: number;
  slotWord?: string;
  /** Móvel do escritório que pode receber agente ou funcionário. */
  desk?: boolean;
}

export const STATION_KINDS = {
  BANCADA_TAPECEIRO: {
    label: 'Bancada de tapeceiro',
    wCm: 200,
    dCm: 100,
    hCm: 85,
    frontClearCm: 90,
    activities: ['MONTAGEM', 'REVESTIMENTO', 'ACABAMENTO', 'APOIO', 'CORRECAO'],
    areaHint: 'MONTAGEM',
  },
  BANCADA_DESMANCHE: {
    label: 'Bancada de desmanche',
    wCm: 200,
    dCm: 100,
    hCm: 80,
    frontClearCm: 90,
    activities: ['DESMONTAGEM', 'PREPARACAO'],
    areaHint: 'DESMANCHE',
  },
  MESA_CORTE: {
    label: 'Mesa de corte',
    wCm: 300,
    dCm: 160,
    hCm: 90,
    frontClearCm: 80,
    activities: ['CORTE_TECIDO', 'CORTE_ESPUMA', 'CORTE'],
    areaHint: 'CORTE',
  },
  MAQUINA_COSTURA: {
    label: 'Máquina de costura',
    wCm: 120,
    dCm: 60,
    hCm: 120,
    frontClearCm: 80,
    activities: ['COSTURA'],
    areaHint: 'COSTURA',
  },
  BANCADA_MARCENARIA: {
    label: 'Bancada de marcenaria',
    wCm: 220,
    dCm: 90,
    hCm: 90,
    frontClearCm: 100,
    activities: ['PREPARACAO_MDF'],
    areaHint: 'MARCENARIA',
  },
  MESA_INSPECAO: {
    label: 'Mesa de inspeção',
    wCm: 200,
    dCm: 110,
    hCm: 75,
    frontClearCm: 90,
    activities: [],
    areaHint: 'QUALIDADE',
  },
  MESA_EMBALAGEM: {
    label: 'Mesa de embalagem',
    wCm: 220,
    dCm: 120,
    hCm: 80,
    frontClearCm: 90,
    activities: ['EMBALAGEM'],
    areaHint: 'EMBALAGEM',
  },
  ESTACAO_LIVRE: {
    label: 'Estação de trabalho',
    wCm: 160,
    dCm: 80,
    hCm: 80,
    frontClearCm: 80,
    activities: [],
  },
  MESA_ESCRITORIO: {
    label: 'Mesa de escritório',
    wCm: 140,
    dCm: 70,
    hCm: 75,
    frontClearCm: 90,
    areaHint: 'ESCRITORIO',
    desk: true,
  },
  MESA_REUNIAO: {
    label: 'Mesa de reunião',
    wCm: 240,
    dCm: 110,
    hCm: 75,
    frontClearCm: 90,
    areaHint: 'REUNIAO',
  },
  /** Quadro de Metas do caixa (escritório): saldo, próxima meta e semana. */
  QUADRO_METAS: {
    label: 'Quadro de Metas',
    wCm: 180,
    dCm: 30,
    hCm: 190,
    frontClearCm: 100,
    areaHint: 'ESCRITORIO',
  },
} as const satisfies Record<string, CatalogEntry>;
export type StationKind = keyof typeof STATION_KINDS;

export const STORAGE_KINDS = {
  ESTANTE: {
    label: 'Estante',
    wCm: 180,
    dCm: 50,
    hCm: 200,
    frontClearCm: 90,
    levels: 4,
    slotWord: 'Prateleira',
  },
  PRATELEIRA: {
    label: 'Prateleira',
    wCm: 120,
    dCm: 40,
    hCm: 160,
    frontClearCm: 80,
    levels: 3,
    slotWord: 'Nível',
  },
  ARMARIO: {
    label: 'Armário',
    wCm: 100,
    dCm: 55,
    hCm: 190,
    frontClearCm: 80,
    levels: 3,
    slotWord: 'Prateleira',
  },
  GAVETEIRO: {
    label: 'Gaveteiro de ferragens',
    wCm: 70,
    dCm: 50,
    hCm: 100,
    frontClearCm: 70,
    levels: 5,
    slotWord: 'Gaveta',
  },
  SUPORTE_ROLOS: {
    label: 'Suporte de rolos de tecido',
    wCm: 220,
    dCm: 70,
    hCm: 180,
    frontClearCm: 100,
    levels: 3,
    slotWord: 'Nível',
  },
  ESTRADO_ESPUMA: {
    label: 'Estrado de espumas',
    wCm: 210,
    dCm: 110,
    hCm: 150,
    frontClearCm: 90,
    levels: 1,
    slotWord: 'Pilha',
  },
} as const satisfies Record<string, CatalogEntry>;
export type StorageKind = keyof typeof STORAGE_KINDS;

export const DECOR_KINDS = {
  SOFA_ESPERA: { label: 'Sofá de espera', wCm: 200, dCm: 90, hCm: 80, frontClearCm: 60 },
  CADEIRA: { label: 'Cadeira', wCm: 50, dCm: 50, hCm: 90, frontClearCm: 0 },
  PLANTA: { label: 'Vaso com planta', wCm: 50, dCm: 50, hCm: 120, frontClearCm: 0 },
  PALETE: { label: 'Palete', wCm: 120, dCm: 100, hCm: 15, frontClearCm: 60 },
  LIXEIRA: { label: 'Lixeira', wCm: 50, dCm: 50, hCm: 70, frontClearCm: 0 },
  QUADRO: { label: 'Quadro de avisos', wCm: 120, dCm: 10, hCm: 90, frontClearCm: 0 },
  BALCAO: { label: 'Balcão', wCm: 200, dCm: 60, hCm: 100, frontClearCm: 80 },
  BEBEDOURO: { label: 'Bebedouro', wCm: 40, dCm: 40, hCm: 110, frontClearCm: 50 },
} as const satisfies Record<string, CatalogEntry>;
export type DecorKind = keyof typeof DECOR_KINDS;

/** Largura livre para um sofá de 3 lugares passar de frente (~90 cm de profundidade + folga). */
export const SOFA_PASSAGE_CM = 100;
/** Passagem mínima para uma pessoa (sem carga). */
export const PERSON_PASSAGE_CM = 60;

// ───────────────────────────── Tipos da planta ─────────────────────────────

export type Rotation = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface WallDef {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DoorDef {
  id: string;
  /** 'N' | 'S' | 'L' | 'O' (paredes externas) ou id de parede interna. */
  wall: string;
  offsetCm: number;
  widthCm: number;
  label?: string | null;
  /** Espaço de destino (porta de passagem entre ambientes). */
  toSpaceKey?: string | null;
}

export interface DecorDef {
  id: string;
  kind: DecorKind;
  name?: string | null;
  xCm: number;
  yCm: number;
  wCm: number;
  dCm: number;
  rotation: Rotation;
}

/** Janela numa parede (externa N/S/L/O ou interna): referência para o Mestre de Obras. */
export interface WindowDef {
  id: string;
  wall: string;
  offsetCm: number;
  widthCm: number;
}

export interface LayoutDoc {
  walls: WallDef[];
  doors: DoorDef[];
  decor: DecorDef[];
  windows?: WindowDef[];
  notes?: string | null;
}

export interface AreaDef {
  id: string;
  function: AreaFunction;
  name: string;
  xCm: number;
  yCm: number;
  wCm: number;
  dCm: number;
  color?: string | null;
  itemLocationId?: string | null;
}

export interface StationDef {
  id: string;
  kind: StationKind;
  name: string;
  areaId?: string | null;
  xCm: number;
  yCm: number;
  wCm: number;
  dCm: number;
  rotation: Rotation;
  activities: string[];
  shared: boolean;
  assigneeUserIds: string[];
}

export interface StorageSlotDef {
  id: string;
  label: string;
  level: number;
  stockItemIds: string[];
}

export interface StorageUnitDef {
  id: string;
  kind: StorageKind;
  label: string;
  areaId?: string | null;
  xCm: number;
  yCm: number;
  wCm: number;
  dCm: number;
  rotation: Rotation;
  slots: StorageSlotDef[];
}

export type SpaceKind = 'OFICINA' | 'ESCRITORIO' | 'OUTRO';

export interface LayoutContent {
  name: string;
  kind: SpaceKind;
  widthCm: number;
  depthCm: number;
  gridCm: number;
  illustrative: boolean;
  doc: LayoutDoc;
  areas: AreaDef[];
  stations: StationDef[];
  storageUnits: StorageUnitDef[];
}

// ───────────────────────────── Geometria ─────────────────────────────

/** Retângulo ocupado no chão (largura e profundidade trocam a 90°/270°). */
export function footprint(o: {
  xCm: number;
  yCm: number;
  wCm: number;
  dCm: number;
  rotation?: number;
}): Rect {
  const turned = o.rotation === 90 || o.rotation === 270;
  return { x: o.xCm, y: o.yCm, w: turned ? o.dCm : o.wCm, d: turned ? o.wCm : o.dCm };
}

export const rectOfArea = (a: { xCm: number; yCm: number; wCm: number; dCm: number }): Rect => ({
  x: a.xCm,
  y: a.yCm,
  w: a.wCm,
  d: a.dCm,
});

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.d + gap && b.y < a.y + a.d + gap
  );
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.d <= outer.y + outer.d
  );
}

export const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.d / 2 });
export const areaM2 = (r: { w: number; d: number }) => Math.round((r.w * r.d) / 1000) / 10;

/** Retângulo da faixa de trabalho em frente ao móvel (lado "frontal" conforme a rotação). */
export function frontRect(o: StationDef | StorageUnitDef | DecorDef, depthCm: number): Rect {
  const f = footprint(o);
  switch (o.rotation) {
    case 0:
      return { x: f.x, y: f.y + f.d, w: f.w, d: depthCm };
    case 180:
      return { x: f.x, y: f.y - depthCm, w: f.w, d: depthCm };
    case 90:
      return { x: f.x - depthCm, y: f.y, w: depthCm, d: f.d };
    default:
      return { x: f.x + f.w, y: f.y, w: depthCm, d: f.d };
  }
}

export function catalogOf(kind: string): CatalogEntry {
  return (
    (STATION_KINDS as Record<string, CatalogEntry>)[kind] ??
    (STORAGE_KINDS as Record<string, CatalogEntry>)[kind] ??
    (DECOR_KINDS as Record<string, CatalogEntry>)[kind] ??
    STATION_KINDS.ESTACAO_LIVRE
  );
}

/** Paredes externas (N, S, L, O) com as portas abertas nelas, como segmentos. */
export function exteriorWalls(widthCm: number, depthCm: number): WallDef[] {
  return [
    { id: 'N', x1: 0, y1: 0, x2: widthCm, y2: 0 },
    { id: 'S', x1: 0, y1: depthCm, x2: widthCm, y2: depthCm },
    { id: 'O', x1: 0, y1: 0, x2: 0, y2: depthCm },
    { id: 'L', x1: widthCm, y1: 0, x2: widthCm, y2: depthCm },
  ];
}

export function wallById(l: Pick<LayoutContent, 'widthCm' | 'depthCm' | 'doc'>, id: string) {
  return (
    exteriorWalls(l.widthCm, l.depthCm).find((w) => w.id === id) ??
    l.doc.walls.find((w) => w.id === id) ??
    null
  );
}

/** Ponto central de uma porta (no plano da parede). */
export function doorCenter(l: Pick<LayoutContent, 'widthCm' | 'depthCm' | 'doc'>, door: DoorDef) {
  const w = wallById(l, door.wall);
  if (!w) return null;
  const horizontal = w.y1 === w.y2;
  const off = door.offsetCm + door.widthCm / 2;
  return horizontal
    ? { x: Math.min(w.x1, w.x2) + off, y: w.y1 }
    : { x: w.x1, y: Math.min(w.y1, w.y2) + off };
}

// ───────────────────────────── Grade de ocupação e caminho ─────────────────────────────

export interface OccupancyGrid {
  cell: number;
  cols: number;
  rows: number;
  /** 1 = bloqueado (móvel ou parede). */
  blocked: Uint8Array;
}

export interface GridOptions {
  cell?: number;
  /** Folga somada em volta dos obstáculos (meia largura do que vai passar). */
  inflateCm?: number;
  /** Ids ignorados (ex.: o próprio móvel sendo arrastado). */
  ignore?: ReadonlySet<string>;
  /** Obstáculos extras (prévia do Mestre de Obras). */
  extra?: Rect[];
}

export function obstaclesOf(l: LayoutContent, ignore?: ReadonlySet<string>): Rect[] {
  const out: Rect[] = [];
  for (const s of l.stations) if (!ignore?.has(s.id)) out.push(footprint(s));
  for (const u of l.storageUnits) if (!ignore?.has(u.id)) out.push(footprint(u));
  for (const d of l.doc.decor)
    if (!ignore?.has(d.id) && d.kind !== 'CADEIRA') out.push(footprint(d));
  return out;
}

export function buildGrid(l: LayoutContent, opts: GridOptions = {}): OccupancyGrid {
  const cell = opts.cell ?? 25;
  const inflate = opts.inflateCm ?? 0;
  const cols = Math.max(1, Math.ceil(l.widthCm / cell));
  const rows = Math.max(1, Math.ceil(l.depthCm / cell));
  const blocked = new Uint8Array(cols * rows);
  const mark = (r: Rect) => {
    const x0 = Math.max(0, Math.floor((r.x - inflate) / cell));
    const y0 = Math.max(0, Math.floor((r.y - inflate) / cell));
    const x1 = Math.min(cols - 1, Math.ceil((r.x + r.w + inflate) / cell) - 1);
    const y1 = Math.min(rows - 1, Math.ceil((r.y + r.d + inflate) / cell) - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) blocked[y * cols + x] = 1;
  };
  for (const r of obstaclesOf(l, opts.ignore)) mark(r);
  for (const r of opts.extra ?? []) mark(r);
  // Folga junto às paredes externas.
  if (inflate > 0) {
    mark({ x: -inflate, y: -inflate, w: l.widthCm + 2 * inflate, d: inflate });
    mark({ x: -inflate, y: l.depthCm, w: l.widthCm + 2 * inflate, d: inflate });
    mark({ x: -inflate, y: 0, w: inflate, d: l.depthCm });
    mark({ x: l.widthCm, y: 0, w: inflate, d: l.depthCm });
  }
  // Paredes internas com as aberturas das portas.
  for (const w of l.doc.walls) {
    const doors = l.doc.doors.filter((d) => d.wall === w.id);
    const horizontal = w.y1 === w.y2;
    const len = horizontal ? Math.abs(w.x2 - w.x1) : Math.abs(w.y2 - w.y1);
    const start = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
    const step = cell / 2;
    for (let t = 0; t <= len; t += step) {
      if (doors.some((d) => t >= d.offsetCm && t <= d.offsetCm + d.widthCm)) continue;
      const px = horizontal ? start + t : w.x1;
      const py = horizontal ? w.y1 : start + t;
      mark({ x: px - 5, y: py - 5, w: 10, d: 10 });
    }
  }
  return { cell, cols, rows, blocked };
}

export interface GridPoint {
  x: number;
  y: number;
}

const toCell = (g: OccupancyGrid, p: GridPoint) => ({
  cx: Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell))),
  cy: Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell))),
});

/** Célula livre mais próxima (busca em anel), útil quando o destino é o próprio móvel. */
export function nearestFree(g: OccupancyGrid, p: GridPoint): GridPoint | null {
  const { cx, cy } = toCell(g, p);
  for (let r = 0; r < Math.max(g.cols, g.rows); r++) {
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (g.blocked[y * g.cols + x]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (!best || d < best.d) best = { x, y, d };
      }
    if (best) return { x: (best.x + 0.5) * g.cell, y: (best.y + 0.5) * g.cell };
  }
  return null;
}

/** Caminho A* (8 direções, sem cortar quinas) entre dois pontos em cm. */
export function findPath(g: OccupancyGrid, from: GridPoint, to: GridPoint): GridPoint[] | null {
  const a = toCell(g, from);
  const b = toCell(g, to);
  const idx = (x: number, y: number) => y * g.cols + x;
  const free = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < g.cols && y < g.rows && !g.blocked[idx(x, y)];
  if (!free(a.cx, a.cy) || !free(b.cx, b.cy)) return null;
  const n = g.cols * g.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open: number[] = [];
  const fScore = new Float64Array(n).fill(Infinity);
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - b.cx);
    const dy = Math.abs(y - b.cy);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  const s = idx(a.cx, a.cy);
  gScore[s] = 0;
  fScore[s] = h(a.cx, a.cy);
  open.push(s);
  const target = idx(b.cx, b.cy);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fScore[open[i]!]! < fScore[open[bi]!]!) bi = i;
    const cur = open.splice(bi, 1)[0]!;
    if (cur === target) break;
    closed[cur] = 1;
    const cx = cur % g.cols;
    const cy = Math.floor(cur / g.cols);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!free(nx, ny)) continue;
        if (dx && dy && (!free(cx + dx, cy) || !free(cx, cy + dy))) continue;
        const ni = idx(nx, ny);
        if (closed[ni]) continue;
        const tentative = gScore[cur]! + (dx && dy ? Math.SQRT2 : 1);
        if (tentative < gScore[ni]!) {
          came[ni] = cur;
          gScore[ni] = tentative;
          fScore[ni] = tentative + h(nx, ny);
          if (!open.includes(ni)) open.push(ni);
        }
      }
  }
  if (came[target] === -1 && target !== s) return null;
  const cells: number[] = [];
  for (let c = target; c !== -1; c = came[c]!) {
    cells.push(c);
    if (c === s) break;
  }
  cells.reverse();
  return simplifyPath(
    cells.map((c) => ({
      x: ((c % g.cols) + 0.5) * g.cell,
      y: (Math.floor(c / g.cols) + 0.5) * g.cell,
    })),
  );
}

function simplifyPath(points: GridPoint[]): GridPoint[] {
  if (points.length <= 2) return points;
  const out = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const p = out[out.length - 1]!;
    const c = points[i]!;
    const n = points[i + 1]!;
    if (
      Math.sign(c.x - p.x) === Math.sign(n.x - c.x) &&
      Math.sign(c.y - p.y) === Math.sign(n.y - c.y)
    )
      continue;
    out.push(c);
  }
  out.push(points[points.length - 1]!);
  return out;
}

export const pathLengthCm = (p: GridPoint[]) =>
  p.reduce((s, c, i) => (i ? s + Math.hypot(c.x - p[i - 1]!.x, c.y - p[i - 1]!.y) : 0), 0);

// ───────────────────────────── Análise de passagem ─────────────────────────────

export interface ClearanceProblem {
  /** Faixa estreita (para desenhar em vermelho no mapa). */
  rect: Rect;
  gapCm: number;
  requiredCm: number;
  message: string;
  severity: 'erro' | 'aviso';
}

/**
 * Folgas em volta de um objeto: vão livre até o vizinho/parede em cada lado e a faixa frontal
 * de trabalho. Vão menor que a passagem de um sofá vira aviso; menor que uma pessoa, erro.
 */
export function clearanceAround(
  l: LayoutContent,
  id: string,
  rect: Rect,
  frontClearCm = 0,
  rotation: number = 0,
): ClearanceProblem[] {
  const others = obstaclesOf(l, new Set([id]));
  const problems: ClearanceProblem[] = [];
  for (const o of others)
    if (overlaps(rect, o))
      problems.push({
        rect: intersect(rect, o),
        gapCm: 0,
        requiredCm: 0,
        message: 'Sobreposto a outro móvel. Dois móveis no mesmo lugar só no desenho.',
        severity: 'erro',
      });
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > l.widthCm || rect.y + rect.d > l.depthCm)
    problems.push({
      rect,
      gapCm: 0,
      requiredCm: 0,
      message: 'Fora das paredes. A parede não vai abrir espaço sozinha.',
      severity: 'erro',
    });
  const sides: { name: string; band: (g: number) => Rect; limit: number }[] = [
    { name: 'norte', band: (g) => ({ x: rect.x, y: rect.y - g, w: rect.w, d: g }), limit: rect.y },
    {
      name: 'sul',
      band: (g) => ({ x: rect.x, y: rect.y + rect.d, w: rect.w, d: g }),
      limit: l.depthCm - (rect.y + rect.d),
    },
    { name: 'oeste', band: (g) => ({ x: rect.x - g, y: rect.y, w: g, d: rect.d }), limit: rect.x },
    {
      name: 'leste',
      band: (g) => ({ x: rect.x + rect.w, y: rect.y, w: g, d: rect.d }),
      limit: l.widthCm - (rect.x + rect.w),
    },
  ];
  const frontSide = { 0: 'sul', 180: 'norte', 90: 'oeste', 270: 'leste' }[rotation] ?? 'sul';
  for (const s of sides) {
    // Distância até o obstáculo mais próximo naquele lado (ou a parede).
    let gap = s.limit;
    for (const o of others) {
      if (overlaps(rect, o)) continue;
      const probe = s.band(Math.max(0, s.limit));
      if (!overlaps(probe, o)) continue;
      const d =
        s.name === 'norte'
          ? rect.y - (o.y + o.d)
          : s.name === 'sul'
            ? o.y - (rect.y + rect.d)
            : s.name === 'oeste'
              ? rect.x - (o.x + o.w)
              : o.x - (rect.x + rect.w);
      if (d >= 0) gap = Math.min(gap, d);
    }
    if (gap <= 0 || gap >= SOFA_PASSAGE_CM) {
      if (s.name === frontSide && frontClearCm > 0 && gap < frontClearCm && gap >= 0)
        problems.push(frontProblem(s.band(Math.max(gap, 5)), gap, frontClearCm));
      continue;
    }
    // Vão encostado na parede (até 15 cm) é só "encostado", não um corredor.
    if (gap <= 15 && gap === s.limit) continue;
    if (s.name === frontSide && frontClearCm > 0 && gap < frontClearCm) {
      problems.push(frontProblem(s.band(gap), gap, frontClearCm));
      continue;
    }
    problems.push({
      rect: s.band(gap),
      gapCm: Math.round(gap),
      requiredCm: SOFA_PASSAGE_CM,
      message:
        gap < PERSON_PASSAGE_CM
          ? `Vão de ${Math.round(gap)} cm ao ${s.name}: nem gente passa direito. Nem de lado.`
          : `Vão de ${Math.round(gap)} cm ao ${s.name}: desse jeito o sofá vai precisar passar de lado (pede ${SOFA_PASSAGE_CM} cm).`,
      severity: gap < PERSON_PASSAGE_CM ? 'erro' : 'aviso',
    });
  }
  return problems;
}

function frontProblem(rect: Rect, gap: number, need: number): ClearanceProblem {
  return {
    rect,
    gapCm: Math.round(gap),
    requiredCm: need,
    message: `Frente de trabalho com ${Math.round(gap)} cm; o ideal são ${need} cm. Quem trabalha aqui vai encolher a barriga.`,
    severity: 'aviso',
  };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(1, Math.min(a.x + a.w, b.x + b.w) - x),
    d: Math.max(1, Math.min(a.y + a.d, b.y + b.d) - y),
  };
}

/** Todos os problemas de passagem da planta inteira (painel "Verificar planta"). */
export function layoutProblems(l: LayoutContent) {
  const out: (ClearanceProblem & { objectId: string; objectName: string })[] = [];
  for (const s of l.stations)
    for (const p of clearanceAround(
      l,
      s.id,
      footprint(s),
      catalogOf(s.kind).frontClearCm,
      s.rotation,
    ))
      out.push({ ...p, objectId: s.id, objectName: s.name });
  for (const u of l.storageUnits)
    for (const p of clearanceAround(
      l,
      u.id,
      footprint(u),
      catalogOf(u.kind).frontClearCm,
      u.rotation,
    ))
      out.push({ ...p, objectId: u.id, objectName: u.label });
  return out;
}

// ───────────────────────────── Posição representada da peça ─────────────────────────────

export interface PlacementTask {
  id: string;
  activity: string;
  status: string;
  assigneeUserId: string | null;
}

export type PlacementKind = 'ESTACAO' | 'FILA' | 'AGUARDANDO_ETAPA' | 'AREA' | 'SEM_PLANEJAMENTO';

export interface Placement {
  kind: PlacementKind;
  stationId: string | null;
  areaId: string | null;
  areaFunction: AreaFunction;
  userId: string | null;
  taskId: string | null;
  label: string;
}

const RUNNING = ['EM_EXECUCAO', 'PAUSADA'];
const WAITING = ['LIBERADA', 'PROGRAMADA', 'BLOQUEADA'];

/** Estação do funcionário para a etapa (vínculo + etapa; depois só vínculo; depois só etapa). */
export function stationFor(
  l: Pick<LayoutContent, 'stations' | 'areas'>,
  userId: string | null,
  activity: string,
): StationDef | null {
  const fn = ACTIVITY_AREA[activity] ?? 'MONTAGEM';
  const serves = (s: StationDef) => s.activities.length === 0 || s.activities.includes(activity);
  const inArea = (s: StationDef) => l.areas.find((a) => a.id === s.areaId)?.function === fn;
  const mine = userId ? l.stations.filter((s) => s.assigneeUserIds.includes(userId)) : [];
  return (
    mine.find((s) => serves(s) && s.activities.length > 0) ??
    mine.find((s) => serves(s) && inArea(s)) ??
    l.stations.find((s) => s.shared && s.activities.includes(activity)) ??
    l.stations.find((s) => s.activities.includes(activity) && s.assigneeUserIds.length === 0) ??
    mine.find(serves) ??
    l.stations.find((s) => inArea(s)) ??
    null
  );
}

const areaByFunction = (l: Pick<LayoutContent, 'areas'>, fn: AreaFunction) =>
  l.areas.find((a) => a.function === fn) ?? null;

/**
 * Onde a peça aparece no mapa, a partir SÓ dos registros: tarefa em execução → estação de quem
 * iniciou; próxima tarefa com responsável → fila dessa pessoa; etapa de qualidade/embalagem/
 * expedição → área correspondente; nada planejado → recebimento/espera.
 */
export function placePiece(
  l: Pick<LayoutContent, 'stations' | 'areas'>,
  input: { stage: string; tasks: PlacementTask[]; names?: Record<string, string> },
): Placement {
  const name = (u: string | null) => (u ? (input.names?.[u] ?? 'responsável') : 'sem responsável');
  const active = input.tasks.filter((t) => t.status !== 'CANCELADA' && t.status !== 'RASCUNHO');
  const running = active.find((t) => RUNNING.includes(t.status));
  const at = (
    fn: AreaFunction,
    kind: PlacementKind,
    label: string,
    extra: Partial<Placement> = {},
  ) => {
    const area = areaByFunction(l, fn) ?? areaByFunction(l, 'ESPERA') ?? l.areas[0] ?? null;
    return {
      kind,
      stationId: null,
      areaId: area?.id ?? null,
      areaFunction: (area?.function ?? fn) as AreaFunction,
      userId: null,
      taskId: null,
      label,
      ...extra,
    } satisfies Placement;
  };
  const stageArea = STAGE_AREA[input.stage];
  if (stageArea && !running) {
    const lbl: Record<string, string> = {
      AGUARDANDO_INSPECAO: 'Aguardando inspeção',
      EM_INSPECAO: 'Em inspeção',
      EM_CORRECAO: 'Em correção',
      AGUARDANDO_EMBALAGEM: 'Aguardando embalagem',
      EM_EMBALAGEM: 'Em embalagem',
      BLOQUEIO_EXPEDICAO: 'Expedição bloqueada',
      PRONTA_ENTREGA: 'Pronta para entrega',
      ENTREGA_AGENDADA: 'Entrega agendada',
      EM_TRANSPORTE: 'Em transporte',
    };
    return at(stageArea, 'AREA', lbl[input.stage] ?? input.stage);
  }
  if (running) {
    const st = stationFor(l, running.assigneeUserId, running.activity);
    const label = `${running.status === 'PAUSADA' ? 'Pausado' : 'Em execução'} · ${ACTIVITY_LABEL_GAME[running.activity] ?? running.activity} com ${name(running.assigneeUserId)}`;
    if (st)
      return {
        kind: 'ESTACAO',
        stationId: st.id,
        areaId: st.areaId ?? null,
        areaFunction:
          l.areas.find((a) => a.id === st.areaId)?.function ??
          ACTIVITY_AREA[running.activity] ??
          'MONTAGEM',
        userId: running.assigneeUserId,
        taskId: running.id,
        label,
      };
    return at(ACTIVITY_AREA[running.activity] ?? 'MONTAGEM', 'AREA', label, {
      userId: running.assigneeUserId,
      taskId: running.id,
    });
  }
  const done = active.filter((t) => t.status === 'CONCLUIDA');
  const next = active.find((t) => WAITING.includes(t.status) && t.assigneeUserId);
  if (next && next.status !== 'BLOQUEADA') {
    const st = stationFor(l, next.assigneeUserId, next.activity);
    return {
      kind: 'FILA',
      stationId: st?.id ?? null,
      areaId: st?.areaId ?? areaByFunction(l, 'ESPERA')?.id ?? null,
      areaFunction: (l.areas.find((a) => a.id === st?.areaId)?.function ??
        'ESPERA') as AreaFunction,
      userId: next.assigneeUserId,
      taskId: next.id,
      label: `Na fila de ${name(next.assigneeUserId)} · ${ACTIVITY_LABEL_GAME[next.activity] ?? next.activity}${next.status === 'PROGRAMADA' ? ' (programada)' : ''}`,
    };
  }
  if (done.length && active.length > done.length) {
    const pending = active.find((t) => !['CONCLUIDA'].includes(t.status));
    return at(
      'ESPERA',
      'AGUARDANDO_ETAPA',
      `Aguardando a etapa seguinte${pending ? `: ${ACTIVITY_LABEL_GAME[pending.activity] ?? pending.activity}` : ''}`,
      {
        taskId: pending?.id ?? null,
        userId: pending?.assigneeUserId ?? null,
      },
    );
  }
  if (next)
    return at(
      'ESPERA',
      'AGUARDANDO_ETAPA',
      `Aguardando liberação · ${ACTIVITY_LABEL_GAME[next.activity] ?? next.activity} com ${name(next.assigneeUserId)}`,
      {
        taskId: next.id,
        userId: next.assigneeUserId,
      },
    );
  if (done.length && done.length === active.length)
    return at('QUALIDADE', 'AREA', 'Produção concluída');
  if (input.tasks.some((t) => t.status === 'RASCUNHO'))
    return at('RECEBIMENTO', 'SEM_PLANEJAMENTO', 'Planejada · aguardando publicação da semana');
  return at('RECEBIMENTO', 'SEM_PLANEJAMENTO', 'Aguardando planejamento');
}

/** Modelo 3D por categoria (a partir do tipo da peça e da descrição). */
export type FurnitureModel =
  | 'SOFA'
  | 'SOFA_RETRATIL'
  | 'SOFA_CANTO'
  | 'POLTRONA'
  | 'CADEIRA'
  | 'CABECEIRA'
  | 'PUFE'
  | 'BANCO'
  | 'COLCHAO'
  | 'OUTRO';

export function furnitureModel(pieceType: string, description = ''): FurnitureModel {
  const d = description.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (pieceType === 'SOFA' || pieceType === 'CANTO_ALEMAO') {
    if (/retrat|reclin/.test(d)) return 'SOFA_RETRATIL';
    if (/canto|chaise|em l\b|l\s?shape/.test(d) || pieceType === 'CANTO_ALEMAO')
      return 'SOFA_CANTO';
    return 'SOFA';
  }
  const known = ['POLTRONA', 'CADEIRA', 'CABECEIRA', 'PUFE', 'BANCO', 'COLCHAO'] as const;
  return (known as readonly string[]).includes(pieceType) ? (pieceType as FurnitureModel) : 'OUTRO';
}

/** Prontidão de materiais → semáforo do jogo (vermelho falta, verde disponível, "A conferir"). */
export type MaterialTone = 'FALTA' | 'DISPONIVEL' | 'A_CONFERIR';
export function materialTone(readiness: string | null | undefined): MaterialTone {
  if (readiness === 'COMPLETO') return 'DISPONIVEL';
  if (!readiness || readiness === 'SEM_LEVANTAMENTO' || readiness === 'AGUARDANDO_APROVACAO')
    return 'A_CONFERIR';
  return 'FALTA';
}
export const MATERIAL_TONE_LABEL: Record<MaterialTone, string> = {
  FALTA: 'Material faltante',
  DISPONIVEL: 'Material disponível',
  A_CONFERIR: 'A conferir',
};

// ───────────────────────────── Plantas iniciais ─────────────────────────────

let seq = 0;
/** Gerador de ids (uuid v4) — usa crypto quando disponível. */
export function newGameId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  seq++;
  const hex = (n: number) =>
    Math.floor(Math.random() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(8)}${(seq % 65536).toString(16).padStart(4, '0')}`;
}

export interface TeamHint {
  userId: string;
  displayName: string;
}

const station = (
  kind: StationKind,
  name: string,
  area: AreaDef | undefined,
  xCm: number,
  yCm: number,
  opts: Partial<StationDef> = {},
): StationDef => {
  const c = STATION_KINDS[kind] as CatalogEntry;
  return {
    id: newGameId(),
    kind,
    name,
    areaId: area?.id ?? null,
    xCm,
    yCm,
    wCm: c.wCm,
    dCm: c.dCm,
    rotation: 0,
    activities: [...(c.activities ?? [])],
    shared: false,
    assigneeUserIds: [],
    ...opts,
  };
};

export function storageUnit(
  kind: StorageKind,
  label: string,
  area: AreaDef | undefined,
  xCm: number,
  yCm: number,
  rotation: Rotation = 0,
): StorageUnitDef {
  const c = STORAGE_KINDS[kind] as CatalogEntry;
  return {
    id: newGameId(),
    kind,
    label,
    areaId: area?.id ?? null,
    xCm,
    yCm,
    wCm: c.wCm,
    dCm: c.dCm,
    rotation,
    slots: Array.from({ length: c.levels ?? 1 }, (_, i) => ({
      id: newGameId(),
      label: `${c.slotWord ?? 'Posição'} ${i + 1}`,
      level: i + 1,
      stockItemIds: [],
    })),
  };
}

const area = (
  fn: AreaFunction,
  xCm: number,
  yCm: number,
  wCm: number,
  dCm: number,
  name?: string,
): AreaDef => ({
  id: newGameId(),
  function: fn,
  name: name ?? AREA_FUNCTION_LABEL[fn],
  xCm,
  yCm,
  wCm,
  dCm,
  color: AREA_FUNCTION_COLOR[fn],
  itemLocationId: null,
});

/**
 * Tapeçaria sugerida: 15 m × 12 m = 180 m². Fluxo em "U": recebimento (sul-oeste) → desmanche →
 * marcenaria/corte/costura (norte) → montagem (centro) → qualidade → embalagem → expedição (sul-
 * leste), com estoque a nordeste e corredor central livre. MEDIDAS ILUSTRATIVAS.
 */
export function suggestedWorkshop(team: TeamHint[] = []): LayoutContent {
  const W = 1500;
  const D = 1200;
  const user = (n: string) => team.find((t) => t.displayName === n)?.userId;
  const ids = (...n: string[]) => n.map(user).filter((x): x is string => Boolean(x));
  // Bancadas com nome da pessoa só quando ela existe na equipe (outras empresas: nome genérico).
  const benchOf = (n: string, fallback: string) => (user(n) ? `Bancada do ${n}` : fallback);
  const A = {
    marcenaria: area('MARCENARIA', 0, 0, 400, 380),
    corte: area('CORTE', 400, 0, 450, 380),
    costura: area('COSTURA', 850, 0, 350, 380),
    estoque: area('ESTOQUE', 1200, 0, 300, 520),
    desmanche: area('DESMANCHE', 0, 380, 400, 400),
    montagem: area('MONTAGEM', 400, 480, 600, 340),
    qualidade: area('QUALIDADE', 1000, 520, 260, 300),
    embalagem: area('EMBALAGEM', 1260, 520, 240, 300),
    recebimento: area('RECEBIMENTO', 0, 780, 400, 420),
    espera: area('ESPERA', 400, 900, 500, 300, 'Espera entre etapas'),
    expedicao: area('EXPEDICAO', 900, 900, 600, 300),
  };
  const stations: StationDef[] = [
    station('BANCADA_MARCENARIA', 'Bancada de marcenaria', A.marcenaria, 60, 60, { shared: true }),
    station('MESA_CORTE', 'Mesa de corte', A.corte, 470, 60, { shared: true }),
    station('MAQUINA_COSTURA', 'Máquina de costura 1', A.costura, 900, 60, {
      assigneeUserIds: ids('Márcio'),
    }),
    station('MAQUINA_COSTURA', 'Máquina de costura 2', A.costura, 1050, 60, {
      assigneeUserIds: ids('Ricardo'),
    }),
    station('BANCADA_DESMANCHE', 'Bancada do desmanche', A.desmanche, 60, 440, {
      assigneeUserIds: ids('João'),
    }),
    station(
      'BANCADA_TAPECEIRO',
      benchOf('Ricardo', 'Bancada de tapeçaria 1'),
      A.montagem,
      440,
      520,
      {
        assigneeUserIds: ids('Ricardo'),
      },
    ),
    station(
      'BANCADA_TAPECEIRO',
      benchOf('Márcio', 'Bancada de tapeçaria 2'),
      A.montagem,
      720,
      520,
      {
        assigneeUserIds: ids('Márcio'),
      },
    ),
    station('MESA_INSPECAO', 'Mesa de inspeção', A.qualidade, 1030, 560, {
      assigneeUserIds: ids('Thiago'),
      activities: ['ACABAMENTO', 'CORRECAO'],
    }),
    station('MESA_EMBALAGEM', 'Mesa de embalagem', A.embalagem, 1270, 560, {
      wCm: 200,
      shared: true,
      assigneeUserIds: ids('João', 'Thiago'),
    }),
  ];
  const storageUnits: StorageUnitDef[] = [
    storageUnit('SUPORTE_ROLOS', 'Suporte de tecidos', A.estoque, 1240, 20),
    storageUnit('ESTANTE', 'Estante A', A.estoque, 1240, 190),
    storageUnit('ESTANTE', 'Estante B', A.estoque, 1240, 330),
    storageUnit('GAVETEIRO', 'Gaveteiro de ferragens', A.estoque, 1420, 190, 270),
    storageUnit('ESTRADO_ESPUMA', 'Estrado de espumas', A.corte, 620, 250),
  ];
  return {
    name: 'Tapeçaria',
    kind: 'OFICINA',
    widthCm: W,
    depthCm: D,
    gridCm: 50,
    illustrative: true,
    doc: {
      walls: [],
      doors: [
        { id: newGameId(), wall: 'S', offsetCm: 80, widthCm: 300, label: 'Portão de recebimento' },
        { id: newGameId(), wall: 'S', offsetCm: 1100, widthCm: 300, label: 'Portão de expedição' },
        {
          id: newGameId(),
          wall: 'O',
          offsetCm: 150,
          widthCm: 100,
          label: 'Escritório',
          toSpaceKey: 'ESCRITORIO',
        },
      ],
      decor: [
        {
          id: newGameId(),
          kind: 'PALETE',
          name: 'Palete de chegada',
          xCm: 60,
          yCm: 880,
          wCm: 120,
          dCm: 100,
          rotation: 0,
        },
        {
          id: newGameId(),
          kind: 'LIXEIRA',
          name: 'Retalhos',
          xCm: 330,
          yCm: 700,
          wCm: 50,
          dCm: 50,
          rotation: 0,
        },
        {
          id: newGameId(),
          kind: 'QUADRO',
          name: 'Quadro da semana',
          xCm: 560,
          yCm: 5,
          wCm: 120,
          dCm: 10,
          rotation: 0,
        },
      ],
      notes:
        'Planta sugerida com medidas e posições ilustrativas (~180 m²). Ajuste pelas medidas reais da oficina.',
    },
    areas: Object.values(A),
    stations,
    storageUnits,
  };
}

/** Escritório sugerido: 8 m × 6 m, quatro mesas (duas com agentes) e mesa de reunião. */
export function suggestedOffice(): LayoutContent {
  const esc = area('ESCRITORIO', 0, 0, 560, 600, 'Escritório');
  const reu = area('REUNIAO', 560, 0, 240, 600, 'Reunião');
  const desk = (name: string, x: number, y: number) => station('MESA_ESCRITORIO', name, esc, x, y);
  return {
    name: 'Escritório',
    kind: 'ESCRITORIO',
    widthCm: 800,
    depthCm: 600,
    gridCm: 50,
    illustrative: true,
    doc: {
      walls: [],
      doors: [
        {
          id: newGameId(),
          wall: 'L',
          offsetCm: 250,
          widthCm: 100,
          label: 'Tapeçaria',
          toSpaceKey: 'TAPECARIA',
        },
      ],
      decor: [
        {
          id: newGameId(),
          kind: 'PLANTA',
          name: 'Planta',
          xCm: 20,
          yCm: 530,
          wCm: 50,
          dCm: 50,
          rotation: 0,
        },
        {
          id: newGameId(),
          kind: 'BEBEDOURO',
          name: 'Bebedouro',
          xCm: 500,
          yCm: 20,
          wCm: 40,
          dCm: 40,
          rotation: 0,
        },
        {
          id: newGameId(),
          kind: 'SOFA_ESPERA',
          name: 'Sofá do cliente',
          xCm: 60,
          yCm: 470,
          wCm: 200,
          dCm: 90,
          rotation: 180,
        },
      ],
      notes: 'Escritório sugerido (medidas ilustrativas).',
    },
    areas: [esc, reu],
    stations: [
      desk('Mesa 1 · Gerente', 60, 60),
      desk('Mesa 2 · Compras', 300, 60),
      desk('Mesa 3', 60, 250),
      desk('Mesa 4', 300, 250),
      station('MESA_REUNIAO', 'Mesa de reunião', reu, 560, 240, { wCm: 110, dCm: 220 }),
      station('QUADRO_METAS', 'Quadro de Metas', esc, 270, 565, { rotation: 180 }),
    ],
    storageUnits: [storageUnit('ARMARIO', 'Arquivo', esc, 450, 480, 180)],
  };
}

export function blankLayout(
  name: string,
  kind: SpaceKind,
  widthCm: number,
  depthCm: number,
): LayoutContent {
  return {
    name,
    kind,
    widthCm,
    depthCm,
    gridCm: 50,
    illustrative: false,
    doc: {
      walls: [],
      doors: [{ id: newGameId(), wall: 'S', offsetCm: 50, widthCm: 120, label: 'Entrada' }],
      decor: [],
    },
    areas: [],
    stations: [],
    storageUnits: [],
  };
}

// ───────────────────────────── Impacto da remoção ─────────────────────────────

export interface RemovalImpact {
  kind: 'AREA' | 'ESTACAO' | 'ARMAZENAGEM' | 'POSICAO';
  id: string;
  name: string;
  /** O que depende do objeto removido. */
  links: string[];
  /** Destinos possíveis para transferir os vínculos. */
  targets: { id: string; name: string }[];
}

/** Compara a planta salva com a nova e lista remoções com vínculos (pedem destino). */
export function removalImpacts(
  before: LayoutContent,
  after: LayoutContent,
  live: { pieceCountByArea?: Record<string, number>; agentByDesk?: Record<string, string> } = {},
): RemovalImpact[] {
  const out: RemovalImpact[] = [];
  const keptAreas = new Set(after.areas.map((a) => a.id));
  const keptStations = new Set(after.stations.map((s) => s.id));
  const afterSlots = new Set(after.storageUnits.flatMap((u) => u.slots.map((s) => s.id)));
  const slotTargets = after.storageUnits.flatMap((u) =>
    u.slots.map((s) => ({ id: s.id, name: `${u.label} → ${s.label}` })),
  );
  for (const a of before.areas) {
    if (keptAreas.has(a.id)) continue;
    const links: string[] = [];
    const st = after.stations.filter((s) => s.areaId === a.id);
    if (st.length) links.push(`${st.length} estação(ões) nesta área`);
    const un = after.storageUnits.filter((u) => u.areaId === a.id);
    if (un.length) links.push(`${un.length} móvel(is) de estoque`);
    if (a.itemLocationId) links.push('Localização física das peças (registro de onde a peça está)');
    const pieces = live.pieceCountByArea?.[a.id] ?? 0;
    if (pieces) links.push(`${pieces} peça(s) de OS representada(s) aqui`);
    if (links.length)
      out.push({
        kind: 'AREA',
        id: a.id,
        name: a.name,
        links,
        targets: after.areas.map((x) => ({ id: x.id, name: x.name })),
      });
  }
  for (const s of before.stations) {
    if (keptStations.has(s.id)) continue;
    const links: string[] = [];
    if (s.assigneeUserIds.length)
      links.push(`${s.assigneeUserIds.length} funcionário(s) vinculado(s)`);
    if (live.agentByDesk?.[s.id]) links.push(`Agente ${live.agentByDesk[s.id]} nesta mesa`);
    if (links.length)
      out.push({
        kind: 'ESTACAO',
        id: s.id,
        name: s.name,
        links,
        targets: after.stations
          .filter((x) => x.kind === s.kind || (catalogOf(x.kind).desk && catalogOf(s.kind).desk))
          .map((x) => ({ id: x.id, name: x.name })),
      });
  }
  for (const u of before.storageUnits)
    for (const sl of u.slots) {
      if (afterSlots.has(sl.id) || !sl.stockItemIds.length) continue;
      out.push({
        kind: 'POSICAO',
        id: sl.id,
        name: `${u.label} → ${sl.label}`,
        links: [`${sl.stockItemIds.length} material(is) endereçado(s)`],
        targets: slotTargets,
      });
    }
  return out;
}

/** Endereço legível de uma posição de estoque (Estoque → Estante A → Prateleira 2). */
export function slotAddress(
  spaceName: string,
  areaName: string | null,
  unitLabel: string,
  slotLabel: string,
) {
  return [spaceName, areaName, unitLabel, slotLabel].filter(Boolean).join(' → ');
}
