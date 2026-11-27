import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { resetPlatformConfigCache } from '../src/core/platform-config';
import { companyCopiesRound, purgeCompany } from '../src/modules/platform/company-copies';
import {
  Client,
  EMPRESA_NOVA,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  loginPlatform,
  rawDb,
  resetDatabase,
} from './helpers';
import { qualityKit } from './quality-helpers';

/**
 * Etapa 6 da lista de 53: recuperar os dados de uma empresa só (item 52) e limpeza automática
 * das empresas encerradas há 90 dias. Dados fictícios.
 */
let app: App;
let storageDir: string;
const k = qualityKit(() => app);
beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'cenario-copias-'));
  app = await createTestApp({ STORAGE_DIR: storageDir });
});
afterAll(async () => {
  await app.close();
  rmSync(storageDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDatabase();
  resetPlatformConfigCache();
  setClock();
  rmSync(join(storageDir, 'copias-empresas'), { recursive: true, force: true });
  rmSync(join(storageDir, 'arquivo-empresas'), { recursive: true, force: true });
});
afterEach(() => setClock());

const DAY = 86_400_000;

async function criarConta(email = 'dona@tapecaria.local') {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', {
    ...EMPRESA_NOVA,
    email,
    password: 'senha1234',
    passwordConfirm: 'senha1234',
  });
  expect(r.status).toBe(201);
  const user = await db().user.findUniqueOrThrow({ where: { email } });
  return { c, companyId: user.companyId };
}

function round() {
  return companyCopiesRound({
    owner: app.ctx.owner,
    system: app.ctx.system,
    storageDir,
    webUrl: 'http://localhost:3000',
    log: app.app.log,
  });
}

