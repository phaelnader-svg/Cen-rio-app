import { expect, test, type Page } from '@playwright/test';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 5 — planejamento semanal e execução nos tablets, com dados fictícios.
 * Painel (gestor) + dois tablets em sessões separadas (João e Márcio): planejar → publicar →
 * João conclui a preparação → a tarefa dependente do Márcio é liberada sem recarregar.
 */
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-5/${name}.png`, fullPage: true })
    : Promise.resolve();

test.describe.serial('Fase 5 — motor de produção e planejamento semanal', () => {
  test('gestor planeja e publica; João conclui a preparação e libera a tarefa do Márcio em tempo real', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await loginAdmin(page);
    const so = await openServiceOrder(page, 'Cliente Produção E2E');
    const sofa = so.items[0]!.code;
    const prep = `Preparação — ${sofa}`;

    // Tablets do João (apoio) e do Márcio (tapeceiro principal), cada um com sua sessão.
    await setPin(page, 'João', '591837');
    await setPin(page, 'Márcio', '736204');
    const joao = await openTablet(
      browser,
      await registerDevice(page, 'Tablet João (produção)', 'João'),
      '591837',
    );
    const marcio = await openTablet(
      browser,
      await registerDevice(page, 'Tablet Márcio (produção)', 'Márcio'),
      '736204',
    );
    await expect(joao.page.getByTestId('tasks-count')).toHaveText('0');

    // 1. Planejamento da semana atual (rascunho).
    await page.goto('/painel/producao/planejamento');
    await page.getByLabel('Semana', { exact: true }).fill(today());
    await page.getByRole('button', { name: 'Criar planejamento da semana' }).click();
    await expect(page.getByTestId('plan-editor')).toBeVisible();

    // 2. OS adicionada com o tapeceiro principal; tarefas sugeridas pelo modelo.
    await page
      .getByTestId(`candidate-${so.code}`)
      .getByRole('button', { name: 'Adicionar à semana' })
      .click();
    const add = page.getByRole('dialog');
    await add
      .getByLabel('Tapeceiro principal (sofá)')
      .selectOption({ label: 'Márcio — Tapeceiro' });
    await add.getByLabel('Começar em').fill(today());
    await add.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(page.getByTestId(`plan-tasks-${so.code}`)).toContainText(
      `Corte de tecido — ${sofa}`,
    );
    // Corte e costura ficam com o principal; apoio sem distribuição automática.
    await expect(page.getByLabel(`Responsável de Corte de tecido — ${sofa}`)).toHaveValue(/.+/);
    await expect(page.getByLabel(`Responsável de ${prep}`)).toHaveValue('');

    // 3. Ajustes: sem desmontagem; preparação para o João; revestimento do Márcio depende dela.
    await page.getByRole('button', { name: `Remover Desmontagem — ${sofa}` }).click();
    await expect(page.getByTestId(`plan-task-Desmontagem — ${sofa}`)).toHaveCount(0);
    await page.getByLabel(`Responsável de ${prep}`).selectOption({ label: 'João' });
    await expect(page.getByLabel(`Responsável de ${prep}`)).not.toHaveValue('');
    await page.getByLabel(`Hora de ${prep}`).fill('00:00');
    await expect(page.getByLabel(`Hora de ${prep}`)).toHaveValue('00:00');

    await page.getByLabel('Incluir etapa').first().selectOption({ label: 'Revestimento' });
    await page.getByRole('button', { name: 'Incluir', exact: true }).first().click();
    const rev = page.getByTestId('plan-task-Revestimento');
    await expect(rev).toBeVisible();
    await page.getByLabel('Responsável de Revestimento').selectOption({ label: 'Márcio' });
    await expect(page.getByLabel('Responsável de Revestimento')).not.toHaveValue('');
    await page.getByLabel('Dia de Revestimento').fill(today());
    await expect(page.getByLabel('Hora de Revestimento')).toBeEnabled();
    await page.getByLabel('Hora de Revestimento').fill('00:00');
    await expect(page.getByLabel('Hora de Revestimento')).toHaveValue('00:00');
    await rev.getByRole('button', { name: 'nenhuma' }).click();
    await page.getByRole('dialog').getByLabel(new RegExp(prep)).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
    await expect(rev.getByRole('button', { name: /TP-\d{5}/ })).toBeVisible();
    await expect(page.getByTestId('plan-conflicts')).toBeVisible();
    await evidence(page, '01-planejamento-rascunho');

    // Rascunho não aparece nos tablets.
    // Fase 6: as tarefas ficam direto na tela inicial (Meu dia).
    await expect(joao.page.getByText('Nenhuma tarefa para hoje')).toBeVisible();

    // 4. Revisar e publicar.
    await page.getByRole('button', { name: 'Revisar e publicar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Publicar' }).click();
    await expect(page.getByTestId('plan-editor')).toContainText('Publicado');
    await expect(page.getByTestId(`plan-task-${prep}`)).toContainText('Liberada');
    await expect(rev).toContainText('Bloqueada');
    await expect(page.getByTestId(`plan-task-Corte de tecido — ${sofa}`)).toContainText(
      'Materiais',
    );
    await evidence(page, '02-planejamento-publicado');

    // 5. Tablets recebem as tarefas sem recarregar; cada um vê só as suas.
    const jt = joao.page;
    const mt = marcio.page;
    await expect(jt.getByRole('button', { name: new RegExp(prep) }).first()).toBeVisible();
    await expect(jt.getByText('Revestimento')).toHaveCount(0);
    await expect(mt.getByRole('button', { name: /Revestimento/ })).toBeVisible();
    await expect(mt.getByRole('button', { name: new RegExp(prep) })).toHaveCount(0);
    await expect(mt.getByText(/R\$/)).toHaveCount(0);
    await evidence(mt, '03-tablet-marcio-lista');
    await mt.getByRole('button', { name: /Revestimento/ }).click();
    await expect(mt.getByText('Ainda não liberada')).toBeVisible();
    await expect(mt.getByRole('button', { name: 'Iniciar' })).toHaveCount(0);

    // Márcio não consegue agir na tarefa do João (verificação no backend).
    const plan = await (await page.request.get(`/api/v1/production-plans?week=${today()}`)).json();
    const detail = await (await page.request.get(`/api/v1/production-plans/${plan[0].id}`)).json();
    const prepTask = detail.tasks.find((t: { title: string }) => t.title === prep);
    const forbidden = await mt.request.post(`/api/v1/production-tasks/${prepTask.id}/start`, {
      data: {},
      headers: {
        origin: new URL(page.url()).origin,
        'idempotency-key': crypto.randomUUID().replace(/-/g, ''),
      },
    });
    expect(forbidden.status()).toBe(403);

    // 6. João: iniciar, registrar andamento, pausar, retomar e concluir.
    await jt
      .getByRole('button', { name: new RegExp(prep) })
      .first()
      .click();
    await jt.getByRole('button', { name: 'Iniciar' }).click();
    await expect(jt.getByTestId('my-task-detail')).toContainText('Em execução');
    await jt.getByRole('button', { name: 'Registrar andamento' }).click();
    await jt.getByRole('button', { name: '50%' }).click();
    await jt.getByLabel('Andamento').fill('Estrutura limpa');
    await jt.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(jt.getByTestId('last-progress')).toContainText('50%');
    await expect(jt.getByTestId('last-progress')).toContainText('Estrutura limpa');
    await jt.getByRole('button', { name: 'Pausar', exact: true }).click();
    await jt.getByRole('button', { name: 'Fim do expediente' }).click();
    await expect(jt.getByText('Pausada — Fim do expediente')).toBeVisible();
    await evidence(jt, '04-tablet-joao-pausada');
    await jt.getByRole('button', { name: 'Retomar' }).click();
    await expect(jt.getByTestId('my-task-detail')).toContainText('Em execução');
    await jt.getByRole('button', { name: 'Concluir', exact: true }).click();
    await expect(jt.getByTestId('confirm-complete')).toContainText('Revestimento (Márcio)');
    await jt.getByRole('button', { name: 'Sim, concluir' }).click();
    await expect(jt.getByTestId('my-task-detail')).toContainText('Concluída');

    // 7. Tablet do Márcio: liberada sem recarregar, e ele inicia.
    await expect(mt.getByRole('button', { name: 'Iniciar' })).toBeVisible();
    await expect(mt.getByTestId('my-task-detail')).toContainText('Liberada');
    await evidence(mt, '05-tablet-marcio-liberada');
    await mt.getByRole('button', { name: 'Iniciar' }).click();
    await expect(mt.getByTestId('my-task-detail')).toContainText('Em execução');

    // 8. Quadro de produção e detalhe da tarefa no painel.
    await page.goto('/painel/producao');
    await expect(page.getByTestId('production-board')).toContainText(prep);
    await page.getByLabel('Agrupar por').selectOption({ label: 'Status' });
    await expect(page.getByTestId('production-board')).toContainText('Concluída');
    await expect(page.getByTestId('production-board')).toContainText('Em execução');
    await evidence(page, '06-quadro-producao');
    await page.getByTestId(`board-task-${prepTask.code}`).click();
    await expect(page.getByTestId('task-history')).toContainText('Concluída');
    await expect(page.getByTestId('task-history')).toContainText('Estrutura limpa');
    await evidence(page, '07-tarefa-detalhe');

    // 9. OS: aba Produção ativa.
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: /Produção/ }).click();
    await expect(page.getByTestId('os-production')).toContainText('Revestimento');

    // 10. Alteração depois de publicar exige motivo e gera revisão.
    await page.goto('/painel/producao/planejamento');
    await page.getByLabel('Semana', { exact: true }).fill(today());
    await page.locator('#plan-reason').fill('Cliente antecipou a entrega');
    await page.getByLabel(`Prioridade de Acabamento — ${sofa}`).selectOption({ label: 'Alta' });
    await expect(page.getByTestId('plan-revisions')).toContainText('Cliente antecipou a entrega');
    await evidence(page, '08-revisoes');

    await joao.context.close();
    await marcio.context.close();
  });
});
