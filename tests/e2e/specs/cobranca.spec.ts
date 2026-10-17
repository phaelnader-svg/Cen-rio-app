import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Cobrança do cliente, no navegador (dados fictícios): Novo serviço R$ 4.000 com valor por peça
 * e condição 50/50 → o pedido mostra Financeiro (valor fechado, recebido, saldo, vencido) com a
 * entrada e o saldo na entrega; o escritório registra a entrada pela tela.
 */
const origin = `http://localhost:${E2E.webPort}`;

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('Cobrança do cliente', () => {
  test('Novo serviço 50/50 → Financeiro do pedido → recebimento da entrada', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const customer = await call(page, 'POST', '/api/v1/customers', {
      kind: 'PF',
      name: 'Cliente Cobrança E2E',
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Residência',
          street: 'Rua Fictícia de Teste',
          number: '40',
          district: 'Bairro Teste',
          city: 'Cidade Teste',
          state: 'SP',
          postalCode: '01000-000',
        },
      ],
    });
    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const svc = await call(page, 'POST', '/api/v1/services', {
      customer: { mode: 'EXISTENTE', customerId: customer.id, addressId: customer.addresses[0].id },
      service: {
        contractedService: 'Reforma',
        agreedValueCents: 400000,
        promisedDate: due,
        items: [
          {
            pieceType: 'SOFA',
            description: 'Sofá E2E',
            quantity: 1,
            serviceType: 'REFORMA_COMPLETA',
            agreedValueCents: 300000,
          },
          {
            pieceType: 'POLTRONA',
            description: 'Poltrona E2E',
            quantity: 1,
            serviceType: 'TROCA_DE_TECIDO',
            agreedValueCents: 100000,
          },
        ],
        payment: { model: 'ENTRADA_ENTREGA' },
      },
      pickup: null,
    });

    await page.goto(`/painel/pedidos/${svc.order.id}`);
    const fin = page.getByTestId('order-finance');
    await expect(fin.getByTestId('order-fin-final')).toHaveText('R$ 4.000,00');
    await expect(fin.getByTestId('order-fin-received')).toHaveText('R$ 0,00');
    await expect(fin.getByTestId('order-fin-open')).toHaveText('R$ 4.000,00');
    await expect(fin.getByTestId('order-fin-pieces')).toContainText('Sofá E2E: R$ 3.000,00');
    const rows = fin.getByTestId('fin-receivables');
    await expect(rows).toContainText('Entrada');
    await expect(rows).toContainText('Saldo na entrega');
    await expect(rows).toContainText('Na entrega');

    // Escritório registra a entrada (R$ 2.000) pela tela.
    await rows.locator('tr', { hasText: 'Entrada' }).getByRole('button', { name: 'Abrir' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Registrar recebimento' }).click();
    const form = page.getByRole('dialog').filter({ hasText: 'Registrar recebimento —' });
    await form.getByRole('button', { name: 'Salvar' }).click();
    await expect(dlg.getByTestId('receivable-received')).toHaveText('R$ 2.000,00');
    await page.keyboard.press('Escape');
    await expect(fin.getByTestId('order-fin-received')).toHaveText('R$ 2.000,00');
    await expect(fin.getByTestId('order-fin-open')).toHaveText('R$ 2.000,00');
  });
});
