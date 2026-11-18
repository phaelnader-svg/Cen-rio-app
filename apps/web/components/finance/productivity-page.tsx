'use client';

import { useState } from 'react';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { localToday, monthStart, useProductivity, type Period } from '@/lib/finance';
import { PeriodPicker } from './common';
import { ProductivityTable } from './productivity-table';

/** 2026-11-18: Produtividade virou item do menu (antes era uma aba do Financeiro). */
export function ProductivityPage() {
  const [period, setPeriod] = useState<Period>(() => ({ from: monthStart(), to: localToday() }));
  const q = useProductivity(period);
  return (
    <>
      <PageHeader
        title="Produtividade"
        description="O que cada pessoa concluiu no período, com prazos, apoios e retrabalhos."
      />
      <PeriodPicker value={period} onChange={setPeriod} />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <ProductivityTable data={q.data} />
      )}
    </>
  );
}
