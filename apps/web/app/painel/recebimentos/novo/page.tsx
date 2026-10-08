import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewReceiptPage } from '@/components/commercial/new-receipt-page';

export const metadata: Metadata = { title: 'Registrar recebimento' };

export default function Page() {
  return (
    <Suspense>
      <NewReceiptPage />
    </Suspense>
  );
}
