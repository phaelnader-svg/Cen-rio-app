'use client';

import type { PickupDto } from '@cenario/shared';
import { PICKUP_STATUSES, PICKUP_STATUS_LABEL } from '@cenario/shared';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, List, Truck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { holidayOf } from '@/lib/holidays';
import { addDays, arrivalText, formatDay, todayIso, usePickups, weekStart } from '@/lib/commercial';
import { PickupStatusBadge } from './badges';
import { useFocusParam } from '@/lib/focus-param';
import { PickupDetailDialog } from './pickup-detail';

const OPEN = 'AGUARDANDO_AGENDAMENTO,AGENDADA,EM_EXECUCAO,RETIRADA_REALIZADA,COM_OCORRENCIA';
const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

/** "AAAA-MM" ± n meses. */
function addMonths(month: string, n: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

function lastDayOfMonth(month: string): string {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function isWeekend(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function AgendaItem({ p, onOpen }: { p: PickupDto; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`agenda-item-${p.code}`}
      className={clsx(
        'w-full rounded-lg border px-2 py-1.5 text-left text-xs leading-snug hover:shadow-[var(--shadow-card)]',
        p.status === 'CANCELADA'
          ? 'border-line bg-subtle text-ink-muted line-through'
          : p.status === 'COM_OCORRENCIA'
            ? 'border-danger-600/30 bg-surface'
            : p.status === 'RECEBIDA_NA_OFICINA'
              ? 'border-ok-600/20 bg-ok-50'
              : 'border-info-600/20 bg-info-50',
      )}
    >
      <span className="block font-semibold">
        {p.windowStart ? `${p.windowStart}${p.windowEnd ? `–${p.windowEnd}` : ''}` : 'Sem horário'}
      </span>
      <span className="block truncate font-medium">{p.customer.name}</span>
      <span className="sr-only">
        {p.code} · {PICKUP_STATUS_LABEL[p.status]}
      </span>
    </button>
  );
}

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
  const today = todayIso();
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [waitingOpen, setWaitingOpen] = useState(false);
  // Rodada 3 (F10-06): link da Central abre o detalhe da retirada (`?foco=<id>`).
  const focus = useFocusParam();
  const [open, setOpen] = useState<string | null>(focus);
  // Mês inteiro, em semanas completas (segunda a domingo).
  const gridStart = weekStart(`${month}-01`);
  const gridEnd = addDays(weekStart(lastDayOfMonth(month)), 6);
  const agenda = usePickups({ from: gridStart, to: gridEnd }, view === 'agenda');
  const unscheduled = usePickups({ status: 'AGUARDANDO_AGENDAMENTO' }, view === 'agenda');
  const list = usePickups({ status }, view === 'lista');
  const days: string[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

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
              aria-label="Mês anterior"
              icon={<ChevronLeft className="size-4" aria-hidden />}
              onClick={() => setMonth(addMonths(month, -1))}
            />
            <Button size="sm" variant="secondary" onClick={() => setMonth(today.slice(0, 7))}>
              Este mês
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label="Próximo mês"
              icon={<ChevronRight className="size-4" aria-hidden />}
              onClick={() => setMonth(addMonths(month, 1))}
            />
            <p className="ml-2 font-medium first-letter:uppercase" data-testid="agenda-range">
              {monthLabel(month)}
            </p>
            <Button
              size="sm"
              variant={unscheduled.data?.length ? 'primary' : 'secondary'}
              className="ml-auto"
              icon={<Clock className="size-3.5" aria-hidden />}
              onClick={() => setWaitingOpen(true)}
              data-testid="pickups-waiting"
            >
              Aguardando agendamento
              {unscheduled.data ? ` (${unscheduled.data.length})` : ''}
            </Button>
          </div>
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded border border-danger-600/30 bg-danger-50" />
              Feriado
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded border border-line-strong bg-subtle" />
              Sábado e domingo
            </span>
          </div>
          {agenda.isError && <Alert tone="danger">{agenda.error.message}</Alert>}
          <div
            className="hidden gap-2 pb-1 text-center text-xs font-semibold text-ink-muted md:grid md:grid-cols-7"
            aria-hidden
          >
            {WEEKDAYS.map((w, i) => (
              <span key={w} className={clsx(i >= 5 && 'text-ink-soft')}>
                {w}
              </span>
            ))}
          </div>
          <div className="grid gap-2 md:grid-cols-7" data-testid="agenda">
            {days.map((d) => {
              const items = agenda.data?.filter((p) => p.scheduledDate === d) ?? [];
              const inMonth = d.slice(0, 7) === month;
              const holiday = holidayOf(d);
              const weekend = isWeekend(d);
              return (
                <div
                  key={d}
                  data-testid={`agenda-day-${d}`}
                  data-holiday={holiday ? 'true' : undefined}
                  data-weekend={weekend ? 'true' : undefined}
                  className={clsx(
                    'rounded-xl border px-3 py-2 md:min-h-28 md:p-2',
                    !inMonth && 'hidden opacity-55 md:block',
                    holiday
                      ? 'border-danger-600/30 bg-danger-50'
                      : weekend
                        ? 'border-line-strong bg-subtle'
                        : 'border-line bg-surface',
                    d === today && 'ring-2 ring-brand-500',
                  )}
                >
                  <p
                    className={clsx(
                      'text-sm font-semibold',
                      holiday
                        ? 'text-danger-700'
                        : d === today
                          ? 'text-brand-700'
                          : 'text-ink-soft',
                    )}
                  >
                    <span className="md:hidden first-letter:uppercase">{formatDay(d)}</span>
                    <span className="hidden md:inline">{Number(d.slice(8))}</span>
                    {d === today && <span className="ml-1.5 text-xs font-medium">hoje</span>}
                  </p>
                  {holiday && (
                    <p className="mb-1 text-[11px] leading-tight text-danger-700">{holiday.name}</p>
                  )}
                  {agenda.isPending ? null : items.length === 0 ? null : (
                    <ul className="mt-1.5 space-y-1.5">
                      {items.map((p) => (
                        <li key={p.id}>
                          <AgendaItem p={p} onOpen={() => setOpen(p.id)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          {agenda.isPending && <Spinner className="mt-4" />}
          {waitingOpen && (
            <Dialog
              open
              onClose={() => setWaitingOpen(false)}
              size="lg"
              title="Aguardando agendamento"
              description="Retiradas solicitadas que ainda não têm data. Abra uma para agendar."
            >
              {unscheduled.isPending ? (
                <Spinner />
              ) : unscheduled.data?.length ? (
                <div className="-mx-1 divide-y divide-line">
                  {unscheduled.data.map((p) => (
                    <PickupLine
                      key={p.id}
                      p={p}
                      onOpen={() => {
                        setWaitingOpen(false);
                        setOpen(p.id);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState title="Nenhuma retirada aguardando agendamento" />
              )}
            </Dialog>
          )}
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
