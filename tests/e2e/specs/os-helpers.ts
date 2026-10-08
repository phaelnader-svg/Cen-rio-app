import { expect, type Page } from '@playwright/test';
import { E2E } from '../env';

/** OS aberta criada pela API (o fluxo comercial é coberto pela Fase 2). Dados fictícios. */
const origin = `http://localhost:${E2E.webPort}`;

export async function post(page: Page, path: string, data: unknown) {
  const r = await page.request.post(path, {
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.status(), `${path}: ${await r.text()}`).toBe(201);
  return r.json();
}

/** Cliente → pedido → recebimento → OS aberta (sofá + poltronas). */
export async function openServiceOrder(page: Page, name: string) {
  const customer = await post(page, '/api/v1/customers', {
    kind: 'PF',
    name,
    phone: null,
    allowSimilar: true,
    addresses: [
      {
        label: 'Residência',
        street: 'Rua Fictícia de Teste',
        number: '10',
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
    agreedValueCents: 100000,
    paymentTerms: 'À vista',
    items: [
      { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
      { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
    ],
  });
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
  return post(page, '/api/v1/service-orders', {
    orderId: order.id,
    items: [
      {
        orderItemId: order.items[0].id,
        quantity: 1,
        description: 'Sofá 3 lugares',
        serviceType: 'REFORMA_COMPLETA',
      },
      {
        orderItemId: order.items[1].id,
        quantity: 2,
        description: 'Poltronas',
        serviceType: 'TROCA_DE_TECIDO',
      },
    ],
  }) as Promise<{ id: string; code: string; items: { id: string; code: string }[] }>;
}
