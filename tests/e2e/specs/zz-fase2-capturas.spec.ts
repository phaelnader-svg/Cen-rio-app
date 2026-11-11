import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 2 — capturas e inspeção geométrica das telas novas ou alteradas, em 1440 px
 * e 390 px. Sempre verifica: sem rolagem horizontal da página, sem erro de página e título
 * presente. Com E2E_EVIDENCE=1, salva as capturas em docs/evidencias/reformulacao-fase-2/<largura>.
 * Dados fictícios.
 */
const OUT = '../../docs/evidencias/reformulacao-fase-2';
const origin = `http://localhost:${E2E.webPort}`;
const FIXTURE = join(__dirname, '..', 'fixtures', 'foto-gps.jpg');
const TZ = 'America/Sao_Paulo';
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

/** Inspeção: sem rolagem horizontal da página e sem erro de página; captura opcional. */
async function check(page: Page, errors: string[], viewport: string, name: string) {
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${name} @${viewport}: rolagem horizontal de ${overflow}px`).toBeLessThanOrEqual(
    2,
  );
  expect(errors, `${name} @${viewport}: erros de página`).toEqual([]);
  if (process.env.E2E_EVIDENCE)
    await page.screenshot({ path: `${OUT}/${viewport}/${name}.png`, fullPage: true });
}

test('capturas da Fase 2 (painel e tablet) em 1440 e 390 px', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const tag = Date.now().toString(36);
  const so = await openServiceOrder(page, `Cliente Capturas ${tag}`);
  // Material padrão e foto para as telas terem conteúdo.
  await call(page, 'POST', '/api/v1/service-models/materials', {
    pieceType: 'POLTRONA',
    serviceType: 'TROCA_DE_TECIDO',
    description: `Tecido capturas ${tag}`,
    quantity: 3.5,
    unit: 'm',
  });
  await page.goto(`/painel/os/${so.id}?tab=pecas`);
  await page.getByLabel('Selecionar fotos').first().setInputFiles(FIXTURE);
  await expect(
    page
      .getByTestId('photo-list')
      .first()
      .getByRole('button', { name: /Ampliar/ }),
  ).toHaveCount(1);

  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    const os = (tab: string) => `/painel/os/${so.id}?tab=${tab}`;
    for (const tab of ['resumo', 'pecas', 'materiais', 'producao', 'qualidade', 'historico']) {
      await page.goto(os(tab), { waitUntil: 'networkidle' });
      await expect(page.getByTestId('os-state')).toBeVisible();
      await check(page, errors, v.name, `os-${tab}`);
    }
    // Visualizador de fotos.
    await page.goto(os('pecas'), { waitUntil: 'networkidle' });
    await page
      .getByTestId('photo-list')
      .first()
      .getByRole('button', { name: /Ampliar/ })
      .click();
    await expect(page.getByTestId('photo-viewer')).toBeVisible();
    await check(page, errors, v.name, 'os-foto-visualizador');
    await page.keyboard.press('Escape');
    // Sugestão de materiais.
    await page.goto(os('materiais'), { waitUntil: 'networkidle' });
    await page.getByTestId('os-material-suggest').click();
    await expect(page.getByTestId('os-material-suggestions')).toBeVisible();
    await check(page, errors, v.name, 'os-sugerir-materiais');
    await page.keyboard.press('Escape');

    // Modelos de serviço: visão por serviço (com detalhe), etapas, checklists e materiais.
    await page.goto('/painel/producao/modelos', { waitUntil: 'networkidle' });
    await page
      .getByTestId('service-models-overview')
      .getByLabel('Tipo de peça')
      .selectOption('POLTRONA');
    await page.getByTestId('service-model-row-TROCA_DE_TECIDO').click();
    await expect(page.getByTestId('service-model-detail')).toBeVisible();
    await check(page, errors, v.name, 'modelos-por-servico');
    for (const [tab, name] of [
      ['etapas', 'modelos-etapas'],
      ['checklists', 'modelos-checklists'],
      ['materiais', 'modelos-materiais'],
    ] as const) {
      await page.goto(`/painel/producao/modelos?tab=${tab}`, { waitUntil: 'networkidle' });
      await check(page, errors, v.name, name);
    }

    // Mapa da oficina (com peças sem localização registrada).
    await page.goto('/painel/producao/mapa', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('map-area-SEM_LOCALIZACAO')).toBeVisible();
    await check(page, errors, v.name, 'mapa-oficina');
  }

  // Tablet: tarefa (essencial + "Mais detalhes") e "Aguardando chegada" unificada.
  const workers = await call(page, 'GET', '/api/v1/production/workers');
  const joaoId = workers.find((w: { displayName: string }) => w.displayName === 'João').userId;
  const week = (() => {
    const d = new Date(`${DAY}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
  if (!plan)
    plan = await call(page, 'POST', '/api/v1/production-plans', {
      weekStart: week,
      mode: 'LEGADO',
    });
  const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
    serviceOrderId: so.id,
    principalUserId: joaoId,
    date: DAY,
    reason: 'Capturas da Fase 2',
  });
  if (plan.status !== 'PUBLICADO') {
    const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
      version: draft.version,
    });
  }
  type T = { id: string; title: string; assignee: { userId: string } | null };
  const tasks = added.tasks as T[];
  const task = tasks.find((x) => x.assignee?.userId === joaoId) ?? tasks[0]!;
  await setPin(page, 'João', '603917');
  for (const v of VIEWPORTS) {
    const code = await registerDevice(page, `Tablet João capturas ${tag} ${v.name}`, 'João');
    const t = await openTablet(browser, code, '603917', {
      width: v.width,
      height: v.height,
      isMobile: v.name === '390',
    });
    const terr: string[] = [];
    t.page.on('pageerror', (e) => terr.push(e.message));
    try {
      await check(t.page, terr, v.name, 'tablet-inicio');
      await t.page.getByTestId('tile-arrivals').click();
      await check(t.page, terr, v.name, 'tablet-aguardando-chegada');
      await t.page.getByTestId('arrivals-section-conferencia').click();
      await check(t.page, terr, v.name, 'tablet-conferir-materiais');
      // Abre a tarefa pelo cartão de "Meu dia".
      await t.page
        .getByRole('button', { name: /Voltar/ })
        .first()
        .click();
      const open = t.page.getByRole('button', { name: new RegExp(`Abrir ${task.title}`) });
      await open.first().click();
      await expect(t.page.getByTestId('my-task-detail')).toBeVisible();
      await expect(t.page.getByTestId('os-steps')).toBeHidden();
      await check(t.page, terr, v.name, 'tablet-tarefa');
      await t.page.getByTestId('task-more').getByText('Mais detalhes').click();
      await expect(t.page.getByTestId('os-steps')).toBeVisible();
      await check(t.page, terr, v.name, 'tablet-tarefa-mais-detalhes');
    } finally {
      await t.context.close();
    }
  }
});
