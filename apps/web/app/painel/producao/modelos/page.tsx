import type { Metadata } from 'next';
import { ServiceModelsPage } from '@/components/service-models/service-models-page';

// Reformulação, Fase 2: o antigo "Modelos de produção" virou "Modelos de serviço" (mesmo
// endereço): etapas, checklist e materiais padrão por tipo de peça e serviço.
export const metadata: Metadata = { title: 'Modelos de serviço' };

export default function Page() {
  return <ServiceModelsPage />;
}
