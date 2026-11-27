import type { Metadata } from 'next';
import { InvitePage } from '@/components/onboarding/invite-page';

export const metadata: Metadata = { title: 'Terminar o cadastro', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InvitePage token={token} />;
}
