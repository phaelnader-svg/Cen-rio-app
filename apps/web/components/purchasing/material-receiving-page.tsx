'use client';

import { PageHeader } from '@/components/ui/misc';
import { MaterialReceiving } from './material-receiving';

/** Recebimento pelo painel (mesma conferência do tablet). Lê `?pedido=` sem exigir Suspense. */
export function MaterialReceivingPage() {
  const initial =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('pedido');
  return (
    <>
      <PageHeader
        title="Recebimento de materiais"
        description="Confira referência, cor e quantidade. Só o que chegou em ordem fica disponível; problemas são registrados como divergência."
      />
      <MaterialReceiving initialId={initial} />
    </>
  );
}
