import type { Metadata } from 'next';
import { MeasurementsPage } from '@/components/measurements/measurements-page';

export const metadata: Metadata = { title: 'Medições' };

export default function Page() {
  return <MeasurementsPage />;
}
