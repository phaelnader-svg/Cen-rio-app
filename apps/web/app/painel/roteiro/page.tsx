import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LogisticsRoutePage } from '@/components/quality/route-page';

export const metadata: Metadata = { title: 'Roteiro do dia' };

export default function Page() {
  return (
    <Suspense>
      <LogisticsRoutePage />
    </Suspense>
  );
}
