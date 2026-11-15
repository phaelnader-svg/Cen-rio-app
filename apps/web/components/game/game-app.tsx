'use client';
/**
 * Entrada própria do jogo (/jogo): mesma sessão, usuários e permissões do painel. Exige sessão
 * web com `jogo.acessar`; cada ação pelo mapa continua exigindo a permissão do fluxo oficial.
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Alert, Spinner } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { RealtimeProvider } from '@/lib/realtime';
import { GameWorld } from './game-world';

export function GameApp() {
  const me = useMe();
  const router = useRouter();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) router.replace('/entrar?voltar=/jogo');
  }, [unauthenticated, router]);
  if (me.isPending || unauthenticated)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  if (me.isError)
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="danger" title="Não foi possível abrir o jogo">
          {me.error.message}
        </Alert>
      </div>
    );
  const perms = new Set(me.data.permissions);
  if (me.data.session.kind !== 'WEB' || !perms.has('jogo.acessar'))
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="warn" title="Jogo indisponível para esta conta">
          É preciso entrar pelo navegador com a permissão “Entrar no jogo de gestão”.
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={() => router.replace('/painel')}>
          Voltar ao painel
        </Button>
      </div>
    );
  return (
    <RealtimeProvider onSessionEnded={() => router.replace('/entrar?motivo=encerrada')}>
      <GameWorld />
    </RealtimeProvider>
  );
}
