import {
  ATTENDANCE_SITUATION_LABEL,
  EVENT_TYPES,
  anyPermissionAudience,
  compareTasks,
  computeAvailability,
  localParts,
  taskCode,
  zonedDateTime,
  type AttendanceConfigDto,
  type AttendanceDayDto,
  type AttendanceSituation,
  type AttendanceTaskRefDto,
  type Availability,
  type NotificationKind,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { notify } from '../notifications/notify';

// ─────────────────────────── Acesso ───────────────────────────

/** O próprio funcionário (tablet ou painel) registra só a própria presença. */
export const SELF = { session: 'any', permissions: ['presenca.registrar'] } as const;
export const VIEW = {
  session: 'WEB',
  anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
} as const;
export const MANAGE = { session: 'WEB', permissions: ['presenca.gerenciar'] } as const;
export const MANAGERS_AUDIENCE = anyPermissionAudience('presenca.ver', 'presenca.gerenciar');
export const audienceOf = (userId: string) =>
  `${MANAGERS_AUDIENCE}|user:${userId}` as typeof MANAGERS_AUDIENCE;

// ─────────────────────────── Configuração e datas ───────────────────────────

/**
 * Relógio da presença: sempre o horário do servidor. Os testes podem fixá-lo para
 * simular 8h30, atrasos e o limite de 9h30 de forma determinística.
 */
let clockFn: () => Date = () => new Date();
export const clock = () => clockFn();
export function setAttendanceClock(fn?: () => Date) {
  clockFn = fn ?? (() => new Date());
}

export async function attendanceConfig(db: Tx | PrismaClient, now = clock()) {
  const c = await db.companySettings.findUnique({ where: { id: 1 } });
  const timezone = c?.timezone ?? 'America/Sao_Paulo';
  const local = localParts(now, timezone);
  const weekday = new Date(`${local.date}T12:00:00Z`).getUTCDay();
  const cfg = {
    timezone,
    arrivalWindowStart: c?.arrivalWindowStart ?? '07:00',
    workdayStart: c?.workdayStart ?? '08:30',
    arrivalAlertAt: c?.arrivalAlertAt ?? '09:30',
    workdayEnd: c?.workdayEnd ?? '18:00',
    lateAlertMinutes: c?.lateAlertMinutes ?? 15,
    workingDay: (c?.workingDays ?? [1, 2, 3, 4, 5]).includes(weekday),
    now: local.time,
    today: local.date,
  } satisfies AttendanceConfigDto;
  return cfg;
}
export type AttendanceConfig = Awaited<ReturnType<typeof attendanceConfig>>;

export const dbDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const hhmm = (d: Date, tz: string) => localParts(d, tz).time;
export const brDate = (iso: string) => iso.split('-').reverse().join('/');

// ─────────────────────────── Equipe e gestores ───────────────────────────

/**
 * Equipe da presença operacional: funcionários ativos que registram a própria presença
 * (Ricardo, Márcio, Thiago, João). Quem gerencia a presença (gestor) não entra na lista.
 */
export async function team(db: Tx | PrismaClient) {
  const employees = await db.employee.findMany({
    where: { active: true, user: { active: true } },
    include: { user: { select: { id: true, displayName: true } } },
    orderBy: { displayName: 'asc' },
  });
  const out: typeof employees = [];
  for (const e of employees) {
    const perms = await loadUserPermissions(db, e.userId);
    if (perms.has('presenca.registrar') && !perms.has('presenca.gerenciar')) out.push(e);
  }
  return out;
}

/** Quem recebe os alertas que exigem ação (gestores com `presenca.gerenciar`). */
export async function managers(db: Tx | PrismaClient) {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true } });
  const out: string[] = [];
  for (const u of users) {
    if ((await loadUserPermissions(db, u.id)).has('presenca.gerenciar')) out.push(u.id);
  }
  return out;
}

export async function notifyManagers(
  tx: Tx,
  actor: ActorContext,
  kind: NotificationKind,
  dedupeKey: string,
  body: string,
  taskId: string | null = null,
) {
  await notify(
    tx,
    actor,
    (await managers(tx)).map((userId) => ({
      userId,
      kind,
      dedupeKey: `${dedupeKey}:${userId}`,
      body,
      taskId,
      includeActor: true,
    })),
  );
}

// ─────────────────────────── Tarefas e disponibilidade ───────────────────────────

const taskRefSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  priority: true,
  scheduledAt: true,
  dueDate: true,
  sequence: true,
  pauseReason: true,
} as const;
type TaskLite = Prisma.ProductionTaskGetPayload<{ select: typeof taskRefSelect }>;

const toRef = (t: TaskLite): AttendanceTaskRefDto => ({
  id: t.id,
  code: taskCode(t.number),
  title: t.title,
  status: t.status,
  priority: t.priority,
  scheduledAt: t.scheduledAt?.toISOString() ?? null,
  dueDate: dateOnly(t.dueDate),
});

