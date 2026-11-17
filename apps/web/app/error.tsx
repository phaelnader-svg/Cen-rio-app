'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { LogoMark } from '@/components/brand';
import { buttonClass } from '@/components/ui/button-styles';

/** Melhoria 137: erro inesperado numa tela, no mesmo estilo da página "não existe". */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center">
      <LogoMark className="size-14" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">Algo deu errado</h1>
      <p className="mt-2 max-w-sm text-ink-soft">
        Não foi possível abrir esta tela agora. Tente de novo; se continuar, avise o suporte.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button type="button" onClick={reset} className={buttonClass('primary', 'md')}>
          Tentar de novo
        </button>
        <Link href="/" className={buttonClass('secondary', 'md')}>
          Voltar para o início
        </Link>
      </div>
      {error.digest && <p className="mt-6 text-xs text-ink-muted">Código: {error.digest}</p>}
    </main>
  );
}
