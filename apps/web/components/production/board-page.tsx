'use client';

import type { ProductionTaskDto, TaskStatus } from '@cenario/shared';
import {
  PRODUCTION_ACTIVITIES,
  PRODUCTION_ACTIVITY_LABEL,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  mondayOf,
} from '@cenario/shared';
import { Factory } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { Input, Select } from '@/components/ui/field';
import { HelpAndRescheduleBanner } from '@/components/help/pages';
import { Alert, Avatar, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { addDays, formatDay, todayIso } from '@/lib/commercial';
import { useCan, useMe } from '@/lib/hooks';
import { useBoard, useWorkers } from '@/lib/production';
import { TaskStatusBadge, blockersText } from './badges';

type GroupBy = 'funcionario' | 'os' | 'etapa' | 'status' | 'dia';
const GROUP_LABEL: Record<GroupBy, string> = {
  funcionario: 'Funcionário',
  os: 'OS',
  etapa: 'Etapa',
  status: 'Status',
  dia: 'Dia',
};

function groupKey(t: ProductionTaskDto, by: GroupBy): string {
  switch (by) {
    case 'funcionario':
      return t.assignee?.displayName ?? 'Sem responsável';
    case 'os':
      return `${t.serviceOrder.code} · ${t.customerName}`;
    case 'etapa':
      return PRODUCTION_ACTIVITY_LABEL[t.activity];
    case 'status':
      return TASK_STATUS_LABEL[t.status];
    case 'dia':
      return t.scheduledDate ? formatDay(t.scheduledDate) : 'Sem dia';
  }
}

/** Quadro de produção: tarefas publicadas por funcionário, OS, etapa, status ou dia. */
export function ProductionBoardPage() {
  const me = useMe();
  const can = useCan();
  const today = todayIso(me.data?.company.timezone);
  const [from, setFrom] = useState(() => mondayOf(today));
  const [to, setTo] = useState(() => addDays(mondayOf(today), 6));
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState('');
  const [activity, setActivity] = useState('');
  const [os, setOs] = useState('');
  const [by, setBy] = useState<GroupBy>('funcionario');
  const board = useBoard({
    from,
    to,
    assigneeUserId: assignee || undefined,
    status: status || undefined,
    activity: activity || undefined,
  });
  const workers = useWorkers();

  const groups = useMemo(() => {
    const term = os.trim().toLowerCase();
    const rows = (board.data ?? []).filter(
      (t) =>
        !term ||
        t.serviceOrder.code.toLowerCase().includes(term) ||
        t.customerName.toLowerCase().includes(term),
    );
    const map = new Map<string, ProductionTaskDto[]>();
    for (const t of rows) {
      const k = groupKey(t, by);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()];
  }, [board.data, by, os]);

  return (
    <>
      <PageHeader
        title="Quadro de produção"
        description="Tarefas publicadas no planejamento semanal. Atualiza em tempo real conforme os funcionários iniciam, pausam e concluem."
        actions={
          can('producao.planejar') ? (
            <Link
              href="/painel/producao/planejamento"
              className="text-sm font-medium text-brand-700 hover:underline"
            >
              Planejamento semanal →
            </Link>
          ) : undefined
        }
      />
      <HelpAndRescheduleBanner />
      <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="field">
          <span className="label">De</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Até</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Funcionário</span>
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Todos</option>
            {workers.data?.map((w) => (
              <option key={w.userId} value={w.userId}>
                {w.displayName}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span className="label">OS ou cliente</span>
          <Input value={os} placeholder="OS-00001" onChange={(e) => setOs(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Etapa</span>
          <Select value={activity} onChange={(e) => setActivity(e.target.value)}>
            <option value="">Todas</option>
            {PRODUCTION_ACTIVITIES.map((a) => (
              <option key={a} value={a}>
                {PRODUCTION_ACTIVITY_LABEL[a]}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span className="label">Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {TASK_STATUSES.filter((s) => s !== 'RASCUNHO').map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </label>
        <label className="field sm:col-span-2">
          <span className="label">Agrupar por</span>
          <Select
            aria-label="Agrupar por"
            value={by}
            onChange={(e) => setBy(e.target.value as GroupBy)}
          >
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </Select>
        </label>
      </Card>
      {board.isPending ? (
        <Spinner />
      ) : board.isError ? (
        <Alert tone="danger">{board.error.message}</Alert>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Factory className="size-6" aria-hidden />}
            title="Nenhuma tarefa no período"
            description="As tarefas aparecem aqui depois que o planejamento da semana é publicado."
          />
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2" data-testid="production-board">
          {groups.map(([name, tasks]) => (
            <Card key={name} className="p-0">
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <h2 className="font-semibold">{name}</h2>
                <StatusCounts tasks={tasks} />
              </div>
              <ul className="divide-y divide-line">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <BoardRow t={t} />
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function StatusCounts({ tasks }: { tasks: ProductionTaskDto[] }) {
  const counts = new Map<TaskStatus, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  return (
    <span className="text-xs text-ink-muted">
      {[...counts.entries()]
        .map(([s, n]) => `${n} ${TASK_STATUS_LABEL[s].toLowerCase()}`)
        .join(' · ')}
    </span>
  );
}

export function BoardRow({ t }: { t: ProductionTaskDto }) {
  return (
    <Link
      href={`/painel/producao/tarefas/${t.id}`}
      data-testid={`board-task-${t.code}`}
      className="flex items-start gap-3 px-5 py-3 hover:bg-subtle/60"
    >
      {t.assignee ? (
        <Avatar name={t.assignee.displayName} color={t.assignee.color} size={28} />
      ) : (
        <span className="size-7 shrink-0 rounded-full border border-dashed border-line-strong" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t.title}</span>
          <TaskStatusBadge status={t.status} />
          {t.priority !== 'NORMAL' && <PriorityBadge priority={t.priority} />}
          {t.supportFor && (
            <Badge tone="brand">
              Apoio para {t.supportFor.requester ?? 'colega'} · {t.supportFor.code}
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-ink-muted">
          {t.code} · {t.serviceOrder.code}
          {t.serviceOrderItem ? ` · ${t.serviceOrderItem.description}` : ''} ·{' '}
          {t.assignee?.displayName ?? 'sem responsável'}
          {t.scheduledDate ? ` · ${formatDay(t.scheduledDate)} ${t.scheduledTime ?? ''}` : ''}
        </span>
        {(t.blockers.length > 0 || t.blockedReason) && t.status === 'BLOQUEADA' && (
          <span className="mt-0.5 block text-xs text-danger-600">
            {t.blockedReason ?? blockersText(t.blockers)}
          </span>
        )}
        {t.status === 'PAUSADA' && t.pauseNote && (
          <span className="mt-0.5 block text-xs text-warn-600">{t.pauseNote}</span>
        )}
      </span>
    </Link>
  );
}
