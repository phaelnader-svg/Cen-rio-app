import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Simplificação Fase 2 — "Novo serviço" no navegador (dados fictícios; nenhum pagamento real):
 *  1. Gestor abre "Novo serviço" pelo Início, cadastra cliente novo, serviço com 2 peças, retirada
 *     terceirizada (André + Izaías, R$ 100,00) e salva com UM clique.
 *  2. Possível duplicidade: o cadastro encontrado é oferecido e reutilizado.
 *  3. Equipe própria sugere Thiago (configuração da Empresa).
 *  4. André no celular vê a retirada no roteiro, com horário de chegada e sem valores.
 *  5. Chegada parcial pelo painel: a OS nasce automaticamente só com as peças recebidas.
 */
const origin = `http://localhost:${E2E.webPort}`;
const evidence = (page: Page, name: string) =>
  process.env.E2E_GEOMETRIA
    ? page.screenshot({
        path: `../../docs/evidencias/simplificacao-fase-2/${name}.png`,
        fullPage: true,
      })
    : Promise.resolve();
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('Simplificação Fase 2 — Novo serviço', () => {
  test('cliente novo + serviço + retirada em um formulário; roteiro do André; OS na chegada', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);

    const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
    const who = (n: string) =>
      (defaults.people as { userId: string; displayName: string }[]).find((p) =>
        p.displayName.startsWith(n),
      )!;
    const ANDRE = who('André');
    const IZAIAS = who('Izaías');
    await call(page, 'PUT', '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: 10000,
      defaultDeliveryCostCents: defaults.defaultDeliveryCostCents ?? 12000,
      logisticsPayeeUserId: ANDRE.userId,
    });
    const day = today();

    // ── 1. Entrada direta pelo Início
    await page.goto('/painel');
    await page.getByTestId('dashboard-new-service').click();
    await expect(page).toHaveURL(/\/painel\/servicos\/novo$/);
    const form = page.getByTestId('new-service-form');
    await expect(form.getByRole('heading', { name: 'Cliente' })).toBeVisible();

    await page.getByTestId('ns-mode-new').click();
    await page.getByTestId('ns-name').fill('Cliente Novo Serviço E2E');
    await page.getByTestId('ns-phone').fill('(11) 93333-2211');
    await form.getByLabel('Logradouro').fill('Rua Fictícia do Serviço');
    await form.getByLabel('Número').fill('42');
    await form.getByLabel('Complemento').fill('Apto 12');
    await form.getByLabel('Cidade').fill('Cidade Teste');
    await form.getByLabel('Referência / instruções de acesso').fill('Portaria lateral');
    await page.getByTestId('ns-piece-desc-0').fill('Sofá retrátil');
    await page.getByTestId('ns-add-piece').click();
    await page
      .getByTestId('ns-piece-1')
      .getByLabel('Peça', { exact: true })
      .selectOption('POLTRONA');
    await page.getByTestId('ns-piece-desc-1').fill('Poltronas da sala');
    await page.getByTestId('ns-piece-qty-1').fill('2');
    await page.getByTestId('ns-value').fill('2.500,00');
    await page.getByTestId('ns-date').fill(day);
    await page.getByTestId('ns-arrival').fill('15:30');
    // Terceirizada: André por padrão, Izaías participante, valor total único.
    await expect(page.getByTestId('ns-responsible')).toHaveValue(ANDRE.userId);
    await page.getByTestId(`ns-participant-${IZAIAS.displayName}`).check();
    await expect(page.getByTestId('ns-amount')).toHaveValue('100,00');
    await expect(page.getByTestId('ns-sum-value')).toHaveText('R$ 2.500,00');
    await expect(page.getByTestId('ns-sum-amount')).toHaveText('R$ 100,00');
    await evidence(page, '01-novo-servico-formulario');

    await page.getByTestId('ns-submit').click();
    const done = page.getByTestId('ns-confirmation');
    await expect(done).toContainText('Aguardando retirada');
    await expect(page.getByTestId('ns-done-order')).toHaveText(/PC-\d{5}/);
    await expect(page.getByTestId('ns-done-when')).toContainText('15:30');
    await expect(page.getByTestId('ns-done-team')).toContainText(
      `${ANDRE.displayName} + ${IZAIAS.displayName}`,
    );
    await expect(page.getByTestId('ns-done-cost')).toHaveText('R$ 100,00');
    await evidence(page, '02-novo-servico-confirmacao');
    const orderCode = (await page.getByTestId('ns-done-order').textContent())!.trim();
    await page.getByTestId('ns-open-order').click();
    await expect(page.getByTestId('order-auto-os')).toBeVisible();
    const orderId = page.url().split('/').pop()!;
    const pickups = await call(page, 'GET', `/api/v1/pickups?orderId=${orderId}`);
    const pickupCode = pickups[0].code as string;

    // ── 2. Possível duplicidade: cadastro encontrado é oferecido e reutilizado.
    await page.goto('/painel/servicos/novo');
    await page.getByTestId('ns-mode-new').click();
    await page.getByTestId('ns-name').fill('Outro Nome Qualquer');
    await page.getByTestId('ns-phone').fill('(11) 93333-2211');
    await form.getByLabel('Logradouro').fill('Rua B');
    await form.getByLabel('Número').fill('1');
    await form.getByLabel('Cidade').fill('Cidade Teste');
    await page.getByTestId('ns-piece-desc-0').fill('Cadeira');
    await page.getByTestId('ns-submit').click();
    const dup = page.getByTestId('ns-dup-candidates');
    await expect(dup).toContainText('Cliente Novo Serviço E2E');
    await dup.getByRole('button', { name: 'Usar este cadastro' }).click();
    await expect(page.getByTestId('ns-customer-chosen')).toHaveText('Cliente Novo Serviço E2E');

    // ── 3. Equipe própria: Thiago sugerido pela configuração da Empresa.
    await page.getByTestId('ns-team-own').click();
    await expect(page.getByTestId('ns-responsible').locator('option:checked')).toHaveText('Thiago');
    await expect(page.getByTestId('ns-amount')).toHaveCount(0);
    await evidence(page, '03-novo-servico-equipe-propria');

    // ── 4. André no celular: a retirada no roteiro de hoje, sem valores.
    await setPin(page, 'André', '640218');
    const code = await registerDevice(page, 'Celular André (Novo serviço)', 'André');
    const andre = await openTablet(browser, code, '640218', {
      width: 390,
      height: 844,
      isMobile: true,
    });
    const stop = andre.page.getByTestId(`route-stop-${pickupCode}`);
    await expect(stop).toContainText('chegada 15:30');
    await expect(andre.page.getByText(/R\$/)).toHaveCount(0);
    await evidence(andre.page, '04-celular-andre-roteiro');
    await andre.context.close();

    // ── 5. Chegada parcial (sofá + 1 poltrona): OS automática só com o que chegou.
    const order = await call(page, 'GET', `/api/v1/orders/${orderId}`);
    await page.goto(`/painel/recebimentos/novo?pedido=${orderId}&retirada=${pickups[0].id}`);
    await page
      .getByTestId('receipt-line-Poltronas da sala')
      .getByLabel('Recebidas agora')
      .fill('1');
    for (const d of ['Sofá retrátil', 'Poltronas da sala'])
      await page
        .getByTestId(`receipt-line-${d}`)
        .getByLabel('Localização inicial na oficina')
        .fill('Área de recebimento');
    await page.getByRole('button', { name: 'Confirmar recebimento' }).click();
    await expect(page.getByTestId('receipt-done')).toContainText(/Recebimento RC-\d{5} registrado/);
    const osLink = page.getByTestId('receipt-generated-os');
    await expect(osLink).toContainText(/OS-\d{5}/);
    await evidence(page, '05-recebimento-os-automatica');
    await osLink.click();
    await expect(page).toHaveURL(/\/painel\/os\/[0-9a-f-]{36}$/);
    const so = await call(page, 'GET', `/api/v1/service-orders/${page.url().split('/').pop()}`);
    expect(
      so.items.map((i: { description: string; quantity: number }) => [i.description, i.quantity]),
    ).toEqual([
      ['Sofá retrátil', 1],
      ['Poltronas da sala', 1],
    ]);
    expect(order.code).toBe(orderCode);
  });
});
