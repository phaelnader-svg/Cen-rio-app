import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Etapa 5 da lista de 53 (Firma Viva): teste de 7 dias (34), foto no crachá (35), fotos reais
 * da peça (36), quadro da semana (38) e cliente esperando na recepção (39). Dados fictícios.
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => resetDatabase());
afterEach(() => setClock());

const DAY = 86_400_000;

describe('Item 34: experimentar o Firma Viva por 7 dias', () => {
  it('plano de R$ 399: começa uma vez, libera o jogo por 7 dias e depois oferece o plano', async () => {
    await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao' } });
    const admin = await loginAdmin(app);
    const t0 = await admin.get('/api/v1/firma-viva/teste');
    expect(t0.status).toBe(200);
    expect(t0.body).toMatchObject({ status: 'DISPONIVEL', upgradeMonthlyCents: 59_900 });
    expect(((await admin.get('/api/v1/modules')).body as J).ambiente_interativo).toBe(false);

    const go = await admin.req(
      'POST',
      '/api/v1/firma-viva/teste',
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(go.status, JSON.stringify(go.body)).toBe(200);
    expect(go.body).toMatchObject({ status: 'ATIVO', daysLeft: 7 });
    const endsAt = (go.body as J).endsAt as string;
    expect(((await admin.get('/api/v1/modules')).body as J).ambiente_interativo).toBe(true);
    const log = await db().auditLog.findFirst({ where: { action: 'company.game_trial_started' } });
    expect(log?.summary).toMatch(/7 dias do Firma Viva/);

    // Clicar de novo no meio do teste não estende.
    const base = Date.now();
    setClock(() => new Date(base + 3 * DAY));
    const again = await admin.req(
      'POST',
      '/api/v1/firma-viva/teste',
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(again.body).toMatchObject({ status: 'ATIVO', endsAt, daysLeft: 4 });

    // Passados os 7 dias: jogo desligado e a oferta do plano.
    setClock(() => new Date(base + 7 * DAY + 60_000));
    expect((await admin.get('/api/v1/firma-viva/teste')).body).toMatchObject({
      status: 'ENCERRADO',
    });
    expect(((await admin.get('/api/v1/modules')).body as J).ambiente_interativo).toBe(false);
    const late = await admin.req(
      'POST',
      '/api/v1/firma-viva/teste',
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(late.status).toBe(422);
    expect(JSON.stringify(late.body)).toMatch(/já foi usado/);
  });

  it('plano com o Firma Viva: já incluído, nada para testar', async () => {
    await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
    const admin = await loginAdmin(app);
    expect((await admin.get('/api/v1/firma-viva/teste')).body).toMatchObject({
      status: 'INCLUIDO',
      whatsappUrl: null,
    });
    const r = await admin.req(
      'POST',
      '/api/v1/firma-viva/teste',
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(r.body).toMatchObject({ status: 'INCLUIDO' });
    expect((await db().companySettings.findUnique({ where: { id: 1 } }))?.gameTrialEndsAt).toBe(
      null,
    );
  });
});

describe('Itens 35, 36, 38 e 39: o que o jogo lê do Cenário', () => {
  beforeEach(async () => {
    await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
  });

  it('pessoas do jogo levam a foto de Funcionários (miniatura) para o crachá', async () => {
    const admin = await loginAdmin(app);
    const emp = await db().employee.findFirstOrThrow({ where: { active: true } });
    const file = await db().storedFile.create({
      data: {
        purpose: 'employee-photo',
        storageKey: `employee-photo/teste-${emp.id}`,
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        originalName: 'foto.jpg',
        sha256: 'x'.repeat(64),
      } as J,
    });
    await db().employee.update({ where: { id: emp.id }, data: { photoFileId: file.id } });
    const r = await admin.get('/api/v1/game/people');
    expect(r.status).toBe(200);
    const me = (r.body as J[]).find((p) => p.employeeId === emp.id);
    expect(me.photoUrl).toBe(`/api/files/${file.id}/miniatura`);
    const other = (r.body as J[]).find((p) => p.employeeId !== emp.id);
    if (other) expect(other.photoUrl).toBeNull();
  });

  it('quadro da semana e cliente esperando: peça pronta há 3 dias aparece; entregue, some', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const admin = await loginAdmin(app);
    const w0 = (await admin.get('/api/v1/game/wall')).body as J;
    expect(w0.deliveries).toEqual({ week: 0, last: 0 });
    expect(w0.revenueCents).toEqual({ week: 0, last: 0 });
    expect(w0.waiting).toEqual([]); // pronta hoje ainda não é espera

    // Dinheiro que entrou hoje conta na semana.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      new Date(Date.now() + 3 * DAY),
    );
    await db().manualRevenue.create({
      data: {
        description: 'Reforma de cadeira',
        category: 'SERVICO',
        amountCents: 45_000,
        receivedAt: new Date(`${today}T00:00:00Z`),
        method: 'PIX',
      } as J,
    });
    const base = Date.now();
    setClock(() => new Date(base + 3 * DAY));
    const w = (await admin.get('/api/v1/game/wall')).body as J;
    expect(w.revenueCents.week).toBe(45_000);
    expect(w.waiting).toHaveLength(1);
    expect(w.waiting[0]).toMatchObject({ serviceOrderId: s.so.id, days: 3 });
    expect(w.waiting[0].items[0].id).toBe(s.sofa.id);

    await db().serviceOrderItem.update({
      where: { id: s.sofa.id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    expect(((await admin.get('/api/v1/game/wall')).body as J).waiting).toEqual([]);
  });

  it('prazo da semana que passou sem entregar conta como atraso; sem financeiro, sem dinheiro', async () => {
    const s = await k.scenario();
    const admin = await loginAdmin(app);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      new Date(),
    );
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    // Prazo na segunda passada (mesmo pedaço da semana passada): atraso de "semana passada".
    const lastMonday = new Date(Date.parse(`${today}T00:00:00Z`) - (weekday + 7) * DAY);
    await db().serviceOrder.update({ where: { id: s.so.id }, data: { promisedDate: lastMonday } });
    const w = (await admin.get('/api/v1/game/wall')).body as J;
    expect(w.late).toEqual({ week: 0, last: 1 });
  });

  it('fotos da peça: as do tablet (etapa) entram com a etapa; outra peça não', async () => {
    const s = await k.scenario();
    const admin = await loginAdmin(app);
    const file = await db().storedFile.create({
      data: {
        purpose: 'attachment',
        storageKey: 'attachment/teste-1',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        originalName: 'etapa.jpg',
        sha256: 'y'.repeat(64),
      } as J,
    });
    await db().attachment.create({
      data: { entityType: 'PRODUCTION_TASK', entityId: s.sofaTask.id, fileId: file.id } as J,
    });
    const r = await admin.get(`/api/v1/game/pieces/${s.sofa.id}/photos`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toHaveLength(1);
    expect((r.body as J[])[0]).toMatchObject({
      url: `/api/files/${file.id}`,
      source: expect.stringMatching(/^Tablet: /),
    });
    const other = await admin.get(`/api/v1/game/pieces/${s.poltronas.id}/photos`);
    expect(other.body).toHaveLength(0);
  });
});
