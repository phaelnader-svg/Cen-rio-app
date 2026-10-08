import {
  ARRIVAL_KIND_LABEL,
  ATTENDANCE_ACTION_LABEL,
  EVENT_TYPES,
  PAUSE_REASON_LABEL,
  arrivalWindowOpen,
  attendanceActionSchema,
  classifyArrival,
  departSchema,
  historyQuerySchema,
  resolveImpactSchema,
  taskCode,
  teamQuerySchema,
  zonedDateTime,
  type AttendanceHistoryDto,
  type AttendanceImpactDto,
  type ImpactKind,
  type MyAttendanceDto,
} from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { notify } from '../notifications/notify';
import { idParams } from '../presenters';
import { domainTaskEvent, lockTasks, taskEvent } from '../production/common';
import { processHelpQueue } from '../help/queue';
import { analyzeAbsence, obsoleteProposals } from '../help/reschedule';
import {
  MANAGE,
  MANAGERS_AUDIENCE,
  SELF,
  VIEW,
  attendanceConfig,
  audienceOf,
  brDate,
  clock,
  dayDto,
  dbDate,
  history,
  lockEmployeeDay,
  notifyManagers,
  openTasksOf,
  refreshAvailability,
  team,
} from './common';

const deviceOf = (request: FastifyRequest) => request.auth?.deviceId ?? null;

/** Situações em que a pessoa não estará na oficina hoje (Fase 8: análise de reprogramação). */
const ABSENT_ACTIONS: readonly string[] = [
  'CONFIRMAR_AUSENCIA',
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
  'TRABALHO_EXTERNO',
];

async function myEmployee(tx: Tx | FastifyInstance['ctx']['prisma'], userId: string) {
  const e = await tx.employee.findUnique({ where: { userId } });
  if (!e || !e.active) throw Errors.forbidden('Sem cadastro de funcionário ativo.');
  return e;
}

/** Resolve os impactos abertos de um dia (ex.: o funcionário chegou ou a ausência foi justificada). */
async function resolveOpenImpacts(
  tx: Tx,
  actor: ActorContext,
  attendanceId: string,
  resolution: string,
) {
  await tx.attendanceImpact.updateMany({
    where: {
      attendanceId,
      resolvedAt: null,
      kind: { in: ['TAREFA_DO_AUSENTE', 'DEPENDENTE_AFETADA'] },
    },
    data: { resolvedAt: new Date(), resolution, resolvedById: actor.userId },
  });
}

