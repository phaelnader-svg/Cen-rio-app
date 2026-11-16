'use client';

import { SIGNUP_PASSWORD_MIN, adminLoginSchema, signupSchema } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn, UserPlus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

const REASONS: Record<string, string> = {
  'sessao-encerrada': 'Sua sessão foi encerrada. Entre novamente para continuar.',
  saiu: 'Você saiu do painel com segurança.',
};

export function AdminLogin() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reason = params.get('motivo');
  // Retorno seguro depois do login (ex.: tela oficial de autorização de um aplicativo).
  const next = params.get('proximo');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  function switchMode(next: 'login' | 'signup') {
    setMode(next);
    setErrors({});
    setFormError(null);
    setPassword('');
    setPasswordConfirm('');
  }

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = signupSchema.safeParse({ email, password, passwordConfirm });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      await api('/api/auth/signup', { method: 'POST', body: parsed.data });
      // Conta criada já entra direto (função de consulta).
      const me = await api('/api/auth/login', {
        method: 'POST',
        body: { email: parsed.data.email, password: parsed.data.password },
      });
      qc.setQueryData(['me'], me);
      router.replace('/painel');
      return;
    } catch (err) {
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = adminLoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const me = await api('/api/auth/login', { method: 'POST', body: parsed.data });
      qc.setQueryData(['me'], me);
      router.replace(safeNext ?? '/painel');
    } catch (err) {
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-brand-800 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <BrandMark inverted />
        <div className="max-w-md">
          <p className="text-sm font-semibold tracking-[0.18em] text-bronze-100/80 uppercase">
            Tapeçaria premium
          </p>
          <h2 className="mt-3 text-4xl leading-tight font-semibold tracking-tight">
            Da aprovação à entrega, cada estofado sob controle.
          </h2>
          <p className="mt-4 text-white/70">
            Painel do gestor e tablets da oficina sincronizados em tempo real.
          </p>
        </div>
        <p className="text-xs text-white/50">Acesso restrito à equipe da Cenário Estofados.</p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full border-[48px] border-white/5"
        />
      </section>

      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <BrandMark className="mb-10 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === 'login' ? 'Entrar no painel' : 'Criar conta'}
          </h1>
          <p className="mt-1 text-[15px] text-ink-muted">
            {mode === 'login'
              ? 'Use seu e-mail e senha de gestor.'
              : 'Crie sua conta com e-mail e senha para entrar no sistema.'}
          </p>

          {mode === 'login' && reason && REASONS[reason] && (
            <Alert tone="info" className="mt-6">
              {REASONS[reason]}
            </Alert>
          )}
          {formError && (
            <Alert tone="danger" className="mt-6">
              {formError}
            </Alert>
          )}

          {mode === 'login' ? (
            <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
              <Field label="E-mail" error={errors.email}>
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
              <Field label="Senha" error={errors.password}>
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={loading}
                icon={<LogIn className="size-4" aria-hidden />}
              >
                Entrar
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full"
                icon={<UserPlus className="size-4" aria-hidden />}
                onClick={() => switchMode('signup')}
                data-testid="criar-conta"
              >
                Criar conta
              </Button>
            </form>
          ) : (
            <form onSubmit={onSignup} noValidate className="mt-6 space-y-4">
              <Field label="E-mail" error={errors.email}>
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                  />
                )}
              </Field>
              <Field
                label="Senha"
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
                  />
                )}
              </Field>
              <Field label="Confirmar senha" error={errors.passwordConfirm}>
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
                icon={<UserPlus className="size-4" aria-hidden />}
              >
                Criar conta
              </Button>
              <p className="text-center text-sm text-ink-muted">
                Já tem conta?{' '}
                <button
                  type="button"
                  className="font-medium text-brand-700 underline-offset-4 hover:underline"
                  onClick={() => switchMode('login')}
                >
                  Entrar
                </button>
              </p>
            </form>
          )}
          <p className="mt-8 text-center text-sm text-ink-muted">
            Tablet da oficina?{' '}
            <a
              href="/tablet"
              className="font-medium text-brand-700 underline-offset-4 hover:underline"
            >
              Abrir interface de produção
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
