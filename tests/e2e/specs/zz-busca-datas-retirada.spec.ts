import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * 2026-11-24 — busca rápida, datas no meio do campo e retirada combinada pela oficina
 * (dados fictícios). Prints em CAPTURAS_DIR (padrão: test-results/busca-datas-retirada).
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/busca-datas-retirada';
const origin = `http://localhost:${E2E.webPort}`;

async function call(page: Page, method: 'POST' | 'GET' | 'PATCH', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('busca não quebra a tela, datas centralizadas e proposta sem escolher o dia', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'pt-BR',
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loginAdmin(page);

  const settings = await call(page, 'GET', '/api/v1/quotes/settings');
  if (settings.taxRateBps === null)
    await call(page, 'PATCH', '/api/v1/quotes/settings', {
      version: settings.version,
      taxRateBps: 600,
    });
  const quote = await call(page, 'POST', '/api/v1/quotes', {
    customerName: 'Valéria Monteiro',
    phone: '12988887777',
    city: 'Taubaté',
    service: 'Reforma de poltrona',
    serviceOther: '',
    fabricChange: false,
    foamChange: false,
    items: [],
    logisticsId: null,
    upholsteryServiceId: null,
    helperServiceId: null,
    sofaCount: 1,
    profitCents: 45000,
    feeId: null,
    deliveryDays: 20,
    validityDays: 15,
    paymentTerms: '50% na aprovação e 50% na entrega.',
    notes: '',
  });

  // 1) Busca rápida: digitar não abre mais "Algo deu errado".
  await page.goto('/painel/orcamentos');
  await page.getByTestId('busca-rapida').click();
  await page.getByLabel('Buscar', { exact: true }).fill('Valéria');
  await expect(page.getByText(`Orçamento nº ${quote.number} · Valéria Monteiro`)).toBeVisible();
  await expect(page.getByText('Algo deu errado')).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/1-busca-funcionando.png` });
  await page.getByLabel('Buscar', { exact: true }).fill(String(quote.number));
  await expect(page.getByText(`Orçamento nº ${quote.number} · Valéria Monteiro`)).toBeVisible();
  await page.keyboard.press('Escape');

  // 2) Datas De/Até: o campo é flex e centraliza o texto na vertical.
  await page.goto('/painel/financeiro');
  const picker = page.getByTestId('period-picker').first();
  await expect(picker).toBeVisible();
  const date = picker.locator('input[type="date"]').first();
  await expect(date).toHaveCSS('display', 'flex');
  await expect(date).toHaveCSS('align-items', 'center');
  await picker.screenshot({ path: `${OUT}/2-datas-no-meio.png` });

  // 3) Proposta pelo link: aprova e não escolhe dia; a oficina combina a retirada.
  const { url } = await call(page, 'GET', `/api/v1/quotes/${quote.id}/link`);
  const client = await browser.newPage({
    locale: 'pt-BR',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  await client.goto(new URL(url).pathname + new URL(url).search);
  await expect(
    client.getByText('a tapeçaria combina com você o dia de buscar a peça'),
  ).toBeVisible();
  await client.getByRole('button', { name: 'Aprovar proposta' }).click();
  await client.getByRole('button', { name: 'Sim, aprovar' }).click();
  await expect(
    client.getByText('A tapeçaria já foi avisada e vai combinar com você o dia de buscar a peça.'),
  ).toBeVisible();
  await expect(client.getByText('Escolha o dia')).toHaveCount(0);
  await expect(client.getByText('Escolha o turno')).toHaveCount(0);
  await client
    .getByText('Proposta aprovada')
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await client.screenshot({ path: `${OUT}/3-proposta-aprovada-sem-escolher-dia.png` });
  await client.close();

  expect(errors).toEqual([]);
  await ctx.close();
});
