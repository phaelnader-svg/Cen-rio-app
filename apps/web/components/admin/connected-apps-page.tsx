'use client';

/** Aplicativos com acesso delegado ao Cenário Gestão (ex.: Firma Viva): ver e revogar. */
import { APP_SCOPES, APP_SCOPE_KEYS, type AppScope } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, PlugZap, Unplug } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';

interface Grant {
  id: string;
  client: string;
  org: string | null;
  user: string;
  scopes: { key: string; label: string }[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  mine: boolean;
}

export function ConnectedAppsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const grants = useQuery({
    queryKey: ['app-grants'],
    queryFn: () => api<Grant[]>('/api/v1/apps/grants'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<{ revoked: boolean }>(`/api/v1/apps/grants/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      toast('ok', 'Acesso revogado. O aplicativo deixa de agir na empresa imediatamente.');
      void qc.invalidateQueries({ queryKey: ['app-grants'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const can = useCan();
  const active = grants.data?.filter((g) => !g.revokedAt) ?? [];
  const past = grants.data?.filter((g) => g.revokedAt) ?? [];

  return (
    <>
      <PageHeader
        title="Aplicativos conectados"
        description="Aplicativos que você autorizou."
        help="Aplicativos que você autorizou na tela oficial do Cenário Gestão. Eles agem com no máximo as suas permissões e podem ser revogados a qualquer momento."
      />
      {grants.isLoading ? <Spinner /> : null}
      {can('empresa.configurar') ? <ClientsAdmin /> : null}
      {grants.isLoading ? null : active.length === 0 && past.length === 0 ? (
        <EmptyState
          icon={<PlugZap className="size-6" aria-hidden />}
          title="Nenhum aplicativo conectado"
          description="Quando você conectar o Firma Viva, a autorização aparece aqui."
        />
      ) : (
        <div className="space-y-3">
          {active.map((g) => (
            <Card key={g.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink" data-testid="grant-row">
                  {g.client}
                  {g.org ? ` · ${g.org}` : ''}
                </p>
                <p className="text-sm text-ink-muted">
                  Autorizado por {g.user} em {formatDateTime(g.createdAt)} · último uso{' '}
                  {g.lastUsedAt ? formatDateTime(g.lastUsedAt) : 'ainda não usado'}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {g.scopes.map((s) => (
                    <Badge key={s.key} tone="info">
                      {s.label}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                variant="outline-danger"
                icon={<Unplug className="size-4" aria-hidden />}
                loading={revoke.isPending && revoke.variables === g.id}
                onClick={() => revoke.mutate(g.id)}
              >
                Revogar acesso
              </Button>
            </Card>
          ))}
          {past.length > 0 && (
            <div className="pt-4">
              <p className="mb-2 text-xs font-semibold text-ink-muted uppercase">Histórico</p>
              {past.map((g) => (
                <p key={g.id} className="text-sm text-ink-muted">
                  {g.client}
                  {g.org ? ` · ${g.org}` : ''} — {g.user}, autorizado em{' '}
                  {formatDateTime(g.createdAt)}, encerrado em {formatDateTime(g.revokedAt)}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

interface ClientRow {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  active: boolean;
  updatedAt: string;
}

/**
 * Cadastro do aplicativo (ex.: Firma Viva) com o endereço EXATO de retorno da autorização.
 * O segredo aparece só uma vez: copie e guarde no cofre do aplicativo (nunca em chat).
 */
function ClientsAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const clients = useQuery({
    queryKey: ['app-clients'],
    queryFn: () => api<ClientRow[]>('/api/v1/apps/clients'),
  });
  const [form, setForm] = useState({
    clientId: 'firma-viva',
    name: 'Firma Viva',
    redirect: 'https://firmaviva.com.br/api/conexoes/cenario/retorno',
  });
  // O Firma Viva (ambiente interativo) usa planta, operação e escritório.
  const [scopes, setScopes] = useState<AppScope[]>(['jogo', 'operacao', 'escritorio']);
  const [secret, setSecret] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<ClientRow & { secret: string }>('/api/v1/apps/clients', {
        method: 'POST',
        body: {
          clientId: form.clientId.trim(),
          name: form.name.trim(),
          redirectUris: form.redirect
            .split(/[\s,]+/)
            .map((r) => r.trim())
            .filter(Boolean),
          scopes,
        },
      }),
    onSuccess: (r) => {
      setSecret(r.secret);
      toast('ok', `Aplicativo ${r.name} salvo. Copie o segredo agora: ele não aparece de novo.`);
      void qc.invalidateQueries({ queryKey: ['app-clients'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Card className="mb-6 space-y-4 p-4" data-testid="apps-admin">
      <div>
        <p className="font-semibold text-ink">Aplicativos cadastrados</p>
        <p className="text-sm text-ink-muted">
          Só aplicativos cadastrados aqui podem pedir autorização, e só para os endereços de retorno
          informados (comparação exata). O aplicativo recebe só as permissões marcadas, e nunca mais
          do que a pessoa que autorizar já tem.
        </p>
      </div>
      {clients.data?.map((c) => (
        <div
          key={c.clientId}
          className="rounded-xl border border-line p-3 text-sm"
          data-testid="app-client-row"
        >
          <p className="font-semibold">
            {c.name} <span className="text-ink-muted">({c.clientId})</span>{' '}
            <Badge tone={c.active ? 'ok' : 'neutral'}>{c.active ? 'ativo' : 'desativado'}</Badge>
          </p>
          <p className="break-all text-ink-muted">Retorno: {c.redirectUris.join(' · ')}</p>
          <p className="text-ink-muted">
            Permissões:{' '}
            {c.scopes
              .map((k) => (APP_SCOPES as Record<string, { label: string }>)[k]?.label ?? k)
              .join(' · ')}
          </p>
          <p className="text-ink-muted">Atualizado em {formatDateTime(c.updatedAt)}</p>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Identificador">
          {(p) => (
            <Input
              {...p}
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            />
          )}
        </Field>
        <Field label="Nome">
          {(p) => (
            <Input
              {...p}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Endereço de retorno (exato)" className="sm:col-span-2">
          {(p) => (
            <Input
              {...p}
              value={form.redirect}
              onChange={(e) => setForm({ ...form, redirect: e.target.value })}
              data-testid="app-client-redirect"
            />
          )}
        </Field>
      </div>
      <fieldset className="space-y-2" data-testid="app-client-scopes">
        <legend className="text-sm font-medium text-ink">Permissões do aplicativo</legend>
        {APP_SCOPE_KEYS.map((k) => (
          <label key={k} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={scopes.includes(k)}
              onChange={(e) =>
                setScopes(e.target.checked ? [...scopes, k] : scopes.filter((x) => x !== k))
              }
              data-testid={`app-client-scope-${k}`}
            />
            <span>
              <span className="font-semibold">{APP_SCOPES[k].label}</span>
              <span className="block text-ink-muted">{APP_SCOPES[k].description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button
        disabled={!scopes.length}
        icon={<KeyRound className="size-4" aria-hidden />}
        loading={save.isPending}
        onClick={() => save.mutate()}
        data-testid="app-client-save"
      >
        Salvar e gerar segredo
      </Button>
      {secret ? (
        <Alert tone="warn" title="Segredo do aplicativo (aparece só agora)">
          <p className="break-all font-mono text-xs" data-testid="app-client-secret">
            {secret}
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            icon={<Copy className="size-4" aria-hidden />}
            onClick={() => void navigator.clipboard?.writeText(secret)}
          >
            Copiar
          </Button>
          <p className="mt-2">
            Cole no servidor do aplicativo (comando de configuração do Firma Viva). Não envie por
            chat ou e-mail. Gerar de novo invalida o anterior.
          </p>
        </Alert>
      ) : null}
    </Card>
  );
}
