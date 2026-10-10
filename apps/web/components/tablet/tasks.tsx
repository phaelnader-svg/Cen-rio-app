'use client';

import type {
  MyQueueDto,
  NotificationDto,
  PauseReason,
  ProductionTaskDetailDto,
  ProductionTaskDto,
} from '@cenario/shared';
import {
  LINE_STAGE_LABEL,
  PAUSE_REASONS,
  PAUSE_REASON_LABEL,
  PIECE_TYPE_LABEL,
  PRIORITY_LABEL,
  PRODUCTION_ACTIVITY_LABEL,
  RELEASE_BLOCKER_LABEL,
  TASK_ROLE_LABEL,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Camera,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Lock,
  MessageSquarePlus,
  Package,
  PackageX,
  Pause,
  Play,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { TaskStatusBadge } from '@/components/production/badges';
import { TaskHistory, TaskRefs } from '@/components/production/task-history';
import { useSend } from '@/components/production/use-send';
import { qtyText, specText } from '@/components/purchasing/format';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useMyQueue, useMyTasks, useNotifications, useTask } from '@/lib/production';
import { useRealtime } from '@/lib/realtime';
import { AlternativeTasks, HelpPanel, MyOpenHelp, SupportInfo } from './help';
import { IssueInfo, MyOpenIssues, ProblemPanel } from './issues';
import { PackagingPanel, QualityInfo } from './quality';

const DONE = ['CONCLUIDA', 'CANCELADA'];
const isOpen = (t: ProductionTaskDto) => !DONE.includes(t.status);

/** Ações só com o servidor alcançável: nada é "salvo" sem confirmação dele. */
export function useOnline() {
  return useRealtime().status === 'online';
}

/** Quantidade de tarefas de hoje ainda abertas (bloco da tela inicial). */
export function useMyTodayCount(enabled: boolean) {
  const q = useMyTasks(enabled);
  return q.data?.today.filter(isOpen).length;
}

/** Aviso fixo quando a conexão cai: os dados ficam visíveis, as ações não. */
export function OfflineBanner() {
  const { status } = useRealtime();
  if (status === 'online' || status === 'connecting') return null;
  return (
    <div
      role="alert"
      data-testid="offline-banner"
      className="flex items-center gap-3 bg-danger-600 px-6 py-3 text-base font-semibold text-white sm:px-8"
    >
      <WifiOff className="size-6 shrink-0" aria-hidden />
      <span>
        Sem conexão com o servidor. Os dados abaixo podem estar desatualizados e as ações ficam
        desativadas até a conexão voltar.
      </span>
    </div>
  );
}

/** Botão do sino com a contagem de avisos não lidos. */
export function NotificationsButton({ onClick }: { onClick: () => void }) {
  const q = useNotifications();
  const unread = q.data?.unread ?? 0;
  return (
    <Button
      variant="secondary"
      size="lg"
      onClick={onClick}
      data-testid="notifications-button"
      aria-label={`Avisos: ${unread} não lido(s)`}
      icon={<Bell className="size-5" aria-hidden />}
    >
      Avisos
      {unread > 0 && (
        <span
          className="ml-1 grid min-w-7 place-items-center rounded-full bg-danger-600 px-2 text-sm font-bold text-white"
          data-testid="notifications-unread"
        >
          {unread}
        </span>
      )}
    </Button>
  );
}

// ─────────────────────────── Meu dia ───────────────────────────

/**
 * Tela "Meu dia": tarefa em execução, próxima liberada e as tarefas de hoje na ordem
 * de prioridade (em execução → liberadas urgentes → liberadas → programadas → bloqueadas).
 */
