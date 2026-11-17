import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AccessProblem } from '@/components/auth/access-problem';

export const metadata: Metadata = { title: 'Ambiente interativo' };

export default function Page() {
  return (
    <Suspense>
      <AccessProblem />
    </Suspense>
  );
}
