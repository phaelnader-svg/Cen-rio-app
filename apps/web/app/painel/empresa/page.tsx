import type { Metadata } from 'next';
import { CompanyPage } from '@/components/admin/company-page';

export const metadata: Metadata = { title: 'Empresa' };

export default function Page() {
  return <CompanyPage />;
}
