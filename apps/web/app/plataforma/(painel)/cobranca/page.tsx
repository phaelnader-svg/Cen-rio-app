import type { Metadata } from 'next';
import { PlatformBilling } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Cobrança' };

export default function Page() {
  return <PlatformBilling />;
}
