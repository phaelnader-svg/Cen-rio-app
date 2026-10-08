import type { Metadata } from 'next';
import { DeliveryDetailPage } from '@/components/quality/delivery-pages';

export const metadata: Metadata = { title: 'Entrega' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeliveryDetailPage id={id} />;
}
