import type { Metadata } from 'next';
import { DevicesPage } from '@/components/admin/devices-page';

export const metadata: Metadata = { title: 'Dispositivos e sessões' };

export default function Page() {
  return <DevicesPage />;
}
