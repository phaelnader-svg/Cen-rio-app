'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { AuthCard } from './auth-card';

export function ConfirmEmail() {
  const token = useSearchParams().get('token') ?? '';
  const q = useQuery({
    queryKey: ['confirm-email', token],
    queryFn: () => api('/api/auth/email/confirm', { method: 'POST', body: { token } }),
    enabled: token.length >= 20,
    retry: false,
    staleTime: Infinity,
  });
  return (
    <AuthCard title="Confirmar e-mail">
      <div className="mt-6">
        {token.length < 20 ? (
          <Alert tone="danger">Link incompleto. Abra de novo o link do e-mail.</Alert>
        ) : q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <Alert tone="danger">{errorMessage(q.error)}</Alert>
        ) : (
          <>
            <Alert tone="ok" className="justify-center">
              E-mail confirmado. Obrigado!
            </Alert>
            <a
              href="/painel"
              className="mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl bg-brand-700 font-semibold text-white hover:bg-brand-800"
            >
              Abrir o painel
            </a>
          </>
        )}
      </div>
    </AuthCard>
  );
}
