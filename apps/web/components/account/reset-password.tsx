'use client';

import { SIGNUP_PASSWORD_MIN, resetPasswordSchema } from '@cenario/shared';
import { KeyRound } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { AuthCard } from './auth-card';

export function ResetPassword() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = resetPasswordSchema.safeParse({ token, password, passwordConfirm });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
      if (map.token) setFormError('Link incompleto. Abra de novo o link do e-mail.');
      setErrors(map);
      return;
    }
    setErrors({});
    setFormError(null);
    setLoading(true);
    try {
      await api('/api/auth/password/reset', { method: 'POST', body: parsed.data });
      setDone(true);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Criar senha nova">
      {done ? (
        <>
          <Alert tone="ok" className="mt-6">
            Senha trocada. Por segurança, saímos da sua conta em todos os aparelhos.
          </Alert>
          <a
            href="/entrar"
            className="mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl bg-brand-700 font-semibold text-white hover:bg-brand-800"
          >
            Entrar com a senha nova
          </a>
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field
            label="Senha nova"
            error={errors.password}
            hint={`Mínimo de ${SIGNUP_PASSWORD_MIN} caracteres.`}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            )}
          </Field>
          <Field label="Confirmar senha nova" error={errors.passwordConfirm}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            )}
          </Field>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={loading}
            icon={<KeyRound className="size-4" aria-hidden />}
          >
            Salvar senha nova
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
