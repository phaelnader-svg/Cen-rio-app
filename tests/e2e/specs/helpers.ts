import { expect, type Browser, type Page } from '@playwright/test';
import { E2E } from '../env';

export async function loginAdmin(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(E2E.admin.email);
  await page.getByLabel('Senha').fill(E2E.admin.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/painel$/);
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
}

export async function setPin(page: Page, employee: string, pin: string) {
  await page.goto('/painel/funcionarios');
  await page.getByTestId(`employee-${employee}`).getByRole('button', { name: 'PIN' }).click();
  await page.getByLabel('Novo PIN').fill(pin);
  await page.getByRole('button', { name: 'Salvar PIN' }).click();
  await expect(
    page.getByTestId(`employee-${employee}`).getByText('PIN do tablet definido'),
  ).toBeVisible();
}

/** Cadastra um tablet no painel e devolve o código de vinculação exibido. */
export async function registerDevice(page: Page, name: string, employee: string) {
  await page.goto('/painel/dispositivos');
  await page.getByRole('button', { name: 'Cadastrar dispositivo' }).click();
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('Funcionário do tablet').selectOption({ label: employee });
  await page.getByRole('button', { name: 'Cadastrar e gerar código' }).click();
  const code = (await page.getByTestId('pairing-code').textContent())!.trim();
  await page.getByRole('button', { name: 'Concluído' }).click();
  return code;
}

/** Abre um "tablet" (contexto de navegador separado, 1280x800 com toque), vincula e entra. */
export async function openTablet(browser: Browser, code: string, pin: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/tablet');
  await page.getByLabel('Código de vinculação').fill(code);
  await page.getByRole('button', { name: 'Vincular tablet' }).click();
  await expect(page.getByText('Digite seu PIN de 6 dígitos')).toBeVisible();
  await typePin(page, pin);
  await expect(page.getByTestId('tablet-user')).toBeVisible();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
  return { context, page };
}

export async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
}
