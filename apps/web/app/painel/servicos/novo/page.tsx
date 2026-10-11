import type { Metadata } from 'next';
import { NewServicePage } from '@/components/commercial/new-service-page';

export const metadata: Metadata = { title: 'Novo serviço' };

export default function Page() {
  return <NewServicePage />;
}
