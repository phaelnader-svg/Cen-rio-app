'use client';

import type { PieceProfitDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Select } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { money } from '@/lib/finance';
import { Table } from './common';

/**
 * Item 18 (lista de 53): o que mais dá lucro e o que dá prejuízo, por tipo de peça. Vem dos
 * orçamentos que viraram serviço, tirando o gasto extra dos retrabalhos.
 */
export function PieceProfitTab() {
  const [months, setMonths] = useState(12);
  const q = useQuery({
    queryKey: ['reports', 'profit-by-piece', months],
    queryFn: () =>
      api<{ months: number; items: PieceProfitDto[] }>(
        `/api/v1/reports/profit-by-piece?months=${months}`,
      ),
  });
  return (
    <div className="space-y-4" data-testid="lucro-por-peca">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-muted">
          Pelos orçamentos que viraram serviço, menos o gasto extra dos retrabalhos. A peça com mais
          lucro por unidade aparece primeiro.
        </p>
        <Select
          aria-label="Período"
          className="w-44"
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
        >
          <option value={3}>Últimos 3 meses</option>
          <option value={6}>Últimos 6 meses</option>
          <option value={12}>Últimos 12 meses</option>
        </Select>
      </div>
      {q.isPending && <Spinner />}
      {q.isError && <Alert tone="danger">{q.error.message}</Alert>}
      {q.data && q.data.items.length === 0 && (
        <p className="text-sm text-ink-muted">
          Ainda não há serviços fechados a partir de orçamento neste período.
        </p>
      )}
      {q.data && q.data.items.length > 0 && (
        <Table
          head={[
            'Peça',
            'Peças',
            'Serviços',
            'Vendido',
            'Lucro',
            'Lucro por peça',
            'Margem',
            'Retrabalhos',
          ]}
        >
          {q.data.items.map((r) => (
            <tr key={r.pieceType}>
              <td className="px-4 py-2.5 font-medium">{r.label}</td>
              <td className="px-4 py-2.5 tabular-nums">{r.pieces}</td>
              <td className="px-4 py-2.5 tabular-nums">{r.services}</td>
              <td className="px-4 py-2.5 tabular-nums">{money(r.revenueCents)}</td>
              <td
                className={clsx(
                  'px-4 py-2.5 font-semibold tabular-nums',
                  r.profitCents < 0 ? 'text-danger-600' : 'text-ok-600',
                )}
              >
                {money(r.profitCents)}
              </td>
              <td className="px-4 py-2.5 tabular-nums">{money(r.profitPerPieceCents)}</td>
              <td className="px-4 py-2.5 tabular-nums">
                {r.marginPct === null ? '—' : `${r.marginPct.toLocaleString('pt-BR')}%`}
              </td>
              <td className={clsx('px-4 py-2.5 tabular-nums', r.reworks > 0 && 'text-danger-600')}>
                {r.reworks}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
