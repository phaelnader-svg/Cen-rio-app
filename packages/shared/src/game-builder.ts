/**
 * Mestre de Obras — assistente do modo Construção (regras puras, sem rede).
 *
 * Lê a planta atual (medidas em cm), entende pedidos comuns de uma tapeçaria e devolve:
 * frases curtas (com humor leve), uma PRÉVIA aplicável (estações/áreas novas ou movidas,
 * redimensionamento) e marcações no mapa (local sugerido, caminho livre, gargalos).
 * Nada é salvo aqui: o editor aplica a prévia ao rascunho, a pessoa ajusta e salva.
 */
import {
  AREA_FUNCTION_COLOR,
  AREA_FUNCTION_LABEL,
  type AreaDef,
  type AreaFunction,
  type ClearanceProblem,
  type GridPoint,
  type LayoutContent,
  type Rect,
  type Rotation,
  SOFA_PASSAGE_CM,
  PERSON_PASSAGE_CM,
  STATION_KINDS,
  type StationDef,
  type StationKind,
  buildGrid,
  catalogOf,
  center,
  clearanceAround,
  contains,
  doorCenter,
  findPath,
  footprint,
  frontRect,
  nearestFree,
  newGameId,
  obstaclesOf,
  overlaps,
  pathLengthCm,
  rectOfArea,
} from './game-domain';

export interface LayoutPatch {
  addStations?: StationDef[];
  moveStations?: { id: string; xCm: number; yCm: number; rotation: Rotation }[];
  addAreas?: AreaDef[];
  updateAreas?: AreaDef[];
  resize?: { widthCm: number; depthCm: number };
}

export interface MestreSuggestion {
  title: string;
  patch: LayoutPatch;
  highlights: Rect[];
  path?: GridPoint[];
  problems: ClearanceProblem[];
}

export interface MestreReply {
  lines: string[];
  suggestion?: MestreSuggestion;
  quickReplies: string[];
  /** Abre outro painel após aplicar (ex.: configurar agente). */
  followUp?: 'CONFIGURAR_AGENTE' | 'VINCULAR_FUNCIONARIO';
}

export const MESTRE_QUICK = [
  'Contratei mais um tapeceiro. Onde posso montar a bancada dele?',
  'Onde faz mais sentido colocar a mesa de corte perto da costura?',
  'Mudei para um escritório maior. Como encaixo mais quatro mesas?',
  'Quero criar uma área de marcenaria e deixar um caminho livre até a expedição.',
  'Quero mais um agente para compras. Como coloco a mesa e configuro a função?',
  'Verifique as passagens da planta.',
];

const NUMBERS: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export function numberIn(text: string): number | null {
  const t = norm(text);
  const d = /(\d+)\s*(mesas|bancadas|estacoes|agentes|lugares)?/.exec(t);
  if (d) return Number(d[1]);
  for (const [w, n] of Object.entries(NUMBERS))
    if (new RegExp(`\\bmais\\s+${w}\\b|\\b${w}\\s+(mesas|bancadas|estacoes|agentes)`).test(t)) return n;
  return null;
}

// ───────────────────────────── Busca de espaço ─────────────────────────────

export interface SpotRequest {
  wCm: number;
  dCm: number;
  frontClearCm: number;
  /** Área preferida (o lugar sugerido fica dentro dela, se couber). */
  prefer?: Rect | null;
  /** Ponto de interesse (aproxima a sugestão). */
  near?: { x: number; y: number } | null;
  ignoreId?: string;
  /** Obstáculos adicionais (outras sugestões já feitas nesta mesma prévia). */
  extra?: Rect[];
  /** Mantém o caminho principal (portas) com passagem de sofá. */
  keepMainPath?: boolean;
  rotations?: Rotation[];
}

export interface Spot {
  rect: Rect;
  rotation: Rotation;
  score: number;
  inPreferred: boolean;
}

