import type { Metadata } from 'next';
import { ProductionTemplatesPage } from '@/components/production/templates-page';

export const metadata: Metadata = { title: 'Modelos de produção' };

export default function Page() {
  return <ProductionTemplatesPage />;
}
