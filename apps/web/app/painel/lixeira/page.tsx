import type { Metadata } from 'next';
import { TrashPage } from '@/components/improvements/panel-pages';

export const metadata: Metadata = { title: 'Lixeira' };

export default function Page() {
  return <TrashPage />;
}
