import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Remediação pós-auditoria (F2-08) — chave de idempotência do "Novo serviço" no navegador:
 * o envio CHEGA ao servidor e é gravado (pedido, retirada e cobranças 50/50), mas a resposta se
 * perde na rede. A tela avisa que não conseguiu confirmar; ao salvar de novo sem alterar nada,
 * reaproveita a MESMA chave e mostra o serviço já criado — um pedido, uma retirada, um conjunto
 * de cobranças, para o cliente existente.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const promised = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const LOST =
  'Não foi possível confirmar se o serviço foi salvo. Toque em salvar de novo sem alterar nada: se ele já foi registrado, o sistema mostra o mesmo serviço e não cria outro.';

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('Novo serviço: resposta perdida depois da gravação não duplica (mesma chave)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const customer = await call(page, 'POST', '/api/v1/customers', {
    kind: 'PF',
    name: 'Clara Rede Novo Serviço',
    phone: null,
    allowSimilar: true,
    addresses: [
      {
        label: 'Residência',
        street: 'Rua da Rede',
        number: '7',
        district: 'Bairro Fictício',
        postalCode: '01000-000',
        city: 'Cidade Teste',
        state: 'SP',
        isPrimary: true,
      },
    ],
  });

  const keys: string[] = [];
  let attempt = 0;
  await page.route('**/api/v1/services', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (attempt++ === 0) {
      // O servidor recebe e grava; a resposta não chega ao navegador.
      const served = await route.fetch();
      expect(served.status()).toBe(201);
      await route.abort('connectionreset');
    } else await route.continue();
  });

  await page.goto('/painel/servicos/novo');
  await page.getByTestId('ns-mode-existing').click();
  await page.getByTestId('ns-customer-search').fill('Clara Rede');
  await page
    .getByTestId('ns-customer-results')
    .getByRole('button', { name: /Clara Rede Novo Serviço/ })
    .click();
  await page.getByTestId('ns-piece-desc-0').fill('Sofá da rede');
  await page.getByTestId('ns-promised').fill(promised());
  await page.getByTestId('ns-value').fill('2.000,00');
  await expect(page.getByTestId('ns-pay-model')).toHaveValue('ENTRADA_ENTREGA');
  await page.getByTestId('ns-date').fill(today());
  await page.getByTestId('ns-arrival').fill('22:30');
  await page.getByTestId('ns-team-own').click();

  await page.getByTestId('ns-submit').click();
  await expect(page.getByTestId('ns-error')).toContainText(LOST);
  await expect(page.getByTestId('ns-confirmation')).toHaveCount(0);

  // Gravado no servidor apesar do erro na tela.
  const orders = (
    (await call(page, 'GET', `/api/v1/orders?customerId=${customer.id}`)) as {
      items: { id: string; code: string }[];
    }
  ).items;
  expect(orders).toHaveLength(1);

  // Nova tentativa sem alterar nada: mesma chave, mesmo serviço.
  await page.getByTestId('ns-submit').click();
  await expect(page.getByTestId('ns-confirmation')).toBeVisible();
  await expect(page.getByTestId('ns-done-order')).toHaveText(orders[0]!.code);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);

  const after = (
    (await call(page, 'GET', `/api/v1/orders?customerId=${customer.id}`)) as {
      items: { id: string }[];
    }
  ).items;
  expect(after).toHaveLength(1);
  const pickups = (await call(page, 'GET', `/api/v1/pickups?orderId=${after[0]!.id}`)) as unknown[];
  expect(pickups).toHaveLength(1);
  const receivables = (await call(
    page,
    'GET',
    `/api/v1/finance/receivables?orderId=${after[0]!.id}`,
  )) as unknown[];
  expect(receivables).toHaveLength(2);
});
