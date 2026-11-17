'use client';
/**
 * Recursos do jogo da rodada de melhorias de novembro de 2026:
 *  - boneco "Você" personalizado (cabelo, pele, roupa), salvo no servidor por pessoa;
 *  - furgão de retirada e entrega (dados de hoje do Cenário Gestão) e o painel da logística;
 *  - "Bom dia do Gerente": as 3 coisas que importam hoje, uma vez por dia;
 *  - imagem pronta para compartilhar quando a empresa bate a meta (ou fecha a semana);
 *  - aviso do navegador quando o jogo está em outra aba;
 *  - simulador "e se" (mais gente, mais pedidos, alguém fora): como ficam os prazos.
 * Nada aqui altera o Cenário Gestão: só lê (as rotas oficiais, pela conexão da empresa).
 */
import type { GamePieceDto, GameSnapshotDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Download,
  FlaskConical,
  type LucideIcon,
  Share2,
  Sun,
  Trophy,
  Truck,
  UserRound,
  Users,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cenarioUrl } from '@/lib/links';
import type { LogisticsView } from './engine';
import { drawIcon } from './icons';
import {
  type AvatarLook,
  HAIR_COLORS,
  HAIR_STYLES,
  PALETTE,
  PANTS_COLORS,
  SHIRT_COLORS,
} from './models';
import { isLate } from './placement';
import type { ProgressStore } from './progress';
import { GBtn, Panel, Section } from './ui';

const todaySP = (d = new Date()) =>
  d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const br = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';

function readLS(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, v: string) {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* sem armazenamento */
  }
}

// ───────────────────────────── Boneco ─────────────────────────────

export const DEFAULT_LOOK: AvatarLook = {
  skin: 1,
  hairStyle: 0,
  hairColor: HAIR_COLORS[0]!,
  shirt: PALETTE.bronze,
  pants: PANTS_COLORS[0]!,
};

