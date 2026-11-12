import type { Metadata } from 'next';
import { SyncPage } from '@/components/admin/sync-page';

export const metadata: Metadata = { title: 'Sincronização' };

export default function Page() {
  return <SyncPage />;
}
