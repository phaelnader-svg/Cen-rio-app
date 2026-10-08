import type { Metadata } from 'next';
import { RolesPage } from '@/components/admin/roles-page';

export const metadata: Metadata = { title: 'Funções e permissões' };

export default function Page() {
  return <RolesPage />;
}
