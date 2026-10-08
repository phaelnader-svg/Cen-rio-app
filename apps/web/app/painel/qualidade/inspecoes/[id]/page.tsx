import type { Metadata } from 'next';
import { InspectionAdminPage } from '@/components/quality/quality-pages';

export const metadata: Metadata = { title: 'Inspeção' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InspectionAdminPage id={id} />;
}