export async function attendanceRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  /** Fase 8: chegada, encerramento e situações mudam quem pode ajudar. */
  const requeue = () =>
    processHelpQueue(prisma).catch((err: unknown) =>
      app.log.warn({ err }, 'Falha ao reavaliar a fila de ajuda'),
    );

  // ─────────────────────────── Funcionário (tablet) ───────────────────────────

  async function myAttendance(userId: string): Promise<MyAttendanceDto> {
    const cfg = await attendanceConfig(prisma);
    const e = await myEmployee(prisma, userId);
    const row = await prisma.operationalAttendance.findUnique({
      where: { employeeId_date: { employeeId: e.id, date: dbDate(cfg.today) } },
    });
    const day = await dayDto(prisma, e, row, cfg, cfg.today);
    const open = (await openTasksOf(prisma, userId, cfg)).filter((t) => t.status === 'EM_EXECUCAO');
    const windowOpen = arrivalWindowOpen(cfg.now, cfg);
    const arrived = Boolean(row?.arrivedAt);
    return {
      day,
      config: cfg,
      canArrive: !arrived && windowOpen,
      arriveBlockedReason: arrived
        ? null
        : windowOpen
          ? null
          : `O “Cheguei” fica disponível a partir das ${cfg.arrivalWindowStart}.`,
      canDepart: arrived && row?.situation !== 'ENCERRADO',
      openTasks: open.map((t) => ({
        id: t.id,
        code: taskCode(t.number),
        title: t.title,
        status: t.status,
        priority: t.priority,
        scheduledAt: t.scheduledAt?.toISOString() ?? null,
        dueDate: dateOnly(t.dueDate),
      })),
    };
  }

  app.get('/api/v1/attendance/me', { config: { access: SELF } }, (request) =>
    myAttendance(request.auth!.userId),
  );

  /** "Cheguei": um toque, horário do servidor; repetição não duplica (devolve o registro). */
  app.post(
    '/api/v1/attendance/me/arrive',
    { config: { access: SELF, idempotent: true } },
    async (request) => {
      const userId = request.auth!.userId;
      const actor = actorFrom(request);
      const device = deviceOf(request);
      const now = clock();
      const cfg = await attendanceConfig(prisma, now);
      if (!arrivalWindowOpen(cfg.now, cfg)) {
        throw Errors.business(
          `O “Cheguei” fica disponível a partir das ${cfg.arrivalWindowStart}.`,
        );
      }
      const e = await myEmployee(prisma, userId);
      await prisma.$transaction(async (tx) => {
        await lockEmployeeDay(tx, e.id, cfg.today);
        const before = await tx.operationalAttendance.findUnique({
          where: { employeeId_date: { employeeId: e.id, date: dbDate(cfg.today) } },
        });
        if (before?.arrivedAt) return; // já confirmada: nada muda (sem novo evento)
        const presumed = before?.situation === 'AUSENCIA_PRESUMIDA';
        const { kind, lateMinutes } = classifyArrival(cfg.now, cfg, presumed);
        const data = {
          situation: 'PRESENTE' as const,
          arrivedAt: now,
          arrivalKind: kind,
          lateMinutes,
          arrivalById: userId,
          arrivalDeviceId: device,
        };
        const row = before
          ? await tx.operationalAttendance.update({
              where: { id: before.id },
              data: { ...data, version: { increment: 1 } },
            })
          : await tx.operationalAttendance.create({
              data: { ...data, employeeId: e.id, date: dbDate(cfg.today) },
            });
        await history(tx, actor, row.id, 'CHEGADA', before, row, null, device);
        await audit(tx, actor, {
          action: 'attendance.arrived',
          entityType: 'attendance',
          entityId: row.id,
          summary: `${e.displayName} confirmou chegada às ${cfg.now} (${ARRIVAL_KIND_LABEL[kind].toLowerCase()}${lateMinutes ? `, ${lateMinutes} min` : ''}).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.ATTENDANCE_ARRIVED,
          aggregateType: 'attendance',
          aggregateId: row.id,
          payload: { employeeId: e.id, date: cfg.today, kind, lateMinutes },
          audience: audienceOf(userId),
        });
        if (lateMinutes > 0) {
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.ATTENDANCE_LATE,
            aggregateType: 'attendance',
            aggregateId: row.id,
            payload: { employeeId: e.id, date: cfg.today, lateMinutes },
            audience: audienceOf(userId),
          });
        }
        // Recibo para o próprio funcionário (persistente); o gestor só recebe o que exige ação.
        await notify(tx, actor, [
          {
            userId,
            kind: 'CHEGADA_CONFIRMADA',
            dedupeKey: `CHEGADA:${row.id}`,
            body: `Chegada confirmada às ${cfg.now}${lateMinutes ? ` (${lateMinutes} min após o horário previsto)` : ''}.`,
            includeActor: true,
          },
        ]);
        if (presumed) {
          await resolveOpenImpacts(tx, actor, row.id, `${e.displayName} chegou às ${cfg.now}.`);
          // Fase 8: a chegada torna sem efeito as propostas da ausência presumida.
          await obsoleteProposals(
            tx,
            actor,
            { attendanceId: row.id },
            `${e.displayName} chegou às ${cfg.now}.`,
          );
          await notifyManagers(
            tx,
            actor,
            'CHEGADA_APOS_AUSENCIA',
            `CHEGADA_APOS_AUSENCIA:${row.id}`,
            `${e.displayName} chegou às ${cfg.now}, depois da ausência presumida. Reveja as tarefas afetadas.`,
          );
        } else if (lateMinutes >= cfg.lateAlertMinutes && lateMinutes > 0) {
          await notifyManagers(
            tx,
            actor,
            'ATRASO_OPERACIONAL',
            `ATRASO:${row.id}`,
            `${e.displayName} confirmou chegada às ${cfg.now} (${lateMinutes} min após ${cfg.workdayStart}).`,
          );
        }
        await refreshAvailability(tx, actor, e.id, now);
      });
      await requeue();
      return myAttendance(userId);
    },
  );

  /**
   * Encerrar expediente: registra a saída (nunca bloqueada por falta de informação),
   * grava o andamento informado, pausa as tarefas em execução (andamento preservado)
   * e, se alguma ficou sem andamento, gera pendência para o gestor acompanhar.
   */
  app.post(
    '/api/v1/attendance/me/depart',
    { config: { access: SELF, idempotent: true } },
    async (request) => {
      const userId = request.auth!.userId;
      const input = departSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      const device = deviceOf(request);
      const now = clock();
      const cfg = await attendanceConfig(prisma, now);
      const e = await myEmployee(prisma, userId);
      await prisma.$transaction(async (tx) => {
        await lockEmployeeDay(tx, e.id, cfg.today);
        const before = await tx.operationalAttendance.findUnique({
          where: { employeeId_date: { employeeId: e.id, date: dbDate(cfg.today) } },
        });
        if (before?.situation === 'ENCERRADO') return; // repetição
        if (!before?.arrivedAt) {
          throw Errors.business('Confirme a chegada antes de encerrar o expediente.');
        }
        const running = await tx.productionTask.findMany({
          where: { assigneeUserId: userId, status: 'EM_EXECUCAO' },
        });
        await lockTasks(
          tx,
          running.map((t) => t.id),
        );
        const given = new Map(input.tasks.map((t) => [t.taskId, t]));
        if ([...given.keys()].some((id) => !running.some((t) => t.id === id))) {
          throw Errors.business(
            'Andamento informado para tarefa que não está em execução com você.',
          );
        }
        const pending: typeof running = [];
        for (const t of running) {
          const p = given.get(t.id);
          const informed = Boolean(
            p &&
              (p.note || p.step || p.nextStep || (p.percent !== undefined && p.percent !== null)),
          );
          if (informed) {
            await taskEvent(tx, actor, device, t, {
              kind: 'ANDAMENTO',
              note: p!.note ?? null,
              changes: {
                percent: p!.percent ?? null,
                step: p!.step ?? null,
                nextStep: p!.nextStep ?? null,
                attachmentIds: [],
              },
            });
          } else {
            pending.push(t);
          }
          // Pausa operacional: andamento (anterior ou informado agora) preservado.
          const u = await tx.productionTask.update({
            where: { id: t.id },
            data: {
              status: 'PAUSADA',
              pauseReason: 'FIM_EXPEDIENTE',
              pauseNote: 'Encerramento do expediente',
              ...(informed
                ? {
                    progressNote: p!.note ?? null,
                    progressPercent: p!.percent ?? t.progressPercent,
                    progressStep: p!.step ?? null,
                    progressNext: p!.nextStep ?? null,
                    progressAt: now,
                  }
                : {}),
              version: { increment: 1 },
            },
          });
          await taskEvent(tx, actor, device, t, {
            kind: 'PAUSADA',
            from: 'EM_EXECUCAO',
            to: 'PAUSADA',
            note: PAUSE_REASON_LABEL.FIM_EXPEDIENTE,
            changes: { reason: 'FIM_EXPEDIENTE', impediment: false },
          });
          await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PAUSED, u, {
            reason: 'FIM_EXPEDIENTE',
            impediment: false,
          });
        }
        const early = cfg.now < cfg.workdayEnd;
        const row = await tx.operationalAttendance.update({
          where: { id: before.id },
          data: {
            situation: 'ENCERRADO',
            departedAt: now,
            departureById: userId,
            departureDeviceId: device,
            earlyDeparture: early,
            departureNote: input.note ?? null,
            version: { increment: 1 },
          },
        });
        await history(tx, actor, row.id, 'SAIDA', before, row, input.note ?? null, device);
        if (pending.length) {
          const full = await tx.productionTask.findMany({
            where: { id: { in: pending.map((t) => t.id) } },
            include: { serviceOrder: { select: { number: true } } },
          });
          await tx.attendanceImpact.createMany({
            data: full.map((t) => ({
              attendanceId: row.id,
              taskId: t.id,
              kind: 'ANDAMENTO_PENDENTE',
              affectedUserId: userId,
              dueDate: t.dueDate,
              detail: `${taskCode(t.number)} · ${t.title} (${serviceOrderCode(t.serviceOrder.number)}) pausada no encerramento sem andamento informado por ${e.displayName}.`,
            })),
            skipDuplicates: true,
          });
          await notifyManagers(
            tx,
            actor,
            'TAREFA_PENDENTE_ENCERRAMENTO',
            `PENDENTE:${row.id}`,
            `${e.displayName} encerrou o expediente sem informar o andamento de ${full
              .map((t) => taskCode(t.number))
              .join(', ')}.`,
            full[0]!.id,
          );
        }
        await audit(tx, actor, {
          action: 'attendance.departed',
          entityType: 'attendance',
          entityId: row.id,
          summary: `${e.displayName} encerrou o expediente às ${cfg.now}${early ? ' (saída antecipada)' : ''}; ${running.length} tarefa(s) pausada(s), ${pending.length} sem andamento.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.ATTENDANCE_DEPARTED,
          aggregateType: 'attendance',
          aggregateId: row.id,
          payload: {
            employeeId: e.id,
            date: cfg.today,
            paused: running.length,
            pending: pending.length,
            early,
          },
          audience: audienceOf(userId),
        });
        await notify(tx, actor, [
          {
            userId,
            kind: 'EXPEDIENTE_ENCERRADO',
            dedupeKey: `SAIDA:${row.id}`,
            body: `Expediente encerrado às ${cfg.now}${running.length ? `; ${running.length} tarefa(s) pausada(s) com o andamento preservado` : ''}.`,
            includeActor: true,
          },
        ]);
        await refreshAvailability(tx, actor, e.id, now);
      });
      await requeue();
      return myAttendance(userId);
    },
  );

  // ─────────────────────────── Gestão ───────────────────────────

  app.get('/api/v1/attendance/team', { config: { access: VIEW } }, async (request) => {
    const q = teamQuerySchema.parse(request.query);
    const cfg = await attendanceConfig(prisma);
    const date = q.date ?? cfg.today;
    const members = (await team(prisma)).filter((e) => !q.employeeId || e.id === q.employeeId);
    const rows = await prisma.operationalAttendance.findMany({
      where: { date: dbDate(date), employeeId: { in: members.map((m) => m.id) } },
    });
    const days = [];
    for (const m of members)
      days.push(
        await dayDto(prisma, m, rows.find((r) => r.employeeId === m.id) ?? null, cfg, date),
      );
    return { date, config: cfg, days };
  });

  /** Histórico diário de um funcionário (período) com as alterações de cada dia. */
  app.get('/api/v1/attendance/history', { config: { access: VIEW } }, async (request) => {
    const q = historyQuerySchema.parse(request.query);
    const cfg = await attendanceConfig(prisma);
    const e = await prisma.employee.findUnique({ where: { id: q.employeeId } });
    if (!e) throw Errors.notFound('Funcionário');
    const to = q.to ?? cfg.today;
    const from =
      q.from ?? new Date(dbDate(to).getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
    const rows = await prisma.operationalAttendance.findMany({
      where: { employeeId: e.id, date: { gte: dbDate(from), lte: dbDate(to) } },
      include: {
        corrections: {
          include: { actor: { select: { displayName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { date: 'desc' },
    });
    const devices = await prisma.device.findMany({ select: { id: true, name: true } });
    const deviceName = (id: string | null) => devices.find((d) => d.id === id)?.name ?? null;
    return {
      employee: { id: e.id, displayName: e.displayName },
      from,
      to,
      days: await Promise.all(
        rows.map(async (r) => ({
          ...(await dayDto(prisma, e, r, cfg, dateOnly(r.date)!)),
          history: r.corrections.map(
            (c): AttendanceHistoryDto => ({
              id: c.id,
              action: c.action,
              reason: c.reason,
              before: c.before,
              after: c.after,
              actor: c.actor?.displayName ?? (c.actorId ? null : 'Sistema'),
              device: deviceName(c.deviceId),
              createdAt: c.createdAt.toISOString(),
            }),
          ),
        })),
      ),
    };
  });

  /**
   * Situações especiais e correções do gestor (sempre com justificativa). O registro
   * anterior fica no histórico imutável; nada é apagado. Atestado: só o fato informado.
   */
  app.post('/api/v1/attendance/actions', { config: { access: MANAGE } }, async (request) => {
    const input = attendanceActionSchema.parse(request.body);
    const actor = actorFrom(request);
    const cfg = await attendanceConfig(prisma);
    const e = await prisma.employee.findUnique({ where: { id: input.employeeId } });
    if (!e) throw Errors.notFound('Funcionário');
    if (!(await team(prisma)).some((m) => m.id === e.id)) {
      throw Errors.business('Este funcionário não registra presença operacional.');
    }
    const at = (time: string) => zonedDateTime(input.date, time, cfg.timezone);
    await prisma.$transaction(async (tx) => {
      await lockEmployeeDay(tx, e.id, input.date);
      const before = await tx.operationalAttendance.findUnique({
        where: { employeeId_date: { employeeId: e.id, date: dbDate(input.date) } },
      });
      if (input.version !== undefined && before && before.version !== input.version) {
        throw Errors.versionConflict(before.version);
      }
      const data: Prisma.OperationalAttendanceUncheckedUpdateInput = {};
      const arrival = (time: string) => {
        const c = classifyArrival(time, cfg, false);
        return {
          arrivedAt: at(time),
          arrivalKind: c.kind,
          lateMinutes: c.lateMinutes,
          arrivalById: actor.userId,
          arrivalDeviceId: null,
        };
      };
      switch (input.action) {
        case 'CONFIRMAR_AUSENCIA':
        case 'AUSENCIA_JUSTIFICADA':
        case 'ATESTADO':
        case 'FOLGA':
        case 'FERIAS': {
          if (before?.arrivedAt) {
            throw Errors.business(
              'Há chegada registrada neste dia; use “Correção administrativa”.',
            );
          }
          data.situation =
            input.action === 'CONFIRMAR_AUSENCIA' ? 'AUSENCIA_CONFIRMADA' : input.action;
          data.note = input.reason;
          break;
        }
        case 'TRABALHO_EXTERNO':
          data.situation = 'TRABALHO_EXTERNO';
          data.note = input.externalNote;
          break;
        case 'CHEGADA_TARDIA':
        case 'ESQUECIMENTO':
          Object.assign(data, arrival(input.arrivalTime!));
          if (before?.situation !== 'ENCERRADO') data.situation = 'PRESENTE';
          break;
        case 'SAIDA_ANTECIPADA':
          if (!before?.arrivedAt) throw Errors.business('Não há chegada registrada neste dia.');
          data.departedAt = at(input.departureTime!);
          data.earlyDeparture = true;
          data.situation = 'ENCERRADO';
          break;
        case 'CORRECAO':
          if (input.arrivalTime) Object.assign(data, arrival(input.arrivalTime));
          if (input.departureTime) {
            data.departedAt = at(input.departureTime);
            data.earlyDeparture = input.departureTime < cfg.workdayEnd;
            data.situation = 'ENCERRADO';
          } else if (input.arrivalTime) {
            data.situation = before?.departedAt ? 'ENCERRADO' : 'PRESENTE';
          }
          if (input.arrivalTime === null) {
            // Remover chegada registrada por engano (o histórico guarda a original).
            Object.assign(data, {
              arrivedAt: null,
              arrivalKind: null,
              lateMinutes: 0,
              departedAt: null,
              earlyDeparture: false,
              situation: 'AUSENCIA_CONFIRMADA',
            });
          }
          break;
      }
      const row = before
        ? await tx.operationalAttendance.update({
            where: { id: before.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.operationalAttendance.create({
            data: {
              employeeId: e.id,
              date: dbDate(input.date),
              situation: (data.situation as never) ?? 'PRESENTE',
              ...(data as object),
            } as Prisma.OperationalAttendanceUncheckedCreateInput,
          });
      await history(tx, actor, row.id, input.action, before, row, input.reason);
      if (
        [
          'AUSENCIA_JUSTIFICADA',
          'ATESTADO',
          'FOLGA',
          'FERIAS',
          'CHEGADA_TARDIA',
          'ESQUECIMENTO',
          'TRABALHO_EXTERNO',
        ].includes(input.action)
      ) {
        await resolveOpenImpacts(
          tx,
          actor,
          row.id,
          `${ATTENDANCE_ACTION_LABEL[input.action]}: ${input.reason}`,
        );
      }
      await audit(tx, actor, {
        action: `attendance.${input.action.toLowerCase()}`,
        entityType: 'attendance',
        entityId: row.id,
        summary: `${e.displayName} em ${brDate(input.date)}: ${ATTENDANCE_ACTION_LABEL[input.action]} — ${input.reason}`,
      });
      await appendEvent(tx, actor, {
        type:
          input.action === 'CONFIRMAR_AUSENCIA'
            ? EVENT_TYPES.ATTENDANCE_ABSENCE_CONFIRMED
            : EVENT_TYPES.ATTENDANCE_CORRECTED,
        aggregateType: 'attendance',
        aggregateId: row.id,
        payload: { employeeId: e.id, date: input.date, action: input.action },
        audience: audienceOf(e.userId),
      });
      await notify(tx, actor, [
        {
          userId: e.userId,
          kind: input.action === 'CONFIRMAR_AUSENCIA' ? 'AUSENCIA_CONFIRMADA' : 'PRESENCA_ALTERADA',
          dedupeKey: `PRESENCA:${row.id}:${row.version}`,
          body: `${brDate(input.date)}: ${ATTENDANCE_ACTION_LABEL[input.action]} — ${input.reason}`,
        },
      ]);
      if (input.date === cfg.today) {
        await refreshAvailability(tx, actor, e.id);
        // Fase 8: ausência (confirmada, justificada, folga, férias, externo) → análise de
        // reprogramação; chegada registrada → propostas da ausência perdem o efeito.
        if (ABSENT_ACTIONS.includes(input.action)) {
          await obsoleteProposals(
            tx,
            actor,
            { attendanceId: row.id, dedupeKey: { endsWith: ':PRESUMIDA' } },
            `${ATTENDANCE_ACTION_LABEL[input.action]} registrada pelo gestor.`,
          );
          await analyzeAbsence(tx, actor, row.id, 'CONFIRMADA');
        } else if (row.arrivedAt && row.situation === 'PRESENTE') {
          await obsoleteProposals(
            tx,
            actor,
            { attendanceId: row.id },
            `${ATTENDANCE_ACTION_LABEL[input.action]}: ${e.displayName} está presente.`,
          );
        }
      }
    });
    await requeue();
    const row = await prisma.operationalAttendance.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: e.id, date: dbDate(input.date) } },
    });
    return dayDto(prisma, e, row, cfg, input.date);
  });

  app.get('/api/v1/attendance/impacts', { config: { access: VIEW } }, async (request) => {
    const q = teamQuerySchema.parse(request.query);
    const cfg = await attendanceConfig(prisma);
    const date = q.date ?? cfg.today;
    const rows = await prisma.attendanceImpact.findMany({
      where: {
        attendance: {
          date: dbDate(date),
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
        },
      },
      include: {
        attendance: { include: { employee: { select: { id: true, displayName: true } } } },
        task: { include: { serviceOrder: { select: { number: true } } } },
        affectedUser: { select: { displayName: true } },
        resolvedBy: { select: { displayName: true } },
      },
      orderBy: [{ resolvedAt: { sort: 'asc', nulls: 'first' } }, { detectedAt: 'asc' }],
    });
    return rows.map(
      (r): AttendanceImpactDto => ({
        id: r.id,
        kind: r.kind as ImpactKind,
        employee: r.attendance.employee,
        date,
        task: {
          id: r.task.id,
          code: taskCode(r.task.number),
          title: r.task.title,
          status: r.task.status,
          serviceOrderCode: serviceOrderCode(r.task.serviceOrder.number),
        },
        affectedUser: r.affectedUser?.displayName ?? null,
        dueDate: dateOnly(r.dueDate),
        detail: r.detail,
        detectedAt: r.detectedAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolution: r.resolution,
        resolvedBy: r.resolvedBy?.displayName ?? null,
      }),
    );
  });

  /** O gestor registra o encaminhamento (ex.: "reprogramada para amanhã"); nada é feito automaticamente. */
  app.post(
    '/api/v1/attendance/impacts/:id/resolve',
    { config: { access: MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = resolveImpactSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM attendance_impacts WHERE id = ${id}::uuid FOR UPDATE`;
        if (!rows.length) throw Errors.notFound('Alerta');
        const impact = await tx.attendanceImpact.findUniqueOrThrow({ where: { id } });
        if (impact.resolvedAt) throw Errors.business('Alerta já encaminhado.');
        await tx.attendanceImpact.update({
          where: { id },
          data: {
            resolvedAt: new Date(),
            resolvedById: actor.userId,
            resolution: input.resolution,
          },
        });
        await audit(tx, actor, {
          action: 'attendance.impact_resolved',
          entityType: 'attendance_impact',
          entityId: id,
          summary: `Alerta de presença encaminhado: ${input.resolution}`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.ATTENDANCE_CORRECTED,
          aggregateType: 'attendance',
          aggregateId: impact.attendanceId,
          payload: { impactId: id, resolved: true },
          audience: MANAGERS_AUDIENCE,
        });
      });
      return { ok: true };
    },
  );
}
