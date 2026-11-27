import { expect, test } from '@playwright/test';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 2 — "Modelos de serviço" e "Sugerir do modelo" na OS, pela tela.
 * Visão por serviço (etapas + checklist + materiais), cadastro de material padrão e aplicação na
 * OS: a linha entra sem custo, não comprada e não disponível, e não se repete. Dados fictícios.
 */
test('modelos de serviço: visão unificada, material padrão e sugestão na OS', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const tag = `E2E-F2-${Date.now().toString(36)}`;
  const material = `Tecido ${tag}`;

  // Visão por serviço: as três partes lado a lado.
  await page.goto('/painel/producao/modelos');
  await expect(page.getByRole('heading', { name: 'Modelos de serviço', level: 1 })).toBeVisible();
  const overview = page.getByTestId('service-models-overview');
  await expect(overview).toBeVisible();
  await overview.getByLabel('Tipo de peça').selectOption('POLTRONA');
  await overview.getByTestId('service-model-row-TROCA_DE_TECIDO').click();
  const detail = page.getByTestId('service-model-detail');
  await expect(detail.getByRole('heading', { name: 'Etapas de produção' })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Checklist de qualidade' })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Materiais padrão' })).toBeVisible();

  // Material padrão (quantidade por peça) só para troca de tecido de poltrona.
  await detail.getByRole('button', { name: 'Editar materiais' }).click();
  const panel = page.getByTestId('service-model-materials');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Tipo de peça')).toHaveValue('POLTRONA');
  const add = page.getByTestId('model-material-add');
  await add.getByLabel('Material padrão').fill(material);
  await add.getByLabel('Quantidade por peça').fill('3,5');
  await add.getByLabel('Unidade').fill('m');
  await add.getByLabel('Serviço').selectOption('TROCA_DE_TECIDO');
  await add.getByRole('button', { name: 'Adicionar' }).click();
  await expect(panel.getByTestId('model-material').filter({ hasText: material })).toContainText(
    '3,5 m por peça',
  );

  // OS com 2 poltronas em troca de tecido: sugere 7 m.
  const so = await openServiceOrder(page, `Cliente ${tag}`);
  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  const list = page.getByTestId('os-material-list');
  await list.getByTestId('os-material-suggest').click();
  const dialog = page.getByRole('dialog', { name: 'Sugerir materiais do modelo' });
  const line = dialog.getByRole('listitem').filter({ hasText: material });
  await expect(line).toContainText('7 m');
  await expect(line).toContainText('Poltrona · Troca de tecido (2)');
  await expect(line.getByRole('checkbox')).toBeChecked();
  // Só o material deste teste (outros padrões do banco E2E ficam de fora).
  for (const other of await dialog.getByRole('listitem').all()) {
    const box = other.getByRole('checkbox');
    if (!(await other.textContent())?.includes(material) && (await box.isEnabled()))
      await box.uncheck();
  }
  await dialog.getByTestId('os-material-suggest-apply').click();
  await expect(dialog).toBeHidden();

  const row = list.locator('tr', { hasText: material });
  await expect(row).toBeVisible();
  await expect(row).toContainText('7');
  // Nunca nasce comprada nem na oficina.
  await expect(row.getByRole('checkbox', { name: /Comprado/ })).not.toBeChecked();
  await expect(row.getByRole('checkbox', { name: /Na oficina/ })).not.toBeChecked();

  // Abrir de novo: já na lista, sem repetir.
  await list.getByTestId('os-material-suggest').click();
  const again = dialog.getByRole('listitem').filter({ hasText: material });
  await expect(again).toContainText('já na lista');
  await expect(again.getByRole('checkbox')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Fechar' }).first().click();
  await expect(list.locator('tr', { hasText: material })).toHaveCount(1);
});
