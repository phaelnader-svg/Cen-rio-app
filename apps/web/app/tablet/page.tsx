import type { Metadata } from 'next';
import { TabletApp } from '@/components/tablet/tablet-app';

export const metadata: Metadata = { title: 'Produção' };

export default function Page() {
  return <TabletApp />;
}
