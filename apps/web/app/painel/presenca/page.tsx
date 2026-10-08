import type { Metadata } from 'next';
import { TeamAttendancePage } from '@/components/attendance/team-page';

export const metadata: Metadata = { title: 'Presença da equipe' };

export default function Page() {
  return <TeamAttendancePage />;
}