/** Porta de entrada e de saída (expedição) usadas como eixo do fluxo da oficina. */
export function mainDoors(l: LayoutContent) {
  const ext = l.doc.doors.filter((d) => ['N', 'S', 'L', 'O'].includes(d.wall) && !d.toSpaceKey);
  const exp = l.areas.find((a) => a.function === 'EXPEDICAO');
  const rec = l.areas.find((a) => a.function === 'RECEBIMENTO');
  const dist = (d: (typeof ext)[number], a?: AreaDef) => {
    const c = doorCenter(l, d);
    if (!c || !a) return Infinity;
    const m = center(rectOfArea(a));
    return Math.hypot(c.x - m.x, c.y - m.y);
  };
  const entry = [...ext].sort((a, b) => dist(a, rec) - dist(b, rec))[0] ?? null;
  const exit = [...ext].filter((d) => d !== entry).sort((a, b) => dist(a, exp) - dist(b, exp))[0] ?? entry;
  return { entry, exit };
}

const inward = (l: LayoutContent, p: { x: number; y: number }) => ({
  x: Math.min(l.widthCm - 30, Math.max(30, p.x)),
  y: Math.min(l.depthCm - 30, Math.max(30, p.y)),
});

/** Caminho de sofá entre a entrada e a expedição (ou null se não passa). */
export function sofaRoute(l: LayoutContent, extra: Rect[] = [], ignore?: ReadonlySet<string>) {
  const { entry, exit } = mainDoors(l);
  if (!entry || !exit) return null;
  const a = doorCenter(l, entry);
  const b = doorCenter(l, exit);
  if (!a || !b) return null;
  const g = buildGrid(l, { inflateCm: SOFA_PASSAGE_CM / 2 - 5, extra, ignore });
  const s = nearestFree(g, inward(l, a));
  const t = nearestFree(g, inward(l, b));
  if (!s || !t) return null;
  return findPath(g, s, t);
}

/** Onde o caminho de sofá trava: trechos do caminho de pessoa que o sofá não consegue usar. */
export function chokepoints(l: LayoutContent, extra: Rect[] = []): Rect[] {
  const { entry, exit } = mainDoors(l);
  if (!entry || !exit) return [];
  const a = doorCenter(l, entry);
  const b = doorCenter(l, exit);
  if (!a || !b) return [];
  const person = buildGrid(l, { inflateCm: PERSON_PASSAGE_CM / 2 - 5, extra });
  const sofa = buildGrid(l, { inflateCm: SOFA_PASSAGE_CM / 2 - 5, extra });
  const s = nearestFree(person, inward(l, a));
  const t = nearestFree(person, inward(l, b));
  if (!s || !t) return [];
  const p = findPath(person, s, t);
  if (!p) return [];
  const out: Rect[] = [];
  for (let i = 1; i < p.length; i++) {
    const from = p[i - 1]!;
    const to = p[i]!;
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / sofa.cell);
    for (let k = 0; k <= steps; k++) {
      const x = from.x + ((to.x - from.x) * k) / Math.max(1, steps);
      const y = from.y + ((to.y - from.y) * k) / Math.max(1, steps);
      const cx = Math.floor(x / sofa.cell);
      const cy = Math.floor(y / sofa.cell);
      if (sofa.blocked[cy * sofa.cols + cx])
        out.push({ x: cx * sofa.cell - 25, y: cy * sofa.cell - 25, w: sofa.cell + 50, d: sofa.cell + 50 });
    }
  }
  return mergeRects(out);
}

function mergeRects(rs: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rs) {
    const m = out.find((o) => overlaps(o, r, 1));
    if (m) {
      const x = Math.min(m.x, r.x);
      const y = Math.min(m.y, r.y);
      m.w = Math.max(m.x + m.w, r.x + r.w) - x;
      m.d = Math.max(m.y + m.d, r.y + r.d) - y;
      m.x = x;
      m.y = y;
    } else out.push({ ...r });
  }
  return out;
}

