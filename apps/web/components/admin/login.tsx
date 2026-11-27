'use client';

import { currentOrigin } from '@/lib/origem';
import { PASSWORD_RULE_HINT, adminLoginSchema, signupSchema } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, EyeOff, LogIn, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { Honeypot, Turnstile, useSignupConfig } from '@/components/account/turnstile';
import { legalLinksReady } from '@/components/site/legal/links-ready';
import { WelcomeBackPanel } from './welcome-back';
import {
  SignupPricingPanel,
  cheapest,
  pricingOrDefault,
  reais,
  signupPriceNotice,
} from './signup-pricing';

const REASONS: Record<string, string> = {
  'sessao-encerrada': 'Sua sessão foi encerrada. Entre novamente para continuar.',
  saiu: 'Você saiu do painel com segurança.',
};

/** Botão de mostrar/esconder a senha, dentro do campo. */
function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Esconder caracteres digitados' : 'Mostrar caracteres digitados'}
      aria-pressed={shown}
      data-testid="mostrar-senha"
      className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-ink-muted hover:bg-subtle hover:text-ink"
    >
      {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
    </button>
  );
}

export function AdminLogin() {
  const router = useRouter();
  const signupConfig = useSignupConfig();
  const pricing = pricingOrDefault(signupConfig.data?.pricing);
  const params = useSearchParams();
  const qc = useQueryClient();
  // ?criar=1 (botões da landing e anúncios) abre direto no Criar conta.
  const [mode, setMode] = useState<'login' | 'signup'>(() =>
    params.get('criar') === '1' ? 'signup' : 'login',
  );
  const [showPassword, setShowPassword] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Anti-robô do Criar conta (melhoria 5).
  const [captcha, setCaptcha] = useState<string | undefined>();
  const [website, setWebsite] = useState('');
  const reason = params.get('motivo');
  // Retorno seguro depois do login (ex.: tela oficial de autorização de um aplicativo).
  const next = params.get('proximo');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

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
    const parsed = signupSchema.safeParse({
      companyName,
      ownerName,
      email,
      password,
      passwordConfirm,
    });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      // A conta nova é uma empresa nova, e já entra direto como gestor dela.
      const me = await api('/api/auth/signup', {
        method: 'POST',
        body: {
          ...parsed.data,
          captcha,
          ...(website ? { website } : {}),
          ...(currentOrigin() ? { origem: currentOrigin()! } : {}),
        },
      });
      qc.setQueryData(['me'], me);
      router.replace('/painel');
      return;
    } catch (err) {
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  async function onSecondStep(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setLoading(true);
    try {
      const me = await api('/api/auth/login/2fa', {
        method: 'POST',
        body: { challenge, code: code.trim().toUpperCase() },
      });
      qc.setQueryData(['me'], me);
      router.replace(safeNext ?? '/painel');
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
      const me = await api<{ twoFactorRequired?: boolean; challenge?: string }>('/api/auth/login', {
        method: 'POST',
        body: parsed.data,
      });
      // Melhoria 98: conta com verificação em duas etapas pede o código do aplicativo.
      if (me.twoFactorRequired && me.challenge) {
        setChallenge(me.challenge);
        setLoading(false);
        return;
      }
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
        {mode === 'signup' ? <SignupPricingPanel pricing={pricing} /> : <WelcomeBackPanel />}
        <p className="text-xs text-white/75">Cada empresa vê só os próprios dados.</p>
      </section>

      <section className="flex min-h-dvh flex-col px-5 pt-12 pb-6 lg:min-h-0">
        <div className="mx-auto my-auto w-full max-w-sm">
          <BrandMark className="mx-auto mb-10 w-fit lg:hidden" />
          <h1 className="text-center text-2xl font-semibold tracking-tight">
            {mode === 'login' ? 'Entrar' : 'Criar conta'}
          </h1>
          <p className="mt-1 text-center text-[15px] text-ink-muted">
            {mode === 'login'
              ? 'Use seu e-mail e senha.'
              : 'Crie a conta da sua empresa. Os dados dela ficam separados de todas as outras.'}
          </p>

          {/* No celular (sem o lado esquerdo), os planos aparecem aqui, antes do cadastro. */}
          {mode === 'signup' && (
            <div
              className="mt-5 rounded-xl border border-line bg-surface p-4 text-sm lg:hidden"
              data-testid="signup-precos-celular"
            >
              <p className="font-semibold text-ink">
                {pricing.trialDays} dias grátis. Depois, o sistema é pago:
              </p>
              <ul className="mt-2 space-y-1 text-ink-soft">
                {pricing.plans.map((p) => (
                  <li key={p.key} className="flex justify-between gap-3">
                    <span>{p.label}</span>
                    <span className="font-semibold whitespace-nowrap text-ink">
                      {reais(p.monthlyCents)}/mês
                    </span>
                  </li>
                ))}
              </ul>
              {pricing.annualDiscountPct > 0 && (
                <p className="mt-2 text-ink-muted">
                  No plano anual, {pricing.annualDiscountPct}% de desconto.
                </p>
              )}
            </div>
          )}

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

          {mode === 'login' && challenge ? (
            <form onSubmit={onSecondStep} noValidate className="mt-6 space-y-4">
              <Field label="Código do aplicativo autenticador">
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={9}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoFocus
                  />
                )}
              </Field>
              <p className="-mt-2 text-sm text-ink-muted">
                Abra o aplicativo (Google Authenticator, Microsoft Authenticator ou outro) e digite
                os 6 números. Sem o celular, use um dos códigos de recuperação.
              </p>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={loading}
                icon={<LogIn className="size-4" aria-hidden />}
              >
                Confirmar
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full"
                onClick={() => {
                  setChallenge(null);
                  setCode('');
                  setFormError(null);
                }}
              >
                Voltar
              </Button>
            </form>
          ) : mode === 'login' ? (
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
                  <div className="relative">
                    <Input
                      {...p}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      className="pr-11"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <RevealButton
                      shown={showPassword}
                      onToggle={() => setShowPassword((v) => !v)}
                    />
                  </div>
                )}
              </Field>
              {signupConfig.data?.emailEnabled ? (
                <p className="-mt-1 text-right text-sm">
                  <a
                    href="/entrar/esqueci"
                    className="font-medium text-brand-700 underline-offset-4 hover:underline"
                  >
                    Esqueci minha senha
                  </a>
                </p>
              ) : null}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={loading}
                icon={<LogIn className="size-4" aria-hidden />}
              >
                Entrar
              </Button>
            </form>
          ) : null}
          {mode === 'login' && !challenge && (
            /* 26/11/2026: o cadastro logo embaixo do Entrar, já avisando que é pago. */
            <div className="mt-4 text-center" data-testid="convite-cadastro">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full"
                icon={<UserPlus className="size-4" aria-hidden />}
                onClick={() => switchMode('signup')}
                data-testid="criar-conta"
              >
                Cadastre-se e teste {pricing.trialDays} dias grátis
              </Button>
              <p className="mt-2 text-sm text-balance text-ink-muted">
                Cadastro sem custo. Depois do teste, a partir de {reais(cheapest(pricing))} por mês.
              </p>
            </div>
          )}
          {mode === 'signup' ? (
            <form onSubmit={onSignup} noValidate className="mt-6 space-y-4">
              {/* 26/11/2026: nome da empresa e de quem cria. O telefone é pedido ao entrar no sistema. */}
              <Field label="Nome da empresa" error={errors.companyName}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="organization"
                    placeholder="Ex.: Tapeçaria Silva"
                    maxLength={120}
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    data-testid="signup-empresa"
                    autoFocus
                  />
                )}
              </Field>
              <Field label="Seu nome" error={errors.ownerName}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="name"
                    maxLength={40}
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    data-testid="signup-nome"
                  />
                )}
              </Field>
              <Field label="E-mail" error={errors.email}>
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Senha" error={errors.password} hint={PASSWORD_RULE_HINT}>
                {(p) => (
                  <div className="relative">
                    <Input
                      {...p}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      className="pr-11"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <RevealButton
                      shown={showPassword}
                      onToggle={() => setShowPassword((v) => !v)}
                    />
                  </div>
                )}
              </Field>
              <Field label="Confirmar senha" error={errors.passwordConfirm}>
                {(p) => (
                  <Input
                    {...p}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                  />
                )}
              </Field>
              <Honeypot value={website} onChange={setWebsite} />
              <Turnstile onToken={setCaptcha} />
              {/* Melhoria 151: a mesma promessa da landing, logo antes do botão. */}
              {/* 26/11/2026: deixa claro, antes do botão, que depois do teste o sistema é pago. */}
              <p className="text-sm font-medium text-brand-700" data-testid="signup-trial">
                {signupPriceNotice(pricing)}
              </p>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={loading}
                icon={<UserPlus className="size-4" aria-hidden />}
              >
                Criar conta
              </Button>
              {/* LGPD: quem cria a conta vê, antes do botão, a que está aceitando. */}
              {legalLinksReady() && (
                <p className="text-center text-sm text-ink-muted" data-testid="signup-termos">
                  Ao criar a conta, você concorda com os{' '}
                  <a
                    href="/termos"
                    target="_blank"
                    className="font-medium text-brand-700 underline"
                  >
                    Termos de uso
                  </a>{' '}
                  e com a{' '}
                  <a
                    href="/privacidade"
                    target="_blank"
                    className="font-medium text-brand-700 underline"
                  >
                    Política de privacidade
                  </a>
                  .
                </p>
              )}
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
          ) : null}
        </div>
        <nav className="mt-12 flex items-center justify-center gap-3 text-sm text-ink-muted">
          <Link
            href="/"
            className="inline-flex items-center gap-1 underline-offset-4 hover:text-ink hover:underline"
            data-testid="voltar-site"
          >
            <ArrowLeft className="size-3.5" aria-hidden /> Voltar ao site
          </Link>
          <span aria-hidden>·</span>
          <a
            href="/tablet"
            className="font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            Abrir o tablet da oficina
          </a>
        </nav>
      </section>
    </main>
  );
}
