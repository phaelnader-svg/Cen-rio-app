import type { Metadata } from 'next';
import { AttentionPage } from '@/components/issues/pages';

export const metadata: Metadata = { title: 'Central de atenção' };

export default function Page() {
  return <AttentionPage />;
}
