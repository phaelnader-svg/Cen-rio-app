import type { Metadata } from 'next';
import { PlanningPage } from '@/components/measurements/planning-page';

export const metadata: Metadata = { title: 'Planejamento de sexta' };

export default function Page() {
  return <PlanningPage />;
}
