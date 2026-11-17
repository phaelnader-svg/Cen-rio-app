'use client';

import { plural } from '@cenario/shared';
import { SERVICE_ORDER_STATUSES, SERVICE_ORDER_STATUS_LABEL } from '@cenario/shared';
import { ClipboardList, Search } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Avatar, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { ExportLink } from '@/components/ui/export-link';
import { formatDay, useServiceOrders } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { OsBulkBar } from '@/components/improvements/os-bulk';
import { DeadlineBadge, PriorityBadge, ServiceOrderStatusBadge } from './badges';
import { OsStateBadge } from './os-state';

export function ServiceOrdersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ABERTA');
  const list = useServiceOrders({ q: useDeferredValue(q), status });
  const can = useCan();
  const bulk = can('os.gerenciar');
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <>
      <PageHeader
        title="Ordens de serviço"
        description="Todas as OS da oficina."
        help="OS técnicas: nascem no fechamento do serviço (Novo serviço) ou pelo pedido, com as peças ainda sem OS."
        actions={<ExportLink href="/api/v1/export/os.csv" testId="export-os" />}
      />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_220px]">
        <label className="relative">
          <span className="sr-only">Pesquisar OS</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Número (OS-00001), cliente ou peça"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          {SERVICE_ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SERVICE_ORDER_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Card>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList className="size-6" aria-hidden />}
            title="Nenhuma OS encontrada"
          />
        </Card>
      ) : (
        <>
          {bulk && <OsBulkBar ids={selected} onDone={() => setSelected([])} />}
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {list.data.items.map((s) => (
                <li key={s.id} className="flex items-center">
                  {bulk && s.status === 'ABERTA' && (
                    <label className="flex self-stretch items-center pl-4">
                      <span className="sr-only">Selecionar {s.code}</span>
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={selected.includes(s.id)}
                        onChange={() => toggle(s.id)}
                      />
                    </label>
                  )}
                  <Link
                    href={`/painel/os/${s.id}`}
                    // Melhoria 160: no celular cada OS vira um cartão (código pequeno, cliente em cima,
                    // selos embaixo); no computador continua uma linha.
                    className="flex min-w-0 flex-1 flex-col gap-1.5 px-5 py-3.5 hover:bg-subtle/70 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1"
                    data-testid={`so-${s.code}`}
                  >
                    <span className="font-mono text-xs font-semibold text-ink-muted sm:w-24 sm:text-sm sm:text-ink">
                      {s.code}
                    </span>
                    <div className="min-w-0 sm:flex-1">
                      <p className="truncate font-medium">{s.customer.name}</p>
                      <p className="text-sm text-ink-muted">
                        Pedido {s.order.code} · {plural(s.pieceCount, 'peça', 'peças')} em{' '}
                        {plural(s.itemCount, 'item', 'itens')}
                        {s.promisedDate ? ` · prazo ${formatDay(s.promisedDate, true)}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:contents">
                      <DeadlineBadge deadline={s.deadline} />
                      {s.technicalLead && (
                        <span className="flex items-center gap-1.5 text-sm text-ink-soft">
                          <Avatar
                            name={s.technicalLead.displayName}
                            color={s.technicalLead.color}
                            photoUrl={s.technicalLead.photoUrl}
                            size={22}
                          />
                          {s.technicalLead.displayName}
                        </span>
                      )}
                      <PriorityBadge priority={s.priority} />
                      {/* Fase 3: o estado geral (mesmo do cabeçalho da OS) no lugar de "Aberta". */}
                      {s.operationalState ? (
                        <OsStateBadge state={s.operationalState} />
                      ) : (
                        <ServiceOrderStatusBadge status={s.status} />
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
