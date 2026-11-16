import { expect, test } from '@playwright/test';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 2 — mapa interno da oficina (painel) e "Aguardando chegada" unificada
 * (tablet). Dados fictícios.
 */
test('mapa da oficina: peça sem localização, mover pela tela, busca e localização na OS', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const tag = `Mapa ${Date.now().toString(36)}`;
  const so = await openServiceOrder(page, `Cliente ${tag}`);
  // A rota existente de localizações responde 200 (não 201).
  const created = await page.request.post('/api/v1/locations', {
    data: { label: `Bancada ${tag}`, position: 900 },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const area = (await created.json()) as { id: string; key: string };
  const piece = so.items[0]!;

  await page.goto('/painel/producao/mapa');
  await expect(page.getByRole('heading', { name: 'Mapa da oficina', level: 1 })).toBeVisible();
  const unplaced = page.getByTestId('map-area-SEM_LOCALIZACAO');
  const card = unplaced.getByTestId(`map-piece-${piece.code}`);
  await expect(card).toContainText(`Cliente ${tag}`);
  await expect(card).toContainText('No recebimento: Área de recebimento');

  // Mover pela tela (mesma movimentação de sempre).
  await card.getByLabel(`Mover ${piece.code}`).selectOption({ label: `Bancada ${tag}` });
  const target = page.getByTestId(`map-area-${area.key}`);
  await expect(target.getByTestId(`map-piece-${piece.code}`)).toContainText('Movida por');
  await expect(unplaced.getByTestId(`map-piece-${piece.code}`)).toHaveCount(0);

  // Busca: diz onde a peça está.
  await page.getByLabel('Procurar peça').fill(piece.code);
  await expect(page.getByTestId('workshop-map-found')).toContainText(
    `${piece.code} → Bancada ${tag}`,
  );

  // A OS mostra a localização registrada (com o texto do recebimento abaixo).
  await page.goto(`/painel/os/${so.id}?tab=pecas`);
  await expect(page.getByTestId(`so-item-location-${piece.code}`)).toContainText(`Bancada ${tag}`);
});

test('tablet: "Aguardando chegada" reúne avisos e conferência de materiais', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await loginAdmin(page);
  await setPin(page, 'João', '640213');
  const code = await registerDevice(page, 'Tablet João (Fase 2 chegada)', 'João');
  const t = await openTablet(browser, code, '640213');
  try {
    await expect(t.page.getByTestId('tile-materials')).toHaveCount(0);
    await t.page.getByTestId('tile-arrivals').click();
    await expect(t.page.getByRole('heading', { name: 'Aguardando chegada' })).toBeVisible();
    const avisos = t.page.getByTestId('arrivals-section-avisos');
    const conferencia = t.page.getByTestId('arrivals-section-conferencia');
    await expect(avisos).toHaveAttribute('aria-pressed', 'true');
    await expect(conferencia.getByTestId('materials-count')).toBeVisible();
    await conferencia.click();
    await expect(conferencia).toHaveAttribute('aria-pressed', 'true');
    await expect(
      t.page
        .getByTestId('pending-receipts')
        .or(t.page.getByText('Nenhum material aguardando chegada'))
        .first(),
    ).toBeVisible();
  } finally {
    await t.context.close();
  }
});
