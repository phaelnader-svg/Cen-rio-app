import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PickupChoicePage } from '@/components/public/client-pages';

export const metadata: Metadata = {
  title: 'Escolher o dia da retirada',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <PickupChoicePage id={id} />
    </Suspense>
  );
}
