'use client';

import { IDLE_NOTICE_DAYS, type PlatformCompanyDto } from '@cenario/shared';
import clsx from 'clsx';
import { Check, MessageCircle } from 'lucide-react';

const LEVEL = {
  quente: { label: 'Usando de verdade', cls: 'bg-ok-50 text-ok-600 ring-ok-600/20' },
  morno: { label: 'Começando a usar', cls: 'bg-warn-50 text-warn-600 ring-warn-600/20' },
  frio: { label: 'Ainda não usou', cls: 'bg-danger-50 text-danger-600 ring-danger-600/20' },
} as const;

const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  });

/**
 * Termômetro de uso (2026-11-27): os 5 passos que mostram se a tapeçaria está usando o sistema
 * de verdade, quantos dias ela entrou e o aviso de quem está no teste e parou de entrar.
 */
export function UsageThermometer({ c }: { c: PlatformCompanyDto }) {
  const u = c.usage;
  const done = u.steps.filter((s) => s.at).length;
  const idle = c.status === 'TESTE' && !c.closedAt && u.idleDays >= IDLE_NOTICE_DAYS;
  return (
    <div className="mt-2 space-y-2" data-testid="empresa-termometro">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={clsx(
            'rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1',
            LEVEL[u.level].cls,
          )}
          data-testid="empresa-termometro-nivel"
        >
          {LEVEL[u.level].label} · {done} de 5
        </span>
        <span className="text-ink-muted">
          {u.activeDays === 0
            ? 'Ainda não entrou'
            : u.activeDays === 1
              ? 'Entrou em 1 dia só'
              : `Entrou em ${u.activeDays} dias diferentes`}
          {u.lastSeenAt ? ` · última vez ${shortDay(u.lastSeenAt)}` : ' · nunca voltou'}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {u.steps.map((s) => (
          <li
            key={s.key}
            className={clsx(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs',
              s.at ? 'bg-ok-50 font-medium text-ok-600' : 'bg-subtle text-ink-muted',
            )}
            title={s.at ? `Em ${shortDay(s.at)}` : 'Ainda não'}
          >
            {s.at && <Check className="size-3" aria-hidden />}
            {s.label}
          </li>
        ))}
      </ul>
      {idle && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-50 px-3 py-2 text-sm"
          data-testid="empresa-parada"
        >
          <span className="font-medium text-danger-600">
            Está no teste e não entra há {u.idleDays} dias.
          </span>
          {u.helpWhatsappUrl && (
            <a
              href={u.helpWhatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ok-600 px-3 text-sm font-semibold text-white hover:bg-ok-600/90"
              data-testid="empresa-oferecer-ajuda"
            >
              <MessageCircle className="size-4" aria-hidden /> Oferecer ajuda
            </a>
          )}
        </div>
      )}
    </div>
  );
}
