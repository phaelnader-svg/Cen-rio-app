import type { Metadata } from 'next';
import { ReceiptsPage } from '@/components/commercial/receipts-page';

export const metadata: Metadata = { title: 'Recebimentos' };

export default function Page() {
  return <ReceiptsPage />;
}
