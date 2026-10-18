import {
  EVENT_TYPES,
  LEAVE_KIND_LABEL,
  LEAVE_MAX_DAYS,
  cancelLeaveSchema,
  createHolidaySchema,
  createLeaveSchema,
  holidayQuerySchema,
  leaveCode,
  leaveQuerySchema,
  updateHolidaySchema,
  updateLeaveSchema,
  type HolidayDto,
  type LeaveDto,
  type LeaveKind,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly } from '../commercial/common';
import { idParams } from '../presenters';
import { notify } from '../notifications/notify';
import { MANAGE, MANAGERS_AUDIENCE, VIEW, attendanceConfig, brDate, dbDate, team } from './common';
import { applyAttendanceAction } from './routes';

/**
 * Simplificação Fase 7 — calendário da empresa (feriados/dias sem expediente) e folga/férias
 * por intervalo. Nada aqui cria presença em dias futuros: o intervalo é interpretado dia a dia
 * (sem ausência presumida, sem atraso, sem proposta por falta). Fatos já registrados (chegada,
 * saída, situação de dias passados) nunca são reescritos.
 */
const days = (from: string, to: string) =>
  Math.round((dbDate(to).getTime() - dbDate(from).getTime()) / 86_400_000) + 1;

const holidayDto = (h: Prisma.CompanyHolidayGetPayload<object>): HolidayDto => ({
  id: h.id,
  date: dateOnly(h.date)!,
  name: h.name,
  active: h.active,
  version: h.version,
  updatedAt: h.updatedAt.toISOString(),
});

