import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FinancePage } from '@/components/finance/finance-page';

export const metadata: Metadata = { title: 'Financeiro' };

export default function Page() {
  return (
    <Suspense>
      <FinancePage />
    </Suspense>
  );
}
