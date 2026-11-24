import {
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
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
  // Espera a GRAVAÇÃO terminar: a janela fecha e o aviso de sucesso aparece. O texto "PIN do tablet
  // definido" sozinho não basta — ele já aparece quando o funcionário tinha um PIN anterior (de
  // outro spec), e navegar em seguida abortava o PUT ainda em andamento: o tablet tentava o PIN
  // novo com o antigo ainda valendo (instabilidade do team-issues na suíte completa).
  await expect(page.getByLabel('Novo PIN')).toHaveCount(0);
  await expect(page.getByText('PIN atualizado.', { exact: false }).first()).toBeVisible();
  await expect(
    page.getByTestId(`employee-${employee}`).getByText('PIN do tablet definido'),
  ).toBeVisible();
}

/** Cadastra um tablet no painel e devolve o código de vinculação exibido. */
export async function registerDevice(page: Page, name: string, employee: string) {
  await page.goto('/painel/dispositivos');
  await page.getByRole('button', { name: 'Cadastrar dispositivo' }).click();
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('Funcionário do aparelho').selectOption({ label: employee });
  await page.getByRole('button', { name: 'Cadastrar e gerar código' }).click();
  const code = (await page.getByTestId('pairing-code').textContent())!.trim();
  await page.getByRole('button', { name: 'Concluído' }).click();
  return code;
}

/** Abre um "tablet" (contexto de navegador separado, 1280x800 com toque), vincula e entra. */
export async function openTablet(
  browser: Browser,
  code: string,
  pin: string,
  device: { width: number; height: number; isMobile?: boolean } = { width: 1280, height: 800 },
  extra: BrowserContextOptions = {},
  /** Preparação do contexto antes de abrir a página (ex.: interceptar o tempo real). */
  setup?: (context: BrowserContext) => Promise<void>,
) {
  const context = await browser.newContext({
    ...extra,
    viewport: { width: device.width, height: device.height },
    isMobile: device.isMobile ?? false,
    hasTouch: true,
  });
  if (setup) await setup(context);
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

/**
 * Etapa E1: as travas de materiais vêm DESLIGADAS por padrão. Os specs que provam o controle formal
 * (tarefa esperando material) ligam a trava no começo e restauram o padrão (desligada) no fim, para
 * não alterar o estado dos specs seguintes (o banco E2E é compartilhado).
 */
export async function setMaterialsGate(page: Page, enabled: boolean) {
  const origin = `http://localhost:${E2E.webPort}`;
  const headers = () => ({ origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') });
  const r = await page.request.fetch('/api/company/modules', { headers: headers() });
  expect(r.ok(), `GET /api/company/modules: ${await r.text()}`).toBe(true);
  const m = ((await r.json()) as { key: string; version: number; enabled: boolean }[]).find(
    (x) => x.key === 'materiais',
  );
  // Remoção de módulos (16/11/2026): a trava formal de materiais saiu; materiais nunca bloqueiam.
  if (!m || m.enabled === enabled) return;
  const w = await page.request.fetch('/api/company/modules/materiais', {
    method: 'PUT',
    data: { enabled, version: m.version },
    headers: headers(),
  });
  expect(w.ok(), `PUT /api/company/modules/materiais: ${await w.text()}`).toBe(true);
}
