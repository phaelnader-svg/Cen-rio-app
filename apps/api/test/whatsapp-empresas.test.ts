import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { companyForInbound } from '../src/modules/integrations/inbox';
import { signBody, webhookSecret } from '../src/modules/integrations/meta';
import { Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';

/**
 * WhatsApp de cada empresa: cada tapeçaria liga o próprio número; a mensagem que chega pelo webhook
 * vai só para a empresa dona do número (nunca para outra); conta desconhecida é ignorada.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
});

const post = (c: Client, url: string, body: unknown) =>
  c.post(url, body, { 'idempotency-key': idemKey() });

async function novaEmpresa() {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', {
    email: 'nova@tapecaria.local',
    password: 'senha123',
    passwordConfirm: 'senha123',
  });
  expect(r.status).toBeLessThan(300);
  return c;
}

async function webhook(phoneNumberId: string, from: string, text: string) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: from, profile: { name: from } }],
              messages: [
                {
                  from,
                  id: `wamid.${from}.${Date.now()}`,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const r = await app.app.inject({
    method: 'POST',
    url: '/api/webhooks/meta',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(webhookSecret(true)!, body),
    },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { received: number; ignored: number };
}

describe('WhatsApp de cada empresa', () => {
  it('empresa nova liga o próprio WhatsApp e a mensagem cai só nela', async () => {
    const admin = await loginAdmin(app);
    const nova = await novaEmpresa();
    expect((await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {})).status).toBe(200);
    expect((await post(nova, '/api/v1/connections/WHATSAPP/test-mode', {})).status).toBe(200);
    const conns = await db().integrationConnection.findMany({ where: { providerKey: 'WHATSAPP' } });
    const pn = Object.fromEntries(
      conns.map((c) => [c.companyId, (c.config as { phoneNumberId: string }).phoneNumberId]),
    );
    expect(pn[1]).toBe('pn-teste-1');
    const novaId = conns.find((c) => c.companyId !== 1)!.companyId;
    expect(pn[novaId]).toBe(`pn-teste-${novaId}`);

    await webhook(pn[novaId]!, '5511999990001', 'Quero reformar uma poltrona');
    await webhook(pn[1]!, '5511999990002', 'Orçamento de sofá');
    const conv = await db().inboxConversation.findMany({
      select: { companyId: true, externalThreadId: true },
    });
    expect(conv.find((c) => c.externalThreadId === '5511999990001')?.companyId).toBe(novaId);
    expect(conv.find((c) => c.externalThreadId === '5511999990002')?.companyId).toBe(1);

    // A simulação da empresa nova usa o número dela.
    const sim = await post(nova, '/api/v1/connections/WHATSAPP/simulate', {
      from: '5511999990003',
      text: 'Oi',
    });
    expect(sim.status).toBe(200);
    expect(
      (await db().inboxConversation.findFirst({ where: { externalThreadId: '5511999990003' } }))
        ?.companyId,
    ).toBe(novaId);
  });

  it('número que nenhuma empresa ligou é ignorado', async () => {
    const admin = await loginAdmin(app);
    await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {});
    const r = await webhook('numero-de-ninguem', '5511999990009', 'Oi');
    expect(r.ignored).toBe(1);
    expect(await db().inboxConversation.count()).toBe(0);
  });

  it('conexão antiga da Cenário Estofados sem número gravado continua recebendo', async () => {
    const admin = await loginAdmin(app);
    await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {});
    await db().integrationConnection.updateMany({
      where: { providerKey: 'WHATSAPP' },
      data: { config: {} },
    });
    expect(await companyForInbound(app.ctx.system, { channel: 'WHATSAPP', account: 'x' })).toBe(1);
  });

  it('cobrança e notas continuam só na Cenário Estofados', async () => {
    const nova = await novaEmpresa();
    const r = await nova.post('/api/v1/connections/ASAAS/connect', {
      apiKey: 'chave-qualquer-123',
    });
    expect(r.status).toBe(422);
  });

  it('painel: mostra o estado e só deixa conectar com o servidor ligado à Meta', async () => {
    const nova = await novaEmpresa();
    const g = await nova.get('/api/v1/whatsapp-empresa');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ ready: false, status: 'DESCONECTADA', choices: [] });
    const c = await post(nova, '/api/v1/whatsapp-empresa/conectar', {});
    expect(c.status).toBe(422);
    await post(nova, '/api/v1/connections/WHATSAPP/test-mode', {});
    const ligado = await nova.get('/api/v1/whatsapp-empresa');
    expect(ligado.body).toMatchObject({ status: 'CONECTADA', test: true });
    expect((await post(nova, '/api/v1/whatsapp-empresa/desligar', {})).status).toBe(200);
    expect((await nova.get('/api/v1/whatsapp-empresa')).body).toMatchObject({
      status: 'DESCONECTADA',
    });
  });
});
