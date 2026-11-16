'use client';

/**
 * Quando a entrada pelo Cenário Gestão não dá certo: explica o motivo e oferece voltar ao painel
 * ou tentar de novo. Não é uma tela de login (o acesso é sempre pela conta do Cenário).
 */
import { useSearchParams } from 'next/navigation';
import { AuthFrame } from '@/components/brand';
import { Alert } from '@/components/ui/misc';
import { cenarioUrl } from '@/lib/links';

export function AccessProblem() {
  const params = useSearchParams();
  const message =
    params.get('erro')?.slice(0, 300) ?? 'Não foi possível abrir o ambiente interativo.';
  return (
    <AuthFrame
      title="Ambiente interativo"
      subtitle="O acesso é feito pela sua conta do Cenário Gestão."
    >
      <Alert tone="danger" className="mb-4">
        {message}
      </Alert>
      <div className="flex flex-col gap-2 sm:flex-row">
        <a
          href="/api/entrar/cenario"
          className="inline-flex h-10 items-center justify-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Tentar de novo
        </a>
        <a
          href={cenarioUrl('/painel')}
          className="inline-flex h-10 items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold text-ink hover:bg-subtle"
        >
          Voltar ao Cenário Gestão
        </a>
      </div>
    </AuthFrame>
  );
}
