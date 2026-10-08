import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { WsClient, createTestApp, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  createMeasurement,
  fabric,
  fillAndSubmit,
  nextTuesday,
  openServiceOrder,
  tapeceiroTablet,
} from './measurement-helpers';

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
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Medições em tempo real', () => {
  it('atribuição chega ao tablet do Ricardo; envio chega ao painel; Márcio não recebe', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const marcio = await tapeceiroTablet(app, admin, 'Márcio', '736152');
    const wGestor = track(await WsClient.connect(app, admin));
    const wRicardo = track(await WsClient.connect(app, ricardo.tablet));
    const wMarcio = track(await WsClient.connect(app, marcio.tablet));

    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: ricardo.userId,
        dueDate: nextTuesday(),
        reason: 'Urgente',
      })
    ).body;
    const assigned = await wRicardo.waitFor((x) => x.event?.type === 'measurement.assigned');
    expect(assigned.event.payload.id).toBe(m.id);

    await fillAndSubmit(ricardo.tablet, m, { items: [fabric()] });
    await wGestor.waitFor((x) => x.event?.type === 'measurement.started');
    await wGestor.waitFor((x) => x.event?.type === 'measurement.completed');
    const submitted = await wGestor.waitFor((x) => x.event?.type === 'material_request.submitted');
    expect(submitted.event.payload.measurementId).toBe(m.id);

    await admin.post('/api/sync/signal', { message: 'marcador' }, { 'idempotency-key': idemKey() });
    await wMarcio.waitFor((x) => x.event?.payload?.message === 'marcador');
    expect(
      wMarcio
        .events()
        .filter((e) => e.type.startsWith('measurement.') || e.type.startsWith('material_request.')),
    ).toHaveLength(0);
  });

  it('reconexão: devolução feita enquanto o tablet estava sem internet é recuperada', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: ricardo.userId,
        dueDate: nextTuesday(),
        reason: 'Urgente',
      })
    ).body;
    let w = track(await WsClient.connect(app, ricardo.tablet));
    const sub = (await fillAndSubmit(ricardo.tablet, m, { items: [fabric()] })).body;
    const last = (await w.waitFor((x) => x.event?.type === 'material_request.submitted')).event
      .seq as string;
    await w.close(); // perda de internet

    await admin.post(`/api/v1/measurements/${m.id}/request/return`, {
      reason: 'Conferir metragem',
      version: sub.request.version,
    });

    w = track(await WsClient.connect(app, ricardo.tablet, last));
    await w.waitFor((x) => x.kind === 'replay.done');
    const returned = w.events('material_request.returned');
    expect(returned).toHaveLength(1);
    expect(returned[0].payload.requestStatus).toBe('DEVOLVIDA');
  });

  it('executor vê as fotos da OS da sua medição, e só dela', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Com foto');
    const other = await openServiceOrder(admin, 'Sem acesso');
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const upload = async (entityId: string) => {
      const boundary = '----x';
      const part = (n: string, v: string) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
      const res = await app.app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        headers: {
          origin: 'http://localhost:3000',
          cookie: admin.cookieHeader,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(part('entityType', 'SERVICE_ORDER') + part('entityId', entityId)),
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          PNG,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      return JSON.parse(res.body).url as string;
    };
    const mine = await upload(so.id);
    const notMine = await upload(other.id);
    const get = (url: string) =>
      app.app.inject({ method: 'GET', url, headers: { cookie: ricardo.tablet.cookieHeader } });
    expect((await get(mine)).statusCode).toBe(403);
    await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'EXTRAORDINARIA',
      assigneeUserId: ricardo.userId,
      dueDate: nextTuesday(),
      reason: 'x',
    });
    expect((await get(mine)).statusCode).toBe(200);
    expect((await get(notMine)).statusCode).toBe(403);
    expect(
      (await ricardo.tablet.get(`/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${so.id}`))
        .status,
    ).toBe(200);
    expect(
      (
        await ricardo.tablet.get(
          `/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${other.id}`,
        )
      ).status,
    ).toBe(403);
  });
});
