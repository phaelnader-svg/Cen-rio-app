import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewOrderPage } from '@/components/commercial/order-pages';

export const metadata: Metadata = { title: 'Novo pedido' };

export default function Page() {
  return (
    <Suspense>
      <NewOrderPage />
    </Suspense>
  );
}
