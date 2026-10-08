import { EVENT_TYPES, PLANNED_ABSENCES, pastAbsenceLimit } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import {
  attendanceConfig,
  audienceOf,
  brDate,
  clock,
  dbDate,
  detectImpacts,
  history,
  lockEmployeeDay,
  notifyManagers,
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
      await appendEvent(tx, SYSTEM, {
        type: EVENT_TYPES.ATTENDANCE_ABSENCE_SUSPECTED,
        aggregateType: 'attendance',
        aggregateId: row.id,
        payload: { employeeId: e.id, date: cfg.today },
        audience: audienceOf(e.userId),
      });
      if (impact.own + impact.dependents > 0) {
        await appendEvent(tx, SYSTEM, {
          type: EVENT_TYPES.ATTENDANCE_PRODUCTION_IMPACT_DETECTED,
          aggregateType: 'attendance',
          aggregateId: row.id,
          payload: {
            employeeId: e.id,
            date: cfg.today,
            tasks: impact.own,
            dependents: impact.dependents,
          },
          audience: audienceOf(e.userId),
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
