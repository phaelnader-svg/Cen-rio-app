import type { Metadata } from 'next';
import { OccurrenceDetailPage } from '@/components/quality/delivery-pages';

export const metadata: Metadata = { title: 'Ocorrência logística' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OccurrenceDetailPage id={id} />;
}
