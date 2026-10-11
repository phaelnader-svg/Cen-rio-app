import type { Metadata } from 'next';
import { PreplanningPage } from '@/components/production/preplanning-page';

export const metadata: Metadata = { title: 'Produção — A planejar' };

export default function Page() {
  return <PreplanningPage />;
}
