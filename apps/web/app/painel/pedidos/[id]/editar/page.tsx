import type { Metadata } from 'next';
import { EditOrderPage } from '@/components/commercial/order-pages';

export const metadata: Metadata = { title: 'Editar pedido' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditOrderPage id={id} />;
}
