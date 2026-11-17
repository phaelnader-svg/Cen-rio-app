import type { Metadata } from 'next';
import { SubscriptionPage } from '@/components/billing/subscription-page';

export const metadata: Metadata = { title: 'Assinatura' };

export default function Page() {
  return <SubscriptionPage />;
}