function Swatches({
  colors,
  value,
  onPick,
  label,
}: {
  colors: readonly string[];
  value: string;
  onPick: (c: string) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          aria-label={c}
          onClick={() => onPick(c)}
          className={clsx(
            'size-8 rounded-full border-2 shadow-sm transition',
            value.toLowerCase() === c.toLowerCase()
              ? 'border-brand-600 ring-2 ring-brand-600/30'
              : 'border-white hover:scale-105',
          )}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

/** Painel "Seu boneco": a mudança aparece na hora no mapa; Salvar guarda para todo computador. */
export function AvatarPanel({
  look,
  onChange,
  onSave,
  onReset,
  saving,
  dirty,
  onClose,
}: {
  look: AvatarLook;
  onChange: (l: AvatarLook) => void;
  onSave: () => void;
  onReset: () => void;
  saving: boolean;
  dirty: boolean;
  onClose: () => void;
}) {
  const set = (p: Partial<AvatarLook>) => onChange({ ...look, ...p });
  return (
    <Panel
      title="Seu boneco"
      subtitle="Como você aparece no mapa (o “Você”)"
      icon={<UserRound className="size-5" />}
      onClose={onClose}
      testId="avatar-panel"
    >
      <Section title="Pele">
        <Swatches
          label="Pele"
          colors={PALETTE.skin}
          value={PALETTE.skin[look.skin] ?? PALETTE.skin[0]!}
          onPick={(c) => set({ skin: Math.max(0, PALETTE.skin.indexOf(c)) })}
        />
      </Section>
      <Section title="Cabelo">
        <div className="mb-2 flex flex-wrap gap-1">
          {HAIR_STYLES.map((h, i) => (
            <button
              key={h}
              type="button"
              onClick={() => set({ hairStyle: i })}
              className={clsx(
                'rounded-lg border px-2 py-1 text-xs font-semibold',
                look.hairStyle === i
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-line bg-white hover:bg-subtle',
              )}
            >
              {h}
            </button>
          ))}
        </div>
        <Swatches
          label="Cor do cabelo"
          colors={HAIR_COLORS}
          value={look.hairColor}
          onPick={(c) => set({ hairColor: c })}
        />
      </Section>
      <Section title="Camisa">
        <Swatches
          label="Camisa"
          colors={SHIRT_COLORS}
          value={look.shirt}
          onPick={(c) => set({ shirt: c })}
        />
      </Section>
      <Section title="Calça">
        <Swatches
          label="Calça"
          colors={PANTS_COLORS}
          value={look.pants}
          onPick={(c) => set({ pants: c })}
        />
      </Section>
      <div className="flex gap-2">
        <GBtn tone="primary" onClick={onSave} disabled={saving || !dirty} testId="avatar-save">
          {saving ? 'Salvando…' : 'Salvar'}
        </GBtn>
        <GBtn tone="ghost" onClick={onReset}>
          Voltar ao padrão
        </GBtn>
      </div>
      <p className="mt-2 text-[11px] text-ink-muted">
        Fica guardado na sua conta: aparece igual em qualquer computador ou celular.
      </p>
    </Panel>
  );
}

// ───────────────────────────── Logística de hoje ─────────────────────────────

interface DeliveryRow {
  id: string;
  code: string;
  status: string;
  origin?: 'LOGISTICA' | 'DIRETA';
  customer: { name: string };
  region?: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  completedAt: string | null;
  departedAt: string | null;
}
interface PickupRow {
  id: string;
  code: string;
  status: string;
  customer: { name: string } & Record<string, unknown>;
  windowStart: string | null;
  windowEnd: string | null;
  address?: { neighborhood?: string | null; city?: string | null } | null;
}
export interface TodayLogistics {
  deliveries: DeliveryRow[];
  pickups: PickupRow[];
}

const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;
/** Nome do cliente curto para o mapa (empresa fica inteira: "Hotel Vista Alegre"). */
const shortName = (n: string) => {
  const t = n.replace(/^\[[^\]]*\]\s*/, '').trim();
  return t.length > 24 ? `${t.slice(0, 23)}…` : t;
};

/** Entregas e retiradas de hoje (rotas oficiais do Cenário; sem permissão, fica vazio). */
export function useTodayLogistics(enabled: boolean) {
  return useQuery({
    queryKey: ['game-logistics', todaySP()],
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async (): Promise<TodayLogistics> => {
      const d = todaySP();
      const [deliveries, pickups] = await Promise.all([
        api<DeliveryRow[]>(`/api/v1/deliveries?from=${d}&to=${d}`).catch(() => []),
        api<PickupRow[]>(`/api/v1/pickups?from=${d}&to=${d}`).catch(() => []),
      ]);
      return { deliveries, pickups };
    },
  });
}

/** Converte para o que o mapa mostra (furgão no pátio ou na rua; cliente na entrada). */
export function logisticsView(l: TodayLogistics | undefined): LogisticsView | null {
  if (!l) return null;
  const trips: LogisticsView['trips'] = [];
  for (const d of l.deliveries) {
    if (d.status === 'CANCELADA' || d.status === 'PROVISORIA' || d.origin === 'DIRETA') continue;
    trips.push({
      id: d.id,
      kind: 'ENTREGA',
      customer: shortName(d.customer.name),
      status:
        d.status === 'EM_TRANSPORTE' || d.status === 'NO_DESTINO'
          ? 'NA_RUA'
          : d.status === 'CONCLUIDA'
            ? 'FEITA'
            : d.status === 'FRUSTRADA'
              ? 'PROBLEMA'
              : 'AGENDADA',
    });
  }
  for (const p of l.pickups) {
    if (p.status === 'CANCELADA' || p.status === 'AGUARDANDO_AGENDAMENTO') continue;
    trips.push({
      id: p.id,
      kind: 'RETIRADA',
      customer: shortName(p.customer.name),
      status:
        p.status === 'EM_EXECUCAO'
          ? 'NA_RUA'
          : p.status === 'RETIRADA_REALIZADA' || p.status === 'RECEBIDA_NA_OFICINA'
            ? 'FEITA'
            : p.status === 'COM_OCORRENCIA'
              ? 'PROBLEMA'
              : 'AGENDADA',
    });
  }
  // Cliente que buscou na oficina (entrega direta) nas últimas 2 horas: aparece na entrada.
  const recent = l.deliveries
    .filter(
      (d) =>
        d.origin === 'DIRETA' &&
        d.completedAt &&
        Date.now() - new Date(d.completedAt).getTime() < 2 * 3600_000,
    )
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
  return {
    trips,
    visitor: recent ? { id: recent.id, name: shortName(recent.customer.name) } : null,
  };
}

const TRIP_STATUS: Record<string, { label: string; cls: string }> = {
  AGENDADA: { label: 'Agendada', cls: 'bg-subtle text-ink-soft' },
  NA_RUA: { label: 'Na rua', cls: 'bg-bronze-100 text-bronze-600' },
  FEITA: { label: 'Feita', cls: 'bg-ok-50 text-ok-600' },
  PROBLEMA: { label: 'Com problema', cls: 'bg-danger-50 text-danger-600' },
};

export function LogisticsPanel({
  data,
  loading,
  onClose,
}: {
  data: TodayLogistics | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  const view = logisticsView(data);
  const rows = [
    ...(data?.deliveries ?? [])
      .filter((d) => d.status !== 'CANCELADA')
      .map((d) => ({
        id: d.id,
        code: d.code,
        kind: d.origin === 'DIRETA' ? 'Cliente buscou' : 'Entrega',
        customer: d.customer.name,
        where: d.region ?? '',
        window: d.windowStart ? `${d.windowStart}${d.windowEnd ? `–${d.windowEnd}` : ''}` : '',
        status: view?.trips.find((t) => t.id === d.id)?.status ?? 'FEITA',
      })),
    ...(data?.pickups ?? [])
      .filter((p) => p.status !== 'CANCELADA')
      .map((p) => ({
        id: p.id,
        code: p.code,
        kind: 'Retirada',
        customer: p.customer.name,
        where: [p.address?.neighborhood, p.address?.city].filter(Boolean).join(', '),
        window: p.windowStart ? `${p.windowStart}${p.windowEnd ? `–${p.windowEnd}` : ''}` : '',
        status: view?.trips.find((t) => t.id === p.id)?.status ?? 'AGENDADA',
      })),
  ].sort((a, b) => a.window.localeCompare(b.window));
  return (
    <Panel
      title="Furgão · roteiro de hoje"
      subtitle={new Date().toLocaleDateString('pt-BR', {
        weekday: 'long',
        day: '2-digit',
        month: 'long',
      })}
      icon={<Truck className="size-5" />}
      onClose={onClose}
      testId="logistics-panel"
    >
      {loading ? <p className="text-xs text-ink-muted">Carregando…</p> : null}
      {!loading && !rows.length ? (
        <p className="text-xs text-ink-soft">
          Nenhuma entrega ou retirada marcada para hoje. Quando o furgão sair, ele some do pátio e
          volta quando a viagem for concluída no Cenário.
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-line bg-white p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <b className="truncate">
                {r.kind} · {r.customer}
              </b>
              <span
                className={clsx(
                  'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  TRIP_STATUS[r.status]?.cls,
                )}
              >
                {TRIP_STATUS[r.status]?.label}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between gap-2 text-ink-soft">
              <span className="truncate">
                {r.code}
                {r.where ? ` · ${r.where}` : ''}
              </span>
              <span className="shrink-0">{r.window}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <a
          className="text-xs font-semibold text-brand-700 underline"
          href={cenarioUrl('/painel/roteiro')}
          target="_blank"
          rel="noreferrer"
        >
          Abrir o roteiro no Cenário
        </a>
      </div>
    </Panel>
  );
}

// ───────────────────────────── Bom dia do Gerente ─────────────────────────────

export interface MorningItem {
  key: 'atrasos' | 'saidas' | 'faltas';
  icon: LucideIcon;
  title: string;
  detail: string;
  tone: 'ok' | 'warn' | 'danger';
  action?: { label: string; run: () => void };
}

const greeting = (h = new Date().getHours()) =>
  h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';

/** As 3 coisas que importam hoje, a partir do retrato da oficina e do roteiro. */
export function morningItems(
  snap: GameSnapshotDto | undefined,
  log: TodayLogistics | undefined,
  actions: { late: () => void; trips: () => void; people: () => void },
): MorningItem[] {
  const late = (snap?.pieces ?? []).filter((p) => isLate(p));
  const due = (snap?.pieces ?? []).filter(
    (p) =>
      p.promisedDate?.slice(0, 10) === todaySP() &&
      !isLate(p) &&
      !/PRONTA|ENTREG|TRANSP/.test(p.stage),
  );
  const v = logisticsView(log);
  const trips = (v?.trips ?? []).filter((t) => t.status !== 'FEITA');
  const ent = trips.filter((t) => t.kind === 'ENTREGA').length;
  const ret = trips.filter((t) => t.kind === 'RETIRADA').length;
  const absent = (snap?.employees ?? []).filter((e) =>
    [
      'AUSENCIA_PRESUMIDA',
      'AUSENCIA_CONFIRMADA',
      'AUSENCIA_JUSTIFICADA',
      'ATESTADO',
      'FOLGA',
      'FERIAS',
    ].includes(e.attendance ?? ''),
  );
  const pieceName = (p: GamePieceDto) =>
    `${p.osCode}${p.customerName ? ` (${firstName(p.customerName)})` : ''}`;
  return [
    {
      key: 'atrasos',
      icon: TriangleAlert,
      title: late.length
        ? `${late.length} ${late.length === 1 ? 'peça atrasada' : 'peças atrasadas'}`
        : due.length
          ? `${due.length} ${due.length === 1 ? 'peça vence' : 'peças vencem'} hoje`
          : 'Nenhuma peça atrasada',
      detail: late.length
        ? late.slice(0, 3).map(pieceName).join(', ') +
          (late.length > 3 ? ` e mais ${late.length - 3}` : '')
        : due.length
          ? due.slice(0, 3).map(pieceName).join(', ')
          : 'Todos os prazos em dia.',
      tone: late.length ? 'danger' : due.length ? 'warn' : 'ok',
      ...(late.length ? { action: { label: 'Ver no mapa', run: actions.late } } : {}),
    },
    {
      key: 'saidas',
      icon: Truck,
      title:
        ent || ret
          ? [
              ent ? `${ent} ${ent === 1 ? 'entrega' : 'entregas'}` : '',
              ret ? `${ret} ${ret === 1 ? 'retirada' : 'retiradas'}` : '',
            ]
              .filter(Boolean)
              .join(' e ') + ' hoje'
          : 'Sem entregas nem retiradas hoje',
      detail: trips.length
        ? trips
            .slice(0, 3)
            .map((t) => `${t.kind === 'ENTREGA' ? 'Entrega' : 'Retirada'}: ${t.customer}`)
            .join(' · ')
        : 'O furgão fica no pátio.',
      tone: trips.length ? 'warn' : 'ok',
      ...(trips.length ? { action: { label: 'Ver roteiro', run: actions.trips } } : {}),
    },
    {
      key: 'faltas',
      icon: Users,
      title: absent.length
        ? `${absent.length} ${absent.length === 1 ? 'pessoa fora' : 'pessoas fora'} hoje`
        : 'Equipe completa',
      detail: absent.length
        ? absent
            .slice(0, 4)
            .map((e) => firstName(e.name))
            .join(', ')
        : `${(snap?.employees ?? []).length} pessoas na oficina.`,
      tone: absent.length ? 'warn' : 'ok',
      ...(absent.length ? { action: { label: 'Ver equipe', run: actions.people } } : {}),
    },
  ];
}

const morningKey = (orgId: string, userId: string) => `firma-bom-dia:${orgId}:${userId}`;
export const morningSeenToday = (orgId: string, userId: string) =>
  readLS(morningKey(orgId, userId)) === todaySP();
export const markMorningSeen = (orgId: string, userId: string) =>
  writeLS(morningKey(orgId, userId), todaySP());

export function GoodMorning({
  name,
  items,
  onClose,
}: {
  name: string;
  items: MorningItem[];
  onClose: () => void;
}) {
  const toneCls = {
    ok: 'border-ok-600/25 bg-ok-50 text-ok-600',
    warn: 'border-bronze-500/30 bg-bronze-100/70 text-bronze-600',
    danger: 'border-danger-600/25 bg-danger-50 text-danger-600',
  };
  return (
    <div
      className="pointer-events-auto absolute inset-0 z-40 grid place-items-center bg-ink/30 p-3 backdrop-blur-[2px]"
      data-testid="good-morning"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border-2 border-bronze-500/60 bg-[#fffaf2] shadow-pop"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Resumo do dia"
      >
        <div className="flex items-center gap-3 border-b border-bronze-500/25 bg-gradient-to-r from-[#f5ebdf] to-[#fffaf2] px-4 py-3">
          <div className="grid size-10 place-items-center rounded-full bg-bronze-500 text-white">
            <Sun className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-bold">
              {greeting()}, {firstName(name)}
            </div>
            <div className="text-xs text-ink-soft">
              O Gerente separou o que importa hoje,{' '}
              {new Date().toLocaleDateString('pt-BR', {
                weekday: 'long',
                day: '2-digit',
                month: 'long',
              })}
              .
            </div>
          </div>
        </div>
        <ul className="space-y-2 p-4">
          {items.map((it) => (
            <li
              key={it.key}
              className="flex items-start gap-3 rounded-xl border border-line bg-white p-2.5"
              data-testid={`morning-${it.key}`}
            >
              <span
                className={clsx(
                  'grid size-8 shrink-0 place-items-center rounded-lg border',
                  toneCls[it.tone],
                )}
              >
                <it.icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold">{it.title}</div>
                <div className="text-xs text-ink-soft">{it.detail}</div>
              </div>
              {it.action ? (
                <button
                  className="shrink-0 self-center rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-subtle"
                  onClick={() => {
                    it.action!.run();
                    onClose();
                  }}
                >
                  {it.action.label}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex justify-end border-t border-line px-4 py-3">
          <GBtn tone="primary" onClick={onClose} testId="morning-close">
            Começar o dia
          </GBtn>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Imagem para compartilhar ─────────────────────────────

export interface ShareCard {
  /** Linha pequena acima do título (ex.: "Meta conquistada"). */
  kicker: string;
  title: string;
  /** Destaque grande (ex.: valor ou número). Opcional. */
  big?: string | null;
  lines: string[];
  company: string;
  icon?: LucideIcon;
  /** Nome do arquivo (sem extensão). */
  file: string;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) {
      out.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/** Desenha o cartão 1080 × 1080 (formato do Instagram e do WhatsApp) e devolve o PNG. */
export async function renderShareCard(c: ShareCard): Promise<Blob> {
  const S = 1080;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d')!;
  try {
    await document.fonts?.ready;
  } catch {
    /* segue com a fonte que houver */
  }
  // Fundo creme com moldura bronze e faixa escura no rodapé.
  ctx.fillStyle = '#fffaf2';
  ctx.fillRect(0, 0, S, S);
  const grd = ctx.createLinearGradient(0, 0, S, S);
  grd.addColorStop(0, '#f5ebdf');
  grd.addColorStop(1, '#fffaf2');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = '#a8743f';
  ctx.lineWidth = 14;
  ctx.strokeRect(36, 36, S - 72, S - 72);
  ctx.fillStyle = '#1d2523';
  ctx.fillRect(43, S - 200, S - 86, 157);
  // Ícone em círculo.
  ctx.fillStyle = '#a8743f';
  ctx.beginPath();
  ctx.arc(S / 2, 230, 92, 0, Math.PI * 2);
  ctx.fill();
  drawIcon(ctx, c.icon ?? Trophy, S / 2 - 52, 178, 104, '#ffffff');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#a8743f';
  ctx.font = '700 34px Inter, system-ui, sans-serif';
  ctx.fillText(c.kicker.toUpperCase(), S / 2, 380);
  ctx.fillStyle = '#1d2523';
  ctx.font = '800 68px Inter, system-ui, sans-serif';
  let y = 470;
  for (const l of wrap(ctx, c.title, S - 200).slice(0, 2)) {
    ctx.fillText(l, S / 2, y);
    y += 80;
  }
  if (c.big) {
    ctx.fillStyle = '#1f7a46';
    ctx.font = '800 96px Inter, system-ui, sans-serif';
    ctx.fillText(c.big, S / 2, y + 40);
    y += 120;
  }
  ctx.fillStyle = '#4a5553';
  ctx.font = '500 38px Inter, system-ui, sans-serif';
  for (const l of c.lines.slice(0, 3)) {
    for (const w of wrap(ctx, l, S - 220).slice(0, 2)) {
      if (y > S - 250) break;
      ctx.fillText(w, S / 2, y);
      y += 52;
    }
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 46px Inter, system-ui, sans-serif';
  ctx.fillText(c.company, S / 2, S - 112);
  ctx.fillStyle = '#d9c3a5';
  ctx.font = '500 28px Inter, system-ui, sans-serif';
  ctx.fillText(
    new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }),
    S / 2,
    S - 66,
  );
  return new Promise((res, rej) =>
    cv.toBlob(
      (b) => (b ? res(b) : rej(new Error('Não foi possível gerar a imagem.'))),
      'image/png',
    ),
  );
}

/** Prévia + Compartilhar (WhatsApp e Instagram pelo celular) + Baixar. */
export function ShareDialog({
  card,
  onClose,
  options,
}: {
  card: ShareCard;
  onClose: () => void;
  /** Escolhas que mudam o cartão (ex.: mostrar o valor). */
  options?: React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const blob = useRef<Blob | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const key = JSON.stringify({ ...card, icon: undefined });
  useEffect(() => {
    let alive = true;
    let u: string | null = null;
    void renderShareCard(card).then((b) => {
      if (!alive) return;
      blob.current = b;
      u = URL.createObjectURL(b);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fileName = `${card.file}.png`;
  const download = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  };
  const share = async () => {
    if (!blob.current) return;
    const file = new File([blob.current], fileName, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({
          files: [file],
          title: card.title,
          text: `${card.title} · ${card.company}`,
        });
        return;
      } catch {
        return; // cancelado pela pessoa
      }
    }
    download();
    setMsg('Imagem baixada. Agora é só anexar no WhatsApp ou no Instagram.');
  };
  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 grid place-items-center bg-ink/40 p-3"
      onClick={onClose}
      data-testid="share-dialog"
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Compartilhar"
      >
        <div className="border-b border-line px-4 py-3 text-base font-bold">Compartilhar</div>
        <div className="p-4">
          <div className="aspect-square w-full overflow-hidden rounded-xl border border-line bg-subtle">
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element -- imagem gerada no navegador (blob)
              <img src={url} alt={card.title} className="size-full" />
            ) : null}
          </div>
          {options ? <div className="mt-2 text-xs">{options}</div> : null}
          {msg ? <p className="mt-2 text-xs text-ok-600">{msg}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <GBtn tone="ghost" onClick={onClose}>
            Fechar
          </GBtn>
          <GBtn onClick={download} disabled={!url}>
            <Download className="size-4" /> Baixar
          </GBtn>
          <GBtn tone="primary" onClick={() => void share()} disabled={!url} testId="share-go">
            <Share2 className="size-4" /> Compartilhar
          </GBtn>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Aviso do navegador ─────────────────────────────

const NOTIFY_KEY = 'firma-avisos-navegador';
export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;
export function notifyEnabled() {
  return notifySupported() && Notification.permission === 'granted' && readLS(NOTIFY_KEY) === '1';
}
export async function setNotify(on: boolean) {
  if (!notifySupported()) return false;
  if (on && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') {
      writeLS(NOTIFY_KEY, '0');
      return false;
    }
  }
  writeLS(NOTIFY_KEY, on ? '1' : '0');
  return on;
}

/**
 * Com o jogo em outra aba (ou minimizado), avisa: peça pronta, peça que atrasou e mensagem nova
 * no atendimento. Clicar no aviso volta para o jogo.
 */
export function useTabNotifications(
  snap: GameSnapshotDto | undefined,
  unread: number,
  onOpen: (pieceId: string | null) => void,
) {
  const prev = useRef<GameSnapshotDto | null>(null);
  const prevUnread = useRef<number | null>(null);
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    const before = prev.current;
    prev.current = snap ?? null;
    if (!snap || !before || !document.hidden || !notifyEnabled()) return;
    const READY = ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE'];
    const old = new Map(before.pieces.map((p) => [p.id, p]));
    const msgs: { title: string; body: string; id: string }[] = [];
    for (const p of snap.pieces) {
      const o = old.get(p.id);
      if (!o) continue;
      const who = `${p.osCode}${p.customerName ? ` · ${p.customerName}` : ''}`;
      if (!READY.includes(o.stage) && READY.includes(p.stage))
        msgs.push({ id: p.id, title: 'Peça pronta', body: `${p.description} (${who})` });
      else if (!isLate(o) && isLate(p))
        msgs.push({
          id: p.id,
          title: 'Peça atrasou',
          body: `${p.description} (${who}): prazo ${br(p.promisedDate)}`,
        });
    }
    for (const m of msgs.slice(0, 3)) {
      const n = new Notification(`Firma Viva · ${m.title}`, {
        body: m.body,
        tag: `firma-${m.id}`,
        icon: '/icon.svg',
      });
      n.onclick = () => {
        window.focus();
        openRef.current(m.id);
        n.close();
      };
    }
  }, [snap]);
  useEffect(() => {
    const before = prevUnread.current;
    prevUnread.current = unread;
    if (before === null || unread <= before || !document.hidden || !notifyEnabled()) return;
    const n = new Notification('Firma Viva · Mensagem nova', {
      body:
        unread - before === 1
          ? 'Chegou uma mensagem nova no atendimento.'
          : `Chegaram ${unread - before} mensagens novas no atendimento.`,
      tag: 'firma-inbox',
      icon: '/icon.svg',
    });
    n.onclick = () => {
      window.focus();
      openRef.current(null);
      n.close();
    };
  }, [unread]);
}

export function NotifyToggle() {
  // Só aparece dentro do menu de ajustes (no navegador), então lê direto na criação.
  const [on, setOn] = useState(() => notifyEnabled());
  const [denied, setDenied] = useState(
    () => notifySupported() && Notification.permission === 'denied',
  );
  if (!notifySupported()) return null;
  const opt = (sel: boolean) =>
    clsx(
      'rounded-lg border px-2 py-1 text-xs font-semibold',
      sel ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white hover:bg-subtle',
    );
  return (
    <>
      <div className="mb-1 font-bold">Avisos com o jogo em outra aba</div>
      <div className="mb-1 flex gap-1">
        <button
          className={opt(on)}
          data-testid="notify-on"
          onClick={() =>
            void setNotify(true).then((ok) => {
              setOn(ok);
              setDenied(Notification.permission === 'denied');
            })
          }
        >
          Ligados
        </button>
        <button className={opt(!on)} onClick={() => void setNotify(false).then(() => setOn(false))}>
          Desligados
        </button>
      </div>
      <div className="mb-3 text-[11px] text-ink-muted">
        {denied
          ? 'O navegador bloqueou os avisos deste site. Libere no cadeado ao lado do endereço.'
          : 'Peça pronta, peça que atrasou e mensagem nova no atendimento.'}
      </div>
    </>
  );
}

// ───────────────────────────── Simulador "e se" ─────────────────────────────

const PRODUCTION_ROLES = /tapec|costur|cabec|ajud|corte|marcen|espuma|produ|qualid/i;

interface SimPiece {
  id: string;
  label: string;
  promised: string | null;
  steps: number;
  isNew?: boolean;
}

/** Dias úteis (segunda a sábado de manhã contam como 5,5 dias por semana). */
function addWorkdays(from: Date, days: number) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w === 0) continue;
    left -= w === 6 ? 0.5 : 1;
  }
  return d;
}
const iso = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

/**
 * Projeção simples e explicada: cada pessoa da produção conclui, em média, N etapas por dia útil
 * (medido nas últimas 2 semanas do próprio placar). As peças entram na fila pelo prazo prometido;
 * a capacidade do dia vai para as primeiras da fila.
 */
export function simulate(
  pieces: SimPiece[],
  people: number,
  rate: number,
  extra: { add: number; out: number; outDays: number; newOrders: number; stepsPerNew: number },
) {
  const queue = [
    ...pieces,
    ...Array.from({ length: extra.newOrders }, (_, i) => ({
      id: `novo-${i}`,
      label: `Pedido novo ${i + 1}`,
      promised: null,
      steps: extra.stepsPerNew,
      isNew: true,
    })),
  ].sort((a, b) => (a.promised ?? '9999').localeCompare(b.promised ?? '9999'));
  const remaining = new Map(queue.map((p) => [p.id, p.steps]));
  const finish = new Map<string, string>();
  const start = new Date();
  let day = 0;
  while (finish.size < queue.length && day < 400) {
    day++;
    const date = addWorkdays(start, day);
    const w = date.getDay();
    const factor = w === 6 ? 0.5 : 1;
    const crew = Math.max(0, people + extra.add - (day <= extra.outDays ? extra.out : 0));
    let cap = crew * rate * factor;
    for (const p of queue) {
      if (cap <= 0) break;
      const r = remaining.get(p.id)!;
      if (r <= 0) continue;
      const used = Math.min(cap, r);
      remaining.set(p.id, r - used);
      cap -= used;
      if (r - used <= 1e-6) finish.set(p.id, iso(date));
    }
    if (crew === 0 && day > extra.outDays) break;
  }
  return queue.map((p) => ({
    ...p,
    finish: finish.get(p.id) ?? null,
    late: Boolean(p.promised && (!finish.get(p.id) || finish.get(p.id)! > p.promised.slice(0, 10))),
  }));
}

function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 20,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-xs">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="grid size-7 place-items-center rounded-lg border border-line bg-white font-bold hover:bg-subtle disabled:opacity-40"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          aria-label={`Diminuir: ${label}`}
        >
          −
        </button>
        <span className="w-14 text-center text-sm font-bold tabular-nums">
          {value}
          {suffix ? (
            <span className="text-[11px] font-medium text-ink-muted"> {suffix}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-lg border border-line bg-white font-bold hover:bg-subtle disabled:opacity-40"
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          aria-label={`Aumentar: ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

export function SimulatorPanel({
  snap,
  store,
  onClose,
  onPiece,
}: {
  snap: GameSnapshotDto | undefined;
  store: ProgressStore | null;
  onClose: () => void;
  onPiece: (id: string) => void;
}) {
  const [add, setAdd] = useState(0);
  const [out, setOut] = useState(0);
  const [outDays, setOutDays] = useState(5);
  const [newOrders, setNewOrders] = useState(0);
  const [openedAt] = useState(() => Date.now());

  const base = useMemo(() => {
    const employees = (snap?.employees ?? []).filter(
      (e) => e.roles.some((r) => PRODUCTION_ROLES.test(r)) || e.stationIds.length || e.queue.length,
    );
    const people = Math.max(1, employees.length);
    // Ritmo: etapas concluídas nos últimos 14 dias (placar guardado) por pessoa por dia útil.
    const cut = iso(new Date(openedAt - 14 * 864e5));
    const recent = Object.values(store?.tasks ?? {}).filter(([, d]) => d >= cut);
    const days = 11; // 14 dias corridos ≈ 11 dias úteis (com meio sábado)
    const measured = recent.length / days / people;
    const rate = measured >= 0.3 ? Math.min(8, measured) : 2.5;
    const pieces: SimPiece[] = (snap?.pieces ?? [])
      .filter(
        (p) =>
          !['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE', 'ENTREGUE'].includes(p.stage),
      )
      .map((p) => ({
        id: p.id,
        label: `${p.osCode} · ${p.description}`,
        promised: p.promisedDate,
        steps: Math.max(
          1,
          p.tasks.filter((t) => t.status !== 'CONCLUIDA' && t.status !== 'CANCELADA').length,
        ),
      }));
    const avgSteps = pieces.length
      ? Math.round(
          (snap?.pieces ?? []).reduce((a, p) => a + Math.max(1, p.tasks.length), 0) /
            Math.max(1, (snap?.pieces ?? []).length),
        )
      : 5;
    return { people, rate, measured: measured >= 0.3, pieces, avgSteps: Math.max(2, avgSteps) };
  }, [snap, store, openedAt]);

  const now = useMemo(
    () =>
      simulate(base.pieces, base.people, base.rate, {
        add: 0,
        out: 0,
        outDays: 0,
        newOrders: 0,
        stepsPerNew: base.avgSteps,
      }),
    [base],
  );
  const sim = useMemo(
    () =>
      simulate(base.pieces, base.people, base.rate, {
        add,
        out: Math.min(out, base.people),
        outDays,
        newOrders,
        stepsPerNew: base.avgSteps,
      }),
    [base, add, out, outDays, newOrders],
  );
  const lateNow = now.filter((p) => p.late).length;
  const lateSim = sim.filter((p) => p.late).length;
  const lastNow =
    now
      .map((p) => p.finish ?? '')
      .sort()
      .at(-1) ?? '';
  const lastSim =
    sim
      .map((p) => p.finish ?? '')
      .sort()
      .at(-1) ?? '';
  const changed = add || out || newOrders;
  const nowMap = new Map(now.map((p) => [p.id, p.finish]));
  const moved = sim.filter((p) => !p.isNew && p.finish !== nowMap.get(p.id)).slice(0, 8);
  const newOnes = sim.filter((p) => p.isNew);

  return (
    <Panel
      title="Simulador: e se…?"
      subtitle="Veja como ficam os prazos antes de decidir"
      icon={<FlaskConical className="size-5" />}
      onClose={onClose}
      testId="simulator-panel"
    >
      <Section title="O que mudar">
        <Stepper label="Contratar mais tapeceiros" value={add} onChange={setAdd} max={10} />
        <Stepper label="Aceitar mais pedidos" value={newOrders} onChange={setNewOrders} max={30} />
        <Stepper
          label="Pessoas fora (férias, atestado)"
          value={out}
          onChange={setOut}
          max={base.people}
        />
        {out ? (
          <Stepper
            label="Por quantos dias úteis"
            value={outDays}
            onChange={setOutDays}
            min={1}
            max={30}
            suffix="dias"
          />
        ) : null}
      </Section>
      <div className="mb-3 grid grid-cols-2 gap-2 text-center">
        <div className="rounded-xl border border-line bg-white p-2">
          <div className="text-[11px] font-semibold text-ink-muted uppercase">Hoje</div>
          <div className={clsx('text-xl font-black', lateNow ? 'text-danger-600' : 'text-ok-600')}>
            {lateNow}
          </div>
          <div className="text-[11px] text-ink-soft">peça(s) fora do prazo</div>
          <div className="mt-1 text-[11px] text-ink-muted">tudo pronto em {br(lastNow) || '—'}</div>
        </div>
        <div
          className={clsx(
            'rounded-xl border p-2',
            !changed
              ? 'border-line bg-white'
              : lateSim > lateNow
                ? 'border-danger-600/30 bg-danger-50'
                : lateSim < lateNow
                  ? 'border-ok-600/30 bg-ok-50'
                  : 'border-bronze-500/30 bg-bronze-100/60',
          )}
          data-testid="sim-result"
        >
          <div className="text-[11px] font-semibold text-ink-muted uppercase">Com a mudança</div>
          <div className={clsx('text-xl font-black', lateSim ? 'text-danger-600' : 'text-ok-600')}>
            {lateSim}
          </div>
          <div className="text-[11px] text-ink-soft">peça(s) fora do prazo</div>
          <div className="mt-1 text-[11px] text-ink-muted">tudo pronto em {br(lastSim) || '—'}</div>
        </div>
      </div>
      {changed && (moved.length || newOnes.length) ? (
        <Section title="O que muda">
          <ul className="space-y-1 text-xs">
            {moved.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-subtle"
                  onClick={() => onPiece(p.id)}
                >
                  <span className="truncate">{p.label}</span>
                  <span
                    className={clsx(
                      'shrink-0 tabular-nums',
                      p.late ? 'font-bold text-danger-600' : 'text-ink-soft',
                    )}
                  >
                    {br(nowMap.get(p.id))} → {br(p.finish)}
                  </span>
                </button>
              </li>
            ))}
            {newOnes.length ? (
              <li className="flex justify-between gap-2 px-1 text-ink-soft">
                <span>{newOnes.length} pedido(s) novo(s) ficariam prontos até</span>
                <b>
                  {br(
                    newOnes
                      .map((p) => p.finish ?? '')
                      .sort()
                      .at(-1),
                  )}
                </b>
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}
      <p className="text-[11px] text-ink-muted">
        Conta usada: {base.people} pessoa(s) na produção, cada uma concluindo{' '}
        {base.rate.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} etapa(s) por dia útil
        {base.measured
          ? ' (média das últimas 2 semanas)'
          : ' (estimativa: ainda há pouco histórico)'}
        ; pedido novo com {base.avgSteps} etapas; fila pela data prometida; sábado conta meio dia. É
        uma projeção para ajudar a decidir: nada é alterado.
      </p>
    </Panel>
  );
}

/** Cartão "Batemos a meta" (o valor só aparece se a pessoa marcar). */
export function GoalShare({
  goal,
  company,
  onClose,
}: {
  goal: { name: string; targetCents: number; achieved: { at: string } | null };
  company: string;
  onClose: () => void;
}) {
  const [showValue, setShowValue] = useState(false);
  const at = goal.achieved?.at ?? new Date().toISOString();
  const month = new Date(`${at.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  });
  const card: ShareCard = {
    kicker: 'Meta conquistada',
    title: `Batemos a meta ${goal.name.trim().toLowerCase().startsWith('de ') ? goal.name : `“${goal.name}”`}`,
    big: showValue ? brl(goal.targetCents) : null,
    lines: [`Conquistada em ${br(at)}.`, `Obrigado à equipe pelo trabalho de ${month}.`],
    company,
    icon: Trophy,
    file: `meta-${goal.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  };
  return (
    <ShareDialog
      card={card}
      onClose={onClose}
      options={
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showValue}
            onChange={(e) => setShowValue(e.target.checked)}
          />
          Mostrar o valor da meta na imagem
        </label>
      }
    />
  );
}

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
