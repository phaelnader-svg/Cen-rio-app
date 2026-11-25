'use client';

import { PASSWORD_RULE_HINT, platformLoginSchema } from '@cenario/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogIn } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage, fieldErrors } from '@/lib/api';

/**
 * Entrar no painel da plataforma. Enquanto ninguém foi cadastrado, a tela cria o primeiro
 * acesso — só funciona para quem já está logado como gestor da Cenário Estofados neste
 * navegador (prova de que é o dono). Depois disso o painel tem login próprio.
 */
export function PlatformLogin() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const estado = useQuery({
    queryKey: ['platform-estado'],
    queryFn: () => api<{ hasAdmin: boolean }>('/api/plataforma/estado'),
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const first = estado.data?.hasAdmin === false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!first) {
      const parsed = platformLoginSchema.safeParse({ email, password });
      if (!parsed.success) {
        const map: Record<string, string> = {};
        for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
        setErrors(map);
        return;
      }
    }
    setErrors({});
    setLoading(true);
    try {
      const me = first
        ? await api('/api/plataforma/primeiro-acesso', {
            method: 'POST',
            body: { email, displayName, password, passwordConfirm },
          })
        : await api('/api/plataforma/entrar', { method: 'POST', body: { email, password } });
      qc.setQueryData(['platform-me'], me);
      router.replace('/plataforma');
    } catch (err) {
      const f = fieldErrors(err);
      if (Object.keys(f).length) setErrors(f);
      setFormError(
        first && /401|entre|sess/i.test(errorMessage(err))
          ? 'Para criar o primeiro acesso, entre antes no painel da Cenário Estofados neste navegador e volte aqui.'
          : errorMessage(err),
      );
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-5 py-12">
      <div className="w-full max-w-sm">
        <BrandMark subtitle="Painel da plataforma" className="mx-auto mb-10 w-fit" />
        {estado.isPending ? (
          <Spinner />
        ) : (
          <>
            <h1 className="text-center text-2xl font-semibold tracking-tight">
              {first ? 'Criar o acesso do painel' : 'Entrar no painel da plataforma'}
            </h1>
            <p className="mt-1 text-center text-[15px] text-ink-muted">
              {first
                ? 'Um e-mail e uma senha só deste painel, separados do login da Cenário Estofados. Você faz isso uma vez.'
                : 'Empresas, cobrança, preços e avisos do Cenário Gestão.'}
            </p>
            {params.get('motivo') === 'saiu' && !formError && (
              <Alert tone="info" className="mt-6">
                Você saiu do painel com segurança.
              </Alert>
            )}
            {formError && (
              <Alert tone="danger" className="mt-6">
                {formError}
              </Alert>
            )}
            <form onSubmit={submit} noValidate className="mt-6 space-y-4">
              {first && (
                <Field label="Seu nome" error={errors.displayName}>
                  {(p) => (
                    <Input
                      {...p}
                      value={displayName}
                      autoComplete="name"
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  )}
                </Field>
              )}
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
              <Field
                label="Senha"
                error={errors.password}
                hint={first ? PASSWORD_RULE_HINT : undefined}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete={first ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              {first && (
                <Field label="Repita a senha" error={errors.passwordConfirm}>
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
              )}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={loading}
                icon={
                  first ? (
                    <KeyRound className="size-4" aria-hidden />
                  ) : (
                    <LogIn className="size-4" aria-hidden />
                  )
                }
              >
                {first ? 'Criar e entrar' : 'Entrar'}
              </Button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
