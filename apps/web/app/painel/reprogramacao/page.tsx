import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReschedulePage } from '@/components/help/pages';

export const metadata: Metadata = { title: 'Reprogramação' };

export default function Page() {
  return (
    <Suspense>
      <ReschedulePage />
    </Suspense>
  );
}
