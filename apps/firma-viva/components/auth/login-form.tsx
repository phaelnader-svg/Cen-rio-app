'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AuthFrame } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

const REASONS: Record<string, string> = {
  saiu: 'Você saiu do Firma Viva com segurança.',
  encerrada: 'Sua sessão terminou. Entre novamente.',
  senha: 'Senha alterada. Entre com a nova senha.',
};

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reason = params.get('motivo');
  const next = params.get('proximo');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/jogo';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const me = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      qc.setQueryData(['me'], me);
      router.replace(safeNext);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <AuthFrame
      title="Entrar no Firma Viva"
      subtitle="Use o e-mail e a senha da sua conta Firma Viva."
    >
      {reason && REASONS[reason] ? (
        <Alert tone="info" className="mb-4">
          {REASONS[reason]}
        </Alert>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="E-mail">
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="login-email"
            />
          )}
        </Field>
        <Field label="Senha">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="login-password"
            />
          )}
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button
          type="submit"
          className="w-full"
          loading={loading}
          icon={<LogIn className="size-4" aria-hidden />}
          data-testid="login-submit"
        >
          Entrar
        </Button>
      </form>
      <div className="mt-6 flex flex-col gap-1 text-sm text-ink-muted">
        <Link href="/recuperar-senha" className="font-semibold text-brand-700 hover:underline">
          Esqueci minha senha
        </Link>
        <span>
          Ainda não tem acesso? O Firma Viva funciona por convite: peça a quem administra a sua
          organização.
        </span>
      </div>
    </AuthFrame>
  );
}
