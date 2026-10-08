import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewServiceOrderPage } from '@/components/commercial/new-service-order-page';

export const metadata: Metadata = { title: 'Nova OS' };

export default function Page() {
  return (
    <Suspense>
      <NewServiceOrderPage />
    </Suspense>
  );
}
