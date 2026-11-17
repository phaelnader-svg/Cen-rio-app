/**
 * Ícones do jogo: um só conjunto (lucide, de linha), no lugar dos emojis.
 *
 * Partes do jogo (e textos que vêm do pacote compartilhado, como as fases da peça) ainda
 * descrevem um ícone por emoji. Aqui cada emoji vira o ícone de linha equivalente, tanto na
 * interface (React) quanto nas etiquetas desenhadas no mapa (canvas). Emoji sem equivalente
 * some do texto: nada com cara de aplicativo de mensagem aparece para o usuário.
 */
import {
  AlarmClock,
  Archive,
  Armchair,
  Ban,
  BedDouble,
  Bot,
  Box,
  BrickWall,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  Check,
  CircleCheck,
  CircleHelp,
  ClipboardList,
  DoorOpen,
  Eye,
  FileText,
  Flag,
  GraduationCap,
  HardHat,
  Hourglass,
  House,
  Image as ImageIcon,
  Inbox,
  Instagram,
  Keyboard,
  type LucideIcon,
  MapPin,
  MessageCircle,
  NotebookPen,
  Package,
  Pause,
  Phone,
  Play,
  Plug,
  Receipt,
  Rewind,
  Ruler,
  Scissors,
  Search,
  Settings,
  Sofa,
  Sparkles,
  Star,
  Target,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Trophy,
  Truck,
  Volume2,
  VolumeX,
  Wallet,
  Warehouse,
  Wrench,
} from 'lucide-react';
import { Children, Fragment, type ReactNode, createElement } from 'react';

/** Emoji (sem o seletor de variação) → ícone de linha. */
const MAP: Record<string, LucideIcon> = {
  '⌨': Keyboard,
  '⏪': Rewind,
  '⏰': AlarmClock,
  '⏳': Hourglass,
  '⏸': Pause,
  '▶': Play,
  '⚙': Settings,
  '⚠': TriangleAlert,
  '⛔': Ban,
  '✅': CircleCheck,
  '✓': Check,
  '✔': Check,
  '❔': CircleHelp,
  '⭐': Star,
  '🎉': Sparkles,
  '🎓': GraduationCap,
  '🎯': Target,
  '🏁': Flag,
  '🏆': Trophy,
  '🏠': House,
  '🏢': Building2,
  '👁': Eye,
  '👷': HardHat,
  '🦺': HardHat,
  '💬': MessageCircle,
  '💰': Wallet,
  '💺': Armchair,
  '🪑': Armchair,
  '💼': Briefcase,
  '📄': FileText,
  '📈': TrendingUp,
  '📋': ClipboardList,
  '📍': MapPin,
  '📐': Ruler,
  '📝': NotebookPen,
  '📥': Inbox,
  '📦': Package,
  '📷': Camera,
  '📸': Instagram,
  '🔇': VolumeX,
  '🔊': Volume2,
  '🔌': Plug,
  '🔍': Search,
  '🔎': Search,
  '🖼': ImageIcon,
  '🗄': Archive,
  '🗑': Trash2,
  '🗓': CalendarDays,
  '🚚': Truck,
  '🚪': DoorOpen,
  '🛋': Sofa,
  '🛏': BedDouble,
  '🛠': Wrench,
  '🟢': Phone,
  '🟫': Box,
  '🤖': Bot,
  '🧱': BrickWall,
  '🧵': Scissors,
  '🪡': Scissors,
  '🧾': Receipt,
  '🏭': Warehouse,
};

/** Emojis e símbolos usados como ícone (com o seletor de variação opcional). */
const EMOJI =
  /(?:[\u{1F000}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2600}-\u{27BF}]|[\u{2B00}-\u{2BFF}]|[▶◀])️?/gu;

const key = (e: string) => e.replace(/️/g, '');

/** O ícone de linha de um emoji (ou null se não houver equivalente). */
export function iconOf(emoji: string | null | undefined): LucideIcon | null {
  return emoji ? (MAP[key(emoji)] ?? null) : null;
}