/** Tarefas abertas do funcionário até o fim do dia operacional. */
export async function openTasksOf(
  db: Tx | PrismaClient,
  userId: string,
  cfg: AttendanceConfig,
  date = cfg.today,
) {
  const endOfDay = zonedDateTime(date, '23:59', cfg.timezone);
  return db.productionTask.findMany({
    where: {
      assigneeUserId: userId,
      OR: [
        { status: { in: ['EM_EXECUCAO', 'PAUSADA'] } },
        {
          status: { in: ['LIBERADA', 'PROGRAMADA', 'BLOQUEADA'] },
          scheduledAt: { lte: endOfDay },
        },
      ],
    },
    select: taskRefSelect,
  });
}

type AttendanceRow = Prisma.OperationalAttendanceGetPayload<object>;

export function availabilityFrom(
  row: Pick<AttendanceRow, 'situation' | 'arrivedAt'> | null,
  tasks: TaskLite[],
): Availability {
  return computeAvailability({
    situation: (row?.situation as AttendanceSituation | undefined) ?? null,
    arrived: Boolean(row?.arrivedAt),
    running: tasks.some((t) => t.status === 'EM_EXECUCAO'),
    // Pausa feita durante o dia (as de fim de expediente de ontem não contam).
    pausedSinceArrival: Boolean(
      row?.arrivedAt &&
        tasks.some((t) => t.status === 'PAUSADA' && t.pauseReason !== 'FIM_EXPEDIENTE'),
    ),
  });
}

/**
 * Recalcula a disponibilidade do funcionário no dia e, se mudou, grava e publica
 * `attendance.availability_changed` (idempotente: sem mudança, sem evento).
 */
export async function refreshAvailability(
  tx: Tx,
  actor: ActorContext,
  employeeId: string,
  now = clock(),
) {
  const cfg = await attendanceConfig(tx, now);
  const row = await tx.operationalAttendance.findUnique({
    where: { employeeId_date: { employeeId, date: dbDate(cfg.today) } },
    include: { employee: { select: { userId: true } } },
  });
  if (!row) return;
  const value = availabilityFrom(row, await openTasksOf(tx, row.employee.userId, cfg));
  if (value === row.availability) return;
  await tx.operationalAttendance.update({
    where: { id: row.id },
    data: { availability: value, availabilityAt: now },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.ATTENDANCE_AVAILABILITY_CHANGED,
    aggregateType: 'attendance',
    aggregateId: row.id,
    payload: { employeeId, date: cfg.today, from: row.availability, to: value },
    audience: audienceOf(row.employee.userId),
  });
}

/** Atalho usado pelas ações de tarefa: recalcula a disponibilidade de quem executa. */
export async function refreshAvailabilityOfUser(
  tx: Tx,
  actor: ActorContext,
  userId: string | null,
) {
  if (!userId) return;
  const e = await tx.employee.findUnique({ where: { userId }, select: { id: true } });
  if (e) await refreshAvailability(tx, actor, e.id);
}

// ─────────────────────────── DTO ───────────────────────────

export async function dayDto(
  db: Tx | PrismaClient,
  employee: {
    id: string;
    userId: string;
    displayName: string;
    color: string;
    jobTitle: string;
  },
  row: AttendanceRow | null,
  cfg: AttendanceConfig,
  date: string,
): Promise<AttendanceDayDto> {
  const tasks = await openTasksOf(db, employee.userId, cfg, date);
  const sorted = tasks
    .map((t) => ({ ...t, scheduledAt: t.scheduledAt?.toISOString() ?? null }))
    .sort((a, b) => compareTasks(a, b));
  const running = tasks.find((t) => t.status === 'EM_EXECUCAO') ?? null;
  const nextId = sorted.find((t) => t.status !== 'EM_EXECUCAO')?.id;
  const next = tasks.find((t) => t.id === nextId) ?? null;
  const openAlerts = row
    ? await db.attendanceImpact.count({ where: { attendanceId: row.id, resolvedAt: null } })
    : 0;
  return {
    id: row?.id ?? null,
    date,
    employee: {
      id: employee.id,
      userId: employee.userId,
      displayName: employee.displayName,
      color: employee.color,
      jobTitle: employee.jobTitle,
    },
    situation: (row?.situation as AttendanceSituation | undefined) ?? null,
    // Hoje: calculada na hora; outros dias: a última registrada.
    availability:
      date === cfg.today
        ? availabilityFrom(row, tasks)
        : ((row?.availability as Availability | undefined) ?? 'NAO_CONFIRMOU'),
    arrivedAt: row?.arrivedAt?.toISOString() ?? null,
    arrivalKind: row?.arrivalKind ?? null,
    lateMinutes: row?.lateMinutes ?? 0,
    departedAt: row?.departedAt?.toISOString() ?? null,
    earlyDeparture: row?.earlyDeparture ?? false,
    departureNote: row?.departureNote ?? null,
    presumedAbsentAt: row?.presumedAbsentAt?.toISOString() ?? null,
    note: row?.note ?? null,
    runningTask: date === cfg.today && running ? toRef(running) : null,
    nextTask: date === cfg.today && next ? toRef(next) : null,
    openAlerts,
    version: row?.version ?? null,
  };
}

