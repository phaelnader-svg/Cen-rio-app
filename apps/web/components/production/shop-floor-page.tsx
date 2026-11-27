'use client';

import { plural, type ShopFloorDto, type ShopFloorServiceDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Hammer } from 'lucide-react';
import Link from 'next/link';
import { OsStateBadge } from '@/components/commercial/os-state';
import { Alert, Avatar, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { NextStepButton } from './next-step';

/**
 * Oficina sem tablet (2026-11-24): "Hoje na oficina" — tudo que está na oficina e ainda não foi
 * entregue, separado por tapeceiro, com o botão verde da próxima etapa. Feito para o celular:
 * cada serviço é um cartão com o botão na largura toda.
 */
export function ShopFloorPage() {
  const can = useCan();
  const q = useQuery({
    queryKey: ['shop-floor'],
    queryFn: () => api<ShopFloorDto>('/api/v1/shop-floor'),
    refetchInterval: 60_000,
  });
  return (
    <>
      <PageHeader
        title="Hoje na oficina"
        description="O que está na oficina, por tapeceiro. Toque no botão verde quando o serviço andar."
        help="Cada botão marca a próxima etapa na ordem da oficina: Começou, Ficou pronta, Aprovada, Saiu para entrega e Entregue. Fica no nome do tapeceiro e o histórico guarda quem marcou. Serviço começado e parado há 3 dias ou mais aparece em laranja e avisa no sininho."
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <>
          {!q.data.withoutTablet && can('empresa.configurar') && (
            <Alert tone="info" className="mb-4">
              Ainda sem tablet? Ligue “Oficina sem tablet” em{' '}
              <Link className="font-medium underline" href="/painel/empresa">
                Empresa → Funcionalidades
              </Link>
              : a foto das etapas fica opcional e a semana planejada vale sem publicar.
            </Alert>
          )}
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count label="Em produção" value={q.data.counts.started} />
            <Count label="Para aprovar" value={q.data.counts.ready} />
            <Count label="Para entregar" value={q.data.counts.delivery} />
            <Count label="Para começar" value={q.data.counts.waiting} />
          </div>
          {q.data.groups.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Hammer className="size-6" aria-hidden />}
                title="Nenhum serviço na oficina"
              />
            </Card>
          ) : (
            <div className="space-y-6">
              {q.data.groups.map((g) => (
                <section key={g.upholsterer?.id ?? '-'} data-testid="shop-floor-group">
                  <h2 className="mb-2 flex items-center gap-2 font-semibold">
                    {g.upholsterer ? (
                      <>
                        <Avatar
                          name={g.upholsterer.displayName}
                          color={g.upholsterer.color ?? '#64748b'}
                          photoUrl={g.upholsterer.photoUrl}
                          size={28}
                        />
                        {g.upholsterer.displayName}
                      </>
                    ) : (
                      'Sem tapeceiro'
                    )}
                    <span className="text-sm font-normal text-ink-muted">
                      · {plural(g.services.length, 'serviço', 'serviços')}
                    </span>
                  </h2>
                  <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {g.services.map((s) => (
                      <ServiceCard key={s.id} s={s} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-sm text-ink-muted">{label}</p>
    </Card>
  );
}

function ServiceCard({ s }: { s: ShopFloorServiceDto }) {
  const stopped = s.stoppedDays !== null && s.stoppedDays >= 3;
  return (
    <li
      className={clsx(
        'flex flex-col gap-3 rounded-xl border bg-surface p-4',
        s.rework || s.late ? 'border-danger-600/50' : 'border-line',
      )}
      data-testid={`shop-floor-${s.code}`}
    >
      <Link href={`/painel/os/${s.id}`} className="min-w-0 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs font-semibold text-ink-muted">{s.code}</span>
          <OsStateBadge state={s.state} />
        </div>
        <p className="font-medium">{s.customer.name}</p>
        <p className="text-sm text-ink-soft">{s.pieces}</p>
        <div className="flex flex-wrap gap-1.5 text-sm">
          {s.promisedDate && (
            <span className={clsx(s.late ? 'font-medium text-danger-600' : 'text-ink-muted')}>
              {s.late ? 'Atrasada · prazo ' : 'Prazo '}
              {formatDay(s.promisedDate, true)}
            </span>
          )}
          {s.rework && <Badge tone="danger">Retrabalho</Badge>}
          {stopped && (
            <Badge tone="warn" dot>
              Parada há {plural(s.stoppedDays!, 'dia', 'dias')}
            </Badge>
          )}
          {!s.materialPurchased && <Badge tone="warn">Aguardando material</Badge>}
        </div>
      </Link>
      {s.next && (
        <NextStepButton
          size="lg"
          full
          os={{
            id: s.id,
            code: s.code,
            nextStep: s.next,
            customer: s.customer,
            pieces: s.pieces.toLowerCase(),
          }}
        />
      )}
    </li>
  );
}