export function findSpots(l: LayoutContent, req: SpotRequest, limit = 3): Spot[] {
  const obstacles = [
    ...obstaclesOf(l, req.ignoreId ? new Set([req.ignoreId]) : undefined),
    ...(req.extra ?? []),
  ];
  const step = Math.max(10, Math.min(25, l.gridCm / 2));
  const candidates: Spot[] = [];
  const rotations = req.rotations ?? [0, 180, 90, 270];
  const space: Rect = { x: 0, y: 0, w: l.widthCm, d: l.depthCm };
  for (const rotation of rotations) {
    const turned = rotation === 90 || rotation === 270;
    const w = turned ? req.dCm : req.wCm;
    const d = turned ? req.wCm : req.dCm;
    for (let y = 0; y + d <= l.depthCm; y += step)
      for (let x = 0; x + w <= l.widthCm; x += step) {
        const rect = { x, y, w, d };
        if (obstacles.some((o) => overlaps(rect, o, 40))) continue;
        const front = frontRect(
          { xCm: x, yCm: y, wCm: req.wCm, dCm: req.dCm, rotation } as StationDef,
          req.frontClearCm,
        );
        if (!contains(space, front)) continue;
        if (obstacles.some((o) => overlaps(front, o))) continue;
        const inPreferred = req.prefer ? contains(req.prefer, rect) : false;
        const c = center(rect);
        const nearD = req.near ? Math.hypot(c.x - req.near.x, c.y - req.near.y) : 0;
        // Encostar na parede ou no limite da área preferida é bom (libera o miolo).
        const wallHug =
          Math.min(x, y, l.widthCm - (x + w), l.depthCm - (y + d)) <= 20 ? -60 : 0;
        const prefD = req.prefer ? Math.hypot(c.x - center(req.prefer).x, c.y - center(req.prefer).y) : 0;
        const score = (inPreferred ? 0 : 400 + prefD) + nearD + wallHug;
        candidates.push({ rect, rotation, score, inPreferred });
      }
  }
  candidates.sort((a, b) => a.score - b.score);
  const out: Spot[] = [];
  for (const c of candidates) {
    if (out.some((o) => overlaps(o.rect, c.rect, 50))) continue;
    if (req.keepMainPath && !sofaRoute(l, [...(req.extra ?? []), c.rect], req.ignoreId ? new Set([req.ignoreId]) : undefined))
      continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

function stationAt(kind: StationKind, name: string, spot: Spot, areaId: string | null, extra: Partial<StationDef> = {}): StationDef {
  const c = STATION_KINDS[kind];
  return {
    id: newGameId(),
    kind,
    name,
    areaId,
    xCm: Math.round(spot.rect.x),
    yCm: Math.round(spot.rect.y),
    wCm: c.wCm,
    dCm: c.dCm,
    rotation: spot.rotation,
    activities: [...(('activities' in c ? c.activities : []) as readonly string[])],
    shared: false,
    assigneeUserIds: [],
    ...extra,
  };
}

const areaOf = (l: LayoutContent, fn: AreaFunction) => l.areas.find((a) => a.function === fn) ?? null;
const m = (cm: number) => `${(cm / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} m`;

// ───────────────────────────── Intenções ─────────────────────────────

function newUpholsterer(l: LayoutContent): MestreReply {
  const mont = areaOf(l, 'MONTAGEM');
  const cost = areaOf(l, 'COSTURA');
  const c = STATION_KINDS.BANCADA_TAPECEIRO;
  const spots = findSpots(l, {
    wCm: c.wCm,
    dCm: c.dCm,
    frontClearCm: c.frontClearCm,
    prefer: mont ? rectOfArea(mont) : null,
    near: cost ? center(rectOfArea(cost)) : null,
    keepMainPath: true,
  });
  if (!spots.length)
    return {
      lines: [
        'Procurei e não achei 2,0 × 1,0 m com 90 cm de frente sem travar o caminho dos sofás.',
        'Ou a gente aumenta a oficina, ou alguém vai trabalhar no corredor. Não recomendo.',
        'Tente: mover a espera para perto da expedição ou reduzir uma área.',
      ],
      quickReplies: ['Verifique as passagens da planta.'],
    };
  const best = spots[0]!;
  const st = stationAt('BANCADA_TAPECEIRO', 'Bancada nova (tapeceiro)', best, best.inPreferred ? (mont?.id ?? null) : null);
  return {
    lines: [
      best.inPreferred
        ? `Cabe na ${mont?.name ?? 'montagem'}: bancada de ${m(c.wCm)} × ${m(c.dCm)} com ${c.frontClearCm} cm de frente livre.`
        : `Na montagem não cabe sem apertar. Achei um canto fora dela${mont ? `, a ${(Math.round(Math.hypot(center(best.rect).x - center(rectOfArea(mont)).x, center(best.rect).y - center(rectOfArea(mont)).y) / 10) / 10).toLocaleString('pt-BR')} m de lá` : ''}.`,
      'O caminho do portão até a expedição continua passando sofá de frente.',
      'Depois de aplicar, vincule a bancada ao novo tapeceiro (cadastro em Funcionários).',
      spots.length > 1 ? `Tenho mais ${spots.length - 1} opção(ões) marcada(s) em tracejado.` : 'Só achei essa. A oficina está cheia de boas ideias.',
    ],
    suggestion: {
      title: 'Bancada para o novo tapeceiro',
      patch: { addStations: [st] },
      highlights: spots.map((s) => s.rect),
      path: sofaRoute(l, [best.rect]) ?? undefined,
      problems: [],
    },
    quickReplies: ['Verifique as passagens da planta.'],
    followUp: 'VINCULAR_FUNCIONARIO',
  };
}

function cutNearSewing(l: LayoutContent): MestreReply {
  const cut = l.stations.find((s) => s.kind === 'MESA_CORTE');
  const cost = areaOf(l, 'COSTURA');
  if (!cost)
    return {
      lines: ['Não achei a área de costura. Crie a área (Áreas → Costura) e eu ajudo a encaixar o corte.'],
      quickReplies: [],
    };
  const sewing = l.stations.filter((s) => s.kind === 'MAQUINA_COSTURA');
  const target = sewing.length
    ? center(sewing.map(footprint).reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), d: Math.max(a.y + a.d, b.y + b.d) - Math.min(a.y, b.y) })))
    : center(rectOfArea(cost));
  const c = STATION_KINDS.MESA_CORTE;
  const corte = areaOf(l, 'CORTE');
  const spots = findSpots(l, {
    wCm: cut?.wCm ?? c.wCm,
    dCm: cut?.dCm ?? c.dCm,
    frontClearCm: c.frontClearCm,
    near: target,
    prefer: corte ? rectOfArea(corte) : rectOfArea(cost),
    ignoreId: cut?.id,
    keepMainPath: true,
  });
  if (!spots.length)
    return { lines: ['A mesa de corte é grandona (3 × 1,6 m). Não achei vão perto da costura. Libere um pedaço da área ao lado.'], quickReplies: [] };
  const best = spots[0]!;
  const dist = Math.round(Math.hypot(center(best.rect).x - target.x, center(best.rect).y - target.y) / 10) / 10;
  const before = cut ? Math.round(Math.hypot(center(footprint(cut)).x - target.x, center(footprint(cut)).y - target.y) / 10) / 10 : null;
  return {
    lines: [
      'Corte e costura são vizinhos de porta: o tecido cortado vai direto para a máquina.',
      `Sugestão: mesa de corte a ${dist.toLocaleString('pt-BR')} m das máquinas${before !== null ? ` (hoje está a ${before.toLocaleString('pt-BR')} m)` : ''}.`,
      'Deixe o lado comprido livre: é por ali que o rolo de tecido abre.',
    ],
    suggestion: {
      title: cut ? 'Mover a mesa de corte para perto da costura' : 'Nova mesa de corte perto da costura',
      patch: cut
        ? { moveStations: [{ id: cut.id, xCm: Math.round(best.rect.x), yCm: Math.round(best.rect.y), rotation: best.rotation }] }
        : { addStations: [stationAt('MESA_CORTE', 'Mesa de corte', best, corte?.id ?? null, { shared: true })] },
      highlights: spots.map((s) => s.rect),
      path: sofaRoute(l, [best.rect], cut ? new Set([cut.id]) : undefined) ?? undefined,
      problems: [],
    },
    quickReplies: ['Verifique as passagens da planta.'],
  };
}

