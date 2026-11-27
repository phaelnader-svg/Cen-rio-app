import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * 2026-11-24 — Oficina sem tablet (dados fictícios). O gestor marca o andamento pela OS, um
 * clique por etapa; "Hoje na oficina" no celular; várias OS de uma vez; foto e WhatsApp quando
 * fica pronta; "Voltou com defeito" na OS entregue. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/oficina-sem-tablet';
const origin = `http://localhost:${E2E.webPort}`;

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('capturas: oficina sem tablet', async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);

  // Chave ligada em Empresa → Funcionalidades.
  const modules = (await call(page, 'GET', '/api/company/modules')) as {
    key: string;
    version: number;
  }[];
  await call(page, 'PUT', '/api/company/modules/oficina_sem_tablet', {
    enabled: true,
    version: modules.find((m) => m.key === 'oficina_sem_tablet')!.version,
  });

  const employees = (await call(page, 'GET', '/api/employees')) as {
    id: string;
    displayName: string;
  }[];
  const emp = (n: string) => employees.find((e) => e.displayName === n)!.id;
  async function os(name: string, lead: string) {
    const so = await openServiceOrder(page, name);
    const full = await call(page, 'GET', `/api/v1/service-orders/${so.id}`);
    await call(page, 'PUT', `/api/v1/service-orders/${so.id}`, {
      technicalInstructions: full.technicalInstructions,
      notes: full.notes,
      promisedDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
      priority: full.priority,
      technicalLeadId: emp(lead),
      reason: 'Tapeceiro da OS',
      version: full.version,
    });
    return so as { id: string; code: string };
  }
  const step = (id: string, s: string, extra: object = {}) =>
    call(page, 'POST', `/api/v1/service-orders/${id}/next-step`, { step: s, ...extra });

  const silvia = await os('Sílvia Moraes', 'Ricardo');
  const marta = await os('Marta Siqueira', 'Ricardo');
  const paulo = await os('Paulo Nogueira', 'Márcio');
  const lucia = await os('Lúcia Andrade', 'Márcio');
  const renato = await os('Renato Prado', 'Ricardo');
  await step(marta.id, 'COMECOU');
  await step(paulo.id, 'COMECOU');
  await step(paulo.id, 'PRONTA');
  for (const s of ['COMECOU', 'PRONTA', 'APROVADA']) await step(lucia.id, s);
  for (const s of ['COMECOU', 'PRONTA', 'APROVADA', 'SAIU', 'ENTREGUE']) await step(renato.id, s);

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    storageState: await page.context().storageState(),
  });
  const pp = await ctx.newPage();
  const shot = (p: Page, name: string, full = false) =>
    p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

  // 1. Lista de OS: cada uma com o botão verde da próxima etapa.
  await pp.goto('/painel/os');
  await expect(pp.getByTestId(`next-step-${silvia.code}`)).toHaveText('Começou');
  await expect(pp.getByTestId(`next-step-${marta.code}`)).toHaveText('Ficou pronta');
  await expect(pp.getByTestId(`next-step-${paulo.code}`)).toHaveText('Aprovada');
  await expect(pp.getByTestId(`next-step-${lucia.code}`)).toHaveText('Saiu para entrega');
  await shot(pp, '01-lista-de-os-botao-verde');

  // 2. Várias de uma vez.
  await pp.getByLabel(`Selecionar ${silvia.code}`).check();
  await pp.getByLabel(`Selecionar ${paulo.code}`).check();
  await pp.getByTestId('bulk-next-step').click();
  await expect(pp.getByRole('dialog')).toContainText('Marcar a próxima etapa');
  await shot(pp, '02-varias-os-de-uma-vez');
  await pp.keyboard.press('Escape');

  // 3. Página da OS: o botão verde ao lado de "Material comprado".
  await pp.goto(`/painel/os/${marta.id}`);
  await expect(pp.getByTestId(`next-step-${marta.code}`)).toBeVisible();
  await shot(pp, '03-pagina-da-os-ficou-pronta');

  // 4. Ficou pronta → foto (opcional) e aviso no WhatsApp.
  await pp.getByTestId(`next-step-${marta.code}`).click();
  await expect(pp.getByRole('dialog')).toContainText('ficou pronta');
  await expect(pp.getByTestId('ready-whatsapp')).toBeVisible();
  await shot(pp, '04-ficou-pronta-foto-e-whatsapp');
  await pp.getByTestId('ready-photo-input').setInputFiles('fixtures/foto-gps.jpg');
  await expect(pp.getByText('Foto guardada no álbum da OS.')).toBeVisible();
  await shot(pp, '05-foto-guardada-whatsapp-com-link');
  await pp.keyboard.press('Escape');
  await pp.reload();
  await expect(pp.getByTestId(`next-step-${marta.code}`)).toHaveText('Aprovada');
  await shot(pp, '06-pagina-da-os-aprovada');

  // 5. OS entregue: "Voltou com defeito" abre o retrabalho já preenchido.
  await pp.goto(`/painel/os/${renato.id}`);
  await expect(pp.getByTestId('os-back-with-defect')).toBeVisible();
  await shot(pp, '07-os-entregue-voltou-com-defeito');
  await pp.getByTestId('os-back-with-defect').click();
  await expect(pp.getByRole('dialog')).toContainText('Renato Prado');
  await shot(pp, '08-retrabalho-ja-preenchido');
  await pp.keyboard.press('Escape');

  // 6. Hoje na oficina — computador e celular.
  await pp.goto('/painel/producao/hoje');
  await expect(pp.getByTestId('shop-floor-group').first()).toBeVisible();
  await shot(pp, '09-hoje-na-oficina-computador', true);
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    storageState: await page.context().storageState(),
  });
  const mp = await phone.newPage();
  await mp.goto('/painel/producao/hoje');
  await expect(mp.getByTestId('shop-floor-group').first()).toBeVisible();
  await shot(mp, '10-hoje-na-oficina-celular');
  await shot(mp, '11-hoje-na-oficina-celular-inteira', true);

  // 7. Serviço parado: 4 dias depois, o cartão fica laranja (o aviso vai para o sininho).
  await step(silvia.id, 'COMECOU');
  await call(page, 'POST', '/api/test/clock', {
    now: new Date(Date.now() + 4 * 86_400_000 + 3_600_000).toISOString(),
  });
  await mp.reload();
  await expect(mp.getByText(/Parada há 4 dias/).first()).toBeVisible();
  await mp.getByTestId(`shop-floor-${silvia.code}`).scrollIntoViewIfNeeded();
  await shot(mp, '12-servico-parado-celular');
  await call(page, 'POST', '/api/test/clock', { now: null });

  // 8. A chave em Empresa → Funcionalidades.
  await pp.goto('/painel/empresa');
  const chave = pp.getByText('Oficina sem tablet').first();
  await chave.scrollIntoViewIfNeeded();
  await expect(chave).toBeVisible();
  await shot(pp, '13-chave-oficina-sem-tablet');
});
