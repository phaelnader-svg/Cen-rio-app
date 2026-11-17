'use client';

import { TRASH_DAYS, TRASH_KIND_LABEL, formatCents, type TrashItemDto } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

/** Melhoria 86: o que foi apagado nos últimos 30 dias, com "Recuperar". */
export function TrashPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ['lixeira'],
    queryFn: () => api<{ items: TrashItemDto[] }>('/api/v1/trash'),
  });
  const restore = useMutation({
    mutationFn: (i: TrashItemDto) =>
      api(`/api/v1/trash/${i.kind}/${i.id}/restore`, { method: 'POST', body: {} }),
    onSuccess: async (_r, i) => {
      toast('ok', `${TRASH_KIND_LABEL[i.kind]} recuperado.`);
      await qc.invalidateQueries();
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <>
      <PageHeader
        title="Lixeira"
        description={`Orçamentos, fotos e clientes arquivados nos últimos ${TRASH_DAYS} dias. Depois disso, saem da lista.`}
      />
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : !list.data.items.length ? (
        <Card>
          <EmptyState
            icon={<Trash2 className="size-6" aria-hidden />}
            title="A lixeira está vazia"
            description="O que for apagado aparece aqui por 30 dias."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.data.items.map((i) => (
              <li key={`${i.kind}:${i.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
                {i.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={i.thumbUrl}
                    alt=""
                    className="size-12 rounded-lg border border-line object-cover"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {i.title}{' '}
                    <Badge className="ml-1 align-middle">{TRASH_KIND_LABEL[i.kind]}</Badge>
                  </p>
                  <p className="text-sm text-ink-muted">
                    {i.detail ? `${i.detail} • ` : ''}Apagado em{' '}
                    {new Date(i.deletedAt).toLocaleDateString('pt-BR')}
                    {i.deletedBy ? ` por ${i.deletedBy}` : ''} • sai da lixeira em {i.daysLeft}{' '}
                    dia(s)
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RotateCcw className="size-4" aria-hidden />}
                  loading={restore.isPending && restore.variables?.id === i.id}
                  onClick={() => restore.mutate(i)}
                >
                  Recuperar
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

interface WeekDto {
  weekStart: string;
  weekEnd: string;
  newServices: { count: number; valueCents: number | null } | null;
  delivered: { pieces: number; scheduledRest: number } | null;
  receivedCents: number | null;
  quotes: { sent: number; approved: number; approvedCents: number; followUpDue: number } | null;
}

const br = (d: string) => d.split('-').reverse().slice(0, 2).join('/');

function Big({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
}) {
  const body = (
    <Card className="h-full p-5">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-sm text-ink-soft">{hint}</p>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-2xl hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Melhoria 111: a semana em números grandes, pensado para o celular do dono. */
export function WeekSummaryPage() {
  const q = useQuery({
    queryKey: ['resumo-semana'],
    queryFn: () => api<WeekDto>('/api/v1/management/week'),
    refetchInterval: 5 * 60_000,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const w = q.data;
  return (
    <>
      <PageHeader
        title="Resumo da semana"
        description={`De ${br(w.weekStart)} a ${br(w.weekEnd)}. Atualiza sozinho.`}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {w.newServices && (
          <Big
            label="Serviços fechados"
            value={String(w.newServices.count)}
            hint={
              w.newServices.valueCents !== null
                ? `${formatCents(w.newServices.valueCents)} em serviços`
                : undefined
            }
            href="/painel/pedidos"
          />
        )}
        {w.receivedCents !== null && (
          <Big label="Recebido" value={formatCents(w.receivedCents)} href="/painel/financeiro" />
        )}
        {w.delivered && (
          <Big
            label="Peças entregues"
            value={String(w.delivered.pieces)}
            hint={
              w.delivered.scheduledRest
                ? `${w.delivered.scheduledRest} entrega(s) ainda agendada(s) nesta semana`
                : 'Nenhuma outra entrega agendada nesta semana'
            }
            href="/painel/entregas"
          />
        )}
        {w.quotes && (
          <Big
            label="Orçamentos aprovados"
            value={`${w.quotes.approved} de ${w.quotes.sent}`}
            hint={`${formatCents(w.quotes.approvedCents)} aprovados${w.quotes.followUpDue ? ` • ${w.quotes.followUpDue} para cobrar` : ''}`}
            href="/painel/orcamentos?aba=salvos"
          />
        )}
      </div>
    </>
  );
}
