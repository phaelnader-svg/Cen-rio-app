import type { Metadata } from 'next';
import { Suspense } from 'react';
import { QuotesPage } from '@/components/quotes/quotes-page';
import { Spinner } from '@/components/ui/misc';

export const metadata: Metadata = { title: 'Orçamentos' };

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <QuotesPage />
    </Suspense>
  );
}
