import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import {
  Client,
  WsClient,
  createTestApp,
  db,
  employeeByName,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
  sleep,
} from './helpers';

let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  // Após o TRUNCATE a sequência recomeça: alinha o fluxo de eventos com o banco limpo.
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

async function adminAndTablet() {
  const admin = await loginAdmin(app);
  const t = await setupTablet(app, admin, { name: 'Tablet R', employee: 'Ricardo', pin: '482915' });
  return { admin, ...t };
}

describe('Sincronização em tempo real entre sessões', () => {
  it('WebSocket exige sessão válida e origem permitida', async () => {
    await expect(WsClient.connect(app, new Client(app))).rejects.toThrow(/401/);
    const admin = await loginAdmin(app);
    const evil = new Client(app, 'https://malicioso.example');
    evil.cookies = admin.cookies;
    await expect(WsClient.connect(app, evil)).rejects.toThrow(/403/);
  });

  it('alteração feita no painel chega ao tablet e a outro painel conectados', async () => {
    const { admin, tablet } = await adminAndTablet();
    const admin2 = await loginAdmin(app);
    const wTablet = track(await WsClient.connect(app, tablet));
    const wAdmin2 = track(await WsClient.connect(app, admin2));

    const joao = await employeeByName('João');
    const roles = await db().role.findUniqueOrThrow({ where: { key: 'ajudante' } });
    const upd = await admin.put(`/api/employees/${joao.id}`, {
      fullName: 'João',
      displayName: 'João Pedro',
      jobTitle: joao.jobTitle,
      color: '#7C3AED',
      roleIds: [roles.id],
      extraPermissions: [],
      version: joao.version,
    });
    expect(upd.status).toBe(200);

    for (const w of [wTablet, wAdmin2]) {
      const msg = await w.waitFor((m) => m.kind === 'event' && m.event.type === 'employee.updated');
      expect(msg.event.payload.displayName).toBe('João Pedro');
      expect(msg.event.payload).not.toHaveProperty('pinHash');
    }
  });

  it('sinal enviado por um tablet aparece no painel (e vice-versa)', async () => {
    const { admin, tablet } = await adminAndTablet();
    const wAdmin = track(await WsClient.connect(app, admin));
    const wTablet = track(await WsClient.connect(app, tablet));
    await tablet.post(
      '/api/sync/signal',
      { message: 'do tablet' },
      { 'idempotency-key': idemKey() },
    );
    await admin.post(
      '/api/sync/signal',
      { message: 'do painel' },
      { 'idempotency-key': idemKey() },
    );
    for (const w of [wAdmin, wTablet]) {
      await w.waitFor((m) => m.event?.payload?.message === 'do tablet');
      await w.waitFor((m) => m.event?.payload?.message === 'do painel');
    }
    // ordem global preservada
    const seqs = wAdmin.events('sync.signal').map((e) => BigInt(e.seq));
    expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
  });

  it('eventos respeitam a audiência: tablet não recebe eventos administrativos', async () => {
    const { admin, tablet } = await adminAndTablet();
    const wAdmin = track(await WsClient.connect(app, admin));
    const wTablet = track(await WsClient.connect(app, tablet));
    await admin.post('/api/devices', { name: 'Outro tablet' }, { 'idempotency-key': idemKey() });
    await wAdmin.waitFor((m) => m.event?.type === 'device.registered');
    await admin.post('/api/sync/signal', { message: 'marcador' }, { 'idempotency-key': idemKey() });
    await wTablet.waitFor((m) => m.event?.payload?.message === 'marcador');
    expect(wTablet.events('device.registered')).toHaveLength(0);
  });

  it('reconexão: eventos perdidos durante a queda são reenviados (reconciliação)', async () => {
    const { admin, tablet } = await adminAndTablet();
    let w = track(await WsClient.connect(app, tablet));
    await tablet.post('/api/sync/signal', { message: 'antes' }, { 'idempotency-key': idemKey() });
    const before = await w.waitFor((m) => m.event?.payload?.message === 'antes');
    const lastSeq = before.event.seq as string;

    // queda de conexão
    await w.close();
    for (const message of ['durante 1', 'durante 2', 'durante 3']) {
      await admin.post('/api/sync/signal', { message }, { 'idempotency-key': idemKey() });
    }

    // reconecta informando o último evento visto
    w = track(await WsClient.connect(app, tablet, lastSeq));
    const done = await w.waitFor((m) => m.kind === 'replay.done');
    expect(done.count).toBe(3);
    expect(w.events('sync.signal').map((e) => e.payload.message)).toEqual([
      'durante 1',
      'durante 2',
      'durante 3',
    ]);

    // após o reenvio, eventos ao vivo continuam chegando, sem duplicação
    await admin.post('/api/sync/signal', { message: 'depois' }, { 'idempotency-key': idemKey() });
    await w.waitFor((m) => m.event?.payload?.message === 'depois');
    const msgs = w.events('sync.signal').map((e) => e.payload.message);
    expect(msgs).toEqual(['durante 1', 'durante 2', 'durante 3', 'depois']);
  });

  it('reconciliação também está disponível por HTTP (/api/sync/events)', async () => {
    const { admin, tablet } = await adminAndTablet();
    const head = (await tablet.get('/api/sync/status')).body.headSeq;
    await admin.post('/api/sync/signal', { message: 'via http' }, { 'idempotency-key': idemKey() });
    const r = await tablet.get(`/api/sync/events?since=${head}`);
    expect(r.status).toBe(200);
    expect(
      r.body.events.map((e: { payload: { message?: string } }) => e.payload.message),
    ).toContain('via http');
    expect(r.body.events.every((e: { type: string }) => !e.type.startsWith('device.'))).toBe(true);
  });

  it('intervalo grande demais exige ressincronização completa', async () => {
    const { tablet } = await adminAndTablet();
    const w0 = track(await WsClient.connect(app, tablet));
    await w0.close();
    const values = Array.from(
      { length: 520 },
      (_, i) => `('sync.signal','sync','x','{"message":"m${i}"}'::jsonb,'all')`,
    );
    await db().$executeRawUnsafe(
      `INSERT INTO domain_events (id, type, aggregate_type, aggregate_id, payload, audience)
       SELECT gen_random_uuid(), v.* FROM (VALUES ${values.join(',')}) AS v(type, aggregate_type, aggregate_id, payload, audience)`,
    );
    await sleep(400);
    const w = track(await WsClient.connect(app, tablet, '1'));
    const msg = await w.waitFor((m) => m.kind === 'resync.required');
    expect(msg.reason).toBe('gap_too_large');
  });

  it('cursor desconhecido (ex.: banco restaurado de backup) exige ressincronização', async () => {
    const { tablet } = await adminAndTablet();
    const w = track(await WsClient.connect(app, tablet, '999999999'));
    const msg = await w.waitFor((m) => m.kind === 'resync.required');
    expect(msg.reason).toBe('unknown_cursor');
  });

  it('revogação remota encerra imediatamente a conexão de tempo real do tablet', async () => {
    const { admin, me, tablet } = await adminAndTablet();
    const w = track(await WsClient.connect(app, tablet));
    await admin.post(`/api/sessions/${me.session.id}/revoke`);
    const ended = await w.waitFor((m) => m.kind === 'session.ended');
    expect(ended.reason).toBe('revoked');
    for (let i = 0; i < 40 && !w.closed; i++) await sleep(25);
    expect(w.closed?.code).toBe(4401);
  });

  it('presença: conexão do tablet gera evento de dispositivo conectado para o painel', async () => {
    const { admin, tablet, device } = await adminAndTablet();
    const wAdmin = track(await WsClient.connect(app, admin));
    track(await WsClient.connect(app, tablet));
    const msg = await wAdmin.waitFor(
      (m) => m.event?.type === 'device.connection_changed' && m.event.payload.online === true,
    );
    expect(msg.event.aggregateId).toBe(device.id);
    const list = await admin.get('/api/devices');
    expect(list.body.find((d: { id: string }) => d.id === device.id).online).toBe(true);
  });
});