function moreDesks(l: LayoutContent, text: string): MestreReply {
  const n = Math.min(20, numberIn(text) ?? 4);
  const c = STATION_KINDS.MESA_ESCRITORIO;
  // Cada mesa ocupa a mesa + 90 cm de cadeira atrás + 60 cm de circulação.
  const perDesk = (c.wCm + 40) * (c.dCm + 90 + 60);
  let work: LayoutContent = l;
  let resize: LayoutPatch['resize'] | undefined;
  const placeAll = (layout: LayoutContent) => {
    const placed: StationDef[] = [];
    const extra: Rect[] = [];
    const esc = areaOf(layout, 'ESCRITORIO');
    for (let i = 0; i < n; i++) {
      const s = findSpots(layout, {
        wCm: c.wCm,
        dCm: c.dCm,
        frontClearCm: c.frontClearCm,
        prefer: esc ? rectOfArea(esc) : null,
        extra,
        rotations: [0, 180],
      }, 1)[0];
      if (!s) break;
      extra.push(s.rect, frontRect({ xCm: s.rect.x, yCm: s.rect.y, wCm: c.wCm, dCm: c.dCm, rotation: s.rotation } as StationDef, c.frontClearCm));
      placed.push(stationAt('MESA_ESCRITORIO', `Mesa ${layout.stations.filter((x) => x.kind === 'MESA_ESCRITORIO').length + i + 1}`, s, esc?.id ?? null));
    }
    return placed;
  };
  let placed = placeAll(work);
  if (placed.length < n) {
    // Cresce a sala para o sul (as áreas encostadas no fundo crescem junto), de 50 em 50 cm.
    for (let grow = 50; grow <= 1500 && placed.length < n; grow += 50) {
      resize = { widthCm: l.widthCm, depthCm: l.depthCm + grow };
      work = {
        ...l,
        ...resize,
        areas: l.areas.map((a) => (a.yCm + a.dCm >= l.depthCm ? { ...a, dCm: a.dCm + grow } : a)),
      };
      placed = placeAll(work);
    }
  }
  const lines = [
    `Cada mesa pede uns ${(perDesk / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m² contando cadeira e corredor.`,
    resize
      ? `Na sala atual (${m(l.widthCm)} × ${m(l.depthCm)}) não cabem ${n}. Com ${m(resize.widthCm)} × ${m(resize.depthCm)} cabem — e ninguém senta no colo de ninguém.`
      : `Cabem ${placed.length} mesa(s) na sala atual, com 90 cm para a cadeira.`,
    'Uma mesa pode ficar vazia; depois é só colocar um agente ou uma pessoa nela.',
  ];
  if (placed.length < n) lines.push(`Só consegui ${placed.length}. Acima disso, vale outro ambiente.`);
  return {
    lines,
    suggestion: {
      title: `Encaixar ${placed.length} mesa(s)${resize ? ' em sala maior' : ''}`,
      patch: {
        addStations: placed,
        ...(resize ? { resize, updateAreas: work.areas.filter((a) => a.yCm + a.dCm > l.depthCm) } : {}),
      },
      highlights: placed.map(footprint),
      problems: [],
    },
    quickReplies: ['Quero mais um agente para compras. Como coloco a mesa e configuro a função?'],
  };
}