export function MyDay({
  onOpen,
  canAskHelp,
  reportUserId,
}: {
  onOpen: (id: string) => void;
  canAskHelp?: boolean;
  /** Fase 9: quem registra problemas (mostra os próprios ainda abertos). */
  reportUserId?: string | null;
}) {
  const q = useMyTasks();
  const queue = useMyQueue();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const today = q.data.today;
  const current = today.find((t) => t.status === 'EM_EXECUCAO');
  const paused = today.filter((t) => t.status === 'PAUSADA');
  // Fila semanal: a próxima é a primeira executável na ordem da fila (nunca inicia sozinha).
  const fila = queue.data && queue.data.total > 0 ? queue.data : null;
  const inQueue = new Set(fila?.items.map((e) => e.task.id) ?? []);
  const next = fila ? (fila.next ?? undefined) : today.find((t) => t.status === 'LIBERADA');
  const open = today.filter((t) => isOpen(t) && !inQueue.has(t.id));
  const done = today.filter((t) => !isOpen(t));
  return (
    <div className="space-y-8" data-testid="my-day">
      <section className="grid gap-5 lg:grid-cols-2">
        <Highlight
          label="Em execução"
          empty={
            paused.length
              ? `${paused.length} tarefa(s) pausada(s) — retome quando puder.`
              : 'Nenhuma tarefa em execução agora.'
          }
          task={current ?? paused[0]}
          onOpen={onOpen}
          testId="current-task"
        />
        <Highlight
          label={fila ? 'Próxima da fila' : 'Próxima tarefa liberada'}
          empty="Nenhuma tarefa liberada para começar."
          task={next}
          onOpen={onOpen}
          testId="next-task"
        />
      </section>

      {canAskHelp && <MyOpenHelp />}
      {reportUserId && <MyOpenIssues userId={reportUserId} />}

      {fila && <QueueSection queue={fila} onOpen={onOpen} />}

      <section>
        <h2 className="mb-3 text-xl font-semibold">
          {fila ? 'Outras tarefas' : 'Tarefas de hoje'} ({open.length})
        </h2>
        {open.length === 0 && fila ? (
          <p className="text-base text-ink-muted">Nenhuma tarefa fora da fila.</p>
        ) : open.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
            <ClipboardCheck className="mx-auto size-10 text-ink-muted" aria-hidden />
            <p className="mt-3 text-xl font-semibold">Nenhuma tarefa para hoje</p>
            <p className="mt-1 text-base text-ink-muted">
              Quando o gestor publicar a programação, suas tarefas aparecem aqui na hora.
            </p>
          </div>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2" data-testid="my-tasks-today">
            {open.map((t) => (
              <li key={t.id}>
                <TaskCard t={t} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {q.data.upcoming.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink-soft">Próximos dias</h2>
          <ul className="grid gap-3 lg:grid-cols-2" data-testid="my-tasks-upcoming">
            {q.data.upcoming.map((t) => (
              <li key={t.id}>
                <TaskCard t={t} onOpen={onOpen} compact />
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink-soft">Concluídas hoje</h2>
          <ul className="grid gap-3 lg:grid-cols-2" data-testid="my-tasks-done">
            {done.map((t) => (
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

/**
 * Evolução Fase 2 — fila semanal: ordem definida pelo gestor, sem horário. A posição não muda
 * quando uma tarefa fica bloqueada; a fila continua de um dia para o outro.
 */
function QueueSection({ queue, onOpen }: { queue: MyQueueDto; onOpen: (id: string) => void }) {
  return (
    <section data-testid="my-queue">
      <h2 className="mb-1 text-xl font-semibold">Minha fila da semana ({queue.total})</h2>
      <p className="mb-3 text-base text-ink-muted">
        Siga a ordem: conclua uma e toque em Iniciar na próxima.
        {queue.blockedAhead > 0 &&
          ` ${queue.blockedAhead} tarefa(s) à frente aguardando desbloqueio (mantêm o lugar).`}
      </p>
      <ol className="grid gap-4 lg:grid-cols-2">
        {queue.items.map((e) => {
          const active = e.executable || e.task.status === 'EM_EXECUCAO';
          return (
            <li key={e.task.id} data-testid={`queue-item-${e.position}`} className="relative">
              <span
                className={clsx(
                  'absolute -top-2 -left-2 z-10 flex size-8 items-center justify-center rounded-full text-sm font-bold shadow',
                  active ? 'bg-brand-600 text-white' : 'bg-subtle text-ink-muted',
                )}
                aria-label={`Posição ${e.position}`}
              >
                {e.position}
              </span>
              <TaskCard t={e.task} onOpen={onOpen} compact={!active} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Highlight({
  label,
  empty,
  task,
  onOpen,
  testId,
}: {
  label: string;
  empty: string;
  task: ProductionTaskDto | undefined;
  onOpen: (id: string) => void;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="mb-2 text-sm font-semibold tracking-wide text-ink-muted uppercase">{label}</p>
      {task ? (
        <TaskCard t={task} onOpen={onOpen} highlight />
      ) : (
        <p className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-6 text-base text-ink-muted">
          {empty}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────── Cartão ───────────────────────────

const ACCENT: Partial<Record<ProductionTaskDto['status'], string>> = {
  LIBERADA: 'border-brand-600/50 ring-2 ring-brand-600/15',
  EM_EXECUCAO: 'border-bronze-600/60 ring-2 ring-bronze-600/20',
  PAUSADA: 'border-warn-600/50',
  BLOQUEADA: 'border-danger-600/25',
};

/** Situação dos materiais a partir do que a tarefa já informa (sem consulta extra). */
function materialsOf(t: ProductionTaskDto): 'NAO_EXIGE' | 'DISPONIVEIS' | 'FALTANDO' {
  if (!t.requiresMaterials) return 'NAO_EXIGE';
  return t.blockers.includes('MATERIAIS') ? 'FALTANDO' : 'DISPONIVEIS';
}

function MaterialsIndicator({ state }: { state: 'NAO_EXIGE' | 'DISPONIVEIS' | 'FALTANDO' }) {
  if (state === 'NAO_EXIGE') return null;
  return state === 'DISPONIVEIS' ? (
    <span className="inline-flex items-center gap-1 text-ok-600">
      <Package className="size-4" aria-hidden /> Materiais disponíveis
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 font-semibold text-danger-600">
      <PackageX className="size-4" aria-hidden /> Falta material
    </span>
  );
}

const generatedTitle = (t: ProductionTaskDto) =>
  t.title === PRODUCTION_ACTIVITY_LABEL[t.activity] ||
  Boolean(t.serviceOrderItem && t.title.endsWith(` — ${t.serviceOrderItem.code}`));

/** Motivo de espera em linguagem simples. */
function waitingText(t: ProductionTaskDto) {
  if (t.status === 'PROGRAMADA' && t.scheduledDate)
    return `Programada: libera em ${formatDay(t.scheduledDate)} às ${t.scheduledTime}.`;
  if (t.status !== 'BLOQUEADA') return null;
  const parts = t.blockers
    .filter((b) => b !== 'BLOQUEIO')
    .map((b) =>
      b === 'DEPENDENCIAS'
        ? `aguardando ${t.dependsOn
            .filter((d) => !DONE.includes(d.status))
            .map((d) => `${d.title}${d.assignee ? ` (${d.assignee})` : ''}`)
            .join(', ')}`
        : RELEASE_BLOCKER_LABEL[b].toLowerCase(),
    );
  if (t.blockedReason) parts.unshift(`bloqueada pelo gestor: ${t.blockedReason}`);
  return parts.length ? `Por que espera: ${parts.join('; ')}.` : null;
}

export function TaskCard({
  t,
  onOpen,
  compact,
  highlight,
}: {
  t: ProductionTaskDto;
  onOpen: (id: string) => void;
  compact?: boolean;
  highlight?: boolean;
}) {
  const why = waitingText(t);
  return (
    <div
      data-testid={`my-task-${t.code}`}
      data-status={t.status}
      className={clsx(
        'flex h-full flex-col rounded-2xl border bg-surface shadow-[var(--shadow-card)]',
        ACCENT[t.status] ?? 'border-line',
        !isOpen(t) && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(t.id)}
        aria-label={`Abrir ${t.title}`}
        className="flex flex-1 items-start gap-4 p-5 text-left active:scale-[0.99]"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span className="font-mono font-semibold text-ink-soft">{t.serviceOrder.code}</span>
            {t.serviceOrderItem && <span>· {t.serviceOrderItem.code}</span>}
            <span>· {t.code}</span>
          </span>
          {/* Título gerado pelo modelo ("Etapa — OS-xxxxx/n"): mostra etapa e peça; título
              próprio dado pelo gestor vira o destaque, com a etapa abaixo. */}
          <span className={clsx('mt-1 block font-semibold', highlight ? 'text-2xl' : 'text-xl')}>
            {generatedTitle(t)
              ? `${PRODUCTION_ACTIVITY_LABEL[t.activity]}${t.serviceOrderItem ? ` — ${t.serviceOrderItem.description}` : ''}`
              : t.title}
          </span>
          {!generatedTitle(t) && (
            <span className="mt-0.5 block truncate text-base text-ink-muted">
              {PRODUCTION_ACTIVITY_LABEL[t.activity]}
              {t.serviceOrderItem ? ` — ${t.serviceOrderItem.description}` : ''}
            </span>
          )}
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <TaskStatusBadge status={t.status} />
            <span
              className={clsx(
                'rounded-full px-3 py-1 font-semibold',
                t.priority === 'URGENTE'
                  ? 'bg-danger-600 text-white'
                  : t.priority === 'ALTA'
                    ? 'bg-danger-50 text-danger-600'
                    : 'bg-subtle text-ink-soft',
              )}
            >
              {PRIORITY_LABEL[t.priority]}
            </span>
            {t.dueDate && (
              <span className="inline-flex items-center gap-1 text-ink-muted">
                <CalendarClock className="size-4" aria-hidden /> Prazo {formatDay(t.dueDate)}
              </span>
            )}
            {t.scheduledDate && (
              <span className="text-ink-muted">
                {formatDay(t.scheduledDate)} {t.scheduledTime}
              </span>
            )}
            <span className="text-ink-muted">{t.assignee?.displayName ?? 'Sem responsável'}</span>
            <MaterialsIndicator state={materialsOf(t)} />
          </span>
          {why && (
            <span className="mt-2 block text-base text-danger-600" data-testid="task-why">
              {why}
            </span>
          )}
          {t.status === 'PAUSADA' && t.pauseReason && (
            <span className="mt-2 block text-base text-warn-600">
              Pausada — {PAUSE_REASON_LABEL[t.pauseReason]}
              {t.pauseImpediment ? ' (impedimento)' : ''}
            </span>
          )}
          <PieceOwnerInfo t={t} />
          <SupportInfo t={t} />
          <IssueInfo t={t} />
          <QualityInfo t={t} />
        </span>
        <ChevronRight className="mt-1 size-6 shrink-0 text-ink-muted" aria-hidden />
      </button>
      {!compact && <QuickAction t={t} />}
    </div>
  );
}

/**
 * Evolução Fase 4: tapeceiro titular da peça × quem executa a etapa. Quem prepara/desmonta a
 * peça de outro titular vê de quem é a peça; o titular vê que a tapeçaria é dele. Só exibição.
 */
export function PieceOwnerInfo({ t }: { t: ProductionTaskDto }) {
  const owner = t.serviceOrderItem?.upholsterer;
  if (!owner) return null;
  const mine = t.assignee?.userId === owner.userId;
  return (
    <span className="mt-2 block text-sm text-ink-soft" data-testid="piece-owner">
      {mine && t.stepClass === 'TAPECARIA'
        ? 'Você é o tapeceiro titular desta peça.'
        : `Tapeceiro titular da peça: ${owner.displayName}${mine ? '' : ' — esta etapa é de apoio.'}`}
    </span>
  );
}

/** Ação rápida no próprio cartão: Iniciar (1 toque) ou Concluir (toque + confirmação). */
function QuickAction({ t }: { t: ProductionTaskDto }) {
  const online = useOnline();
  const { m, error } = useSend();
  const [key, setKey] = useState(newIdempotencyKey);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = window.setTimeout(() => setConfirm(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirm]);
  const simpleComplete =
    t.status === 'EM_EXECUCAO' &&
    t.completionRequirement === 'NENHUM' &&
    t.activity !== 'EMBALAGEM';
  if (t.status !== 'LIBERADA' && !simpleComplete) return null;
  const run = (path: 'start' | 'complete', ok: string) =>
    m.mutate(
      {
        run: () =>
          api(`/api/v1/production-tasks/${t.id}/${path}`, {
            method: 'POST',
            body: {},
            idempotencyKey: key,
          }),
        ok,
      },
      { onSuccess: () => setKey(newIdempotencyKey()) },
    );
  return (
    <div className="border-t border-line p-3">
      {error && <p className="mb-2 text-sm text-danger-600">{error}</p>}
      {t.status === 'LIBERADA' ? (
        <Button
          size="xl"
          className="w-full"
          disabled={!online}
          loading={m.isPending}
          icon={<Play className="size-6" aria-hidden />}
          onClick={() => run('start', 'Tarefa iniciada.')}
        >
          Iniciar
        </Button>
      ) : (
        <Button
          size="xl"
          className="w-full"
          variant={confirm ? 'primary' : 'secondary'}
          disabled={!online}
          loading={m.isPending}
          icon={<CheckCircle2 className="size-6" aria-hidden />}
          onClick={() => (confirm ? run('complete', 'Tarefa concluída.') : setConfirm(true))}
        >
          {confirm ? 'Toque de novo para confirmar' : 'Concluir'}
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────── Detalhe ───────────────────────────

/** Detalhe da tarefa: ações grandes e informações técnicas (sem valores comerciais). */
export function MyTaskDetail({
  id,
  onOpen,
  canAskHelp,
  reportUserId,
}: {
  id: string;
  onOpen?: (id: string) => void;
  canAskHelp?: boolean;
  /** Fase 9: usuário que pode registrar problemas nas próprias tarefas. */
  reportUserId?: string | null;
}) {
  const q = useTask(id);
  const online = useOnline();
  const { m, error } = useSend();
  const [panel, setPanel] = useState<'pause' | 'progress' | 'complete' | null>(null);
  const [startKey, setStartKey] = useState(newIdempotencyKey);
  const [completeKey, setCompleteKey] = useState(newIdempotencyKey);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const t = q.data;
  const post = (path: string, body: unknown, ok: string, idempotencyKey?: string) =>
    m.mutate(
      {
        run: () =>
          api(`/api/v1/production-tasks/${t.id}/${path}`, {
            method: 'POST',
            body,
            idempotencyKey,
          }),
        ok,
      },
      {
        onSuccess: () => {
          setPanel(null);
          if (path === 'start') setStartKey(newIdempotencyKey());
          if (path === 'complete') setCompleteKey(newIdempotencyKey());
        },
      },
    );
  const myMaterials = t.materialIds.length
    ? t.materials.filter((l) => t.materialIds.includes(l.requirementId))
    : t.materials;

  return (
    <div className="space-y-6" data-testid="my-task-detail">
      <div>
        <p className="text-base text-ink-muted">
          {t.serviceOrder.code} · {t.serviceOrderItem?.code ?? 'OS inteira'} · {t.code} ·{' '}
          {t.customerName}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-1 text-lg text-ink-soft">
          {PRODUCTION_ACTIVITY_LABEL[t.activity]} · {TASK_ROLE_LABEL[t.role]} ·{' '}
          {t.assignee?.displayName ?? 'Sem responsável'}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-base">
          <TaskStatusBadge status={t.status} />
          <span className="text-ink-muted">
            Prioridade {PRIORITY_LABEL[t.priority].toLowerCase()}
          </span>
          {t.scheduledDate && (
            <span className="text-ink-muted">
              {formatDay(t.scheduledDate)} às {t.scheduledTime}
            </span>
          )}
          {t.dueDate && <span className="text-ink-muted">Prazo {formatDay(t.dueDate)}</span>}
          <MaterialsIndicator state={t.taskMaterials} />
        </div>
        <SupportInfo t={t} large />
        <IssueInfo t={t} large />
        <QualityInfo t={t} large />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      <WhyWaiting t={t} />
      {t.status === 'PAUSADA' && t.pauseReason && (
        <Alert tone="warn" title={`Pausada — ${PAUSE_REASON_LABEL[t.pauseReason]}`}>
          {t.pauseNote ?? 'O andamento registrado foi mantido.'}
          {t.pauseImpediment ? ' Marcada como impedimento.' : ''}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2" data-testid="task-actions">
        {t.can.start && (
          <Button
            size="xl"
            className="sm:col-span-2"
            disabled={!online}
            loading={m.isPending}
            icon={<Play className="size-6" aria-hidden />}
            onClick={() => post('start', {}, 'Tarefa iniciada.', startKey)}
          >
            Iniciar
          </Button>
        )}
        {t.can.resume && (
          <Button
            size="xl"
            className="sm:col-span-2"
            disabled={!online}
            loading={m.isPending}
            icon={<Play className="size-6" aria-hidden />}
            onClick={() => post('resume', {}, 'Tarefa retomada.')}
          >
            Retomar
          </Button>
        )}
        {t.can.complete && (
          <Button
            size="xl"
            disabled={!online}
            icon={<CheckCircle2 className="size-6" aria-hidden />}
            onClick={() => setPanel(panel === 'complete' ? null : 'complete')}
          >
            Concluir
          </Button>
        )}
        {t.can.progress && (
          <Button
            size="xl"
            variant="secondary"
            disabled={!online}
            icon={<MessageSquarePlus className="size-6" aria-hidden />}
            onClick={() => setPanel(panel === 'progress' ? null : 'progress')}
          >
            Registrar andamento
          </Button>
        )}
        {t.can.pause && (
          <Button
            size="xl"
            variant="secondary"
            disabled={!online}
            icon={<Pause className="size-6" aria-hidden />}
            onClick={() => setPanel(panel === 'pause' ? null : 'pause')}
          >
            Pausar
          </Button>
        )}
        {!t.can.start &&
          !t.can.resume &&
          !t.can.complete &&
          (t.status === 'BLOQUEADA' || t.status === 'PROGRAMADA') && (
            <p className="flex items-center gap-2 text-base text-ink-muted sm:col-span-2">
              <Lock className="size-5" aria-hidden /> O botão Iniciar aparece quando a tarefa for
              liberada.
            </p>
          )}
      </div>

      {t.qualityFor?.kind === 'EMBALAGEM' && t.qualityFor.packagingId && (
        <PackagingPanel packagingId={t.qualityFor.packagingId} />
      )}
      {canAskHelp && (t.can.start || t.can.progress) && <HelpPanel t={t} />}
      <AlternativeTasks t={t} onOpen={onOpen} />
      {reportUserId && t.assignee?.userId === reportUserId && !t.issueFor && <ProblemPanel t={t} />}

      {panel === 'complete' && (
        <CompletePanel
          t={t}
          busy={m.isPending}
          onCancel={() => setPanel(null)}
          onComplete={(body) => post('complete', body, 'Tarefa concluída.', completeKey)}
        />
      )}
      {panel === 'pause' && (
        <PausePanel
          busy={m.isPending}
          onCancel={() => setPanel(null)}
          onPause={(body) => post('pause', body, 'Tarefa pausada.')}
        />
      )}
      {panel === 'progress' && (
        <ProgressPanel
          taskId={t.id}
          busy={m.isPending}
          onCancel={() => setPanel(null)}
          onSend={(body) => post('progress', body, 'Andamento registrado.')}
        />
      )}

      {t.lastProgress && (
        <div className="rounded-xl bg-subtle px-4 py-3 text-base" data-testid="last-progress">
          <p className="font-semibold">
            Último andamento{t.lastProgress.percent !== null ? ` · ${t.lastProgress.percent}%` : ''}
          </p>
          {t.lastProgress.note && <p>{t.lastProgress.note}</p>}
          {t.lastProgress.step && <p>Etapa atual: {t.lastProgress.step}</p>}
          {t.lastProgress.nextStep && <p>Próximo passo: {t.lastProgress.nextStep}</p>}
        </div>
      )}

      <Block title="O que fazer">
        {t.instructions ? (
          <p className="text-lg whitespace-pre-line" data-testid="task-instructions">
            {t.instructions}
          </p>
        ) : (
          <p className="text-base text-ink-muted">Sem instruções específicas para esta tarefa.</p>
        )}
        {t.serviceOrderInfo.technicalInstructions && (
          <p className="mt-3 border-t border-line pt-3 text-base whitespace-pre-line text-ink-soft">
            <span className="font-semibold">Instruções da OS: </span>
            {t.serviceOrderInfo.technicalInstructions}
          </p>
        )}
      </Block>

      <Block title="Peças, medidas, tecido e espuma">
        <ul className="space-y-5" data-testid="task-pieces">
          {t.serviceOrderInfo.items
            .filter((i) => !t.serviceOrderItem || i.id === t.serviceOrderItem.id)
            .map((i) => (
              <li key={i.id}>
                <p className="text-lg font-semibold">
                  {i.code} · {i.description}{' '}
                  <span className="font-normal text-ink-muted">
                    ({PIECE_TYPE_LABEL[i.pieceType]}, {i.quantity} un.)
                  </span>
                </p>
                <dl className="mt-1 grid gap-x-6 gap-y-1 text-base sm:grid-cols-2">
                  <Spec label="Tecido">
                    {i.fabricName
                      ? `${i.fabricName}${i.fabricColor ? ` ${i.fabricColor}` : ''}`
                      : null}
                  </Spec>
                  <Spec label="Espuma">{i.foamSpecs}</Spec>
                  <Spec label="Medidas">
                    {i.measurements.length
                      ? i.measurements.map((mm) => `${mm.label}: ${mm.valueCm} cm`).join(' · ')
                      : null}
                  </Spec>
                  <Spec label="Observações técnicas">{i.technicalNotes}</Spec>
                </dl>
                <div className="mt-3">
                  <PhotoGallery entityType="SERVICE_ORDER_ITEM" entityId={i.id} canManage={false} />
                </div>
              </li>
            ))}
        </ul>
      </Block>

      <Block title={t.materialIds.length ? 'Materiais desta tarefa' : 'Materiais da OS'}>
        {myMaterials.length === 0 ? (
          <p className="text-base text-ink-muted">Nenhum material aprovado.</p>
        ) : (
          <ul className="space-y-2 text-base" data-testid="task-materials">
            {myMaterials.map((l) => (
              <li key={l.requirementId} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{specText(l)}</span>
                <span className="text-ink-muted">· {qtyText(l.need, l.unit)}</span>
                <span
                  className={clsx(
                    'rounded-full px-2.5 py-0.5 text-sm font-semibold',
                    l.stage === 'DISPONIVEL' ? 'bg-ok-50 text-ok-600' : 'bg-warn-50 text-warn-600',
                  )}
                >
                  {LINE_STAGE_LABEL[l.stage]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <div className="grid gap-6 lg:grid-cols-2">
        <Block title="Depende de">
          <TaskRefs large refs={t.dependsOn} empty="Nenhuma dependência." />
        </Block>
        <Block title="Ao concluir, libera">
          <TaskRefs large refs={t.dependents} empty="Nenhuma tarefa depende desta." />
        </Block>
      </div>

      <Block title="Etapas da OS">
        <ul className="space-y-1.5" data-testid="os-steps">
          {t.osTasks.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 text-base">
              <span
                className={clsx(
                  'rounded-full px-2 py-0.5 text-xs font-semibold',
                  x.id === t.id ? 'bg-brand-700 text-white' : 'bg-subtle text-ink-soft',
                )}
              >
                {x.id === t.id ? 'Esta' : x.code}
              </span>
              {onOpen && x.id !== t.id ? (
                <span>{x.title}</span>
              ) : (
                <span className="font-semibold">{x.title}</span>
              )}
              <span className="text-ink-muted">· {x.assignee ?? 'sem responsável'}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="Fotos desta tarefa">
        <PhotoGallery entityType="PRODUCTION_TASK" entityId={t.id} canManage={false} />
      </Block>

      <Block title="Fotos da OS">
        <PhotoGallery entityType="SERVICE_ORDER" entityId={t.serviceOrder.id} canManage={false} />
      </Block>

      <Block title="Histórico técnico da OS">
        {t.technicalHistory.length === 0 ? (
          <p className="text-base text-ink-muted">Sem alterações técnicas registradas.</p>
        ) : (
          <ol className="space-y-2 text-base" data-testid="technical-history">
            {t.technicalHistory.map((r) => (
              <li key={r.revision} className="border-l-2 border-line pl-3">
                <p className="font-medium">
                  Revisão {r.revision}
                  {r.itemCode ? ` · ${r.itemCode}` : ''} · {SCOPE_LABEL[r.scope] ?? r.scope}
                </p>
                {r.fields.length > 0 && (
                  <p className="text-ink-soft">
                    Alterado: {r.fields.map((f) => FIELD_LABEL[f] ?? f).join(', ')}
                  </p>
                )}
                {r.reason && <p className="text-ink-soft">Motivo: {r.reason}</p>}
                <p className="text-sm text-ink-muted">
                  {formatDateTime(r.createdAt)} · {r.changedBy ?? 'Sistema'}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Block>

      <Block title="Histórico da tarefa">
        <TaskHistory large events={t.events} />
      </Block>
    </div>
  );
}

const SCOPE_LABEL: Record<string, string> = {
  OS: 'Dados da OS',
  ITEM: 'Especificação da peça',
  MEDICAO: 'Medidas',
  MATERIAL: 'Materiais',
  CANCELAMENTO: 'Cancelamento',
};
const FIELD_LABEL: Record<string, string> = {
  description: 'descrição',
  quantity: 'quantidade',
  serviceType: 'tipo de serviço',
  fabricName: 'tecido',
  fabricColor: 'cor do tecido',
  fabricReference: 'referência do tecido',
  foamSpecs: 'espuma',
  technicalNotes: 'observações técnicas',
  technicalInstructions: 'instruções técnicas',
  measurements: 'medidas',
  measurementNotes: 'observações das medidas',
  promisedDate: 'prazo',
  priority: 'prioridade',
  technicalLeadId: 'responsável técnico',
  notes: 'observações',
  added: 'material incluído',
  removed: 'material removido',
  status: 'situação',
};

function Spec({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd>{children ?? <span className="text-ink-muted">—</span>}</dd>
    </div>
  );
}

/** Explica cada motivo de espera, com nomes de quem faz as etapas anteriores e o que falta. */
function WhyWaiting({ t }: { t: ProductionTaskDetailDto }) {
  if (t.status === 'PROGRAMADA') {
    return (
      <Alert tone="info" title="Programada">
        Libera em {t.scheduledDate ? formatDay(t.scheduledDate) : ''} às {t.scheduledTime}.
      </Alert>
    );
  }
  if (t.status !== 'BLOQUEADA') return null;
  const missing = (
    t.materialIds.length
      ? t.materials.filter((l) => t.materialIds.includes(l.requirementId))
      : t.materials
  ).filter((l) => l.stage !== 'DISPONIVEL');
  return (
    <Alert tone="warn" title="Ainda não liberada — por quê:">
      <ul className="mt-1 list-disc space-y-1 pl-5 text-base" data-testid="why-waiting">
        {t.blockedReason && <li>Bloqueada pelo gestor: {t.blockedReason}</li>}
        {t.blockers
          .filter((b) => b !== 'BLOQUEIO')
          .map((b) => (
            <li key={b}>
              {b === 'DEPENDENCIAS'
                ? `Aguardando: ${t.dependsOn
                    .filter((d) => !DONE.includes(d.status))
                    .map((d) => `${d.title} (${d.assignee ?? 'sem responsável'})`)
                    .join(', ')}`
                : b === 'MATERIAIS' && missing.length
                  ? `Falta material: ${missing.map((l) => `${specText(l)} — ${LINE_STAGE_LABEL[l.stage]}`).join('; ')}`
                  : RELEASE_BLOCKER_LABEL[b]}
            </li>
          ))}
      </ul>
    </Alert>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="mb-3 text-lg font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  );
}

// ─────────────────────────── Painéis de ação ───────────────────────────

/** Envia fotos da própria tarefa e devolve os ids dos anexos criados. */
function useTaskPhotoUpload(taskId: string) {
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const created: string[] = [];
      for (const file of files) {
        const fd = new FormData();
        fd.append('entityType', 'PRODUCTION_TASK');
        fd.append('entityId', taskId);
        fd.append('file', file);
        created.push(
          (await api<{ id: string }>('/api/v1/attachments', { method: 'POST', body: fd })).id,
        );
      }
      return created;
    },
    onSuccess: (created) => {
      setIds((x) => [...x, ...created]);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['attachments', 'PRODUCTION_TASK', taskId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { ids, upload, error };
}

function PhotoPicker({
  label,
  upload,
  count,
}: {
  label: string;
  upload: ReturnType<typeof useTaskPhotoUpload>['upload'];
  count: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        hidden
        aria-label={label}
        data-testid="photo-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) upload.mutate(files);
        }}
      />
      <Button
        size="xl"
        variant="secondary"
        loading={upload.isPending}
        icon={<Camera className="size-6" aria-hidden />}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
      {count > 0 && (
        <span className="text-base font-semibold text-ok-600" data-testid="photos-attached">
          {count} foto(s) anexada(s)
        </span>
      )}
    </div>
  );
}

function CompletePanel({
  t,
  busy,
  onCancel,
  onComplete,
}: {
  t: ProductionTaskDetailDto;
  busy: boolean;
  onCancel: () => void;
  onComplete: (body: { note?: string; attachmentIds: string[] }) => void;
}) {
  const [note, setNote] = useState('');
  const photos = useTaskPhotoUpload(t.id);
  const needsNote = t.completionRequirement === 'OBSERVACAO';
  const needsPhoto = t.completionRequirement === 'FOTO';
  const ready = (!needsNote || note.trim().length >= 2) && (!needsPhoto || photos.ids.length > 0);
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" data-testid="confirm-complete">
      <p className="text-xl font-semibold">Concluir “{t.title}”?</p>
      {t.dependents.length > 0 && (
        <p className="mt-1 text-base text-ink-muted">
          Libera:{' '}
          {t.dependents.map((d) => `${d.title} (${d.assignee ?? 'sem responsável'})`).join(', ')}
        </p>
      )}
      {photos.error && (
        <Alert tone="danger" className="mt-3">
          {photos.error}
        </Alert>
      )}
      {needsNote && (
        <label className="mt-4 block">
          <span className="label-lg">
            {t.issueFor ? 'Resultado (o que foi feito)' : 'Observação de conclusão'}
          </span>
          <input
            className="input input-lg"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      {needsPhoto && (
        <div className="mt-4">
          <p className="mb-2 text-base font-semibold">Esta etapa exige uma foto do resultado.</p>
          <PhotoPicker label="Tirar foto" upload={photos.upload} count={photos.ids.length} />
        </div>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Button size="xl" variant="secondary" onClick={onCancel}>
          Voltar
        </Button>
        <Button
          size="xl"
          disabled={!ready}
          loading={busy}
          onClick={() => onComplete({ note: note.trim() || undefined, attachmentIds: photos.ids })}
        >
          Sim, concluir
        </Button>
      </div>
    </div>
  );
}

function PausePanel({
  busy,
  onCancel,
  onPause,
}: {
  busy: boolean;
  onCancel: () => void;
  onPause: (body: { reason: PauseReason; note?: string; impediment: boolean }) => void;
}) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState('');
  const [impediment, setImpediment] = useState(false);
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" data-testid="pause-panel">
      <p className="mb-3 text-xl font-semibold">Por que vai pausar?</p>
      <label className="mb-4 flex items-center gap-3 rounded-xl bg-warn-50 px-4 py-3 text-base">
        <input
          type="checkbox"
          className="size-6 accent-warn-600"
          checked={impediment}
          onChange={(e) => setImpediment(e.target.checked)}
        />
        <span>
          <span className="font-semibold">É um impedimento</span> — não consigo continuar sem ajuda
          ou decisão do gestor.
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {PAUSE_REASONS.filter((r) => r !== 'OUTRO').map((r) => (
          <Button
            key={r}
            size="xl"
            variant="secondary"
            loading={busy}
            onClick={() => onPause({ reason: r, impediment })}
          >
            {PAUSE_REASON_LABEL[r]}
          </Button>
        ))}
        <Button size="xl" variant="secondary" onClick={() => setOther(true)}>
          {PAUSE_REASON_LABEL.OUTRO}
        </Button>
      </div>
      {other && (
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            aria-label="Motivo da pausa"
            className="input input-lg min-w-0 flex-1"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="xl"
            disabled={note.trim().length < 2}
            loading={busy}
            onClick={() => onPause({ reason: 'OUTRO', note: note.trim(), impediment })}
          >
            Pausar
          </Button>
        </div>
      )}
      <Button size="lg" variant="ghost" className="mt-3" onClick={onCancel}>
        Voltar
      </Button>
    </div>
  );
}

function ProgressPanel({
  taskId,
  busy,
  onCancel,
  onSend,
}: {
  taskId: string;
  busy: boolean;
  onCancel: () => void;
  onSend: (body: {
    note?: string;
    percent: number | null;
    step?: string;
    nextStep?: string;
    attachmentIds: string[];
  }) => void;
}) {
  const [note, setNote] = useState('');
  const [step, setStep] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [percent, setPercent] = useState<number | null>(null);
  const photos = useTaskPhotoUpload(taskId);
  const filled =
    note.trim().length >= 2 ||
    step.trim().length >= 2 ||
    nextStep.trim().length >= 2 ||
    percent !== null ||
    photos.ids.length > 0;
  const field = 'input input-lg';
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" data-testid="progress-panel">
      <p className="mb-1 text-xl font-semibold">Como está o andamento?</p>
      <p className="mb-4 text-base text-ink-muted">Preencha só o que for útil.</p>
      {photos.error && (
        <Alert tone="danger" className="mb-3">
          {photos.error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="label-lg">Observação</span>
          <input
            aria-label="Andamento"
            placeholder="Ex.: Braços cortados"
            className={field}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label>
          <span className="label-lg">Etapa atual</span>
          <input
            aria-label="Etapa atual"
            className={field}
            value={step}
            maxLength={200}
            onChange={(e) => setStep(e.target.value)}
          />
        </label>
        <label>
          <span className="label-lg">Próximo passo</span>
          <input
            aria-label="Próximo passo"
            className={field}
            value={nextStep}
            maxLength={200}
            onChange={(e) => setNextStep(e.target.value)}
          />
        </label>
      </div>
      <p className="mt-4 mb-2 text-base font-semibold">Percentual aproximado (opcional)</p>
      <div className="mb-4 flex flex-wrap gap-3">
        {[25, 50, 75].map((p) => (
          <Button
            key={p}
            size="xl"
            variant={percent === p ? 'primary' : 'secondary'}
            aria-pressed={percent === p}
            onClick={() => setPercent(percent === p ? null : p)}
          >
            {p}%
          </Button>
        ))}
      </div>
      <PhotoPicker label="Adicionar foto" upload={photos.upload} count={photos.ids.length} />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Button size="xl" variant="secondary" onClick={onCancel}>
          Voltar
        </Button>
        <Button
          size="xl"
          disabled={!filled || photos.upload.isPending}
          loading={busy}
          onClick={() =>
            onSend({
              note: note.trim() || undefined,
              percent,
              step: step.trim() || undefined,
              nextStep: nextStep.trim() || undefined,
              attachmentIds: photos.ids,
            })
          }
        >
          Registrar
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────── Avisos ───────────────────────────

/** Caixa de avisos: persistente, lida/não lida, abre a tarefa correspondente. */
export function NotificationsInbox({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const q = useNotifications();
  const online = useOnline();
  const { m, error } = useSend();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const open = (n: NotificationDto) => {
    if (!n.readAt && online)
      m.mutate({ run: () => api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' }) });
    if (n.taskId) onOpenTask(n.taskId);
  };
  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-base text-ink-muted">
          {q.data.unread} não lido(s) · {q.data.items.length} aviso(s) recente(s)
        </p>
        <Button
          size="lg"
          variant="secondary"
          disabled={!online || q.data.unread === 0}
          loading={m.isPending}
          icon={<CheckCheck className="size-5" aria-hidden />}
          onClick={() =>
            m.mutate({
              run: () => api('/api/v1/notifications/read-all', { method: 'POST' }),
              ok: 'Avisos marcados como lidos.',
            })
          }
        >
          Marcar todos como lidos
        </Button>
      </div>
      {q.data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
          <Bell className="mx-auto size-10 text-ink-muted" aria-hidden />
          <p className="mt-3 text-xl font-semibold">Nenhum aviso</p>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="notifications">
          {q.data.items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => open(n)}
                data-testid={`notification-${n.kind}`}
                data-read={n.readAt ? 'true' : 'false'}
                className={clsx(
                  'flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition active:scale-[0.99]',
                  n.readAt
                    ? 'border-line bg-surface text-ink-soft'
                    : 'border-brand-600/40 bg-brand-50 ring-2 ring-brand-600/10',
                )}
              >
                {n.kind === 'TAREFA_CANCELADA' || n.kind === 'TAREFA_BLOQUEADA' ? (
                  <AlertTriangle className="mt-0.5 size-6 shrink-0 text-danger-600" aria-hidden />
                ) : (
                  <Bell
                    className={clsx(
                      'mt-0.5 size-6 shrink-0',
                      n.readAt ? 'text-ink-muted' : 'text-brand-700',
                    )}
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold">{n.title}</span>
                    {!n.readAt && (
                      <span className="rounded-full bg-brand-700 px-2 py-0.5 text-xs font-bold text-white">
                        Novo
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-base">{n.body}</span>
                  <span className="mt-1 block text-sm text-ink-muted">
                    {formatDateTime(n.createdAt)}
                  </span>
                </span>
                {n.taskId && (
                  <ChevronRight className="size-6 shrink-0 text-ink-muted" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
