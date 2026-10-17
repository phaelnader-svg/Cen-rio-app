import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Compra antes da chegada (Etapa 3), no navegador, com dados fictícios: o gestor prevê o tecido
 * na peça do pedido ("Previsão — não medido"), a previsão aparece em Compras → A comprar como
 * "Pré-chegada", a peça chega (OS criada, vínculo automático: quantidade 1) e a medição real
 * substitui a previsão — "Previsto 12 m / Medido 10 m / Substitui previsão".
 */
const origin = `http://localhost:${E2E.webPort}`;
const FABRIC = 'Veludo E2E Etapa3';

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

async function submitted(page: Page, serviceOrderId: string, items: unknown[]) {
  const me = await call(page, 'GET', '/api/auth/me');
  const d = new Date(Date.now() + 86_400_000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  const m = await call(page, 'POST', '/api/v1/measurements', {
    serviceOrderId,
    kind: 'EXTRAORDINARIA',
    reason: 'Medição real E2E',
    assigneeUserId: me.user.id,
    dueDate: d.toISOString().slice(0, 10),
  });
  const draft = await call(page, 'PUT', `/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items,
    version: m.version,
  });
  await call(page, 'POST', `/api/v1/measurements/${m.id}/submit`, { version: draft.version });
  return m.id as string;
}

test.describe.serial('Compra antes da chegada — Etapa 3', () => {
  test('previsão no pedido → Pré-chegada → chegada → medição substitui', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const customer = await call(page, 'POST', '/api/v1/customers', {
      kind: 'PF',
      name: 'Cliente Etapa3 E2E',
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
    const order = await call(page, 'POST', '/api/v1/orders', {
      customerId: customer.id,
      pickupAddressId: customer.addresses[0].id,
      contractedService: 'Reforma',
      agreedValueCents: 100000,
      paymentTerms: 'À vista',
      items: [{ pieceType: 'SOFA', description: 'Sofá Etapa3', quantity: 1 }],
    });

    // 1. "Prever material" na peça do pedido (antes de chegar).
    await page.goto(`/painel/pedidos/${order.id}`);
    const piece = page.getByTestId('forecast-piece-1');
    await expect(page.getByTestId('order-forecast-hint')).toContainText('Previsão — não medido');
    await piece.getByRole('button', { name: 'Prever tecido' }).click();
    await piece.getByLabel('Tecido (nome ou referência)').fill(FABRIC);
    await piece.getByLabel('Cor').fill('Azul');
    await piece.getByLabel('Metragem (m)').fill('12');
    await piece.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(piece).toContainText(`${FABRIC} Azul`);
    await expect(piece).toContainText('Previsão — não medido');
    await expect(piece).toContainText('Pré-chegada');

    // 2. A comprar: linha "Pré-chegada" com pedido, peça e prazo prometido como contexto.
    await page.goto('/painel/compras');
    const row = page.getByTestId(`need-${order.code}-${FABRIC}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Pré-chegada');
    await expect(row).toContainText('Previsão — não medido');
    await expect(row).toContainText('Sofá Etapa3');
    await expect(page.getByTestId(`to-buy-${order.code}-${FABRIC}`)).toHaveText(/^12 /);

    // 3. A peça chega: OS criada; quantidade 1 → vínculo automático.
    await call(page, 'POST', '/api/v1/receipts', {
      orderId: order.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      lines: [{ orderItemId: order.items[0].id, quantity: 1, condition: 'BOA', location: 'Área' }],
    });
    const so = await call(page, 'POST', '/api/v1/service-orders', {
      orderId: order.id,
      items: [
        {
          orderItemId: order.items[0].id,
          quantity: 1,
          description: 'Sofá Etapa3',
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    });

    // 4. Medição real: 10 m substitui a previsão de 12 m (decisão na aprovação).
    const mId = await submitted(page, so.id, [
      {
        kind: 'TECIDO',
        sourcing: 'EXCLUSIVO_OS',
        serviceOrderItemId: so.items[0].id,
        description: FABRIC,
        color: 'Azul',
        quantity: 10,
        unit: 'METRO',
      },
    ]);
    await page.goto(`/painel/medicoes/${mId}`);
    await page.getByRole('button', { name: 'Iniciar revisão' }).click();
    await page.getByRole('button', { name: 'Aprovar para compra' }).click();
    const dlg = page.getByRole('dialog');
    const box = dlg.getByTestId('substitution');
    await expect(box.locator('select option:checked')).toContainText('Substitui previsão:');
    await expect(box.getByTestId('forecast-compare')).toHaveText(
      'Previsto 12 m / Medido 10 m / Substitui previsão',
    );
    await dlg.getByRole('button', { name: 'Aprovar' }).click();
    await expect(dlg).toBeHidden();

    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: /Materiais/ }).click();
    const lines = page.getByTestId('os-material-lines');
    await expect(lines.locator('tbody tr')).toHaveCount(1);
    await expect(lines).toContainText('Previsto 12 metros / Medido 10 metros / Substitui previsão');
  });
});
