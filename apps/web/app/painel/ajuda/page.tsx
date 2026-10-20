import type { Metadata } from 'next';
import { Suspense } from 'react';
import { HelpRequestsPage } from '@/components/help/pages';

export const metadata: Metadata = { title: 'Pedidos de ajuda' };

export default function Page() {
  return (
    <Suspense>
      <HelpRequestsPage />
    </Suspense>
  );
}