function carpentryWithPath(l: LayoutContent): MestreReply {
  const existing = areaOf(l, 'MARCENARIA');
  const exp = areaOf(l, 'EXPEDICAO');
  const lines: string[] = [];
  let newArea: AreaDef | null = null;
  let areaRect: Rect;
  if (existing) {
    areaRect = rectOfArea(existing);
    lines.push(`Já existe ${existing.name} (${m(existing.wCm)} × ${m(existing.dCm)}). Vou só conferir o caminho.`);
  } else {
    // Área de 3,5 × 3 m num canto livre, longe do corredor principal.
    const spot = findSpots(l, { wCm: 350, dCm: 300, frontClearCm: 0, keepMainPath: true }, 1)[0];
    if (!spot)
      return {
        lines: [
          'Marcenaria pede uns 3,5 × 3 m (bancada + serra + MDF encostado).',
          'Hoje não há esse vão sem tirar alguém do lugar. Quer aumentar a oficina ou reduzir uma área?',
        ],
        quickReplies: ['Verifique as passagens da planta.'],
      };
    areaRect = spot.rect;
    newArea = {
      id: newGameId(),
      function: 'MARCENARIA',
      name: 'Marcenaria',
      xCm: Math.round(spot.rect.x),
      yCm: Math.round(spot.rect.y),
      wCm: Math.round(spot.rect.w),
      dCm: Math.round(spot.rect.d),
      color: AREA_FUNCTION_COLOR.MARCENARIA,
      itemLocationId: null,
    };
    lines.push('Reservei 3,5 × 3 m para a marcenaria, encostada onde não atrapalha o fluxo.');
  }
  // Bancada dentro da área nova.
  const b = STATION_KINDS.BANCADA_MARCENARIA;
  const benchSpot = findSpots(l, { wCm: b.wCm, dCm: b.dCm, frontClearCm: b.frontClearCm, prefer: areaRect }, 1)[0];
  const bench = benchSpot && contains(areaRect, benchSpot.rect)
    ? stationAt('BANCADA_MARCENARIA', 'Bancada de marcenaria', benchSpot, newArea?.id ?? existing?.id ?? null, { shared: true })
    : null;
  // Caminho de sofá da marcenaria até a expedição.
  const extra = bench ? [footprint(bench)] : [];
  const g = buildGrid(l, { inflateCm: SOFA_PASSAGE_CM / 2 - 5, extra });
  const from = nearestFree(g, center(areaRect));
  const to = exp ? nearestFree(g, center(rectOfArea(exp))) : null;
  const path = from && to ? findPath(g, from, to) : null;
  const problems: ClearanceProblem[] = [];
  if (!exp) lines.push('Não há área de expedição. Crie uma e eu traço o caminho.');
  else if (path) {
    lines.push(`Caminho livre de ${m(pathLengthCm(path))} até a ${exp.name}, com ${SOFA_PASSAGE_CM} cm de largura: estrutura pronta passa de frente.`);
  } else {
    const chokes = chokepoints(l, extra);
    for (const r of chokes)
      problems.push({ rect: r, gapCm: 0, requiredCm: SOFA_PASSAGE_CM, message: 'Aqui a estrutura entala.', severity: 'erro' });
    lines.push('O caminho até a expedição trava. Marquei os gargalos em vermelho: algo precisa andar uns palmos.');
  }
  return {
    lines,
    suggestion: {
      title: newArea ? 'Área de marcenaria com caminho até a expedição' : 'Caminho da marcenaria até a expedição',
      patch: { addAreas: newArea ? [newArea] : [], addStations: bench && !l.stations.some((s) => s.kind === 'BANCADA_MARCENARIA') ? [bench] : [] },
      highlights: [areaRect],
      path: path ?? undefined,
      problems,
    },
    quickReplies: ['Verifique as passagens da planta.'],
  };
}

