import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ServiceOrdersPage } from '@/components/commercial/service-orders-page';

export const metadata: Metadata = { title: 'Ordens de serviço' };

export default function Page() {
  return (
    <Suspense>
      <ServiceOrdersPage />
    </Suspense>
  );
}
