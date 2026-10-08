import { expect, test } from '@playwright/test';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 4 — fluxo completo com dados fictícios:
 * medição → solicitação → aprovação → compra → recebimento (tablet) → reserva → prontidão completa,
 * sem iniciar a produção.
 */
test.describe.serial('Fase 4 — compras, recebimento e estoque', () => {
  test('medição até prontidão completa, com recebimento pelo tablet e sem iniciar produção', async ({
    page,
    browser,
  }) => {
    await loginAdmin(page);
    const so = await openServiceOrder(page, 'Cliente Compras E2E');

    // 1. Medição de rotina com tecido (exclusivo da OS) e grampos (estoque comum).
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('button', { name: 'Solicitar medição' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Atribuir medição' }).click();
    await page.getByRole('button', { name: 'Medir agora' }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Adicionar tecido' }).click();
    await page.getByLabel('Tecido (nome ou referência)').fill('Linho');
    await page.getByLabel('Cor').fill('Bege');
    await page.getByLabel('Metragem (m)').fill('10');
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Adicionar outro material' }).click();
    await page.getByLabel('Descrição').fill('Grampos 80/10');
    await page.getByLabel('Quantidade').fill('2');
    await page.getByLabel('Unidade').selectOption({ label: 'embalagens' });
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Enviar medição' }).click();
    await expect(page.getByTestId('measurement-badges')).toContainText('Materiais: enviada');

    // 2. Aprovação (quantidades conferidas).
    await page.getByRole('button', { name: 'Iniciar revisão' }).click();
    await page.getByRole('button', { name: 'Aprovar para compra' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Aprovar' }).click();
    await expect(page.getByText('Quantidades conferidas e aprovadas para compra')).toBeVisible();
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: /Materiais/ }).click();
    await expect(page.getByTestId('os-readiness-state')).toHaveText('Aguardando compra');

    // 3. Fornecedor e pedido de compra a partir das solicitações aprovadas.
    await page.goto('/painel/fornecedores');
    await page.getByRole('button', { name: 'Novo fornecedor' }).click();
    await page.getByRole('dialog').getByLabel('Nome ou razão social').fill('Tecidos Fictícios E2E');
    await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByTestId('supplier-Tecidos Fictícios E2E')).toBeVisible();

    await page.goto('/painel/compras');
    await page.getByLabel(`Selecionar Linho da ${so.code}`).check();
    await page.getByLabel(`Selecionar Grampos 80/10 da ${so.code}`).check();
    await page.getByRole('button', { name: /Criar pedido de compra \(2\)/ }).click();
    await page.getByLabel('Fornecedor').selectOption({ label: 'Tecidos Fictícios E2E' });
    await page.getByTestId('po-line-1').getByLabel('Preço unitário').fill('45,90');
    await page.getByTestId('po-line-2').getByLabel('Preço unitário').fill('18,90');
    await expect(page.getByTestId('po-total')).toHaveText(/496,80/);
    await page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await expect(page.getByRole('heading', { name: /^Pedido de compra CP-\d{5}$/ })).toBeVisible();
    const poUrl = page.url();
    await page.getByRole('button', { name: 'Confirmar pedido' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByTestId('po-status')).toContainText('Confirmado');
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: /Materiais/ }).click();
    await expect(page.getByTestId('os-readiness-state')).toHaveText('Aguardando recebimento');

    // 4. Recebimento pelo tablet do Thiago (qualquer funcionário; sem preços).
    await setPin(page, 'Thiago', '505050');
    const code = await registerDevice(page, 'Tablet Thiago (materiais)', 'Thiago');
    const tablet = await openTablet(browser, code, '505050');
    const t = tablet.page;
    await expect(t.getByTestId('materials-count')).toHaveText('1');
    await t.getByTestId('tile-materials').click();
    await t.getByTestId('pending-receipts').getByRole('button').first().click();
    await expect(t.getByText(/R\$/)).toHaveCount(0);
    const linho = t.getByTestId('receive-item-Linho');
    await linho.getByLabel('Recebido em ordem').fill('10');
    await linho.getByLabel('Conferi referência, cor e especificação').check();
    const grampos = t.getByTestId('receive-item-Grampos 80/10');
    await grampos.getByLabel('Recebido em ordem').fill('2');
    await grampos.getByLabel('Conferi referência, cor e especificação').check();
    await t.getByRole('button', { name: 'Confirmar recebimento' }).click();
    await expect(t.getByTestId('material-receipt-done')).toContainText(
      /Recebimento RM-\d{5} registrado/,
    );

    // 5. Painel atualizado em tempo real: pedido recebido; grampos reservados para a OS.
    await page.goto(poUrl);
    await expect(page.getByTestId('po-status')).toContainText('Recebido');
    await page.goto('/painel/estoque');
    await expect(page.getByTestId('stock-items')).toContainText('Grampos 80/10');
    await page.getByRole('tab', { name: 'Reservas por OS' }).click();
    await expect(page.getByTestId('reservations')).toContainText(so.code);

    // 6. Prontidão completa — e nenhuma produção iniciada.
    await page.goto('/painel/prontidao');
    await expect(page.getByTestId(`readiness-${so.code}`)).toContainText('Completo');
    await page.goto(`/painel/os/${so.id}`);
    await expect(page.getByTestId('readiness')).toContainText('Materiais');
    await page.getByRole('tab', { name: /Materiais/ }).click();
    await expect(page.getByTestId('os-readiness-state')).toHaveText('Completo');
    await expect(page.getByText('não autorizam o início da produção')).toBeVisible();
    await expect(page.getByRole('button', { name: /produção/i })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Produção/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await tablet.context.close();
  });
});
