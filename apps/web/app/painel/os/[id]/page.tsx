import type { Metadata } from 'next';
import { ServiceOrderDetail } from '@/components/commercial/service-order-detail';

export const metadata: Metadata = { title: 'Ordem de serviço' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServiceOrderDetail id={id} />;
}
