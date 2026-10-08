import type { Metadata } from 'next';
import { OrderDetail } from '@/components/commercial/order-detail';

export const metadata: Metadata = { title: 'Pedido' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail id={id} />;
}
