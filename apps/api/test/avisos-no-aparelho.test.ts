import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { notify } from '../src/modules/notifications/notify';
import {
  pushSender,
  resetPushKeyCache,
  type PushMessage,
  type PushTarget,
} from '../src/modules/push/push';
import { allowedPushEndpoint } from '../src/modules/push/routes';
import {
  Client,
  createTestApp,
  db,
  loginAdmin,
  naEmpresa1,
  resetDatabase,
  setupTablet,
} from './helpers';

/**
 * App instalado (2026-11-25): o aparelho do funcionário aceita avisos e recebe no celular/tablet
 * o mesmo aviso da caixa, mesmo com o app fechado. Nenhum passo manual: as chaves nascem sozinhas.
 */

let app: App;
const sent: { target: PushTarget; message: PushMessage }[] = [];
let failWith: number | null = null;
const original = pushSender.send;

beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
  pushSender.send = async (target, message) => {
    if (failWith) throw Object.assign(new Error('falhou'), { statusCode: failWith });
    sent.push({ target, message });
  };
});
afterAll(async () => {
  pushSender.send = original;
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  resetPushKeyCache();
  sent.length = 0;
  failWith = null;
});

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

async function avisar(userId: string, body: string) {
  await naEmpresa1(() =>
    app.ctx.prisma.$transaction((tx) =>
      notify(tx, { userId: null, requestId: null } as never, [
        { userId, kind: 'TAREFA_ATRIBUIDA', dedupeKey: `teste:${body}`, body },
      ]),
    ),
  );
  await app.ctx.processor.kick();
}

describe('Avisos no aparelho', () => {
  it('chave criada sozinha; aparelho aceita avisos e recebe o aviso do funcionário', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee, device } = await setupTablet(app, admin, {
      name: 'Celular Ricardo',
      employee: 'Ricardo',
      pin: '246813',
    });

    const key = await tablet.get('/api/tablet/push');
    expect(key.status).toBe(200);
    expect(key.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // A mesma chave para todo mundo (uma linha só, criada uma vez).
    expect((await tablet.get('/api/tablet/push')).body.publicKey).toBe(key.body.publicKey);
    expect(await db().pushKey.count()).toBe(1);

    expect((await tablet.put('/api/tablet/push', SUB)).status).toBe(200);
    const row = await db().pushSubscription.findUniqueOrThrow({
      where: { endpoint: SUB.endpoint },
    });
    expect(row.deviceId).toBe(device.id);
    expect(row.userId).toBe(employee.userId);

    await avisar(employee.userId, 'OS 12 · Costura — nova tarefa para você');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.endpoint).toBe(SUB.endpoint);
    expect(sent[0]!.message.body).toContain('OS 12');
    expect(sent[0]!.message.url).toBe('/tablet');
  });

  it('aviso de outra pessoa não chega; endereço desativado pelo navegador é apagado', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '246813',
    });
    await tablet.put('/api/tablet/push', SUB);
    const outro = await db().employee.findFirstOrThrow({
      where: { NOT: { id: employee.id } },
    });
    await avisar(outro.userId, 'aviso de outra pessoa');
    expect(sent).toHaveLength(0);

    failWith = 410;
    await avisar(employee.userId, 'aviso para um endereço que expirou');
    expect(await db().pushSubscription.count()).toBe(0);
    // A fila não travou.
    const cp = await db().eventConsumer.findUniqueOrThrow({
      where: { name: 'avisos-no-aparelho' },
    });
    expect(cp.failedAttempts).toBe(0);
  });

  it('falha de envio fica anotada e não trava a fila', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '246813',
    });
    await tablet.put('/api/tablet/push', SUB);
    failWith = 500;
    await avisar(employee.userId, 'servidor de avisos fora do ar');
    const row = await db().pushSubscription.findFirstOrThrow();
    expect(row.lastError).toContain('500');
    const cp = await db().eventConsumer.findUniqueOrThrow({
      where: { name: 'avisos-no-aparelho' },
    });
    expect(cp.failedAttempts).toBe(0);
  });

  it('só funcionário entrado no aparelho; só endereços dos serviços de aviso', async () => {
    const admin = await loginAdmin(app);
    expect((await admin.put('/api/tablet/push', SUB)).status).toBe(403);
    expect((await new Client(app).get('/api/tablet/push')).status).toBe(401);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '246813',
    });
    const ruim = await tablet.put('/api/tablet/push', {
      ...SUB,
      endpoint: 'https://meu-servidor.exemplo.com/roubar',
    });
    expect(ruim.status).toBe(400);
    expect(allowedPushEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(allowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(allowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);

    await tablet.put('/api/tablet/push', SUB);
    expect(
      (await tablet.req('DELETE', '/api/tablet/push', { endpoint: SUB.endpoint })).status,
    ).toBe(200);
    expect(await db().pushSubscription.count()).toBe(0);
  });
});
