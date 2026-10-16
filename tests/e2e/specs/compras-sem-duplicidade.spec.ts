import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Compras e materiais sem duplicidade (Etapa 1), no navegador, com dados fictícios:
 *  1. "A comprar" consolida o material de duas OS: necessidade 15, estoque livre 8 → sugestão 7.
 *  2. "Reservar" é a ação explícita que liga o estoque livre a uma OS (nada é reservado sozinho).
 *  3. Recusa no recebimento exige decisão: "Não repor" devolve a quantidade para A comprar.
 */
const origin = `http://localhost:${E2E.webPort}`;
const STAPLE = 'Grampos E2E Consolidado';
const FABRIC = 'Linho E2E Recusa';

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

/** Medição de rotina enviada e aprovada pela API (o fluxo de telas está em measurements.spec). */
async function approve(page: Page, serviceOrderId: string, items: unknown[]) {
  const me = await call(page, 'GET', '/api/auth/me');
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const m = await call(page, 'POST', '/api/v1/measurements', {
    serviceOrderId,
    kind: 'ROTINA',
    assigneeUserId: me.user.id,
    dueDate: due,
  });
  const draft = await call(page, 'PUT', `/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items,
    version: m.version,
  });
  const sub = await call(page, 'POST', `/api/v1/measurements/${m.id}/submit`, {
    version: draft.version,
  });
  await call(page, 'POST', `/api/v1/measurements/${m.id}/request/approve`, {
    version: sub.request.version,
  });
}
const staple = (quantity: number) => ({
  kind: 'OUTRO',
  sourcing: 'ESTOQUE',
  description: STAPLE,
  quantity,
  unit: 'EMBALAGEM',
});

test.describe.serial('Compras e materiais sem duplicidade', () => {
  test('A comprar consolidado com estoque livre, Reservar explícito e recusa "Não repor"', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);

    // Duas OS precisam do mesmo material comum; há 8 livres no estoque.
    const a = await openServiceOrder(page, 'Cliente Compra A E2E');
    const b = await openServiceOrder(page, 'Cliente Compra B E2E');
    await approve(page, a.id, [staple(10)]);
    await approve(page, b.id, [staple(5)]);
    const stock = await call(page, 'POST', '/api/v1/stock-items', {
      kind: 'OUTRO',
      description: STAPLE,
      unit: 'EMBALAGEM',
    });
    await call(page, 'POST', `/api/v1/stock-items/${stock.id}/adjust`, {
      quantity: 8,
      reason: 'Inventário E2E',
    });

    // 1. Uma linha consolidada; a sugestão desconta o estoque livre.
    await page.goto('/painel/compras');
    const card = page.getByTestId(`shortage-${STAPLE}`);
    await expect(card.getByTestId(`free-${STAPLE}`)).toHaveText(/^8 /);
    await expect(card.getByTestId(`suggestion-${STAPLE}`)).toHaveText(/^7 /);
    await expect(card.getByTestId(`need-${a.code}-${STAPLE}`)).toBeVisible();
    await expect(card.getByTestId(`need-${b.code}-${STAPLE}`)).toBeVisible();
    await expect(card.getByText('ainda não está reservado para nenhuma OS')).toBeVisible();

    // 2. Reservar (ação explícita) liga o livre à OS escolhida.
    await card.getByRole('button', { name: 'Reservar' }).click();
    const dlg = page.getByRole('dialog');
    const option = dlg.locator('option', { hasText: a.code });
    await dlg.getByLabel('Para a OS').selectOption((await option.getAttribute('value'))!);
    await dlg.getByLabel('Quantidade').fill('8');
    await dlg.getByRole('button', { name: 'Reservar' }).click();
    await expect(dlg).toBeHidden();
    await expect(card.getByTestId(`free-${STAPLE}`)).toHaveText(/^0 /);
    await expect(card.getByTestId(`to-buy-${a.code}-${STAPLE}`)).toHaveText(/^2 /);
    await expect(card.getByTestId(`suggestion-${STAPLE}`)).toHaveText(/^7 /);

    // 3. Tecido comprado e recebido com recusa: decisão explícita "Não repor".
    await approve(page, a.id, [
      {
        kind: 'TECIDO',
        sourcing: 'EXCLUSIVO_OS',
        serviceOrderItemId: a.items[0].id,
        description: FABRIC,
        color: 'Cru',
        quantity: 10,
        unit: 'METRO',
      },
    ]);
    const needs = await call(page, 'GET', '/api/v1/purchasing/needs');
    const req = needs.find((n: { description: string }) => n.description === FABRIC);
    const supplier = await call(page, 'POST', '/api/v1/suppliers', {
      name: 'Fornecedor Recusa E2E',
      categories: ['TECIDO'],
    });
    const po = await call(page, 'POST', '/api/v1/purchase-orders', {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: req.requirementId, quantity: 10 }],
          quantity: 10,
          unitPriceCents: 3000,
        },
      ],
    });
    await call(page, 'POST', `/api/v1/purchase-orders/${po.id}/confirm`, { version: po.version });
    await call(page, 'POST', '/api/v1/material-receipts', {
      purchaseOrderId: po.id,
      lines: [
        {
          purchaseOrderItemId: po.items[0].id,
          acceptedQuantity: 6,
          rejectedQuantity: 4,
          specConfirmed: true,
          issue: 'DANIFICADO',
          issueNote: 'Rolo manchado',
        },
      ],
    });

    await page.goto(`/painel/compras/${po.id}`);
    await expect(page.getByTestId('po-status')).toContainText('aguardando decisão');
    await page.getByRole('button', { name: 'Decidir recusa' }).click();
    const rd = page.getByRole('dialog');
    // Nada vem marcado: sem escolha, não registra.
    await expect(rd.getByRole('button', { name: 'Registrar decisão' })).toBeDisabled();
    await rd.getByTestId('rejection-NAO_REPOR').check();
    await rd.getByRole('button', { name: 'Registrar decisão' }).click();
    await expect(rd).toBeHidden();
    await expect(page.getByText('Recusa: não será reposta — voltou para A comprar.')).toBeVisible();

    await page.goto('/painel/compras');
    const fabric = page.getByTestId(`shortage-${FABRIC}`);
    await expect(fabric.getByTestId(`to-buy-${a.code}-${FABRIC}`)).toHaveText(/^4 /);
    await expect(fabric.getByTestId(`suggestion-${FABRIC}`)).toHaveText(/^4 /);
  });
});
