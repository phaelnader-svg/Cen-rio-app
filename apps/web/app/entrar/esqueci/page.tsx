import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ForgotPassword } from '@/components/account/forgot-password';

export const metadata: Metadata = { title: 'Esqueci minha senha' };

export default function Page() {
  return (
    <Suspense>
      <ForgotPassword />
    </Suspense>
  );
}