describe('Item 52: recuperar os dados de uma empresa só', () => {
  it('volta a empresa para a cópia, guarda o antes, não mexe na outra e mantém a senha de hoje', async () => {
    const s = await k.scenario();
    const outra = await criarConta();
    const painel = await loginPlatform(app);
    const admin = await loginAdmin(app);

    const copy = await painel.post('/api/v1/platform/companies/1/copies', {});
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    const auditBefore = await rawDb().auditLog.count({ where: { companyId: 1 } });

    // Depois da cópia: cliente novo, nome trocado, OS cancelada à força e algo na outra empresa.
    const novo = await admin.req(
      'POST',
      '/api/v1/customers',
      {
        kind: 'PF',
        name: 'Cliente Novo Depois',
        phone: '12988887777',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);
    const cust = await rawDb().customer.findFirstOrThrow({
      where: { companyId: 1, id: { not: novo.body.id } },
    });
    await rawDb().customer.update({ where: { id: cust.id }, data: { name: 'Nome Errado' } });
    await rawDb().serviceOrderItem.updateMany({
      where: { serviceOrderId: s.so.id },
      data: { fulfillmentStage: 'CANCELADA' },
    });
    const outroCliente = await outra.c.req(
      'POST',
      '/api/v1/customers',
      {
        kind: 'PF',
        name: 'Cliente da Outra',
        phone: '11977776666',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(outroCliente.status).toBe(201);
    // Senha trocada depois da cópia continua valendo.
    await rawDb()
      .$executeRaw`UPDATE users SET display_name = 'Gestor Novo Nome' WHERE company_id = 1 AND email = 'gestor@teste.local'`;

    const list = await painel.get('/api/v1/platform/companies/1/copies');
    expect(list.body.items).toHaveLength(1);
    const prev = await painel.get(`/api/v1/platform/companies/1/copies/${copy.body.id}`);
    expect(prev.status).toBe(200);
    const clientes = prev.body.changes.find((c: { table: string }) => c.table === 'customers');
    expect(clientes.now).toBe(clientes.copy + 1);

    const errado = await painel.post('/api/v1/platform/companies/1/recover', {
      copyId: copy.body.id,
      confirmName: 'Outra',
    });
    expect(errado.status).toBe(400);
    const name = (await rawDb().companySettings.findUniqueOrThrow({ where: { id: 1 } })).tradeName;
    const r = await painel.post('/api/v1/platform/companies/1/recover', {
      copyId: copy.body.id,
      confirmName: name,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.beforeCopyId).toMatch(/antes-de-recuperar$/);

    // A empresa voltou para a cópia.
    expect(await rawDb().customer.count({ where: { id: novo.body.id } })).toBe(0);
    expect((await rawDb().customer.findUniqueOrThrow({ where: { id: cust.id } })).name).toBe(
      cust.name,
    );
    const items = await rawDb().serviceOrderItem.findMany({ where: { serviceOrderId: s.so.id } });
    expect(items.every((i) => i.fulfillmentStage !== 'CANCELADA')).toBe(true);
    // A outra empresa não mudou.
    expect(await rawDb().customer.count({ where: { id: outroCliente.body.id } })).toBe(1);
    // Histórico não perde nada.
    expect(await rawDb().auditLog.count({ where: { companyId: 1 } })).toBeGreaterThanOrEqual(
      auditBefore,
    );
    // Todo mundo entra de novo, com a senha de hoje.
    expect((await admin.get('/api/v1/customers')).status).toBe(401);
    const again = await loginAdmin(app);
    expect((await again.get('/api/v1/customers')).status).toBe(200);
    expect(
      await rawDb().platformAuditLog.count({
        where: { action: 'platform.company_recovered', targetCompanyId: 1 },
      }),
    ).toBe(1);

    // Desfazer: a cópia de "antes" traz tudo de volta.
    const undo = await painel.post('/api/v1/platform/companies/1/recover', {
      copyId: r.body.beforeCopyId,
      confirmName: name,
    });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(await rawDb().customer.count({ where: { id: novo.body.id } })).toBe(1);
    expect((await rawDb().customer.findUniqueOrThrow({ where: { id: cust.id } })).name).toBe(
      'Nome Errado',
    );
  });

  it('a rodada diária guarda uma cópia por dia de cada empresa ativa', async () => {
    await criarConta();
    // 10 h em Brasília.
    setClock(() => new Date('2026-12-02T13:00:00Z'));
    const r1 = await round();
    expect(r1.copies).toBe(2);
    const r2 = await round();
    expect(r2.copies).toBe(0);
    setClock(() => new Date('2026-12-03T13:00:00Z'));
    expect((await round()).copies).toBe(2);
    expect(readdirSync(join(storageDir, 'copias-empresas', '1'))).toHaveLength(2);
  });
});

describe('Empresa encerrada há 90 dias: aviso e limpeza automática', () => {
  it('avisa 7 dias antes (uma vez), guarda as planilhas e apaga só ela', async () => {
    const painel = await loginPlatform(app);
    const { companyId } = await criarConta();
    const closed = await painel.post(`/api/v1/platform/companies/${companyId}/close`, {
      reason: 'Fechou a oficina',
      confirmName: EMPRESA_NOVA.companyName,
    });
    expect(closed.status).toBe(200);
    const purgeAt = Date.parse(closed.body.purgeAfter);

    // 5 dias antes: aviso para o dono da plataforma e para a empresa.
    setClock(() => new Date(purgeAt - 5 * DAY));
    expect((await round()).notices).toBe(1);
    expect((await round()).notices).toBe(0);
    const mails = await rawDb().outboundEmail.findMany({ where: { kind: 'empresa-sera-apagada' } });
    expect(mails.map((m) => m.to)).toContain('dona@tapecaria.local');
    expect(mails[0]!.subject).toMatch(/serão apagados em/);
    expect(await rawDb().companySettings.count({ where: { id: companyId } })).toBe(1);

    // Passou dos 90 dias: some de vez; as planilhas ficam no arquivo; a empresa 1 continua.
    setClock(() => new Date(purgeAt + 60_000));
    const r = await round();
    expect(r.purged).toBe(1);
    expect(await rawDb().companySettings.count({ where: { id: companyId } })).toBe(0);
    expect(await rawDb().user.count({ where: { companyId } })).toBe(0);
    expect(await rawDb().companySettings.count({ where: { id: 1 } })).toBe(1);
    const arch = await painel.get('/api/v1/platform/archives');
    expect(arch.body.items).toHaveLength(1);
    expect(arch.body.items[0].name).toMatch(new RegExp(`^empresa-${companyId}-tapecaria-teste-`));
    const zip = await painel.get(`/api/v1/platform/archives/${arch.body.items[0].name}`);
    expect(zip.status).toBe(200);
    expect(
      await rawDb().platformAuditLog.count({
        where: { action: 'platform.company_deleted', targetCompanyId: companyId },
      }),
    ).toBe(1);
    expect(existsSync(join(storageDir, 'copias-empresas', String(companyId)))).toBe(false);
  });

  it('antes dos 90 dias, ou reaberta, nada é apagado', async () => {
    const painel = await loginPlatform(app);
    const { companyId } = await criarConta();
    await painel.post(`/api/v1/platform/companies/${companyId}/close`, {
      reason: 'Teste',
      confirmName: EMPRESA_NOVA.companyName,
    });
    const d = { owner: app.ctx.owner, system: app.ctx.system, storageDir, webUrl: 'http://x' };
    expect(await purgeCompany(d, companyId)).toBe(false);
    await painel.post(`/api/v1/platform/companies/${companyId}/reopen`, {});
    setClock(() => new Date(Date.now() + 200 * DAY));
    expect(await purgeCompany(d, companyId)).toBe(false);
    expect(await rawDb().companySettings.count({ where: { id: companyId } })).toBe(1);
  });
});
