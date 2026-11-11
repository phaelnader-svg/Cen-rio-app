import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder, post } from './os-helpers';

/**
 * Reformulação, Fase 1 — tela de conciliação do custo de material (lacuna apontada na revisão:
 * a regra estava provada na API, mas a interface nunca tinha sido exercitada no navegador).
 *
 * Preparação pela API (mesmos passos do fluxo formal): OS → medição aprovada para compra →
 * fornecedor → pedido exclusivo confirmado → recebimento (12 m × R$ 45 = R$ 540). Depois, PELA
 * TELA: custo informado na lista da OS, aviso de pendência, vincular, desfazer e "é outro
 * material", conferindo o realizado no resultado financeiro em cada passo. Dados fictícios.
 */
const origin = `http://localhost:${E2E.webPort}`;
async function call(page: Page, method: 'PUT' | 'POST', path: string, data: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
  return r.json();
}
function nextFriday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Realizado de materiais no detalhe do resultado da OS (Financeiro → Custos e resultado). */
async function realizedMaterials(page: Page, code: string) {
  await page.goto('/painel/financeiro?tab=custos');
  await page.getByTestId(`result-${code}`).getByRole('button', { name: 'Detalhar' }).click();
  const detail = page.getByTestId('result-detail');
  await expect(detail).toBeVisible();
  const text = await detail.innerText();
  await page.keyboard.press('Escape');
  return text;
}

test('conciliação pela tela: pendente, vincular sem dupla contagem, desfazer e "é outro material"', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAdmin(page);
  const so = await openServiceOrder(page, 'Cliente Fictício Conciliação Tela');
  const me = await (await page.request.get('/api/auth/me')).json();
  // Medição aprovada para compra (tecido exclusivo da OS).
  const m = await post(page, '/api/v1/measurements', {
    serviceOrderId: so.id,
    kind: 'ROTINA',
    assigneeUserId: me.user.id,
    dueDate: nextFriday(),
  });
  const draft = await call(page, 'PUT', `/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items: [
      {
        kind: 'TECIDO',
        sourcing: 'EXCLUSIVO_OS',
        description: 'Linho fictício',
        color: 'Bege',
        quantity: 12,
        unit: 'METRO',
        serviceOrderItemId: so.items[0]!.id,
      },
    ],
    version: m.version,
  });
  const submitted = await call(page, 'POST', `/api/v1/measurements/${m.id}/submit`, {
    version: draft.version,
  });
  await call(page, 'POST', `/api/v1/measurements/${m.id}/request/approve`, {
    version: submitted.request.version,
  });
  const needs = await (await page.request.get('/api/v1/purchasing/needs')).json();
  const need = needs.find(
    (n: { serviceOrder: { id: string } | null }) => n.serviceOrder?.id === so.id,
  );
  expect(need, 'necessidade aprovada da OS').toBeTruthy();
  const supplier = await post(page, '/api/v1/suppliers', {
    name: 'Fornecedor Fictício Conciliação',
    phone: '(11) 4000-0000',
    categories: ['TECIDO'],
  });
  const po = await post(page, '/api/v1/purchase-orders', {
    supplierId: supplier.id,
    expectedDate: '2030-01-10',
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: need.requirementId, quantity: 12 }],
        quantity: 12,
        unitPriceCents: 4500,
      },
    ],
  });
  const confirmed = await call(page, 'POST', `/api/v1/purchase-orders/${po.id}/confirm`, {
    version: po.version,
  });
  await post(page, '/api/v1/material-receipts', {
    purchaseOrderId: po.id,
    lines: [
      { purchaseOrderItemId: confirmed.items[0].id, acceptedQuantity: 12, specConfirmed: true },
    ],
  });

  // Pela tela: o mesmo tecido anotado com custo na lista da OS.
  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  const list = page.getByTestId('os-material-list');
  const add = page.getByTestId('os-material-add');
  await add.getByLabel('Novo material').fill('Linho anotado na OS');
  await add.getByLabel('Custo (opcional)').fill('540,00');
  await add.locator('label', { hasText: 'Comprado' }).locator('input').check();
  await add.getByRole('button', { name: 'Adicionar' }).click();
  const row = list.getByTestId('os-material-row').filter({ hasText: 'Linho anotado na OS' });
  await expect(row).toBeVisible();
  // Valores iguais NÃO são presumidos iguais: pendente, com o valor em risco.
  await expect(page.getByTestId('os-material-reconcile-notice')).toContainText(
    'Conciliação pendente: 1 material(is)',
  );
  await expect(page.getByTestId('os-material-reconcile-notice')).toContainText('R$ 540,00');
  await expect(row.getByTestId('os-material-reconciliation')).toContainText(
    'Conciliar com a compra formal',
  );
  let detail = await realizedMaterials(page, so.code);
  expect(detail).toMatch(/consumido\/destinado\s*R\$\s*1\.080,00/);
  expect(detail).toContain('Conciliação pendente');

  // Vincular à compra formal.
  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  const recon = list
    .getByTestId('os-material-row')
    .filter({ hasText: 'Linho anotado na OS' })
    .getByTestId('os-material-reconciliation');
  const compra = await recon
    .locator('select option', { hasText: 'Compra CP-' })
    .first()
    .getAttribute('value');
  await recon.locator('select').selectOption(compra!);
  await recon.getByRole('button', { name: 'Vincular' }).click();
  await expect(recon).toContainText('Mesmo material da compra formal');
  await expect(page.getByTestId('os-material-reconcile-notice')).toHaveCount(0);
  detail = await realizedMaterials(page, so.code);
  expect(detail).toMatch(/consumido\/destinado\s*R\$\s*540,00/);
  expect(detail).not.toContain('Conciliação pendente');

  // Desfazer: volta a pendente e a contar.
  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  await recon.getByRole('button', { name: 'Desfazer conciliação' }).click();
  await expect(recon).toContainText('Conciliar com a compra formal');
  detail = await realizedMaterials(page, so.code);
  expect(detail).toMatch(/consumido\/destinado\s*R\$\s*1\.080,00/);

  // É outro material: continua contando, sem aviso de pendência.
  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  await recon.getByRole('button', { name: 'É outro material' }).click();
  await expect(recon).toContainText('Outro material (conta à parte)');
  await expect(page.getByTestId('os-material-reconcile-notice')).toHaveCount(0);
  detail = await realizedMaterials(page, so.code);
  expect(detail).toMatch(/consumido\/destinado\s*R\$\s*1\.080,00/);
  expect(detail).not.toContain('Conciliação pendente');
});
