import type { Metadata } from 'next';
import { ReturnsPage } from '@/components/quality/returns-page';

export const metadata: Metadata = { title: 'Devoluções' };

export default function Page() {
  return <ReturnsPage />;
}
