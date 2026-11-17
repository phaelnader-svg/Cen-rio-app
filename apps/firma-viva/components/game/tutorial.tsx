'use client';
/**
 * Tutorial do primeiro acesso, guiado pela Gerente (personagem): abrir uma peça, passar uma etapa
 * para alguém, falar com a Firma, ir ao escritório e falar com o Gerente. Cada passo termina
 * sozinho quando a pessoa faz a ação (ou pode ser pulado). Fica guardado como visto neste navegador.
 */
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { GBtn } from './ui';

export type TutorialEvent = 'piece' | 'assign' | 'chat' | 'office' | 'agent' | 'missions';

export interface TutorialStep {
  id: string;
  title: string;
  text: string;
  /** Evento que conclui o passo (sem evento = botão Próximo). */
  until?: TutorialEvent;
  /** Para onde a seta aponta: objeto do mapa (id) ou elemento da tela (seletor). */
  point?: { map: string } | { dom: string } | null;
}

export const TUTORIAL_KEY = 'firma-tutorial-v1';

export function tutorialSeen() {
  try {
    return window.localStorage.getItem(TUTORIAL_KEY) === 'visto';
  } catch {
    return true;
  }
}

export function buildSteps(o: {
  pieceId: string | null;
  employeeName: string | null;
  hasOffice: boolean;
  gerenteId: string | null;
  canAssign: boolean;
}): TutorialStep[] {
  const s: TutorialStep[] = [
    {
      id: 'oi',
      title: 'Bem-vindo à sua oficina!',
      text: 'Tudo que você vê aqui é a sua empresa de verdade: cada sofá é uma OS do Cenário, e cada pessoa é alguém da equipe trabalhando agora. Vou te mostrar o básico em 1 minuto.',
    },
  ];
  if (o.pieceId)
    s.push({
      id: 'peca',
      title: 'Clique numa peça',
      text: 'A aparência muda conforme a etapa: desmontada, só a estrutura, com espuma, com a capa nova e embalada. Clique nesta para ver a ficha.',
      until: 'piece',
      point: { map: o.pieceId },
    });
  if (o.pieceId && o.canAssign && o.employeeName)
    s.push({
      id: 'atribuir',
      title: 'Passe uma etapa arrastando',
      text: `Arraste a peça até um funcionário (por exemplo, ${o.employeeName}) para passar a próxima etapa para ele. Nada muda sem você confirmar.`,
      until: 'assign',
      point: { map: o.pieceId },
    });
  s.push({
    id: 'chat',
    title: 'Fale com a Firma',
    text: 'Aqui embaixo você escreve do seu jeito: "onde está o sofá da Mariana?", "quem está livre?", "abre a OS 12". Experimente uma pergunta.',
    until: 'chat',
    point: { dom: '[data-testid="cenaria-chat"], [data-testid="chat-open"]' },
  });
  if (o.hasOffice)
    s.push({
      id: 'escritorio',
      title: 'Vá ao escritório',
      text: 'No escritório ficam os agentes que preparam mensagens, finanças e metas para você aprovar.',
      until: 'office',
      point: { dom: '[data-testid="space-ESCRITORIO"]' },
    });
  if (o.hasOffice && o.gerenteId)
    s.push({
      id: 'gerente',
      title: 'Fale com o Gerente',
      text: 'Clique no Gerente para ver o resumo do dia e o que ele sugere.',
      until: 'agent',
      point: { map: o.gerenteId },
    });
  s.push({
    id: 'missoes',
    title: 'Missões do dia',
    text: 'Aqui ficam as missões ligadas ao trabalho real (zerar atrasos, concluir etapas). Cada uma dá pontos, sobe o nível da oficina e libera decoração nova.',
    until: 'missions',
    point: { dom: '[data-testid="missions-chip"]' },
  });
  return s;
}

