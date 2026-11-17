'use client';
/**
 * Tutorial do primeiro acesso, guiado pela Gerente (personagem): abrir uma peça, passar uma etapa
 * para alguém, falar com a Firma, ir ao escritório e falar com o Gerente. Cada passo termina
 * sozinho quando a pessoa faz a ação (ou pode ser pulado). Fica guardado como visto neste navegador.
 */
import clsx from 'clsx';
import { useEffect, useState } from 'react';
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
  locate: (id: string) => { x: number; y: number } | null;
  onClose: (finished: boolean) => void;
}) {
  const [i, setI] = useState(0);
  const [arrow, setArrow] = useState<{ x: number; y: number } | null>(null);
  const step = steps[Math.min(i, steps.length - 1)]!;
  const last = i >= steps.length - 1;

  // Avança sozinho quando a ação do passo acontece.
  useEffect(() => {
    if (step.until && events.has(step.until)) {
      const t = window.setTimeout(() => (last ? onClose(true) : setI((x) => x + 1)), 500);
      return () => window.clearTimeout(t);
    }
  }, [events, step, last, onClose]);

  // Seta acompanhando o alvo (a câmera pode mexer).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const p = step.point;
      if (!p) return setArrow(null);
      if ('map' in p) setArrow(locate(p.map));
      else {
        const el = [...document.querySelectorAll<HTMLElement>(p.dom)].find(
          (x) => x.offsetParent !== null,
        );
        if (!el) return setArrow(null);
        const r = el.getBoundingClientRect();
        setArrow({ x: r.left + r.width / 2, y: r.top < 120 ? r.bottom + 46 : r.top });
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step, locate]);

  return (
    <>
      {arrow ? (
        <div
          className="pointer-events-none fixed z-40 text-4xl drop-shadow-lg"
          style={{
            left: arrow.x,
            top: arrow.y,
            animation: 'point 0.9s ease-in-out infinite',
          }}
          aria-hidden
        >
          👇
        </div>
      ) : null}
      <div
        className="animate-pop-in pointer-events-auto absolute top-[6.75rem] left-1/2 z-40 w-[min(400px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border-2 border-[#7c3aed]/50 bg-[#fffaf2] p-3 shadow-pop sm:top-[5rem]"
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
