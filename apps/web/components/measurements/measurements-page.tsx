'use client';

import type { AwaitingMeasurementDto, MeasurementSummaryDto } from '@cenario/shared';
import {
  MEASUREMENT_KIND_LABEL,
  MEASUREMENT_STATUSES,
  MEASUREMENT_STATUS_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import { CalendarClock, ClipboardCheck, Ruler, Search } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert, Avatar, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useAssignees, useAwaitingMeasurement, useMeasurements } from '@/lib/measurements';
import { KindBadge, MeasurementStatusBadge, RequestStatusBadge } from './badges';
import { CreateMeasurementDialog, type MeasurementTarget } from './create-dialog';

export function MeasurementsPage() {
  const can = useCan();
  const manage = can('medicoes.gerenciar');
  const [tab, setTab] = useState(manage ? 'aguardando' : 'revisao');
  const awaiting = useAwaitingMeasurement();
  const review = useMeasurements({ requestStatus: 'ENVIADA,EM_REVISAO' });
  return (
    <>
      <PageHeader
        title="Medições"
        description="Peças que aguardam medição, rotina de sexta, medições extraordinárias e solicitações de materiais para conferência."
        actions={
          <Link
            href="/painel/planejamento"
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Planejamento de sexta →
          </Link>
        }
      />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'aguardando', label: 'Aguardando medição', count: awaiting.data?.length },
          { key: 'medicoes', label: 'Medições' },
          { key: 'revisao', label: 'Aguardando revisão', count: review.data?.length },
        ]}
      >
        {tab === 'aguardando' && <AwaitingTab manage={manage} />}
        {tab === 'medicoes' && <ListTab />}
        {tab === 'revisao' &&
          (review.isPending ? (
            <Spinner />
          ) : review.isError ? (
            <Alert tone="danger">{review.error.message}</Alert>
          ) : (
            <MeasurementList
              rows={review.data}
              empty="Nenhuma solicitação aguardando conferência."
            />
          ))}
      </Tabs>
    </>
  );
}

