import { expect, test } from '@playwright/test';
import { loginAdmin, openTablet, registerDevice, setPin, typePin } from './helpers';

test.describe.serial('Tablets, sessões e sincronização', () => {
  test('vinculação, login por PIN, sessão persistente e atualização em tempo real', async ({
    page,
    browser,
  }) => {
    await loginAdmin(page);
    await setPin(page, 'Ricardo', '482915');
    const code = await registerDevice(page, 'Tablet Ricardo', 'Ricardo');
    const tablet = await openTablet(browser, code, '482915');
    await expect(tablet.page.getByTestId('tablet-user')).toHaveText('Ricardo');
    await expect(tablet.page.getByText('Disponível na próxima fase').first()).toBeVisible();

    // Sessão persistente: recarregar ou reabrir o navegador mantém o acesso.
    await tablet.page.reload();
    await expect(tablet.page.getByTestId('tablet-user')).toHaveText('Ricardo');
    const state = await tablet.context.storageState();
    const reopened = await browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 800 },
    });
    const p2 = await reopened.newPage();
    await p2.goto('/tablet');
    await expect(p2.getByTestId('tablet-user')).toHaveText('Ricardo');
    await reopened.close();

    // O painel vê o tablet conectado em tempo real.
    await page.goto('/painel/dispositivos');
    await expect(page.getByTestId('device-Tablet Ricardo').getByText('Conectado')).toBeVisible();

    // Gestor altera o cadastro → o tablet atualiza sem recarregar.
    await page.goto('/painel/funcionarios');
    await page.getByTestId('employee-Ricardo').getByRole('button', { name: 'Editar' }).click();
    await page.getByLabel('Nome de exibição').fill('Ricardo S.');
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(tablet.page.getByTestId('tablet-user')).toHaveText('Ricardo S.');

    // Sessão de tablet não abre o painel.
    await tablet.page.goto('/painel');
    await expect(tablet.page.getByText('Acesso ao painel indisponível')).toBeVisible();
    await tablet.context.close();
  });

  test('sinais de sincronização e reconciliação após queda de conexão', async ({
    page,
    browser,
  }) => {
    await loginAdmin(page);
    await setPin(page, 'Márcio', '736152');
    const code = await registerDevice(page, 'Tablet Márcio', 'Márcio');
    const tablet = await openTablet(browser, code, '736152');

    // Permite bloquear novas conexões WebSocket do tablet (simula Wi-Fi caindo).
    let blocked = false;
    await tablet.page.routeWebSocket(/\/api\/realtime$/, (ws) => {
      if (blocked) ws.close({ code: 1006 as never, reason: 'rede indisponível' });
      else ws.connectToServer();
    });
    await tablet.page.reload();
    await expect(tablet.page.getByTestId('connection-status')).toHaveAttribute(
      'data-status',
      'online',
    );
    await tablet.page.getByRole('button', { name: /Teste de sincronização/ }).click();

    await page.goto('/painel/sincronizacao');
    await expect(page.getByTestId('sync-status')).toHaveText('Conectado');

    // Tablet → painel
    await tablet.page.getByTestId('sync-send').click();
    await expect(page.getByTestId('sync-signals')).toContainText('Sinal de teste nº 1');
    await expect(page.getByTestId('sync-signals')).toContainText('Tablet Márcio');
    // Painel → tablet
    await page.getByTestId('sync-send').click();
    await expect(tablet.page.getByTestId('sync-signals')).toContainText('de Gestor E2E');

    // Queda: o tablet perde a conexão e não consegue reconectar.
    blocked = true;
    await tablet.page.getByTestId('sync-drop').click();
    await expect(tablet.page.getByTestId('connection-status')).toHaveAttribute(
      'data-status',
      /reconnecting|offline/,
    );

    // Enquanto isso, o painel envia dois sinais.
    await page.getByTestId('sync-send').click();
    await expect(page.getByTestId('sync-signals')).toContainText('Sinal de teste nº 2');
    await page.getByTestId('sync-send').click();
    await expect(page.getByTestId('sync-signals')).toContainText('Sinal de teste nº 3');
    await expect(tablet.page.getByTestId('sync-signals')).not.toContainText('Sinal de teste nº 2');

    // Rede volta: o servidor reenvia o que foi perdido.
    blocked = false;
    await expect(tablet.page.getByTestId('connection-status')).toHaveAttribute(
      'data-status',
      'online',
      {
        timeout: 20_000,
      },
    );
    const list = tablet.page.getByTestId('sync-signals');
    await expect(list).toContainText('Sinal de teste nº 2');
    await expect(list).toContainText('Sinal de teste nº 3');
    await expect(list.getByText('recuperado após reconexão')).toHaveCount(2);
    await expect(tablet.page.getByTestId('sync-replayed')).toHaveText('2');
    // O tablet alcança (ou passa) a última sequência vista pelo painel: eventos de fundo
    // (presença, dispositivos) podem chegar a um e não ao outro entre as duas leituras.
    const panelSeq = Number(await page.getByTestId('sync-last-seq').textContent());
    await expect
      .poll(async () => Number(await tablet.page.getByTestId('sync-last-seq').textContent()))
      .toBeGreaterThanOrEqual(panelSeq);
    await tablet.context.close();
  });

  test('revogação remota de sessão e de dispositivo', async ({ page, browser }) => {
    await loginAdmin(page);
    await setPin(page, 'Thiago', '529174');
    const code = await registerDevice(page, 'Tablet Thiago', 'Thiago');
    const tablet = await openTablet(browser, code, '529174');

    // Encerrar a sessão: o tablet volta para o PIN, ainda vinculado.
    await page.goto('/painel/dispositivos');
    await page
      .getByTestId('session-Thiago-DEVICE')
      .getByRole('button', { name: 'Encerrar' })
      .click();
    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await expect(tablet.page.getByText('Sua sessão foi encerrada pelo gestor')).toBeVisible();
    await expect(tablet.page.getByText('Digite seu PIN de 6 dígitos')).toBeVisible();

    // Entra de novo e o gestor revoga o dispositivo: volta à tela de vinculação.
    await typePin(tablet.page, '529174');
    await expect(tablet.page.getByTestId('tablet-user')).toBeVisible();
    await page.reload();
    await page.getByTestId('device-Tablet Thiago').getByRole('button', { name: 'Revogar' }).click();
    await page.getByRole('button', { name: 'Revogar dispositivo' }).click();
    await expect(tablet.page.getByRole('heading', { name: 'Vincular este tablet' })).toBeVisible();
    await expect(page.getByTestId('device-Tablet Thiago').getByText('Revogado')).toBeVisible();
    await tablet.context.close();
  });
});
