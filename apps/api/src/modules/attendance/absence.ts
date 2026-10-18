import { EVENT_TYPES, PLANNED_ABSENCES, pastAbsenceLimit } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import {
  attendanceConfig,
  attendanceEvent,
  brDate,
  clock,
  dbDate,
  detectImpacts,
  history,
  hhmm,
  leaveOn,
  lockEmployeeDay,
  notifyManagers,
  openShifts,
  refreshAvailability,
  team,
} from './common';
import { analyzeAbsence } from '../help/reschedule';

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };

/**
 * Ausência presumida: em dia útil, depois do limite configurado (9h30), quem da equipe
 * não confirmou chegada nem tem situação registrada passa a "ausência presumida". Isso
 * NÃO é falta trabalhista: só identifica o impacto nas tarefas e avisa o gestor, que
 * confirma ou corrige. Idempotente (executado periodicamente).
 */
export async function detectAbsences(prisma: PrismaClient, now = clock()) {
  const cfg = await attendanceConfig(prisma, now);
  if (!cfg.workingDay || !pastAbsenceLimit(cfg.now, cfg)) return 0;
  let flagged = 0;
  for (const e of await team(prisma)) {
    const changed = await prisma.$transaction(async (tx) => {
      await lockEmployeeDay(tx, e.id, cfg.today);
      const before = await tx.operationalAttendance.findUnique({
        where: { employeeId_date: { employeeId: e.id, date: dbDate(cfg.today) } },
      });
      // Já chegou, já foi presumido/confirmado, ou tem situação planejada/externa: nada a fazer.
      if (
        before &&
        (before.arrivedAt ||
          before.situation === 'AUSENCIA_PRESUMIDA' ||
          before.situation === 'AUSENCIA_CONFIRMADA' ||
          before.situation === 'TRABALHO_EXTERNO' ||
          (PLANNED_ABSENCES as readonly string[]).includes(before.situation))
      ) {
        return false;
      }
      // Simplificação Fase 7: folga/férias planejada por intervalo também não gera ausência.
      if (!before && (await leaveOn(tx, e.id, cfg.today))) return false;
      const row = before
        ? await tx.operationalAttendance.update({
            where: { id: before.id },
            data: {
              situation: 'AUSENCIA_PRESUMIDA',
              presumedAbsentAt: now,
              version: { increment: 1 },
            },
          })
        : await tx.operationalAttendance.create({
            data: {
              employeeId: e.id,
              date: dbDate(cfg.today),
              situation: 'AUSENCIA_PRESUMIDA',
              presumedAbsentAt: now,
            },
          });
      await history(
        tx,
        SYSTEM,
        row.id,
        'AUSENCIA_PRESUMIDA',
        before,
        row,
        `Sem confirmação até ${cfg.arrivalAlertAt}`,
      );
      const impact = await detectImpacts(tx, row, e, cfg);
      await audit(tx, SYSTEM, {
        action: 'attendance.absence_suspected',
        entityType: 'attendance',
        entityId: row.id,
        summary: `${e.displayName}: ausência presumida em ${brDate(cfg.today)} (sem confirmação até ${cfg.arrivalAlertAt}).`,
      });
      await attendanceEvent(tx, SYSTEM, {
        type: EVENT_TYPES.ATTENDANCE_ABSENCE_SUSPECTED,
        aggregateId: row.id,
        userId: e.userId,
        payload: { employeeId: e.id, date: cfg.today },
      });
      if (impact.own + impact.dependents > 0) {
        await attendanceEvent(tx, SYSTEM, {
          type: EVENT_TYPES.ATTENDANCE_PRODUCTION_IMPACT_DETECTED,
          aggregateId: row.id,
          userId: e.userId,
          payload: {
            employeeId: e.id,
            date: cfg.today,
            tasks: impact.own,
            dependents: impact.dependents,
          },
          self: null,
        });
      }
      // Um alerta por pessoa ausente (não um por tarefa).
      await notifyManagers(
        tx,
        SYSTEM,
        'AUSENCIA_PRESUMIDA',
        `AUSENCIA_PRESUMIDA:${row.id}`,
        `${e.displayName} não confirmou chegada até ${cfg.arrivalAlertAt}. ${
          impact.own + impact.dependents
            ? `${impact.own} tarefa(s) dele(a) e ${impact.dependents} dependente(s) afetada(s) — verificar reprogramação.`
            : 'Nenhuma tarefa programada afetada.'
        }`,
      );
      await refreshAvailability(tx, SYSTEM, e.id, now);
      // Fase 8: sugestões de redistribuição ao gestor (nada é transferido na ausência presumida).
      if (impact.own > 0) await analyzeAbsence(tx, SYSTEM, row.id, 'PRESUMIDA');
      return true;
    });
    if (changed) flagged += 1;
  }
  return flagged;
}

/**
 * Simplificação Fase 7: expediente esquecido. Um dia anterior com chegada e sem saída nunca é
 * encerrado sozinho (nenhum horário é inventado): vira alerta único para quem gerencia a
 * presença, que registra a saída, encerra sem horário ou corrige. Idempotente.
 */
export async function detectOpenShifts(prisma: PrismaClient, now = clock()) {
  const cfg = await attendanceConfig(prisma, now);
  let alerted = 0;
  for (const r of await openShifts(prisma, cfg)) {
    const fresh = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`open-shift:${r.id}`}))`;
      const done = await tx.auditLog.count({
        where: { action: 'attendance.open_shift_detected', entityId: r.id },
      });
      if (done) return false;
      const date = r.date.toISOString().slice(0, 10);
      await audit(tx, SYSTEM, {
        action: 'attendance.open_shift_detected',
        entityType: 'attendance',
        entityId: r.id,
        summary: `${r.employee.displayName}: expediente de ${brDate(date)} sem saída registrada (chegada às ${hhmm(r.arrivedAt!, cfg.timezone)}).`,
      });
      await notifyManagers(
        tx,
        SYSTEM,
        'EXPEDIENTE_ABERTO',
        `EXPEDIENTE_ABERTO:${r.id}`,
        `${r.employee.displayName}: expediente de ${brDate(date)} sem encerramento (chegada às ${hhmm(r.arrivedAt!, cfg.timezone)}). Registre a saída ou encerre sem horário em Presença.`,
      );
      return true;
    });
    if (fresh) alerted += 1;
  }
  return alerted;
}
