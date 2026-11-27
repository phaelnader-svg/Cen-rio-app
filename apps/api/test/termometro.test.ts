/**
 * Termômetro de uso no painel da plataforma (2026-11-27): os 5 passos de cada empresa e o aviso
 * no celular quando uma empresa em teste fica 2 dias sem entrar. Dados fictícios.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { App } from '../src/app';
import { sendIdleNotices } from '../src/modules/platform/usage';
import { pushSender } from '../src/modules/push/push';
import { Client, EMPRESA_NOVA, createTestApp, db, loginPlatform, resetDatabase } from './helpers';

let app: App;
const pushes: { title: string; body: string; url: string }[] = [];
const originalPush = pushSender.send;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
  pushSender.send = async (_t, m) => {
    pushes.push({ title: m.title, body: m.body, url: m.url });
  };
});
afterAll(async () => {
  pushSender.send = originalPush;
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  pushes.length = 0;
});

const DAY = 86_400_000;

it('mostra os passos, os dias de uso e avisa uma vez quando a empresa em teste para de entrar', async () => {
  const painel = await loginPlatform(app);
  await painel.put('/api/v1/platform/push', {
    endpoint: 'https://push.exemplo/termometro',
    keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) },
  });
  const c = new Client(app);
  expect(
    (
      await c.post('/api/auth/signup', {
        ...EMPRESA_NOVA,
        email: 'parada@tapecaria.local',
        password: 'senha1234',
        passwordConfirm: 'senha1234',
      })
    ).status,
  ).toBe(201);
  const { companyId } = await db().user.findUniqueOrThrow({
    where: { email: 'parada@tapecaria.local' },
  });

  const row = async () =>
    (await painel.get('/api/v1/platform/companies')).body.items.find(
      (x: { id: number }) => x.id === companyId,
    );
  let r = await row();
  expect(r.usage.steps.map((s: { key: string }) => s.key)).toEqual([
    'orcamento',
    'aprovou',
    'os',
    'funcionario',
    'voltou',
  ]);
  expect(r.usage.level).toBe('frio');
  expect(r.usage.idleDays).toBe(0);
  // Acabou de criar a conta: nada de aviso.
  expect(await sendIdleNotices(app.ctx.system, 'http://localhost:3000')).toBe(0);

  // Três dias depois, sem entrar de novo: aviso no celular, uma vez só.
  const later = new Date(Date.now() + 3 * DAY);
  expect(await sendIdleNotices(app.ctx.system, 'http://localhost:3000', later)).toBe(1);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]!.body).toContain('não entra há 3 dias');
  expect(pushes[0]!.url).toBe(`/plataforma/empresas?parada=${companyId}`);
  expect(await sendIdleNotices(app.ctx.system, 'http://localhost:3000', later)).toBe(0);

  // Voltou a usar no dia seguinte (sessão e tela vistas depois do cadastro) e fez um orçamento.
  await db().session.updateMany({
    where: { companyId },
    data: { lastSeenAt: new Date(Date.now() + 4 * DAY) },
  });
  await db().screenView.create({
    data: {
      companyId,
      screen: 'painel',
      day: new Date(new Date(Date.now() + 4 * DAY).toISOString().slice(0, 10)),
      views: 3,
    },
  });
  await db().quote.create({
    data: {
      companyId,
      number: 10200,
      customerName: 'Cliente teste',
      service: 'Reforma de Sofá',
      totalCents: 100000,
      snapshot: {},
    },
  });
  r = await row();
  expect(r.usage.steps.find((s: { key: string }) => s.key === 'voltou').at).not.toBeNull();
  expect(r.usage.steps.find((s: { key: string }) => s.key === 'orcamento').at).not.toBeNull();
  expect(r.usage.level).toBe('morno');
  expect(r.usage.helpWhatsappUrl).toContain('wa.me');
  expect(decodeURIComponent(r.usage.helpWhatsappUrl)).toContain('Travou em alguma coisa?');

  // Parou de novo depois de voltar: novo aviso.
  expect(
    await sendIdleNotices(
      app.ctx.system,
      'http://localhost:3000',
      new Date(Date.now() + 6.6 * DAY),
    ),
  ).toBe(1);
  expect(pushes).toHaveLength(2);
});
