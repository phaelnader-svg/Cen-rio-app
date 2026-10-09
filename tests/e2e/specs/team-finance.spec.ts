import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 11 — financeiro operacional, com dados fictícios. Painel (gestor) + tablet do Ricardo.
 * O gestor lança a cobrança do pedido (R$ 1.000,00), registra um recebimento parcial, combina o
 * valor de produção do sofá com o Ricardo, lança uma despesa, confere o painel e exporta um
 * relatório. O Ricardo, autorizado, vê só os próprios valores no tablet — nunca o valor do
 * cliente nem o financeiro geral.
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-11/${name}.png`, fullPage: true })
    : Promise.resolve();

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

/** Concede uma permissão individual pelo cadastro do funcionário (como no painel). */
async function grant(page: Page, displayName: string, permission: string) {
  const list = await call(page, 'GET', '/api/employees');
  const summary = list.find((e: { displayName: string }) => e.displayName === displayName);
  const e = await call(page, 'GET', `/api/employees/${summary.id}`);
  await call(page, 'PUT', `/api/employees/${e.id}`, {
    fullName: e.fullName,
    displayName: e.displayName,
    jobTitle: e.jobTitle,
    color: e.color,
    roleIds: e.roles.map((r: { id: string }) => r.id),
    extraPermissions: [...new Set([...e.extraPermissions, permission])],
    version: e.version,
  });
}

test.describe.serial('Fase 11 — financeiro operacional', () => {
  test('cobrança, recebimento parcial, valor de produção, despesa, painel e "Meus valores" no tablet', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const people = await call(page, 'GET', '/api/v1/finance/people');
    // O nome de exibição pode ter sido alterado por specs anteriores (ex.: "Ricardo S.").
    const RICARDO = people.find((w: { displayName: string }) => w.displayName.startsWith('Ricardo'))
      .displayName as string;
    const so = await openServiceOrder(page, 'Cliente Financeiro E2E');
    const order = (await call(page, 'GET', `/api/v1/service-orders/${so.id}`)).order as {
      code: string;
    };

    // ── Receita: valor do pedido reaproveitado, cobrança e recebimento parcial ──
    await page.goto('/painel/financeiro');
    await expect(page.getByRole('heading', { name: 'Financeiro' })).toBeVisible();
    await expect(page.getByTestId('finance-dashboard')).toBeVisible();
    await page.getByRole('tab', { name: 'Receitas e recebimentos' }).click();
    const row = page.getByTestId(`fin-order-${order.code}`);
    await expect(row).toContainText('R$ 1.000,00');
    await expect(row).toContainText('Cobrança não lançada');
    await row.getByRole('button', { name: 'Lançar cobrança' }).click();
    const charge = page.getByRole('dialog', { name: /Lançar cobrança/ });
    await charge.getByLabel('Descrição').fill('Entrada (50%)');
    await charge.getByLabel('Valor (R$)').fill('500,00');
    await charge.getByRole('button', { name: 'Lançar' }).click();
    await expect(charge).toBeHidden();
    const receivable = page.getByTestId('fin-receivables').getByRole('row').filter({
      hasText: 'Cliente Financeiro E2E',
    });
    await expect(receivable).toContainText('Em aberto');
    await receivable.getByRole('button', { name: 'Abrir' }).click();
    await page.getByRole('button', { name: 'Registrar recebimento' }).click();
    const pay = page.getByRole('dialog', { name: /Registrar recebimento/ });
    await pay.getByLabel('Valor recebido (R$)').fill('200,00');
    await pay.getByRole('button', { name: 'Salvar' }).click();
    await expect(pay).toBeHidden();
    await expect(page.getByTestId('receivable-received')).toHaveText('R$ 200,00');
    await evidence(page, '01-recebimento-parcial');
    await page.keyboard.press('Escape');
    await expect(receivable).toContainText('Recebido em parte');
    await expect(row).toContainText('Recebido em parte');

    // ── Produção: valor combinado do sofá com o Ricardo (liberado só na condição) ──
    await page.getByRole('tab', { name: 'Produção e equipe' }).click();
    await page.getByRole('button', { name: 'Combinar valor' }).click();
    const labor = page.getByRole('dialog', { name: 'Combinar valor de produção' });
    await labor.getByTestId('labor-os').selectOption({ value: so.id });
    await expect(labor.getByLabel('Peça')).toContainText('Sofá 3 lugares');
    await labor.getByLabel('Tapeceiro principal').selectOption({ label: RICARDO });
    await labor.getByLabel('Peça').selectOption({ value: so.items[0]!.id });
    await labor
      .getByRole('textbox', { name: 'Serviço', exact: true })
      .fill('Reforma completa do sofá');
    await labor.getByLabel('Valor combinado (R$)').fill('320,00');
    await labor.getByRole('button', { name: 'Combinar' }).click();
    await expect(labor).toBeHidden();
    const mo = page.getByTestId('fin-labor').getByRole('row').filter({ hasText: so.code });
    await expect(mo).toContainText('R$ 320,00');
    await expect(mo).toContainText('Previsto');
    await evidence(page, '02-producao-combinada');

    // ── Despesa operacional e painel (competência × caixa) ──
    await page.getByRole('tab', { name: 'Despesas' }).click();
    await page.getByRole('button', { name: 'Nova despesa' }).click();
    const exp = page.getByRole('dialog', { name: 'Nova despesa operacional' });
    await exp.getByLabel('Categoria').selectOption({ label: 'Energia' });
    await exp.getByLabel('Descrição').fill('Energia do galpão (E2E)');
    await exp.getByLabel('Valor (R$)').fill('150,00');
    await exp.getByLabel('Beneficiário').fill('Distribuidora Exemplo');
    await exp.getByRole('button', { name: 'Salvar' }).click();
    await expect(exp).toBeHidden();
    await expect(page.getByTestId('fin-expenses')).toContainText('Energia do galpão (E2E)');
    await page.getByRole('tab', { name: 'Painel' }).click();
    await expect(page.getByTestId('fin-received')).not.toHaveText('R$ 0,00');
    await expect(page.getByText('não é lucro líquido').first()).toBeVisible();
    await evidence(page, '03-painel-financeiro');

    // ── Custos e resultado por OS (previsto × realizado) ──
    await page.getByRole('tab', { name: 'Custos e resultado por OS' }).click();
    const result = page.getByTestId(`result-${so.code}`);
    await expect(result).toContainText('R$ 1.000,00');
    await result.getByRole('button', { name: 'Detalhar' }).click();
    await expect(page.getByTestId('result-detail')).toContainText('Previsto (estimativa)');
    await expect(page.getByTestId('result-detail')).toContainText('Realizado (registrado)');
    await evidence(page, '04-resultado-os');
    await page.keyboard.press('Escape');

    // ── Relatório com exportação CSV ──
    await page.getByRole('tab', { name: 'Relatórios' }).click();
    await expect(page.getByTestId('report-table')).toContainText(so.code);
    const href = await page.getByTestId('report-csv').getAttribute('href');
    const csv = await page.request.get(href!);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(await csv.text()).toContain(so.code);

    // ── Tablet do Ricardo: sem financeiro até o gestor autorizar; depois, só os próprios ──
    await setPin(page, RICARDO, '482915');
    const ricardo = await openTablet(
      browser,
      await registerDevice(page, 'Tablet Ricardo (financeiro)', RICARDO),
      '482915',
    );
    const rt = ricardo.page;
    await expect(rt.getByTestId('tile-values')).toHaveCount(0);
    const denied = await rt.request.get('/api/v1/finance/dashboard');
    expect(denied.status()).toBe(403);
    await grant(page, RICARDO, 'financeiro.producao_propria');
    await rt.reload();
    await rt.getByTestId('tile-values').click();
    const values = rt.getByTestId('my-values');
    await expect(values).toContainText('R$ 320,00');
    await expect(values).toContainText(so.code);
    await expect(values).toContainText('Previsto');
    // Nunca o valor cobrado do cliente, recebimentos ou o financeiro geral.
    await expect(values).not.toContainText('1.000,00');
    await expect(values).not.toContainText('200,00');
    expect((await rt.request.get('/api/v1/finance/dashboard')).status()).toBe(403);
    expect((await rt.request.get('/api/v1/finance/labor')).status()).toBe(403);
    await evidence(rt, '05-tablet-meus-valores');
    await ricardo.context.close();

    // Período sem movimento: o painel não mostra nada contratado.
    const empty = await call(
      page,
      'GET',
      '/api/v1/finance/dashboard?from=2020-01-01&to=2020-01-31',
    );
    expect(empty.accrual.contractedCents).toBe(0);
    expect(today() >= '2026-01-01').toBe(true);
  });
});
