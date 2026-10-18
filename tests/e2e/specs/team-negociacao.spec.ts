import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { post } from './os-helpers';

/**
 * R2 — negociação de valores + confirmação semanal + portão de pagamento (D13). Dados fictícios;
 * nenhum pagamento real. Retirada realizada → André deve R$ 100,00 → no celular, pede R$ 120,00
 * → o gestor aprova → sem a conferência do André o Pix é recusado → André confere a semana →
 * o gestor registra o Pix.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const mondayOf = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
const WEEK = mondayOf(today());
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/r2/${name}.png`, fullPage: true })
    : Promise.resolve();

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('R2 — negociação, confirmação semanal e portão de pagamento', () => {
  test('pedido no celular → aprovação → sem confirmação recusado → André confere → Pix', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
    const ANDRE = (defaults.people as { userId: string; displayName: string }[]).find((p) =>
      p.displayName.startsWith('André'),
    )!;
    await call(page, 'PUT', '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: null,
      defaultDeliveryCostCents: null,
      logisticsPayeeUserId: ANDRE.userId,
    });

    // ── Retirada realizada com custo de R$ 100,00 (obrigação do André nesta semana) ──
    const customer = await post(page, '/api/v1/customers', {
      kind: 'PF',
      name: 'Cliente Negociação E2E',
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Residência',
          street: 'Rua Fictícia de Teste',
          number: '30',
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
      contractedService: 'Reforma',
      agreedValueCents: 90000,
      paymentTerms: 'À vista',
      items: [{ pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1 }],
    });
    const pickup = await post(page, '/api/v1/pickups', {
      orderId: order.id,
      scheduledDate: today(),
      windowStart: '09:00',
      windowEnd: '12:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
    await call(page, 'PUT', '/api/v1/finance/trip-costs', {
      pickupId: pickup.id,
      amountCents: 10000,
    });
    for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
      const cur = await call(page, 'GET', `/api/v1/pickups/${pickup.id}`);
      await call(page, 'POST', `/api/v1/pickups/${pickup.id}/transition`, {
        toStatus,
        version: cur.version,
      });
    }
    const cost = (await call(page, 'GET', `/api/v1/finance/trip-costs?pickupId=${pickup.id}`))
      .cost as { id: string; code: string; dueCents: number };
    expect(cost.dueCents).toBe(10000);

    // ── André (celular): Meus Ganhos com PIN → "Solicitar alteração" ──
    await setPin(page, ANDRE.displayName, '640218');
    const a = await openTablet(
      browser,
      await registerDevice(page, 'Celular André (R2)', ANDRE.displayName),
      '640218',
      { width: 390, height: 844, isMobile: true },
    );
    const at = a.page;
    const unlock = async () => {
      await at.getByTestId('tile-values').click();
      await at.getByTestId('my-values-pin').fill('640218');
      await at.getByTestId('my-values-unlock').click();
      await expect(at.getByTestId('my-values')).toBeVisible();
    };
    await unlock();
    const item = at.getByTestId(`my-value-${cost.code}`);
    await expect(item).toContainText('R$ 100,00');
    await item.getByTestId(`my-value-ask-${cost.code}`).click();
    const form = at.getByTestId(`my-value-ask-form-${cost.code}`);
    await form.getByTestId('ask-value').fill('120,00');
    await form.getByTestId('ask-reason').fill('Pedágio e espera no cliente');
    await form.getByTestId('ask-submit').click();
    await expect(at.getByTestId(`my-value-request-${cost.code}`)).toContainText('Pendente');
    // Pedido pendente: a semana não pode ser confirmada.
    await at.getByTestId('week-confirm-open').click();
    await expect(at.getByTestId('week-confirm-panel')).toContainText(
      'pedido de alteração pendente',
    );
    await expect(at.getByTestId('week-confirm-submit')).toBeDisabled();
    await evidence(at, '01-celular-pedido-pendente');

    // ── Gestor: Fechamento semanal → aprovar o pedido; Pix sem confirmação é recusado ──
    await page.goto('/painel/financeiro');
    await page.getByRole('tab', { name: 'Fechamento semanal' }).click();
    const requests = page.getByTestId('value-requests');
    const req = requests.locator('tr', { hasText: cost.code });
    await expect(req).toContainText('R$ 120,00');
    await expect(req).toContainText('Pedágio e espera no cliente');
    await evidence(page, '02-painel-pedido');
    await req.getByTestId('value-request-approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Aprovar' }).click();
    await expect(page.getByTestId('value-requests')).toHaveCount(0);
    const refused = await page.request.post(`/api/v1/finance/weekly-closings/${WEEK}/payments`, {
      data: {
        beneficiaryUserId: ANDRE.userId,
        category: 'LOGISTICA',
        amountCents: 12000,
        paidAt: today(),
        method: 'PIX',
      },
      headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
    });
    expect(refused.status()).toBe(422);
    expect(await refused.text()).toMatch(/não foi confirmada/);
    const andreRow = page.getByTestId(`closing-row-${ANDRE.displayName}-LOGISTICA`);
    await expect(
      andreRow.getByTestId(`closing-confirmation-${ANDRE.displayName}-LOGISTICA`),
    ).not.toContainText('Confirmada pelo profissional');

    // ── André confere a semana (valor aprovado) e confirma ──
    await at.reload();
    await unlock();
    await expect(at.getByTestId(`my-value-${cost.code}`)).toContainText('R$ 120,00');
    await expect(at.getByTestId(`my-value-request-${cost.code}`)).toContainText('Aprovad');
    await at.getByTestId('week-confirm-open').click();
    await expect(at.getByTestId('week-confirm-panel')).toContainText(cost.code);
    await at.getByTestId('week-confirm-check').check();
    await evidence(at, '03-celular-conferir-semana');
    await at.getByTestId('week-confirm-submit').click();
    await expect(at.getByTestId('week-confirmation-state')).toHaveText(
      'Confirmada pelo profissional',
    );
    // O celular do André não lê o fechamento geral.
    expect((await at.request.get(`/api/v1/finance/weekly-closings/${WEEK}`)).status()).toBe(403);
    await a.context.close();

    // ── Gestor: semana confirmada → Pix de R$ 120,00 registrado ──
    await page.reload();
    await page.getByRole('tab', { name: 'Fechamento semanal' }).click();
    await expect(
      andreRow.getByTestId(`closing-confirmation-${ANDRE.displayName}-LOGISTICA`),
    ).toContainText('Confirmada pelo profissional');
    await andreRow.getByTestId('closing-pay').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('closing-pay-amount').fill('120,00');
    await dlg.getByTestId('closing-pay-review').click();
    await expect(dlg.getByTestId('closing-pay-summary')).toContainText('R$ 120,00');
    await dlg.getByTestId('closing-pay-confirm').click();
    await expect(page.getByTestId('closing-payments')).toContainText('R$ 120,00');
    await evidence(page, '04-painel-pix-apos-confirmacao');
    const after = await call(page, 'GET', `/api/v1/finance/trip-costs?pickupId=${pickup.id}`);
    expect(after.cost).toMatchObject({ dueCents: 12000 });
  });
});
