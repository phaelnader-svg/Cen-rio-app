'use client';

import { MapPin, Truck } from 'lucide-react';
import { arrivalText, todayIso } from '@/lib/commercial';
import { useLogisticsRoute } from '@/lib/quality';

/**
 * Equipe própria (ex.: João acompanhando a retirada do Thiago): as paradas de hoje em que a
 * pessoa é responsável ou participante — só leitura, sem valores. Participar não gera pagamento.
 */
export function MyTripsToday({ standalone = false }: { standalone?: boolean }) {
  const route = useLogisticsRoute(todayIso(), true);
  // Aparelho só de entregas e retiradas (2026-11-24): a lista é a tela inteira, então o dia sem
  // nenhuma parada precisa dizer isso em vez de ficar em branco.
  if (standalone && route.isSuccess && !route.data.stops.length)
    return (
      <p
        className="rounded-xl border border-line p-4 text-lg text-ink-soft"
        data-testid="my-trips-empty"
      >
        Nada agendado para você hoje.
      </p>
    );
  if (route.isPending || route.isError || !route.data.stops.length) return null;
  return (
    <section className={standalone ? 'space-y-4' : 'mt-10 space-y-4'} data-testid="my-trips">
      {!standalone && (
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink-soft">
          <Truck className="size-5" aria-hidden />
          Minhas retiradas e entregas de hoje
        </h2>
      )}
      <ol className="grid gap-4 md:grid-cols-2">
        {route.data.stops.map((s) => {
          const a = s.job.address;
          return (
            <li
              key={`${s.job.kind}:${s.job.id}`}
              className="rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
              data-testid={`route-stop-${s.job.code}`}
            >
              <p
                className={
                  s.job.onSite
                    ? 'text-base font-semibold text-brand-700'
                    : 'text-base font-semibold text-ink-soft'
                }
              >
                {s.job.kind === 'ENTREGA' ? 'Entrega' : s.job.onSite ? 'No local' : 'Retirada'}{' '}
                {s.job.code} · {arrivalText(s.job.windowStart, s.job.windowEnd)}
              </p>
              <p className="mt-1 text-xl font-semibold break-words">{s.job.customerName}</p>
              {a && (
                <p className="mt-1 flex items-start gap-2 text-base">
                  <MapPin className="mt-0.5 size-5 shrink-0" aria-hidden />
                  <span className="break-words">
                    {a.street}, {a.number}
                    {a.complement ? ` — ${a.complement}` : ''} · {a.city}
                  </span>
                </p>
              )}
              <p className="mt-2 text-base text-ink-muted">
                Equipe:{' '}
                {[s.responsible?.displayName, ...s.participants.map((p) => p.displayName)]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
