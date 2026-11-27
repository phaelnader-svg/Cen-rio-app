'use client';

import type { StageTimesDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/misc';
import { api } from '@/lib/api';

const hours = (m: number) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
};

/**
 * Item 17 (lista de 53): o tempo real de cada etapa, aprendido no tablet. As tarefas novas já
 * nascem com esse tempo previsto.
 */
export function StageTimesCard() {
  const q = useQuery({
    queryKey: ['production', 'stage-times'],
    queryFn: () => api<StageTimesDto>('/api/v1/production/stage-times'),
  });
  const d = q.data;
  if (!d) return null;
  return (
    <Card className="mt-6 p-5" data-testid="tempo-etapas">
      <h2 className="font-semibold">Quanto tempo leva cada peça</h2>
      <p className="text-sm text-ink-muted">
        Tempo real no tablet (últimos {d.days} dias), por peça. As tarefas novas já nascem com esse
        tempo previsto, e a semana da oficina e a data de entrega do orçamento usam o número real.
      </p>
      {d.pieces.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          Ainda sem tarefas suficientes começadas e terminadas no tablet. Cada etapa precisa de pelo
          menos 3 registros.
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.pieces.map((p) => (
            <div key={p.pieceType} className="rounded-xl border border-line p-4">
              <p className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{p.label}</span>
                <span className="text-lg font-semibold tabular-nums">{hours(p.totalMinutes)}</span>
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {p.stages.map((s) => (
                  <li key={s.activity} className="flex justify-between gap-2 text-ink-soft">
                    <span>{s.label}</span>
                    <span className="tabular-nums">
                      {hours(s.minutes)} <span className="text-ink-muted">({s.samples}x)</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
