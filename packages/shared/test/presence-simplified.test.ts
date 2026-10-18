import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_ACTIONS,
  HELP_KINDS,
  HELP_KIND_SKILL,
  PROLONGED_SUPPORT,
  VERSIONED_ACTIONS,
  attendanceActionSchema,
  classifyArrival,
  createLeaveSchema,
  leaveCode,
} from '../src';

/** Simplificação Fase 7 — regras puras de presença e apoio. */
describe('presença simplificada', () => {
  it('feriado/dia sem expediente: chegada nunca é atraso', () => {
    expect(classifyArrival('10:15', { workdayStart: '08:30', workingDay: false }, false)).toEqual({
      kind: 'NO_HORARIO',
      lateMinutes: 0,
    });
    expect(classifyArrival('08:45', { workdayStart: '08:30', workingDay: true }, false)).toEqual({
      kind: 'ATRASO',
      lateMinutes: 15,
    });
  });

  it('saída esquecida exige horário e versão; desfazer exige versão', () => {
    const base = { employeeId: '00000000-0000-4000-8000-000000000001', date: '2026-10-16' };
    expect(
      attendanceActionSchema.safeParse({
        ...base,
        action: 'REGISTRAR_SAIDA',
        reason: 'Saiu',
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      attendanceActionSchema.safeParse({ ...base, action: 'ANULAR_SAIDA', reason: 'Engano' })
        .success,
    ).toBe(false);
    expect(
      attendanceActionSchema.safeParse({
        ...base,
        action: 'REGISTRAR_SAIDA',
        departureTime: '17:30',
        reason: 'Saiu',
        version: 2,
      }).success,
    ).toBe(true);
    expect(VERSIONED_ACTIONS.every((a) => ATTENDANCE_ACTIONS.includes(a))).toBe(true);
  });

  it('folga/férias por intervalo: fim nunca antes do início; código FL', () => {
    const l = {
      employeeId: '00000000-0000-4000-8000-000000000001',
      kind: 'FERIAS',
      reason: 'Férias',
    };
    expect(
      createLeaveSchema.safeParse({ ...l, startDate: '2026-11-10', endDate: '2026-11-01' }).success,
    ).toBe(false);
    expect(
      createLeaveSchema.safeParse({ ...l, startDate: '2026-11-01', endDate: '2026-11-10' }).success,
    ).toBe(true);
    expect(leaveCode(7)).toBe('FL-00007');
  });

  it('apoio prolongado fica fora do pedido de ajuda rápida', () => {
    expect((HELP_KINDS as readonly string[]).includes(PROLONGED_SUPPORT)).toBe(false);
    expect(HELP_KIND_SKILL[PROLONGED_SUPPORT]).toBe('APOIO_GERAL');
  });
});
