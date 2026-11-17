import type { Metadata } from 'next';
import { ResetForm } from '@/components/auth/reset-form';

export const metadata: Metadata = { title: 'Nova senha' };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ResetForm token={token} />;
}
