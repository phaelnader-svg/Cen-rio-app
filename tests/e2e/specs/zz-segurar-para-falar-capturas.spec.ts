import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { rootEnv } from '../env';
import { loginAdmin } from './helpers';
import { post } from './os-helpers';

/**
 * 2026-11-26 — Segurar para falar na Conversar (dados fictícios). Microfone falso do Chromium;
 * Google e IA falsos (SPEECH_BASE_URL e ANTHROPIC_BASE_URL) só para os prints.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/segurar-para-falar';
const TZ = 'America/Sao_Paulo';
const day = (o: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + o * 86_400_000));

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test('capturas: segurar para falar', async ({ page, browser }) => {
  test.skip(!process.env.SPEECH_BASE_URL, 'Precisa do Google falso (SPEECH_BASE_URL).');
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  await loginAdmin(page);

  for (const [name, w] of [
    ['Helena Prado', ['09:00', '11:00']],
    ['Marcos Teixeira', ['14:00', '16:00']],
  ] as const) {
    const c = await post(page, '/api/v1/customers', {
      kind: 'PF',
      name,
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Casa',
          street: 'Rua das Acácias',
          number: '120',
          district: name.startsWith('H') ? 'Jardim Aquarius' : 'Vila Adyana',
          city: 'São José dos Campos',
          state: 'SP',
          postalCode: '12200-000',
        },
      ],
    });
    const o = await post(page, '/api/v1/orders', {
      customerId: c.id,
      pickupAddressId: c.addresses[0].id,
      contractedService: 'Reforma com troca de tecido',
      agreedValueCents: 180000,
      paymentTerms: 'Metade na retirada',
      items: [{ pieceType: 'POLTRONA', description: 'Poltrona', quantity: 2 }],
    });
    await post(page, '/api/v1/pickups', {
      orderId: o.id,
      scheduledDate: day(1),
      windowStart: w[0],
      windowEnd: w[1],
      team: 'LOGISTICA_TERCEIRIZADA',
      items: o.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
  }
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(`SELECT set_config('app.company_id', '1', false)`);
  await db.query(`UPDATE company_settings SET plan = 'gestao_jogo'`);
  await db.end();

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    timezoneId: TZ,
    permissions: ['microphone'],
    storageState: await page.context().storageState(),
  });
  // Como no app instalado no iPhone: sem a voz do navegador; o áudio vai ao servidor.
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  });
  const phone = await context.newPage();
  const shot = (name: string) => phone.screenshot({ path: `${OUT}/${name}.png` });
  await phone.goto('/dono');
  await phone
    .getByRole('navigation')
    .getByRole('button', { name: /Conversar/ })
    .click();
  await expect(phone.getByTestId('owner-chat')).toBeVisible();
  await shot('1-segure-o-microfone');

  const mic = phone.getByTestId('chat-mic');
  const box = (await mic.boundingBox())!;
  await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await phone.mouse.down();
  await expect(phone.getByTestId('voice-status')).toContainText('solte para enviar');
  await phone.waitForTimeout(1500);
  await shot('2-segurando-ouvindo');
  await phone.mouse.up();
  await expect(phone.getByText('tem retirada amanhã?').first()).toBeVisible({ timeout: 20_000 });
  await expect(phone.getByText(/Tem sim\. Amanhã tem 2 retiradas/)).toBeVisible();
  await phone.waitForTimeout(500);
  await shot('3-soltou-e-respondeu');
});
