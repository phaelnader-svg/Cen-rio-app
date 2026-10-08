import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createCustomer, createOrder, createPickup, receiptBody } from './commercial-helpers';
import {
  type Client,
  WsClient,
  createTestApp,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
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
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(client: Client, entityType: string, entityId: string) {
  const boundary = '----foto';
  const part = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const payload = Buffer.concat([
    Buffer.from(
      part('entityType', entityType) +
        part('entityId', entityId) +
        part('caption', 'Foto de teste'),
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/attachments',
    headers: {
      origin: 'http://localhost:3000',
      cookie: client.cookieHeader,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('Sincronização do fluxo comercial', () => {
  it('pedido, retirada, recebimento e OS chegam em tempo real a outra sessão do painel', async () => {
    const admin = await loginAdmin(app);
    const other = await loginAdmin(app);
    const w = track(await WsClient.connect(app, other));
    const customer = await createCustomer(admin);
    await w.waitFor((m) => m.event?.type === 'customer.created');
    const order = await createOrder(admin, customer);
    const created = await w.waitFor((m) => m.event?.type === 'order.created');
    expect(created.event.payload).toEqual({
      id: order.id,
      code: order.code,
      status: 'AGUARDANDO_RETIRADA',
      version: 1,
    });
    // Eventos não carregam valores nem dados pessoais.
    expect(JSON.stringify(w.events())).not.toMatch(/350000|11900000001|Rua Exemplo/);

    const pickup = await createPickup(admin, order);
    await w.waitFor(
      (m) => m.event?.type === 'pickup.created' && m.event.payload.status === 'AGENDADA',
    );
    await admin.post(
      '/api/v1/receipts',
      receiptBody(
        order.id,
        order.items.map((i: { id: string; quantity: number }) => ({
          orderItemId: i.id,
          quantity: i.quantity,
        })),
        pickup.id,
      ),
      { 'idempotency-key': idemKey() },
    );
    const receipt = await w.waitFor((m) => m.event?.type === 'receipt.registered');
    expect(receipt.event.payload.orderStatus).toBe('RECEBIDO');
    await w.waitFor(
      (m) =>
        m.event?.type === 'pickup.status_changed' &&
        m.event.payload.status === 'RECEBIDA_NA_OFICINA',
    );
    await admin.post(
      '/api/v1/service-orders',
      {
        orderId: order.id,
        items: [
          {
            orderItemId: order.items[0].id,
            quantity: 1,
            description: 'Sofá',
            serviceType: 'REPARO',
          },
        ],
      },
      { 'idempotency-key': idemKey() },
    );
    await w.waitFor((m) => m.event?.type === 'service_order.created');
  });

  it('tablet sem permissões comerciais não recebe esses eventos', async () => {
    const admin = await loginAdmin(app);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet R',
      employee: 'Ricardo',
      pin: '482915',
    });
    const w = track(await WsClient.connect(app, tablet));
    await createOrder(admin, await createCustomer(admin));
    await admin.post('/api/sync/signal', { message: 'marcador' }, { 'idempotency-key': idemKey() });
    await w.waitFor((m) => m.event?.payload?.message === 'marcador');
    expect(w.events().filter((e) => /^(customer|order|pickup)\./.test(e.type))).toHaveLength(0);
  });

  it('reconexão: alterações de retirada feitas durante a queda são reenviadas em ordem', async () => {
    const admin = await loginAdmin(app);
    const other = await loginAdmin(app);
    const order = await createOrder(admin, await createCustomer(admin));
    const pickup = await createPickup(admin, order);
    let w = track(await WsClient.connect(app, other));
    await admin.post('/api/sync/signal', { message: 'antes' }, { 'idempotency-key': idemKey() });
    const last = (await w.waitFor((m) => m.event?.payload?.message === 'antes')).event
      .seq as string;
    await w.close();

    const exec = await admin.post(`/api/v1/pickups/${pickup.id}/transition`, {
      toStatus: 'EM_EXECUCAO',
      version: pickup.version,
    });
    await admin.post(`/api/v1/pickups/${pickup.id}/transition`, {
      toStatus: 'RETIRADA_REALIZADA',
      version: exec.body.version,
    });

    w = track(await WsClient.connect(app, other, last));
    const done = await w.waitFor((m) => m.kind === 'replay.done');
    expect(done.count).toBeGreaterThanOrEqual(2);
    const statuses = w.events('pickup.status_changed').map((e) => e.payload.status);
    expect(statuses).toEqual(['EM_EXECUCAO', 'RETIRADA_REALIZADA']);
  });
});

describe('Fotografias dos registros', () => {
  it('anexa foto ao pedido; leitura e envio respeitam permissões', async () => {
    const admin = await loginAdmin(app);
    const order = await createOrder(admin, await createCustomer(admin));
    const up = await upload(admin, 'COMMERCIAL_ORDER', order.id);
    expect(up.status).toBe(201);
    const list = await admin.get(
      `/api/v1/attachments?entityType=COMMERCIAL_ORDER&entityId=${order.id}`,
    );
    expect(list.body).toHaveLength(1);
    expect(list.body[0].caption).toBe('Foto de teste');
    const file = await app.app.inject({
      method: 'GET',
      url: up.body.url,
      headers: { cookie: admin.cookieHeader },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');

    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet R',
      employee: 'Ricardo',
      pin: '482915',
    });
    const denied = await app.app.inject({
      method: 'GET',
      url: up.body.url,
      headers: { cookie: tablet.cookieHeader },
    });
    expect(denied.statusCode).toBe(403);
    expect((await upload(tablet, 'COMMERCIAL_ORDER', order.id)).status).toBe(403);
    expect(
      (await tablet.get(`/api/v1/attachments?entityType=COMMERCIAL_ORDER&entityId=${order.id}`))
        .status,
    ).toBe(403);

    expect((await admin.del(`/api/v1/attachments/${up.body.id}`)).status).toBe(204);
    const gone = await app.app.inject({
      method: 'GET',
      url: up.body.url,
      headers: { cookie: admin.cookieHeader },
    });
    expect(gone.statusCode).toBe(404);
  });
});
