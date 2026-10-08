import type { Metadata } from 'next';
import { QualityPage } from '@/components/quality/quality-pages';

export const metadata: Metadata = { title: 'Qualidade' };

export default function Page() {
  return <QualityPage />;
}
