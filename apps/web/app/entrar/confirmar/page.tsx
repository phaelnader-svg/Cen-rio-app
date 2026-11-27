import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConfirmEmail } from '@/components/account/confirm-email';

export const metadata: Metadata = { title: 'Confirmar e-mail' };

export default function Page() {
  return (
    <Suspense>
      <ConfirmEmail />
    </Suspense>
  );
}
