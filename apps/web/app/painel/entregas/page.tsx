import type { Metadata } from 'next';
import { DeliveriesPage } from '@/components/quality/delivery-pages';

export const metadata: Metadata = { title: 'Expedição e entregas' };

export default function Page() {
  return <DeliveriesPage />;
}
