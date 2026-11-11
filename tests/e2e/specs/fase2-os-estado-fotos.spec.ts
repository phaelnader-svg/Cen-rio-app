import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 2 — pela tela:
 *  1. o botão de próximo passo do cabeçalho ("Planejar a produção da OS") SÓ troca de aba: não
 *     cria tarefa, plano nem muda o estado da OS;
 *  2. foto nova enviada pela galeria (foto de celular com GPS e orientação no EXIF) é gravada e
 *     servida SEM metadados — nem a foto nem a miniatura trazem EXIF/GPS — e abre no visualizador.
 * Dados fictícios.
 */
const origin = `http://localhost:${E2E.webPort}`;
const FIXTURE = fileURLToPath(new URL('../fixtures/foto-gps.jpg', import.meta.url));

async function getJson(page: Page, path: string) {
  const r = await page.request.get(path, { headers: { origin } });
  expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

/** Bloco EXIF (APP1 "Exif\0\0") ou a etiqueta GPS (0x8825, qualquer ordem de bytes). */
function hasExifOrGps(b: Buffer) {
  return (
    b.includes(Buffer.from('Exif\0\0', 'latin1')) ||
    b.includes(Buffer.from([0x88, 0x25])) ||
    b.includes(Buffer.from([0x25, 0x88])) ||
    b.includes(Buffer.from('CelularTeste', 'latin1'))
  );
}

test('"Planejar a produção da OS" só navega para a aba Produção', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const so = await openServiceOrder(page, `Cliente Estado ${Date.now().toString(36)}`);
  const before = await getJson(page, `/api/v1/service-orders/${so.id}/production`);
  const stateBefore = await getJson(page, `/api/v1/service-orders/${so.id}/operational-state`);

  await page.goto(`/painel/os/${so.id}?tab=materiais`);
  const header = page.getByTestId('os-state');
  await expect(header).toHaveAttribute('data-state', 'NAO_PLANEJADA');
  const next = header.getByTestId('os-next-step');
  await expect(next).toHaveText(/Planejar a produção da OS/);
  await next.click();
  await expect(page.getByRole('tab', { name: /Produção/, selected: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/painel/os/${so.id}`));

  // Nada foi criado nem mudou de estado.
  expect(await getJson(page, `/api/v1/service-orders/${so.id}/production`)).toEqual(before);
  const stateAfter = await getJson(page, `/api/v1/service-orders/${so.id}/operational-state`);
  expect(stateAfter.state).toBe(stateBefore.state);
  expect(stateAfter.state).toBe('NAO_PLANEJADA');
});

test('foto nova pela galeria: sem EXIF/GPS na foto e na miniatura; abre no visualizador', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  // A própria entrada tem GPS (prova de que o teste é significativo).
  expect(hasExifOrGps(readFileSync(FIXTURE))).toBe(true);
  const so = await openServiceOrder(page, `Cliente Foto ${Date.now().toString(36)}`);

  await page.goto(`/painel/os/${so.id}?tab=pecas`);
  await page.getByLabel('Selecionar fotos').first().setInputFiles(FIXTURE);
  const list = page.getByTestId('photo-list').first();
  await expect(list.getByRole('button', { name: /Ampliar/ })).toHaveCount(1);

  const photos = await getJson(
    page,
    `/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${so.id}`,
  );
  expect(photos).toHaveLength(1);
  const p = photos[0];
  // Orientação aplicada: 1600×1200 com orientação 6 vira 1200×1600 ("em pé").
  expect([p.width, p.height]).toEqual([1200, 1600]);
  for (const url of [p.url, p.thumbUrl]) {
    const r = await page.request.get(url, { headers: { origin } });
    expect(r.ok()).toBe(true);
    expect(hasExifOrGps(Buffer.from(await r.body())), url).toBe(false);
  }

  await list.getByRole('button', { name: /Ampliar/ }).click();
  const viewer = page.getByTestId('photo-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId('photo-viewer-count')).toHaveText('1 de 1');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});
