import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetPassword } from '@/components/account/reset-password';

export const metadata: Metadata = { title: 'Senha nova' };

export default function Page() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
