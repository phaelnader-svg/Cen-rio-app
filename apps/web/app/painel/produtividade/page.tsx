import type { Metadata } from 'next';
import { ProductivityPage } from '@/components/finance/productivity-page';

export const metadata: Metadata = { title: 'Produtividade' };

export default function Page() {
  return <ProductivityPage />;
}
