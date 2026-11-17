'use client';

import { forgotPasswordSchema } from '@cenario/shared';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { AuthCard } from './auth-card';
import { Turnstile } from './turnstile';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [captcha, setCaptcha] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = forgotPasswordSchema.safeParse({ email, captcha });
    if (!parsed.success) {
      setError('Informe um e-mail válido.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api('/api/auth/password/forgot', { method: 'POST', body: parsed.data });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Esqueci minha senha"
      description="Informe o e-mail da sua conta. Mandamos um link para você criar uma senha nova."
    >
      {sent ? (
        <Alert tone="ok" className="mt-6">
          Se houver uma conta com {email}, o link chega em alguns minutos. Ele vale por 1 hora. Olhe
          também a caixa de spam.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="E-mail">
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="username"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            )}
          </Field>
          <Turnstile onToken={setCaptcha} />
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={loading}
            icon={<Mail className="size-4" aria-hidden />}
          >
            Mandar o link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
