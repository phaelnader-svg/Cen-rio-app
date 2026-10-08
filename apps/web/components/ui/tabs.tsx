'use client';

import clsx from 'clsx';
import { Lock } from 'lucide-react';
import { useId, useRef } from 'react';

export interface TabDef {
  key: string;
  label: string;
  /** Aba de módulo futuro: visível, mas não selecionável. */
  disabledNote?: string;
  count?: number;
}

/** Abas acessíveis (role=tablist, setas do teclado). */
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
  const enabled = tabs.filter((t) => !t.disabledNote);
  return (
    <div>
      <div
        role="tablist"
        className="flex gap-1 overflow-x-auto border-b border-line"
        aria-orientation="horizontal"
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
