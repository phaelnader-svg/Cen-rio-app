import type { Metadata } from 'next';
import { PlatformReceive } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Como eu recebo' };

export default function Page() {
  return <PlatformReceive />;
}
