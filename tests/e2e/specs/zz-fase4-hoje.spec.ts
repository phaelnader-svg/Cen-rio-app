import { expect, test, type Page } from '@playwright/test';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 4 — pela tela:
 *  1. o Início mostra a seção "Hoje" (em execução, na oficina, prontas aguardando entrega,
 *     pendências) e as ações sugeridas, que só levam à tela certa (nenhum botão executa nada);
 *  2. a Programação semanal tem a aba "Produtividade" (mesmos indicadores, sem valores).
 * Capturas em 1440 px e 390 px quando E2E_EVIDENCE=1. Dados fictícios.
 */
const shot = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({
        path: `../../docs/evidencias/reformulacao-fase-4/${name}.png`,
        fullPage: true,
      })
    : Promise.resolve();

const MONEY = /R\$\s?\d/;

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`Fase 4 — "Hoje" e produtividade (${vp.name})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await loginAdmin(page);
    // Uma OS recebida e ainda sem programação.
    await openServiceOrder(page, `Cliente Fase 4 ${vp.name} ${Date.now().toString(36)}`);
    await page.goto('/painel');
    const today = page.getByTestId('today-panel');
    await expect(today).toBeVisible();
    // 2026-11-19 (Raphael): o "Hoje" volta com os quatro quadros e sem a lista de sugestões e
    // avisos (os avisos ficam no sininho).
    await expect(today.getByRole('heading', { name: 'Hoje', exact: true })).toBeVisible();
    for (const id of ['today-in-execution', 'today-present', 'today-ready', 'today-pendencies'])
      await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('today-suggestions')).toHaveCount(0);
    await expect(page.getByTestId('today-alerts')).toHaveCount(0);
    // Nada de valores no painel "Hoje".
    expect(await today.innerText()).not.toMatch(MONEY);
    await shot(page, `inicio-hoje-${vp.name}`);

    // Revisão geral (item 8): quem vê o financeiro abre a produtividade em Equipe (a aba da
    // programação fica só para quem planeja sem acesso ao financeiro).
    await page.goto('/painel/produtividade');
    await expect(page.getByTestId('productivity-table')).toBeVisible();
    await shot(page, `programacao-produtividade-${vp.name}`);
  });
}
