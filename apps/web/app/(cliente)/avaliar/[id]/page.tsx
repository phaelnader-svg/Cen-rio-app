import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReviewPage } from '@/components/public/client-pages';

export const metadata: Metadata = {
  title: 'Como ficou?',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ReviewPage id={id} />
    </Suspense>
  );
}
