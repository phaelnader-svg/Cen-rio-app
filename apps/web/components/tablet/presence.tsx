'use client';

import type { AttendanceDayDto, MyAttendanceDto } from '@cenario/shared';
import {
  ARRIVAL_KIND_LABEL,
  ATTENDANCE_SITUATION_LABEL,
  AVAILABILITY_LABEL,
  PRIORITY_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import { CheckCircle2, Hand, Moon, TimerReset } from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useMyAttendance } from '@/lib/attendance';
import { formatHourMinute } from '@/lib/format';
import { useOnline } from './tasks';

const ABSENT = ['AUSENCIA_CONFIRMADA', 'AUSENCIA_JUSTIFICADA', 'ATESTADO', 'FOLGA', 'FERIAS'];

export const availabilityTone = (a: AttendanceDayDto['availability']) =>
  a === 'DISPONIVEL'
    ? 'bg-ok-50 text-ok-600'
    : a === 'OCUPADO'
      ? 'bg-bronze-100 text-bronze-600'
      : a === 'EM_PAUSA' || a === 'EXTERNO'
        ? 'bg-warn-50 text-warn-600'
        : a === 'AUSENCIA_PRESUMIDA'
          ? 'bg-danger-50 text-danger-600'
          : 'bg-subtle text-ink-soft';

/**
 * Presença no "Meu dia": "Cheguei" em destaque no início do expediente (um toque, horário
 * do servidor); depois, a situação do dia e "Encerrar expediente" — distinto de "Concluir".
 */
export function PresenceCard({ onDepart }: { onDepart: () => void }) {
  const q = useMyAttendance();
  const online = useOnline();
  const { m, error } = useSend();
  const [key, setKey] = useState(newIdempotencyKey);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const { day, config } = q.data;
  const arrived = Boolean(day.arrivedAt);

  if (day.situation && ABSENT.includes(day.situation)) {
    return (
      <section
        className="rounded-2xl border border-line bg-surface p-6"
        data-testid="presence-card"
      >
        <p className="text-xl font-semibold">{ATTENDANCE_SITUATION_LABEL[day.situation]}</p>
        {day.note && <p className="mt-1 text-base text-ink-muted">{day.note}</p>}
        <p className="mt-2 text-sm text-ink-muted">Registrado pelo gestor.</p>
      </section>
    );
  }

  if (!arrived) {
    return (
      <section
        className="rounded-2xl border-2 border-brand-600/40 bg-brand-50 p-6"
        data-testid="presence-card"
        data-state="pending"
      >
        <p className="text-sm font-semibold tracking-wide text-brand-700 uppercase">
          Início previsto às {config.workdayStart}
        </p>
        {day.situation === 'AUSENCIA_PRESUMIDA' && (
          <p className="mt-1 text-base text-danger-600">
            Sua chegada não foi confirmada até {config.arrivalAlertAt}. Se você já está na oficina,
            toque em Cheguei.
          </p>
        )}
        {day.situation === 'TRABALHO_EXTERNO' && (
          <p className="mt-1 text-base text-ink-soft">Trabalho externo: {day.note}</p>
        )}
        {error && (
          <Alert tone="danger" className="mt-3">
            {error}
          </Alert>
        )}
        <Button
          size="xl"
          className="mt-4 w-full text-2xl"
          data-testid="arrive-button"
          disabled={!q.data.canArrive || !online}
          loading={m.isPending}
          icon={<Hand className="size-7" aria-hidden />}
          onClick={() =>
            m.mutate(
              {
                run: () =>
                  api('/api/v1/attendance/me/arrive', {
                    method: 'POST',
                    body: {},
                    idempotencyKey: key,
                  }),
                ok: 'Chegada confirmada.',
              },
              { onSuccess: () => setKey(newIdempotencyKey()) },
            )
          }
        >
          Cheguei
        </Button>
        {q.data.arriveBlockedReason && (
          <p className="mt-2 text-base text-ink-muted">{q.data.arriveBlockedReason}</p>
        )}
      </section>
    );
  }

  return (
    <section
      className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-surface p-5"
      data-testid="presence-card"
      data-state={day.situation === 'ENCERRADO' ? 'departed' : 'present'}
    >
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-ok-50 text-ok-600">
        <CheckCircle2 className="size-7" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold" data-testid="presence-status">
          {day.situation === 'ENCERRADO'
            ? `Expediente encerrado às ${formatHourMinute(day.departedAt!)}`
            : `Presente desde ${formatHourMinute(day.arrivedAt!)}`}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-base text-ink-muted">
          <span
            className={clsx(
              'rounded-full px-3 py-0.5 text-sm font-semibold',
              availabilityTone(day.availability),
            )}
            data-testid="presence-availability"
          >
            {AVAILABILITY_LABEL[day.availability]}
          </span>
          {day.arrivalKind && day.arrivalKind !== 'NO_HORARIO' && (
            <span>
              {ARRIVAL_KIND_LABEL[day.arrivalKind]}
              {day.lateMinutes ? ` (${day.lateMinutes} min)` : ''}
            </span>
          )}
        </p>
      </div>
      {q.data.canDepart && (
        <Button
          size="lg"
          variant="secondary"
          className="border-2"
          data-testid="depart-button"
          icon={<Moon className="size-5" aria-hidden />}
          onClick={onDepart}
        >
          Encerrar expediente
        </Button>
      )}
    </section>
  );
}

