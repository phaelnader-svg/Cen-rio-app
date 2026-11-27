import type { Metadata } from 'next';
import { WorkshopMapPage } from '@/components/workshop-map/workshop-map-page';

export const metadata: Metadata = { title: 'Mapa da oficina' };

export default function Page() {
  return <WorkshopMapPage />;
}
