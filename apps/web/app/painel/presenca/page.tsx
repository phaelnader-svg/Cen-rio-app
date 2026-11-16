import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamAttendancePage } from '@/components/attendance/team-page';

export const metadata: Metadata = { title: 'Presença da equipe' };

export default function Page() {
  return (
    <Suspense>
      <TeamAttendancePage />
    </Suspense>
  );
}
