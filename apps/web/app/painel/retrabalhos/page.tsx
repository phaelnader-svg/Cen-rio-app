import type { Metadata } from 'next';
import { ReworksPage } from '@/components/quality/reworks-page';

export const metadata: Metadata = { title: 'Retrabalhos' };

export default function Page() {
  return <ReworksPage />;
}