/** Rosto da guia (Gerente) em blocos, no mesmo estilo dos personagens do mapa. */
function GuideFace() {
  return (
    <svg viewBox="0 0 48 48" className="size-14 shrink-0 drop-shadow" aria-hidden>
      <rect x="4" y="4" width="40" height="40" rx="10" fill="#ede9fe" />
      <rect x="11" y="9" width="26" height="9" rx="2" fill="#3a2a20" />
      <rect x="12" y="14" width="24" height="22" rx="3" fill="#f1c7a5" />
      <rect x="11" y="13" width="26" height="5" rx="2" fill="#3a2a20" />
      <rect x="17" y="21" width="4" height="4" rx="1" fill="#1d2523" />
      <rect x="27" y="21" width="4" height="4" rx="1" fill="#1d2523" />
      <rect x="20" y="30" width="8" height="2" rx="1" fill="#8a4b3c" />
      <rect x="8" y="17" width="4" height="9" rx="2" fill="#7c3aed" />
      <rect x="36" y="17" width="4" height="9" rx="2" fill="#7c3aed" />
      <rect x="8" y="6" width="32" height="3" rx="1.5" fill="#4c1d95" />
      <rect x="11" y="38" width="26" height="6" rx="2" fill="#5b21b6" />
    </svg>
  );
}

/** Altura da seta, em px. */
const ARROW = 44;

interface Pointer {
  /** Ponta da seta (px na janela). */
  x: number;
  y: number;
  dir: 'up' | 'down';
  /** Contorno pulsando em volta do botão alvo. */
  ring?: { l: number; t: number; w: number; h: number };
}

