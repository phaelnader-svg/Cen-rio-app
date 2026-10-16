import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Compras e materiais sem duplicidade (Etapa 2), no navegador, com dados fictícios: a nova
 * medição do sofá vem com "Substitui: …" pré-selecionado (candidato único e seguro), a aprovação
 * substitui a necessidade anterior e a aba Materiais mostra "Necessidade alterada: 10 → 8" sem
 * somar as duas.
 */
const origin = `http://localhost:${E2E.webPort}`;
const FABRIC = 'Linho E2E Etapa2';

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

/** Medição enviada pela API (o fluxo de telas da medição está em measurements.spec). */
async function submitted(page: Page, serviceOrderId: string, items: unknown[]) {
  const me = await call(page, 'GET', '/api/auth/me');
  const d = new Date(Date.now() + 86_400_000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  const m = await call(page, 'POST', '/api/v1/measurements', {
    serviceOrderId,
    kind: 'EXTRAORDINARIA',
    reason: 'Remedição E2E',
    assigneeUserId: me.user.id,
    dueDate: d.toISOString().slice(0, 10),
  });
  const draft = await call(page, 'PUT', `/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items,
    version: m.version,
  });
  const sub = await call(page, 'POST', `/api/v1/measurements/${m.id}/submit`, {
    version: draft.version,
  });
  return { id: m.id as string, version: sub.request.version as number };
}

const linen = (serviceOrderItemId: string, quantity: number) => ({
  kind: 'TECIDO',
  sourcing: 'EXCLUSIVO_OS',
  serviceOrderItemId,
  description: FABRIC,
  color: 'Cru',
  quantity,
  unit: 'METRO',
});

test.describe.serial('Compras e materiais sem duplicidade — Etapa 2', () => {
  test('remedição substitui a necessidade (decisão na aprovação) e não soma', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const so = await openServiceOrder(page, 'Cliente Etapa2 E2E');
    const sofa = so.items[0]!.id;
    const first = await submitted(page, so.id, [linen(sofa, 10)]);
    await call(page, 'POST', `/api/v1/measurements/${first.id}/request/approve`, {
      version: first.version,
    });
    const second = await submitted(page, so.id, [linen(sofa, 8)]);

    await page.goto(`/painel/medicoes/${second.id}`);
    await page.getByRole('button', { name: 'Iniciar revisão' }).click();
    await page.getByRole('button', { name: 'Aprovar para compra' }).click();
    const dlg = page.getByRole('dialog');
    const box = dlg.getByTestId('substitution');
    await expect(box).toBeVisible();
    // Candidato único e seguro (mesma peça e tipo): pré-selecionado, o gestor só confirma.
    const select = box.locator('select');
    await expect(select.locator('option:checked')).toContainText(`Substitui: ${FABRIC} Cru — 10 m`);
    await dlg.getByRole('button', { name: 'Aprovar' }).click();
    await expect(dlg).toBeHidden();

    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: /Materiais/ }).click();
    const lines = page.getByTestId('os-material-lines');
    await expect(lines.locator('tbody tr')).toHaveCount(1);
    await expect(lines).toContainText('Necessidade alterada: 10 metros → 8 metros');
    await expect(page.getByTestId('materials')).toContainText('Substituído por nova medição');
  });
});
