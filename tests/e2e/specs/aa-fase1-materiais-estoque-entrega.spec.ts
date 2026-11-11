import { expect, test } from '@playwright/test';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 1 — pelo painel, com dados fictícios:
 *  - "Materiais necessários" na OS: incluir, marcar comprado/na oficina (independentes), custo
 *    opcional, aviso discreto enquanto algo não chegou e remoção em dois cliques;
 *  - estoque da oficina: categoria, material, ajuste com motivo e histórico, arquivar;
 *  - logística desligada: Retiradas e Roteiro somem do menu, a OS ganha a aba "Entrega" com o que
 *    falta (qualidade não é pulada) e religar volta ao normal. Termina com a logística ligada.
 * A entrega direta completa (qualidade aprovada, cobrança, idempotência e concorrência) está
 * provada na API: apps/api/test/fase1-materiais-estoque-entrega.test.ts.
 *
 * Prefixo "aa-": roda PRIMEIRO, no banco E2E recém-criado. Desligar a logística é RECUSADO enquanto
 * houver entrega ou retirada em andamento (regra da Fase 1, provada na API), e os specs seguintes
 * deixam várias em andamento.
 */
test.describe.configure({ mode: 'serial' });

test('materiais necessários: lista inline, flags independentes, custo e aviso', async ({
  page,
}) => {
  await loginAdmin(page);
  const so = await openServiceOrder(page, 'Cliente Fictício Fase Um Materiais');
  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  const list = page.getByTestId('os-material-list');
  await expect(list).toContainText('Nenhum material listado');

  const add = page.getByTestId('os-material-add');
  await add.getByLabel('Novo material').fill('Tecido linho bege');
  await add.getByLabel('Quantidade').fill('8');
  await add.getByLabel('Unidade').fill('m');
  await add.getByLabel('Custo (opcional)').fill('540,00');
  await add.getByRole('button', { name: 'Adicionar' }).click();
  const row = list.getByTestId('os-material-row').filter({ hasText: 'Tecido linho bege' });
  await expect(row).toBeVisible();
  await expect(page.getByTestId('os-material-notice')).toContainText(
    'Existem materiais ainda não disponíveis na oficina.',
  );

  // Comprado e "na oficina" são independentes.
  await row.getByTestId('os-material-purchased').check();
  await expect(row.getByTestId('os-material-purchased')).toBeChecked();
  await expect(row.getByTestId('os-material-available')).not.toBeChecked();
  await expect(page.getByTestId('os-material-summary')).toContainText('1 comprado(s)');
  await expect(page.getByTestId('os-material-notice')).toBeVisible();
  await row.getByTestId('os-material-available').check();
  await expect(page.getByTestId('os-material-notice')).toHaveCount(0);
  await expect(page.getByTestId('os-material-summary')).toContainText('1 na oficina');

  // Material sem custo: em branco continua "não informado" (nunca vira zero).
  await add.getByLabel('Novo material').fill('Grampos');
  await add.getByRole('button', { name: 'Adicionar' }).click();
  const grampos = list.getByTestId('os-material-row').filter({ hasText: 'Grampos' });
  await expect(grampos).toBeVisible();
  await expect(grampos.getByTestId('os-material-cost')).toHaveValue('');
  await expect(page.getByTestId('os-material-notice')).toBeVisible();

  // Remoção em dois cliques, sem janela.
  await grampos.getByRole('button', { name: 'Remover' }).click();
  await grampos.getByRole('button', { name: 'Remover' }).click();
  await expect(grampos).toHaveCount(0);
  await expect(page.getByTestId('os-material-notice')).toHaveCount(0);
});

test('estoque da oficina: categoria, material, ajuste com histórico e arquivamento', async ({
  page,
}) => {
  await loginAdmin(page);
  await page.getByRole('link', { name: 'Estoque da oficina' }).click();
  await expect(page).toHaveURL(/\/painel\/estoque-oficina$/);

  const cats = page.getByTestId('inventory-categories');
  await cats.getByLabel('Nova categoria').fill('Espumas Fictícias');
  await cats.getByRole('button', { name: 'Criar' }).click();
  await expect(cats).toContainText('Espumas Fictícias');

  const form = page.getByTestId('inventory-new-item');
  await form.getByLabel('Novo material').fill('Espuma D33 fictícia');
  await form.getByLabel('Categoria do material').selectOption({ label: 'Espumas Fictícias' });
  await form.getByLabel('Quantidade inicial').fill('4');
  await form.getByLabel('Unidade do material').fill('placa');
  await form.getByRole('button', { name: 'Cadastrar' }).click();
  const item = page.getByTestId('inventory-item').filter({ hasText: 'Espuma D33 fictícia' });
  await expect(item.getByTestId('inventory-quantity')).toContainText('4');

  await item.getByRole('button', { name: 'Ajustar' }).click();
  await item.getByLabel('Nova quantidade').fill('3');
  await item.getByLabel('Motivo do ajuste').fill('Contagem de teste');
  await item.getByRole('button', { name: 'Salvar ajuste' }).click();
  await expect(item.getByTestId('inventory-quantity')).toContainText('3');
  await item.getByRole('button', { name: 'Histórico' }).click();
  await expect(item.getByTestId('inventory-history')).toContainText('4 → 3');
  await expect(item.getByTestId('inventory-history')).toContainText('Contagem de teste');

  // Com histórico não há exclusão: só arquivar.
  await expect(item.getByRole('button', { name: 'Excluir material' })).toHaveCount(0);
  await item.getByRole('button', { name: 'Arquivar' }).click();
  await expect(item).toHaveCount(0);
  await page.getByLabel('Mostrar arquivados').check();
  await expect(item).toContainText('Arquivado');
});

test('logística desligada: menu sem roteiro e entrega pela OS; religar volta ao normal', async ({
  page,
}) => {
  await loginAdmin(page);
  const so = await openServiceOrder(page, 'Cliente Fictício Fase Um Entrega');
  await expect(page.getByRole('link', { name: 'Roteiro do dia' })).toBeVisible();

  await page.goto('/painel/empresa');
  const toggle = page.getByTestId('module-logistica-toggle');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('link', { name: 'Roteiro do dia' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Retiradas' })).toHaveCount(0);

  await page.goto(`/painel/os/${so.id}?tab=entrega`);
  const panel = page.getByTestId('os-direct-delivery');
  await expect(panel).toContainText('Ainda não pode ser entregue');
  await expect(page.getByTestId('os-direct-delivery-blocks')).toContainText('inspeção');
  await expect(page.getByTestId('os-direct-delivery-start')).toHaveCount(0);

  await page.goto('/painel/empresa');
  await page.getByTestId('module-logistica-toggle').click();
  await expect(page.getByTestId('module-logistica-toggle')).toBeChecked();
  await expect(page.getByRole('link', { name: 'Roteiro do dia' })).toBeVisible();
});