/** Onde pôr a seta para o passo atual. */
function pointerFor(
  point: TutorialStep['point'],
  locate: (id: string, heightM?: number) => { x: number; y: number } | null,
  card: HTMLElement | null,
): Pointer | null {
  if (!point) return null;
  const c = card?.getBoundingClientRect();
  const hitsCard = (x: number, y0: number, y1: number) =>
    Boolean(c && x > c.left - 20 && x < c.right + 20 && y1 > c.top && y0 < c.bottom);
  if ('map' in point) {
    const top = locate(point.map, 1.4);
    if (!top) return null;
    // Acima do objeto, apontando para baixo; se ali estiver o cartão ou a borda, vem por baixo.
    if (top.y - ARROW > 70 && !hitsCard(top.x, top.y - ARROW, top.y))
      return { ...top, dir: 'down' };
    const base = locate(point.map, 0) ?? top;
    return { x: base.x, y: base.y + 6, dir: 'up' };
  }
  const el = [...document.querySelectorAll<HTMLElement>(point.dom)].find(
    (x) => x.offsetParent !== null,
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const ring = { l: r.left, t: r.top, w: r.width, h: r.height };
  const x = r.left + r.width / 2;
  const roomAbove = r.top;
  const roomBelow = window.innerHeight - r.bottom;
  // Botões do topo: a seta fica embaixo e aponta para cima. Os de baixo: em cima, para baixo.
  if (roomAbove > ARROW + 70 && roomAbove >= roomBelow && !hitsCard(x, r.top - ARROW - 8, r.top))
    return { x, y: r.top - 8, dir: 'down', ring };
  return { x, y: r.bottom + 8, dir: 'up', ring };
}

/** Seta grossa, no roxo da Gerente, com contorno branco para aparecer em qualquer fundo. */
function PointerArrow({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg
      width="36"
      height={ARROW}
      viewBox="0 0 36 44"
      style={{
        transform: dir === 'up' ? 'rotate(180deg)' : undefined,
        filter: 'drop-shadow(0 3px 4px rgba(30, 10, 60, 0.35))',
      }}
    >
      <path
        d="M11 3 h14 a2 2 0 0 1 2 2 v16 h6 a1.5 1.5 0 0 1 1.1 2.5 L19.1 40.4 a1.5 1.5 0 0 1 -2.2 0 L1.9 23.5 A1.5 1.5 0 0 1 3 21 h6 V5 a2 2 0 0 1 2 -2 z"
        fill="#7c3aed"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M13 7 h3 v14 h-3 z" fill="#a78bfa" opacity="0.8" />
    </svg>
  );
}

export function Tutorial({
  steps,
  events,
  locate,
  onClose,
}: {
  steps: TutorialStep[];
  /** Eventos que já aconteceram desde o início do tutorial. */
  events: Set<TutorialEvent>;
  /** Posição na tela de um objeto do mapa. */
  locate: (id: string, heightM?: number) => { x: number; y: number } | null;
  onClose: (finished: boolean) => void;
}) {
  const [i, setI] = useState(0);
  const [arrow, setArrow] = useState<Pointer | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = steps[Math.min(i, steps.length - 1)]!;
  const last = i >= steps.length - 1;

  // Avança sozinho quando a ação do passo acontece.
  useEffect(() => {
    if (step.until && events.has(step.until)) {
      const t = window.setTimeout(() => (last ? onClose(true) : setI((x) => x + 1)), 500);
      return () => window.clearTimeout(t);
    }
  }, [events, step, last, onClose]);

  // Seta acompanhando o alvo (a câmera pode mexer). Ela fica do lado com espaço livre e aponta
  // sempre para o alvo: abaixo dele apontando para cima, ou acima apontando para baixo.
  useEffect(() => {
    let raf = 0;
    let lastKey = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const next = pointerFor(step.point, locate, card.current);
      const key = next
        ? `${Math.round(next.x)}|${Math.round(next.y)}|${next.dir}|${next.ring ? Math.round(next.ring.t) : ''}`
        : '';
      if (key !== lastKey) {
        lastKey = key;
        setArrow(next);
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step, locate]);

  // O cartão desce quando a seta precisa ficar logo abaixo de um botão do topo.
  const cardTop =
    arrow && arrow.dir === 'up' && arrow.y < 200 ? Math.round(arrow.y + ARROW + 14) : null;

  return (
    <>
      {arrow?.ring ? (
        <div
          className="pointer-events-none fixed z-40 rounded-2xl"
          style={{
            left: arrow.ring.l - 5,
            top: arrow.ring.t - 5,
            width: arrow.ring.w + 10,
            height: arrow.ring.h + 10,
            animation: 'tut-ring 1.4s ease-out infinite',
          }}
          aria-hidden
        />
      ) : null}
      {arrow ? (
        <div
          className="pointer-events-none fixed z-40"
          style={{
            left: arrow.x,
            top: arrow.y,
            transform: arrow.dir === 'down' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          }}
          data-testid="tutorial-arrow"
          data-dir={arrow.dir}
          aria-hidden
        >
          <div
            style={{
              animation: `${arrow.dir === 'down' ? 'tut-nudge-down' : 'tut-nudge-up'} 0.9s ease-in-out infinite`,
            }}
          >
            <PointerArrow dir={arrow.dir} />
          </div>
        </div>
      ) : null}
      <div
        ref={card}
        className="animate-pop-in pointer-events-auto absolute top-[6.75rem] left-1/2 z-40 w-[min(400px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border-2 border-[#7c3aed]/50 bg-[#fffaf2] p-3 shadow-pop sm:top-[5rem]"
        style={cardTop ? { top: cardTop } : undefined}
        data-testid="tutorial"
        data-hud
      >
        <div className="flex gap-3">
          <GuideFace />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold tracking-wider text-[#5b21b6] uppercase">
              Gerente · passo {i + 1} de {steps.length}
            </div>
            <div className="text-sm font-black text-ink">{step.title}</div>
            <p className="mt-1 text-xs text-ink-soft">{step.text}</p>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <div className="flex flex-1 gap-1">
            {steps.map((s, k) => (
              <span
                key={s.id}
                className={clsx(
                  'h-1.5 flex-1 rounded-full',
                  k < i ? 'bg-[#7c3aed]' : k === i ? 'bg-[#a78bfa]' : 'bg-line',
                )}
              />
            ))}
          </div>
          <GBtn tone="ghost" onClick={() => onClose(false)} testId="tutorial-skip">
            Pular
          </GBtn>
          <GBtn
            tone="primary"
            onClick={() => (last ? onClose(true) : setI(i + 1))}
            testId="tutorial-next"
          >
            {last ? 'Concluir' : step.until ? 'Próximo' : 'Começar'}
          </GBtn>
        </div>
      </div>
    </>
  );
}
