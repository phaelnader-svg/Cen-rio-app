'use client';

import type { HolidayDto, LeaveDto, LeaveKind, OpenShiftDto } from '@cenario/shared';
import { LEAVE_KINDS, LEAVE_KIND_LABEL } from '@cenario/shared';
import { CalendarOff, Moon, Plane } from 'lucide-react';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useHolidays, useLeaves, useOpenShifts } from '@/lib/attendance';
import { formatDay } from '@/lib/commercial';
import { formatHourMinute } from '@/lib/format';

/**
 * Simplificação Fase 7 — no painel de Presença: expedientes de dias anteriores sem saída (o
 * gestor resolve; nada é encerrado sozinho), folga/férias por intervalo e o calendário de
 * feriados/dias sem expediente da empresa.
 */
export function OpenShiftsSection({
  manage,
  onResolve,
}: {
  manage: boolean;
  onResolve: (s: OpenShiftDto) => void;
}) {
  const q = useOpenShifts();
  if (!q.data?.length) return null;
  return (
    <Section title="Expedientes sem saída registrada" bodyClassName="p-0">
      <ul className="divide-y divide-line" data-testid="open-shifts">
        {q.data.map((s) => (
          <li
            key={s.attendanceId}
            className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
            data-testid={`open-shift-${s.employee.displayName}`}
          >
            <Moon className="size-4 text-warn-600" aria-hidden />
            <span className="font-medium">{s.employee.displayName}</span>
            <span>
              {formatDay(s.date)} · chegada {formatHourMinute(s.arrivedAt)} · sem encerramento
            </span>
            {manage && (
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                onClick={() => onResolve(s)}
              >
                Resolver
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
        Nenhum horário é inventado: registre a saída informada ou encerre sem horário.
      </p>
    </Section>
  );
}

export function LeavesSection({
  manage,
  employees,
}: {
  manage: boolean;
  employees: { id: string; displayName: string }[];
}) {
  const q = useLeaves();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ leave: LeaveDto; mode: 'fix' | 'cancel' } | null>(null);
  return (
    <Section
      title="Folgas e férias"
      bodyClassName="p-0"
      actions={
        manage ? (
          <Button
            size="sm"
            icon={<Plane className="size-4" aria-hidden />}
            onClick={() => setCreating(true)}
            data-testid="leave-new"
          >
            Registrar folga ou férias
          </Button>
        ) : null
      }
    >
      {q.isPending ? (
        <Spinner className="p-5" />
      ) : !q.data?.length ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Nenhuma folga ou férias registrada.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="leaves">
          {q.data.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
              data-testid={`leave-${l.code}`}
            >
              <span className="font-mono text-xs text-ink-muted">{l.code}</span>
              <span className="font-medium">{l.employee.displayName}</span>
              <span>
                {LEAVE_KIND_LABEL[l.kind]} · {formatDay(l.startDate)}
                {l.endDate !== l.startDate ? ` a ${formatDay(l.endDate)}` : ''} ({l.days} dia
                {l.days > 1 ? 's' : ''})
              </span>
              <span className="text-ink-muted">— {l.reason}</span>
              {l.status === 'CANCELADA' ? (
                <span className="rounded-full bg-subtle px-2 py-0.5 text-xs">
                  Cancelada: {l.cancelReason}
                </span>
              ) : (
                manage && (
                  <span className="ml-auto flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing({ leave: l, mode: 'fix' })}
                    >
                      Corrigir
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing({ leave: l, mode: 'cancel' })}
                    >
                      Cancelar
                    </Button>
                  </span>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
        Folga e férias são situações planejadas: não geram ausência presumida nem proposta por
        falta, e não criam presença nos dias futuros. Correções ficam no histórico.
      </p>
      {creating && <LeaveDialog employees={employees} onClose={() => setCreating(false)} />}
      {editing && (
        <LeaveDialog
          employees={employees}
          leave={editing.leave}
          cancel={editing.mode === 'cancel'}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}

function LeaveDialog({
  employees,
  leave,
  cancel,
  onClose,
}: {
  employees: { id: string; displayName: string }[];
  leave?: LeaveDto;
  cancel?: boolean;
  onClose: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(leave?.employee.id ?? employees[0]?.id ?? '');
  const [kind, setKind] = useState<LeaveKind>(leave?.kind ?? 'FOLGA');
  const [startDate, setStart] = useState(leave?.startDate ?? '');
  const [endDate, setEnd] = useState(leave?.endDate ?? '');
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  const run = () =>
    cancel
      ? api(`/api/v1/attendance/leaves/${leave!.id}/cancel`, {
          method: 'POST',
          body: { reason, version: leave!.version },
          idempotencyKey: key,
        })
      : leave
        ? api(`/api/v1/attendance/leaves/${leave.id}`, {
            method: 'PUT',
            body: { startDate, endDate, reason, version: leave.version },
            idempotencyKey: key,
          })
        : api('/api/v1/attendance/leaves', {
            method: 'POST',
            body: { employeeId, kind, startDate, endDate: endDate || startDate, reason },
            idempotencyKey: key,
          });
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        cancel
          ? `Cancelar ${leave!.code}`
          : leave
            ? `Corrigir ${leave.code} — ${leave.employee.displayName}`
            : 'Registrar folga ou férias'
      }
      description="Sempre com motivo. O registro original fica no histórico."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            data-testid="leave-save"
            onClick={() => m.mutate({ run, ok: 'Folga/férias atualizada.' })}
          >
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!leave && (
          <>
            <Field label="Funcionário">
              {(p) => (
                <Select {...p} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Tipo">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as LeaveKind)}>
                  {LEAVE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {LEAVE_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
        {!cancel && (
          <>
            <Field label="Data inicial">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={startDate}
                  onChange={(e) => setStart(e.target.value)}
                />
              )}
            </Field>
            <Field label="Data final">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={endDate}
                  onChange={(e) => setEnd(e.target.value)}
                />
              )}
            </Field>
          </>
        )}
        <Field label="Motivo" required className="sm:col-span-2">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function HolidaysSection({ manage }: { manage: boolean }) {
  const q = useHolidays();
  const [creating, setCreating] = useState(false);
  const { m, error } = useSend();
  const toggle = (h: HolidayDto) =>
    m.mutate({
      run: () =>
        api(`/api/v1/attendance/holidays/${h.id}`, {
          method: 'PUT',
          body: { active: !h.active, version: h.version },
          idempotencyKey: newIdempotencyKey(),
        }),
      ok: h.active ? 'Dia desativado no calendário.' : 'Dia reativado no calendário.',
    });
  return (
    <Section
      title="Calendário: feriados e dias sem expediente"
      bodyClassName="p-0"
      actions={
        manage ? (
          <Button
            size="sm"
            icon={<CalendarOff className="size-4" aria-hidden />}
            onClick={() => setCreating(true)}
            data-testid="holiday-new"
          >
            Adicionar dia
          </Button>
        ) : null
      }
    >
      {error && (
        <Alert tone="danger" className="m-4">
          {error}
        </Alert>
      )}
      {q.isPending ? (
        <Spinner className="p-5" />
      ) : !q.data?.length ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Nenhum feriado cadastrado.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="holidays">
          {q.data.map((h) => (
            <li
              key={h.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
              data-testid={`holiday-${h.date}`}
            >
              <span className="font-medium tabular-nums">{formatDay(h.date, true)}</span>
              <span className={h.active ? '' : 'text-ink-muted line-through'}>{h.name}</span>
              {!h.active && <span className="text-xs text-ink-muted">inativo</span>}
              {manage && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => toggle(h)}>
                  {h.active ? 'Desativar' : 'Reativar'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
        Em dia sem expediente ninguém é presumido ausente nem atrasado, e a reprogramação pula o
        dia. O histórico de presença já registrado não muda.
      </p>
      {creating && <HolidayDialog onClose={() => setCreating(false)} />}
    </Section>
  );
}

function HolidayDialog({ onClose }: { onClose: () => void }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Adicionar feriado ou dia sem expediente"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            data-testid="holiday-save"
            onClick={() =>
              m.mutate({
                run: () =>
                  api('/api/v1/attendance/holidays', {
                    method: 'POST',
                    body: { date, name },
                    idempotencyKey: key,
                  }),
                ok: 'Dia adicionado ao calendário.',
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Data">
          {(p) => (
            <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </Field>
        <Field label="Nome">
          {(p) => (
            <Input
              {...p}
              value={name}
              placeholder="Ex.: Natal, feriado municipal, recesso"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
