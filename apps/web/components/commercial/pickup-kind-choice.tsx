'use client';

import type { PickupKind } from '@cenario/shared';
import clsx from 'clsx';
import { House, Truck } from 'lucide-react';

/**
 * 2026-11-25: em todo agendamento, Retirada (a peça vem para a tapeçaria) ou No local (o serviço
 * é feito na casa do cliente). Dois botões grandes, um clique.
 */
const OPTIONS: { kind: PickupKind; title: string; hint: string; icon: typeof Truck }[] = [
  { kind: 'RETIRADA', title: 'Retirada', hint: 'A peça vem para a tapeçaria', icon: Truck },
  {
    kind: 'NO_LOCAL',
    title: 'No local',
    hint: 'O serviço é feito na casa do cliente',
    icon: House,
  },
];

export function PickupKindChoice({
  value,
  onChange,
}: {
  value: PickupKind;
  onChange: (v: PickupKind) => void;
}) {
  return (
    <fieldset data-testid="pickup-kind">
      <legend className="mb-2 text-sm font-semibold">Onde o serviço é feito</legend>
      <div className="grid grid-cols-2 gap-3">
        {OPTIONS.map((o) => {
          const on = value === o.kind;
          const Icon = o.icon;
          return (
            <button
              key={o.kind}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(o.kind)}
              data-testid={`pickup-kind-${o.kind}`}
              className={clsx(
                'flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition',
                on
                  ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                  : 'border-line hover:bg-subtle',
              )}
            >
              <Icon
                className={clsx('mt-0.5 size-5 shrink-0', on ? 'text-brand-600' : 'text-ink-muted')}
                aria-hidden
              />
              <span>
                <span className="block text-sm font-semibold">{o.title}</span>
                <span className="block text-xs text-ink-muted">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Palavras do agendamento conforme o tipo (Retirada ou No local). */
export function pickupWords(kind: PickupKind) {
  return kind === 'NO_LOCAL'
    ? {
        noun: 'Serviço no local',
        date: 'Data do serviço',
        pieces: 'Peças do serviço',
        schedule: 'Agendar serviço no local',
        qty: 'Quantidade no serviço de',
      }
    : {
        noun: 'Retirada',
        date: 'Data da retirada',
        pieces: 'Peças a retirar',
        schedule: 'Agendar retirada',
        qty: 'Quantidade a retirar de',
      };
}
