'use client';

import { SyncPanel } from '@/components/sync-panel';
import { Alert, PageHeader } from '@/components/ui/misc';
import { useCan } from '@/lib/hooks';

/**
 * Página de sincronização do painel. B5: quem não pode diagnosticar a sincronização (API:
 * sincronizacao.diagnosticar) vê o aviso de acesso negado em vez de um painel cuja ação falharia.
 * O painel do tablet usa o SyncPanel direto e não muda.
 */
export function SyncPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Sincronização"
        description="Verifique, a qualquer momento, se painel e tablets estão recebendo as atualizações em tempo real — inclusive depois de quedas de conexão."
      />
      {can('sincronizacao.diagnosticar') ? (
        <SyncPanel />
      ) : (
        <div data-testid="acesso-negado">
          <Alert tone="warn" title="Acesso negado">
            Você não tem permissão para diagnosticar a sincronização. Peça acesso ao gestor.
          </Alert>
        </div>
      )}
    </>
  );
}
