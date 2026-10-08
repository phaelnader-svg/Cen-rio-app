import type { Metadata } from 'next';
import { PickupsPage } from '@/components/commercial/pickups-page';

export const metadata: Metadata = { title: 'Retiradas' };

export default function Page() {
  return <PickupsPage />;
}
