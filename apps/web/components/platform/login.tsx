'use client';

import {
  PASSWORD_RULE_HINT,
  platformForgotSchema,
  platformLoginSchema,
  platformResetSchema,
} from '@cenario/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogIn, Mail } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { ZodType } from 'zod';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage, fieldErrors } from '@/lib/api';

/** Valida no navegador e devolve o primeiro erro de cada campo (ou null quando está tudo certo). */
function check<T>(schema: ZodType<T>, value: unknown): Record<string, string> | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const map: Record<string, string> = {};
  for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
  return map;
}

function Frame({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-5 py-12">
      <div className="w-full max-w-sm">
        <BrandMark subtitle="Painel da plataforma" className="mx-auto mb-10 w-fit" />
        <h1 className="text-center text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-center text-[15px] text-ink-muted">{text}</p>
        {children}
      </div>
    </main>
  );
}

/**
 * Entrar no painel da plataforma. O painel tem login próprio, sem ligação com nenhuma tapeçaria:
 * o primeiro acesso é criado pelo suporte do servidor, e a senha esquecida volta por e-mail.
 */
export function PlatformLogin() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const estado = useQuery({
    queryKey: ['platform-estado'],
    queryFn: () => api<{ hasAdmin: boolean }>('/api/plataforma/estado'),
  });
  const [mode, setMode] = useState<'entrar' | 'esqueci' | 'enviado'>('entrar');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const invalid =
      mode === 'esqueci'
        ? check(platformForgotSchema, { email })
        : check(platformLoginSchema, { email, password });
    if (invalid) return setErrors(invalid);
    setErrors({});
    setLoading(true);
    try {
      if (mode === 'esqueci') {
        await api('/api/plataforma/esqueci', { method: 'POST', body: { email } });
        setMode('enviado');
        setLoading(false);
        return;
      }
      const me = await api('/api/plataforma/entrar', { method: 'POST', body: { email, password } });
      qc.setQueryData(['platform-me'], me);
      router.replace('/plataforma');
    } catch (err) {
      const f = fieldErrors(err);
      if (Object.keys(f).length) setErrors(f);
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  if (estado.isPending)
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas">
        <Spinner />
      </main>
    );

  if (estado.data?.hasAdmin === false)
    return (
      <Frame
        title="O acesso do painel ainda não foi criado"
        text="O primeiro acesso é criado uma vez pelo suporte do servidor, com o seu e-mail e uma senha só deste painel. Depois disso é só entrar aqui."
      >
        <span />
      </Frame>
    );

  if (mode === 'enviado')
    return (
      <Frame
        title="Confira o seu e-mail"
        text={`Se ${email} for o e-mail do painel, chegou uma mensagem com o link para criar uma senha nova. O link vale por 1 hora.`}
      >
        <Button
          variant="secondary"
          size="lg"
          className="mt-6 w-full"
          onClick={() => {
            setMode('entrar');
            setFormError(null);
          }}
        >
          Voltar para entrar
        </Button>
      </Frame>
    );

  const esqueci = mode === 'esqueci';
  return (
    <Frame
      title={esqueci ? 'Esqueci a senha do painel' : 'Entrar no painel da plataforma'}
      text={
        esqueci
          ? 'Digite o e-mail do painel. Mandamos um link para você criar uma senha nova.'
          : 'Empresas, cobrança, preços e avisos do Cenário Gestão.'
      }
    >
      {params.get('motivo') === 'saiu' && !formError && !esqueci && (
        <Alert tone="info" className="mt-6">
          Você saiu do painel com segurança.
        </Alert>
      )}
      {params.get('motivo') === 'senha' && !formError && !esqueci && (
        <Alert tone="ok" className="mt-6">
          Senha nova salva. Entre com ela.
        </Alert>
      )}
      {formError && (
        <Alert tone="danger" className="mt-6">
          {formError}
        </Alert>
      )}
      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
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
        {!esqueci && (
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
        )}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={loading}
          icon={
            esqueci ? (
              <Mail className="size-4" aria-hidden />
            ) : (
              <LogIn className="size-4" aria-hidden />
            )
          }
        >
          {esqueci ? 'Mandar o link' : 'Entrar'}
        </Button>
      </form>
      <button
        type="button"
        className="mt-5 w-full text-center text-[15px] font-medium text-brand-700 hover:underline"
        onClick={() => {
          setMode(esqueci ? 'entrar' : 'esqueci');
          setErrors({});
          setFormError(null);
        }}
      >
        {esqueci ? 'Voltar para entrar' : 'Esqueci a senha'}
      </button>
    </Frame>
  );
}

/** Criar a senha nova pelo link do e-mail (/plataforma/nova-senha?token=…). */
export function PlatformNewPassword() {
  const router = useRouter();
  const qc = useQueryClient();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const invalid = check(platformResetSchema, { token, password, passwordConfirm });
    if (invalid && !invalid.token) return setErrors(invalid);
    setErrors({});
    setLoading(true);
    try {
      const me = await api('/api/plataforma/nova-senha', {
        method: 'POST',
        body: { token, password, passwordConfirm },
      });
      qc.setQueryData(['platform-me'], me);
      router.replace('/plataforma');
    } catch (err) {
      const f = fieldErrors(err);
      if (Object.keys(f).length) setErrors(f);
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  if (token.length < 20)
    return (
      <Frame
        title="Link incompleto"
        text="Abra o link do e-mail de novo, do jeito que chegou. Se não der, peça outro link."
      >
        <Link
          href="/plataforma/entrar"
          className="mt-6 block text-center text-[15px] font-medium text-brand-700 hover:underline"
        >
          Voltar para entrar
        </Link>
      </Frame>
    );

  return (
    <Frame
      title="Criar uma senha nova"
      text="Senha só deste painel. Depois de salvar, você já entra."
    >
      {formError && (
        <Alert tone="danger" className="mt-6">
          {formError}
        </Alert>
      )}
      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        <Field label="Senha nova" error={errors.password} hint={PASSWORD_RULE_HINT}>
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
        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={loading}
          icon={<KeyRound className="size-4" aria-hidden />}
        >
          Salvar e entrar
        </Button>
      </form>
      <Link
        href="/plataforma/entrar"
        className="mt-5 block text-center text-[15px] font-medium text-brand-700 hover:underline"
      >
        Pedir outro link
      </Link>
    </Frame>
  );
}
