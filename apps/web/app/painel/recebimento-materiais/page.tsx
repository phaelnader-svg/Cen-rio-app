import type { Metadata } from 'next';
import { MaterialReceivingPage } from '@/components/purchasing/material-receiving-page';

export const metadata: Metadata = { title: 'Recebimento de materiais' };

export default function Page() {
  return <MaterialReceivingPage />;
}
