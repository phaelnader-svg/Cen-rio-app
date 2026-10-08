import type { Metadata } from 'next';
import { ConsolidatedPage } from '@/components/measurements/consolidated-page';

export const metadata: Metadata = { title: 'Materiais aprovados' };

export default function Page() {
  return <ConsolidatedPage />;
}
