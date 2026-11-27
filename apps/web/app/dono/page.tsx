import type { Metadata } from 'next';
import { DonoApp } from '@/components/dono/dono-app';

export const metadata: Metadata = {
  title: 'Seu app',
  manifest: '/dono/manifest',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <DonoApp />;
}
