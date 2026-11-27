import type { Metadata } from 'next';
import { StatusPage } from '@/components/public/client-pages';

export const metadata: Metadata = {
  title: 'Status do sistema',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <StatusPage />;
}