function AwaitingTab({ manage }: { manage: boolean }) {
  const awaiting = useAwaitingMeasurement();
  const [target, setTarget] = useState<MeasurementTarget | null>(null);
  if (awaiting.isPending) return <Spinner />;
  if (awaiting.isError) return <Alert tone="danger">{awaiting.error.message}</Alert>;
  if (awaiting.data.length === 0)
    return (
      <Card>
        <EmptyState
          icon={<Ruler className="size-6" aria-hidden />}
          title="Nenhuma peça aguardando medição"
          description="Peças recebidas com OS aberta e sem medição aparecem aqui."
        />
      </Card>
    );
  const groups = new Map<string, AwaitingMeasurementDto[]>();
  for (const a of awaiting.data)
    groups.set(a.serviceOrder.id, [...(groups.get(a.serviceOrder.id) ?? []), a]);
  return (
    <>
      <ul className="space-y-4" data-testid="awaiting-list">
        {[...groups.values()].map((rows) => {
          const first = rows[0]!;
          const t: MeasurementTarget = {
            serviceOrder: { id: first.serviceOrder.id, code: first.serviceOrder.code },
            items: rows.map((r) => ({
              id: r.item.id,
              code: r.item.code,
              description: r.item.description,
            })),
          };
          return (
            <li key={first.serviceOrder.id}>
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
                  <Link
                    href={`/painel/os/${first.serviceOrder.id}`}
                    className="font-mono text-sm font-semibold text-brand-700 hover:underline"
                  >
                    {first.serviceOrder.code}
                  </Link>
                  <span className="min-w-0 flex-1 truncate font-medium">{first.customer.name}</span>
                  {first.serviceOrder.promisedDate && (
                    <span className="text-sm text-ink-muted">
                      prazo {formatDay(first.serviceOrder.promisedDate)}
                    </span>
                  )}
                  <PriorityBadge priority={first.serviceOrder.priority as never} />
                  {manage && rows.length > 1 && (
                    <Button size="sm" variant="secondary" onClick={() => setTarget(t)}>
                      Medir OS inteira
                    </Button>
                  )}
                </div>
                <ul className="divide-y divide-line">
                  {rows.map((r) => (
                    <li
                      key={r.item.id}
                      className="flex flex-wrap items-center gap-3 px-5 py-2.5"
                      data-testid={`awaiting-${r.item.code}`}
                    >
                      <span className="w-28 font-mono text-sm">{r.item.code}</span>
                      <span className="min-w-0 flex-1">
                        {r.item.quantity}× {r.item.description}
                        {r.receivedAt && (
                          <span className="block text-xs text-ink-muted">
                            recebida em {formatDateTime(r.receivedAt)}
                          </span>
                        )}
                      </span>
                      {manage && (
                        <Button
                          size="sm"
                          icon={<Ruler className="size-3.5" aria-hidden />}
                          onClick={() => setTarget({ ...t, itemId: r.item.id })}
                        >
                          Solicitar medição
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          );
        })}
      </ul>
      {target && <CreateMeasurementDialog target={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function ListTab() {
  const can = useCan();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('PENDENTE,EM_ANDAMENTO');
  const [kind, setKind] = useState('');
  const [assignee, setAssignee] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const assignees = useAssignees(can('medicoes.gerenciar'));
  const list = useMeasurements({
    q: useDeferredValue(q),
    status,
    kind,
    assigneeUserId: assignee,
    from,
    to,
  });
  return (
    <>
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="relative lg:col-span-2">
          <span className="sr-only">Pesquisar</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="OS, cliente ou MD-00001"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="PENDENTE,EM_ANDAMENTO">Em aberto</option>
          <option value="">Todas</option>
          {MEASUREMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {MEASUREMENT_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Todos os tipos</option>
          <option value="ROTINA">{MEASUREMENT_KIND_LABEL.ROTINA}</option>
          <option value="EXTRAORDINARIA">{MEASUREMENT_KIND_LABEL.EXTRAORDINARIA}</option>
        </Select>
        <Select
          aria-label="Responsável"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="">Todos os responsáveis</option>
          {assignees.data?.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.displayName}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="shrink-0">Prazo de</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="shrink-0">até</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </Card>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : (
        <MeasurementList rows={list.data} empty="Nenhuma medição encontrada com esses filtros." />
      )}
    </>
  );
}

export function MeasurementList({ rows, empty }: { rows: MeasurementSummaryDto[]; empty: string }) {
  if (rows.length === 0)
    return (
      <Card>
        <EmptyState icon={<ClipboardCheck className="size-6" aria-hidden />} title={empty} />
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line" data-testid="measurement-list">
        {rows.map((m) => (
          <li key={m.id}>
            <Link
              href={`/painel/medicoes/${m.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3.5 hover:bg-subtle/70"
              data-testid={`measurement-${m.code}`}
            >
              <span className="w-20 font-mono text-sm font-semibold">{m.code}</span>
              <div className="min-w-0 flex-1 basis-[calc(100%-6rem)] sm:basis-0">
                <p className="truncate font-medium">
                  {m.serviceOrder.code} · {m.customer.name}
                </p>
                <p className="line-clamp-2 text-sm text-ink-muted">
                  {m.serviceOrderItem
                    ? `${m.serviceOrderItem.code} — ${m.serviceOrderItem.description}`
                    : 'OS inteira'}
                  {m.reason ? ` · ${m.reason}` : ''}
                </p>
              </div>
              <span className="flex items-center gap-1.5 text-sm text-ink-soft">
                <Avatar
                  name={m.assignee.displayName}
                  color={m.assignee.color ?? '#1d4a45'}
                  size={22}
                />
                {m.assignee.displayName}
              </span>
              <span
                className={clsx(
                  'flex items-center gap-1 text-sm',
                  m.overdue ? 'font-semibold text-danger-600' : 'text-ink-muted',
                )}
              >
                <CalendarClock className="size-3.5" aria-hidden />
                {formatDay(m.dueDate)}
                {m.overdue ? ' · atrasada' : ''}
              </span>
              <KindBadge kind={m.kind} />
              <MeasurementStatusBadge status={m.status} />
              {m.request && m.request.status !== 'RASCUNHO' && (
                <RequestStatusBadge status={m.request.status} />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
