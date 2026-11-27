import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Item 30 da lista de 53 (2026-11-27): os prints da página de vendas são refeitos a cada versão,
 * com dados de exemplo, para o site nunca mostrar tela velha. Este spec monta uma oficina fictícia,
 * tira as telas que a página usa e grava em apps/web/public/site (formato WebP).
 *
 * Rodar antes de cada versão (a IA da Conversar é falsa, só para o print):
 *   ANTHROPIC_API_KEY=falsa ANTHROPIC_BASE_URL=http://localhost:4198 \
 *   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test specs/zz-site-prints.spec.ts
 * Sem SITE_PRINTS_DIR, grava direto em apps/web/public/site.
 */
const OUT =
  process.env.SITE_PRINTS_DIR ?? new URL('../../../apps/web/public/site', import.meta.url).pathname;
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const FAKE_AI_PORT = 4198;
const sharp = createRequire(new URL('../../../apps/api/package.json', import.meta.url))(
  'sharp',
) as typeof import('sharp');

// Campos de data no formato brasileiro (dd/mm/aaaa) também nos prints.
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--lang=pt-BR'],
    env: { ...process.env, LANG: 'pt_BR.UTF-8', LANGUAGE: 'pt_BR' },
  },
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.status() === 204 ? null : r.json();
}

/** Print → WebP na largura pedida (o dobro da tela, para ficar nítido em tela de celular). */
async function save(p: Page, name: string, width: number) {
  // As dicas de primeira vez ("Entendi") saem do print.
  for (const b of await p.getByRole('button', { name: 'Entendi', exact: true }).all())
    if (await b.isVisible()) await b.click();
  await p.waitForTimeout(500);
  const png = await p.screenshot();
  await sharp(png).resize({ width }).webp({ quality: 82 }).toFile(`${OUT}/${name}.webp`);
}

