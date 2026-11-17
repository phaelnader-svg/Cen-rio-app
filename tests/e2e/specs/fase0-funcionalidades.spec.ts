import { expect, test } from '@playwright/test';
import { loginAdmin } from './helpers';

/**
 * Reformulação, Fase 0 — o gestor desliga e religa uma funcionalidade em Empresa →
 * Funcionalidades. Os pedidos de ajuda foram removidos (remoção de módulos, 16/11/2026); o
 * interruptor exercitado agora é o do "Ambiente interativo": desligado, o botão some do topo do
 * painel; religado, volta. A embalagem não existe mais (nenhum interruptor); a logística é
 * configurável (coberta em aa-fase1-materiais-estoque-entrega.spec.ts) e continua ligada por padrão.
 * Termina religado.
 */
test('funcionalidades: desligar e religar o ambiente interativo pelo painel', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/painel/empresa');
  const card = page.getByTestId('modules-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('module-logistica-toggle')).toBeEnabled();
  await expect(page.getByTestId('module-logistica-toggle')).toBeChecked();
  // Removidos: embalagem (S1) e pedidos de ajuda (S7).
  await expect(page.getByTestId('module-embalagem-toggle')).toHaveCount(0);
  await expect(page.getByTestId('module-ajuda-toggle')).toHaveCount(0);

  const button = page.getByTestId('ambiente-interativo');
  const toggle = page.getByTestId('module-ambiente_interativo-toggle');
  await expect(toggle).toBeChecked();
  await expect(button).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('module-ambiente_interativo')).toContainText('Desativada por');
  await expect(button).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(button).toBeVisible();
});
