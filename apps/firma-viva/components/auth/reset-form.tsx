'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthFrame } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('As senhas não conferem.');
    setLoading(true);
    setError(null);
    try {
      await api('/api/auth/redefinir', { method: 'POST', body: { token, password } });
      router.replace('/entrar?motivo=senha');
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }
  return (
    <AuthFrame
      title="Criar nova senha"
      subtitle="Use ao menos 10 caracteres, com letras e números."
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Nova senha">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="reset-password"
            />
          )}
        </Field>
        <Field label="Repita a senha">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              data-testid="reset-confirm"
            />
          )}
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" className="w-full" loading={loading} data-testid="reset-submit">
          Salvar nova senha
        </Button>
      </form>
    </AuthFrame>
  );
}
