'use client';
import {
  ACTIVITY_LABEL_GAME,
  AREA_FUNCTIONS,
  AREA_FUNCTION_LABEL,
  type AreaFunction,
  DECOR_KINDS,
  type DecorKind,
  type LayoutContent,
  MESTRE_QUICK,
  type MestreReply,
  type RemovalImpact,
  STATION_KINDS,
  STORAGE_KINDS,
  type StationKind,
  type StorageKind,
  areaM2,
  newGameId,
} from '@cenario/shared';
import { useState } from 'react';
import { type GamePerson, useItemLocations, useMaterialSearch, useRevisions } from './game-api';
import type { Selection } from './editor';
import { GBtn, Panel, Section, fmtDateTime } from './ui';

export type PaletteItem =
  | { type: 'station'; kind: StationKind }
  | { type: 'storage'; kind: StorageKind }
  | { type: 'decor'; kind: DecorKind }
  | { type: 'area'; fn: AreaFunction }
  | { type: 'wall' };

export function Palette({ onAdd, kind }: { onAdd: (p: PaletteItem) => void; kind: LayoutContent['kind'] }) {
  const [tab, setTab] = useState<'estacoes' | 'estoque' | 'areas' | 'outros'>('estacoes');
  const office = kind === 'ESCRITORIO';
  const stations = (Object.keys(STATION_KINDS) as StationKind[]).filter((k) => (office ? ['MESA_ESCRITORIO', 'MESA_REUNIAO', 'ESTACAO_LIVRE'].includes(k) : k !== 'MESA_REUNIAO'));
  return (
    <Panel title="Construir" subtitle="Clique para colocar no centro da vista" icon="🧱" className="w-full" testId="palette">
      <div className="mb-2 grid grid-cols-4 gap-1 text-[11px] font-semibold">
        {(
          [
            ['estacoes', office ? 'Mesas' : 'Estações'],
            ['estoque', 'Estoque'],
            ['areas', 'Áreas'],
            ['outros', 'Outros'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-1 py-1 ${tab === k ? 'bg-brand-600 text-white' : 'bg-subtle'}`}>{l}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {tab === 'estacoes' &&
          stations.map((k) => (
            <Item key={k} label={STATION_KINDS[k].label} dims={`${STATION_KINDS[k].wCm}×${STATION_KINDS[k].dCm}`} onClick={() => onAdd({ type: 'station', kind: k })} />
          ))}
        {tab === 'estoque' &&
          (Object.keys(STORAGE_KINDS) as StorageKind[]).map((k) => (
            <Item key={k} label={STORAGE_KINDS[k].label} dims={`${STORAGE_KINDS[k].wCm}×${STORAGE_KINDS[k].dCm} · ${STORAGE_KINDS[k].levels} pos.`} onClick={() => onAdd({ type: 'storage', kind: k })} />
          ))}
        {tab === 'areas' &&
          AREA_FUNCTIONS.map((f) => <Item key={f} label={AREA_FUNCTION_LABEL[f]} dims="3×2,5 m" onClick={() => onAdd({ type: 'area', fn: f })} />)}
        {tab === 'outros' && (
          <>
            <Item label="Parede interna" dims="3 m" onClick={() => onAdd({ type: 'wall' })} />
            {(Object.keys(DECOR_KINDS) as DecorKind[]).map((k) => (
              <Item key={k} label={DECOR_KINDS[k].label} dims={`${DECOR_KINDS[k].wCm}×${DECOR_KINDS[k].dCm}`} onClick={() => onAdd({ type: 'decor', kind: k })} />
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}

function Item({ label, dims, onClick }: { label: string; dims: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-line bg-white p-2 text-left text-xs hover:border-bronze-500 hover:bg-bronze-100" data-testid={`palette-${label}`}>
      <div className="font-semibold leading-tight">{label}</div>
      <div className="text-[10px] text-ink-muted">{dims} cm</div>
    </button>
  );
}

const num = (v: string) => Math.round(Number(v.replace(',', '.')) || 0);

function NumField({ label, value, onChange, suffix = 'cm', min }: { label: string; value: number; onChange: (n: number) => void; suffix?: string; min?: number }) {
  return (
    <label className="block text-xs">
      {label}
      <div className="mt-0.5 flex items-center rounded-lg border border-line-strong bg-white">
        <input
          type="number"
          className="w-full rounded-lg px-2 py-1 outline-none"
          value={value}
          min={min}
          onChange={(e) => onChange(num(e.target.value))}
          aria-label={label}
        />
        <span className="px-1.5 text-ink-muted">{suffix}</span>
      </div>
    </label>
  );
}

export function Properties({
  draft,
  sel,
  people,
  apply,
  onRotate,
  onDuplicate,
  onRemove,
  onClose,
}: {
  draft: LayoutContent;
  sel: Selection;
  people: GamePerson[];
  apply: (fn: (l: LayoutContent) => void) => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const locs = useItemLocations();
  if (!sel) return null;
  const st = draft.stations.find((s) => s.id === sel.id);
  const su = draft.storageUnits.find((s) => s.id === sel.id);
  const de = draft.doc.decor.find((s) => s.id === sel.id);
  const ar = draft.areas.find((s) => s.id === sel.id);
  const wl = draft.doc.walls.find((s) => s.id === sel.id);
  const o = st ?? su ?? de;
  const tools = (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {!ar ? <GBtn onClick={onRotate} title="Girar (R)">⟳ Girar</GBtn> : null}
      {!wl ? <GBtn onClick={onDuplicate} title="Duplicar (D)">⧉ Duplicar</GBtn> : null}
      <GBtn tone="danger" onClick={onRemove} title="Remover (Delete)" testId="remove-selected">🗑 Remover</GBtn>
    </div>
  );
  const pos = (x: number, y: number, setX: (n: number) => void, setY: (n: number) => void) => (
    <div className="grid grid-cols-2 gap-1.5">
      <NumField label="Posição X (oeste→leste)" value={x} onChange={setX} />
      <NumField label="Posição Y (norte→sul)" value={y} onChange={setY} />
    </div>
  );
  const upd = <T extends object>(find: (l: LayoutContent) => T | undefined, patch: Partial<NoInfer<T>>) =>
    apply((l) => {
      const t = find(l);
      if (t) Object.assign(t, patch);
    });
  return (
    <Panel title={st?.name ?? su?.label ?? de?.name ?? ar?.name ?? 'Parede'} subtitle={st ? STATION_KINDS[st.kind].label : su ? STORAGE_KINDS[su.kind].label : de ? DECOR_KINDS[de.kind].label : ar ? `Área · ${areaM2({ w: ar.wCm, d: ar.dCm })} m²` : 'Parede interna'} icon="📐" onClose={onClose} className="h-full" testId="properties">
      {tools}
      {o ? (
        <div className="space-y-2">
          <label className="block text-xs">
            Nome
            <input className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1" value={st?.name ?? su?.label ?? de?.name ?? ''} onChange={(e) => (st ? upd((l) => l.stations.find((x) => x.id === st.id), { name: e.target.value }) : su ? upd((l) => l.storageUnits.find((x) => x.id === su.id), { label: e.target.value }) : upd((l) => l.doc.decor.find((x) => x.id === de!.id), { name: e.target.value }))} aria-label="Nome" />
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            <NumField label="Largura" value={o.wCm} min={10} onChange={(n) => apply((l) => { const t = [...l.stations, ...l.storageUnits, ...l.doc.decor].find((x) => x.id === o.id); if (t) t.wCm = Math.max(10, n); })} />
            <NumField label="Profundidade" value={o.dCm} min={10} onChange={(n) => apply((l) => { const t = [...l.stations, ...l.storageUnits, ...l.doc.decor].find((x) => x.id === o.id); if (t) t.dCm = Math.max(10, n); })} />
          </div>
          {pos(o.xCm, o.yCm, (n) => apply((l) => { const t = [...l.stations, ...l.storageUnits, ...l.doc.decor].find((x) => x.id === o.id); if (t) t.xCm = n; }), (n) => apply((l) => { const t = [...l.stations, ...l.storageUnits, ...l.doc.decor].find((x) => x.id === o.id); if (t) t.yCm = n; }))}
          {st || su ? (
            <label className="block text-xs">
              Área
              <select className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1" value={(st ?? su)!.areaId ?? ''} onChange={(e) => apply((l) => { const t = [...l.stations, ...l.storageUnits].find((x) => x.id === o.id); if (t) t.areaId = e.target.value || null; })}>
                <option value="">(fora de área)</option>
                {draft.areas.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {st ? (
        <>
          <Section title="Funcionários vinculados">
            <p className="mb-1 text-xs text-ink-muted">Uma estação pode ser compartilhada; uma pessoa pode ter estações em várias etapas.</p>
            <div className="space-y-1">
              {people.map((p) => (
                <label key={p.userId} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={st.assigneeUserIds.includes(p.userId)}
                    onChange={(e) => apply((l) => { const t = l.stations.find((x) => x.id === st.id)!; t.assigneeUserIds = e.target.checked ? [...t.assigneeUserIds, p.userId] : t.assigneeUserIds.filter((u) => u !== p.userId); })}
                  />
                  <span className="inline-block size-2.5 rounded-full" style={{ background: p.color }} />
                  {p.name} <span className="text-ink-muted">({p.roles.join(', ')})</span>
                </label>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={st.shared} onChange={(e) => upd((l) => l.stations.find((x) => x.id === st.id), { shared: e.target.checked })} /> Estação compartilhada
            </label>
          </Section>
          <Section title="Etapas atendidas">
            <div className="grid grid-cols-2 gap-1">
              {Object.keys(ACTIVITY_LABEL_GAME).map((a) => (
                <label key={a} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={st.activities.includes(a)} onChange={(e) => apply((l) => { const t = l.stations.find((x) => x.id === st.id)!; t.activities = e.target.checked ? [...t.activities, a] : t.activities.filter((x) => x !== a); })} />
                  {ACTIVITY_LABEL_GAME[a]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">Sem etapas marcadas = atende qualquer etapa de quem está vinculado.</p>
          </Section>
        </>
      ) : null}
      {su ? <SlotsEditor draft={draft} unitId={su.id} apply={apply} /> : null}
      {ar ? (
        <div className="space-y-2">
          <label className="block text-xs">
            Nome
            <input className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1" value={ar.name} onChange={(e) => upd((l) => l.areas.find((x) => x.id === ar.id), { name: e.target.value })} aria-label="Nome da área" />
          </label>
          <label className="block text-xs">
            Função
            <select className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1" value={ar.function} onChange={(e) => upd((l) => l.areas.find((x) => x.id === ar.id), { function: e.target.value as AreaFunction })}>
              {AREA_FUNCTIONS.map((f) => (
                <option key={f} value={f}>{AREA_FUNCTION_LABEL[f]}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            <NumField label="Largura" value={ar.wCm} onChange={(n) => upd((l) => l.areas.find((x) => x.id === ar.id), { wCm: Math.max(50, n) })} />
            <NumField label="Profundidade" value={ar.dCm} onChange={(n) => upd((l) => l.areas.find((x) => x.id === ar.id), { dCm: Math.max(50, n) })} />
          </div>
          {pos(ar.xCm, ar.yCm, (n) => upd((l) => l.areas.find((x) => x.id === ar.id), { xCm: n }), (n) => upd((l) => l.areas.find((x) => x.id === ar.id), { yCm: n }))}
          <label className="block text-xs">
            Localização física no sistema
            <select className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1" value={ar.itemLocationId ?? ''} onChange={(e) => upd((l) => l.areas.find((x) => x.id === ar.id), { itemLocationId: e.target.value || null })}>
              <option value="">(nenhuma)</option>
              {locs.data?.map((x) => (
                <option key={x.id} value={x.id} disabled={draft.areas.some((a) => a.id !== ar.id && a.itemLocationId === x.id)}>{x.label}</option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-ink-muted">Quando alguém confirma a posição de uma peça nessa localização (embalagem, expedição…), o mapa mostra o alfinete azul nesta área.</p>
        </div>
      ) : null}
      {wl ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <NumField label="Início X" value={wl.x1} onChange={(n) => upd((l) => l.doc.walls.find((x) => x.id === wl.id), wl.y1 === wl.y2 ? { x1: n } : { x1: n, x2: n })} />
            <NumField label="Início Y" value={wl.y1} onChange={(n) => upd((l) => l.doc.walls.find((x) => x.id === wl.id), wl.y1 === wl.y2 ? { y1: n, y2: n } : { y1: n })} />
          </div>
          <NumField label="Comprimento" value={Math.abs(wl.x2 - wl.x1) + Math.abs(wl.y2 - wl.y1)} onChange={(n) => upd((l) => l.doc.walls.find((x) => x.id === wl.id), wl.y1 === wl.y2 ? { x2: wl.x1 + n } : { y2: wl.y1 + n })} />
          <DoorsFor draft={draft} wall={wl.id} length={Math.abs(wl.x2 - wl.x1) + Math.abs(wl.y2 - wl.y1)} apply={apply} />
        </div>
      ) : null}
    </Panel>
  );
}

function SlotsEditor({ draft, unitId, apply }: { draft: LayoutContent; unitId: string; apply: (fn: (l: LayoutContent) => void) => void }) {
  const unit = draft.storageUnits.find((u) => u.id === unitId)!;
  const [slot, setSlot] = useState<string | null>(unit.slots[0]?.id ?? null);
  const [q, setQ] = useState('');
  const search = useMaterialSearch(q, q.length >= 2);
  const cur = unit.slots.find((s) => s.id === slot);
  return (
    <Section title="Posições e materiais">
      <div className="mb-1.5 flex flex-wrap gap-1">
        {[...unit.slots].sort((a, b) => a.level - b.level).map((s) => (
          <button key={s.id} onClick={() => setSlot(s.id)} className={`rounded-lg border px-2 py-0.5 text-xs ${slot === s.id ? 'border-bronze-600 bg-bronze-500 text-white' : 'border-line-strong bg-white'}`}>{s.label}</button>
        ))}
        <button
          className="rounded-lg border border-dashed border-line-strong px-2 py-0.5 text-xs"
          onClick={() => apply((l) => { const u = l.storageUnits.find((x) => x.id === unitId)!; const n = u.slots.length + 1; u.slots.push({ id: newGameId(), label: `${STORAGE_KINDS[u.kind].slotWord} ${n}`, level: n, stockItemIds: [] }); })}
        >
          + posição
        </button>
      </div>
      {cur ? (
        <div className="space-y-1.5 text-xs">
          <div className="flex gap-1">
            <input className="flex-1 rounded-lg border border-line-strong px-2 py-1" value={cur.label} onChange={(e) => apply((l) => { const s = l.storageUnits.find((x) => x.id === unitId)!.slots.find((x) => x.id === cur.id)!; s.label = e.target.value; })} aria-label="Nome da posição" />
            <button className="rounded-lg px-2 text-danger-700" onClick={() => apply((l) => { const u = l.storageUnits.find((x) => x.id === unitId)!; u.slots = u.slots.filter((x) => x.id !== cur.id); })}>Remover</button>
          </div>
          <div className="text-ink-muted">Materiais nesta posição ({cur.stockItemIds.length}):</div>
          <LinkedMaterials ids={cur.stockItemIds} onRemove={(id) => apply((l) => { const s = l.storageUnits.find((x) => x.id === unitId)!.slots.find((x) => x.id === cur.id)!; s.stockItemIds = s.stockItemIds.filter((x) => x !== id); })} />
          <input className="w-full rounded-lg border border-line-strong px-2 py-1" placeholder="Vincular material do catálogo (ex.: espuma D28, grampo)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar material para vincular" />
          {search.data?.slice(0, 8).map((m) => (
            <button
              key={m.stockItemId}
              className="block w-full rounded-lg border border-line bg-white px-2 py-1 text-left hover:bg-subtle"
              disabled={cur.stockItemIds.includes(m.stockItemId)}
              onClick={() => apply((l) => { const s = l.storageUnits.find((x) => x.id === unitId)!.slots.find((x) => x.id === cur.id)!; if (!s.stockItemIds.includes(m.stockItemId)) s.stockItemIds.push(m.stockItemId); })}
            >
              <b>{m.code}</b> {m.description} <span className="text-ink-muted">{m.locations.length ? `· já em ${m.locations[0]!.address}` : m.legacyLocation ? `· cadastro: ${m.legacyLocation}` : ''}</span>
            </button>
          ))}
          <p className="text-[11px] text-ink-muted">Ao salvar, o endereço vai para o cadastro do material (campo Localização) no estoque oficial.</p>
        </div>
      ) : null}
    </Section>
  );
}

function LinkedMaterials({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  const all = useMaterialSearch('', ids.length > 0);
  if (!ids.length) return <p className="text-ink-muted">Nenhum.</p>;
  return (
    <ul className="space-y-0.5">
      {ids.map((id) => {
        const m = all.data?.find((x) => x.stockItemId === id);
        return (
          <li key={id} className="flex items-center justify-between rounded bg-subtle px-2 py-0.5">
            <span>{m ? `${m.code} ${m.description}` : id.slice(0, 8)}</span>
            <button className="text-danger-700" onClick={() => onRemove(id)} aria-label="Desvincular material">×</button>
          </li>
        );
      })}
    </ul>
  );
}

function DoorsFor({ draft, wall, length, apply }: { draft: LayoutContent; wall: string; length: number; apply: (fn: (l: LayoutContent) => void) => void }) {
  const doors = draft.doc.doors.filter((d) => d.wall === wall);
  return (
    <div className="space-y-1 text-xs">
      <div className="font-semibold">Portas nesta parede</div>
      {doors.map((d) => (
        <div key={d.id} className="grid grid-cols-[1fr_1fr_auto] items-end gap-1 rounded-lg bg-subtle p-1.5">
          <NumField label="Distância do início" value={d.offsetCm} onChange={(n) => apply((l) => { const x = l.doc.doors.find((y) => y.id === d.id)!; x.offsetCm = Math.max(0, Math.min(length - x.widthCm, n)); })} />
          <NumField label="Largura" value={d.widthCm} onChange={(n) => apply((l) => { const x = l.doc.doors.find((y) => y.id === d.id)!; x.widthCm = Math.max(60, n); })} />
          <button className="pb-1 text-danger-700" onClick={() => apply((l) => { l.doc.doors = l.doc.doors.filter((y) => y.id !== d.id); })}>×</button>
          <input className="col-span-3 rounded border border-line-strong px-1.5 py-0.5" placeholder="Nome (ex.: Portão de expedição)" value={d.label ?? ''} onChange={(e) => apply((l) => { l.doc.doors.find((y) => y.id === d.id)!.label = e.target.value; })} />
        </div>
      ))}
      <GBtn onClick={() => apply((l) => { l.doc.doors.push({ id: newGameId().slice(0, 8), wall, offsetCm: Math.max(0, Math.round(length / 2 - 50)), widthCm: 100, label: null }); })}>+ Abrir porta</GBtn>
    </div>
  );
}

/** Ambiente: medidas da sala, portas externas, planta ilustrativa, recomeçar e histórico. */
export function RoomSettings({
  draft,
  spaceKey,
  apply,
  spaces,
  onReset,
  onClose,
}: {
  draft: LayoutContent;
  spaceKey: string;
  apply: (fn: (l: LayoutContent) => void) => void;
  spaces: { key: string; name: string }[];
  onReset: (start: 'SUGERIDA' | 'EM_BRANCO') => void;
  onClose: () => void;
}) {
  const revs = useRevisions(spaceKey);
  const [wall, setWall] = useState('S');
  const walls = [
    { id: 'N', name: 'Norte (fundo)', len: draft.widthCm },
    { id: 'S', name: 'Sul (frente)', len: draft.widthCm },
    { id: 'O', name: 'Oeste (esquerda)', len: draft.depthCm },
    { id: 'L', name: 'Leste (direita)', len: draft.depthCm },
  ];
  const w = walls.find((x) => x.id === wall)!;
  return (
    <Panel title={`Ambiente · ${draft.name}`} subtitle={`${(draft.widthCm / 100).toLocaleString('pt-BR')} × ${(draft.depthCm / 100).toLocaleString('pt-BR')} m = ${areaM2({ w: draft.widthCm, d: draft.depthCm })} m²`} icon="🏠" onClose={onClose} className="h-full" testId="room-settings">
      <div className="space-y-2">
        <label className="block text-xs">
          Nome do ambiente
          <input className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1" value={draft.name} onChange={(e) => apply((l) => { l.name = e.target.value; })} aria-label="Nome do ambiente" />
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <NumField label="Largura (leste-oeste)" value={draft.widthCm} onChange={(n) => apply((l) => { l.widthCm = Math.max(200, n); })} />
          <NumField label="Profundidade (norte-sul)" value={draft.depthCm} onChange={(n) => apply((l) => { l.depthCm = Math.max(200, n); })} />
        </div>
        <NumField label="Grade" value={draft.gridCm} onChange={(n) => apply((l) => { l.gridCm = Math.min(200, Math.max(5, n)); })} />
        <label className="flex items-start gap-2 rounded-lg border border-warn-600/30 bg-warn-50 p-2 text-xs">
          <input type="checkbox" checked={draft.illustrative} onChange={(e) => apply((l) => { l.illustrative = e.target.checked; })} />
          <span><b>Medidas ilustrativas.</b> Desmarque quando a planta reproduzir as medidas reais da {draft.kind === 'ESCRITORIO' ? 'sala' : 'oficina'} (trena na mão).</span>
        </label>
      </div>
      <Section title="Portas nas paredes externas">
        <select className="mb-1.5 w-full rounded-lg border border-line-strong px-2 py-1 text-xs" value={wall} onChange={(e) => setWall(e.target.value)} aria-label="Parede">
          {walls.map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>
        <DoorsFor draft={draft} wall={wall} length={w.len} apply={apply} />
        <div className="mt-2 text-xs">
          Passagem para outro ambiente:
          {draft.doc.doors.filter((d) => d.wall === wall).map((d) => (
            <select key={d.id} className="mt-1 block w-full rounded border border-line-strong px-1.5 py-0.5" value={d.toSpaceKey ?? ''} onChange={(e) => apply((l) => { l.doc.doors.find((x) => x.id === d.id)!.toSpaceKey = e.target.value || null; })}>
              <option value="">{d.label ?? 'Porta'}: para a rua</option>
              {spaces.filter((s) => s.key !== spaceKey).map((s) => (
                <option key={s.key} value={s.key}>{d.label ?? 'Porta'}: leva a {s.name}</option>
              ))}
            </select>
          ))}
        </div>
      </Section>
      <Section title="Recomeçar">
        <div className="flex gap-1.5">
          <GBtn onClick={() => onReset('SUGERIDA')}>Da planta sugerida</GBtn>
          <GBtn tone="danger" onClick={() => onReset('EM_BRANCO')}>Do zero</GBtn>
        </div>
        <p className="mt-1 text-[11px] text-ink-muted">Recomeçar desfaz vínculos de estações e endereços do estoque (o histórico das versões fica guardado).</p>
      </Section>
      <Section title="Versões salvas">
        <ul className="space-y-0.5 text-xs">
          {revs.data?.slice(0, 8).map((r) => (
            <li key={r.version}><b>v{r.version}</b> · {fmtDateTime(r.createdAt)} · {r.createdBy ?? 'sistema'} — {r.summary}</li>
          ))}
        </ul>
      </Section>
    </Panel>
  );
}

/** Remoção com vínculos: mostra o impacto e pede o destino de cada vínculo. */
export function ImpactDialog({ impacts, onCancel, onConfirm }: { impacts: RemovalImpact[]; onCancel: () => void; onConfirm: (t: { areas: Record<string, string>; stations: Record<string, string>; slots: Record<string, string> }) => void }) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const ok = impacts.every((i) => choice[i.id]);
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Impacto da remoção">
      <Panel title="Antes de salvar: para onde vão os vínculos?" icon="⚠️" onClose={onCancel} className="max-h-[85vh] w-full max-w-lg" testId="impact-dialog">
        <p className="mb-3 text-xs text-ink-soft">Você removeu objetos que têm vínculos. Escolha o destino de cada um; nada se perde no histórico.</p>
        {impacts.map((i) => (
          <div key={i.id} className="mb-3 rounded-xl border border-warn-600/30 bg-warn-50 p-2.5 text-xs">
            <div className="font-bold">{i.kind === 'AREA' ? 'Área' : i.kind === 'ESTACAO' ? 'Estação' : 'Posição de estoque'}: {i.name}</div>
            <ul className="my-1 list-disc pl-4">
              {i.links.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <select className="w-full rounded-lg border border-line-strong bg-white px-2 py-1" value={choice[i.id] ?? ''} onChange={(e) => setChoice({ ...choice, [i.id]: e.target.value })} aria-label={`Destino de ${i.name}`}>
              <option value="">Transferir para…</option>
              {i.targets.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {!i.targets.length ? <p className="mt-1 text-danger-700">Não há destino compatível: crie um antes de remover (ou desfaça a remoção).</p> : null}
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <GBtn tone="ghost" onClick={onCancel}>Voltar</GBtn>
          <GBtn
            tone="primary"
            disabled={!ok}
            testId="impact-confirm"
            onClick={() => {
              const t = { areas: {} as Record<string, string>, stations: {} as Record<string, string>, slots: {} as Record<string, string> };
              for (const i of impacts) (i.kind === 'AREA' ? t.areas : i.kind === 'ESTACAO' ? t.stations : t.slots)[i.id] = choice[i.id]!;
              onConfirm(t);
            }}
          >
            Transferir e salvar
          </GBtn>
        </div>
      </Panel>
    </div>
  );
}

export function MestrePanel({
  history,
  onAsk,
  onApply,
  onDiscard,
  pending,
  onClose,
}: {
  history: { who: 'eu' | 'mestre'; text: string }[];
  onAsk: (q: string) => void;
  onApply: () => void;
  onDiscard: () => void;
  pending: MestreReply | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  return (
    <Panel title="Mestre de Obras" subtitle="Dicas de layout com medidas da sua planta" icon="🦺" onClose={onClose} className="h-full" testId="mestre-panel">
      <div className="space-y-2" data-testid="mestre-chat">
        {history.map((h, i) => (
          <div key={i} className={h.who === 'eu' ? 'ml-8 rounded-xl bg-brand-600 p-2 text-xs text-white' : 'mr-4 rounded-xl border border-[#e76f1a]/40 bg-[#fff3e6] p-2 text-xs whitespace-pre-wrap'}>
            {h.text}
          </div>
        ))}
      </div>
      {pending?.suggestion ? (
        <div className="mt-3 rounded-xl border-2 border-bronze-500 bg-bronze-100 p-2.5 text-xs">
          <div className="font-bold">Prévia: {pending.suggestion.title}</div>
          <div className="text-ink-soft">Marquei no mapa: local sugerido em bronze, caminho livre em verde, apertos em vermelho.</div>
          <div className="mt-2 flex gap-1.5">
            {Object.values(pending.suggestion.patch).some((v) => (Array.isArray(v) ? v.length : v)) ? (
              <GBtn tone="bronze" onClick={onApply} testId="mestre-apply">Aplicar ao rascunho</GBtn>
            ) : null}
            <GBtn tone="ghost" onClick={onDiscard}>Limpar marcações</GBtn>
          </div>
          <div className="mt-1 text-[11px] text-ink-muted">Aplicar não salva: ajuste arrastando e use Salvar. Desfazer com Ctrl+Z.</div>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-1">
        {(pending?.quickReplies.length ? pending.quickReplies : MESTRE_QUICK).map((x) => (
          <button key={x} className="rounded-full border border-[#e76f1a]/40 bg-[#fff3e6] px-2 py-0.5 text-left text-[11px]" onClick={() => onAsk(x)}>{x}</button>
        ))}
      </div>
      <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { onAsk(q); setQ(''); } }}>
        <input className="flex-1 rounded-xl border border-line-strong px-3 py-2 text-sm" placeholder="Pergunte ao Mestre de Obras…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pergunta ao Mestre de Obras" />
        <GBtn type="submit" tone="bronze">Perguntar</GBtn>
      </form>
    </Panel>
  );
}
