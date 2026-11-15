'use client';
/**
 * Rascunho da planta no modo Construção: alterações locais com desfazer/refazer, até salvar.
 * Ids são gerados no cliente (estáveis): mover, renomear ou redimensionar preserva vínculos.
 */
import {
  AREA_FUNCTION_COLOR,
  AREA_FUNCTION_LABEL,
  type AreaDef,
  type AreaFunction,
  type DecorKind,
  type LayoutContent,
  type LayoutPatch,
  type Rotation,
  DECOR_KINDS,
  STATION_KINDS,
  type StationDef,
  type StationKind,
  type StorageKind,
  contains,
  footprint,
  newGameId,
  rectOfArea,
  storageUnit,
} from '@cenario/shared';
import { useCallback, useMemo, useState } from 'react';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export type Selection = {
  kind: 'station' | 'storage' | 'decor' | 'area' | 'wall' | 'door';
  id: string;
} | null;

interface DraftState {
  draft: LayoutContent | null;
  base: string;
  past: LayoutContent[];
  future: LayoutContent[];
}

export function useLayoutDraft() {
  const [st, setSt] = useState<DraftState>({ draft: null, base: '', past: [], future: [] });

  const load = useCallback((l: LayoutContent) => {
    const c = clone(l);
    setSt({ draft: c, base: JSON.stringify(c), past: [], future: [] });
  }, []);

  /** Mudança com passo de desfazer (`commit`) ou sem (arraste contínuo). */
  const live = useCallback((fn: (l: LayoutContent) => void, commit: boolean) => {
    setSt((cur) => {
      if (!cur.draft) return cur;
      const next = clone(cur.draft);
      fn(next);
      return commit
        ? { ...cur, draft: next, past: [...cur.past.slice(-99), cur.draft], future: [] }
        : { ...cur, draft: next };
    });
  }, []);
  const apply = useCallback((fn: (l: LayoutContent) => void) => live(fn, true), [live]);

  const undo = useCallback(() => {
    setSt((cur) => {
      const prev = cur.past[cur.past.length - 1];
      if (!prev || !cur.draft) return cur;
      return {
        ...cur,
        draft: prev,
        past: cur.past.slice(0, -1),
        future: [...cur.future, cur.draft],
      };
    });
  }, []);
  const redo = useCallback(() => {
    setSt((cur) => {
      const next = cur.future[cur.future.length - 1];
      if (!next || !cur.draft) return cur;
      return {
        ...cur,
        draft: next,
        future: cur.future.slice(0, -1),
        past: [...cur.past, cur.draft],
      };
    });
  }, []);

  const dirty = useMemo(
    () => (st.draft ? JSON.stringify(st.draft) !== st.base : false),
    [st.draft, st.base],
  );
  return {
    draft: st.draft,
    load,
    apply,
    live,
    undo,
    redo,
    dirty,
    canUndo: st.past.length > 0,
    canRedo: st.future.length > 0,
  };
}

/** Área que contém o retângulo (para vincular a estação automaticamente). */
export function areaFor(l: LayoutContent, r: { x: number; y: number; w: number; d: number }) {
  const inside = l.areas.filter((a) => contains(rectOfArea(a), r));
  if (inside.length) return inside.sort((a, b) => a.wCm * a.dCm - b.wCm * b.dCm)[0]!;
  const c = { x: r.x + r.w / 2, y: r.y + r.d / 2 };
  return (
    l.areas.find(
      (a) => c.x >= a.xCm && c.x <= a.xCm + a.wCm && c.y >= a.yCm && c.y <= a.yCm + a.dCm,
    ) ?? null
  );
}

export function addStation(l: LayoutContent, kind: StationKind, at: { x: number; y: number }) {
  const c = STATION_KINDS[kind];
  const s: StationDef = {
    id: newGameId(),
    kind,
    name: c.label,
    xCm: Math.round(at.x - c.wCm / 2),
    yCm: Math.round(at.y - c.dCm / 2),
    wCm: c.wCm,
    dCm: c.dCm,
    rotation: 0,
    activities: [...(('activities' in c ? c.activities : []) as readonly string[])],
    shared: false,
    assigneeUserIds: [],
    areaId: null,
  };
  s.areaId = areaFor(l, footprint(s))?.id ?? null;
  l.stations.push(s);
  return s.id;
}

