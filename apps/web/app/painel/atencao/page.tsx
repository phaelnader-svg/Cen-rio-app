import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AttentionPage } from '@/components/issues/pages';

export const metadata: Metadata = { title: 'Avisos e pendências' };

export default function Page() {
  return (
    <Suspense>
      <AttentionPage />
    </Suspense>
  );
}
