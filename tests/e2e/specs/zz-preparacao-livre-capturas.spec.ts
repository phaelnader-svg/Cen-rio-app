import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * 2026-11-19 — preparação/desmontagem livre para os ajudantes (dados fictícios).
 * O dono escolhe só o tapeceiro titular; a desmontagem aparece no tablet de quem está livre e
 * o primeiro que toca em Iniciar fica com ela (some do tablet do outro).
 * Prints em CAPTURAS_DIR (padrão: test-results/preparacao-livre).
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/preparacao-livre';
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('capturas: desmontagem livre no tablet dos ajudantes', async ({ page, browser }) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/${name}.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const workers = await call(page, 'GET', '/api/v1/production/workers');
  const w = (n: string) =>
    (workers as { displayName: string; userId: string }[]).find((x) => x.displayName.startsWith(n))!
      .userId;

  // Serviço fictício: sofá (reforma) + poltronas; titular Ricardo. Ninguém escolhido para desmontar.
  const so = await openServiceOrder(page, 'Marta Siqueira');
  const week = mondayOf(today());
  let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
  if (!plan)
    plan = await call(page, 'POST', '/api/v1/production-plans', {
      weekStart: week,
      mode: 'FILA_SEMANAL',
    });
  await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
    serviceOrderId: so.id,
    pieces: so.items.map((i: { id: string }) => ({
      serviceOrderItemId: i.id,
      upholstererUserId: w('Ricardo'),
    })),
  });
  plan = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
  await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
    version: plan.version,
    notes: 'Semana fictícia',
  });

  // Tablets do João (ajudante) e do Thiago (cabeceiras, também ajuda), lado a lado.
  await setPin(page, 'João', '602413');
  await setPin(page, 'Thiago', '602414');
  const hi = { deviceScaleFactor: 2 };
  const joao = await openTablet(
    browser,
    await registerDevice(page, 'Tablet João', 'João'),
    '602413',
    undefined,
    hi,
  );
  const thiago = await openTablet(
    browser,
    await registerDevice(page, 'Tablet Thiago', 'Thiago'),
    '602414',
    undefined,
    hi,
  );
  const free = (p: Page) => p.getByTestId('free-tasks');
  await expect(free(joao.page)).toContainText('Desmontagem');
  await expect(free(thiago.page)).toContainText('Desmontagem');
  await shot(joao.page, '1-tablet-joao-tarefas-livres');
  await shot(thiago.page, '2-tablet-thiago-mesmas-tarefas');

  // Painel: a desmontagem aparece como "Livre para os ajudantes".
  const panel = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    storageState: await page.context().storageState(),
  });
  const pp = await panel.newPage();
  await pp.goto(`/painel/os/${so.id}?tab=producao`);
  await expect(pp.getByText('Livre para os ajudantes').first()).toBeVisible();
  await shot(pp, '3-painel-os-livre');

  // João toca primeiro em Iniciar no sofá: fica com ele; some do tablet do Thiago.
  const sofa = free(joao.page)
    .getByTestId(/^my-task-/)
    .filter({ hasText: 'Sofá' })
    .first();
  await sofa.getByRole('button', { name: 'Iniciar' }).click();
  await expect(joao.page.getByTestId('week-highlight')).toContainText('Desmontagem');
  await expect(
    free(thiago.page)
      .getByTestId(/^my-task-/)
      .filter({ hasText: 'Sofá' }),
  ).toHaveCount(0);
  await shot(joao.page, '4-tablet-joao-pegou');
  await shot(thiago.page, '5-tablet-thiago-sumiu');

  await pp.reload();
  await expect(pp.getByText('João').first()).toBeVisible();
  await shot(pp, '6-painel-os-joao-fazendo');

  await pp.goto('/painel/producao/modelos?tab=etapas');
  await expect(pp.getByText('Ajudante que estiver livre').first()).toBeVisible();
  await pp
    .getByText('Ajudante que estiver livre')
    .first()
    .evaluate((e) => e.closest('div.card')?.scrollIntoView());
  await shot(pp, '7-modelos-etapa-livre');
  await panel.close();
  await joao.context.close();
  await thiago.context.close();
});
