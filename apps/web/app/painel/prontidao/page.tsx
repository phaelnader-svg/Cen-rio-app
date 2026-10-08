import type { Metadata } from 'next';
import { ReadinessPage } from '@/components/purchasing/readiness-page';

export const metadata: Metadata = { title: 'Prontidão de materiais' };

export default function Page() {
  return <ReadinessPage />;
}
