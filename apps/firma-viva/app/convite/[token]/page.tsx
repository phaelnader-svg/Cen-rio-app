import type { Metadata } from 'next';
import { InviteForm } from '@/components/auth/invite-form';

export const metadata: Metadata = { title: 'Convite' };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteForm token={token} />;
}
