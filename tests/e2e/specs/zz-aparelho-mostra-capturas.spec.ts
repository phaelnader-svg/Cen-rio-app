import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, setPin } from './helpers';
import { post } from './os-helpers';

/**
 * 2026-11-24 — "O que este aparelho mostra" (dados fictícios). O mesmo funcionário (Thiago) com
 * um celular só de entregas e retiradas e um tablet só de produção. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/aparelho-mostra';
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

async function pickupForThiago(page: Page, name: string, street: string, at: string) {
  const employees = (await call(page, 'GET', '/api/employees')) as {
    displayName: string;
    userId: string;
  }[];
  const thiago = employees.find((e) => e.displayName === 'Thiago')!;
  const customer = await post(page, '/api/v1/customers', {
    kind: 'PF',
    name,
    phone: null,
    allowSimilar: true,
    addresses: [
      {
        label: 'Residência',
        street,
        number: '120',
        district: 'Centro',
        city: 'Cidade Exemplo',
        state: 'SP',
        postalCode: '01000-000',
      },
    ],
  });
  const order = await post(page, '/api/v1/orders', {
    customerId: customer.id,
    pickupAddressId: customer.addresses[0].id,
    contractedService: 'Reforma',
    agreedValueCents: 90000,
    paymentTerms: 'À vista',
    items: [{ pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1 }],
  });
  await post(page, '/api/v1/pickups', {
    orderId: order.id,
    scheduledDate: today(),
    windowStart: at,
    team: 'EQUIPE_PROPRIA',
    logisticsUserId: thiago.userId,
    items: [{ orderItemId: order.items[0].id, quantity: 1 }],
  });
}

async function register(page: Page, name: string, kind: string, shows: string) {
  await page.goto('/painel/dispositivos');
  await page.getByRole('button', { name: 'Cadastrar dispositivo' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Nome').fill(name);
  await dlg.getByLabel('Tipo').selectOption({ label: kind });
  await dlg.getByLabel('Funcionário do aparelho').selectOption({ label: 'Thiago' });
  await dlg.getByTestId('device-shows-select').selectOption({ label: shows });
  return dlg;
}

test('capturas: o que cada aparelho mostra', async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  await setPin(page, 'Thiago', '583920');
  await pickupForThiago(page, 'Sílvia Moraes', 'Rua das Acácias', '09:30');
  await pickupForThiago(page, 'Paulo Nogueira', 'Avenida Brasil', '14:00');

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    storageState: await page.context().storageState(),
  });
  const pp = await ctx.newPage();
  const shot = (p: Page, name: string, full = false) =>
    p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

  // 1. Cadastro: o campo novo, já com "Só entregas e retiradas" no celular do Thiago.
  let dlg = await register(pp, 'Celular do Thiago', 'Celular', 'Só entregas e retiradas');
  await shot(pp, '1-cadastrar-celular-so-entregas');
  await dlg.getByRole('button', { name: 'Cadastrar e gerar código' }).click();
  const phoneCode = (await pp.getByTestId('pairing-code').textContent())!.trim();
  await pp.getByRole('button', { name: 'Concluído' }).click();

  dlg = await register(pp, 'Tablet do Thiago', 'Tablet', 'Só produção');
  await dlg.getByRole('button', { name: 'Cadastrar e gerar código' }).click();
  const tabletCode = (await pp.getByTestId('pairing-code').textContent())!.trim();
  await pp.getByRole('button', { name: 'Concluído' }).click();

  // 2. Lista de dispositivos: os dois do Thiago, cada um com o que mostra.
  await expect(pp.getByTestId('device-Celular do Thiago')).toContainText('Só entregas e retiradas');
  await expect(pp.getByTestId('device-Tablet do Thiago')).toContainText('Só produção');
  await shot(pp, '2-dispositivos-do-thiago');

  // 3. Celular do Thiago: só as retiradas e entregas dele hoje.
  const phone = await openTablet(
    browser,
    phoneCode,
    '583920',
    { width: 390, height: 844, isMobile: true },
    { deviceScaleFactor: 3, timezoneId: TZ },
  );
  await expect(phone.page.getByRole('heading', { level: 1 })).toHaveText(
    'Minhas retiradas e entregas de hoje',
  );
  await expect(phone.page.getByTestId('my-trips')).toContainText('Sílvia M.');
  await expect(phone.page.getByText('Inspeções')).toHaveCount(0);
  await shot(phone.page, '3-celular-do-thiago-so-entregas', true);

  // 4. Tablet do Thiago: só a produção (sem a lista de retiradas embaixo).
  const tablet = await openTablet(
    browser,
    tabletCode,
    '583920',
    { width: 1280, height: 800 },
    { deviceScaleFactor: 2, timezoneId: TZ },
  );
  await expect(tablet.page.getByTestId('tile-inspections')).toBeVisible();
  await expect(tablet.page.getByTestId('my-trips')).toHaveCount(0);
  await shot(tablet.page, '4-tablet-do-thiago-so-producao');

  // 5. Editar: o campo aparece também ao editar um aparelho que já existe.
  await pp.goto('/painel/dispositivos');
  await pp
    .getByTestId('device-Tablet do Thiago')
    .getByRole('button', { name: /Editar/ })
    .click();
  await expect(pp.getByTestId('device-shows-select')).toHaveValue('PRODUCAO');
  await shot(pp, '5-editar-tablet-do-thiago');
});
