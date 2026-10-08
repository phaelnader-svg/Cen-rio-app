import type { Metadata } from 'next';
import { OrdersPage } from '@/components/commercial/orders-page';

export const metadata: Metadata = { title: 'Pedidos comerciais' };

export default function Page() {
  return <OrdersPage />;
}