type TaskInput = { note: string; step: string; nextStep: string; percent: number | null };
const empty: TaskInput = { note: '', step: '', nextStep: '', percent: null };
const informed = (t: TaskInput) =>
  Boolean(t.note.trim() || t.step.trim() || t.nextStep.trim() || t.percent !== null);

/**
 * Encerrar expediente: incentiva registrar o andamento das tarefas em execução, mas a
 * saída nunca é bloqueada por isso (sem andamento, o gestor recebe uma pendência).
 */
export function DepartScreen({ data, onDone }: { data: MyAttendanceDto; onDone: () => void }) {
  const online = useOnline();
  const { m, error } = useSend(onDone);
  const [key] = useState(newIdempotencyKey);
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, TaskInput>>(() =>
    Object.fromEntries(data.openTasks.map((t) => [t.id, { ...empty }])),
  );
  const set = (id: string, patch: Partial<TaskInput>) =>
    setValues((v) => ({ ...v, [id]: { ...v[id]!, ...patch } }));
  const missing = data.openTasks.filter((t) => !informed(values[t.id]!));
  const field = 'input input-lg';
  const send = () =>
    m.mutate({
      run: () =>
        api('/api/v1/attendance/me/depart', {
          method: 'POST',
          idempotencyKey: key,
          body: {
            note: note.trim() || undefined,
            tasks: data.openTasks
              .filter((t) => informed(values[t.id]!))
              .map((t) => ({
                taskId: t.id,
                note: values[t.id]!.note.trim() || undefined,
                step: values[t.id]!.step.trim() || undefined,
                nextStep: values[t.id]!.nextStep.trim() || undefined,
                percent: values[t.id]!.percent,
              })),
          },
        }),
      ok: 'Expediente encerrado.',
    });

  return (
    <div className="space-y-6" data-testid="depart-screen">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Encerrar expediente</h1>
        <p className="mt-1 text-base text-ink-muted">
          {data.openTasks.length
            ? 'Antes de sair, conte como ficou cada tarefa. Ela será pausada com o andamento preservado.'
            : 'Nenhuma tarefa em execução. Confirme a saída.'}
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {data.openTasks.map((t) => {
        const v = values[t.id]!;
        return (
          <section
            key={t.id}
            className="rounded-2xl border border-line bg-surface p-5"
            data-testid={`depart-task-${t.code}`}
          >
            <p className="text-lg font-semibold">
              {t.code} · {t.title}
            </p>
            <p className="text-sm text-ink-muted">
              Prioridade {PRIORITY_LABEL[t.priority].toLowerCase()}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className="label-lg">Como ficou</span>
                <input
                  aria-label={`Andamento de ${t.code}`}
                  className={field}
                  value={v.note}
                  maxLength={500}
                  onChange={(e) => set(t.id, { note: e.target.value })}
                />
              </label>
              <label>
                <span className="label-lg">Etapa atual</span>
                <input
                  aria-label={`Etapa atual de ${t.code}`}
                  className={field}
                  value={v.step}
                  maxLength={200}
                  onChange={(e) => set(t.id, { step: e.target.value })}
                />
              </label>
              <label>
                <span className="label-lg">Próximo passo</span>
                <input
                  aria-label={`Próximo passo de ${t.code}`}
                  className={field}
                  value={v.nextStep}
                  maxLength={200}
                  onChange={(e) => set(t.id, { nextStep: e.target.value })}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {[25, 50, 75].map((p) => (
                <Button
                  key={p}
                  size="lg"
                  variant={v.percent === p ? 'primary' : 'secondary'}
                  aria-pressed={v.percent === p}
                  onClick={() => set(t.id, { percent: v.percent === p ? null : p })}
                >
                  {p}%
                </Button>
              ))}
            </div>
          </section>
        );
      })}
      <label className="block">
        <span className="label-lg">Observação do dia (opcional)</span>
        <input
          aria-label="Observação do dia"
          className={field}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {missing.length > 0 && data.openTasks.length > 0 && (
        <p className="flex items-center gap-2 text-base text-warn-600">
          <TimerReset className="size-5" aria-hidden />
          {missing.length} tarefa(s) sem andamento: você pode sair mesmo assim — o gestor será
          avisado para acompanhar.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Button size="xl" variant="secondary" onClick={onDone}>
          Voltar
        </Button>
        <Button
          size="xl"
          disabled={!online}
          loading={m.isPending}
          icon={<Moon className="size-6" aria-hidden />}
          onClick={send}
          data-testid="confirm-depart"
        >
          {missing.length && data.openTasks.length ? 'Encerrar mesmo assim' : 'Encerrar expediente'}
        </Button>
      </div>
    </div>
  );
}
