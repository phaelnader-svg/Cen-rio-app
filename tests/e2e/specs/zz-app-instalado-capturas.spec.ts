import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, setPin, typePin } from './helpers';
import { post } from './os-helpers';

/**
 * 2026-11-25 — App instalado (dados fictícios): o gestor mostra o código QR em Dispositivos, o
 * celular abre o link e já fica ligado à empresa (sem digitar código), oferece "Instalar Cenário"
 * e, depois de entrar, "Ligar avisos". No iPhone, primeiro instala e o código vai junto no ícone.
 * Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/app-instalado';
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
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

/** Cadastra o aparelho e devolve o link do código QR (o mesmo que a câmera abre). */
async function registerWithQr(pp: Page, name: string, kind: string, shows: string) {
  await pp.goto('/painel/dispositivos');
  await pp.getByRole('button', { name: 'Cadastrar dispositivo' }).click();
  const dlg = pp.getByRole('dialog');
  await dlg.getByLabel('Nome').fill(name);
  await dlg.getByLabel('Tipo').selectOption({ label: kind });
  await dlg.getByLabel('Funcionário do aparelho').selectOption({ label: 'Thiago' });
  await dlg.getByTestId('device-shows-select').selectOption({ label: shows });
  await dlg.getByRole('button', { name: 'Cadastrar e gerar código' }).click();
  await expect(pp.getByTestId('pairing-qr').locator('svg')).toBeVisible();
  const code = (await pp.getByTestId('pairing-code').textContent())!.trim();
  return `/tablet?codigo=${code.replace('-', '')}`;
}

async function phone(browser: Browser, userAgent: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    timezoneId: TZ,
    userAgent,
  });
  return { context, page: await context.newPage() };
}

test('capturas: instalar o app pelo código QR e ligar avisos', async ({ page, browser }) => {
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

  // 1. Painel: o código QR para instalar no celular do Thiago.
  const androidLink = await registerWithQr(
    pp,
    'Celular do Thiago',
    'Celular',
    'Só entregas e retiradas',
  );
  await shot(pp, '1-painel-instalar-no-aparelho');
  await pp.getByRole('button', { name: 'Concluído' }).click();

  // 1b. Tela que pede o código (sem QR): o botão de instalar o app da equipe está ali, com o
  // manifesto da equipe (o do dono é o padrão do site).
  const fresh = await phone(browser, ANDROID);
  await fresh.page.goto('/tablet');
  await expect(fresh.page.getByRole('button', { name: 'Ligar aparelho' })).toBeVisible();
  await expect(fresh.page.locator('link[rel="manifest"]').first()).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await fresh.page.evaluate(() => {
    const e = new Event('beforeinstallprompt') as Event & Record<string, unknown>;
    e.prompt = async () => undefined;
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });
  await expect(fresh.page.getByTestId('instalar-app')).toBeVisible();
  await shot(fresh.page, '1b-tela-do-codigo-instalar', true);
  await fresh.context.close();

  // 2. Celular Android abre o link do código QR: liga sozinho, sem digitar código.
  const android = await phone(browser, ANDROID);
  await android.page.goto(androidLink);
  await expect(android.page.getByText('Digite seu PIN de 6 dígitos')).toBeVisible();
  await expect(android.page).toHaveURL(/\/tablet$/); // o código sai do endereço
  // O Chrome oferece "Instalar" (aqui simulado: o navegador de teste não oferece sozinho).
  await android.page.evaluate(() => {
    const e = new Event('beforeinstallprompt') as Event & Record<string, unknown>;
    e.prompt = async () => undefined;
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });
  await expect(android.page.getByTestId('instalar-app')).toBeVisible();
  await shot(android.page, '2-celular-ligado-sem-digitar-codigo', true);

  // 3. Entrou com o PIN: o app pede para ligar os avisos e mostra o de sempre (entregas).
  await typePin(android.page, '583920');
  await expect(android.page.getByTestId('tablet-user')).toBeVisible();
  await expect(android.page.getByTestId('ligar-avisos')).toBeVisible();
  await expect(android.page.getByTestId('my-trips')).toContainText('Sílvia M.');
  await shot(android.page, '3-celular-ligar-avisos', true);

  // 4. iPhone: primeiro instala; o código vai junto no ícone (manifesto com o código).
  const iosLink = await registerWithQr(
    pp,
    'iPhone do Thiago',
    'Celular',
    'Só entregas e retiradas',
  );
  await pp.getByRole('button', { name: 'Concluído' }).click();
  const iphone = await phone(browser, IPHONE);
  await iphone.page.goto(iosLink);
  await expect(iphone.page.getByTestId('instalar-iphone')).toBeVisible();
  const code = iosLink.split('=')[1]!;
  await expect(iphone.page.locator('link[rel="manifest"]').first()).toHaveAttribute(
    'href',
    `/tablet/manifest?codigo=${code}`,
  );
  const manifest = await (await iphone.page.request.get(`/tablet/manifest?codigo=${code}`)).json();
  expect(manifest.start_url).toBe(`/tablet?codigo=${code}`);
  expect(manifest.name).toBe('Cenário');
  await shot(iphone.page, '4-iphone-instalar-primeiro', true);
  // O código não foi gasto no Safari: "Usar no Safari mesmo" ainda liga o aparelho.
  await iphone.page.getByRole('button', { name: 'Usar no Safari mesmo, sem instalar' }).click();
  await expect(iphone.page.getByText('Digite seu PIN de 6 dígitos')).toBeVisible();
});
