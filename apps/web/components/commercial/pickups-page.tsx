'use client';

import type { PickupDto } from '@cenario/shared';
import { PICKUP_STATUSES, PICKUP_STATUS_LABEL } from '@cenario/shared';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, List, Truck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { addDays, formatDay, todayIso, usePickups, weekStart, arrivalText } from '@/lib/commercial';
import { PickupStatusBadge } from './badges';
import { PickupDetailDialog } from './pickup-detail';

const OPEN = 'AGUARDANDO_AGENDAMENTO,AGENDADA,EM_EXECUCAO,RETIRADA_REALIZADA,COM_OCORRENCIA';

function PickupLine({ p, onOpen }: { p: PickupDto; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 text-left hover:bg-subtle/70"
      data-testid={`pickup-${p.code}`}
    >
      <span className="w-20 font-mono text-sm font-semibold">{p.code}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{p.customer.name}</p>
        <p className="truncate text-sm text-ink-muted">
          {p.address
            ? `${p.address.street}, ${p.address.number} · ${p.address.city}`
            : 'Sem endereço'}{' '}
          · {p.items.reduce((a, i) => a + i.quantity, 0)} peça(s)
        </p>
      </div>
      <span className="text-sm text-ink-soft">
        {p.scheduledDate
          ? `${formatDay(p.scheduledDate)}${p.windowStart ? ` · ${arrivalText(p.windowStart, p.windowEnd)}` : ''}`
          : 'Sem data'}
      </span>
      <PickupStatusBadge status={p.status} />
    </button>
  );
}

export function PickupsPage() {
  const [view, setView] = useState<'agenda' | 'lista'>('agenda');
  const [status, setStatus] = useState(OPEN);
  const [week, setWeek] = useState(() => weekStart(todayIso()));
  const [open, setOpen] = useState<string | null>(null);
  const weekEnd = addDays(week, 6);
  const agenda = usePickups({ from: week, to: weekEnd }, view === 'agenda');
  const unscheduled = usePickups({ status: 'AGUARDANDO_AGENDAMENTO' }, view === 'agenda');
  const list = usePickups({ status }, view === 'lista');
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const today = todayIso();

  return (
    <>
      <PageHeader
        title="Retiradas"
        description="Solicitações e agenda de retiradas. As confirmações da logística são registradas manualmente nesta fase."
        actions={
          <div
            className="inline-flex rounded-xl border border-line-strong bg-surface p-1"
            role="group"
            aria-label="Visualização"
          >
            <Button
              size="sm"
              variant={view === 'agenda' ? 'primary' : 'ghost'}
              aria-pressed={view === 'agenda'}
              icon={<CalendarDays className="size-3.5" aria-hidden />}
              onClick={() => setView('agenda')}
            >
              Agenda
            </Button>
            <Button
              size="sm"
              variant={view === 'lista' ? 'primary' : 'ghost'}
              aria-pressed={view === 'lista'}
              icon={<List className="size-3.5" aria-hidden />}
              onClick={() => setView('lista')}
            >
              Lista
            </Button>
          </div>
        }
      />
      <p className="mb-4 text-sm text-ink-muted">
        Para solicitar uma retirada, abra o pedido comercial e use “Solicitar retirada”.
      </p>

      {view === 'agenda' ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-label="Semana anterior"
              icon={<ChevronLeft className="size-4" aria-hidden />}
              onClick={() => setWeek(addDays(week, -7))}
            />
            <Button size="sm" variant="secondary" onClick={() => setWeek(weekStart(today))}>
              Esta semana
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label="Próxima semana"
              icon={<ChevronRight className="size-4" aria-hidden />}
              onClick={() => setWeek(addDays(week, 7))}
            />
            <p className="ml-2 font-medium" data-testid="agenda-range">
              {formatDay(week, true)} a {formatDay(weekEnd, true)}
            </p>
          </div>
          {agenda.isError && <Alert tone="danger">{agenda.error.message}</Alert>}
          <div className="grid gap-3 md:grid-cols-7" data-testid="agenda">
            {days.map((d) => {
              const items = agenda.data?.filter((p) => p.scheduledDate === d) ?? [];
              return (
                <Card
                  key={d}
                  className={clsx('min-h-36 p-3', d === today && 'ring-2 ring-brand-200')}
                >
                  <p
                    className={clsx(
                      'mb-2 text-sm font-semibold first-letter:uppercase',
                      d === today ? 'text-brand-700' : 'text-ink-soft',
                    )}
                  >
                    {formatDay(d)}
                  </p>
                  {agenda.isPending ? (
                    <Spinner label="" />
                  ) : items.length === 0 ? (
                    <p className="text-xs text-ink-muted">—</p>
                  ) : (
                    <ul className="space-y-2">
                      {items.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => setOpen(p.id)}
                            className={clsx(
                              'w-full rounded-lg border px-2.5 py-2 text-left text-xs hover:shadow-[var(--shadow-card)]',
                              p.status === 'CANCELADA'
                                ? 'border-line bg-subtle text-ink-muted line-through'
                                : p.status === 'COM_OCORRENCIA'
                                  ? 'border-danger-600/30 bg-danger-50'
                                  : p.status === 'RECEBIDA_NA_OFICINA'
                                    ? 'border-ok-600/20 bg-ok-50'
                                    : 'border-info-600/20 bg-info-50',
                            )}
                          >
                            <span className="block font-semibold">
                              {p.windowStart
                                ? arrivalText(p.windowStart, p.windowEnd)
                                : 'Sem horário'}
                            </span>
                            <span className="block truncate">{p.customer.name}</span>
                            <span className="block text-ink-muted">
                              {p.code} · {PICKUP_STATUS_LABEL[p.status]}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
          <Card className="mt-6 overflow-hidden">
            <h2 className="border-b border-line px-5 py-3.5 font-semibold">
              Aguardando agendamento
            </h2>
            {unscheduled.data?.length ? (
              <div className="divide-y divide-line">
                {unscheduled.data.map((p) => (
                  <PickupLine key={p.id} p={p} onOpen={() => setOpen(p.id)} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nenhuma retirada aguardando agendamento" />
            )}
          </Card>
        </>
      ) : (
        <>
          <Card className="mb-4 p-4">
            <Select
              aria-label="Situação"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="max-w-sm"
            >
              <option value={OPEN}>Em aberto</option>
              <option value="">Todas</option>
              {PICKUP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PICKUP_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Card>
          {list.isPending ? (
            <Spinner />
          ) : list.isError ? (
            <Alert tone="danger">{list.error.message}</Alert>
          ) : list.data.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Truck className="size-6" aria-hidden />}
                title="Nenhuma retirada"
              />
            </Card>
          ) : (
            <Card className="divide-y divide-line overflow-hidden">
              {list.data.map((p) => (
                <PickupLine key={p.id} p={p} onOpen={() => setOpen(p.id)} />
              ))}
            </Card>
          )}
        </>
      )}
      {open && <PickupDetailDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
