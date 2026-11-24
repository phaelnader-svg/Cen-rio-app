'use client';

import clsx from 'clsx';
import { plural } from '@cenario/shared';
import { SERVICE_ORDER_STATUSES, SERVICE_ORDER_STATUS_LABEL } from '@cenario/shared';
import { ClipboardList, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Avatar, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { ExportLink } from '@/components/ui/export-link';
import { formatDay, useServiceOrders } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { OsBulkBar } from '@/components/improvements/os-bulk';
import { NextStepButton } from '@/components/production/next-step';
import { DeadlineBadge, PriorityBadge, ReworkBadge, ServiceOrderStatusBadge } from './badges';
import { MaterialPurchasedButton } from './material-purchased';
import { OsStateBadge } from './os-state';

export function ServiceOrdersPage() {
  const [q, setQ] = useState('');
  // "Ver OS" na lista de pedidos abre as OS daquele pedido.
  const orderId = useSearchParams().get('pedido') ?? undefined;
  // Revisão geral: o Início abre a lista já filtrada (ex.: ?situacao=AGUARDANDO_MATERIAL).
  const initial = useSearchParams().get('situacao');
  const [status, setStatus] = useState(orderId ? '' : (initial ?? 'ABERTA'));
  // Fluxo da OS (2026-11-18): "Aguardando material" = OS aberta sem "Material comprado".
  const material = status === 'AGUARDANDO_MATERIAL' ? 'AGUARDANDO' : undefined;
  const list = useServiceOrders({
    q: useDeferredValue(q),
    status: material ? 'ABERTA' : status,
    ...(material ? { material } : {}),
    ...(orderId ? { orderId } : {}),
  });
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
        help="A OS é gerada no pedido depois que a peça chega na tapeçaria. Marque “Material comprado” para ela entrar na programação da semana."
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
          <option value="AGUARDANDO_MATERIAL">Aguardando material</option>
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
          {bulk && (
            <OsBulkBar
              ids={selected}
              rows={list.data.items.filter((x) => selected.includes(x.id))}
              onDone={() => setSelected([])}
            />
          )}
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {list.data.items.map((s) => (
                <li
                  key={s.id}
                  // Revisão geral (item 6): no celular o cartão ocupa a largura toda e o botão da
                  // etapa fica embaixo; a seleção em massa é só no computador.
                  className={clsx(
                    'flex flex-col sm:flex-row sm:items-center',
                    s.rework && 'border-l-4 border-l-danger-600 bg-danger-50/40',
                  )}
                >
                  {bulk && s.status === 'ABERTA' && (
                    <label className="hidden items-center self-stretch pl-4 sm:flex">
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
                      <p className="font-medium sm:truncate">{s.customer.name}</p>
                      <p className="text-sm text-ink-muted">
                        Pedido {s.order.code} · {plural(s.pieceCount, 'peça', 'peças')} em{' '}
                        {plural(s.itemCount, 'item', 'itens')}
                        {s.promisedDate ? ` · prazo ${formatDay(s.promisedDate, true)}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:contents">
                      <ReworkBadge rework={s.rework} />
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
                  {/* Botão só enquanto falta o material; depois some da lista. */}
                  {s.status === 'ABERTA' && !s.materialPurchasedAt && (
                    <div className="shrink-0 px-5 pb-3.5 sm:px-0 sm:pr-4 sm:pb-0 [&>button]:w-full sm:[&>button]:w-auto">
                      <MaterialPurchasedButton os={s} canManage={bulk} compact />
                    </div>
                  )}
                  {/* Oficina sem tablet (2026-11-24): botão verde da próxima etapa, um clique. */}
                  {s.status === 'ABERTA' && s.materialPurchasedAt && s.nextStep && (
                    <div className="shrink-0 px-5 pb-3.5 sm:px-0 sm:pr-4 sm:pb-0">
                      <NextStepButton os={s} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
