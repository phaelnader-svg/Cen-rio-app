import type {
  ArrivalKind,
  AttendanceSituation,
  Availability,
  ImpactKind,
  LeaveKind,
} from './attendance-domain';
import type { Priority } from './domain';
import type { TaskStatus } from './production-domain';

export interface AttendanceTaskRefDto {
  id: string;
  code: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  scheduledAt: string | null;
  dueDate: string | null;
}

export interface AttendanceDayDto {
  /** null quando ainda não há registro do dia (não confirmou chegada). */
  id: string | null;
  date: string;
  employee: { id: string; userId: string; displayName: string; color: string; jobTitle: string };
  situation: AttendanceSituation | null;
  availability: Availability;
  arrivedAt: string | null;
  arrivalKind: ArrivalKind | null;
  lateMinutes: number;
  departedAt: string | null;
  earlyDeparture: boolean;
  departureNote: string | null;
  presumedAbsentAt: string | null;
  note: string | null;
  runningTask: AttendanceTaskRefDto | null;
  nextTask: AttendanceTaskRefDto | null;
  /** Alertas abertos (impactos/pendências não resolvidos). */
  openAlerts: number;
  /** Simplificação Fase 7: folga/férias planejada que cobre o dia (sem registro próprio). */
  leave: { id: string; code: string; kind: LeaveKind } | null;
  /** Simplificação Fase 7: expediente de dia anterior sem saída registrada. */
  openShift: boolean;
  /** Simplificação Fase 7: o gestor encerrou o dia sem horário de saída (não informado). */
  departureUnrecorded: boolean;
  version: number | null;
}

export interface AttendanceConfigDto {
  timezone: string;
  arrivalWindowStart: string;
  workdayStart: string;
  arrivalAlertAt: string;
  workdayEnd: string;
  lateAlertMinutes: number;
  workingDay: boolean;
  /** Simplificação Fase 7: feriado/dia sem expediente do calendário da empresa (nome). */
  holiday: string | null;
  /** Hora local do servidor (HH:MM) — referência para o tablet. */
  now: string;
  today: string;
}

/**
 * Simplificação Fase 7 (CA7-01): o que o próprio funcionário recebe no tablet. Sem avaliação de
 * pontualidade — nada de minutos de atraso, tipo de chegada, saída antecipada, limite de alerta
 * ou horário de ausência presumida. O gestor continua vendo tudo em `AttendanceDayDto`.
 */
export interface MyAttendanceDayDto {
  id: string | null;
  date: string;
  situation: AttendanceSituation | null;
  availability: Availability;
  arrivedAt: string | null;
  departedAt: string | null;
  note: string | null;
  runningTask: AttendanceTaskRefDto | null;
  nextTask: AttendanceTaskRefDto | null;
}
export interface MyAttendanceConfigDto {
  timezone: string;
  arrivalWindowStart: string;
  workdayStart: string;
  workdayEnd: string;
  workingDay: boolean;
  holiday: string | null;
  now: string;
  today: string;
}

export interface MyAttendanceDto {
  day: MyAttendanceDayDto;
  config: MyAttendanceConfigDto;
  canArrive: boolean;
  /** Motivo de o "Cheguei" não estar disponível agora. */
  arriveBlockedReason: string | null;
  canDepart: boolean;
  /** Tarefas que ficam pendentes ao encerrar (em execução ou pausadas hoje). */
  openTasks: AttendanceTaskRefDto[];
}

export interface AttendanceHistoryDto {
  id: string;
  action: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  actor: string | null;
  device: string | null;
  createdAt: string;
}

export interface AttendanceImpactDto {
  id: string;
  /** Rodada 3 (F10-14): expediente do impacto (destino do link da Central). */
  attendanceId: string;
  kind: ImpactKind;
  employee: { id: string; displayName: string };
  date: string;
  task: { id: string; code: string; title: string; status: TaskStatus; serviceOrderCode: string };
  affectedUser: string | null;
  dueDate: string | null;
  detail: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
}

/** Simplificação Fase 7: expediente aberto de dia anterior (sem "Encerrar"); nada é inventado. */
export interface OpenShiftDto {
  attendanceId: string;
  date: string;
  employee: { id: string; displayName: string };
  arrivedAt: string;
  version: number;
}

export interface HolidayDto {
  id: string;
  date: string;
  name: string;
  active: boolean;
  version: number;
  updatedAt: string;
}

export interface LeaveDto {
  id: string;
  code: string;
  employee: { id: string; displayName: string };
  kind: LeaveKind;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: 'ATIVA' | 'CANCELADA';
  version: number;
  createdBy: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  history: {
    action: 'CRIADA' | 'CORRIGIDA' | 'CANCELADA';
    reason: string;
    before: unknown;
    after: unknown;
    actor: string | null;
    createdAt: string;
  }[];
}
