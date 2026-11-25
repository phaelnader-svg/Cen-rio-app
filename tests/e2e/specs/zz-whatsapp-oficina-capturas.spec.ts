import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin } from './helpers';

/**
 * 2026-11-25 — WhatsApp da oficina no Escritório (dados fictícios): pronto para conectar, escolher
 * o número e ligado. Prints em CAPTURAS_DIR (computador e celular).
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/whatsapp-oficina';
const origin = `http://localhost:${E2E.webPort}`;

async function sql(q: string, params: unknown[] = []) {
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(`SELECT set_config('app.company_id', '1', false)`);
  await db.query(q, params);
  await db.end();
}

async function shots(page: Page, phone: Page, name: string) {
  for (const [p, sfx] of [
    [page, 'computador'],
    [phone, 'celular'],
  ] as const) {
    await p.goto('/painel/escritorio');
    const card = p.locator('#whatsapp');
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await card.screenshot({ path: `${OUT}/${name}-${sfx}.png` });
  }
}

test('capturas: WhatsApp da oficina no Escritório', async ({ page, browser }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAdmin(page);
  await sql(`UPDATE company_settings SET plan = 'gestao_jogo'`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    timezoneId: 'America/Sao_Paulo',
    storageState: await page.context().storageState(),
  });
  const phone = await context.newPage();

  // 1. Pronto para conectar.
  await shots(page, phone, '1-conectar');

  // 2. A Meta trouxe dois números: escolher o da oficina.
  const r = await page.request.post('/api/v1/connections/WHATSAPP/test-mode', {
    data: {},
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await sql(
    `UPDATE integration_connections SET status = 'PENDENTE', mode = 'PRODUCAO', config = $1::jsonb WHERE provider_key = 'WHATSAPP'`,
    [
      JSON.stringify({
        pendingAccounts: {
          pages: [],
          adAccounts: [],
          wabas: [
            {
              id: 'waba-exemplo',
              name: 'Tapeçaria Exemplo',
              phones: [
                { id: 'pn-1', display: '+55 12 99999-0001', name: 'Tapeçaria Exemplo' },
                { id: 'pn-2', display: '+55 12 3333-0002', name: 'Tapeçaria Exemplo (fixo)' },
              ],
            },
          ],
        },
      }),
    ],
  );
  await shots(page, phone, '2-escolher-numero');

  // 3. Ligado.
  await sql(
    `UPDATE integration_connections SET status = 'CONECTADA', mode = 'PRODUCAO', account_label = '+55 12 99999-0001 · Tapeçaria Exemplo', last_sync_at = now(), config = $1::jsonb WHERE provider_key = 'WHATSAPP'`,
    [
      JSON.stringify({
        phoneNumberId: 'pn-1',
        wabaId: 'waba-exemplo',
        display: '+55 12 99999-0001',
      }),
    ],
  );
  await shots(page, phone, '3-ligado');
  await phone.goto('/painel/escritorio');
  await phone.getByRole('button', { name: 'Desligar' }).click();
  const card = phone.locator('#whatsapp');
  await card.screenshot({ path: `${OUT}/4-desligar-celular.png` });
  await context.close();
});
