'use client';

import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface TabDef {
  key: string;
  label: string;
  /** Aba de módulo futuro: visível, mas não selecionável. */
  disabledNote?: string;
  count?: number;
}

/**
 * Abas acessíveis (role=tablist, setas do teclado).
 * Reformulação, Fase 2 (P2): quando as abas não cabem, a aba ativa entra na área visível sozinha
 * (inclusive ao abrir por link `?tab=`) e as bordas mostram que há mais abas (sombra + seta).
 */
export function Tabs({
  tabs,
  active,
  onChange,
  children,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (key: string) => void;
  children: React.ReactNode;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const enabled = tabs.filter((t) => !t.disabledNote);
  const measure = useCallback(() => {
    const el = list.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);
  const activeIndex = tabs.findIndex((t) => t.key === active);
  useEffect(() => {
    refs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [activeIndex, measure]);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, tabs.length]);
  const scrollBy = (dx: number) => list.current?.scrollBy({ left: dx, behavior: 'smooth' });
  return (
    <div>
      <div className="relative">
        <div
          ref={list}
          role="tablist"
          className="flex gap-1 overflow-x-auto border-b border-line"
          aria-orientation="horizontal"
          onScroll={measure}
          data-overflow={edges.left || edges.right ? 'true' : 'false'}
        >
          {tabs.map((t, i) => {
            const selected = t.key === active;
            return (
              <button
                key={t.key}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                role="tab"
                id={`${id}-tab-${t.key}`}
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                aria-disabled={t.disabledNote ? true : undefined}
                tabIndex={selected ? 0 : -1}
                title={t.disabledNote}
                onClick={() => !t.disabledNote && onChange(t.key)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  const idx = enabled.findIndex((x) => x.key === active);
                  const next =
                    enabled[
                      (idx + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length
                    ]!;
                  onChange(next.key);
                  refs.current[tabs.indexOf(next)]?.focus();
                }}
                className={clsx(
                  '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap',
                  selected
                    ? 'border-brand-700 text-brand-700'
                    : t.disabledNote
                      ? 'cursor-not-allowed border-transparent text-ink-muted/70'
                      : 'border-transparent text-ink-soft hover:text-ink',
                )}
              >
                {t.label}
                {t.count !== undefined && (
                  <span className="rounded-full bg-subtle px-1.5 text-xs text-ink-muted">
                    {t.count}
                  </span>
                )}
                {t.disabledNote && <Lock className="size-3" aria-hidden />}
              </button>
            );
          })}
        </div>
        {edges.left && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Ver abas anteriores"
            data-testid="tabs-more-left"
            onClick={() => scrollBy(-240)}
            className="absolute inset-y-0 left-0 flex w-10 items-center justify-start bg-gradient-to-r from-canvas via-canvas/90 to-transparent text-ink-soft"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        {edges.right && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Ver mais abas"
            data-testid="tabs-more-right"
            onClick={() => scrollBy(240)}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-canvas via-canvas/90 to-transparent text-ink-soft"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
        className="pt-5"
      >
        {children}
      </div>
    </div>
  );
}