// ─────────────────────────── Histórico ───────────────────────────

/** Estado registrável de um dia (usado como "antes/depois" do histórico imutável). */
export const snapshotOf = (row: AttendanceRow | null) =>
  row
    ? {
        situation: row.situation,
        arrivedAt: row.arrivedAt?.toISOString() ?? null,
        arrivalKind: row.arrivalKind,
        lateMinutes: row.lateMinutes,
        departedAt: row.departedAt?.toISOString() ?? null,
        earlyDeparture: row.earlyDeparture,
        presumedAbsentAt: row.presumedAbsentAt?.toISOString() ?? null,
        note: row.note,
      }
    : null;

export async function history(
  tx: Tx,
  actor: ActorContext,
  attendanceId: string,
  action: string,
  before: AttendanceRow | null,
  after: AttendanceRow,
  reason: string | null = null,
  deviceId: string | null = null,
) {
  await tx.attendanceCorrection.create({
    data: {
      attendanceId,
      action,
      reason,
      before: (snapshotOf(before) ?? undefined) as Prisma.InputJsonValue | undefined,
      after: snapshotOf(after) as Prisma.InputJsonValue,
      actorId: actor.userId,
      deviceId,
    },
  });
}

/** Bloqueio por funcionário (evita duas confirmações simultâneas criando dois registros). */
export async function lockEmployeeDay(tx: Tx, employeeId: string, date: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attendance:${employeeId}:${date}`}))`;
}

// ─────────────────────────── Impactos ───────────────────────────

/**
 * Identifica (sem alterar nada) as tarefas do dia do funcionário ausente e as que
 * dependem delas, direta ou indiretamente, com responsáveis e prazos.
 */
export async function detectImpacts(
  tx: Tx,
  attendance: { id: string },
  employee: { userId: string; displayName: string },
  cfg: AttendanceConfig,
) {
  const own = (await openTasksOf(tx, employee.userId, cfg)).filter(
    (t) => t.status !== 'EM_EXECUCAO',
  );
  if (!own.length) return { own: 0, dependents: 0, affectedUsers: [] as string[] };
  const full = await tx.productionTask.findMany({
    where: { id: { in: own.map((t) => t.id) } },
    include: { serviceOrder: { select: { number: true } } },
  });
  const rows: Prisma.AttendanceImpactCreateManyInput[] = full.map((t) => ({
    attendanceId: attendance.id,
    taskId: t.id,
    kind: 'TAREFA_DO_AUSENTE',
    affectedUserId: employee.userId,
    dueDate: t.dueDate,
    detail: `${taskCode(t.number)} · ${t.title} (${serviceOrderCode(t.serviceOrder.number)}) programada para ${employee.displayName}${t.scheduledAt ? ` às ${hhmm(t.scheduledAt, cfg.timezone)}` : ''}${t.dueDate ? `; prazo interno ${brDate(dateOnly(t.dueDate)!)}` : ''}.`,
  }));
  // Dependentes (em cadeia) ainda abertas, de qualquer responsável.
  const seen = new Set(full.map((t) => t.id));
  const cause = new Map(full.map((t) => [t.id, t]));
  let frontier = [...seen];
  const affected = new Set<string>();
  let dependents = 0;
  while (frontier.length) {
    const deps = await tx.taskDependency.findMany({
      where: { dependsOnId: { in: frontier } },
      include: {
        task: {
          include: {
            assignee: { select: { id: true, displayName: true } },
            serviceOrder: { select: { number: true } },
          },
        },
      },
    });
    frontier = [];
    for (const d of deps) {
      const t = d.task;
      if (seen.has(t.id) || ['CONCLUIDA', 'CANCELADA', 'RASCUNHO'].includes(t.status)) continue;
      seen.add(t.id);
      frontier.push(t.id);
      const origin = cause.get(d.dependsOnId) ?? null;
      if (origin) cause.set(t.id, origin);
      if (t.assigneeUserId && t.assigneeUserId !== employee.userId) affected.add(t.assigneeUserId);
      dependents += 1;
      rows.push({
        attendanceId: attendance.id,
        taskId: t.id,
        kind: 'DEPENDENTE_AFETADA',
        affectedUserId: t.assigneeUserId,
        dueDate: t.dueDate,
        detail: `${taskCode(t.number)} · ${t.title} (${serviceOrderCode(t.serviceOrder.number)}) de ${t.assignee?.displayName ?? 'sem responsável'} depende de ${origin ? `${taskCode(origin.number)} · ${origin.title}` : 'tarefa afetada'} — potencialmente bloqueada${t.dueDate ? `; prazo interno ${brDate(dateOnly(t.dueDate)!)}` : ''}. Necessário reprogramar.`,
      });
    }
  }
  await tx.attendanceImpact.createMany({ data: rows, skipDuplicates: true });
  return { own: full.length, dependents, affectedUsers: [...affected] };
}

export const situationLabel = (s: string | null) =>
  s ? ATTENDANCE_SITUATION_LABEL[s as AttendanceSituation] : 'Sem registro';
