import type { Metadata } from 'next';
import { OrgPage } from '@/components/org/org-page';

export const metadata: Metadata = { title: 'Organização' };

export default function Page() {
  return <OrgPage />;
}
