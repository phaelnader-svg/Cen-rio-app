import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { rootEnv } from '../env';
import { loginAdmin } from './helpers';
import { post } from './os-helpers';

/**
 * 2026-11-25 — Correções do app no celular (dados fictícios). Prints em CAPTURAS_DIR:
 * Conversar respondendo "tem retirada amanhã?" e a agenda do dia, o plano B do microfone,
 * campos com 16px (o iPhone não dá zoom sozinho) e as telas de aviso centralizadas.
 * A IA é falsa (ANTHROPIC_BASE_URL) só para os prints; os cartões vêm do sistema.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/correcoes-celular';
const TZ = 'America/Sao_Paulo';
const day = (o: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + o * 86_400_000));

test('capturas: correções do app no celular', async ({ page, browser }) => {
  test.skip(!process.env.ANTHROPIC_BASE_URL, 'Precisa da IA falsa (ANTHROPIC_BASE_URL).');
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  await loginAdmin(page);

  const addr = (street: string, district: string) => ({
    label: 'Casa',
    street,
    number: '120',
    district,
    city: 'São José dos Campos',
    state: 'SP',
    postalCode: '12200-000',
  });
  const pickupFor = async (name: string, a: ReturnType<typeof addr>, date: string, w: string[]) => {
    const c = await post(page, '/api/v1/customers', {
      kind: 'PF',
      name,
      phone: null,
      allowSimilar: true,
      addresses: [a],
    });
    const o = await post(page, '/api/v1/orders', {
      customerId: c.id,
      pickupAddressId: c.addresses[0].id,
      contractedService: 'Reforma com troca de tecido',
      agreedValueCents: 180000,
      paymentTerms: 'Metade na retirada',
      items: [{ pieceType: 'POLTRONA', description: 'Poltrona', quantity: 2 }],
    });
    return post(page, '/api/v1/pickups', {
      orderId: o.id,
      scheduledDate: date,
      windowStart: w[0],
      windowEnd: w[1],
      team: 'LOGISTICA_TERCEIRIZADA',
      items: o.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
  };
  const p1 = await pickupFor('Helena Prado', addr('Rua das Acácias', 'Jardim Aquarius'), day(1), [
    '09:00',
    '11:00',
  ]);
  await pickupFor('Marcos Teixeira', addr('Rua dos Ipês', 'Vila Adyana'), day(1), [
    '14:00',
    '16:00',
  ]);
  await pickupFor('Beatriz Lemos', addr('Rua das Palmeiras', 'Centro'), day(3), ['10:00', '12:00']);
  await post(page, '/api/v1/finance/payables', {
    beneficiary: 'Tecidos Exemplo Ltda',
    category: 'MATERIAL',
    description: 'Tecido suede',
    amountCents: 48000,
    dueDate: day(1),
  });
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(`SELECT set_config('app.company_id', '1', false)`);
  await db.query(`UPDATE company_settings SET plan = 'gestao_jogo'`);
  await db.query(`UPDATE pickup_requests SET bring_card_machine = true WHERE id = $1::uuid`, [
    p1.id,
  ]);
  await db.end();

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    timezoneId: TZ,
    storageState: await page.context().storageState(),
  });
  // Como no app instalado no iPhone: sem reconhecimento de voz do navegador.
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  });
  const phone = await context.newPage();
  const shot = (name: string, fullPage = false) =>
    phone.screenshot({ path: `${OUT}/${name}.png`, fullPage });

  await phone.goto('/dono');
  await expect(phone.getByTestId('dono-app')).toBeVisible();
  await phone
    .getByRole('navigation')
    .getByRole('button', { name: /Conversar/ })
    .click();
  await expect(phone.getByTestId('owner-chat')).toBeVisible();

  // Campo de escrever com 16px no celular: o iPhone não dá mais zoom sozinho ao tocar.
  const box = phone.getByLabel('Sua pergunta');
  expect(await box.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');

  // Microfone sem reconhecimento de voz: abre o teclado e explica o microfone do teclado.
  await phone.getByRole('button', { name: 'Falar' }).click();
  await expect(phone.getByTestId('voice-tip')).toContainText('microfone do teclado');
  await shot('1-microfone-plano-b');

  await box.fill('tem retirada amanhã?');
  await phone.getByRole('button', { name: 'Enviar' }).click();
  await expect(phone.getByText(/Tem sim\. Amanhã tem 2 retiradas/)).toBeVisible();
  await expect(phone.getByText('Helena Prado · ', { exact: false }).first()).toBeVisible();
  await shot('2-tem-retirada-amanha');

  await box.fill('o que tem amanhã?');
  await phone.getByRole('button', { name: 'Enviar' }).click();
  await expect(phone.getByText(/Amanhã tem 2 retiradas e 1 conta para pagar/)).toBeVisible();
  await phone.waitForTimeout(600);
  await shot('3-o-que-tem-amanha');

  // Telas de aviso centralizadas (computador).
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const d = await desk.newPage();
  await d.route('**/api/auth/email/confirm', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await d.goto('/entrar/confirmar?token=abcdefghijklmnopqrstuvwxyz');
  await expect(d.getByText('E-mail confirmado. Obrigado!')).toBeVisible();
  await d.screenshot({ path: `${OUT}/4-confirmar-email.png` });
  await d.goto('/entrar/esqueci');
  await d.waitForLoadState('networkidle');
  await d.screenshot({ path: `${OUT}/5-esqueci-a-senha.png` });
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mp = await m.newPage();
  await mp.goto('/entrar');
  await mp.waitForLoadState('networkidle');
  await mp.screenshot({ path: `${OUT}/6-entrar-celular.png` });

  // Escritório na web separado por menu (abas).
  for (const role of ['ATENDIMENTO', 'GERENTE', 'FINANCEIRO']) {
    const r = await page.request.post('/api/v1/office/hire', {
      data: { roleKey: role },
      headers: {
        origin: new URL(page.url()).origin,
        'idempotency-key': crypto.randomUUID().replace(/-/g, ''),
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
  }
  const db2 = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db2.connect();
  await db2.query(`SELECT set_config('app.company_id', '1', false)`);
  const text = (n: string) =>
    `Oi, ${n}! Aqui é da tapeçaria. Ficamos felizes com o seu serviço. Pode deixar uma avaliação para a gente?`;
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
  await page.setViewportSize({ width: 1440, height: 1150 });

  // Início: enquanto o "Hoje" carrega, o espaço dele já aparece no lugar (sem pular a página).
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/management/today*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/painel');
  await expect(page.getByTestId('today-skeleton')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/12-inicio-carregando.png` });
  release();
  await expect(page.getByTestId('today-panel')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/13-inicio-pronto.png` });
  await page.unroute('**/api/v1/management/today*');
  await page.goto('/painel/escritorio');
  await expect(page.getByRole('tab', { name: /Para aprovar/ })).toBeVisible();
  await expect(page.getByTestId('office-proposal').first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/7-escritorio-para-aprovar.png` });
  const tabs: [RegExp, string][] = [
    [/Pedir aos agentes/, '8-escritorio-pedir'],
    [/Relatórios/, '9-escritorio-relatorios'],
    [/O que fizeram/, '10-escritorio-o-que-fizeram'],
    [/Agentes e permissões/, '11-escritorio-agentes'],
  ];
  for (const [name, file] of tabs) {
    await page.getByRole('tab', { name }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${file}.png` });
  }
});
