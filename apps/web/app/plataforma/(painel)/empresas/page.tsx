import type { Metadata } from 'next';
import { PlatformCompanies } from '@/components/platform/pages';

export const metadata: Metadata = { title: 'Empresas' };

export default function Page() {
  return <PlatformCompanies />;
}
