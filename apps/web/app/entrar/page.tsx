import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AdminLogin } from '@/components/admin/login';

export const metadata: Metadata = { title: 'Entrar' };

export default function Page() {
  return (
    <Suspense>
      <AdminLogin />
    </Suspense>
  );
}
