'use client';

import type { MyQueueDto, ProductionTaskDto } from '@cenario/shared';
import { WEEK_WAIT_REASON_LABEL, pageOf, summarizeWeek } from '@cenario/shared';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, ListOrdered } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { formatDay } from '@/lib/commercial';
import { useMyQueue, useMyTasks } from '@/lib/production';
import { MyOpenHelp } from './help';
import { MyOpenIssues } from './issues';
import { MyDay, TaskCard } from './tasks';

const DONE = ['CONCLUIDA', 'CANCELADA'];

/**
 * Evolução, Fase 4 — "Minha semana" (planos em fila semanal). Destaque: a tarefa em execução
 * ou, sem ela, a primeira executável (ordem do servidor). Depois, até três próximas e o botão
 * "Ver todas as tarefas". Sem fila (planos por horário), mostra o "Meu dia" anterior.
 * Nada inicia ou conclui sozinho; toda ação passa pelo servidor.
 */
export function MyWeek({
  onOpen,
  onAll,
  canAskHelp,
  reportUserId,
}: {
  onOpen: (id: string) => void;
  onAll: () => void;
  canAskHelp?: boolean;
  reportUserId?: string | null;
}) {
  const queue = useMyQueue();
  const mine = useMyTasks();
  if (queue.isPending) return <Spinner />;
  if (queue.isError)
    return (
      <Alert tone="danger" title="Não foi possível carregar a sua fila">
        {queue.error.message}
        <Button size="lg" className="mt-3" onClick={() => void queue.refetch()}>
          Tentar novamente
        </Button>
      </Alert>
    );
  const q = queue.data;
  // Sem fila semanal: experiência anterior (planos por horário), sem conversão.
  if (q.total === 0 && q.counts.done === 0)
    return <MyDay onOpen={onOpen} canAskHelp={canAskHelp} reportUserId={reportUserId} />;

  const s = summarizeWeek(q);
  const inQueue = new Set(q.items.map((e) => e.task.id));
  const others = (mine.data?.today ?? []).filter(
    (t) => !DONE.includes(t.status) && !inQueue.has(t.id),
  );
  return (
    <div className="space-y-8" data-testid="my-week">
      <WeekHeader q={q} />

      <section aria-labelledby="week-highlight">
        <h2 id="week-highlight" className="mb-3 text-xl font-semibold">
          {s.kind === 'EM_EXECUCAO' ? 'Em execução agora' : 'Próxima tarefa'}
        </h2>
        {s.highlight ? (
          <div data-testid="week-highlight">
            <PreviousWeekTag t={s.highlight} weekStart={q.week.start} />
            <TaskCard t={s.highlight} onOpen={onOpen} highlight />
          </div>
        ) : (
          <NothingToDo q={q} reasons={s.waitReasons} onOpen={onOpen} />
        )}
      </section>

      {canAskHelp && <MyOpenHelp />}
      {reportUserId && <MyOpenIssues userId={reportUserId} />}

      {s.upcoming.length > 0 && (
        <section aria-labelledby="week-next">
          <h2 id="week-next" className="mb-3 text-lg font-semibold text-ink-soft">
            Próximas na fila
          </h2>
          <ol className="grid gap-3 lg:grid-cols-3" data-testid="week-upcoming">
            {s.upcoming.map((e) => (
              <li key={e.task.id} data-testid={`week-next-${e.position}`}>
                <Positioned position={e.position} active={e.executable}>
                  <PreviousWeekTag t={e.task} weekStart={q.week.start} />
                  <TaskCard t={e.task} onOpen={onOpen} compact />
                </Positioned>
              </li>
            ))}
          </ol>
        </section>
      )}

      <Button
        size="xl"
        variant="secondary"
        className="w-full"
        icon={<ListOrdered className="size-6" aria-hidden />}
        onClick={onAll}
        data-testid="week-all"
      >
        Ver todas as tarefas ({q.total})
      </Button>

      {others.length > 0 && (
        <section aria-labelledby="week-others">
          <h2 id="week-others" className="mb-3 text-lg font-semibold text-ink-soft">
            Outras tarefas ({others.length})
          </h2>
          <ul className="grid gap-3 lg:grid-cols-2" data-testid="week-others">
            {others.map((t) => (
              <li key={t.id}>
                <TaskCard t={t} onOpen={onOpen} compact />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function WeekHeader({ q }: { q: MyQueueDto }) {
  const chips: { label: string; value: number; testId: string; tone?: string }[] = [
    { label: 'concluídas na semana', value: q.counts.done, testId: 'count-done' },
    { label: 'em execução', value: q.counts.running, testId: 'count-running', tone: 'brand' },
    { label: 'disponíveis', value: q.counts.executable + q.counts.paused, testId: 'count-ready' },
    { label: 'aguardando', value: q.counts.blocked, testId: 'count-blocked', tone: 'warn' },
  ];
  return (
    <section
      className="rounded-2xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5"
      aria-label="Resumo da semana"
    >
      <p className="text-base text-ink-muted" data-testid="week-period">
        Semana de {formatDay(q.week.start)} a {formatDay(q.week.end)}
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {chips.map((c) => (
          <li
            key={c.testId}
            className={clsx(
              'rounded-xl px-3 py-2',
              c.tone === 'brand' && c.value
                ? 'bg-brand-50 text-brand-700'
                : c.tone === 'warn' && c.value
                  ? 'bg-warn-50 text-warn-600'
                  : 'bg-subtle text-ink-soft',
            )}
          >
            <span className="block text-2xl font-semibold tabular-nums" data-testid={c.testId}>
              {c.value}
            </span>
            <span className="text-sm">{c.label}</span>
          </li>
        ))}
      </ul>
      {q.fromPreviousWeeks > 0 && (
        <p className="mt-3 text-base text-warn-600" data-testid="week-previous">
          {q.fromPreviousWeeks} tarefa(s) de semanas anteriores continuam na sua fila (o gestor
          decide se transfere).
        </p>
      )}
    </section>
  );
}

function PreviousWeekTag({ t, weekStart }: { t: ProductionTaskDto; weekStart: string }) {
  const previous = (t.plan?.weekStart ?? weekStart) < weekStart;
  if (!previous && !t.carriedFromWeek) return null;
  return (
    <span className="mb-1 inline-block rounded-full bg-warn-50 px-3 py-1 text-sm font-semibold text-warn-600">
      {previous
        ? `Semana anterior (${formatDay(t.plan!.weekStart)})`
        : `Transferida da semana de ${formatDay(t.carriedFromWeek!)}`}
    </span>
  );
}

function Positioned({
  position,
  active,
  children,
}: {
  position: number;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <span
        className={clsx(
          'absolute -top-2 -left-2 z-10 grid size-8 place-items-center rounded-full text-sm font-bold shadow',
          active ? 'bg-brand-600 text-white' : 'bg-subtle text-ink-muted',
        )}
        aria-label={`Posição ${position} na fila`}
      >
        {position}
      </span>
      {children}
    </div>
  );
}

/** Nada executável agora: explica o motivo e aponta o caminho (abrir a tarefa e avisar). */
function NothingToDo({
  q,
  reasons,
  onOpen,
}: {
  q: MyQueueDto;
  reasons: string[];
  onOpen: (id: string) => void;
}) {
  const first = q.items[0]?.task;
  return (
    <div
      className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-6"
      data-testid="week-nothing"
      role="status"
    >
      <p className="text-xl font-semibold">Nenhuma tarefa pode ser iniciada agora</p>
      {reasons.length > 0 && (
        <p className="mt-2 text-base text-ink-soft" data-testid="week-reasons">
          Motivo:{' '}
          {reasons
            .map((r) => WEEK_WAIT_REASON_LABEL[r as keyof typeof WEEK_WAIT_REASON_LABEL])
            .join('; ')}
          .
        </p>
      )}
      <p className="mt-2 text-base text-ink-muted">
        Se precisar de algo para continuar, abra a tarefa e use “Tenho um problema” ou fale com o
        gestor. Nenhuma tarefa é liberada pelo tablet.
      </p>
      {first && (
        <Button size="lg" variant="secondary" className="mt-4" onClick={() => onOpen(first.id)}>
          Abrir {first.code}
        </Button>
      )}
    </div>
  );
}

/** Fila completa da semana, na ordem do servidor, paginada (20 por página). */
export function MyQueueAll({ onOpen }: { onOpen: (id: string) => void }) {
  const queue = useMyQueue();
  const [page, setPage] = useState(1);
  if (queue.isPending) return <Spinner />;
  if (queue.isError) return <Alert tone="danger">{queue.error.message}</Alert>;
  const q = queue.data;
  const p = pageOf(q.items, page);
  return (
    <div className="space-y-4" data-testid="queue-all">
      <p className="text-base text-ink-muted">
        {q.total} tarefa(s) na ordem definida pelo gestor. A posição não muda quando uma tarefa fica
        bloqueada.
      </p>
      {q.total === 0 ? (
        <p className="text-lg">Nenhuma tarefa na sua fila.</p>
      ) : (
        <ol className="grid gap-4 lg:grid-cols-2">
          {p.items.map((e) => (
            <li key={e.task.id} data-testid={`queue-all-${e.position}`}>
              <Positioned position={e.position} active={e.executable}>
                <PreviousWeekTag t={e.task} weekStart={q.week.start} />
                <TaskCard t={e.task} onOpen={onOpen} compact />
              </Positioned>
            </li>
          ))}
        </ol>
      )}
      {p.pages > 1 && (
        <nav className="flex items-center justify-between gap-3" aria-label="Páginas da fila">
          <Button
            size="lg"
            variant="secondary"
            disabled={p.page <= 1}
            icon={<ChevronLeft className="size-5" aria-hidden />}
            onClick={() => setPage(p.page - 1)}
          >
            Anteriores
          </Button>
          <span className="text-base text-ink-muted">
            Página {p.page} de {p.pages}
          </span>
          <Button
            size="lg"
            variant="secondary"
            disabled={p.page >= p.pages}
            icon={<ChevronRight className="size-5" aria-hidden />}
            onClick={() => setPage(p.page + 1)}
          >
            Seguintes
          </Button>
        </nav>
      )}
    </div>
  );
}
