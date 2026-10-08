import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewPurchaseOrderPage } from '@/components/purchasing/new-purchase-order';

export const metadata: Metadata = { title: 'Novo pedido de compra' };

export default function Page() {
  return (
    <Suspense>
      <NewPurchaseOrderPage />
    </Suspense>
  );
}
