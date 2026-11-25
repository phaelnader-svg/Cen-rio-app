import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeForecastDto, OfficeWeekDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { runOfficeRound } from '../src/modules/game/office';
import {
  type Client,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  naEmpresa1,
  resetDatabase,
} from './helpers';

/**
 * Financeiro do Escritório (2026-11-25): caixa das próximas 4 semanas, lembrete do DAS (15 a 20) e
 * pacote do contador (1 a 5), e o mês × ano passado no relatório do Gerente.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

const send = (c: Client, url: string, body: unknown) =>
  c.req('POST', url, body, { 'idempotency-key': idemKey() });
const bill = (c: Client, description: string, amountCents: number, dueDate: string) =>
  send(c, '/api/v1/finance/payables', {
    beneficiary: description,
    category: 'OUTRAS',
    description,
    amountCents,
    dueDate,
  }).then((r) => expect(r.status, JSON.stringify(r.body)).toBe(201));
const roundAt = (iso: string) => {
  const at = new Date(iso);
  setClock(() => at);
  return naEmpresa1(() => runOfficeRound(app.ctx.prisma, { at }));
};

describe('Financeiro do Escritório', () => {
  it('mostra o caixa das 4 semanas com as contas de cada uma', async () => {
    const admin = await loginAdmin(app);
    expect((await send(admin, '/api/v1/office/hire', { roleKey: 'FINANCEIRO' })).status).toBe(201);
    // Quarta, 25/11/2026: semana de 23 a 29.
    setClock(() => new Date('2026-11-25T15:00:00Z'));
    await bill(admin, 'Aluguel', 150_000, '2026-12-05');
    await bill(admin, 'Energia', 40_000, '2026-11-20');
    const r = await admin.get('/api/v1/office/forecast-weeks');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = r.body as OfficeForecastDto;
    expect(f.weeks).toHaveLength(4);
    expect(f.weeks[0]!.from).toBe('2026-11-23');
    expect(f.overdueOutCents).toBe(40_000);
    expect(f.weeks[1]!.outCents).toBe(150_000);
    expect(f.weeks[1]!.outs[0]!.label).toBe('Aluguel');
  });

  it('lembra o DAS do dia 15 ao 20 (só sem conta de imposto no mês) e avisa o pacote do contador', async () => {
    const admin = await loginAdmin(app);
    expect((await send(admin, '/api/v1/office/hire', { roleKey: 'FINANCEIRO' })).status).toBe(201);
    await roundAt('2026-11-10T12:00:00Z');
    expect(await db().notification.count({ where: { kind: 'AGENTES_IMPOSTO' } })).toBe(0);
    await roundAt('2026-11-16T12:00:00Z');
    await roundAt('2026-11-17T12:00:00Z');
    const n = await db().notification.findMany({ where: { kind: 'AGENTES_IMPOSTO' } });
    expect(n.length).toBeGreaterThan(0);
    expect(new Set(n.map((x) => x.userId)).size).toBe(n.length);
    expect(n[0]!.body).toMatch(/DAS de novembro vence dia 20/);

    // Com a conta do DAS lançada em dezembro, não lembra.
    setClock(() => new Date('2026-12-01T12:00:00Z'));
    await bill(admin, 'DAS Simples Nacional', 30_000, '2026-12-20');
    await roundAt('2026-12-16T12:00:00Z');
    expect(
      await db().notification.count({
        where: { kind: 'AGENTES_IMPOSTO', dedupeKey: { startsWith: 'AGENTES_IMPOSTO:2026-12' } },
      }),
    ).toBe(0);

    // Dia 2: pacote de novembro.
    await roundAt('2026-12-02T12:00:00Z');
    const p = await db().notification.findFirst({ where: { kind: 'AGENTES_CONTADOR' } });
    expect(p?.body).toMatch(/^Pacote de novembro para o contador/);
  });

  it('o relatório traz o mês e a meta de passar o mesmo mês do ano passado', async () => {
    const admin = await loginAdmin(app);
    expect((await send(admin, '/api/v1/office/hire', { roleKey: 'GERENTE' })).status).toBe(201);
    const w = (await admin.get('/api/v1/office/week')).body as OfficeWeekDto;
    expect(typeof w.month.contractedCents).toBe('number');
    expect(w.month.lastYearMonthCents).toBeNull();
  });
});
