import type { Metadata } from 'next';
import { PlatformPlans } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Planos e preços' };

export default function Page() {
  return <PlatformPlans />;
}
