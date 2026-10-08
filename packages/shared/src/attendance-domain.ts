/**
 * Fase 7 — presença operacional (não é registro de ponto eletrônico).
 * Serve para organizar a produção: quem chegou, quem está disponível, atrasos operacionais,
 * ausências presumidas e o impacto nas tarefas. Nada aqui gera cálculo de jornada, folha,
 * desconto ou penalidade.
 */

/** Situação do dia de um funcionário (registro operacional). */
export const ATTENDANCE_SITUATIONS = [
  'PRESENTE',
  'AUSENCIA_PRESUMIDA',
  'AUSENCIA_CONFIRMADA',
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
  'TRABALHO_EXTERNO',
  'ENCERRADO',
] as const;
export type AttendanceSituation = (typeof ATTENDANCE_SITUATIONS)[number];
export const ATTENDANCE_SITUATION_LABEL: Record<AttendanceSituation, string> = {
  PRESENTE: 'Presente',
  AUSENCIA_PRESUMIDA: 'Ausência presumida',
  AUSENCIA_CONFIRMADA: 'Ausência confirmada',
  AUSENCIA_JUSTIFICADA: 'Ausência justificada',
  ATESTADO: 'Atestado informado',
  FOLGA: 'Folga',
  FERIAS: 'Férias',
  TRABALHO_EXTERNO: 'Trabalho externo',
  ENCERRADO: 'Expediente encerrado',
};
/** Situações planejadas/justificadas: não geram ausência presumida nem alerta. */
export const PLANNED_ABSENCES: readonly AttendanceSituation[] = [
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
];

/** Como foi a chegada. */
export const ARRIVAL_KINDS = ['NO_HORARIO', 'ATRASO', 'APOS_AUSENCIA_PRESUMIDA'] as const;
export type ArrivalKind = (typeof ARRIVAL_KINDS)[number];
export const ARRIVAL_KIND_LABEL: Record<ArrivalKind, string> = {
  NO_HORARIO: 'No horário',
  ATRASO: 'Atraso operacional',
  APOS_AUSENCIA_PRESUMIDA: 'Chegada após ausência presumida',
};

/** Disponibilidade operacional (derivada de presença, tarefas, pausas e atividade externa). */
export const AVAILABILITIES = [
  'NAO_CONFIRMOU',
  'DISPONIVEL',
  'OCUPADO',
  'EM_PAUSA',
  'EXTERNO',
  'AUSENCIA_PRESUMIDA',
  'AUSENTE',
  'ENCERRADO',
] as const;
export type Availability = (typeof AVAILABILITIES)[number];
export const AVAILABILITY_LABEL: Record<Availability, string> = {
  NAO_CONFIRMOU: 'Não confirmou chegada',
  DISPONIVEL: 'Presente e disponível',
  OCUPADO: 'Presente e ocupado',
  EM_PAUSA: 'Em pausa',
  EXTERNO: 'Em atividade externa',
  AUSENCIA_PRESUMIDA: 'Ausência presumida',
  AUSENTE: 'Ausência confirmada',
  ENCERRADO: 'Expediente encerrado',
};

/** Registros do gestor (cada um preserva o histórico original). */
export const ATTENDANCE_ACTIONS = [
  'CONFIRMAR_AUSENCIA',
  'AUSENCIA_JUSTIFICADA',
  'ATESTADO',
  'FOLGA',
  'FERIAS',
  'TRABALHO_EXTERNO',
  'SAIDA_ANTECIPADA',
  'CHEGADA_TARDIA',
  'ESQUECIMENTO',
  'CORRECAO',
] as const;
export type AttendanceAction = (typeof ATTENDANCE_ACTIONS)[number];
export const ATTENDANCE_ACTION_LABEL: Record<AttendanceAction, string> = {
  CONFIRMAR_AUSENCIA: 'Confirmar ausência',
  AUSENCIA_JUSTIFICADA: 'Ausência justificada',
  ATESTADO: 'Atestado informado (sem dados médicos)',
  FOLGA: 'Folga',
  FERIAS: 'Férias',
  TRABALHO_EXTERNO: 'Trabalho externo',
  SAIDA_ANTECIPADA: 'Saída antecipada',
  CHEGADA_TARDIA: 'Chegada tardia (informar horário)',
  ESQUECIMENTO: 'Esqueceu de confirmar a chegada',
  CORRECAO: 'Correção administrativa',
};

/** Itens que o gestor acompanha (impactos de ausência e pendências de encerramento). */
export const IMPACT_KINDS = [
  'TAREFA_DO_AUSENTE',
  'DEPENDENTE_AFETADA',
  'ANDAMENTO_PENDENTE',
] as const;
export type ImpactKind = (typeof IMPACT_KINDS)[number];
export const IMPACT_KIND_LABEL: Record<ImpactKind, string> = {
  TAREFA_DO_AUSENTE: 'Tarefa do funcionário ausente',
  DEPENDENTE_AFETADA: 'Tarefa dependente potencialmente bloqueada',
  ANDAMENTO_PENDENTE: 'Andamento não informado ao encerrar',
};

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** Classifica a chegada pela hora local (HH:MM) e pela configuração da empresa. */
export function classifyArrival(
  localTime: string,
  cfg: { workdayStart: string },
  presumedAbsent: boolean,
): { kind: ArrivalKind; lateMinutes: number } {
  const late = Math.max(0, toMin(localTime) - toMin(cfg.workdayStart));
  if (presumedAbsent) return { kind: 'APOS_AUSENCIA_PRESUMIDA', lateMinutes: late };
  return late > 0 ? { kind: 'ATRASO', lateMinutes: late } : { kind: 'NO_HORARIO', lateMinutes: 0 };
}

/** Pode confirmar chegada a partir do início da janela configurada. */
export const arrivalWindowOpen = (localTime: string, cfg: { arrivalWindowStart: string }) =>
  toMin(localTime) >= toMin(cfg.arrivalWindowStart);

/** Passou do limite para alerta de ausência? */
export const pastAbsenceLimit = (localTime: string, cfg: { arrivalAlertAt: string }) =>
  toMin(localTime) >= toMin(cfg.arrivalAlertAt);

/**
 * Disponibilidade operacional. Clicar em "Cheguei" não significa estar livre:
 * tarefa em execução → ocupado; tarefa pausada durante o dia (não por fim de
 * expediente) → em pausa.
 */
export function computeAvailability(i: {
  situation: AttendanceSituation | null;
  arrived: boolean;
  running: boolean;
  pausedSinceArrival: boolean;
}): Availability {
  switch (i.situation) {
    case 'ENCERRADO':
      return 'ENCERRADO';
    case 'TRABALHO_EXTERNO':
      return 'EXTERNO';
    case 'AUSENCIA_PRESUMIDA':
      return 'AUSENCIA_PRESUMIDA';
    case 'AUSENCIA_CONFIRMADA':
    case 'AUSENCIA_JUSTIFICADA':
    case 'ATESTADO':
    case 'FOLGA':
    case 'FERIAS':
      return 'AUSENTE';
    default:
      break;
  }
  if (!i.arrived) return 'NAO_CONFIRMOU';
  if (i.running) return 'OCUPADO';
  if (i.pausedSinceArrival) return 'EM_PAUSA';
  return 'DISPONIVEL';
}
