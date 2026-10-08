import type { Metadata } from 'next';
import { ProductionBoardPage } from '@/components/production/board-page';

export const metadata: Metadata = { title: 'Quadro de produção' };

export default function Page() {
  return <ProductionBoardPage />;
}
