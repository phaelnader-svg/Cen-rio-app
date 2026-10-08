import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

test.describe('Painel administrativo', () => {
  test('rotas do painel exigem autenticação', async ({ page }) => {
    await page.goto('/painel/funcionarios');
    await expect(page).toHaveURL(/\/entrar$/);
  });

  test('credenciais inválidas exibem erro sem revelar se o e-mail existe', async ({ page }) => {
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(E2E.admin.email);
    await page.getByLabel('Senha').fill('SenhaErrada999');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();
  });

  test('gestor entra, navega e cadastra um funcionário', async ({ page }) => {
    await loginAdmin(page);
    await expect(page.getByRole('heading', { name: /Bom dia|Boa tarde|Boa noite/ })).toBeVisible();
    // módulos futuros aparecem como indisponíveis, sem link
    await expect(page.getByLabel('Módulos ainda não disponíveis')).toContainText(
      'Programação semanal',
    );
    await expect(page.getByRole('link', { name: 'Programação semanal' })).toHaveCount(0);
    // Liberado na Fase 2:
    await expect(
      page.getByRole('navigation').getByRole('link', { name: 'Ordens de serviço' }),
    ).toBeVisible();

    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Funcionários', exact: true })
      .click();
    await page.getByRole('button', { name: 'Novo funcionário' }).click();
    await page.getByLabel('Nome completo').fill('Pessoa de Teste E2E');
    await page.getByLabel('Nome de exibição').fill('Teste E2E');
    await page.getByLabel('Cargo / atuação').fill('Apoio');
    await page.getByLabel('Ajudante').check();
    await page.getByRole('button', { name: 'Cadastrar' }).click();
    await expect(page.getByTestId('employee-Teste E2E')).toBeVisible();

    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Auditoria', exact: true })
      .click();
    await expect(page.getByText('Funcionário Teste E2E cadastrado.')).toBeVisible();
  });

  test('validação no formulário de empresa e salvamento com versão', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/painel/empresa');
    const alert = page.getByLabel('Alerta de ausência às');
    await alert.fill('08:00');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('O limite de alerta de chegada deve ser posterior')).toBeVisible();
    await alert.fill('09:45');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Configurações salvas.')).toBeVisible();
  });
});