/** Texto sem emojis (para avisos e títulos que são só texto). */
export function stripEmoji(s: string) {
  return s
    .replace(EMOJI, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Separa o primeiro ícone do texto: "⏸ pausado" → { icon: Pause, text: "pausado" }. */
export function splitIcon(s: string): { icon: LucideIcon | null; text: string } {
  let icon: LucideIcon | null = null;
  for (const m of s.matchAll(EMOJI)) {
    icon = iconOf(m[0]);
    if (icon) break;
  }
  return { icon, text: stripEmoji(s) };
}

/** Um ícone do jogo, no tamanho da letra em volta. */
export function Ic({
  e,
  icon,
  className,
}: {
  e?: string | null;
  icon?: LucideIcon | null;
  className?: string;
}) {
  const I = icon ?? iconOf(e);
  if (!I) return null;
  // createElement: o ícone vem de uma tabela fixa (não é um componente novo a cada render).
  return createElement(I, {
    className: className ?? 'inline-block size-[1.1em] shrink-0 align-[-0.18em]',
    strokeWidth: 2.1,
    'aria-hidden': true,
  });
}

/** Troca, dentro de um texto, cada emoji pelo ícone de linha correspondente. */
export function iconText(s: string): ReactNode {
  if (!EMOJI.test(s)) return s;
  EMOJI.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(EMOJI)) {
    const before = s.slice(last, m.index);
    if (before) out.push(before);
    const I = iconOf(m[0]);
    if (I) out.push(<Ic key={k++} icon={I} />);
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = s.slice(last);
  if (rest) out.push(rest);
  // Sem ícone equivalente, sobra espaço duplo onde estava o emoji.
  return out.map((x, i) =>
    typeof x === 'string' ? <Fragment key={`t${i}`}>{x.replace(/\s{2,}/g, ' ')}</Fragment> : x,
  );
}

/** Aplica `iconText` a cada trecho de texto dos filhos. */
export function IconText({ children }: { children?: ReactNode }) {
  return (
    <>{Children.map(children, (c) => (typeof c === 'string' ? iconText(c) : (c as ReactNode)))}</>
  );
}

// ───────────────────────────── Canvas (etiquetas do mapa) ─────────────────────────────

type Node = [string, Record<string, string | number>];

/** Os traços do ícone, lidos do próprio componente do lucide (24×24). */
function nodesOf(I: LucideIcon): Node[] | null {
  try {
    const el = (
      I as unknown as { render: (p: object, r: null) => { props?: { iconNode?: Node[] } } }
    ).render({}, null);
    return el?.props?.iconNode ?? null;
  } catch {
    return null;
  }
}

const nodeCache = new Map<LucideIcon, Node[] | null>();

/** Desenha um ícone de linha no canvas, com o canto superior esquerdo em (x, y). */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  I: LucideIcon,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  if (!nodeCache.has(I)) nodeCache.set(I, nodesOf(I));
  const nodes = nodeCache.get(I);
  if (!nodes) return false;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const n = (v: string | number | undefined) => Number(v ?? 0);
  for (const [tag, a] of nodes) {
    ctx.beginPath();
    if (tag === 'path') {
      ctx.stroke(new Path2D(String(a.d)));
      continue;
    }
    if (tag === 'circle') ctx.arc(n(a.cx), n(a.cy), n(a.r), 0, Math.PI * 2);
    else if (tag === 'ellipse') ctx.ellipse(n(a.cx), n(a.cy), n(a.rx), n(a.ry), 0, 0, Math.PI * 2);
    else if (tag === 'rect') ctx.roundRect(n(a.x), n(a.y), n(a.width), n(a.height), n(a.rx));
    else if (tag === 'line') {
      ctx.moveTo(n(a.x1), n(a.y1));
      ctx.lineTo(n(a.x2), n(a.y2));
    } else if (tag === 'polyline' || tag === 'polygon') {
      const pts = String(a.points)
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        if (i) ctx.lineTo(pts[i]!, pts[i + 1]!);
        else ctx.moveTo(pts[i]!, pts[i + 1]!);
      }
      if (tag === 'polygon') ctx.closePath();
    }
    ctx.stroke();
  }
  ctx.restore();
  return true;
}
