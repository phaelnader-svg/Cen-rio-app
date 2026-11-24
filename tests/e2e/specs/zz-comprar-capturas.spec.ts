import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { loginAdmin } from './helpers';
import { markArrived, post } from './os-helpers';

/**
 * 2026-11-24 — materiais da OS e lista "Comprar" (dados fictícios). A OS não copia mais os
 * materiais do orçamento; o que se escreve ao gerar a OS (ou na aba Materiais) e ainda não foi
 * comprado aparece em Estoque da oficina → Comprar. "Comprei" marca na OS; o último libera a OS.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/comprar';
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function order(page: Page, name: string, piece: string) {
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
  const o = await post(page, '/api/v1/orders', {
    customerId: customer.id,
    pickupAddressId: customer.addresses[0].id,
    contractedService: 'Reforma',
    agreedValueCents: 180000,
    paymentTerms: 'À vista',
    items: [{ pieceType: 'SOFA', description: piece, quantity: 1 }],
  });
  await markArrived(page, o.id, o.version);
  return o as { id: string; items: { id: string }[] };
}

async function os(
  page: Page,
  name: string,
  piece: string,
  prazo: number,
  materials: { description: string; quantity?: number; unit?: string }[],
) {
  const o = await order(page, name, piece);
  return post(page, '/api/v1/service-orders', {
    orderId: o.id,
    promisedDate: day(prazo),
    items: [
      {
        orderItemId: o.items[0]!.id,
        quantity: 1,
        description: piece,
        serviceType: 'REFORMA_COMPLETA',
        fabricName: 'Linho bege',
      },
    ],
    materials,
  }) as Promise<{ id: string; code: string }>;
}

test('capturas: materiais da OS e lista Comprar', async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);

  const helena = await os(page, 'Helena Barros', 'Sofá 3 lugares', 6, [
    { description: 'Espuma D33 — 3 × 50 × 50 cm', quantity: 4, unit: 'peças' },
    { description: 'Aquablock', quantity: 4.5, unit: 'm' },
  ]);
  await os(page, 'Otávio Lins', 'Poltrona bergère', 9, [
    { description: 'Tecido veludo verde', quantity: 3, unit: 'm' },
    { description: 'Percinta elástica', quantity: 12, unit: 'm' },
  ]);
  await os(page, 'Beatriz Couto', 'Cadeira de jantar', 14, [
    { description: 'Espuma D28 — 5 cm', quantity: 6, unit: 'peças' },
  ]);
  const novo = await order(page, 'Caio Fernandes', 'Sofá retrátil');

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    storageState: await page.context().storageState(),
  });
  const pp = await ctx.newPage();
  const shot = (p: Page, name: string, full = false) =>
    p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

  // 1. Gerar OS: a parte 3 tem os materiais (vazia, não vem do orçamento).
  await pp.goto(`/painel/os/nova?pedido=${novo.id}`);
  const box = pp.getByTestId('so-materials');
  await expect(box).toBeVisible();
  await pp.getByLabel('Material 1', { exact: true }).fill('Espuma D33 — 10 cm');
  await pp.getByLabel('Quantidade do material 1').fill('2');
  await pp.getByLabel('Unidade do material 1').fill('placas');
  await box.getByRole('button', { name: 'Outro material' }).click();
  await pp.getByLabel('Material 2', { exact: true }).fill('Tecido suede cinza');
  await pp.getByLabel('Quantidade do material 2').fill('7');
  await pp.getByLabel('Unidade do material 2').fill('m');
  await pp.locator('#os-prazo').scrollIntoViewIfNeeded();
  await shot(pp, '1-gerar-os-materiais');

  // 2. Estoque da oficina: a lista Comprar no topo.
  await pp.goto('/painel/estoque-oficina');
  await expect(pp.getByTestId('to-buy-row')).toHaveCount(5);
  await shot(pp, '2-estoque-lista-comprar');

  // 3. "Comprei" no último material da Helena → a OS fica liberada para a semana.
  await pp
    .getByTestId('to-buy-row')
    .filter({ hasText: 'Aquablock' })
    .getByTestId('to-buy-done')
    .click();
  await expect(pp.getByTestId('to-buy-row')).toHaveCount(4);
  await pp
    .getByTestId('to-buy-row')
    .filter({ hasText: 'Espuma D33' })
    .getByTestId('to-buy-done')
    .click();
  await expect(pp.getByText(`Tudo comprado para a ${helena.code}`)).toBeVisible();
  await shot(pp, '3-comprei-libera-a-os');

  // 4. A OS da Helena: materiais marcados como comprados, sem "Do orçamento".
  await pp.goto(`/painel/os/${helena.id}?tab=materiais`);
  await expect(pp.getByText('Aquablock').first()).toBeVisible();
  await shot(pp, '4-os-materiais-comprados');

  // 5. Celular.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    storageState: await page.context().storageState(),
  });
  const mp = await phone.newPage();
  await mp.goto('/painel/estoque-oficina');
  await expect(mp.getByTestId('to-buy-row')).toHaveCount(3);
  await shot(mp, '5-comprar-celular');
});
