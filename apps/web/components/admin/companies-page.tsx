'use client';

/**
 * Multi-empresa — etapa 4: painel simples do dono da plataforma. Lista as empresas que usam o
 * sistema (cada "Criar conta" é uma empresa nova) e bloqueia/libera o acesso de cada uma.
 * Mostra só o resumo da empresa; nenhum dado de cliente, pedido ou valor.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Building2, CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface CompanyRow {
  id: number;
  tradeName: string;
  ownerEmail: string | null;
  users: number;
  createdAt: string;
  lastLoginAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  isPlatform: boolean;
}

export function CompaniesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ['platform-companies'],
    queryFn: () => api<{ items: CompanyRow[] }>('/api/v1/platform/companies'),
  });
  const toggle = useMutation({
    mutationFn: (c: CompanyRow) =>
      api(`/api/v1/platform/companies/${c.id}/${c.blockedAt ? 'unblock' : 'block'}`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (_r, c) => {
      toast(
        'ok',
        c.blockedAt
          ? `${c.tradeName} liberada: a equipe dela já pode entrar.`
          : `${c.tradeName} bloqueada: ninguém dela entra até você liberar.`,
      );
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const items = list.data?.items ?? [];
  const outras = items.filter((c) => !c.isPlatform);

  return (
    <>
      <PageHeader
        title="Empresas"
        description="Empresas que usam o Cenário Gestão. Cada conta criada na tela de entrar é uma empresa nova, com dados separados das outras."
      />
      {list.isLoading ? <Spinner /> : null}
      {list.isError ? <Alert tone="danger">{errorMessage(list.error)}</Alert> : null}
      {list.isSuccess && outras.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-6" aria-hidden />}
          title="Nenhuma outra empresa ainda"
          description="Quando alguém criar uma conta na tela de entrar, a empresa aparece aqui."
        />
      ) : null}
      <div className="space-y-3">
        {items.map((c) => (
          <Card
            key={c.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
            data-testid="company-row"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">
                {c.tradeName} <span className="text-sm font-normal text-ink-muted">nº {c.id}</span>
              </p>
              <p className="text-sm text-ink-muted">
                {c.ownerEmail ?? 'sem e-mail'} · {c.users} {c.users === 1 ? 'usuário' : 'usuários'}{' '}
                · criada em {formatDateTime(c.createdAt)} · último acesso{' '}
                {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : 'nunca'}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.isPlatform ? <Badge tone="info">Sua empresa</Badge> : null}
                {c.blockedAt ? (
                  <Badge tone="danger">Bloqueada em {formatDateTime(c.blockedAt)}</Badge>
                ) : (
                  <Badge tone="ok">Ativa</Badge>
                )}
              </div>
            </div>
            {c.isPlatform ? null : (
              <Button
                variant={c.blockedAt ? 'secondary' : 'outline-danger'}
                icon={
                  c.blockedAt ? (
                    <CircleCheck className="size-4" aria-hidden />
                  ) : (
                    <Ban className="size-4" aria-hidden />
                  )
                }
                loading={toggle.isPending && toggle.variables?.id === c.id}
                onClick={() => toggle.mutate(c)}
              >
                {c.blockedAt ? 'Liberar' : 'Bloquear'}
              </Button>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
