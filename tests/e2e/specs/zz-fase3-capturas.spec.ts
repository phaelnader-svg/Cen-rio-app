import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 3 — capturas e inspeção geométrica das telas novas ou alteradas, em 1440 e
 * 390 px: sem rolagem horizontal, sem erro de página. Com E2E_EVIDENCE=1, salva em
 * docs/evidencias/reformulacao-fase-3/<largura>. Dados fictícios.
 */
const OUT = '../../docs/evidencias/reformulacao-fase-3';
const origin = `http://localhost:${E2E.webPort}`;
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

test('capturas da Fase 3 em 1440 e 390 px', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const tag = Date.now().toString(36);
  const so = await openServiceOrder(page, `Cliente Capturas F3 ${tag}`);
  // Inspeção aberta de uma peça executada pelo gestor (para a tela de autoaprovação).
  const gestorId = (await call(page, 'GET', '/api/auth/me')).user.id as string;
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
  const ricardo = (await call(page, 'GET', '/api/v1/production/workers')).find(
    (w: { displayName: string }) => w.displayName === 'Ricardo',
  );
  const reason = `Capturas F3 ${tag}`;
  const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
    serviceOrderId: so.id,
    principalUserId: ricardo.userId,
    date: DAY,
    reason,
  });
  for (const t of added.tasks as { id: string; serviceOrder: { id: string } }[])
    if (t.serviceOrder.id === so.id)
      await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, { reason: 'Fora' });
  const task = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
    serviceOrderId: so.id,
    serviceOrderItemId: so.items[0]!.id,
    activity: 'REVESTIMENTO',
    title: `Revestimento capturas ${tag}`,
    role: 'PRINCIPAL',
    assigneeUserId: gestorId,
    date: DAY,
    time: '00:00',
    reason,
  });
  const fresh = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
  if (fresh.status !== 'PUBLICADO')
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
      version: fresh.version,
    });
  await call(page, 'POST', `/api/v1/production-tasks/${task.id}/start`, {});
  await call(page, 'POST', `/api/v1/production-tasks/${task.id}/complete`, { note: 'Feito' });
  const insp = (
    (await call(page, 'GET', `/api/v1/quality/inspections?serviceOrderId=${so.id}`)) as {
      id: string;
    }[]
  )[0]!;

  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.goto(`/painel/qualidade/inspecoes/${insp.id}`, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('self-approval')).toBeVisible();
    await check(page, errors, v.name, 'inspecao-autoaprovacao');
    await page.goto('/painel/producao/programacao', { waitUntil: 'networkidle' });
    await check(page, errors, v.name, 'programacao-servicos');
    await page.goto('/painel/producao/programacao?tab=semana', { waitUntil: 'networkidle' });
    await check(page, errors, v.name, 'programacao-semana');
    await page.goto(`/painel/os?q=${so.code}`, { waitUntil: 'networkidle' });
    await expect(page.getByTestId(`so-${so.code}`).getByTestId('os-state-badge')).toBeVisible();
    await check(page, errors, v.name, 'os-lista-estado');
    await page.goto(`/painel/os/${so.id}`, { waitUntil: 'networkidle' });
    await check(page, errors, v.name, 'os-cabecalho-estado');
    await page.goto('/painel/empresa', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('modules-card')).toBeVisible();
    await check(page, errors, v.name, 'empresa-funcionalidades');
  }

  // Depois das capturas da tela aberta: aprova com justificativa e mostra a exceção destacada.
  const open = await call(page, 'GET', `/api/v1/quality/inspections/${insp.id}`);
  await call(page, 'POST', `/api/v1/quality/inspections/${insp.id}/approve`, {
    version: open.version,
    allConform: true,
    selfApprovalReason: 'Inspetor ausente; conferido com o cliente (capturas)',
  });
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.goto(`/painel/qualidade/inspecoes/${insp.id}`, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('self-approval-note')).toBeVisible();
    await check(page, errors, v.name, 'inspecao-autoaprovada');
    await page.goto('/painel/auditoria', { waitUntil: 'networkidle' });
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Exceções destacadas' });
    await expect(page.locator('[data-highlighted="true"]').first()).toBeVisible();
    await check(page, errors, v.name, 'auditoria-excecoes');
  }
});
