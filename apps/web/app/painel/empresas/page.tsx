import type { Metadata } from 'next';
import { CompaniesPage } from '@/components/admin/companies-page';

export const metadata: Metadata = { title: 'Empresas' };

export default function Page() {
  return <CompaniesPage />;
}