const leaveInclude = {
  employee: { select: { id: true, displayName: true } },
  createdBy: { select: { displayName: true } },
  events: { include: { actor: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.AttendanceLeaveInclude;
type LeaveRow = Prisma.AttendanceLeaveGetPayload<{ include: typeof leaveInclude }>;

const leaveDto = (l: LeaveRow): LeaveDto => ({
  id: l.id,
  code: leaveCode(l.number),
  employee: l.employee,
  kind: l.kind as LeaveKind,
  startDate: dateOnly(l.startDate)!,
  endDate: dateOnly(l.endDate)!,
  days: days(dateOnly(l.startDate)!, dateOnly(l.endDate)!),
  reason: l.reason,
  status: l.status as LeaveDto['status'],
  version: l.version,
  createdBy: l.createdBy?.displayName ?? null,
  createdAt: l.createdAt.toISOString(),
  cancelledAt: l.cancelledAt?.toISOString() ?? null,
  cancelReason: l.cancelReason,
  history: l.events.map((e) => ({
    action: e.action as LeaveDto['history'][number]['action'],
    reason: e.reason,
    before: e.before,
    after: e.after,
    actor: e.actor?.displayName ?? null,
    createdAt: e.createdAt.toISOString(),
  })),
});

const snapshot = (l: { kind: string; startDate: Date; endDate: Date; status: string }) => ({
  kind: l.kind,
  startDate: dateOnly(l.startDate),
  endDate: dateOnly(l.endDate),
  status: l.status,
});

/** Uma pessoa por vez: duas folgas/férias simultâneas nunca se sobrepõem. */
async function lockEmployeeLeaves(tx: Tx, employeeId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`leave:${employeeId}`}))`;
}

async function assertNoOverlap(
  tx: Tx,
  employeeId: string,
  start: string,
  end: string,
  exceptId?: string,
) {
  const clash = await tx.attendanceLeave.findFirst({
    where: {
      employeeId,
      status: 'ATIVA',
      ...(exceptId ? { id: { not: exceptId } } : {}),
      startDate: { lte: dbDate(end) },
      endDate: { gte: dbDate(start) },
    },
  });
  if (clash)
    throw Errors.conflict(
      `Já existe ${LEAVE_KIND_LABEL[clash.kind as LeaveKind].toLowerCase()} (${leaveCode(clash.number)}) de ${brDate(dateOnly(clash.startDate)!)} a ${brDate(dateOnly(clash.endDate)!)} neste período.`,
    );
}

function assertRange(start: string, end: string) {
  if (days(start, end) > LEAVE_MAX_DAYS)
    throw Errors.business(`Registre no máximo ${LEAVE_MAX_DAYS} dias por vez.`);
}

/**
 * Se o intervalo cobre HOJE e o dia ainda não tem chegada (ex.: ausência presumida), o dia de hoje
 * passa a folga/férias pelo mesmo registro do gestor (histórico, impactos, reprogramação). Dias
 * passados com registro ficam como estão; dias futuros não ganham registro.
 */
async function applyToday(
  tx: Tx,
  actor: ActorContext,
  l: {
    employeeId: string;
    kind: string;
    startDate: Date;
    endDate: Date;
    reason: string;
    number: number;
  },
) {
  const cfg = await attendanceConfig(tx);
  if (dateOnly(l.startDate)! > cfg.today || dateOnly(l.endDate)! < cfg.today) return;
  const row = await tx.operationalAttendance.findUnique({
    where: { employeeId_date: { employeeId: l.employeeId, date: dbDate(cfg.today) } },
  });
  if (!row || row.arrivedAt || row.situation === l.kind) return;
  const e = await tx.employee.findUniqueOrThrow({ where: { id: l.employeeId } });
  await applyAttendanceAction(tx, actor, cfg, e, {
    employeeId: e.id,
    date: cfg.today,
    action: l.kind as LeaveKind,
    reason: `${leaveCode(l.number)}: ${l.reason}`.slice(0, 300),
    version: row.version,
  });
}

async function recordLeave(
  tx: Tx,
  actor: ActorContext,
  leaveId: string,
  action: 'CRIADA' | 'CORRIGIDA' | 'CANCELADA',
  reason: string,
  before: unknown,
  after: unknown,
) {
  await tx.attendanceLeaveEvent.create({
    data: {
      leaveId,
      action,
      reason,
      before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: after as Prisma.InputJsonValue,
      actorId: actor.userId,
    },
  });
}

async function leaveNotice(
  tx: Tx,
  actor: ActorContext,
  l: {
    id: string;
    number: number;
    kind: string;
    startDate: Date;
    endDate: Date;
    employeeId: string;
  },
  what: string,
) {
  const e = await tx.employee.findUniqueOrThrow({ where: { id: l.employeeId } });
  const range = `${brDate(dateOnly(l.startDate)!)} a ${brDate(dateOnly(l.endDate)!)}`;
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.ATTENDANCE_CORRECTED,
    aggregateType: 'attendance_leave',
    aggregateId: l.id,
    payload: { leaveId: l.id, employeeId: l.employeeId },
    audience: MANAGERS_AUDIENCE,
  });
  await notify(tx, actor, [
    {
      userId: e.userId,
      kind: 'PRESENCA_ALTERADA',
      dedupeKey: `FOLGA_FERIAS:${l.id}:${what}:${l.startDate.getTime()}:${l.endDate.getTime()}`,
      body: `${LEAVE_KIND_LABEL[l.kind as LeaveKind]} de ${range} ${what} pelo gestor.`,
    },
  ]);
}

export async function calendarRoutes(app: FastifyInstance, requeue: () => Promise<unknown>) {
  const { prisma } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) =>
    (prisma as PrismaClient).$transaction(fn, { timeout: 60_000 });

  // ─────────────────────────── Feriados ───────────────────────────

  app.get('/api/v1/attendance/holidays', { config: { access: VIEW } }, async (request) => {
    const q = holidayQuerySchema.parse(request.query);
    const rows = await prisma.companyHoliday.findMany({
      where: {
        date: {
          ...(q.from ? { gte: dbDate(q.from) } : {}),
          ...(q.to ? { lte: dbDate(q.to) } : {}),
        },
      },
      orderBy: { date: 'asc' },
    });
    return rows.map(holidayDto);
  });

  /** Feriado/dia sem expediente: sem ausência presumida, sem atraso, sem proposta por falta. */
  app.post(
    '/api/v1/attendance/holidays',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createHolidaySchema.parse(request.body);
      const actor = actorFrom(request);
      const row = await tx(async (t) => {
        const same = await t.companyHoliday.findUnique({ where: { date: dbDate(input.date) } });
        if (same)
          throw Errors.conflict(
            `${brDate(input.date)} já está no calendário (${same.name}${same.active ? '' : ', inativo'}): edite o registro existente.`,
          );
        const h = await t.companyHoliday.create({
          data: {
            date: dbDate(input.date),
            name: input.name,
            createdById: actor.userId,
            updatedById: actor.userId,
          },
        });
        await audit(t, actor, {
          action: 'attendance.holiday_created',
          entityType: 'company_holiday',
          entityId: h.id,
          summary: `Calendário: ${brDate(input.date)} — ${input.name} (sem expediente).`,
        });
        await appendEvent(t, actor, {
          type: EVENT_TYPES.ATTENDANCE_CORRECTED,
          aggregateType: 'company_holiday',
          aggregateId: h.id,
          payload: { holidayId: h.id, date: input.date },
          audience: MANAGERS_AUDIENCE,
        });
        return h;
      });
      await requeue();
      return reply.status(201).send(holidayDto(row));
    },
  );

  /** Renomear ou ativar/desativar (nunca apagar). O histórico de presença já registrado não muda. */
  app.put(
    '/api/v1/attendance/holidays/:id',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = updateHolidaySchema.parse(request.body);
      const actor = actorFrom(request);
      const row = await tx(async (t) => {
        await t.$queryRaw`SELECT id FROM company_holidays WHERE id = ${id}::uuid FOR UPDATE`;
        const h = await t.companyHoliday.findUnique({ where: { id } });
        if (!h) throw Errors.notFound('Feriado');
        if (h.version !== input.version) throw Errors.versionConflict(h.version);
        const u = await t.companyHoliday.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
            updatedById: actor.userId,
            version: { increment: 1 },
          },
        });
        await audit(t, actor, {
          action: 'attendance.holiday_updated',
          entityType: 'company_holiday',
          entityId: id,
          summary: `Calendário: ${brDate(dateOnly(h.date)!)} — ${u.name}${u.active ? '' : ' (inativo)'}.`,
          changes: {
            before: { name: h.name, active: h.active },
            after: { name: u.name, active: u.active },
          },
        });
        return u;
      });
      await requeue();
      return holidayDto(row);
    },
  );

  // ─────────────────────────── Folga e férias por intervalo ───────────────────────────

  app.get('/api/v1/attendance/leaves', { config: { access: VIEW } }, async (request) => {
    const q = leaveQuerySchema.parse(request.query);
    const rows = await prisma.attendanceLeave.findMany({
      where: {
        ...(q.employeeId ? { employeeId: q.employeeId } : {}),
        ...(q.to ? { startDate: { lte: dbDate(q.to) } } : {}),
        ...(q.from ? { endDate: { gte: dbDate(q.from) } } : {}),
      },
      include: leaveInclude,
      orderBy: [{ startDate: 'desc' }, { number: 'desc' }],
      take: 200,
    });
    return rows.map(leaveDto);
  });

  app.post(
    '/api/v1/attendance/leaves',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createLeaveSchema.parse(request.body);
      const actor = actorFrom(request);
      assertRange(input.startDate, input.endDate);
      const e = await prisma.employee.findUnique({ where: { id: input.employeeId } });
      if (!e) throw Errors.notFound('Funcionário');
      if (!(await team(prisma)).some((m) => m.id === e.id))
        throw Errors.business('Este funcionário não registra presença operacional.');
      const id = await tx(async (t) => {
        await lockEmployeeLeaves(t, e.id);
        await assertNoOverlap(t, e.id, input.startDate, input.endDate);
        const l = await t.attendanceLeave.create({
          data: {
            employeeId: e.id,
            kind: input.kind,
            startDate: dbDate(input.startDate),
            endDate: dbDate(input.endDate),
            reason: input.reason,
            createdById: actor.userId,
          },
        });
        await recordLeave(t, actor, l.id, 'CRIADA', input.reason, null, snapshot(l));
        await audit(t, actor, {
          action: 'attendance.leave_created',
          entityType: 'attendance_leave',
          entityId: l.id,
          summary: `${leaveCode(l.number)}: ${LEAVE_KIND_LABEL[input.kind]} de ${e.displayName}, ${brDate(input.startDate)} a ${brDate(input.endDate)} (${days(input.startDate, input.endDate)} dia(s)) — ${input.reason}`,
        });
        await leaveNotice(t, actor, l, 'registrada');
        await applyToday(t, actor, l);
        return l.id;
      });
      await requeue();
      const row = await prisma.attendanceLeave.findUniqueOrThrow({
        where: { id },
        include: leaveInclude,
      });
      return reply.status(201).send(leaveDto(row));
    },
  );

  /** Correção do intervalo (antes/depois no histórico imutável). */
  app.put(
    '/api/v1/attendance/leaves/:id',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = updateLeaveSchema.parse(request.body);
      const actor = actorFrom(request);
      assertRange(input.startDate, input.endDate);
      await tx(async (t) => {
        const cur = await t.attendanceLeave.findUnique({ where: { id } });
        if (!cur) throw Errors.notFound('Folga/férias');
        await lockEmployeeLeaves(t, cur.employeeId);
        const l = await t.attendanceLeave.findUniqueOrThrow({ where: { id } });
        if (l.version !== input.version) throw Errors.versionConflict(l.version);
        if (l.status !== 'ATIVA') throw Errors.business('Folga/férias cancelada não pode mudar.');
        await assertNoOverlap(t, l.employeeId, input.startDate, input.endDate, l.id);
        const u = await t.attendanceLeave.update({
          where: { id },
          data: {
            startDate: dbDate(input.startDate),
            endDate: dbDate(input.endDate),
            version: { increment: 1 },
          },
        });
        await recordLeave(t, actor, id, 'CORRIGIDA', input.reason, snapshot(l), snapshot(u));
        await audit(t, actor, {
          action: 'attendance.leave_corrected',
          entityType: 'attendance_leave',
          entityId: id,
          summary: `${leaveCode(l.number)}: ${brDate(dateOnly(l.startDate)!)}–${brDate(dateOnly(l.endDate)!)} → ${brDate(input.startDate)}–${brDate(input.endDate)} — ${input.reason}`,
          changes: { before: snapshot(l), after: snapshot(u) },
        });
        await leaveNotice(t, actor, u, 'corrigida');
        await applyToday(t, actor, { ...u, reason: input.reason });
      });
      await requeue();
      return leaveDto(
        await prisma.attendanceLeave.findUniqueOrThrow({ where: { id }, include: leaveInclude }),
      );
    },
  );

  /** Cancelar (com motivo; nada é apagado). O registro de hoje, se já virou folga, fica no histórico. */
  app.post(
    '/api/v1/attendance/leaves/:id/cancel',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelLeaveSchema.parse(request.body);
      const actor = actorFrom(request);
      await tx(async (t) => {
        const cur = await t.attendanceLeave.findUnique({ where: { id } });
        if (!cur) throw Errors.notFound('Folga/férias');
        await lockEmployeeLeaves(t, cur.employeeId);
        const l = await t.attendanceLeave.findUniqueOrThrow({ where: { id } });
        if (l.version !== input.version) throw Errors.versionConflict(l.version);
        if (l.status !== 'ATIVA') throw Errors.business('Esta folga/férias já foi cancelada.');
        const u = await t.attendanceLeave.update({
          where: { id },
          data: {
            status: 'CANCELADA',
            cancelledAt: new Date(),
            cancelledById: actor.userId,
            cancelReason: input.reason,
            version: { increment: 1 },
          },
        });
        await recordLeave(t, actor, id, 'CANCELADA', input.reason, snapshot(l), snapshot(u));
        await audit(t, actor, {
          action: 'attendance.leave_cancelled',
          entityType: 'attendance_leave',
          entityId: id,
          summary: `${leaveCode(l.number)} cancelada — ${input.reason}`,
        });
        await leaveNotice(t, actor, u, 'cancelada');
      });
      await requeue();
      return leaveDto(
        await prisma.attendanceLeave.findUniqueOrThrow({ where: { id }, include: leaveInclude }),
      );
    },
  );
}
