'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthFrame } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ message: string }>('/api/auth/recuperar', {
        method: 'POST',
        body: { email },
      });
      setDone(r.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthFrame
      title="Recuperar senha"
      subtitle="Enviaremos um link para você criar uma nova senha no Firma Viva."
    >
      {done ? (
        <Alert tone="ok" title="Pedido recebido">
          {done}
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="E-mail da conta">
            {(p) => (
              <Input
                {...p}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="forgot-email"
              />
            )}
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" className="w-full" loading={loading} data-testid="forgot-submit">
            Enviar link
          </Button>
        </form>
      )}
      <Link
        href="/entrar"
        className="mt-6 inline-block text-sm font-semibold text-brand-700 hover:underline"
      >
        Voltar para entrar
      </Link>
    </AuthFrame>
  );
}
