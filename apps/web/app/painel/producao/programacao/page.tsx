import type { Metadata } from 'next';
import { WeeklySchedulePage } from '@/components/production/weekly-schedule-page';

export const metadata: Metadata = { title: 'Programação semanal' };

export default function Page() {
  return <WeeklySchedulePage />;
}
