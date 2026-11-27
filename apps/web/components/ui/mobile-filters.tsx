'use client';

import clsx from 'clsx';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

/**
 * Filtros recolhíveis no celular: abaixo de `sm` mostra só o botão "Filtros" (com quantos estão
 * em uso); a partir de `sm` os filtros ficam sempre abertos, como antes.
 */
export function MobileFilters({
  active = 0,
  className,
  children,
}: {
  /** Quantos filtros diferentes do padrão estão em uso. */
  active?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mb-2 inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink-soft sm:hidden"
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {open ? 'Esconder filtros' : 'Filtros'}
        {active > 0 && (
          <span className="rounded-full bg-brand-50 px-1.5 text-xs text-brand-700">{active}</span>
        )}
      </button>
      <div className={clsx(!open && 'hidden sm:block')}>{children}</div>
    </div>
  );
}
