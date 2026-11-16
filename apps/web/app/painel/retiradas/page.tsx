import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PickupsPage } from '@/components/commercial/pickups-page';

export const metadata: Metadata = { title: 'Retiradas' };

export default function Page() {
  return (
    <Suspense>
      <PickupsPage />
    </Suspense>
  );
}
