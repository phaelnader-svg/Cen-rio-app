/**
 * Modelos 3D procedurais do jogo (sem arquivos externos): identidade própria da Cenário —
 * piso de madeira clara, paredes em verde petróleo, detalhes em bronze, peças "de feltro".
 * Unidades em metros; a origem de cada móvel é o canto noroeste do retângulo ocupado no chão.
 */
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

// ───────────────────────────── Móveis em produção (por categoria) ─────────────────────────────

export function furniture(model: FurnitureModel, color: string) {
  const g = new THREE.Group();
  const fabric = mat(color, { rough: 1 });
  const cushion = mat(new THREE.Color(color).offsetHSL(0, -0.05, 0.08).getStyle(), { rough: 1 });
  const add = (
    w: number,
    h: number,
    d: number,
    m: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) => g.add(box(w, h, d, m, x, y, z));
  const sofa = (w: number, d: number, seats: number) => {
    add(w, 0.18, d, fabric, 0, 0.08, 0);
    for (let i = 0; i < seats; i++) {
      const sw = (w - 0.3) / seats;
      add(sw - 0.03, 0.14, d - 0.3, cushion, -w / 2 + 0.15 + sw * (i + 0.5), 0.26, 0.08);
      add(sw - 0.03, 0.42, 0.16, cushion, -w / 2 + 0.15 + sw * (i + 0.5), 0.26, -d / 2 + 0.2);
    }
    add(0.15, 0.5, d, fabric, -w / 2 + 0.075, 0.08, 0);
    add(0.15, 0.5, d, fabric, w / 2 - 0.075, 0.08, 0);
    add(w, 0.6, 0.12, fabric, 0, 0.08, -d / 2 + 0.06);
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
      chaise.add(box(0.84, 0.14, 0.95, cushion, 0, 0.26, 0));
      chaise.add(box(0.15, 0.5, 1.0, fabric, 0.375, 0.08, 0));
      chaise.position.set(0.65, 0, 0.95);
      g.add(chaise);
      break;
    }
    case 'POLTRONA':
      add(0.85, 0.2, 0.85, fabric, 0, 0.12, 0);
      add(0.55, 0.14, 0.6, cushion, 0, 0.32, 0.08);
      add(0.15, 0.45, 0.85, fabric, -0.35, 0.12, 0);
      add(0.15, 0.45, 0.85, fabric, 0.35, 0.12, 0);
      add(0.85, 0.75, 0.15, fabric, 0, 0.12, -0.35);
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
      add(1.6, 1.1, 0.12, fabric, 0, 0.1, 0);
      for (let i = 0; i < 4; i++) add(0.36, 0.95, 0.06, cushion, -0.6 + i * 0.4, 0.17, 0.08);
      add(0.08, 0.12, 0.08, mat(PALETTE.woodDark), -0.7, 0, 0);
      add(0.08, 0.12, 0.08, mat(PALETTE.woodDark), 0.7, 0, 0);
      break;
    case 'PUFE':
      g.add(cyl(0.3, 0.42, color, 0, 0, 0, 14));
      break;
    case 'BANCO':
      add(1.4, 0.1, 0.4, cushion, 0, 0.42, 0);
      legs(g, 1.4, 0.4, 0.42);
      break;
    case 'COLCHAO':
      add(1.4, 0.25, 1.9, cushion, 0, 0.05, 0);
      break;
    default:
      add(0.8, 0.5, 0.6, fabric, 0, 0.05, 0);
      add(0.85, 0.06, 0.65, mat(PALETTE.steel, { opacity: 0.6 }), 0, 0.55, 0);
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

export type AvatarStyle = 'PESSOA' | 'JOGADOR' | 'AGENTE' | 'MESTRE';

/** Assento da cadeira da mesa de escritório: altura do assento (m) e distância da borda da mesa (m). */
export const OFFICE_SEAT = { height: 0.42, depth: 0.42 };
/** Altura do quadril do personagem em pé (m). As pernas giram a partir daqui. */
export const HIP_HEIGHT = 0.45;
/** Metade da espessura da coxa: sentado, o quadril fica isso acima do assento. */
export const THIGH_HALF = 0.07;

const HAIR = ['#3a2a20', '#1f1a17', '#6b4423', '#2b2235', '#8a5a2b'];

/**
 * Personagem em blocos. Pernas e braços são articulados (quadril, joelho, ombro), então o mesmo
 * modelo anda, senta e digita. Os nomes legL/legR/kneeL/kneeR/armL/armR são usados pelo motor.
 * Nenhuma peça encosta face com face em outra (evita o "piscar" de superfícies sobrepostas).
 */
export function avatar(color: string, style: AvatarStyle = 'PESSOA', skinIndex = 0) {
  const g = new THREE.Group();
  const skin = PALETTE.skin[skinIndex % PALETTE.skin.length]!;
  const hair = HAIR[skinIndex % HAIR.length]!;
  const shirt = style === 'MESTRE' ? '#e76f1a' : color;
  const pants = style === 'AGENTE' ? '#3b2f63' : '#2d3b45';
  const shoes = '#1d2523';
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
  g.add(box(0.34, 0.42, 0.2, shirt, 0, 0.45, 0));
  g.add(box(0.352, 0.045, 0.212, '#24302f', 0, 0.46, 0)); // cinto
  g.add(box(0.2, 0.03, 0.05, shirt, 0, 0.87, 0.06)); // gola
  for (const [side, sx] of [
    ['L', -0.215],
    ['R', 0.215],
  ] as const) {
    const arm = new THREE.Group();
    arm.name = `arm${side}`;
    arm.position.set(sx, 0.85, 0);
    arm.add(box(0.085, 0.3, 0.105, shirt, 0, -0.3, 0));
    arm.add(box(0.07, 0.075, 0.085, skin, 0, -0.375, 0)); // mão
    g.add(arm);
  }
  g.add(box(0.11, 0.05, 0.1, skin, 0, 0.865, 0)); // pescoço
  g.add(box(0.26, 0.26, 0.24, skin, 0, 0.905, 0));
  // Cabelo: topo + nuca (sem faces coincidentes com a cabeça).
  g.add(box(0.28, 0.075, 0.26, hair, 0, 1.12, -0.005));
  g.add(box(0.28, 0.16, 0.05, hair, 0, 0.99, -0.115));
  // Rosto (frente = +z).
  g.add(box(0.045, 0.05, 0.012, PALETTE.ink, -0.06, 1.0, 0.124));
  g.add(box(0.045, 0.05, 0.012, PALETTE.ink, 0.06, 1.0, 0.124));
  g.add(box(0.09, 0.018, 0.012, '#8a4b3c', 0, 0.945, 0.124));
  if (style === 'MESTRE') {
    g.add(box(0.32, 0.08, 0.3, '#f4c430', 0, 1.17, 0));
    g.add(box(0.37, 0.02, 0.37, '#f4c430', 0, 1.155, 0.03));
    g.add(box(0.352, 0.06, 0.212, '#fdd835', 0, 0.62, 0));
  }
  if (style === 'AGENTE') {
    // Headset: arco por cima do cabelo, hastes, conchas nas duas orelhas e microfone com luz.
    const band = '#4c1d95';
    g.add(box(0.36, 0.035, 0.07, band, 0, 1.2, 0));
    for (const s of [-1, 1]) {
      g.add(box(0.03, 0.22, 0.05, band, s * 0.165, 0.99, 0));
      g.add(box(0.05, 0.11, 0.1, '#7c3aed', s * 0.17, 0.92, 0));
      g.add(box(0.012, 0.07, 0.07, mat('#c4b5fd', { emissive: '#a78bfa' }), s * 0.2, 0.94, 0));
    }
    g.add(box(0.022, 0.022, 0.15, band, -0.175, 0.93, 0.1));
    g.add(box(0.045, 0.04, 0.04, mat('#c4b5fd', { emissive: '#a78bfa' }), -0.16, 0.92, 0.185));
    // Crachá de agente no peito.
    g.add(box(0.08, 0.08, 0.012, mat('#ede9fe', { emissive: '#8b5cf6' }), 0.08, 0.7, 0.106));
  }
  if (style === 'JOGADOR') g.add(box(0.36, 0.06, 0.22, PALETTE.bronze, 0, 0.8, 0));
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
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
  opts: { bg?: string; fg?: string; size?: number; icon?: string; border?: string } = {},
) {
  const size = opts.size ?? 28;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  const full = opts.icon ? `${opts.icon} ${text}` : text;
  const tw = Math.ceil(ctx.measureText(full).width);
  c.width = tw + size;
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
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = opts.fg ?? '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(full, size / 2, c.height / 2 + 1);
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
