import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { post } from './os-helpers';

/**
 * Correção global — fluxos novos no navegador (dados fictícios; nenhum pagamento real):
 *  1. Nova OS em seções com titular e mão de obra por peça (dois tapeceiros), resumo sem lucro.
 *  2. Retirada a partir do pedido com HORÁRIO ÚNICO de chegada, equipe André + Izaías,
 *     valor total R$ 100,00 e recebedor André.
 *  3. Roteiro do dia no painel: ordem pelo horário, gestor reordena (motivo), horário intacto,
 *     histórico registrado.
 *  4. André no celular vê o roteiro do dia na ordem do gestor, sem valores.
 */
const origin = `http://localhost:${E2E.webPort}`;
const evidence = (page: Page, name: string) =>
  process.env.E2E_GEOMETRIA
    ? page.screenshot({
        path: `../../docs/evidencias/interface/fluxos/${name}.png`,
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

async function customerOrder(page: Page, name: string, items: unknown[]) {
  const customer = await post(page, '/api/v1/customers', {
    kind: 'PF',
    name,
    phone: null,
    allowSimilar: true,
    addresses: [
      {
        label: 'Residência',
        street: 'Rua Fictícia do Roteiro',
        number: '100',
        district: 'Bairro Teste',
        city: 'Cidade Teste',
        state: 'SP',
        postalCode: '01000-000',
      },
    ],
  });
  const order = await post(page, '/api/v1/orders', {
    customerId: customer.id,
    pickupAddressId: customer.addresses[0].id,
    contractedService: 'Reforma completa',
    agreedValueCents: 300000,
    paymentTerms: 'À vista',
    items,
  });
  return { customer, order };
}

test.describe.serial('Correção global — OS completa e roteiro da logística', () => {
  test('OS com titular e mão de obra; retirada com chegada; roteiro reordenado; celular do André', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);

    // ── 1. Nova OS completa ──
    const { order } = await customerOrder(page, 'Cliente OS Completa E2E', [
      { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
      { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
    ]);
    await post(page, '/api/v1/receipts', {
      orderId: order.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      lines: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
        condition: 'BOA',
        location: 'Área de recebimento',
      })),
    });
    await page.goto(`/painel/os/nova?pedido=${order.id}`);
    const form = page.getByTestId('new-service-order');
    for (const s of [
      'Informações gerais',
      'Peças',
      'Responsável',
      'Valores comerciais',
      'Mão de obra',
      'Resumo',
    ])
      await expect(form.getByRole('heading', { name: s })).toBeVisible();
    await expect(page.getByTestId('so-contracted')).toHaveText('R$ 3.000,00');
    // Nomes de exibição variam (ex.: "Ricardo S."): escolhe pelo início do nome.
    const pick = async (testId: string, prefix: string) => {
      const sel = page.getByTestId(testId);
      const value = await sel.locator('option', { hasText: prefix }).first().getAttribute('value');
      await sel.selectOption(value!);
    };
    await pick('so-owner-0', 'Ricardo');
    await pick('so-owner-1', 'Márcio');
    await page.getByTestId('so-labor-value-0').fill('800,00');
    await page.getByTestId('so-labor-value-1').fill('450,00');
    await expect(page.getByTestId('so-labor-total')).toHaveText('R$ 1.250,00');
    await expect(page.getByTestId('so-balance')).toHaveText('R$ 1.750,00');
    await expect(form).toContainText('Não é lucro');
    await evidence(page, '01-nova-os-completa');
    await page.getByRole('button', { name: 'Criar OS' }).click();
    await expect(page).toHaveURL(/\/painel\/os\/[0-9a-f-]{36}$/);
    const soId = page.url().split('/').pop()!;
    const labor = await call(page, 'GET', `/api/v1/finance/service-orders/${soId}/labor`);
    const lines = JSON.stringify(labor);
    expect(lines).toContain('Ricardo');
    expect(lines).toContain('Márcio');
    expect(lines).toContain('80000');
    expect(lines).toContain('45000');

    // ── 2. Retirada com horário único de chegada, equipe e valor total ──
    const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
    const who = (n: string) =>
      (defaults.people as { userId: string; displayName: string }[]).find((p) =>
        p.displayName.startsWith(n),
      )!;
    const ANDRE = who('André');
    const IZAIAS = who('Izaías');
    await call(page, 'PUT', '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: defaults.defaultPickupCostCents ?? 8000,
      defaultDeliveryCostCents: defaults.defaultDeliveryCostCents ?? 12000,
      logisticsPayeeUserId: ANDRE.userId,
    });
    const day = today();
    const tarde = await customerOrder(page, 'Cliente Roteiro Tarde', [
      { pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1 },
    ]);
    const manha = await customerOrder(page, 'Cliente Roteiro Manhã', [
      { pieceType: 'CADEIRA', description: 'Cadeira', quantity: 1 },
    ]);
    await page.goto(`/painel/pedidos/${tarde.order.id}`);
    await page.getByRole('button', { name: 'Solicitar retirada' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Data do compromisso').fill(day);
    await expect(dlg.getByRole('button', { name: 'Solicitar e agendar' })).toBeDisabled();
    await dlg.getByLabel('Horário de chegada ao cliente').fill('16:00');
    await expect(dlg.getByText(/Janela — fim/)).toHaveCount(0);
    await dlg.getByTestId('pickup-executor').selectOption({ label: ANDRE.displayName });
    await dlg.getByTestId('trip-cost-amount').fill('100,00');
    await dlg.getByTestId(`trip-participant-${IZAIAS.displayName}`).check();
    await expect(dlg.getByTestId('trip-payee')).toContainText(`${ANDRE.displayName} (100%)`);
    await evidence(page, '02-retirada-horario-de-chegada');
    await dlg.getByRole('button', { name: 'Solicitar e agendar' }).click();
    await expect(page.getByTestId('order-status')).toContainText('Retirada agendada');
    // Segunda parada, mais cedo, pela API (mesmo contrato da tela).
    await post(page, '/api/v1/pickups', {
      orderId: manha.order.id,
      scheduledDate: day,
      windowStart: '09:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      logisticsUserId: ANDRE.userId,
      items: manha.order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });

    // ── 3. Roteiro do dia no painel ──
    await page.goto(`/painel/roteiro?data=${day}`);
    const stops = page.getByTestId('route-stops');
    const tardeStop = stops.locator('li').filter({ hasText: 'Cliente Roteiro Tarde' });
    const manhaStop = stops.locator('li').filter({ hasText: 'Cliente Roteiro Manhã' });
    await expect(tardeStop).toContainText('chegada 16:00');
    const pos = async (l: typeof tardeStop) => Number(await l.getAttribute('data-position'));
    expect(await pos(manhaStop)).toBeLessThan(await pos(tardeStop));
    const tardeCode = (await tardeStop.locator('.font-mono').first().textContent())!.trim();
    // Gestor põe a da tarde antes da da manhã (prioridade operacional).
    while ((await pos(tardeStop)) > (await pos(manhaStop)))
      await tardeStop.getByRole('button', { name: `Mover ${tardeCode} para cima` }).click();
    const save = page.getByTestId('route-save');
    await save.getByLabel('Motivo da nova ordem (opcional)').fill('Cliente pediu prioridade');
    await save.getByRole('button', { name: 'Salvar sequência' }).click();
    await expect(save).toHaveCount(0);
    await expect(tardeStop).toContainText('chegada 16:00');
    await expect(manhaStop).toContainText('confira o deslocamento');
    await expect(page.getByTestId('route-history')).toContainText('Cliente pediu prioridade');
    await evidence(page, '03-roteiro-gestor');

    // ── 4. André no celular: roteiro de hoje, na ordem do gestor, sem valores ──
    await setPin(page, 'André', '640218');
    const code = await registerDevice(page, 'Celular André (roteiro)', 'André');
    const andre = await openTablet(browser, code, '640218', {
      width: 390,
      height: 844,
      isMobile: true,
    });
    const at = andre.page;
    await expect(at.getByTestId('logistics-route')).toBeVisible();
    const tardeA = at.getByTestId(`route-stop-${tardeCode}`);
    await expect(tardeA).toContainText('chegada 16:00');
    await expect(tardeA.getByLabel('Parada 1')).toBeVisible();
    await expect(at.getByText(/R\$/)).toHaveCount(0);
    expect(
      await at.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(2);
    await evidence(at, '04-celular-andre-roteiro');
    await andre.context.close();
  });
});
