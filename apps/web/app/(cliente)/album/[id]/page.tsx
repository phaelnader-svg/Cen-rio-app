import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AlbumPage } from '@/components/public/client-pages';

export const metadata: Metadata = {
  title: 'Fotos do serviço',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <AlbumPage id={id} />
    </Suspense>
  );
}
