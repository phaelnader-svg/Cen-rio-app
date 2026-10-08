import type { Metadata } from 'next';
import { IssueDetailPage } from '@/components/issues/pages';

export const metadata: Metadata = { title: 'Ocorrência' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IssueDetailPage id={id} />;
}
