import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlatformNewPassword } from '@/components/platform/login';

export const metadata: Metadata = { title: 'Senha nova do painel' };

export default function Page() {
  return (
    <Suspense>
      <PlatformNewPassword />
    </Suspense>
  );
}
