import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthorizeApp } from '@/components/admin/authorize-app';

export const metadata: Metadata = { title: 'Autorizar aplicativo' };

export default function Page() {
  return (
    <Suspense>
      <AuthorizeApp />
    </Suspense>
  );
}
