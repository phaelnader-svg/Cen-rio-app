/**
 * Modelos 3D procedurais do jogo (sem arquivos externos): identidade própria da Cenário —
 * piso de madeira clara, paredes em verde petróleo, detalhes em bronze, peças "de feltro".
 * Unidades em metros; a origem de cada móvel é o canto noroeste do retângulo ocupado no chão.
 */
import { drawIcon, iconOf, splitIcon } from './icons';
import * as THREE from 'three';
import type { FurnitureModel } from '@cenario/shared';

const mats = new Map<string, THREE.MeshStandardMaterial>();
export function mat(
  color: string,
  opts: { rough?: number; metal?: number; emissive?: string; opacity?: number } = {},
) {
  const key = `${color}|${opts.rough ?? 0.85}|${opts.metal ?? 0}|${opts.emissive ?? ''}|${opts.opacity ?? 1}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.85,
      metalness: opts.metal ?? 0,
      flatShading: true,
      ...(opts.emissive
        ? { emissive: new THREE.Color(opts.emissive), emissiveIntensity: 0.6 }
        : {}),
      ...(opts.opacity !== undefined && opts.opacity < 1
        ? { transparent: true, opacity: opts.opacity }
        : {}),
    });
    mats.set(key, m);
  }
  return m;
}

export const PALETTE = {
  floor: '#e9dcc4',
  floorLine: '#d6c6a8',
  wall: '#2f6f68',
  wallTop: '#1d4a45',
  wallLow: '#3f7d75',
  wood: '#b98a5a',
  woodDark: '#8d5f31',
  metal: '#7b8a8a',
  steel: '#cfd6d6',
  bronze: '#a8743f',
  foam: '#f2e3a4',
  cardboard: '#c9a26b',
  skin: ['#f1c7a5', '#d9a47c', '#a86f4c', '#7a4a2e'],
  ink: '#1d2523',
};

const box = (
  w: number,
  h: number,
  d: number,
  color: string | THREE.Material,
  x = 0,
  y = 0,
  z = 0,
) => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    typeof color === 'string' ? mat(color) : color,
  );
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};
const cyl = (r: number, h: number, color: string, x = 0, y = 0, z = 0, seg = 10) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat(color));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  return m;
};

/** Grupo centrado: os filhos são posicionados a partir do centro do retângulo (w × d). */
function centered(w: number, d: number) {
  const outer = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.set(w / 2, 0, d / 2);
  outer.add(inner);
  return { outer, inner };
}

function legs(g: THREE.Group, w: number, d: number, h: number, color = PALETTE.woodDark, t = 0.06) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) g.add(box(t, h, t, color, sx * (w / 2 - t), 0, sz * (d / 2 - t)));
}

function table(
  g: THREE.Group,
  w: number,
  d: number,
  h: number,
  top = PALETTE.wood,
  legColor = PALETTE.woodDark,
) {
  legs(g, w, d, h - 0.05, legColor);
  g.add(box(w, 0.05, d, top, 0, h - 0.05, 0));
}

/** Cor de tecido estável a partir de um texto (código da OS). */
export function fabricColor(seed: string) {
  const colors = [
    '#8c5a4a',
    '#5f7f6e',
    '#6d6a8f',
    '#9b7b52',
    '#4f6f86',
    '#a0574f',
    '#7b8656',
    '#8a6f8c',
  ];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length]!;
}

/**
 * Cor do tecido a partir do texto da OS ("Linho cinza", "Veludo azul marinho", "Couro"…).
 * Sem cor reconhecível, cai na cor estável pelo código.
 */
export function fabricColorFor(fabric: string | null | undefined, seed: string) {
  const t = (fabric ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const table: [RegExp, string][] = [
    [/marinho/, '#2f4560'],
    [/azul/, '#4f6f86'],
    [/verde|musgo|oliva/, '#5f7f6e'],
    [/vermelh|vinho|bordo|marsala/, '#8e3b3b'],
    [/rosa|rose/, '#c98b95'],
    [/mostarda|amarel|ocre/, '#c99a3a'],
    [/laranja|terracota|ferrugem/, '#b8643f'],
    [/roxo|lilas|violeta/, '#6d6a8f'],
    [/grafite|chumbo/, '#4a4f52'],
    [/cinza|gelo/, '#8a8f8c'],
    [/preto|negro/, '#33302e'],
    [/branco|off|cru/, '#e8e2d6'],
    [/bege|areia|linho|nude|creme/, '#cbb894'],
    [/caramelo|conhaque|whisky/, '#a0673a'],
    [/marrom|cafe|chocolate|tabaco|couro/, '#6b4a33'],
  ];
  for (const [re, c] of table) if (re.test(t)) return c;
  return fabricColor(seed);
}

/**
 * Como a peça aparece conforme a etapa da produção: chega usada (ANTIGA), é desmontada, fica só na
 * estrutura, recebe espuma, ganha a capa nova e sai embalada.
 */
export type BuildStage = 'ANTIGA' | 'DESMONTADA' | 'ESTRUTURA' | 'ESPUMA' | 'CAPA' | 'EMBALADA';

const FRAME = '#d6b384';
const FOAM = '#f2e3a4';

// ───────────────────────────── Móveis em produção (por categoria) ─────────────────────────────

export function furniture(model: FurnitureModel, color: string, stage: BuildStage = 'CAPA') {
  const g = new THREE.Group();
  const old = new THREE.Color(color).lerp(new THREE.Color('#8b8378'), 0.55).getStyle();
  const base =
    stage === 'ESTRUTURA' || stage === 'DESMONTADA'
      ? FRAME
      : stage === 'ESPUMA'
        ? FOAM
        : stage === 'ANTIGA'
          ? old
          : color;
  const fabric = mat(base, { rough: stage === 'ESTRUTURA' || stage === 'DESMONTADA' ? 0.8 : 1 });
  const cushion = mat(
    stage === 'ESPUMA'
      ? '#f7ecbd'
      : new THREE.Color(stage === 'ANTIGA' || stage === 'DESMONTADA' ? old : base)
          .offsetHSL(0, -0.05, 0.08)
          .getStyle(),
    { rough: 1 },
  );
  /** Almofadas soltas: na estrutura não existem; desmontada, ficam no chão ao lado. */
  const withCushions = stage !== 'ESTRUTURA';
  const add = (
    w: number,
    h: number,
    d: number,
    m: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const isCushion = m === cushion;
    if (isCushion && !withCushions) return;
    const b = box(w, h, d, m, x, y, z);
    if (isCushion) b.userData.cushion = true;
    g.add(b);
  };
  // Estrutura de madeira: travessas vazadas em vez de blocos cheios.
  const frameBox = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    if (stage !== 'ESTRUTURA' && stage !== 'DESMONTADA') return add(w, h, d, fabric, x, y, z);
    const t = 0.05;
    const m = mat(FRAME, { rough: 0.8 });
    for (const sy of [y, y + h - t]) {
      g.add(box(w, t, t, m, x, sy, z - d / 2 + t / 2));
      g.add(box(w, t, t, m, x, sy, z + d / 2 - t / 2));
      g.add(box(t, t, d, m, x - w / 2 + t / 2, sy, z));
      g.add(box(t, t, d, m, x + w / 2 - t / 2, sy, z));
    }
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        g.add(box(t, h, t, m, x + sx * (w / 2 - t / 2), y, z + sz * (d / 2 - t / 2)));
    if (w > 0.6) g.add(box(t, h, t, m, x, y, z - d / 2 + t / 2));
  };
  const sofa = (w: number, d: number, seats: number) => {
    frameBox(w, 0.18, d, 0, 0.08, 0);
    if (stage === 'ESTRUTURA' || stage === 'DESMONTADA') {
      // Percintas (elásticos) no assento.
      for (let i = 0; i < 5; i++)
        g.add(
          box(0.05, 0.01, d - 0.1, mat('#3f4a4f'), -w / 2 + 0.2 + (i * (w - 0.4)) / 4, 0.25, 0),
        );
    }
    for (let i = 0; i < seats; i++) {
      const sw = (w - 0.3) / seats;
      add(sw - 0.03, 0.14, d - 0.3, cushion, -w / 2 + 0.15 + sw * (i + 0.5), 0.26, 0.08);
      add(sw - 0.03, 0.42, 0.16, cushion, -w / 2 + 0.15 + sw * (i + 0.5), 0.26, -d / 2 + 0.2);
    }
    frameBox(0.15, 0.5, d, -w / 2 + 0.075, 0.08, 0);
    frameBox(0.15, 0.5, d, w / 2 - 0.075, 0.08, 0);
    frameBox(w, 0.6, 0.12, 0, 0.08, -d / 2 + 0.06);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        g.add(cyl(0.025, 0.08, PALETTE.woodDark, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), 6));
  };
  switch (model) {
    case 'SOFA':
      sofa(2.0, 0.9, 3);
      break;
    case 'SOFA_RETRATIL':
      sofa(2.2, 1.0, 3);
      // Assento retrátil puxado para frente.
      add(2.2 - 0.3, 0.12, 0.45, cushion, 0, 0.12, 0.6);
      break;
    case 'SOFA_CANTO': {
      sofa(2.2, 0.9, 3);
      const chaise = new THREE.Group();
      chaise.add(box(0.9, 0.18, 1.0, fabric, 0, 0.08, 0));
      if (withCushions) chaise.add(box(0.84, 0.14, 0.95, cushion, 0, 0.26, 0));
      chaise.add(box(0.15, 0.5, 1.0, fabric, 0.375, 0.08, 0));
      chaise.position.set(0.65, 0, 0.95);
      g.add(chaise);
      break;
    }
    case 'POLTRONA':
      frameBox(0.85, 0.2, 0.85, 0, 0.12, 0);
      add(0.55, 0.14, 0.6, cushion, 0, 0.32, 0.08);
      frameBox(0.15, 0.45, 0.85, -0.35, 0.12, 0);
      frameBox(0.15, 0.45, 0.85, 0.35, 0.12, 0);
      frameBox(0.85, 0.75, 0.15, 0, 0.12, -0.35);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          g.add(cyl(0.025, 0.12, PALETTE.woodDark, sx * 0.35, 0, sz * 0.35, 6));
      break;
    case 'CADEIRA':
      add(0.48, 0.06, 0.48, cushion, 0, 0.45, 0);
      add(0.48, 0.5, 0.05, mat(PALETTE.wood), 0, 0.5, -0.22);
      legs(g, 0.48, 0.48, 0.45);
      break;
    case 'CABECEIRA':
      frameBox(1.6, 1.1, 0.12, 0, 0.1, 0);
      for (let i = 0; i < 4; i++) add(0.36, 0.95, 0.06, cushion, -0.6 + i * 0.4, 0.17, 0.08);
      add(0.08, 0.12, 0.08, mat(PALETTE.woodDark), -0.7, 0, 0);
      add(0.08, 0.12, 0.08, mat(PALETTE.woodDark), 0.7, 0, 0);
      break;
    case 'PUFE':
      if (stage === 'ESTRUTURA' || stage === 'DESMONTADA') frameBox(0.55, 0.42, 0.55, 0, 0, 0);
      else g.add(cyl(0.3, 0.42, stage === 'ESPUMA' ? FOAM : base, 0, 0, 0, 14));
      break;
    case 'BANCO':
      add(1.4, 0.1, 0.4, cushion, 0, 0.42, 0);
      legs(g, 1.4, 0.4, 0.42);
      break;
    case 'COLCHAO':
      add(1.4, 0.25, 1.9, stage === 'ESTRUTURA' ? fabric : cushion, 0, 0.05, 0);
      break;
    default:
      add(0.8, 0.5, 0.6, fabric, 0, 0.05, 0);
      add(0.85, 0.06, 0.65, mat(PALETTE.steel, { opacity: 0.6 }), 0, 0.55, 0);
  }
  if (stage === 'DESMONTADA') {
    // Capa velha arrancada, amontoada no chão, e almofadas encostadas.
    const [w, d] = FURNITURE_SIZE[model];
    const heap = mat(old, { rough: 1 });
    g.add(box(0.5, 0.08, 0.4, heap, w / 2 + 0.25, 0, d / 2 - 0.1));
    g.add(box(0.36, 0.06, 0.3, heap, w / 2 + 0.3, 0.08, d / 2 - 0.12));
    const loose = g.children.filter((o) => o.userData.cushion);
    loose.forEach((c, i) => {
      if (i >= 2) return void g.remove(c);
      c.position.set(-w / 2 - 0.25, 0.08 + i * 0.16, -d / 2 + 0.3 + i * 0.05);
      c.rotation.set(0, 0.3 * i, 0);
    });
  }
  if (stage === 'EMBALADA') {
    // Plástico bolha, cantoneiras de papelão e fita.
    const bb = new THREE.Box3().setFromObject(g);
    const size = bb.getSize(new THREE.Vector3());
    const c = bb.getCenter(new THREE.Vector3());
    const wrap = new THREE.Mesh(
      new THREE.BoxGeometry(size.x + 0.06, size.y + 0.04, size.z + 0.06),
      new THREE.MeshStandardMaterial({
        color: '#e9f3f7',
        transparent: true,
        opacity: 0.45,
        roughness: 0.25,
        metalness: 0.05,
        depthWrite: false,
      }),
    );
    wrap.position.set(c.x, size.y / 2 + 0.02, c.z);
    g.add(wrap);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        g.add(
          box(
            0.12,
            size.y + 0.05,
            0.12,
            mat(PALETTE.cardboard),
            c.x + sx * (size.x / 2),
            0,
            c.z + sz * (size.z / 2),
          ),
        );
    g.add(box(size.x + 0.08, 0.05, size.z + 0.08, mat('#c9a26b'), c.x, size.y * 0.55, c.z));
  }
  return g;
}

/** Tamanho no chão de cada categoria (m), para posicionar e não sobrepor. */
export const FURNITURE_SIZE: Record<FurnitureModel, [number, number]> = {
  SOFA: [2.0, 0.9],
  SOFA_RETRATIL: [2.2, 1.3],
  SOFA_CANTO: [2.2, 1.9],
  POLTRONA: [0.85, 0.85],
  CADEIRA: [0.5, 0.5],
  CABECEIRA: [1.6, 0.2],
  PUFE: [0.6, 0.6],
  BANCO: [1.4, 0.4],
  COLCHAO: [1.4, 1.9],
  OUTRO: [0.8, 0.6],
};

// ───────────────────────────── Estações, armazenagem e decoração ─────────────────────────────

export function stationModel(kind: string, w: number, d: number, accent = PALETTE.bronze) {
  const { outer, inner: g } = centered(w, d);
  switch (kind) {
    case 'MESA_CORTE': {
      table(g, w, d, 0.9, '#efe7d6', PALETTE.metal);
      g.add(box(w * 0.9, 0.01, d * 0.7, mat('#c9d6a3'), 0, 0.9, 0));
      const roll = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, d * 0.9, 12),
        mat('#7b8656'),
      );
      roll.rotation.x = Math.PI / 2;
      roll.position.set(-w / 2 + 0.25, 1.0, 0);
      roll.castShadow = true;
      g.add(roll);
      g.add(box(0.5, 0.01, 0.04, mat(PALETTE.steel, { metal: 0.6, rough: 0.3 }), 0.4, 0.91, 0.2));
      break;
    }
    case 'MAQUINA_COSTURA': {
      table(g, w, d, 0.75, PALETTE.wood, PALETTE.metal);
      g.add(box(0.45, 0.12, 0.2, mat('#e8e4dc'), 0, 0.75, 0));
      g.add(box(0.12, 0.25, 0.18, mat('#e8e4dc'), 0.17, 0.87, 0));
      g.add(box(0.4, 0.08, 0.16, mat('#e8e4dc'), 0.0, 1.1, 0));
      g.add(box(0.03, 0.12, 0.03, mat(PALETTE.metal), -0.18, 0.98, 0));
      break;
    }
    case 'BANCADA_MARCENARIA':
      table(g, w, d, 0.9, '#c89b68', PALETTE.woodDark);
      g.add(
        box(0.25, 0.12, 0.2, mat(PALETTE.metal, { metal: 0.5 }), w / 2 - 0.2, 0.9, d / 2 - 0.15),
      );
      g.add(box(1.2, 0.02, 0.6, mat('#d4b48c'), -0.2, 0.9, 0));
      g.add(box(w * 0.9, 0.05, 0.05, mat(PALETTE.woodDark), 0, 0.15, 0));
      break;
    case 'MESA_INSPECAO':
      table(g, w, d, 0.75, '#f3f1ec', PALETTE.metal);
      g.add(cyl(0.02, 0.6, PALETTE.metal, w / 2 - 0.15, 0.75, -d / 2 + 0.15, 6));
      g.add(
        box(
          0.25,
          0.06,
          0.15,
          mat('#fff7d1', { emissive: '#fff1a8' }),
          w / 2 - 0.25,
          1.35,
          -d / 2 + 0.15,
        ),
      );
      g.add(box(0.3, 0.02, 0.22, mat('#b9d3ee'), -0.3, 0.75, 0));
      break;
    case 'MESA_EMBALAGEM':
      table(g, w, d, 0.8, '#e7dcc8', PALETTE.metal);
      g.add(box(0.5, 0.35, 0.4, mat(PALETTE.cardboard), -0.4, 0.8, 0));
      {
        const r = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.12, 0.6, 12),
          mat('#dfe9f0', { opacity: 0.8 }),
        );
        r.rotation.z = Math.PI / 2;
        r.position.set(0.5, 0.92, 0);
        g.add(r);
      }
      break;
    case 'MESA_ESCRITORIO':
      table(g, w, d, 0.75, '#d8c3a5', PALETTE.ink);
      g.add(box(0.5, 0.32, 0.04, mat(PALETTE.ink), 0, 0.8, -d / 2 + 0.12));
      g.add(
        box(0.46, 0.27, 0.01, mat('#1f3a5f', { emissive: '#2c5ea8' }), 0, 0.825, -d / 2 + 0.145),
      );
      g.add(box(0.06, 0.06, 0.06, mat(PALETTE.ink), 0, 0.75, -d / 2 + 0.12));
      g.add(box(0.4, 0.02, 0.14, mat('#e8e4dc'), 0, 0.75, Math.max(0.05, d / 2 - 0.14)));
      // Cadeira giratória na frente (lado sul). O assento fica em OFFICE_SEAT (altura e distância da
      // borda da mesa), o mesmo ponto onde o motor senta o agente.
      {
        const cz = d / 2 + OFFICE_SEAT.depth;
        const top = OFFICE_SEAT.height;
        g.add(box(0.46, 0.07, 0.44, mat('#2f3a40'), 0, top - 0.07, cz));
        g.add(box(0.44, 0.46, 0.06, mat('#2f3a40'), 0, top - 0.02, cz + 0.22));
        g.add(cyl(0.03, top - 0.12, PALETTE.metal, 0, 0.05, cz, 6));
        g.add(box(0.5, 0.04, 0.05, mat(PALETTE.metal), 0, 0.02, cz));
        g.add(box(0.05, 0.04, 0.5, mat(PALETTE.metal), 0, 0.02, cz));
      }
      break;
    case 'QUADRO_METAS': {
      // Quadro em cavalete: moldura, fundo claro e trilho da barra (preenchida pelo motor).
      const legH = 1.9;
      for (const s of [-1, 1])
        g.add(box(0.05, legH, 0.05, mat(PALETTE.woodDark), s * (w / 2 - 0.08), 0, 0));
      g.add(box(w, 1.05, 0.06, mat(PALETTE.woodDark), 0, 0.8, 0));
      g.add(box(w - 0.1, 0.95, 0.02, mat('#fbf7ef'), 0, 0.85, 0.04));
      g.add(box(w - 0.3, 0.12, 0.02, mat('#d9d2c4'), 0, 1.05, 0.055));
      const marks = 3;
      for (let i = 1; i <= marks; i++)
        g.add(
          box(
            0.015,
            0.2,
            0.02,
            mat(PALETTE.ink),
            -(w - 0.3) / 2 + ((w - 0.3) * i) / marks,
            1.0,
            0.06,
          ),
        );
      break;
    }
    case 'MESA_REUNIAO':
      table(g, w, d, 0.75, '#c8a57d', PALETTE.woodDark);
      for (let i = 0; i < 3; i++)
        for (const s of [-1, 1]) {
          const long = w >= d;
          const off = (i - 1) * (long ? w / 3 : d / 3);
          g.add(
            box(
              0.45,
              0.45,
              0.45,
              mat(PALETTE.wallLow),
              long ? off : s * (w / 2 + 0.3),
              0,
              long ? s * (d / 2 + 0.3) : off,
            ),
          );
        }
      break;
    default:
      // Bancadas (tapeceiro, desmanche, livre): tampo acolchoado + prateleira inferior.
      table(g, w, d, 0.85, kind === 'BANCADA_DESMANCHE' ? '#c5a17a' : '#9fb7a6', PALETTE.woodDark);
      g.add(box(w - 0.12, 0.03, d - 0.12, mat(PALETTE.woodDark), 0, 0.25, 0));
      g.add(box(0.3, 0.06, 0.12, mat(accent), w / 2 - 0.3, 0.85, -d / 2 + 0.12));
      g.add(
        box(
          0.15,
          0.03,
          0.04,
          mat(PALETTE.metal, { metal: 0.6 }),
          -w / 2 + 0.3,
          0.85,
          -d / 2 + 0.12,
        ),
      );
  }
  return outer;
}

export function storageModel(
  kind: string,
  w: number,
  d: number,
  levels: number,
  tones: (string | null)[],
) {
  const { outer, inner: g } = centered(w, d);
  const H =
    kind === 'GAVETEIRO'
      ? 1.0
      : kind === 'ESTRADO_ESPUMA'
        ? 0.2
        : kind === 'PRATELEIRA'
          ? 1.6
          : kind === 'ARMARIO'
            ? 1.9
            : 2.0;
  if (kind === 'ESTRADO_ESPUMA') {
    g.add(box(w, 0.12, d, mat(PALETTE.wood), 0, 0, 0));
    const colors = ['#f2e3a4', '#e9d07e', '#f6eccb', '#d9c27a'];
    for (let i = 0; i < 6; i++)
      g.add(box(w * 0.9, 0.18, d * 0.85, mat(colors[i % 4]!), 0, 0.12 + i * 0.19, 0));
    marker(g, tones[0] ?? null, w, d, 1.4);
    return outer;
  }
  if (kind === 'SUPORTE_ROLOS') {
    for (const sx of [-1, 1])
      g.add(box(0.06, 1.8, d, mat(PALETTE.metal, { metal: 0.4 }), sx * (w / 2 - 0.03), 0, 0));
    const colors = ['#8c5a4a', '#5f7f6e', '#6d6a8f', '#9b7b52', '#4f6f86', '#a0574f'];
    for (let lv = 0; lv < levels; lv++) {
      for (let i = 0; i < 2; i++) {
        const r = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.11, w - 0.15, 12),
          mat(colors[(lv * 2 + i) % colors.length]!),
        );
        r.rotation.z = Math.PI / 2;
        r.position.set(0, 0.35 + lv * 0.55, (i - 0.5) * 0.28);
        r.castShadow = true;
        g.add(r);
      }
      slotTone(g, tones[lv] ?? null, w, d, 0.2 + lv * 0.55);
    }
    return outer;
  }
  if (kind === 'GAVETEIRO') {
    g.add(box(w, H, d, mat('#6b7b7b', { metal: 0.3 }), 0, 0, 0));
    for (let i = 0; i < levels; i++) {
      const y = 0.08 + i * ((H - 0.12) / levels);
      g.add(
        box(
          w - 0.08,
          (H - 0.12) / levels - 0.03,
          0.02,
          mat(tones[i] ? toneColor(tones[i]!) : '#8a9a9a'),
          0,
          y,
          d / 2,
        ),
      );
      g.add(box(0.12, 0.02, 0.03, mat(PALETTE.steel), 0, y + 0.06, d / 2 + 0.02));
    }
    return outer;
  }
  if (kind === 'ARMARIO') {
    g.add(box(w, H, d, mat('#d8c3a5'), 0, 0, 0));
    g.add(box(0.01, H - 0.1, 0.01, mat(PALETTE.woodDark), 0, 0.05, d / 2 + 0.005));
    for (let i = 0; i < levels; i++)
      slotTone(g, tones[i] ?? null, w, d, 0.2 + i * ((H - 0.2) / levels));
    return outer;
  }
  // Estante / prateleira: montantes metálicos, prateleiras e caixas.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      g.add(
        box(
          0.04,
          H,
          0.04,
          mat(PALETTE.metal, { metal: 0.5 }),
          sx * (w / 2 - 0.02),
          0,
          sz * (d / 2 - 0.02),
        ),
      );
  for (let lv = 0; lv < levels; lv++) {
    const y = 0.12 + lv * ((H - 0.15) / levels);
    g.add(box(w, 0.03, d, mat('#c8ccc8'), 0, y, 0));
    const n = Math.max(1, Math.floor(w / 0.45));
    for (let i = 0; i < n; i++)
      if ((lv * 7 + i * 3) % 4 !== 0)
        g.add(
          box(
            0.34,
            0.22,
            d * 0.75,
            mat(i % 2 ? PALETTE.cardboard : '#b98f5c'),
            -w / 2 + 0.25 + i * ((w - 0.3) / Math.max(1, n - 1 || 1)),
            y + 0.03,
            0,
          ),
        );
    slotTone(g, tones[lv] ?? null, w, d, y);
  }
  return outer;
}

function toneColor(t: string) {
  return t === 'FALTA' ? '#b42323' : t === 'BAIXO' ? '#d08a16' : '#1f7a46';
}
/** Faixa colorida na frente de cada prateleira (vermelho falta, âmbar baixo, verde ok). */
function slotTone(g: THREE.Group, tone: string | null, w: number, d: number, y: number) {
  if (!tone) return;
  g.add(
    box(
      w * 0.96,
      0.04,
      0.015,
      mat(toneColor(tone), { emissive: toneColor(tone) }),
      0,
      y,
      d / 2 + 0.01,
    ),
  );
}
function marker(g: THREE.Group, tone: string | null, w: number, d: number, y: number) {
  if (!tone) return;
  g.add(
    box(
      0.15,
      0.15,
      0.15,
      mat(toneColor(tone), { emissive: toneColor(tone) }),
      w / 2 - 0.1,
      y,
      d / 2 - 0.1,
    ),
  );
}

export function decorModel(kind: string, w: number, d: number) {
  const { outer, inner: g } = centered(w, d);
  switch (kind) {
    case 'SOFA_ESPERA': {
      const s = furniture('SOFA', '#2f6f68');
      s.scale.set(w / 2, 1, d / 0.9);
      g.add(s);
      break;
    }
    case 'PLANTA':
      g.add(cyl(0.18, 0.35, '#a8743f', 0, 0, 0, 10));
      {
        const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), mat('#4f7d4a'));
        leaf.position.y = 0.75;
        leaf.castShadow = true;
        g.add(leaf);
      }
      break;
    case 'PALETE':
      for (let i = 0; i < 3; i++)
        g.add(box(w, 0.04, 0.12, mat('#b98a5a'), 0, 0.1, -d / 2 + 0.1 + i * ((d - 0.2) / 2)));
      for (let i = 0; i < 5; i++)
        g.add(box(0.12, 0.02, d, mat('#c89b68'), -w / 2 + 0.06 + i * ((w - 0.12) / 4), 0.14, 0));
      break;
    case 'LIXEIRA':
      g.add(cyl(0.22, 0.65, '#3f7d75', 0, 0, 0, 10));
      break;
    case 'QUADRO':
      g.add(box(w, 0.8, 0.04, mat('#f6f1e4'), 0, 1.0, 0));
      g.add(box(w + 0.05, 0.05, 0.06, mat(PALETTE.bronze), 0, 1.8, 0));
      break;
    case 'BALCAO':
      g.add(box(w, 1.0, d, mat('#d8c3a5'), 0, 0, 0));
      g.add(box(w + 0.05, 0.04, d + 0.05, mat(PALETTE.bronze), 0, 1.0, 0));
      break;
    case 'BEBEDOURO':
      g.add(box(0.35, 0.9, 0.35, mat('#e8e4dc'), 0, 0, 0));
      g.add(cyl(0.14, 0.3, '#9fd3f0', 0, 0.9, 0, 10));
      break;
    case 'CADEIRA':
      g.add(furniture('CADEIRA', '#3f7d75'));
      break;
    default:
      g.add(box(w, 0.5, d, mat('#cccccc'), 0, 0, 0));
  }
  return outer;
}

// ───────────────────────────── Personagens ─────────────────────────────

export type AvatarStyle = 'PESSOA' | 'JOGADOR' | 'AGENTE' | 'MESTRE' | 'CLIENTE';

/** Assento da cadeira da mesa de escritório: altura do assento (m) e distância da borda da mesa (m). */
export const OFFICE_SEAT = { height: 0.42, depth: 0.42 };
/** Altura do quadril do personagem em pé (m). As pernas giram a partir daqui. */
export const HIP_HEIGHT = 0.45;
/** Metade da espessura da coxa: sentado, o quadril fica isso acima do assento. */
export const THIGH_HALF = 0.07;

const HAIR = ['#3a2a20', '#1f1a17', '#6b4423', '#2b2235', '#8a5a2b', '#b8875a', '#5b5b5b'];

/** Número estável a partir de um texto (nome, id). */
export function hashOf(seed: string | number) {
  if (typeof seed === 'number') return Math.abs(Math.floor(seed));
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Aparência escolhida pela pessoa para o próprio boneco ("Você"). */
export interface AvatarLook {
  /** Índice em PALETTE.skin. */
  skin: number;
  /** 0 curto, 1 comprido, 2 coque, 3 boné, 4 raspado com barba. */
  hairStyle: number;
  hairColor: string;
  shirt: string;
  pants: string;
}
export const HAIR_STYLES = ['Curto', 'Comprido', 'Coque', 'Boné', 'Raspado com barba'] as const;
export const HAIR_COLORS = HAIR;
export const SHIRT_COLORS = [
  '#a8743f',
  '#1f4e79',
  '#2f6b4f',
  '#7a2e3a',
  '#4b3f72',
  '#c25b2a',
  '#3a3f4a',
  '#d9d4c7',
];
export const PANTS_COLORS = ['#3a3f4a', '#2d3b45', '#4a6688', '#5a4632', '#1d2523', '#6b6f58'];

export interface AvatarOptions {
  /** Aparência escolhida (substitui a variação automática pelo nome). */
  look?: AvatarLook | null;
  /** Nome para o crachá (inicial) e para variar rosto e cabelo. */
  name?: string;
  /** Funções do funcionário (cargo): define avental/uniforme. */
  roles?: string[];
}

/**
 * Personagem em blocos. Pernas e braços são articulados (quadril, joelho, ombro), então o mesmo
 * modelo anda, senta, digita e trabalha. Os nomes legL/legR/kneeL/kneeR/armL/armR/head/toolR são
 * usados pelo motor. Rosto, cabelo, pele, uniforme e crachá variam por pessoa (estáveis pelo nome).
 * Nenhuma peça encosta face com face em outra (evita o "piscar" de superfícies sobrepostas).
 */
export function avatar(
  color: string,
  style: AvatarStyle = 'PESSOA',
  seed: string | number = 0,
  opts: AvatarOptions = {},
) {
  const g = new THREE.Group();
  const h = hashOf(opts.name ?? seed);
  const look = opts.look ?? null;
  const skin = look
    ? (PALETTE.skin[look.skin] ?? PALETTE.skin[0]!)
    : PALETTE.skin[h % PALETTE.skin.length]!;
  const hair = look ? look.hairColor : HAIR[(h >>> 3) % HAIR.length]!;
  // 0 curto, 1 comprido, 2 coque, 3 boné, 4 raspado + barba
  const hairStyle = look ? look.hairStyle % 5 : (h >>> 6) % 5;
  const roles = (opts.roles ?? []).join(' ').toLowerCase();
  const workshop = style === 'PESSOA';
  const shirt = style === 'MESTRE' ? '#e76f1a' : (look?.shirt ?? color);
  const pants = look
    ? look.pants
    : style === 'AGENTE'
      ? '#3b2f63'
      : style === 'JOGADOR'
        ? '#3a3f4a'
        : (h >>> 9) % 2
          ? '#2d3b45'
          : '#37475a';
  const shoes = (h >>> 11) % 3 === 0 ? '#5a3a24' : '#1d2523';
  for (const [side, sx] of [
    ['L', -0.08],
    ['R', 0.08],
  ] as const) {
    const leg = new THREE.Group();
    leg.name = `leg${side}`;
    leg.position.set(sx, HIP_HEIGHT, 0);
    leg.add(box(0.12, 0.22, 0.14, pants, 0, -0.22, 0));
    const knee = new THREE.Group();
    knee.name = `knee${side}`;
    knee.position.set(0, -0.22, 0);
    knee.add(box(0.115, 0.185, 0.135, pants, 0, -0.18, 0));
    knee.add(box(0.13, 0.05, 0.19, shoes, 0, -0.23, 0.025));
    leg.add(knee);
    g.add(leg);
  }
  const torso = new THREE.Group();
  torso.name = 'torso';
  g.add(torso);
  torso.add(box(0.34, 0.42, 0.2, shirt, 0, 0.45, 0));
  torso.add(box(0.352, 0.045, 0.212, '#24302f', 0, 0.46, 0)); // cinto
  torso.add(box(0.2, 0.03, 0.05, shirt, 0, 0.87, 0.06)); // gola
  if (workshop) {
    // Avental de lona (tapeçaria), costura em jeans, qualidade/escritório em jaleco claro.
    const apron = /qualid|inspe/.test(roles)
      ? '#eef1ee'
      : /costur/.test(roles)
        ? '#4a6688'
        : /ajud|apoio|log/.test(roles)
          ? '#5f6b52'
          : '#b48a5a';
    torso.add(box(0.3, 0.36, 0.012, apron, 0, 0.47, 0.107));
    torso.add(box(0.012, 0.18, 0.012, apron, -0.09, 0.8, 0.104)); // alças
    torso.add(box(0.012, 0.18, 0.012, apron, 0.09, 0.8, 0.104));
    torso.add(
      box(
        0.16,
        0.08,
        0.014,
        new THREE.Color(apron).offsetHSL(0, 0, -0.08).getStyle(),
        0,
        0.55,
        0.115,
      ),
    ); // bolso
    // Crachá com a inicial, na cor do funcionário.
    const badge = initialBadge(opts.name ?? '', color);
    badge.position.set(0.09, 0.74, 0.118);
    torso.add(badge);
  }
  for (const [side, sx] of [
    ['L', -0.215],
    ['R', 0.215],
  ] as const) {
    const arm = new THREE.Group();
    arm.name = `arm${side}`;
    arm.position.set(sx, 0.85, 0);
    arm.add(box(0.085, 0.16, 0.105, shirt, 0, -0.16, 0)); // manga
    arm.add(box(0.075, 0.15, 0.09, workshop && (h >>> 13) % 2 ? skin : shirt, 0, -0.3, 0));
    arm.add(box(0.07, 0.075, 0.085, skin, 0, -0.375, 0)); // mão
    if (side === 'R') {
      const tool = new THREE.Group();
      tool.name = 'toolR';
      tool.position.set(0, -0.4, 0.03);
      arm.add(tool);
    }
    g.add(arm);
  }
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 0.905, 0);
  g.add(head);
  g.add(box(0.11, 0.05, 0.1, skin, 0, 0.865, 0)); // pescoço
  head.add(box(0.26, 0.26, 0.24, skin, 0, 0, 0));
  // Cabelo (sem faces coincidentes com a cabeça).
  if (hairStyle !== 4) {
    head.add(box(0.28, 0.075, 0.26, hair, 0, 0.215, -0.005));
    head.add(box(0.28, 0.16, 0.05, hair, 0, 0.085, -0.115));
    head.add(box(0.025, 0.12, 0.2, hair, -0.142, 0.12, -0.02));
    head.add(box(0.025, 0.12, 0.2, hair, 0.142, 0.12, -0.02));
    head.add(box(0.2, 0.04, 0.03, hair, -0.03, 0.22, 0.12)); // franja
  } else {
    head.add(box(0.27, 0.03, 0.25, hair, 0, 0.255, 0));
    head.add(box(0.2, 0.06, 0.02, hair, 0, 0.0, 0.122)); // barba
    head.add(box(0.02, 0.1, 0.12, hair, -0.13, 0.02, 0.06));
    head.add(box(0.02, 0.1, 0.12, hair, 0.13, 0.02, 0.06));
  }
  if (hairStyle === 1) head.add(box(0.28, 0.22, 0.05, hair, 0, -0.12, -0.13)); // comprido
  if (hairStyle === 2) head.add(box(0.12, 0.1, 0.1, hair, 0, 0.25, -0.1)); // coque
  if (hairStyle === 3 && (style === 'PESSOA' || look)) {
    const cap = look ? look.shirt : color;
    head.add(box(0.29, 0.07, 0.27, cap, 0, 0.24, 0)); // boné na cor da equipe (ou da roupa)
    head.add(box(0.22, 0.02, 0.12, cap, 0, 0.245, 0.17));
  }
  // Rosto (frente = +z): olhos com brilho, sobrancelhas, nariz e boca.
  for (const sx of [-0.06, 0.06]) {
    head.add(box(0.05, 0.05, 0.01, '#fbfaf6', sx, 0.07, 0.122));
    head.add(box(0.028, 0.034, 0.012, PALETTE.ink, sx + 0.006, 0.072, 0.126));
    head.add(box(0.055, 0.014, 0.012, hair, sx, 0.135, 0.124));
  }
  head.add(
    box(0.04, 0.045, 0.03, new THREE.Color(skin).offsetHSL(0, 0, -0.06).getStyle(), 0, 0.025, 0.13),
  );
  head.add(box(0.08, 0.016, 0.012, '#8a4b3c', 0, -0.045, 0.124));
  for (const sx of [-0.135, 0.135]) head.add(box(0.02, 0.06, 0.05, skin, sx, 0.03, 0)); // orelhas
  if (style === 'MESTRE') {
    head.add(box(0.32, 0.08, 0.3, '#f4c430', 0, 0.265, 0));
    head.add(box(0.37, 0.02, 0.37, '#f4c430', 0, 0.25, 0.03));
    torso.add(box(0.352, 0.06, 0.212, '#fdd835', 0, 0.62, 0));
  }
  if (style === 'AGENTE') {
    // Headset: arco por cima do cabelo, hastes, conchas nas duas orelhas e microfone com luz.
    const band = '#4c1d95';
    head.add(box(0.36, 0.035, 0.07, band, 0, 0.295, 0));
    for (const s of [-1, 1]) {
      head.add(box(0.03, 0.22, 0.05, band, s * 0.165, 0.085, 0));
      head.add(box(0.05, 0.11, 0.1, '#7c3aed', s * 0.17, 0.015, 0));
      head.add(box(0.012, 0.07, 0.07, mat('#c4b5fd', { emissive: '#a78bfa' }), s * 0.2, 0.035, 0));
    }
    head.add(box(0.022, 0.022, 0.15, band, -0.175, 0.025, 0.1));
    head.add(box(0.045, 0.04, 0.04, mat('#c4b5fd', { emissive: '#a78bfa' }), -0.16, 0.015, 0.185));
    // Crachá de agente no peito.
    torso.add(box(0.08, 0.08, 0.012, mat('#ede9fe', { emissive: '#8b5cf6' }), 0.08, 0.7, 0.106));
  }
  if (style === 'JOGADOR') {
    torso.add(box(0.36, 0.06, 0.22, PALETTE.bronze, 0, 0.8, 0));
    torso.add(
      box(0.1, 0.1, 0.012, mat('#f5ebdf', { emissive: PALETTE.bronze }), 0.08, 0.68, 0.106),
    );
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}

/** Crachá pequeno com a inicial do nome (textura em canvas). */
function initialBadge(name: string, color: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 18);
  ctx.fillStyle = '#1d2523';
  ctx.font = '800 38px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name.replace(/^\[[^\]]*\]\s*/, '')[0] ?? '•').toUpperCase(), 32, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.075, 0.075),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }),
  );
  return m;
}

/** Ferramenta na mão direita conforme a etapa (atividade de produção). */
export function toolModel(activity: string | null) {
  const g = new THREE.Group();
  const steel = mat(PALETTE.steel, { metal: 0.6, rough: 0.35 });
  switch (activity) {
    case 'CORTE':
    case 'CORTE_TECIDO':
    case 'CORTE_ESPUMA': {
      // Tesoura.
      g.add(box(0.012, 0.012, 0.16, steel, -0.012, 0, 0.08));
      g.add(box(0.012, 0.012, 0.16, steel, 0.012, 0, 0.08));
      g.add(box(0.04, 0.02, 0.04, mat('#b42323'), -0.02, -0.01, -0.01));
      g.add(box(0.04, 0.02, 0.04, mat('#b42323'), 0.02, -0.01, -0.01));
      break;
    }
    case 'REVESTIMENTO':
    case 'MONTAGEM':
    case 'ACABAMENTO':
    case 'CORRECAO':
      // Grampeador pneumático.
      g.add(box(0.05, 0.06, 0.16, mat('#d08a16'), 0, -0.03, 0.06));
      g.add(box(0.04, 0.08, 0.04, mat('#2f3a40'), 0, -0.09, -0.01));
      g.add(box(0.03, 0.02, 0.05, steel, 0, -0.04, 0.16));
      break;
    case 'DESMONTAGEM':
    case 'PREPARACAO':
    case 'PREPARACAO_MDF':
      // Alicate/saca-grampo.
      g.add(box(0.025, 0.025, 0.14, steel, 0, 0, 0.07));
      g.add(box(0.03, 0.03, 0.08, mat('#1f5fa8'), 0, 0, -0.03));
      break;
    case 'EMBALAGEM':
      g.add(cyl(0.04, 0.03, '#c9a26b', 0, -0.02, 0.04, 10));
      break;
    default:
      break;
  }
  return g;
}

/**
 * Pose de sentado (s = 0 em pé … 1 sentado), com transição suave. Coxas para a frente, canelas para
 * baixo, corpo apoiado no assento e, sentado, mãos no teclado digitando.
 */
export function seatPose(g: THREE.Object3D, s: number, t: number) {
  const e = s * s * (3 - 2 * s);
  const legL = g.getObjectByName('legL');
  const legR = g.getObjectByName('legR');
  const kneeL = g.getObjectByName('kneeL');
  const kneeR = g.getObjectByName('kneeR');
  const armL = g.getObjectByName('armL');
  const armR = g.getObjectByName('armR');
  if (legL && legR) legL.rotation.x = legR.rotation.x = (-Math.PI / 2) * e;
  if (kneeL && kneeR) kneeL.rotation.x = kneeR.rotation.x = (Math.PI / 2) * e;
  if (armL && armR) {
    const typing = s > 0.98 ? Math.sin(t * 9) * 0.05 : 0;
    armL.rotation.x = -1.3 * e + typing;
    armR.rotation.x = -1.3 * e - typing;
    armL.rotation.z = 0.12 * e;
    armR.rotation.z = -0.12 * e;
  }
  return OFFICE_SEAT.height + THIGH_HALF - HIP_HEIGHT;
}

/** Etiqueta com texto (sprite em canvas). */
export function label(
  text: string,
  opts: {
    bg?: string;
    fg?: string;
    size?: number;
    icon?: string;
    iconColor?: string;
    border?: string;
  } = {},
) {
  const size = opts.size ?? 28;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  // Emojis viram ícone de linha desenhado (o primeiro) ou somem do texto.
  const parsed = splitIcon(text);
  const icon = iconOf(opts.icon) ?? parsed.icon;
  const full = parsed.text;
  const iw = icon ? size * 1.05 : 0;
  const tw = Math.ceil(ctx.measureText(full).width);
  c.width = tw + size + iw;
  c.height = Math.ceil(size * 1.6);
  const r = c.height / 2;
  ctx.fillStyle = opts.bg ?? 'rgba(29,37,35,0.82)';
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, r);
  ctx.fill();
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  const fg = opts.fg ?? '#ffffff';
  if (icon)
    drawIcon(ctx, icon, size / 2, (c.height - size * 0.85) / 2, size * 0.85, opts.iconColor ?? fg);
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(full, size / 2 + iw, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  const scale = 0.0125 * (size / 28);
  sprite.scale.set(c.width * scale, c.height * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Texto pintado no chão (nome da área). */
export function floorText(text: string, color = '#1d2523', maxW = 3) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const size = 64;
  ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
  const tw = Math.ceil(ctx.measureText(text).width);
  c.width = tw + 20;
  c.height = size + 20;
  ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const w = Math.min(maxW, (c.width / c.height) * 0.45);
  const h = w * (c.height / c.width);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ───────────────────────────── Ambiente: texturas, objetos de parede, luminárias ─────────────────────────────

const texCache = new Map<string, THREE.Texture>();
/** Textura procedural do piso: tábuas de madeira (escritório) ou cimento queimado (oficina). */
export function floorTexture(kind: 'wood' | 'concrete') {
  const hit = texCache.get(kind);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  if (kind === 'wood') {
    // 2 m × 2 m: tábuas de 20 cm, emendas desencontradas, veios e variação de tom.
    const rows = 10;
    const h = 512 / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 200;
      while (x < 512) {
        const len = 140 + rnd() * 160;
        const l = 78 + rnd() * 10;
        ctx.fillStyle = `hsl(${32 + rnd() * 6}, ${38 + rnd() * 10}%, ${l}%)`;
        ctx.fillRect(x, r * h, len, h);
        ctx.strokeStyle = 'rgba(120,85,50,0.10)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          const y = r * h + 4 + rnd() * (h - 8);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.bezierCurveTo(
            x + len / 3,
            y + rnd() * 6 - 3,
            x + (2 * len) / 3,
            y + rnd() * 6 - 3,
            x + len,
            y,
          );
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(110,80,50,0.35)';
        ctx.fillRect(x, r * h, 2, h);
        x += len;
      }
      ctx.fillStyle = 'rgba(110,80,50,0.28)';
      ctx.fillRect(0, r * h, 512, 2);
    }
  } else {
    // 4 m × 4 m de cimento queimado claro com juntas a cada 2 m.
    ctx.fillStyle = '#dcd6cb';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      const v = 190 + rnd() * 50;
      ctx.fillStyle = `rgba(${v},${v - 4},${v - 10},${0.15 + rnd() * 0.2})`;
      ctx.fillRect(rnd() * 512, rnd() * 512, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    for (let i = 0; i < 18; i++) {
      const g = ctx.createRadialGradient(
        rnd() * 512,
        rnd() * 512,
        0,
        rnd() * 512,
        rnd() * 512,
        60 + rnd() * 120,
      );
      g.addColorStop(0, 'rgba(160,150,135,0.10)');
      g.addColorStop(1, 'rgba(160,150,135,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 512);
    }
    ctx.fillStyle = 'rgba(120,110,95,0.35)';
    ctx.fillRect(0, 255, 512, 2);
    ctx.fillRect(255, 0, 2, 512);
    ctx.fillRect(0, 0, 512, 1);
    ctx.fillRect(0, 0, 1, 512);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  texCache.set(kind, t);
  return t;
}

/** Janela na parede: moldura, travessas e vidro (o motor ajusta o brilho do vidro pela hora). */
export function wallWindow(len: number, thick: number) {
  const g = new THREE.Group();
  const h = 1.1;
  const y0 = 0.95;
  const frame = mat('#f3efe6');
  g.add(box(len, 0.06, thick + 0.06, frame, 0, y0 - 0.06, 0));
  g.add(box(len, 0.06, thick + 0.06, frame, 0, y0 + h, 0));
  for (const sx of [-1, 1])
    g.add(box(0.06, h, thick + 0.06, frame, (sx * (len - 0.06)) / 2, y0, 0));
  const panes = Math.max(2, Math.round(len / 0.6));
  for (let i = 1; i < panes; i++)
    g.add(box(0.03, h, thick + 0.05, frame, -len / 2 + (i * len) / panes, y0, 0));
  g.add(box(len, 0.03, thick + 0.05, frame, 0, y0 + h / 2, 0));
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(len - 0.08, h, thick + 0.02),
    new THREE.MeshStandardMaterial({
      color: '#bfe3f2',
      transparent: true,
      opacity: 0.8,
      emissive: new THREE.Color('#cfeaff'),
      emissiveIntensity: 0.5,
      roughness: 0.15,
    }),
  );
  glass.name = 'glass';
  glass.position.y = y0 + h / 2;
  g.add(glass);
  // Peitoril.
  g.add(box(len + 0.08, 0.04, thick + 0.16, mat('#d8cfc0'), 0, y0 - 0.1, 0));
  return g;
}

/** Painel de ferramentas (pegboard) com tesouras, martelo, grampeador, réguas e trenas. */
export function pegboard(w: number) {
  const g = new THREE.Group();
  g.add(box(w, 0.9, 0.03, mat('#c9a77a'), 0, 1.1, 0));
  const hole = mat('#8d6e4a');
  for (let x = -w / 2 + 0.08; x < w / 2 - 0.05; x += 0.12)
    for (let y = 1.16; y < 1.98; y += 0.12) g.add(box(0.015, 0.015, 0.005, hole, x, y, 0.017));
  const steel = mat(PALETTE.steel, { metal: 0.6, rough: 0.35 });
  const tools: [number, () => THREE.Object3D][] = [
    [
      -0.32,
      () => {
        const t = new THREE.Group();
        t.add(box(0.04, 0.32, 0.03, mat('#7a4a2e'), 0, 1.35, 0.04));
        t.add(box(0.16, 0.06, 0.04, steel, 0, 1.67, 0.04));
        return t;
      },
    ],
    [
      -0.1,
      () => {
        const t = new THREE.Group();
        t.add(box(0.02, 0.2, 0.012, steel, -0.02, 1.5, 0.04));
        t.add(box(0.02, 0.2, 0.012, steel, 0.02, 1.5, 0.04));
        t.add(box(0.05, 0.05, 0.02, mat('#b42323'), -0.03, 1.42, 0.04));
        t.add(box(0.05, 0.05, 0.02, mat('#b42323'), 0.03, 1.42, 0.04));
        return t;
      },
    ],
    [0.12, () => box(0.08, 0.12, 0.16, mat('#d08a16'), 0, 1.45, 0.08)],
    [0.32, () => box(0.03, 0.6, 0.012, mat('#e8d27a'), 0, 1.2, 0.03)],
  ];
  for (const [x, f] of tools) {
    if (Math.abs(x) > w / 2 - 0.08) continue;
    const t = f();
    t.position.x += x;
    g.add(t);
  }
  return g;
}

/** Quadro de avisos de cortiça com papéis presos. */
export function noticeBoard(w: number) {
  const g = new THREE.Group();
  g.add(box(w, 0.7, 0.03, mat('#8d5f31'), 0, 1.2, 0));
  g.add(box(w - 0.06, 0.64, 0.02, mat('#c9a06a'), 0, 1.23, 0.015));
  const papers = ['#fffaf0', '#fff3b0', '#d8efff', '#ffe0e0', '#fffaf0'];
  let x = -w / 2 + 0.14;
  let i = 0;
  while (x < w / 2 - 0.12) {
    const ph = 0.16 + ((i * 37) % 7) * 0.02;
    const p = box(
      0.15,
      ph,
      0.006,
      mat(papers[i % papers.length]!),
      x,
      1.3 + ((i * 13) % 5) * 0.04,
      0.03,
    );
    p.rotation.z = (((i * 29) % 7) - 3) * 0.03;
    g.add(p);
    g.add(
      box(
        0.02,
        0.02,
        0.01,
        mat(['#b42323', '#1f7a46', '#2c5ea8'][i % 3]!),
        x,
        1.3 + ph + ((i * 13) % 5) * 0.04 - 0.03,
        0.04,
      ),
    );
    x += 0.2;
    i++;
  }
  return g;
}

/** Relógio de parede com ponteiros (o motor gira hourHand/minHand pela hora real). */
export function wallClock() {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 24), mat('#fbfaf6'));
  face.rotation.x = Math.PI / 2;
  face.position.set(0, 2.0, 0.02);
  g.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 6, 24), mat(PALETTE.ink));
  rim.position.set(0, 2.0, 0.035);
  g.add(rim);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.add(
      box(
        0.012,
        0.025,
        0.008,
        mat(PALETTE.ink),
        Math.sin(a) * 0.14,
        2.0 + Math.cos(a) * 0.14 - 0.0125,
        0.04,
      ),
    );
  }
  for (const [name, len, w] of [
    ['hourHand', 0.08, 0.018],
    ['minHand', 0.125, 0.012],
  ] as const) {
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(0, 2.0, 0.045);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.006), mat(PALETTE.ink));
    hand.position.y = len / 2;
    pivot.add(hand);
    g.add(pivot);
  }
  return g;
}

/** Prateleira alta de parede com rolos de tecido deitados. */
export function wallFabricShelf(w: number) {
  const g = new THREE.Group();
  g.add(box(w, 0.03, 0.32, mat(PALETTE.woodDark), 0, 1.85, 0.16));
  for (const sx of [-1, 1])
    g.add(box(0.03, 0.2, 0.28, mat(PALETTE.metal), sx * (w / 2 - 0.1), 1.66, 0.14));
  const colors = ['#8c5a4a', '#5f7f6e', '#cbb894', '#4f6f86', '#c99a3a', '#6d6a8f'];
  const n = Math.max(1, Math.floor(w / 0.24));
  for (let i = 0; i < n; i++) {
    const r = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.3, 12),
      mat(colors[i % colors.length]!, { rough: 1 }),
    );
    r.rotation.x = Math.PI / 2;
    r.position.set(-w / 2 + 0.15 + i * ((w - 0.3) / Math.max(1, n - 1)), 1.98, 0.17);
    r.castShadow = true;
    g.add(r);
  }
  return g;
}

/** Luminária pendente (fio, cúpula e lâmpada). A lâmpada se chama "bulb". */
export function pendantLamp(height = 2.15) {
  const g = new THREE.Group();
  g.add(box(0.01, 3.0 - height, 0.01, mat(PALETTE.ink), 0, height + 0.2, 0));
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.2, 14, 1, true),
    mat('#1d4a45', { rough: 0.6 }),
  );
  (shade.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  shade.position.y = height + 0.1;
  g.add(shade);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshStandardMaterial({
      color: '#fff3c4',
      emissive: new THREE.Color('#ffd27a'),
      emissiveIntensity: 0.2,
    }),
  );
  bulb.name = 'bulb';
  bulb.position.y = height + 0.02;
  g.add(bulb);
  // Cone de luz (só aparece à noite).
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, height, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: '#ffe2a0',
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  cone.name = 'beamcone';
  cone.position.y = height / 2;
  g.add(cone);
  return g;
}

/** Vaso com planta (variações). */
export function plant(kind = 0) {
  const g = new THREE.Group();
  g.add(cyl(0.16, 0.3, kind % 2 ? '#d9cbb6' : '#a8743f', 0, 0, 0, 10));
  const leaf = mat(kind % 3 === 2 ? '#3f6b3a' : '#4f7d4a');
  if (kind % 3 === 1) {
    for (let i = 0; i < 6; i++) {
      const l = box(0.05, 0.5, 0.12, leaf, 0, 0.3, 0);
      l.rotation.set(0.35, (i / 6) * Math.PI * 2, 0.25);
      g.add(l);
    }
  } else {
    const a = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), leaf);
    a.position.y = 0.7;
    a.castShadow = true;
    g.add(a);
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), leaf);
    b.position.set(0.12, 0.95, 0.05);
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

/** Troféu (recompensa de missão). */
export function trophy(color = '#e0a63a') {
  const g = new THREE.Group();
  const gold = mat(color, { metal: 0.7, rough: 0.3, emissive: color });
  g.add(box(0.14, 0.04, 0.1, mat(PALETTE.woodDark), 0, 0, 0));
  g.add(box(0.03, 0.08, 0.03, gold, 0, 0.04, 0));
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.035, 0.1, 10), gold);
  cup.position.y = 0.17;
  g.add(cup);
  return g;
}

/** Tapete retangular. */
export function rug(w: number, d: number, color = '#a0574f') {
  const g = new THREE.Group();
  g.add(box(w, 0.012, d, mat(color, { rough: 1 }), 0, 0.001, 0));
  g.add(
    box(
      w - 0.16,
      0.014,
      d - 0.16,
      mat(new THREE.Color(color).offsetHSL(0, -0.1, 0.12).getStyle(), { rough: 1 }),
      0,
      0.002,
      0,
    ),
  );
  return g;
}

/** Carrinho de transporte (aparece sob a peça quando ela muda de área). */
export function cart(w: number, d: number) {
  const g = new THREE.Group();
  g.add(box(w * 0.8, 0.04, d * 0.8, mat('#5a6b6b', { metal: 0.4 }), 0, 0.06, 0));
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) g.add(cyl(0.04, 0.05, '#1d2523', sx * w * 0.35, 0, sz * d * 0.35, 8));
  return g;
}

/**
 * Furgão de retirada e entrega (frente = +x). Rodas nomeadas `wheel` (giram quando anda) e
 * faróis `lamp` (acendem à noite e quando está em movimento).
 */
export function vanModel(accent: string = PALETTE.bronze) {
  const g = new THREE.Group();
  const body = '#f3f1ec';
  const glass = mat('#8fb3c4', { metal: 0.3, rough: 0.15 });
  g.add(box(3.25, 0.22, 1.46, '#2a2f33', 0, 0.26, 0)); // chassi
  g.add(box(2.15, 1.4, 1.6, body, -0.58, 0.48, 0)); // baú
  g.add(box(2.17, 0.12, 1.62, accent, -0.58, 1.1, 0)); // faixa da empresa
  g.add(box(2.17, 0.04, 1.62, '#d8d3c8', -0.58, 1.88, 0)); // teto do baú
  g.add(box(0.02, 1.2, 0.72, '#e2ddd2', -1.665, 0.58, -0.38)); // portas traseiras
  g.add(box(0.02, 1.2, 0.72, '#e2ddd2', -1.665, 0.58, 0.38));
  g.add(box(1.05, 0.95, 1.56, accent, 1.04, 0.48, 0)); // cabine
  g.add(box(0.62, 0.42, 1.54, accent, 0.82, 1.43, 0)); // teto da cabine
  const wind = box(0.04, 0.5, 1.38, glass, 1.4, 1.02, 0);
  wind.rotation.z = 0.5;
  g.add(wind);
  for (const s of [-1, 1]) {
    g.add(box(0.46, 0.36, 0.02, glass, 1.02, 1.06, s * 0.79)); // janelas laterais
    g.add(box(0.06, 0.1, 0.16, '#1d2523', 1.2, 1.12, s * 0.86)); // retrovisores
  }
  g.add(box(0.1, 0.18, 1.6, '#3a3f44', 1.6, 0.36, 0)); // para-choque
  g.add(box(0.1, 0.16, 1.6, '#3a3f44', -1.66, 0.36, 0));
  for (const s of [-1, 1]) {
    const lamp = box(
      0.03,
      0.12,
      0.26,
      mat('#fff3c8', { emissive: '#fff3c8' }),
      1.575,
      0.62,
      s * 0.56,
    );
    lamp.name = 'lamp';
    g.add(lamp);
    g.add(box(0.03, 0.16, 0.12, mat('#c0392b', { emissive: '#7a1d14' }), -1.68, 0.62, s * 0.66));
  }
  const tire = mat('#1d2523', { rough: 0.9 });
  const hub = mat('#9aa3a8', { metal: 0.6, rough: 0.4 });
  for (const x of [-1.05, 1.05])
    for (const s of [-1, 1]) {
      const w = new THREE.Group();
      w.name = 'wheel';
      w.position.set(x, 0.31, s * 0.72);
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.22, 16), tire);
      t.rotation.x = Math.PI / 2;
      t.castShadow = true;
      w.add(t);
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.23, 10), hub);
      h.rotation.x = Math.PI / 2;
      w.add(h);
      g.add(w);
    }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  return g;
}