/** IA falsa: responde a Conversar com textos fixos, um por pergunta (formato da API de mensagens). */
function fakeAi(answers: string[]): Promise<Server> {
  let i = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const answer = answers[Math.min(i++, answers.length - 1)]!;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_print',
          type: 'message',
          role: 'assistant',
          model: 'print',
          content: [{ type: 'text', text: answer }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  return new Promise((ok) => server.listen(FAKE_AI_PORT, () => ok(server)));
}

test('prints da página de vendas', async ({ page, browser }) => {
  test.skip(
    process.env.ANTHROPIC_BASE_URL !== `http://localhost:${FAKE_AI_PORT}`,
    `Precisa da IA falsa (ANTHROPIC_BASE_URL=http://localhost:${FAKE_AI_PORT}).`,
  );
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const me = await call(page, 'GET', '/api/auth/me');
  if (me.company?.needsWhatsapp)
    await call(page, 'POST', '/api/company/contact', { whatsapp: '(12) 99887-6655' });
  await db.query(`UPDATE users SET display_name = 'Raphael' WHERE email = $1`, [E2E.admin.email]);
  await db.query(`SELECT set_config('app.company_id', '1', false)`);
  // Empresa já configurada: sem as perguntas do começo nem o "Comece por aqui".
  await db.query(
    `UPDATE company_settings SET plan = 'gestao_jogo', setup_done_at = now(), getting_started_hidden_at = now()`,
  );

  // ─────────── Oficina fictícia: seis serviços com prazos espalhados.
  const jobs: [string, number][] = [
    ['Mariana Lopes', 9],
    ['Fernanda Rocha', 4],
    ['Clínica Bem Estar', 1],
    ['Joaquim Ferreira', 12],
    ['Restaurante Sabor da Serra', 6],
    ['Helena Prado', 15],
  ];
  const sos: { id: string; code: string; order: { id: string }; items: { id: string }[] }[] = [];
  for (const [name, days] of jobs) {
    const so = await openServiceOrder(page, name);
    sos.push(so as (typeof sos)[number]);
    await db.query(`UPDATE service_orders SET promised_date = $1::date WHERE id = $2::uuid`, [
      addDays(today(), days),
      so.id,
    ]);
  }

  // Semana da oficina publicada, dividida entre dois tapeceiros.
  const workers = (await call(page, 'GET', '/api/v1/production/workers')) as {
    displayName: string;
    userId: string;
    isTapeceiro: boolean;
  }[];
  const tapeceiros = workers.filter((w) => w.isTapeceiro);
  const ricardo = tapeceiros.find((w) => w.displayName.startsWith('Ricardo')) ?? tapeceiros[0]!;
  const outro = tapeceiros.find((w) => w.userId !== ricardo.userId) ?? ricardo;
  const week = mondayOf(today());
  let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
  if (!plan)
    plan = await call(page, 'POST', '/api/v1/production-plans', {
      weekStart: week,
      mode: 'FILA_SEMANAL',
    });
  for (const [i, so] of sos.slice(0, 4).entries())
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
      serviceOrderId: so.id,
      pieces: so.items.map((it) => ({
        serviceOrderItemId: it.id,
        upholstererUserId: (i % 2 === 0 ? ricardo : outro).userId,
      })),
    });
  plan = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
  if (plan.status !== 'PUBLICADO')
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
      version: plan.version,
      notes: 'Semana de exemplo',
    });

  // Dinheiro do mês: sinais recebidos e contas pagas.
  const valores = [280000, 190000, 350000, 240000, 310000, 160000];
  for (const [i, so] of sos.entries())
    await db.query(`UPDATE commercial_orders SET agreed_value_cents = $1 WHERE id = $2::uuid`, [
      valores[i],
      so.order.id,
    ]);
  for (const [i, cents] of [280000, 95000, 350000, 120000].entries()) {
    const r = await call(page, 'POST', '/api/v1/finance/receivables', {
      orderId: sos[i]!.order.id,
      description: 'Sinal do serviço',
      amountCents: cents,
      dueDate: today(),
      expectedMethod: 'PIX',
    });
    await call(page, 'POST', `/api/v1/finance/receivables/${r.id}/payments`, {
      amountCents: cents,
      receivedAt: today(),
      method: 'PIX',
      version: r.version,
    });
  }
  for (const [who, cat, what, cents] of [
    ['Tecidos Vale', 'MATERIAL', 'Veludo e linho', 98000],
    ['Espumas Paraíba', 'MATERIAL', 'Espuma D33', 62000],
    ['Imobiliária Centro', 'ALUGUEL', 'Aluguel do galpão', 250000],
  ] as const) {
    const p = await call(page, 'POST', '/api/v1/finance/payables', {
      beneficiary: who,
      category: cat,
      description: what,
      amountCents: cents,
      dueDate: today(),
    });
    await call(page, 'POST', `/api/v1/finance/payables/${p.id}/payments`, {
      amountCents: cents,
      paidAt: today(),
      method: 'PIX',
      version: p.version,
    });
  }
  await call(page, 'POST', '/api/v1/finance/payables', {
    beneficiary: 'Tecidos Vale',
    category: 'MATERIAL',
    description: 'Corino preto',
    amountCents: 41000,
    dueDate: addDays(today(), 1),
  });
  // Agente de atendimento contratado, com dois pedidos esperando o dono.
  await call(page, 'POST', '/api/v1/office/hire', { roleKey: 'ATENDIMENTO' });
  const text = (n: string) =>
    `Oi, ${n}! Aqui é da Cenário Estofados. Sua peça ficou pronta. Qual o melhor dia para a entrega?`;
  for (const n of ['Fernanda Rocha', 'Joaquim Ferreira'])
    await db.query(
      `INSERT INTO ai_agent_proposals (id, company_id, agent_id, kind, title, detail, payload)
       SELECT gen_random_uuid(), company_id, id, 'ENVIAR_MENSAGEM', $2, $3, $4::jsonb FROM ai_agents WHERE role_key = $1 AND status = 'ATIVO'`,
      [
        'ATENDIMENTO',
        `Avisar ${n} que ficou pronto`,
        text(n),
        JSON.stringify({
          task: 'AVISAR_PRONTO',
          customerName: n,
          phone: '5512900000000',
          text: text(n),
          href: `https://wa.me/5512900000000?text=${encodeURIComponent(text(n))}`,
          channel: 'WHATSAPP',
        }),
      ],
    );
  await db.end();

  // Contexto do computador em português (datas dd/mm) e sem o pedido de avisos.
  const deskCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: TZ,
    locale: 'pt-BR',
    permissions: ['notifications'],
    storageState: await page.context().storageState(),
  });
  const desk = await deskCtx.newPage();

  // ─────────── Tablet do tapeceiro: chegou e começou a primeira tarefa.
  await setPin(page, ricardo.displayName, '771355');
  const tab = await openTablet(
    browser,
    await registerDevice(page, 'Tablet da oficina', ricardo.displayName),
    '771355',
    undefined,
    { deviceScaleFactor: 2, timezoneId: TZ, locale: 'pt-BR', permissions: ['notifications'] },
  );
  await tab.page.getByRole('button', { name: 'Cheguei' }).click();
  await tab.page
    .getByRole('button', { name: /^Abrir / })
    .first()
    .click();
  await tab.page
    .getByRole('button', { name: /^Iniciar/ })
    .first()
    .click();
  await tab.page.getByRole('button', { name: /Voltar à minha semana/ }).click();
  await tab.page.waitForLoadState('networkidle');
  await expect(tab.page.getByText('Tarefa iniciada.')).toHaveCount(0, { timeout: 15_000 });
  await save(tab.page, 'tablet', 2560);
  await tab.context.close();

  // ─────────── Telas do computador.
  await desk.goto('/painel', { waitUntil: 'networkidle' });
  await save(desk, 'inicio', 2880);
  await desk.goto('/painel/producao', { waitUntil: 'networkidle' });
  await save(desk, 'producao', 2880);
  await desk.goto('/painel/financeiro', { waitUntil: 'networkidle' });
  await save(desk, 'financeiro', 2880);
  await deskCtx.close();

  // ─────────── App do dono no celular: Hoje, Conversar e o que a IA pode fazer.
  const ai = await fakeAi([
    'Tem sim. Amanhã tem 2 retiradas: Helena Prado de manhã, no Jardim Aquarius, e a Clínica Bem Estar à tarde.',
    'Neste mês entraram R$ 8.450,00 e saíram R$ 4.100,00. Sobraram R$ 4.350,00. Amanhã vence o corino da Tecidos Vale, R$ 410,00.',
  ]);
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    timezoneId: TZ,
    locale: 'pt-BR',
    permissions: ['notifications'],
    storageState: await page.context().storageState(),
  });
  const phone = await phoneCtx.newPage();
  await phone.goto('/dono', { waitUntil: 'networkidle' });
  await expect(phone.getByTestId('dono-app')).toBeVisible();
  await save(phone, 'dono-hoje', 780);
  await phone
    .getByRole('navigation')
    .getByRole('button', { name: /Conversar/ })
    .click();
  await expect(phone.getByTestId('owner-chat')).toBeVisible();
  await phone.getByLabel('Sua pergunta').fill('Tem retirada amanhã?');
  await phone.getByRole('button', { name: 'Enviar' }).click();
  await expect(phone.getByText(/Amanhã tem 2 retiradas/)).toBeVisible({ timeout: 20_000 });
  await phone.getByLabel('Sua pergunta').fill('Quanto sobrou este mês?');
  await phone.getByRole('button', { name: 'Enviar' }).click();
  await expect(phone.getByText(/Sobraram R\$ 4\.350,00/)).toBeVisible({ timeout: 20_000 });
  await save(phone, 'dono-conversar', 780);
  await phone.getByRole('button', { name: /Hoje/ }).last().click();
  await phone.getByRole('button', { name: 'O que a IA pode fazer' }).click();
  await expect(phone.getByRole('button', { name: 'Parar tudo' })).toBeVisible();
  await save(phone, 'dono-ia', 780);
  await phoneCtx.close();
  ai.close();
});
