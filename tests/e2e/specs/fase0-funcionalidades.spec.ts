import { expect, test } from '@playwright/test';
import { loginAdmin } from './helpers';

/**
 * Reformulação, Fase 0 — o gestor desliga e religa os pedidos de ajuda em Empresa →
 * Funcionalidades. Desligados: somem do menu e a tela de histórico avisa que estão desativados.
 * Logística e embalagem aparecem, mas não podem ser alteradas nesta fase. Termina religado (os
 * outros specs usam a ajuda).
 */
test('funcionalidades: desligar e religar os pedidos de ajuda pelo painel', async ({ page }) => {
  await loginAdmin(page);
  const menu = page.getByRole('link', { name: 'Pedidos de ajuda' });
  await expect(menu).toBeVisible();

  await page.goto('/painel/empresa');
  const card = page.getByTestId('modules-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('module-logistica-toggle')).toBeDisabled();
  await expect(page.getByTestId('module-embalagem-toggle')).toBeDisabled();
  const help = page.getByTestId('module-ajuda-toggle');
  await expect(help).toBeChecked();

  await help.click();
  await expect(help).not.toBeChecked();
  await expect(page.getByTestId('module-ajuda')).toContainText('Desativada por');
  await expect(menu).toHaveCount(0);

  await page.goto('/painel/ajuda');
  await expect(page.getByTestId('help-disabled')).toContainText('Pedidos de ajuda desativados');
  await expect(page.getByRole('button', { name: 'Reavaliar fila' })).toHaveCount(0);

  await page.goto('/painel/empresa');
  await page.getByTestId('module-ajuda-toggle').click();
  await expect(page.getByTestId('module-ajuda-toggle')).toBeChecked();
  await expect(page.getByRole('link', { name: 'Pedidos de ajuda' })).toBeVisible();
  await page.goto('/painel/ajuda');
  await expect(page.getByTestId('help-disabled')).toHaveCount(0);
});
