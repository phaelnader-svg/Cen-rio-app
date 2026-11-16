import type { Metadata } from 'next';
import { Suspense } from 'react';
import { QualityPage } from '@/components/quality/quality-pages';

export const metadata: Metadata = { title: 'Qualidade' };

export default function Page() {
  return (
    <Suspense>
      <QualityPage />
    </Suspense>
  );
}
