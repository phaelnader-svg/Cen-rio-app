import type { Metadata } from 'next';
import { HelpRequestsPage } from '@/components/help/pages';

export const metadata: Metadata = { title: 'Pedidos de ajuda' };

export default function Page() {
  return <HelpRequestsPage />;
}
