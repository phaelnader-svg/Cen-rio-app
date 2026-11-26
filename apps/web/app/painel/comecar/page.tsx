import type { Metadata } from 'next';
import { SetupPage } from '@/components/onboarding/setup-page';

export const metadata: Metadata = { title: 'Começar' };

export default function Page() {
  return <SetupPage />;
}