function agentDesk(l: LayoutContent, text: string): MestreReply {
  const role = /compra/.test(norm(text)) ? 'Compras' : /gerent/.test(norm(text)) ? 'Gerente' : 'novo agente';
  if (l.kind !== 'ESCRITORIO')
    return {
      lines: [
        'Agente trabalha no escritório. Entre no Escritório (porta oeste) e me pergunte de novo lá.',
        'Na oficina ele ia ficar coberto de pó de espuma.',
      ],
      quickReplies: [],
    };
  const empty = l.stations.filter((s) => s.kind === 'MESA_ESCRITORIO' && /^Mesa \d+$/.test(s.name));
  if (empty.length)
    return {
      lines: [
        `Já tem mesa sobrando: ${empty[0]!.name}. Não precisa comprar móvel.`,
        `Clique nela no modo Gestão → "Colocar agente" → função ${role}.`,
        'Defina o que ele pode ler (estoque, compras, OS) e o que só pode PROPOR. Comprar mesmo, só com sua aprovação.',
      ],
      suggestion: { title: `Mesa para o agente de ${role}`, patch: {}, highlights: [footprint(empty[0]!)], problems: [] },
      quickReplies: [],
      followUp: 'CONFIGURAR_AGENTE',
    };
  const reply = moreDesks(l, 'mais uma mesa');
  const desk = reply.suggestion?.patch.addStations?.[0];
  if (desk) desk.name = `Mesa · ${role}`;
  return {
    ...reply,
    lines: [
      `Vou pôr uma mesa para o agente de ${role}.`,
      ...reply.lines.slice(1, 2),
      'Depois de salvar: clique na mesa (modo Gestão) → "Colocar agente" → escolha a função, as instruções e os dados que ele pode consultar.',
      'Ações de compra ficam como PROPOSTA até você aprovar.',
    ],
    followUp: 'CONFIGURAR_AGENTE',
  };
}

