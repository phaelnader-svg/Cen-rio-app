import type { Metadata } from 'next';
import { AccountPage } from '@/components/admin/account-page';

export const metadata: Metadata = { title: 'Minha conta' };

export default function Page() {
  return <AccountPage />;
}
