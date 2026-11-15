'use client';
/**
 * Firma Viva: o jogo abre na organização da sessão. Funciona sem o Cenário Gestão (planta,
 * mesas, agentes); com ele conectado, o mapa mostra e opera a empresa real.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { Alert, Spinner } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { RealtimeProvider } from '@/lib/realtime';
import { GameWorld } from './game-world';

export function GameApp() {
  const me = useMe();
  const router = useRouter();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) {
      const back = `${window.location.pathname}${window.location.search}`;
      router.replace(`/entrar?proximo=${encodeURIComponent(back)}`);
    }
  }, [unauthenticated, router]);
  const ended = useCallback(() => router.replace('/entrar?motivo=encerrada'), [router]);
  if (me.isPending || unauthenticated)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  if (me.isError)
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="danger" title="Não foi possível abrir o Firma Viva">
          {me.error.message}
        </Alert>
      </div>
    );
  if (!me.data.organization)
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="warn" title="Sem organização">
          Sua conta ainda não faz parte de nenhuma organização. Peça um convite a quem administra a
          sua empresa no Firma Viva.
        </Alert>
      </div>
    );
  return (
    <RealtimeProvider
      key={me.data.organization.id}
      enabled={me.data.organization.cenario.status === 'CONECTADA'}
      onSessionEnded={ended}
    >
      <GameWorld />
    </RealtimeProvider>
  );
}