function checkPassages(l: LayoutContent): MestreReply {
  const problems: ClearanceProblem[] = [];
  for (const s of l.stations)
    problems.push(...clearanceAround(l, s.id, footprint(s), catalogOf(s.kind).frontClearCm, s.rotation));
  for (const u of l.storageUnits)
    problems.push(...clearanceAround(l, u.id, footprint(u), catalogOf(u.kind).frontClearCm, u.rotation));
  const route = l.kind === 'OFICINA' ? sofaRoute(l) : null;
  const chokes = l.kind === 'OFICINA' && !route ? chokepoints(l) : [];
  for (const r of chokes)
    problems.push({ rect: r, gapCm: 0, requiredCm: SOFA_PASSAGE_CM, message: 'Gargalo no caminho do sofá.', severity: 'erro' });
  const errors = problems.filter((p) => p.severity === 'erro').length;
  const warns = problems.length - errors;
  const lines = [
    problems.length
      ? `Achei ${errors} problema(s) sério(s) e ${warns} aperto(s). Marquei tudo no mapa.`
      : 'Planta sem apertos. Pode até passar um sofá de canto dançando.',
  ];
  if (l.kind === 'OFICINA')
    lines.push(
      route
        ? `Caminho do portão à expedição: ${m(pathLengthCm(route))}, passando sofá de frente.`
        : 'Do portão à expedição o sofá não passa de frente. Os gargalos estão em vermelho.',
    );
  const worst = problems.find((p) => p.severity === 'erro') ?? problems[0];
  if (worst) lines.push(worst.message);
  return {
    lines,
    suggestion: { title: 'Verificação de passagens', patch: {}, highlights: [], path: route ?? undefined, problems },
    quickReplies: problems.length ? ['Contratei mais um tapeceiro. Onde posso montar a bancada dele?'] : [],
  };
}

function tutorial(l: LayoutContent): MestreReply {
  return {
    lines: [
      'Sou o Mestre de Obras. Medida aqui é em centímetro, sem chute.',
      'Arrastar: clique e puxe o móvel. Girar: R. Duplicar: D. Remover: Delete. Desfazer: Ctrl+Z.',
      'Planta: em "Ambiente" você muda largura e profundidade da sala; portas ficam em "Portas".',
      `Esta sala tem ${m(l.widthCm)} × ${m(l.depthCm)} (${Math.round((l.widthCm * l.depthCm) / 10000)} m²)${l.illustrative ? ', com medidas ainda ilustrativas — confira com a trena' : ''}.`,
      'Peça algo como os exemplos abaixo e eu marco o lugar no mapa.',
    ],
    quickReplies: MESTRE_QUICK,
  };
}

/** Responde a um pedido em linguagem natural com base na planta atual. */
export function askMestre(l: LayoutContent, text: string): MestreReply {
  const t = norm(text);
  if (/agente/.test(t)) return agentDesk(l, text);
  if (/corte/.test(t) && /costura/.test(t)) return cutNearSewing(l);
  if (/marcenaria/.test(t)) return carpentryWithPath(l);
  if (/mesa/.test(t) && (/escritorio|maior|encaix|mais/.test(t) || l.kind === 'ESCRITORIO')) return moreDesks(l, text);
  if (/tapeceir|contrat|costureir|bancada|funcionari|ajudante/.test(t)) return newUpholsterer(l);
  if (/caminho|passag|corredor|aperto|verific|confer/.test(t)) return checkPassages(l);
  return tutorial(l);
}

/** Frase curta para o problema mais grave ao posicionar um objeto (dica ao arrastar). */
export function dragTip(problems: ClearanceProblem[]): string | null {
  const p = problems.find((x) => x.severity === 'erro') ?? problems[0];
  if (!p) return null;
  return `${p.message} Quer ver onde sobra mais espaço?`;
}

export { AREA_FUNCTION_LABEL };
