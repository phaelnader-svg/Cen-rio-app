import type { Metadata } from 'next';
import { PlatformNotices } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Avisos e pedidos' };

export default function Page() {
  return <PlatformNotices />;
}
