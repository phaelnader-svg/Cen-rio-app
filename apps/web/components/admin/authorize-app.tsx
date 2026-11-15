'use client';

/**
 * Tela oficial de autorização do Cenário Gestão para aplicativos conectados (ex.: Firma Viva).
 * A senha é digitada só aqui (no login do Cenário). O aplicativo recebe apenas a autorização.
 */
import { useQuery } from '@tanstack/react-query';
import { Building2, Check, ShieldCheck, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { ApiError, api, errorMessage } from '@/lib/api';

interface Info {
  client: { id: string; name: string };
  company: { name: string; legalName: string | null; document: string | null };
  user: { id: string; name: string; email: string | null };
  org: { ref: string | null; label: string | null };
  scopes: {
    key: string;
    label: string;
    description: string;
    grantedPermissions: number;
    totalPermissions: number;
  }[];
  redirectHost: string;
}

const KEYS = [
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'org_ref',
  'org_label',
] as const;

export function AuthorizeApp() {
  const params = useSearchParams();
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams();
  for (const k of KEYS) {
    const v = params.get(k);
    if (v) query.set(k, v);
  }
  const qs = query.toString();
  const info = useQuery({
    queryKey: ['oauth-info', qs],
    queryFn: () => api<Info>(`/api/oauth/authorize/info?${qs}`),
    retry: false,
  });
  const unauth = info.error instanceof ApiError && info.error.status === 401;
  useEffect(() => {
    if (unauth) {
      router.replace(`/entrar?proximo=${encodeURIComponent(`/autorizar?${qs}`)}`);
    }
  }, [unauth, qs, router]);

  async function decide(decision: 'allow' | 'deny') {
    setBusy(decision);
    setError(null);
    try {
      const body: Record<string, string> = { decision };
      for (const [k, v] of query.entries()) body[k] = v;
      const res = await api<{ redirect: string }>('/api/oauth/authorize', {
        method: 'POST',
        body,
      });
      window.location.assign(res.redirect);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-dvh items-start justify-center bg-subtle px-4 py-10 sm:items-center">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
        <BrandMark className="mb-6" />
        {info.isLoading || unauth ? (
          <Spinner />
        ) : info.error ? (
          <Alert tone="danger" title="Não foi possível abrir a autorização">
            {errorMessage(info.error)}
          </Alert>
        ) : info.data ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              Conectar {info.data.client.name} ao Cenário Gestão
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              O aplicativo vai agir em seu nome, com no máximo as permissões que você já tem. Sua
              senha não é compartilhada.
            </p>

            <div className="mt-5 space-y-3 text-sm">
              <div className="flex items-start gap-3 rounded-xl border border-line p-3">
                <Building2 className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                <div>
                  <p className="text-xs font-semibold text-ink-muted uppercase">Empresa</p>
                  <p className="font-semibold text-ink" data-testid="authorize-company">
                    {info.data.company.name}
                  </p>
                  {info.data.company.document && (
                    <p className="text-xs text-ink-muted">{info.data.company.document}</p>
                  )}
                  <p className="mt-1 text-xs text-ink-muted">
                    Você entrou como <strong>{info.data.user.name}</strong>
                    {info.data.user.email ? ` (${info.data.user.email})` : ''}. Esta é a empresa que
                    seu usuário pode vincular.
                  </p>
                </div>
              </div>
              {info.data.org.label && (
                <p className="text-ink-soft">
                  Organização no {info.data.client.name}:{' '}
                  <strong data-testid="authorize-org">{info.data.org.label}</strong>
                </p>
              )}
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-muted uppercase">
                  Permissões pedidas
                </p>
                <ul className="space-y-2">
                  {info.data.scopes.map((s) => (
                    <li key={s.key} className="flex gap-2 rounded-lg bg-subtle p-2.5">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                      <div>
                        <p className="font-semibold text-ink">{s.label}</p>
                        <p className="text-xs text-ink-muted">{s.description}</p>
                        {s.grantedPermissions < s.totalPermissions && (
                          <p className="mt-0.5 text-xs text-warn-600">
                            Seu usuário tem {s.grantedPermissions} de {s.totalPermissions}{' '}
                            permissões desta área; o aplicativo terá só essas.
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-ink-muted">
                Depois de autorizar você volta para {info.data.redirectHost}. Você pode revogar a
                qualquer momento em Aplicativos conectados.
              </p>
            </div>

            {error && (
              <Alert tone="danger" className="mt-4">
                {error}
              </Alert>
            )}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                icon={<X className="size-4" aria-hidden />}
                loading={busy === 'deny'}
                disabled={busy !== null}
                onClick={() => void decide('deny')}
              >
                Cancelar
              </Button>
              <Button
                data-testid="authorize-allow"
                icon={<Check className="size-4" aria-hidden />}
                loading={busy === 'allow'}
                disabled={busy !== null}
                onClick={() => void decide('allow')}
              >
                Autorizar
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
