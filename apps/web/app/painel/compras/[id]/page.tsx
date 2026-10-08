import type { Metadata } from 'next';
import { PurchaseOrderDetail } from '@/components/purchasing/purchase-order-detail';

export const metadata: Metadata = { title: 'Pedido de compra' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PurchaseOrderDetail id={id} />;
}
