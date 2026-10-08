import type {
  ArrivalKind,
  AttendanceSituation,
  Availability,
  ImpactKind,
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
  /** Hora local do servidor (HH:MM) — referência para o tablet. */
  now: string;
  today: string;
}

export interface MyAttendanceDto {
  day: AttendanceDayDto;
  config: AttendanceConfigDto;
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
