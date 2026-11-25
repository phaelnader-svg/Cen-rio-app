import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder, post } from './os-helpers';

/**
 * 2026-11-25 — App do dono (dados fictícios): Hoje, Aprovar, Oficina, Dinheiro e "O que a IA
 * pode fazer", no tamanho de um celular. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/app-dono';
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const day = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(Date.now() + offset * 86_400_000),
  );

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('capturas: app do dono no celular', async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  await loginAdmin(page);

  // Oficina com serviços: um atrasado, um para hoje e um para a semana que vem.
  const jobs = [
    { name: 'Helena Prado', promised: day(-2) },
    { name: 'Marcos Teixeira', promised: day(0) },
    { name: 'Beatriz Lemos', promised: day(6) },
  ];
  const ids: string[] = [];
  const orders: string[] = [];
  for (const j of jobs) {
    const os = await openServiceOrder(page, j.name);
    ids.push(os.id);
    orders.push(os.order.id);
  }

  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(`SELECT set_config('app.company_id', '1', false)`);
  for (const [i, j] of jobs.entries())
    await db.query(`UPDATE service_orders SET promised_date = $1::date WHERE id = $2::uuid`, [
      j.promised,
      ids[i],
    ]);
  // Plano com o jogo (os agentes do escritório) para ter o que aprovar.
  await db.query(`UPDATE company_settings SET plan = 'gestao_jogo'`);
  await db.end();

  // Uma conta para pagar amanhã (aparece em "Vem por aí" e no Dinheiro).
  await post(page, '/api/v1/finance/payables', {
    beneficiary: 'Tecidos Exemplo Ltda',
    category: 'MATERIAL',
    description: 'Tecido suede',
    amountCents: 48000,
    dueDate: day(1),
  });

  // Dinheiro do mês: dois sinais recebidos e uma conta de material já paga.
  for (const [i, cents] of [60000, 45000].entries()) {
    const r = await post(page, '/api/v1/finance/receivables', {
      orderId: orders[i],
      description: 'Sinal do serviço',
      amountCents: cents,
      dueDate: day(0),
      expectedMethod: 'PIX',
    });
    await call(page, 'POST', `/api/v1/finance/receivables/${r.id}/payments`, {
      amountCents: cents,
      receivedAt: day(0),
      method: 'PIX',
      version: r.version,
    });
  }
  const paid = await post(page, '/api/v1/finance/payables', {
    beneficiary: 'Espumas Exemplo',
    category: 'MATERIAL',
    description: 'Espuma D33',
    amountCents: 62000,
    dueDate: day(0),
  });
  await call(page, 'POST', `/api/v1/finance/payables/${paid.id}/payments`, {
    amountCents: 62000,
    paidAt: day(0),
    method: 'PIX',
    version: paid.version,
  });

  // Um agente com dois pedidos esperando o dono.
  await call(page, 'POST', '/api/v1/office/hire', { roleKey: 'ATENDIMENTO' });
  const db2 = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db2.connect();
  // O banco separa as empresas (RLS): a gravação direta precisa dizer qual é a empresa.
  await db2.query(`SELECT set_config('app.company_id', '1', false)`);
  const text = (n: string) =>
    `Oi, ${n}! Aqui é da Cenário Estofados. Ficamos felizes com o seu serviço. Pode deixar uma avaliação para a gente? Leva um minutinho.`;
  for (const n of ['Sílvia Moraes', 'Paulo Nogueira'])
    await db2.query(
      `INSERT INTO ai_agent_proposals (id, company_id, agent_id, kind, title, detail, payload)
       SELECT gen_random_uuid(), company_id, id, 'ENVIAR_MENSAGEM', $2, $3, $4::jsonb FROM ai_agents WHERE role_key = $1 AND status = 'ATIVO'`,
      [
        'ATENDIMENTO',
        `Pedir a avaliação de ${n}`,
        text(n),
        JSON.stringify({
          task: 'PEDIR_AVALIACAO',
          customerName: n,
          phone: '5511900000000',
          text: text(n),
          href: `https://wa.me/5511900000000?text=${encodeURIComponent(text(n))}`,
          channel: 'WHATSAPP',
        }),
      ],
    );
  await db2.end();

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    timezoneId: TZ,
    storageState: await page.context().storageState(),
  });
  const phone = await context.newPage();
  const shot = (name: string, fullPage = true) =>
    phone.screenshot({ path: `${OUT}/${name}.png`, fullPage });

  await phone.goto('/dono');
  await expect(phone.getByTestId('dono-app')).toBeVisible();
  await expect(phone.locator('link[rel="manifest"]').first()).toHaveAttribute(
    'href',
    '/dono/manifest',
  );
  const manifest = await (await phone.request.get('/dono/manifest')).json();
  expect(manifest.start_url).toBe('/dono');
  expect(manifest.scope).toBe('/dono');
  await phone.waitForLoadState('networkidle');
  await shot('5-dono-hoje');

  await phone
    .getByRole('button', { name: /Aprovar/ })
    .last()
    .click();
  await expect(phone.getByTestId('office-proposal').first()).toBeVisible();
  await shot('6-dono-aprovar');
  // Sem o WhatsApp da empresa: aprovou, o "Enviar no WhatsApp" fica na tela mesmo depois que o
  // pedido sai da lista (a lista recarrega sozinha).
  await phone
    .getByTestId('office-proposal')
    .first()
    .getByRole('button', { name: 'Aprovar' })
    .click();
  await expect(phone.getByTestId('office-to-send')).toBeVisible();
  await expect(phone.getByTestId('office-proposal')).toHaveCount(1);
  await phone.waitForLoadState('networkidle');
  await expect(phone.getByTestId('office-to-send')).toContainText('Enviar no WhatsApp');
  await shot('6b-dono-aprovado-enviar');

  await phone
    .getByRole('button', { name: /Oficina/ })
    .last()
    .click();
  await expect(phone.getByText('Helena P.').first()).toBeVisible();
  await phone.waitForLoadState('networkidle');
  await shot('7-dono-oficina');

  await phone
    .getByRole('button', { name: /Dinheiro/ })
    .last()
    .click();
  await expect(phone.getByText('Entrou').first()).toBeVisible();
  await shot('8-dono-dinheiro');

  await phone.getByRole('button', { name: /Hoje/ }).last().click();
  await phone.getByRole('button', { name: 'O que a IA pode fazer' }).click();
  await expect(phone.getByRole('button', { name: 'Parar tudo' })).toBeVisible();
  await expect(phone.getByRole('button', { name: /Contratar/ })).toHaveCount(0);
  await shot('9-dono-o-que-a-ia-pode-fazer', false);
});
