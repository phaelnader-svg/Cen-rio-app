import type { Metadata } from 'next';
import { TabletApp } from '@/components/tablet/tablet-app';

export const metadata: Metadata = { title: 'Produção', manifest: '/manifest.webmanifest' };

export default function Page() {
  return <TabletApp />;
}
