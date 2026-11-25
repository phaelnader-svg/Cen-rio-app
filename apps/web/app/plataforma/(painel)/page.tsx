import type { Metadata } from 'next';
import { PlatformDashboard } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Painel da plataforma' };

export default function Page() {
  return <PlatformDashboard />;
}