export function addStorage(l: LayoutContent, kind: StorageKind, at: { x: number; y: number }) {
  const n = l.storageUnits.filter((u) => u.kind === kind).length;
  const letter = String.fromCharCode(65 + (n % 26));
  const u = storageUnit(
    kind,
    kind === 'ESTANTE' ? `Estante ${letter}` : `${kindLabel(kind)} ${n + 1}`,
    undefined,
    0,
    0,
  );
  u.xCm = Math.round(at.x - u.wCm / 2);
  u.yCm = Math.round(at.y - u.dCm / 2);
  u.areaId = areaFor(l, footprint(u))?.id ?? null;
  l.storageUnits.push(u);
  return u.id;
}

const kindLabel = (k: string) =>
  ({
    PRATELEIRA: 'Prateleira',
    ARMARIO: 'Armário',
    GAVETEIRO: 'Gaveteiro',
    SUPORTE_ROLOS: 'Suporte de tecidos',
    ESTRADO_ESPUMA: 'Estrado de espumas',
    ESTANTE: 'Estante',
  })[k] ?? k;

export function addDecor(l: LayoutContent, kind: DecorKind, at: { x: number; y: number }) {
  const c = DECOR_KINDS[kind];
  const id = newGameId();
  l.doc.decor.push({
    id,
    kind,
    name: c.label,
    xCm: Math.round(at.x - c.wCm / 2),
    yCm: Math.round(at.y - c.dCm / 2),
    wCm: c.wCm,
    dCm: c.dCm,
    rotation: 0,
  });
  return id;
}

export function addArea(l: LayoutContent, fn: AreaFunction, at: { x: number; y: number }) {
  const a: AreaDef = {
    id: newGameId(),
    function: fn,
    name: AREA_FUNCTION_LABEL[fn],
    xCm: Math.max(0, Math.round(at.x - 150)),
    yCm: Math.max(0, Math.round(at.y - 125)),
    wCm: 300,
    dCm: 250,
    color: AREA_FUNCTION_COLOR[fn],
    itemLocationId: null,
  };
  l.areas.push(a);
  return a.id;
}

export function addWall(l: LayoutContent, at: { x: number; y: number }) {
  const id = newGameId().slice(0, 8);
  l.doc.walls.push({
    id,
    x1: Math.round(at.x - 150),
    y1: Math.round(at.y),
    x2: Math.round(at.x + 150),
    y2: Math.round(at.y),
  });
  return id;
}

export function rotateObj(l: LayoutContent, id: string) {
  const w = l.doc.walls.find((x) => x.id === id);
  if (w) {
    const cx = (w.x1 + w.x2) / 2;
    const cy = (w.y1 + w.y2) / 2;
    const half = (Math.abs(w.x2 - w.x1) + Math.abs(w.y2 - w.y1)) / 2;
    const horizontal = w.y1 === w.y2;
    Object.assign(
      w,
      horizontal
        ? {
            x1: Math.round(cx),
            x2: Math.round(cx),
            y1: Math.round(cy - half),
            y2: Math.round(cy + half),
          }
        : {
            y1: Math.round(cy),
            y2: Math.round(cy),
            x1: Math.round(cx - half),
            x2: Math.round(cx + half),
          },
    );
    return;
  }
  const o =
    l.stations.find((s) => s.id === id) ??
    l.storageUnits.find((s) => s.id === id) ??
    l.doc.decor.find((s) => s.id === id);
  if (!o) return;
  const before = footprint(o);
  o.rotation = ((o.rotation + 90) % 360) as Rotation;
  // Gira em torno do centro.
  const after = footprint(o);
  o.xCm = Math.round(before.x + before.w / 2 - after.w / 2);
  o.yCm = Math.round(before.y + before.d / 2 - after.d / 2);
}

export function duplicateObj(l: LayoutContent, id: string) {
  const s = l.stations.find((x) => x.id === id);
  if (s) {
    const c = {
      ...clone(s),
      id: newGameId(),
      name: `${s.name} (cópia)`,
      xCm: s.xCm + 40,
      yCm: s.yCm + 40,
      assigneeUserIds: [],
    };
    l.stations.push(c);
    return c.id;
  }
  const u = l.storageUnits.find((x) => x.id === id);
  if (u) {
    const c = clone(u);
    c.id = newGameId();
    c.label = `${u.label} (cópia)`;
    c.xCm += 40;
    c.yCm += 40;
    c.slots = c.slots.map((sl) => ({ ...sl, id: newGameId(), stockItemIds: [] }));
    l.storageUnits.push(c);
    return c.id;
  }
  const d = l.doc.decor.find((x) => x.id === id);
  if (d) {
    const c = { ...clone(d), id: newGameId(), xCm: d.xCm + 40, yCm: d.yCm + 40 };
    l.doc.decor.push(c);
    return c.id;
  }
  const a = l.areas.find((x) => x.id === id);
  if (a) {
    const c = {
      ...clone(a),
      id: newGameId(),
      name: `${a.name} 2`,
      xCm: a.xCm + 60,
      yCm: a.yCm + 60,
      itemLocationId: null,
    };
    l.areas.push(c);
    return c.id;
  }
  return null;
}

