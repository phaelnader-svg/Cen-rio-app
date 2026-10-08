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
  test('fluxo completo, com bloqueio da OS antes do recebimento e histórico técnico', async ({
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

    // A OS ainda não pode ser criada (sem recebimento).
    await expect(page.getByRole('link', { name: 'Criar OS técnica' })).toHaveCount(0);
    await page.goto(`/painel/os/nova?pedido=${orderUrl.split('/').pop()}`);
    await expect(page.getByText('Aguardando a chegada das peças')).toBeVisible();

    // 3. Retirada agendada (todas as peças)
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Solicitar retirada' }).click();
    await page.getByLabel('Data combinada').fill('2026-10-16');
    await page.getByLabel('Janela — início').fill('09:00');
    await page.getByLabel('Janela — fim').fill('12:00');
    await page.getByRole('button', { name: 'Solicitar e agendar' }).click();
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

    // 4. Recebimento parcial (4 das 6 cadeiras + sofá)
    await detail.getByRole('link', { name: 'Registrar recebimento na oficina' }).click();
    await page
      .getByTestId('receipt-line-Cadeiras de jantar')
      .getByLabel('Recebidas agora')
      .fill('4');
    await page
      .getByTestId('receipt-line-Cadeiras de jantar')
      .getByLabel('Localização inicial na oficina')
      .fill('Bancada 2');
    await page
      .getByLabel('Divergências em relação ao pedido')
      .fill('Duas cadeiras ficaram com o cliente');
    await page.getByRole('button', { name: 'Confirmar recebimento' }).click();
    await expect(page.getByTestId('receipt-done')).toContainText(/Recebimento RC-\d{5} registrado/);

    // 5. OS técnica com as peças recebidas
    await page.getByRole('link', { name: 'Criar OS técnica' }).click();
    await expect(page.getByLabel('Quantidade').nth(1)).toHaveValue('4');
    await page.getByLabel('Tecido escolhido').first().fill('Linho');
    await page.getByLabel('Cor').first().fill('Areia');
    await page.getByRole('button', { name: 'Criar OS' }).click();
    await expect(page.getByRole('heading', { name: /^OS-\d{5}$/ })).toBeVisible();
    await expect(page.getByTestId('readiness')).toContainText('Programação · Pendente'); // Fase 5: sem planejamento publicado;

    // 6. Alteração técnica com histórico
    await page.getByRole('tab', { name: /Peças e especificações/ }).click();
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

    // 7. Pedido reflete o recebimento parcial
    await page.goto(orderUrl);
    await expect(page.getByTestId('order-status')).toContainText('Recebido parcialmente');
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
