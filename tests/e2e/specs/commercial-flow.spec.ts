import { expect, test, type Page } from '@playwright/test';
import { loginAdmin } from './helpers';

/** Fluxo da Fase 2 com dados fictícios. */
const CUSTOMER = 'Cliente Fictício E2E';

async function createCustomer(page: Page, name: string, phone = '(11) 90000-1234') {
  await page.goto('/painel/clientes');
  await page.getByRole('button', { name: 'Novo cliente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome completo').fill(name);
  await dialog.getByLabel('Telefone').fill(phone);
  await dialog.getByLabel('Logradouro').fill('Rua Fictícia de Teste');
  await dialog.getByLabel('Número').fill('100');
  await dialog.getByLabel('Cidade').fill('Cidade Teste');
}

test.describe.serial('Fase 2 — cliente → pedido → retirada → recebimento → OS', () => {
  test('fluxo completo: retirada, chegada na oficina, OS técnica e histórico técnico', async ({
    page,
  }) => {
    await loginAdmin(page);

    // 1. Cliente
    await createCustomer(page, CUSTOMER);
    await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(page.getByRole('heading', { name: CUSTOMER })).toBeVisible();

    // Semelhança (mesmo telefone) gera alerta sem bloquear.
    await createCustomer(page, 'Outra Pessoa Fictícia');
    await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(page.getByTestId('duplicate-candidates')).toContainText(CUSTOMER);
    await page.getByRole('button', { name: 'É outra pessoa — salvar mesmo assim' }).click();
    await expect(page.getByRole('heading', { name: 'Outra Pessoa Fictícia' })).toBeVisible();

    // 2. Pedido comercial
    await page.goto('/painel/clientes');
    await page.getByTestId(`customer-${CUSTOMER}`).click();
    await page.getByRole('link', { name: 'Novo pedido' }).click();
    await expect(page.getByTestId('order-customer')).toHaveText(CUSTOMER);
    await page.getByLabel('Serviço contratado').fill('Reforma completa com troca de tecido');
    await page.getByLabel('Valor negociado').fill('3.800,00');
    await page.getByLabel('Condições comerciais').fill('50% na retirada');
    await page.getByLabel('Descrição', { exact: true }).fill('Sofá 3 lugares');
    await page.getByRole('button', { name: 'Adicionar peça' }).click();
    await page.getByLabel('Tipo da peça 2').selectOption('CADEIRA');
    await page.getByLabel('Descrição', { exact: true }).nth(1).fill('Cadeiras de jantar');
    await page.getByLabel('Quantidade').nth(1).fill('6');
    await page.getByRole('button', { name: 'Criar pedido' }).click();
    await expect(page.getByRole('heading', { name: /^Pedido PC-\d{5}$/ })).toBeVisible();
    await expect(page.getByTestId('order-value')).toHaveText(/3\.800,00/);
    const orderUrl = page.url();

    // Fluxo da OS (2026-11-18): a OS é gerada depois que a peça chega na tapeçaria.
    await expect(page.getByTestId('order-generate-os')).toHaveCount(0);
    await expect(page.getByTestId('order-waiting-arrival')).toBeVisible();

    // 3. Retirada agendada (todas as peças)
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Solicitar retirada' }).click();
    await page.getByLabel('Data da retirada').fill('2026-10-16');
    await page.getByLabel('Horário de chegada ao cliente').fill('09:00');
    await page.getByRole('button', { name: 'Agendar retirada' }).click();
    await expect(page.getByTestId('order-status')).toContainText('Retirada agendada');

    // Andamento registrado manualmente (confirmações da logística)
    await page.getByRole('button', { name: /RT-\d{5}/ }).click();
    const detail = page.getByTestId('pickup-detail');
    await detail.getByRole('button', { name: 'Equipe a caminho / em execução' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(detail).toContainText('Em execução');
    await detail.getByRole('button', { name: 'Confirmar retirada realizada' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(page.getByTestId('pickup-timeline')).toContainText('Retirada realizada');

    // 4. Chegada na oficina: só uma marca na retirada (sem conferência de quantidades).
    await detail.getByRole('button', { name: 'Peças chegaram na oficina' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(detail).toContainText('Recebida na oficina');
    await page.goto(orderUrl);

    // 5. OS técnica com as peças recebidas
    await page.getByTestId('order-generate-os').click();
    await expect(page.getByLabel('Quantidade').nth(1)).toHaveValue('6');
    await page.getByLabel('Tecido escolhido').first().fill('Linho');
    await page.getByLabel('Cor').first().fill('Areia');
    await page.getByRole('button', { name: 'Gerar OS' }).click();
    await expect(page.getByRole('heading', { name: /^OS-\d{5}$/ })).toBeVisible();
    await expect(page.getByTestId('readiness')).toContainText('Programação · Pendente'); // Fase 5: sem planejamento publicado;

    // 6. Alteração técnica com histórico
    // Fase 2 (OS unificada): "Peças e especificações" virou "Peças e fotos".
    await page.getByRole('tab', { name: /Peças e fotos/ }).click();
    await page.getByRole('button', { name: 'Editar especificações' }).first().click();
    await page.getByRole('dialog').getByLabel('Tecido escolhido').fill('Veludo');
    await page
      .getByRole('dialog')
      .getByLabel('Motivo da alteração')
      .fill('Cliente trocou o tecido');
    await page.getByRole('button', { name: 'Salvar especificações' }).click();
    await expect(page.locator('[data-testid$="/1"]')).toContainText('Veludo');
    await page.getByRole('tab', { name: /Histórico/ }).click();
    await expect(page.getByTestId('revisions')).toContainText('Linho → Veludo');
    await expect(page.getByTestId('revisions')).toContainText('Motivo: Cliente trocou o tecido');
  });

  test('outra sessão do painel vê o novo pedido em tempo real', async ({ page, browser }) => {
    await loginAdmin(page);
    await page.goto('/painel/pedidos');
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await loginAdmin(p2);
    await p2.goto('/painel/clientes');
    await p2.getByTestId(`customer-${CUSTOMER}`).click();
    await p2.getByRole('link', { name: 'Novo pedido' }).click();
    await p2.getByLabel('Serviço contratado').fill('Reparo de assento — sincronização');
    await p2.getByLabel('Descrição', { exact: true }).fill('Poltrona');
    await p2.getByRole('button', { name: 'Criar pedido' }).click();
    await expect(p2.getByRole('heading', { name: /^Pedido PC-\d{5}$/ })).toBeVisible();
    // A lista aberta na primeira sessão atualiza sem recarregar.
    await expect(page.getByText('Reparo de assento — sincronização')).toBeVisible();
    await other.close();
  });
});
