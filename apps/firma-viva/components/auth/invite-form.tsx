'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthFrame } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

interface InviteInfo {
  organization: string;
  email: string;
  roleLabel: string;
  hasAccount: boolean;
}

export function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>(`/api/auth/convite/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const me = await api(`/api/auth/convite/${token}`, {
        method: 'POST',
        body: info.data?.hasAccount ? { password } : { name, password },
      });
      qc.setQueryData(['me'], me);
      router.replace('/jogo');
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }
  if (info.isLoading)
    return (
      <AuthFrame title="Convite">
        <Spinner />
      </AuthFrame>
    );
  if (info.error || !info.data)
    return (
      <AuthFrame title="Convite">
        <Alert tone="danger">{errorMessage(info.error)}</Alert>
      </AuthFrame>
    );
  const d = info.data;
  return (
    <AuthFrame
      title={`Entrar em ${d.organization}`}
      subtitle={`Convite para ${d.email} como ${d.roleLabel}.`}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {d.hasAccount ? (
          <Alert tone="info">
            Você já tem conta no Firma Viva. Confirme sua senha para aceitar.
          </Alert>
        ) : (
          <Field label="Seu nome">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="invite-name"
              />
            )}
          </Field>
        )}
        <Field
          label={d.hasAccount ? 'Sua senha' : 'Crie uma senha'}
          hint={d.hasAccount ? undefined : 'Ao menos 10 caracteres, com letras e números.'}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete={d.hasAccount ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="invite-password"
            />
          )}
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" className="w-full" loading={loading} data-testid="invite-submit">
          Aceitar convite
        </Button>
      </form>
    </AuthFrame>
  );
}
