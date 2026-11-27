import type { QuoteWorkDto } from '@cenario/shared';
import clsx from 'clsx';
import { Check, HelpCircle, X } from 'lucide-react';

/**
 * 2026-11-19 (Raphael): o que o orçamento diz sobre a execução, mostrado do mesmo jeito na tela de
 * gerar OS e na página da OS do tapeceiro — cada informação uma vez só.
 */

const qty = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

/** "Trocar tecido: Sim" etc. como marcas: verde = fazer, cinza = não fazer, amarelo = avaliar. */
export function WorkChecks({ checks, large }: { checks: QuoteWorkDto['checks']; large?: boolean }) {
  if (!checks.length) return null;
  return (
    <ul className={clsx('flex flex-wrap gap-2', large ? 'text-[15px]' : 'text-sm')}>
      {checks.map((c) => {
        const yes = c.value === 'Sim';
        const maybe = c.value !== 'Sim' && c.value !== 'Não';
        return (
          <li
            key={c.label}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ring-1 ring-inset',
              yes && 'bg-ok-50 text-ok-600 ring-ok-600/30',
              maybe && 'bg-warn-50 text-warn-600 ring-warn-600/30',
              !yes && !maybe && 'bg-subtle text-ink-muted ring-line line-through decoration-1',
            )}
          >
            {yes ? (
              <Check className="size-4" aria-hidden />
            ) : maybe ? (
              <HelpCircle className="size-4" aria-hidden />
            ) : (
              <X className="size-4" aria-hidden />
            )}
            {c.label}
            {maybe && <span className="font-normal">· {c.value.toLowerCase()}</span>}
            <span className="sr-only">: {c.value}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Tecido com a metragem do orçamento. */
export function fabricText(name: string | null | undefined, meters: number | null): string {
  const parts = [name?.trim() || 'A definir'];
  if (meters) parts.push(`${qty(meters)} m`);
  return parts.join(' · ');
}

/** Materiais do orçamento, com as medidas da espuma. */
export function WorkMaterials({ materials }: { materials: QuoteWorkDto['materials'] }) {
  if (!materials.length)
    return <span className="text-ink-muted">Nenhum material no orçamento</span>;
  return (
    <ul className="divide-y divide-line">
      {materials.map((m, i) => (
        <li
          key={i}
          className="flex items-baseline justify-between gap-4 py-1.5 first:pt-0 last:pb-0"
        >
          <span className="min-w-0">
            {m.name}
            {m.size && <span className="ml-2 text-ink-muted tabular-nums">{m.size}</span>}
          </span>
          <span className="shrink-0 tabular-nums text-ink-soft">
            {qty(m.quantity)} {m.unit}
          </span>
        </li>
      ))}
    </ul>
  );
}
