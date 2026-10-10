'use client';

import type { AttendanceAction, AttendanceDayDto } from '@cenario/shared';
import {
  ARRIVAL_KIND_LABEL,
  ATTENDANCE_ACTIONS,
  ATTENDANCE_ACTION_LABEL,
  ATTENDANCE_SITUATION_LABEL,
  AVAILABILITY_LABEL,
  AVAILABILITIES,
  IMPACT_KIND_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import { AlertTriangle, History, PencilLine, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { useSend } from '@/components/production/use-send';
import { availabilityTone } from '@/components/tablet/presence';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Avatar, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAttendanceHistory, useAttendanceImpacts, useTeamAttendance } from '@/lib/attendance';
import { formatDay, todayIso } from '@/lib/commercial';
import { formatDateTime, formatHourMinute } from '@/lib/format';
import { useCan, useMe } from '@/lib/hooks';

/**
 * Presença da equipe (Fase 7): situação, chegada, atraso operacional, tarefa atual e
 * próxima, saída, alertas e histórico. Não é ponto eletrônico nem prova de jornada.
 */
export function TeamAttendancePage() {
  const me = useMe();
  const can = useCan();
  const today = todayIso(me.data?.company.timezone);
  // Sem data escolhida, vale o "hoje" do servidor (relógio operacional da empresa).
  const [picked, setPicked] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const q = useTeamAttendance(picked ?? undefined, employeeId || undefined);
  const date = picked ?? q.data?.date ?? today;
  const impacts = useAttendanceImpacts(date, employeeId || undefined);
  const [acting, setActing] = useState<AttendanceDayDto | null>(null);
  const [historyOf, setHistoryOf] = useState<AttendanceDayDto | null>(null);
  const manage = can('presenca.gerenciar');
  const allMembers = useTeamAttendance(picked ?? undefined);

  const counts = new Map<string, number>();
  for (const d of q.data?.days ?? [])
    counts.set(d.availability, (counts.get(d.availability) ?? 0) + 1);

  return (
    <>
      <PageHeader
        title="Presença da equipe"
        description="Presença operacional para organizar a produção — não é registro de ponto, não calcula jornada nem gera falta ou desconto. Ausência presumida é só um alerta para o gestor confirmar ou corrigir."
      />
      <Card className="mb-6 flex flex-wrap items-end gap-4 p-4">
        <label className="field">
          <span className="label">Data</span>
          <Input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setPicked(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Funcionário</span>
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Todos</option>
            {allMembers.data?.days.map((d) => (
              <option key={d.employee.id} value={d.employee.id}>
                {d.employee.displayName}
              </option>
            ))}
          </Select>
        </label>
        {q.data && (
          <p className="text-sm text-ink-muted">
            Início previsto {q.data.config.workdayStart} · ausência presumida às{' '}
            {q.data.config.arrivalAlertAt} · fim {q.data.config.workdayEnd}
          </p>
        )}
      </Card>

      {q.data && (
        <ul className="mb-6 flex flex-wrap gap-2" aria-label="Resumo da equipe">
          {AVAILABILITIES.filter((a) => counts.get(a)).map((a) => (
            <li
              key={a}
              className={clsx('rounded-full px-3 py-1 text-sm font-semibold', availabilityTone(a))}
            >
              {counts.get(a)} · {AVAILABILITY_LABEL[a]}
            </li>
          ))}
        </ul>
      )}

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : q.data.days.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UserCheck className="size-6" aria-hidden />}
            title="Ninguém registra presença"
            description="Conceda “Registrar a própria presença” às funções da oficina."
          />
        </Card>
      ) : (
        <Card className="mb-8 p-0">
          <div className="overflow-x-auto">
            <table className="data-table min-w-[980px]" data-testid="team-attendance">
              <thead>
                <tr>
                  <th>Funcionário</th>
                  <th>Situação</th>
                  <th>Chegada</th>
                  <th>Tarefa em execução</th>
                  <th>Próxima tarefa</th>
                  <th>Saída</th>
                  <th>Alertas</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {q.data.days.map((d) => (
                  <tr key={d.employee.id} data-testid={`attendance-${d.employee.displayName}`}>
                    <td>
                      <span className="flex items-center gap-2 font-medium">
                        <Avatar name={d.employee.displayName} color={d.employee.color} size={28} />
                        {d.employee.displayName}
                      </span>
                    </td>
                    <td>
                      <span
                        className={clsx(
                          'rounded-full px-2.5 py-1 text-xs font-semibold',
                          availabilityTone(d.availability),
                        )}
                        data-testid="availability"
                      >
                        {AVAILABILITY_LABEL[d.availability]}
                      </span>
                      {d.situation &&
                        !['PRESENTE', 'ENCERRADO', 'AUSENCIA_PRESUMIDA'].includes(d.situation) && (
                          <span className="mt-1 block text-xs text-ink-muted">
                            {ATTENDANCE_SITUATION_LABEL[d.situation]}
                            {d.note ? ` — ${d.note}` : ''}
                          </span>
                        )}
                    </td>
                    <td>
                      {d.arrivedAt ? (
                        <>
                          <span className="font-medium tabular-nums">
                            {formatHourMinute(d.arrivedAt)}
                          </span>
                          {d.arrivalKind && d.arrivalKind !== 'NO_HORARIO' && (
                            <span className="block text-xs text-warn-600" data-testid="late">
                              {ARRIVAL_KIND_LABEL[d.arrivalKind]}
                              {d.lateMinutes ? ` · ${d.lateMinutes} min` : ''}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td>
                      {d.runningTask ? (
                        <TaskLink t={d.runningTask} />
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td>
                      {d.nextTask ? (
                        <TaskLink t={d.nextTask} />
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td>
                      {d.departedAt ? (
                        <>
                          <span className="tabular-nums">{formatHourMinute(d.departedAt)}</span>
                          {d.earlyDeparture && (
                            <span className="block text-xs text-warn-600">Saída antecipada</span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td>
                      {d.openAlerts ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-danger-600">
                          <AlertTriangle className="size-4" aria-hidden /> {d.openAlerts}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {manage && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<PencilLine className="size-3.5" aria-hidden />}
                          onClick={() => setActing(d)}
                        >
                          Registrar
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Histórico de ${d.employee.displayName}`}
                        icon={<History className="size-4" aria-hidden />}
                        onClick={() => setHistoryOf(d)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Section title="Alertas e impacto na produção" bodyClassName="p-0">
        {impacts.isPending ? (
          <Spinner className="p-5" />
        ) : !impacts.data?.length ? (
          <p className="px-5 py-4 text-sm text-ink-muted">Nenhum alerta nesta data.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="attendance-impacts">
            {impacts.data.map((i) => (
              <ImpactRow key={i.id} i={i} manage={manage} />
            ))}
          </ul>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
          O sistema só identifica e apresenta os impactos; nada é cancelado ou transferido
          automaticamente. Reprograme pelo planejamento ou pelo detalhe da tarefa.
        </p>
      </Section>

      {acting && <ActionDialog day={acting} date={date} onClose={() => setActing(null)} />}
      {historyOf && <HistoryDialog day={historyOf} onClose={() => setHistoryOf(null)} />}
    </>
  );
}

function TaskLink({ t }: { t: NonNullable<AttendanceDayDto['runningTask']> }) {
  return (
    <Link href={`/painel/producao/tarefas/${t.id}`} className="hover:underline">
      <span className="font-medium">{t.title}</span>
      <span className="block font-mono text-xs text-ink-muted">{t.code}</span>
    </Link>
  );
}

function ImpactRow({
  i,
  manage,
}: {
  i: NonNullable<ReturnType<typeof useAttendanceImpacts>['data']>[number];
  manage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const { m, error } = useSend(() => setOpen(false));
  return (
    <li
      className={clsx('px-5 py-3 text-sm', i.resolvedAt && 'opacity-60')}
      data-testid={`impact-${i.kind}`}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span
          className={clsx(
            'rounded-full px-2 py-0.5 text-xs font-semibold',
            i.kind === 'DEPENDENTE_AFETADA'
              ? 'bg-warn-50 text-warn-600'
              : i.kind === 'ANDAMENTO_PENDENTE'
                ? 'bg-subtle text-ink-soft'
                : 'bg-danger-50 text-danger-600',
          )}
        >
          {IMPACT_KIND_LABEL[i.kind]}
        </span>
        <span className="font-medium">
          {i.kind === 'ANDAMENTO_PENDENTE' ? '' : 'Ausente: '}
          {i.employee.displayName}
        </span>
        <Link
          href={`/painel/producao/tarefas/${i.task.id}`}
          className="text-brand-700 hover:underline"
        >
          {i.task.code} · {i.task.title}
        </Link>
        {i.dueDate && <span className="text-ink-muted">Prazo {formatDay(i.dueDate)}</span>}
      </p>
      <p className="mt-1 text-ink-soft">{i.detail}</p>
      {i.resolvedAt ? (
        <p className="mt-1 text-xs text-ink-muted">
          Encaminhado: {i.resolution} — {formatDateTime(i.resolvedAt)}
          {i.resolvedBy ? ` · ${i.resolvedBy}` : ''}
        </p>
      ) : (
        manage &&
        (open ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {error && <p className="w-full text-danger-600">{error}</p>}
            <Input
              aria-label="Encaminhamento"
              className="max-w-md"
              placeholder="Ex.: reprogramada para amanhã"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button
              size="sm"
              loading={m.isPending}
              onClick={() =>
                m.mutate({
                  run: () =>
                    api(`/api/v1/attendance/impacts/${i.id}/resolve`, {
                      method: 'POST',
                      body: { resolution: text },
                    }),
                  ok: 'Alerta encaminhado.',
                })
              }
            >
              Salvar
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => setOpen(true)}>
            Registrar encaminhamento
          </Button>
        ))
      )}
    </li>
  );
}

function ActionDialog({
  day,
  date,
  onClose,
}: {
  day: AttendanceDayDto;
  date: string;
  onClose: () => void;
}) {
  const [action, setAction] = useState<AttendanceAction>(
    day.situation === 'AUSENCIA_PRESUMIDA' ? 'CONFIRMAR_AUSENCIA' : 'CORRECAO',
  );
  const [reason, setReason] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [departureTime, setDepartureTime] = useState('');
  const [externalNote, setExternalNote] = useState('');
  const { m, error } = useSend(onClose);
  const needsArrival = ['CHEGADA_TARDIA', 'ESQUECIMENTO', 'CORRECAO'].includes(action);
  const needsDeparture = ['SAIDA_ANTECIPADA', 'CORRECAO'].includes(action);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Presença de ${day.employee.displayName} — ${formatDay(date)}`}
      description="Toda alteração exige justificativa e preserva o registro original no histórico. Atestado: registre só o fato informado, sem dados médicos."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api('/api/v1/attendance/actions', {
                    method: 'POST',
                    body: {
                      employeeId: day.employee.id,
                      date,
                      action,
                      reason,
                      arrivalTime: needsArrival ? arrivalTime || undefined : undefined,
                      departureTime: needsDeparture ? departureTime || undefined : undefined,
                      externalNote: action === 'TRABALHO_EXTERNO' ? externalNote : undefined,
                      version: day.version ?? undefined,
                    },
                  }),
                ok: 'Presença registrada.',
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
        <Field label="O que registrar" className="sm:col-span-2">
          {(p) => (
            <Select
              {...p}
              value={action}
              onChange={(e) => setAction(e.target.value as AttendanceAction)}
            >
              {ATTENDANCE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ATTENDANCE_ACTION_LABEL[a]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {needsArrival && (
          <Field label="Horário de chegada">
            {(p) => (
              <Input
                {...p}
                type="time"
                value={arrivalTime}
                onChange={(e) => setArrivalTime(e.target.value)}
              />
            )}
          </Field>
        )}
        {needsDeparture && (
          <Field label="Horário de saída">
            {(p) => (
              <Input
                {...p}
                type="time"
                value={departureTime}
                onChange={(e) => setDepartureTime(e.target.value)}
              />
            )}
          </Field>
        )}
        {action === 'TRABALHO_EXTERNO' && (
          <Field label="Atividade externa" className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                value={externalNote}
                onChange={(e) => setExternalNote(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label="Justificativa" required className="sm:col-span-2">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

const ACTION_LABEL: Record<string, string> = {
  ...ATTENDANCE_ACTION_LABEL,
  CHEGADA: 'Cheguei (pelo funcionário)',
  SAIDA: 'Encerrou o expediente',
  AUSENCIA_PRESUMIDA: 'Ausência presumida (automática)',
};

function HistoryDialog({ day, onClose }: { day: AttendanceDayDto; onClose: () => void }) {
  const q = useAttendanceHistory(day.employee.id);
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Histórico de ${day.employee.displayName}`}
      description="Últimos 14 dias. Registros originais preservados; correções aparecem como novas entradas."
    >
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : q.data.days.length === 0 ? (
        <p className="text-sm text-ink-muted">Sem registros no período.</p>
      ) : (
        <ol className="space-y-4" data-testid="attendance-history">
          {q.data.days.map((d) => (
            <li key={d.date}>
              <p className="font-semibold">
                {formatDay(d.date, true)} ·{' '}
                {d.situation ? ATTENDANCE_SITUATION_LABEL[d.situation] : 'Sem registro'}
                {d.arrivedAt ? ` · chegada ${formatHourMinute(d.arrivedAt)}` : ''}
                {d.lateMinutes ? ` (${d.lateMinutes} min)` : ''}
                {d.departedAt ? ` · saída ${formatHourMinute(d.departedAt)}` : ''}
              </p>
              <ul className="mt-1 space-y-1 border-l-2 border-line pl-3 text-sm">
                {d.history.map((h) => (
                  <li key={h.id}>
                    <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span>
                    {h.reason && <span className="text-ink-soft"> — {h.reason}</span>}
                    <span className="block text-xs text-ink-muted">
                      {formatDateTime(h.createdAt)} · {h.actor ?? 'Sistema'}
                      {h.device ? ` · ${h.device}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