export function removeObj(l: LayoutContent, id: string) {
  l.stations = l.stations.filter((x) => x.id !== id);
  l.storageUnits = l.storageUnits.filter((x) => x.id !== id);
  l.doc.decor = l.doc.decor.filter((x) => x.id !== id);
  l.areas = l.areas.filter((x) => x.id !== id);
  l.doc.walls = l.doc.walls.filter((x) => x.id !== id);
  l.doc.doors = l.doc.doors.filter((x) => x.id !== id && x.wall !== id);
}

export function moveObj(l: LayoutContent, id: string, x: number, y: number) {
  const o =
    l.stations.find((s) => s.id === id) ??
    l.storageUnits.find((s) => s.id === id) ??
    l.doc.decor.find((s) => s.id === id);
  if (o) {
    o.xCm = Math.round(x);
    o.yCm = Math.round(y);
    if ('areaId' in o) {
      const a = areaFor(l, footprint(o));
      o.areaId = a?.id ?? null;
    }
    return;
  }
  const a = l.areas.find((s) => s.id === id);
  if (a) {
    // Mover a área leva junto o que está dentro dela.
    const dx = Math.round(x) - a.xCm;
    const dy = Math.round(y) - a.yCm;
    for (const s of l.stations)
      if (s.areaId === a.id) {
        s.xCm += dx;
        s.yCm += dy;
      }
    for (const u of l.storageUnits)
      if (u.areaId === a.id) {
        u.xCm += dx;
        u.yCm += dy;
      }
    a.xCm += dx;
    a.yCm += dy;
  }
}

/** Arraste de alça: canto de área ou borda da sala. */
export function dragHandle(l: LayoutContent, handle: string, x: number, y: number) {
  if (handle === 'room:e') {
    l.widthCm = Math.max(200, Math.round(x));
    return;
  }
  if (handle === 'room:s') {
    l.depthCm = Math.max(200, Math.round(y));
    return;
  }
  const [id, corner] = handle.split(':');
  const a = l.areas.find((s) => s.id === id);
  if (!a || !corner) return;
  const x2 = a.xCm + a.wCm;
  const y2 = a.yCm + a.dCm;
  if (corner.includes('w')) a.xCm = Math.min(x2 - 50, Math.round(x));
  if (corner.includes('e')) a.wCm = Math.max(50, Math.round(x) - a.xCm);
  else a.wCm = x2 - a.xCm;
  if (corner.includes('n')) a.yCm = Math.min(y2 - 50, Math.round(y));
  if (corner.includes('s')) a.dCm = Math.max(50, Math.round(y) - a.yCm);
  else a.dCm = y2 - a.yCm;
}

export function moveWall(l: LayoutContent, id: string, cx: number, cy: number) {
  const w = l.doc.walls.find((x) => x.id === id);
  if (!w) return;
  const mx = (w.x1 + w.x2) / 2;
  const my = (w.y1 + w.y2) / 2;
  const dx = Math.round(cx - mx);
  const dy = Math.round(cy - my);
  w.x1 += dx;
  w.x2 += dx;
  w.y1 += dy;
  w.y2 += dy;
}

export function applyPatch(l: LayoutContent, p: LayoutPatch) {
  if (p.resize) {
    l.widthCm = p.resize.widthCm;
    l.depthCm = p.resize.depthCm;
  }
  for (const a of p.updateAreas ?? []) {
    const i = l.areas.findIndex((x) => x.id === a.id);
    if (i >= 0) l.areas[i] = clone(a);
  }
  for (const a of p.addAreas ?? []) l.areas.push(clone(a));
  for (const s of p.addStations ?? []) {
    const c = clone(s);
    c.areaId = c.areaId ?? areaFor(l, footprint(c))?.id ?? null;
    l.stations.push(c);
  }
  for (const m of p.moveStations ?? []) {
    const s = l.stations.find((x) => x.id === m.id);
    if (!s) continue;
    s.xCm = m.xCm;
    s.yCm = m.yCm;
    s.rotation = m.rotation;
    s.areaId = areaFor(l, footprint(s))?.id ?? s.areaId ?? null;
  }
}
