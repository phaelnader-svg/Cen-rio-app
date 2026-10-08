import type { Metadata } from 'next';
import { MeasurementDetail } from '@/components/measurements/measurement-detail';

export const metadata: Metadata = { title: 'Medição' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MeasurementDetail id={id} />;
}
