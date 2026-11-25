import type { Metadata } from 'next';
import { OfficePage } from '@/components/office/office-page';

export const metadata: Metadata = { title: 'Escritório' };

export default function Page() {
  return <OfficePage />;
}
