'use client';

import type { ProductivityDto } from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PeriodPicker } from '@/components/finance/common';
import { ProductivityTable } from '@/components/finance/productivity-table';
import { Alert, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { localToday, monthStart, type Period } from '@/lib/finance';

/**
 * Reformulação, Fase 4 (D6) — produtividade para quem planeja (`producao.planejar`).
 * Mesmos indicadores do Financeiro, pela rota operacional: nenhum salário, custo ou valor.
 */
export function ProductivityTab() {
  const [period, setPeriod] = useState<Period>(() => ({ from: monthStart(), to: localToday() }));
  const q = useQuery({
    queryKey: ['production-productivity', period],
    queryFn: () =>
      api<ProductivityDto>(`/api/v1/production/productivity?from=${period.from}&to=${period.to}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div data-testid="schedule-productivity">
      <PeriodPicker value={period} onChange={setPeriod} />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <ProductivityTable data={q.data} />
      )}
    </div>
  );
}
