import type { Metadata } from 'next';
import { PurchasingPage } from '@/components/purchasing/purchasing-page';

export const metadata: Metadata = { title: 'Compras' };

export default function Page() {
  return <PurchasingPage />;
}
