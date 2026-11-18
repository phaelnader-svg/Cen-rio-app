import type { Metadata } from 'next';
import { ServiceOrderSheetPage } from '@/components/commercial/os-sheet-page';

export const metadata: Metadata = { title: 'Página da OS' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServiceOrderSheetPage id={id} />;
}
