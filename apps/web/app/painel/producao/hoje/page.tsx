import type { Metadata } from 'next';
import { ShopFloorPage } from '@/components/production/shop-floor-page';

export const metadata: Metadata = { title: 'Hoje na oficina' };

export default function Page() {
  return <ShopFloorPage />;
}
