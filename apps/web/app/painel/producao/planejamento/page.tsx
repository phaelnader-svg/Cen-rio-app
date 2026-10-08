import type { Metadata } from 'next';
import { ProductionPlanningPage } from '@/components/production/planning-page';

export const metadata: Metadata = { title: 'Planejamento de produção' };

export default function Page() {
  return <ProductionPlanningPage />;
}
