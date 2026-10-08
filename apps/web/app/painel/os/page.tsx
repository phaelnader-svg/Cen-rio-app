import type { Metadata } from 'next';
import { ServiceOrdersPage } from '@/components/commercial/service-orders-page';

export const metadata: Metadata = { title: 'Ordens de serviço' };

export default function Page() {
  return <ServiceOrdersPage />;
}
