'use client';

/** Aplicativos com acesso delegado ao Cenário Gestão (ex.: Firma Viva): ver e revogar. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

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
  const active = grants.data?.filter((g) => !g.revokedAt) ?? [];
  const past = grants.data?.filter((g) => g.revokedAt) ?? [];

  return (
    <>
      <PageHeader
        title="Aplicativos conectados"
        description="Aplicativos que você autorizou na tela oficial do Cenário Gestão. Eles agem com no máximo as suas permissões e podem ser revogados a qualquer momento."
      />
      {grants.isLoading ? (
        <Spinner />
      ) : active.length === 0 && past.length === 0 ? (
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
