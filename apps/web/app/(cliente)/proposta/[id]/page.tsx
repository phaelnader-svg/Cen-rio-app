import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ProposalPage } from '@/components/public/client-pages';

export const metadata: Metadata = { title: 'Proposta', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ProposalPage id={id} />
    </Suspense>
  );
}
