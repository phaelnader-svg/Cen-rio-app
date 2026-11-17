/**
 * "Replay da semana": reconstrói, a partir dos horários reais de início e fim de cada etapa, onde
 * cada peça e cada pessoa estava num instante dos últimos 7 dias. Só usa o que está no retrato
 * (peças ainda na oficina ou na expedição); peças já entregues não aparecem.
 */
import {
  type GameEmployeeDto,
  type GamePieceDto,
  type GameSnapshotDto,
  type LayoutContent,
  placePiece,
} from '@cenario/shared';

export interface ReplayRange {
  from: number;
  to: number;
}

export function replayRange(snap: GameSnapshotDto, now = Date.now()): ReplayRange | null {
  const times = snap.pieces
    .flatMap((p) => p.tasks)
    .flatMap((t) => [t.startedAt, t.completedAt])
    .filter((x): x is string => Boolean(x))
    .map((x) => new Date(x).getTime());
  if (!times.length) return null;
  const from = Math.max(now - 7 * 864e5, Math.min(...times) - 3600e3);
  return { from, to: now };
}

const RUN = ['EM_EXECUCAO', 'PAUSADA'];

/** Situação da tarefa num instante. */
function statusAt(t: GamePieceDto['tasks'][number], at: number) {
  const s = t.startedAt ? new Date(t.startedAt).getTime() : null;
  const e = t.completedAt ? new Date(t.completedAt).getTime() : null;
  if (e !== null && at >= e) return 'CONCLUIDA';
  if (s !== null && at >= s) return RUN.includes(t.status) ? t.status : 'EM_EXECUCAO';
  return t.status === 'RASCUNHO' ? 'RASCUNHO' : 'LIBERADA';
}

/** Retrato reconstruído no instante `at` (peças, posições, etapas e quem trabalhava). */
export function snapshotAt(
  layout: LayoutContent,
  snap: GameSnapshotDto,
  at: number,
): Pick<GameSnapshotDto, 'pieces' | 'employees'> {
  const names = Object.fromEntries(snap.employees.map((e) => [e.userId, e.name]));
  const pieces: GamePieceDto[] = [];
  for (const p of snap.pieces) {
    const tasks = p.tasks.map((t) => ({ ...t, status: statusAt(t, at) }));
    const lastEnd = Math.max(
      0,
      ...p.tasks.map((t) => (t.completedAt ? new Date(t.completedAt).getTime() : 0)),
    );
    const allDone = p.tasks.every((t) => t.status === 'CONCLUIDA' || t.status === 'CANCELADA');
    const stage = allDone && at >= lastEnd ? p.stage : 'EM_PRODUCAO';
    const running = tasks.find((t) => RUN.includes(t.status)) ?? null;
    const placement = placePiece(layout, {
      stage,
      tasks: tasks.map((t) => ({
        id: t.id,
        activity: t.activity,
        status: t.status,
        assigneeUserId: t.assigneeUserId,
      })),
      names,
    });
    pieces.push({
      ...p,
      stage,
      tasks,
      placement,
      currentTask: running,
      confirmedLocation: null,
    });
  }
  const employees: GameEmployeeDto[] = snap.employees.map((e) => {
    const cur = pieces
      .flatMap((p) => p.tasks.map((t) => ({ t, p })))
      .find(({ t }) => t.assigneeUserId === e.userId && RUN.includes(t.status));
    return {
      ...e,
      currentTask: cur ? { ...cur.t, osCode: cur.p.osCode, itemCode: cur.p.itemCode } : null,
      stationId: cur ? (cur.p.placement.stationId ?? e.stationId) : e.stationId,
      attendance: null,
    };
  });
  return { pieces, employees };
}

export function fmtReplayTime(at: number) {
  return new Date(at).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
