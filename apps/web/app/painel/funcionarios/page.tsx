import type { Metadata } from 'next';
import { EmployeesPage } from '@/components/admin/employees-page';

export const metadata: Metadata = { title: 'Funcionários' };

export default function Page() {
  return <EmployeesPage />;
}
