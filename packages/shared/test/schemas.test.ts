import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  companySettingsSchema,
  createEmployeeSchema,
  normalizePairingCode,
  pairDeviceSchema,
  passwordPolicySchema,
  pinSchema,
  resolvePermissions,
} from '../src';

describe('Permissões', () => {
  it('resolve a união de funções e concessões diretas, ignorando permissões desconhecidas', () => {
    const r = resolvePermissions(
      [['producao.acessar'], ['producao.acessar', 'inexistente']],
      ['auditoria.ver'],
    );
    expect(r).toEqual(['producao.acessar', 'auditoria.ver']);
  });

  it('a função Gestor contém todo o catálogo; funções de produção não acessam o painel', () => {
    const gestor = DEFAULT_ROLES.find((r) => r.key === 'gestor')!;
    expect([...gestor.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const r of DEFAULT_ROLES.filter((x) => x.key !== 'gestor')) {
      expect(r.permissions).toContain('producao.acessar');
      expect(r.permissions).not.toContain('painel.acessar');
    }
  });
});

describe('Validação de credenciais', () => {
  it('PIN: 6 dígitos, sem sequências ou repetições', () => {
    expect(pinSchema.safeParse('482915').success).toBe(true);
    for (const bad of ['123456', '000000', '12345', '1234567', 'abcdef', '654321']) {
      expect(pinSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('senha: mínimo 10 caracteres com letras e números', () => {
    expect(passwordPolicySchema.safeParse('SenhaForte1').success).toBe(true);
    expect(passwordPolicySchema.safeParse('curta1').success).toBe(false);
    expect(passwordPolicySchema.safeParse('somenteletras').success).toBe(false);
    expect(passwordPolicySchema.safeParse('1234567890').success).toBe(false);
  });

  it('código de vinculação aceita minúsculas e hífen, rejeita caracteres ambíguos', () => {
    expect(normalizePairingCode('abcd-2345')).toBe('ABCD2345');
    expect(pairDeviceSchema.safeParse({ code: 'abcd-2345' }).success).toBe(true);
    expect(pairDeviceSchema.safeParse({ code: 'ABCD-0O1I' }).success).toBe(false);
  });
});

describe('Cadastros', () => {
  const base = {
    fullName: 'Ricardo',
    displayName: 'Ricardo',
    jobTitle: 'Tapeceiro',
    color: '#2563EB',
    roleIds: ['5f1e1f7e-1c1a-4a8e-9a3e-1d2f3a4b5c6d'],
  };

  it('e-mail e senha do painel devem vir juntos', () => {
    expect(createEmployeeSchema.safeParse(base).success).toBe(true);
    expect(createEmployeeSchema.safeParse({ ...base, email: 'a@b.com' }).success).toBe(false);
    expect(
      createEmployeeSchema.safeParse({ ...base, email: 'a@b.com', password: 'SenhaForte1' })
        .success,
    ).toBe(true);
  });

  it('expediente: alerta após a chegada e fim após o alerta', () => {
    const company = {
      tradeName: 'Cenário Estofados',
      timezone: 'America/Sao_Paulo',
      workdayStart: '08:30',
      arrivalAlertAt: '09:30',
      workdayEnd: '18:00',
      workingDays: [1, 2, 3, 4, 5],
      planningWeekday: 5,
      measurementWeekday: 5,
      version: 1,
    };
    expect(companySettingsSchema.safeParse(company).success).toBe(true);
    expect(companySettingsSchema.safeParse({ ...company, arrivalAlertAt: '08:00' }).success).toBe(
      false,
    );
    expect(companySettingsSchema.safeParse({ ...company, workdayEnd: '09:00' }).success).toBe(
      false,
    );
    expect(companySettingsSchema.safeParse({ ...company, workdayStart: '8h30' }).success).toBe(
      false,
    );
  });
});
