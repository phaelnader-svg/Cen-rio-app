import type { Metadata } from 'next';
import { Suspense } from 'react';
import { StockPage } from '@/components/purchasing/stock-page';

export const metadata: Metadata = { title: 'Estoque' };

export default function Page() {
  return (
    <Suspense>
      <StockPage />
    </Suspense>
  );
}
