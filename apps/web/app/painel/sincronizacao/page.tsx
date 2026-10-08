import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/misc';
import { SyncPanel } from '@/components/sync-panel';

export const metadata: Metadata = { title: 'Sincronização' };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Sincronização"
        description="Verifique, a qualquer momento, se painel e tablets estão recebendo as atualizações em tempo real — inclusive depois de quedas de conexão."
      />
      <SyncPanel />
    </>
  );
}
