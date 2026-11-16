import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ProductionBoardPage } from '@/components/production/board-page';

export const metadata: Metadata = { title: 'Quadro de produção' };

export default function Page() {
  return (
    <Suspense>
      <ProductionBoardPage />
    </Suspense>
  );
}
