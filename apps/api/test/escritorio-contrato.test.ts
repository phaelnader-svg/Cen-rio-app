import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CustomerDto, OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder } from './commercial-helpers';

/**
 * Contrato do serviço fechado (Orçamentos do Escritório, 2026-11-25): o pedido com valor
 * combinado e sem contrato vira a proposta de mandar o contrato; faltando dado, diz o quê e não
 * manda nada; completo, prepara o contrato e a mensagem leva o link público.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock(() => new Date('2026-11-25T15:00:00Z'));
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));
const round = (c: Client) => send(c, 'POST', '/api/v1/office/round', {}).then((r) => ok(r));

describe('Contrato do serviço fechado', () => {
  it('diz o que falta, não manda pela metade e, completo, manda o link do contrato', async () => {
    const admin = await loginAdmin(app);
    ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'ORCAMENTOS' }), 201);
    const ana = (await createCustomer(admin, {
      name: 'Ana Souza',
      phone: '(12) 99111-0001',
    })) as CustomerDto & { addresses: { id: string }[] };
    const order = await createOrder(admin, ana);

    await round(admin);
    const p = (await overview(admin)).pending.find((x) => x.task === 'ENVIAR_CONTRATO')!;
    expect(p.title).toMatch(/Mandar o contrato de PED-\d+ para Ana Souza/);
    expect(p.detail).toMatch(/\{link\}/);
    const missing = p.payload.missing as string[];
    expect(missing).toContain('CPF/CNPJ do cliente');
    expect(missing).toContain('prazo prometido');
    // O e-mail só a assinatura digital usa: não trava o contrato para ler.
    expect(missing.join()).not.toMatch(/e-mail/);

    const bad = await send(admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, {
      decision: 'APROVAR',
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toMatch(/CPF\/CNPJ do cliente/);
    expect(await db().contract.count()).toBe(0);

    // Completa o cadastro e aprova de novo.
    await db().customer.update({ where: { id: ana.id }, data: { document: '12345678909' } });
    await db().companySettings.update({
      where: { id: 1 },
      data: { document: '12345678000190', address: 'Rua da Oficina, 10, Jacareí/SP' },
    });
    await db().commercialOrder.update({
      where: { id: order.id },
      data: { promisedDate: new Date('2026-12-15T00:00:00Z') },
    });
    const d = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    const msg = decodeURIComponent(String(d.payload.href));
    expect(msg).toMatch(/\/contrato\/[0-9a-f-]+\?t=[0-9a-f]{24}/);
    expect(msg).not.toMatch(/\{link\}/);
    const c = await db().contract.findUniqueOrThrow({
      where: { id: String(d.payload.contractId) },
    });
    expect(c.status).toBe('RASCUNHO');
    expect(c.body).toMatch(/CPF\/CNPJ 123\.456\.789-09/);
    expect(c.body).toMatch(/e-mail não informado/);

    // O cliente abre pelo link (sem login); link adulterado não abre.
    const link = msg.match(/\/contrato\/([0-9a-f-]+)\?t=([0-9a-f]{24})/)!;
    const anon = new Client(app);
    const pub = ok(await anon.get(`/api/public/contrato/${link[1]}?t=${link[2]}`));
    expect(pub.body).toMatch(/CONTRATO DE PRESTAÇÃO/);
    expect(pub.code).toMatch(/^PED-/);
    const pdf = await anon.get(pub.pdfUrl);
    expect(pdf.status).toBe(200);
    expect(String(pdf.headers['content-type'])).toMatch(/application\/pdf/);
    const forged = await anon.get(`/api/public/contrato/${link[1]}?t=${'0'.repeat(24)}`);
    expect(forged.status).toBe(404);

    // Com contrato, a rodada não propõe de novo.
    await round(admin);
    expect(
      (await overview(admin)).pending.filter((x) => x.task === 'ENVIAR_CONTRATO'),
    ).toHaveLength(0);
  });
});
