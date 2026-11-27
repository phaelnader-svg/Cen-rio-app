import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * 2026-11-27 — Etapa 4 da lista de 53 (página de vendas): app do dono e IA (27), calculadora de
 * preço de reforma (28), prints refeitos (30) e Caderno e WhatsApp × Cenário (31). Em /conheca
 * (no teste aparece a faixa de pré-visualização no topo). Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/etapa4';

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--lang=pt-BR'],
    env: { ...process.env, LANG: 'pt_BR.UTF-8', LANGUAGE: 'pt_BR' },
  },
});

let n = 1;
async function shot(p: Page, name: string, fullPage = false) {
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-${name}.png`, fullPage });
}

test('capturas: etapa 4 (página de vendas)', async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const desk = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'pt-BR',
  });
  const p = await desk.newPage();
  await p.goto('/conheca', { waitUntil: 'networkidle' });
  await p.getByRole('button', { name: 'Recusar' }).click(); // aviso de cookies fora do print
  await shot(p, 'abertura');
  await p.getByTestId('site-app-dono').scrollIntoViewIfNeeded();
  await p
    .getByTestId('site-app-dono')
    .screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-app-do-dono-e-ia.png` });
  await p
    .getByTestId('site-antes-depois')
    .screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-caderno-x-cenario.png` });
  await shot(p, 'pagina-inteira', true);

  await p.getByTestId('site-calculadora-link').click();
  await expect(p.getByTestId('calculadora')).toBeVisible();
  await p.getByLabel('Peça', { exact: true }).selectOption({ label: 'Poltrona' });
  await p.getByLabel('Quantas peças').fill('2');
  await p.getByText('Cliente vai pagar no cartão').click();
  await expect(p.getByTestId('calc-preco')).toBeVisible();
  await shot(p, 'calculadora', true);
  await desk.close();

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-BR',
  });
  const m = await phone.newPage();
  await m.goto('/conheca', { waitUntil: 'networkidle' });
  await m.getByRole('button', { name: 'Recusar' }).click();
  await m.getByTestId('site-app-dono').scrollIntoViewIfNeeded();
  await shot(m, 'celular-app-do-dono');
  await m.getByTestId('site-antes-depois').scrollIntoViewIfNeeded();
  await shot(m, 'celular-caderno-x-cenario');
  await m.goto('/calculadora', { waitUntil: 'networkidle' });
  await shot(m, 'celular-calculadora', true);
  await phone.close();
});
