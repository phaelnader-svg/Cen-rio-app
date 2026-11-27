'use client';

import { plural } from '@cenario/shared';
import { TRASH_DAYS, TRASH_KIND_LABEL, formatCents, type TrashItemDto } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
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
                    {i.deletedBy ? ` por ${i.deletedBy}` : ''} • sai da lixeira em{' '}
                    {plural(i.daysLeft, 'dia', 'dias')}
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
  money?: {
    paidCents: number;
    receivableOverdueCents: number;
    receivableOverdueCount: number;
    billsDueCents: number;
    billsDueCount: number;
    billsOverdueCount: number;
  } | null;
  production?: { tasksDone: number; lateOs: number; openOs: number; reworks: number } | null;
  pickups?: { done: number; scheduledRest: number } | null;
}

const br = (d: string) => d.split('-').reverse().slice(0, 2).join('/');

function Big({
  label,
  value,
  hint,
  href,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  tone?: 'ok' | 'danger';
}) {
  const body = (
    <Card className="h-full p-5">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p
        className={clsx(
          'mt-1 text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl',
          tone === 'ok' && 'text-ok-600',
          tone === 'danger' && 'text-danger-600',
        )}
      >
        {value}
      </p>
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

function WeekGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold tracking-[0.12em] text-ink-muted uppercase">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
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
        actions={
          <Link
            href="/painel"
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-medium hover:bg-subtle"
            data-testid="week-back"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Voltar
          </Link>
        }
      />
      <div className="space-y-8">
        {(w.receivedCents !== null || w.money) && (
          <WeekGroup title="Dinheiro">
            {w.receivedCents !== null && (
              <Big
                label="Entrou"
                value={formatCents(w.receivedCents)}
                tone="ok"
                href="/painel/financeiro?tab=entradas"
              />
            )}
            {w.money && (
              <>
                <Big
                  label="Saiu"
                  value={formatCents(w.money.paidCents)}
                  hint="Contas, gastos e mão de obra pagos"
                  href="/painel/financeiro?tab=saidas"
                />
                <Big
                  label="Clientes com pagamento atrasado"
                  value={formatCents(w.money.receivableOverdueCents)}
                  tone={w.money.receivableOverdueCount ? 'danger' : undefined}
                  hint={
                    w.money.receivableOverdueCount
                      ? plural(
                          w.money.receivableOverdueCount,
                          'cobrança vencida',
                          'cobranças vencidas',
                        )
                      : 'Nenhuma cobrança vencida'
                  }
                  href="/painel/financeiro?tab=receitas"
                />
                <Big
                  label="Contas para pagar até domingo"
                  value={formatCents(w.money.billsDueCents)}
                  tone={w.money.billsOverdueCount ? 'danger' : undefined}
                  hint={`${plural(w.money.billsDueCount, 'conta', 'contas')}${w.money.billsOverdueCount ? ` • ${plural(w.money.billsOverdueCount, 'vencida', 'vencidas')}` : ''}`}
                  href="/painel/financeiro?tab=pagar"
                />
              </>
            )}
          </WeekGroup>
        )}
        {(w.newServices || w.quotes) && (
          <WeekGroup title="Vendas">
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
            {w.quotes && (
              <Big
                label="Orçamentos aprovados"
                value={`${w.quotes.approved} de ${w.quotes.sent}`}
                hint={`${formatCents(w.quotes.approvedCents)} aprovados${w.quotes.followUpDue ? ` • ${w.quotes.followUpDue} para cobrar resposta` : ''}`}
                href="/painel/orcamentos?aba=salvos"
              />
            )}
          </WeekGroup>
        )}
        {w.production && (
          <WeekGroup title="Oficina">
            <Big
              label="Tarefas concluídas"
              value={String(w.production.tasksDone)}
              hint={`${plural(w.production.openOs, 'OS em andamento', 'OS em andamento')}`}
              href="/painel/producao"
            />
            <Big
              label="OS atrasadas"
              value={String(w.production.lateOs)}
              tone={w.production.lateOs ? 'danger' : 'ok'}
              hint={w.production.lateOs ? 'Passaram do prazo combinado' : 'Tudo dentro do prazo'}
              href="/painel/os"
            />
            <Big
              label="Retrabalhos abertos"
              value={String(w.production.reworks)}
              tone={w.production.reworks ? 'danger' : undefined}
              hint="Nesta semana"
              href="/painel/retrabalhos"
            />
          </WeekGroup>
        )}
        {(w.pickups || w.delivered) && (
          <WeekGroup title="Retiradas e entregas">
            {w.pickups && (
              <Big
                label="Retiradas feitas"
                value={String(w.pickups.done)}
                hint={
                  w.pickups.scheduledRest
                    ? `${plural(w.pickups.scheduledRest, 'ainda agendada', 'ainda agendadas')} nesta semana`
                    : 'Nenhuma outra agendada nesta semana'
                }
                href="/painel/retiradas"
              />
            )}
            {w.delivered && (
              <Big
                label="Peças entregues"
                value={String(w.delivered.pieces)}
                hint={
                  w.delivered.scheduledRest
                    ? `${plural(w.delivered.scheduledRest, 'entrega ainda agendada', 'entregas ainda agendadas')} nesta semana`
                    : 'Nenhuma outra entrega agendada nesta semana'
                }
                href="/painel/entregas"
              />
            )}
          </WeekGroup>
        )}
      </div>
    </>
  );
}
