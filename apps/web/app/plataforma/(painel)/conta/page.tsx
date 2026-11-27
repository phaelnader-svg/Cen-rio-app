import type { Metadata } from 'next';
import { PlatformAccount } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Minha conta' };

export default function Page() {
  return <PlatformAccount />;
}
