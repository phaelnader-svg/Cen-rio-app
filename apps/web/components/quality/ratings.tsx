'use client';

import type { RatingsSummaryDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import Link from 'next/link';
import { Alert, Card, EmptyState, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/** Item 22 (lista de 53): as notas do "Como ficou?" viram estatística. */
export function RatingsCard() {
  const q = useQuery({
    queryKey: ['ratings', 90],
    queryFn: () => api<RatingsSummaryDto>('/api/v1/reports/ratings?days=90'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const r = q.data;
  if (r.count === 0)
    return (
      <Card>
        <EmptyState
          icon={<Star className="size-6" />}
          title="Nenhuma nota ainda"
          description='Depois de cada entrega, mande ao cliente o "Como ficou?" pelo botão da entrega (no tablet ou aqui no painel). As notas aparecem aqui.'
        />
      </Card>
    );
  const max = Math.max(1, ...r.byStars);
  return (
    <div className="space-y-4" data-testid="notas-clientes">
      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <p className="text-sm text-ink-muted">Nota média, últimos {r.days} dias</p>
            <p className="flex items-center gap-2 text-3xl font-semibold">
              {r.average?.toLocaleString('pt-BR', { minimumFractionDigits: 1 })}
              <Star className="size-7 fill-amber-400 text-amber-400" aria-hidden />
            </p>
          </div>
          <p className="text-sm text-ink-soft">
            {r.count} {r.count === 1 ? 'cliente respondeu' : 'clientes responderam'} de{' '}
            {r.delivered} {r.delivered === 1 ? 'entrega' : 'entregas'}
          </p>
        </div>
        <ul className="mt-4 space-y-1.5">
          {[5, 4, 3, 2, 1].map((n) => (
            <li key={n} className="flex items-center gap-3 text-sm">
              <span className="w-14 shrink-0 text-ink-soft">
                {n} {n === 1 ? 'estrela' : 'estrelas'}
              </span>
              <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-subtle">
                <span
                  className={n <= 3 ? 'block h-full bg-danger-600' : 'block h-full bg-ok-600'}
                  style={{ width: `${(r.byStars[n - 1]! / max) * 100}%` }}
                />
              </span>
              <span className="w-8 text-right tabular-nums">{r.byStars[n - 1]}</span>
            </li>
          ))}
        </ul>
      </Card>
      {r.low.length > 0 && (
        <Card className="p-5">
          <h3 className="font-semibold text-danger-600">Notas baixas para resolver</h3>
          <ul className="mt-3 divide-y divide-line">
            {r.low.map((l) => (
              <li key={l.deliveryId} className="py-2 text-sm">
                <Link
                  href={`/painel/entregas/${l.deliveryId}`}
                  className="font-medium hover:underline"
                >
                  {l.customerName} · {l.code}
                </Link>
                <span className="ml-2 font-semibold text-danger-600">{l.stars} de 5</span>
                <span className="ml-2 text-ink-muted">{formatDateTime(l.at)}</span>
                {l.comment && <p className="mt-0.5 text-ink-soft">“{l.comment}”</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
