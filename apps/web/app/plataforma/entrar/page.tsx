import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlatformLogin } from '@/components/platform/login';

export const metadata: Metadata = { title: 'Painel da plataforma' };

export default function Page() {
  return (
    <Suspense>
      <PlatformLogin />
    </Suspense>
  );
}
