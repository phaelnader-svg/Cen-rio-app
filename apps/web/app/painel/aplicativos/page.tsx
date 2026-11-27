import type { Metadata } from 'next';
import { ConnectedAppsPage } from '@/components/admin/connected-apps-page';

export const metadata: Metadata = { title: 'Aplicativos conectados' };

export default function Page() {
  return <ConnectedAppsPage />;
}
