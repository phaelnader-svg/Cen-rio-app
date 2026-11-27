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

/**
 * Recebimentos removidos: "Peças na oficina" marca as peças do pedido como chegadas (opcional; a
 * OS não depende disso, mas mantém o pedido no estado em que os testes o esperam).
 */
export async function markArrived(page: Page, orderId: string, version: number) {
  const r = await page.request.post(`/api/v1/orders/${orderId}/arrived`, {
    data: { version },
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `/api/v1/orders/${orderId}/arrived: ${await r.text()}`).toBe(true);
  return r.json();
}

/**
 * Fluxo da OS (2026-11-18): o fechamento do serviço não gera OS. Gera a OS do pedido como a tela
 * "Gerar ordem de serviço" (todas as peças livres, dados do pedido) com o material já comprado.
 */
export async function generateOs(page: Page, orderId: string) {
  const r = await page.request.get(`/api/v1/service-orders/available?orderId=${orderId}`, {
    headers: { origin },
  });
  expect(r.ok(), await r.text()).toBe(true);
  const a = (await r.json()) as {
    order: { technicalNotes: string | null; promisedDate: string | null };
    items: {
      orderItemId: string;
      description: string;
      available: number;
      serviceType: string | null;
      fabricName: string | null;
      technicalNotes: string | null;
      plannedUpholstererUserId: string | null;
      plannedLaborUnitCents: number | null;
    }[];
  };
  return post(page, '/api/v1/service-orders', {
    orderId,
    materialPurchased: true,
    technicalInstructions: a.order.technicalNotes,
    promisedDate: a.order.promisedDate,
    items: a.items
      .filter((i) => i.available > 0)
      .map((i) => ({
        orderItemId: i.orderItemId,
        quantity: i.available,
        description: i.description,
        serviceType: i.serviceType ?? 'OUTRO',
        fabricName: i.fabricName,
        technicalNotes: i.technicalNotes,
        ...(i.plannedUpholstererUserId
          ? {
              upholstererUserId: i.plannedUpholstererUserId,
              ...(i.plannedLaborUnitCents
                ? {
                    labor: {
                      agreedCents: i.plannedLaborUnitCents * i.available,
                      eligibility: 'QUALIDADE_APROVADA',
                    },
                  }
                : {}),
            }
          : {}),
      })),
  }) as Promise<{ id: string; code: string; items: { id: string; code: string }[] }>;
}

/** Cliente → pedido → peças na oficina → OS aberta (sofá + poltronas). */
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
  await markArrived(page, order.id, order.version);
  return post(page, '/api/v1/service-orders', {
    orderId: order.id,
    materialPurchased: true,
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
