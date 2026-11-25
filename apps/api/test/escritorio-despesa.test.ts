import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type ReceiptReading, setReceiptReader } from '../src/modules/game/office-receipt';
import { type Client, createTestApp, db, idemKey, resetDatabase } from './helpers';
import { qualityKit } from './quality-helpers';

/**
 * Despesa pela foto (Escritório, 2026-11-25): a IA lê o comprovante (aqui, resposta fixa), o
 * Financeiro deixa a despesa pronta e o dono aprova (ou o agente lança sozinho até o limite).
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});
afterEach(() => setReceiptReader(null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const reading = (r: Partial<ReceiptReading> = {}): ReceiptReading => ({
  ok: true,
  amountCents: 18_990,
  date: '2026-11-24',
  beneficiary: 'Posto Avenida',
  description: 'Gasolina da Fiorino',
  category: 'COMBUSTIVEL',
  paid: true,
  method: 'PIX',
  problem: null,
  ...r,
});

async function sendPhoto(c: Client): Promise<{ status: number; body: J }> {
  const boundary = '----comprovante';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nota.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/office/receipt',
    headers: {
      origin: 'http://localhost:3000',
      cookie: c.cookieHeader,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));

async function withFinance() {
  const s = await k.scenario();
  ok(await send(s.admin, 'POST', '/api/v1/office/hire', { roleKey: 'FINANCEIRO' }), 201);
  return s;
}

describe('Despesa pela foto', () => {
  it('sem o Financeiro contratado não lê', async () => {
    const s = await k.scenario();
    setReceiptReader(async () => reading());
    expect((await sendPhoto(s.admin)).status).toBe(409);
  });

  it('a foto vira um pedido; aprovar com o valor corrigido lança a despesa já paga', async () => {
    const s = await withFinance();
    setReceiptReader(async () => reading());
    const r = ok(await sendPhoto(s.admin), 201);
    expect(r.doneAlone).toBe(false);
    const p = (await overview(s.admin)).pending.find((x) => x.task === 'LANCAR_DESPESA')!;
    expect(p.title).toMatch(/Posto Avenida/);
    expect(p.title).toMatch(/189,90/);
    expect(p.payload.category).toBe('COMBUSTIVEL');
    // A foto fica guardada e abre para quem vê o financeiro.
    expect((await s.admin.get(String(p.payload.photoUrl))).status).toBe(200);

    const decided = ok(
      await send(s.admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, {
        decision: 'APROVAR',
        edits: { amountCents: 19_990 },
      }),
    );
    expect(decided.status).toBe('APROVADA');
    expect(decided.payload.edited).toBe(true);
    const e = await db().operationalExpense.findUniqueOrThrow({
      where: { id: String(decided.payload.expenseId) },
      include: { payable: true },
    });
    expect(e.amountCents).toBe(19_990);
    expect(e.category).toBe('COMBUSTIVEL');
    expect(e.payable?.beneficiary).toBe('Posto Avenida');
    expect(e.payable?.status).toBe('PAGO');
  });

  it('a pagar e categoria desconhecida: vai para "Outras" e a conta fica aberta', async () => {
    const s = await withFinance();
    setReceiptReader(async () => reading({ paid: false, category: 'INVENTADA' }));
    ok(await sendPhoto(s.admin), 201);
    const p = (await overview(s.admin)).pending.find((x) => x.task === 'LANCAR_DESPESA')!;
    expect(p.payload.category).toBe('OUTRAS');
    const d = ok(
      await send(s.admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    const e = await db().operationalExpense.findUniqueOrThrow({
      where: { id: String(d.payload.expenseId) },
      include: { payable: true },
    });
    expect(e.payable?.status).toBe('ABERTO');
  });

  it('foto ilegível é recusada; valor não lido exige o dono preencher', async () => {
    const s = await withFinance();
    setReceiptReader(async () => reading({ ok: false, problem: 'foto tremida' }));
    const bad = await sendPhoto(s.admin);
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toMatch(/foto tremida/);

    setReceiptReader(async () => reading({ amountCents: null }));
    ok(await sendPhoto(s.admin), 201);
    const p = (await overview(s.admin)).pending.find((x) => x.task === 'LANCAR_DESPESA')!;
    const r = await send(s.admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, {
      decision: 'APROVAR',
    });
    expect(r.status).toBe(400);
    expect(await db().operationalExpense.count()).toBe(0);
  });

  it('nível 3: até o limite o Financeiro lança sozinho; acima, pede', async () => {
    const s = await withFinance();
    const fin = (await overview(s.admin)).agents.find((a) => a.roleKey === 'FINANCEIRO')!;
    expect(fin.tasks.map((t) => t.key)).toContain('LANCAR_DESPESA');
    ok(
      await send(s.admin, 'PUT', '/api/v1/office/tasks', {
        agentId: fin.agentId,
        task: 'LANCAR_DESPESA',
        setting: { nivel: 3, limiteCents: 20_000 },
      }),
    );
    setReceiptReader(async () => reading());
    expect(ok(await sendPhoto(s.admin), 201).doneAlone).toBe(true);
    expect(await db().operationalExpense.count()).toBe(1);
    const done = (await overview(s.admin)).recent.find((x) => x.task === 'LANCAR_DESPESA')!;
    expect(done.decidedByAgent).toBe(true);

    setReceiptReader(async () => reading({ amountCents: 50_000 }));
    expect(ok(await sendPhoto(s.admin), 201).doneAlone).toBe(false);
    expect(await db().operationalExpense.count()).toBe(1);
  });
});
