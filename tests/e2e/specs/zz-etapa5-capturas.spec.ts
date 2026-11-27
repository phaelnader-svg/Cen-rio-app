import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { chromium, expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Etapa 5 da lista de 53 (Firma Viva), prints para aprovação: teste de 7 dias (34), rosto no
 * crachá (35), fotos da peça (36), Gerente por voz (37), quadro da semana (38) e cliente
 * esperando (39). Precisa do Firma Viva local ligado a este Cenário:
 *   FIRMA_PRINT_URL=http://localhost:3200 (jogo em `next dev`), FIRMA_WEB_URL igual,
 *   FIRMA_CENARIO_CLIENT_SECRET (valor local qualquer, o mesmo do jogo),
 *   SPEECH_API_KEY=falsa SPEECH_BASE_URL=http://localhost:4199 (voz falsa, só para o print).
 * Fotos e rostos são desenhos de exemplo (nenhuma pessoa real).
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/etapa5';
const GAME = process.env.FIRMA_PRINT_URL ?? '';
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const sharp = createRequire(new URL('../../../apps/api/package.json', import.meta.url))(
  'sharp',
) as typeof import('sharp');

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: [
      '--lang=pt-BR',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
    env: { ...process.env, LANG: 'pt_BR.UTF-8', LANGUAGE: 'pt_BR' },
  },
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) =>
  addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.status() === 204 ? null : r.json();
}
async function upload(page: Page, path: string, fields: Record<string, string>, jpg: Buffer) {
  const r = await page.request.post(path, {
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
    multipart: { ...fields, file: { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: jpg } },
  });
  expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

let n = 1;
async function shot(p: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-${name}.png`, ...opts });
}

/** Rosto desenhado (exemplo), para a foto de Funcionários. */
function portrait(skin: string, hair: string, shirt: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <rect width="400" height="400" fill="#dfe7e4"/>
  <rect x="70" y="300" width="260" height="140" rx="90" fill="${shirt}"/>
  <rect x="170" y="250" width="60" height="70" fill="${skin}"/>
  <ellipse cx="200" cy="190" rx="92" ry="108" fill="${skin}"/>
  <path d="M108 170 Q110 80 200 78 Q290 80 292 170 Q270 120 200 118 Q130 120 108 170Z" fill="${hair}"/>
  <circle cx="165" cy="190" r="9" fill="#2b2b2b"/><circle cx="235" cy="190" r="9" fill="#2b2b2b"/>
  <path d="M168 245 Q200 268 232 245" stroke="#7a3b2e" stroke-width="7" fill="none" stroke-linecap="round"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

/** "Foto" de exemplo da peça (tecido e o desenho do sofá), com a etapa escrita. */
function piecePhoto(fabric: string, text: string, stage: 'antes' | 'estrutura' | 'pronto') {
  const body =
    stage === 'estrutura'
      ? `<rect x="150" y="260" width="500" height="150" fill="none" stroke="#a0703c" stroke-width="16"/>
         <rect x="150" y="190" width="500" height="80" fill="none" stroke="#a0703c" stroke-width="16"/>`
      : `<rect x="130" y="250" width="540" height="150" rx="30" fill="${fabric}"/>
         <rect x="150" y="170" width="500" height="110" rx="30" fill="${fabric}" opacity="0.9"/>
         <rect x="100" y="220" width="70" height="190" rx="25" fill="${fabric}"/>
         <rect x="630" y="220" width="70" height="190" rx="25" fill="${fabric}"/>
         ${stage === 'antes' ? '<path d="M300 290 l60 40 M420 300 l50 -30" stroke="#5b4a3a" stroke-width="8"/>' : ''}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
  <rect width="800" height="600" fill="#cfc6b8"/><rect y="430" width="800" height="170" fill="#9c8f7c"/>
  ${body}
  <rect x="140" y="400" width="20" height="40" fill="#3a2a1a"/><rect x="640" y="400" width="20" height="40" fill="#3a2a1a"/>
  <rect x="20" y="20" width="${text.length * 17 + 30}" height="52" rx="10" fill="rgba(0,0,0,0.55)"/>
  <text x="35" y="56" font-family="sans-serif" font-size="28" fill="#fff">${text}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

/** Voz falsa (Google Speech): devolve sempre a mesma frase. */
function fakeSpeech(text: string): Promise<Server> {
  const server = createServer((req, res) => {
    appendFileSync(
      `${OUT}/../voz-falsa.log`,
      `${new Date().toISOString()} ${req.method} ${req.url}\n`,
    );
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ alternatives: [{ transcript: text }] }] }));
    });
  });
  return new Promise((ok) => server.listen(4199, () => ok(server)));
}

test('capturas: etapa 5 (Firma Viva)', async ({ page, browser }) => {
  test.skip(!GAME, 'Precisa do Firma Viva local (FIRMA_PRINT_URL).');
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const env = rootEnv();
  const db = new pg.Client({ connectionString: env.E2E_DATABASE_URL });
  await db.connect();

  // Firma Viva cadastrado como aplicativo deste Cenário (segredo só na variável).
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@cenario/api',
      'app-client',
      '--',
      '--id',
      'firma-viva',
      '--name',
      'Firma Viva',
      '--redirect',
      `${GAME}/api/conexoes/cenario/retorno`,
      '--scopes',
      'jogo,operacao,escritorio',
      '--secret-env',
      'FIRMA_CENARIO_CLIENT_SECRET',
    ],
    { cwd: '../..', env: { ...process.env, DATABASE_URL: env.E2E_DATABASE_URL }, stdio: 'pipe' },
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const me = await call(page, 'GET', '/api/auth/me');
  if (me.company?.needsWhatsapp)
    await call(page, 'POST', '/api/company/contact', { whatsapp: '(12) 99887-6655' });
  await db.query(`SELECT set_config('app.company_id', '1', false)`);
  await db.query(`UPDATE users SET display_name = 'Marcos Oliveira' WHERE email = $1`, [
    E2E.admin.email,
  ]);
  await db.query(
    `UPDATE company_settings SET trade_name = 'Tapeçaria Exemplo', plan = 'gestao', game_trial_ends_at = NULL,
       billing_courtesy = false, paid_until = now() + interval '18 days',
       setup_done_at = now(), getting_started_hidden_at = now()`,
  );
  await db.query(`UPDATE platform_settings SET whatsapp = '12999990000'`).catch(() => undefined);

  // ─────────── Oficina fictícia.
  const jobs: [string, number][] = [
    ['Mariana Lopes', 9],
    ['Fernanda Rocha', 4],
    ['Clínica Bem Estar', 1],
    ['Joaquim Ferreira', 12],
    ['Helena Prado', 3],
    ['Restaurante Sabor da Serra', 6],
    ['Paulo Mendes', 2],
    ['Ana Beatriz Souza', 1],
    ['Rogério Lima', -7],
    ['Sandra Vieira', -6],
  ];
  const sos: Record<string, { id: string; order: { id: string }; items: { id: string }[] }> = {};
  for (const [name, days] of jobs) {
    const so = await openServiceOrder(page, name);
    sos[name] = so;
    await db.query(`UPDATE service_orders SET promised_date = $1::date WHERE id = $2::uuid`, [
      addDays(today(), days),
      so.id,
    ]);
  }
  const workers = (await call(page, 'GET', '/api/v1/production/workers')) as {
    displayName: string;
    userId: string;
    employeeId?: string;
    isTapeceiro: boolean;
  }[];
  const tapeceiros = workers.filter((w) => w.isTapeceiro);
  const week = mondayOf(today());
  let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
  if (!plan)
    plan = await call(page, 'POST', '/api/v1/production-plans', {
      weekStart: week,
      mode: 'FILA_SEMANAL',
    });
  for (const [i, name] of [
    'Mariana Lopes',
    'Fernanda Rocha',
    'Clínica Bem Estar',
    'Joaquim Ferreira',
  ].entries())
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
      serviceOrderId: sos[name]!.id,
      pieces: sos[name]!.items.map((it) => ({
        serviceOrderItemId: it.id,
        upholstererUserId: tapeceiros[i % tapeceiros.length]!.userId,
      })),
    });
  plan = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
  if (plan.status !== 'PUBLICADO')
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
      version: plan.version,
      notes: 'Semana de exemplo',
    });

  // Item 39: peças prontas e paradas (Helena há 4 dias, Restaurante há 2).
  for (const [name, days] of [
    ['Helena Prado', 4],
    ['Restaurante Sabor da Serra', 2],
  ] as const) {
    for (const it of sos[name]!.items) {
      await db.query(
        `UPDATE service_order_items SET fulfillment_stage = 'PRONTA_ENTREGA' WHERE id = $1::uuid`,
        [it.id],
      );
      await db.query(
        `INSERT INTO quality_events (id, company_id, service_order_item_id, kind, data, created_at)
         VALUES (gen_random_uuid(), 1, $1::uuid, 'ETAPA', '{"to":"PRONTA_ENTREGA"}'::jsonb, now() - ($2 || ' days')::interval - interval '2 hours')`,
        [it.id, String(days)],
      );
    }
  }
  // Item 38: entregas desta semana e da semana passada; prazos que passaram.
  const customerOf = async (soId: string) =>
    (await db.query(`SELECT customer_id FROM service_orders WHERE id = $1::uuid`, [soId])).rows[0]
      .customer_id as string;
  let num = 9100;
  const deliver = async (name: string, when: string) => {
    const so = sos[name]!;
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO deliveries (id, company_id, number, customer_id, address_snapshot, scheduled_date, status, completed_at, updated_at)
       VALUES ($1::uuid, 1, $2, $3::uuid, '{}'::jsonb, $4::date, 'CONCLUIDA', $5::timestamptz, now())`,
      [id, num++, await customerOf(so.id), when.slice(0, 10), when],
    );
    for (const it of so.items) {
      await db.query(
        `INSERT INTO delivery_items (company_id, delivery_id, service_order_item_id, status, delivered_at, active)
         VALUES (1, $1::uuid, $2::uuid, 'ENTREGUE', $3::timestamptz, false)`,
        [id, it.id, when],
      );
      await db.query(
        `UPDATE service_order_items SET fulfillment_stage = 'ENTREGUE' WHERE id = $1::uuid`,
        [it.id],
      );
    }
  };
  const monday = mondayOf(today());
  await deliver('Paulo Mendes', `${monday}T17:00:00-03:00`);
  await deliver('Ana Beatriz Souza', `${today()}T09:30:00-03:00`);
  await deliver('Fernanda Rocha', `${today()}T08:15:00-03:00`);
  await deliver('Rogério Lima', `${addDays(monday, -6)}T16:00:00-03:00`);
  await deliver('Sandra Vieira', `${addDays(monday, -5)}T11:00:00-03:00`);
  // Prazos: um atrasado nesta semana (Clínica, segunda) e dois na passada (Rogério, Sandra).
  await db.query(`UPDATE service_orders SET promised_date = $1::date WHERE id = $2::uuid`, [
    monday,
    sos['Clínica Bem Estar']!.id,
  ]);
  await db.query(`UPDATE service_orders SET promised_date = $1::date WHERE id = ANY($2::uuid[])`, [
    addDays(monday, -7),
    [sos['Rogério Lima']!.id, sos['Sandra Vieira']!.id],
  ]);
  // Dinheiro: recebido nesta semana e na passada.
  await db.query(`UPDATE commercial_orders SET agreed_value_cents = 350000`);
  for (const [i, name] of ['Mariana Lopes', 'Fernanda Rocha', 'Joaquim Ferreira'].entries()) {
    const cents = [280000, 190000, 240000][i]!;
    const r = await call(page, 'POST', '/api/v1/finance/receivables', {
      orderId: sos[name]!.order.id,
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
  await db.query(
    `INSERT INTO manual_revenues (id, company_id, received_at, description, category, amount_cents, method)
     VALUES (gen_random_uuid(), 1, $1::date, 'Reformas da semana passada', 'SERVICO', 540000, 'PIX')`,
    [addDays(today(), -7)],
  );

  // Item 35: fotos (desenhos de exemplo) em Funcionários.
  const looks = [
    ['#e8b996', '#3b2a1e', '#2f6f68'],
    ['#c68863', '#1d1d1d', '#a0574f'],
    ['#8d5a3b', '#111111', '#4a6688'],
    ['#f1c7a8', '#7a4b2a', '#6b6f58'],
  ];
  const emps = (
    await db.query(
      `SELECT e.id, e.display_name FROM employees e JOIN users u ON u.id = e.user_id WHERE e.active AND u.active ORDER BY e.display_name`,
    )
  ).rows as { id: string; display_name: string }[];
  for (const [i, e] of emps.entries()) {
    const [skin, hair, shirt] = looks[i % looks.length]!;
    await upload(page, `/api/employees/${e.id}/photo`, {}, await portrait(skin!, hair!, shirt!));
  }

  // Todo mundo chegou hoje (no jogo, ninguém aparece como ausente).
  await db.query(
    `INSERT INTO operational_attendances (id, company_id, employee_id, date, situation, arrived_at, arrival_kind, availability, updated_at)
     SELECT gen_random_uuid(), 1, e.id, $1::date, 'PRESENTE', now() - interval '3 hours', 'NO_HORARIO', 'DISPONIVEL', now()
       FROM employees e WHERE e.active
     ON CONFLICT DO NOTHING`,
    [today()],
  );

  // Item 36: fotos da peça (OS na chegada e as do tablet nas etapas).
  const mariana = sos['Mariana Lopes']!;
  await upload(
    page,
    '/api/v1/attachments',
    { entityType: 'SERVICE_ORDER', entityId: mariana.id, caption: 'Como chegou' },
    await piecePhoto('#8a6d52', 'Na chegada', 'antes'),
  );
  const tasks = (
    await db.query(
      `SELECT id, title, assignee_user_id FROM production_tasks WHERE service_order_item_id = $1::uuid ORDER BY sequence NULLS LAST, created_at LIMIT 2`,
      [mariana.items[0]!.id],
    )
  ).rows as { id: string; title: string; assignee_user_id: string | null }[];
  const stages: ['estrutura' | 'pronto', string, string][] = [
    ['estrutura', '#7a5c3a', 'Estrutura refeita'],
    ['pronto', '#2f6f68', 'Tecido novo aplicado'],
  ];
  for (const [i, t] of tasks.entries()) {
    const [stage, color, caption] = stages[i]!;
    const a = await upload(
      page,
      '/api/v1/attachments',
      { entityType: 'PRODUCTION_TASK', entityId: t.id, caption },
      await piecePhoto(color, caption, stage),
    );
    if (t.assignee_user_id)
      await db.query(`UPDATE attachments SET created_by_id = $1::uuid WHERE id = $2::uuid`, [
        t.assignee_user_id,
        a.id,
      ]);
  }

  // ─────────── Item 34: plano de R$ 399 → "Experimentar o Firma Viva".
  // Microfone falso (som de teste do Chromium) para o print da voz.
  const micBrowser = await chromium.launch({
    executablePath: env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  void browser;
  const ctx = await micBrowser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: TZ,
    locale: 'pt-BR',
    permissions: ['notifications', 'microphone'],
    storageState: await page.context().storageState(),
  });
  const desk = await ctx.newPage();
  await desk.goto('/painel', { waitUntil: 'networkidle' });
  for (const b of await desk.getByRole('button', { name: 'Entendi', exact: true }).all())
    if (await b.isVisible()) await b.click();
  await expect(desk.getByTestId('firma-experimentar')).toBeVisible();
  await desk.screenshot({
    path: `${OUT}/${String(n++).padStart(2, '0')}-topo-experimentar.png`,
    clip: { x: 0, y: 0, width: 1440, height: 260 },
  });
  await desk.getByTestId('firma-experimentar').click();
  await shot(desk, 'experimentar-explicacao');
  await desk.getByTestId('firma-comecar').click();
  await expect(desk.getByTestId('firma-abrir')).toBeVisible();
  await shot(desk, 'experimentar-comecou');
  await desk.keyboard.press('Escape');
  await expect(desk.getByTestId('firma-teste-dias')).toBeVisible();
  await desk.screenshot({
    path: `${OUT}/${String(n++).padStart(2, '0')}-topo-em-teste.png`,
    clip: { x: 0, y: 0, width: 1440, height: 260 },
  });
  await desk.goto('/painel/assinatura', { waitUntil: 'networkidle' });
  await shot(desk, 'assinatura-em-teste');

  // ─────────── Jogo (entra pelo botão, sem login).
  const ai = await fakeSpeech('cadê o sofá da Mariana');
  await desk.goto('/ambiente-interativo');
  await desk.waitForURL(/\/jogo/, { timeout: 120_000 });
  await desk.waitForTimeout(4000);
  await shot(desk, 'jogo-entrou');
  await desk
    .getByRole('button', { name: 'Começar o dia' })
    .click({ timeout: 8000 })
    .catch(() => undefined);
  await desk
    .getByTestId('tutorial-skip')
    .click({ timeout: 15_000 })
    .catch(() => undefined);
  await desk.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = 'nextjs-portal{display:none!important}';
    document.head.appendChild(st);
  });
  for (const name of ['Começar o dia', 'Fechar', 'Entendi', 'Agora não', 'Depois'])
    for (const b of await desk.getByRole('button', { name, exact: true }).all())
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => undefined);
  await desk.waitForTimeout(2500);
  await shot(desk, 'jogo-oficina');
  type Eng = { screenOf: (id: string, h?: number) => { x: number; y: number } | null };
  const at = (id: string, h = 0.6) =>
    desk.evaluate(
      ([i, hh]) =>
        (window as unknown as { __cenarioGame?: Eng }).__cenarioGame?.screenOf(
          i as string,
          hh as number,
        ) ?? null,
      [id, h] as const,
    );
  const clickAt = async (id: string, h = 0.6) => {
    const p = await at(id, h);
    if (!p) return false;
    await desk.mouse.click(p.x, p.y);
    await desk.waitForTimeout(1200);
    return true;
  };
  /** Centraliza a câmera num objeto ou pessoa do jogo (size = largura da vista, em metros). */
  const focusOn = (id: string, size: number) =>
    desk.evaluate(
      ([i, s]) => {
        type O = {
          getWorldPosition: (v: unknown) => { x: number; z: number };
          position: { clone: () => unknown };
        };
        const e = (window as unknown as { __cenarioGame?: Record<string, unknown> })
          .__cenarioGame as
          | {
              objects: Map<string, O>;
              people: Map<string, { g: O }>;
              focus: (x: number, y: number, s: number) => void;
            }
          | undefined;
        const o = e?.objects.get(i as string) ?? e?.people.get(i as string)?.g;
        if (!e || !o) return false;
        const v = o.getWorldPosition(o.position.clone());
        e.focus(v.x * 100, v.z * 100, s as number);
        return true;
      },
      [id, size] as const,
    );
  const closeSide = async () => {
    await desk.keyboard.press('Escape');
    await desk.waitForTimeout(500);
  };
  // Item 38: quadro da semana.
  if (await focusOn('semana', 4)) {
    await desk.waitForTimeout(2000);
    await shot(desk, 'quadro-da-semana-perto');
    if (await clickAt('semana', 1.45)) await shot(desk, 'quadro-da-semana-painel');
    await closeSide();
  }
  // Item 39: cliente esperando.
  const helena = sos['Helena Prado']!.id;
  if (await focusOn(helena, 9)) {
    await desk.waitForTimeout(2000);
    await shot(desk, 'cliente-esperando');
    if (await clickAt(helena, 1.0)) await shot(desk, 'cliente-esperando-peca');
    await closeSide();
  }
  // Item 36: fotos da peça da Mariana.
  await focusOn(mariana.items[0]!.id, 6);
  await desk.waitForTimeout(1500);
  // Abre a peça como um clique nela (sem depender de quem está na frente).
  const opened = await desk.evaluate((id) => {
    const e = (
      window as unknown as {
        __cenarioGame?: { cb: { onPick: (t: unknown, p: null, ev: PointerEvent) => void } };
      }
    ).__cenarioGame;
    if (!e) return false;
    e.cb.onPick({ kind: 'piece', id }, null, new PointerEvent('pointerup'));
    return true;
  }, mariana.items[0]!.id);
  if (opened) {
    await desk.waitForTimeout(1500);
    await desk
      .getByRole('tab', { name: 'Serviço e fotos' })
      .click()
      .catch(() => desk.getByRole('button', { name: 'Serviço e fotos' }).click());
    await expect(desk.getByTestId('piece-photos')).toBeVisible({ timeout: 15_000 });
    await desk.waitForTimeout(1500);
    await shot(desk, 'peca-fotos');
    const first = desk.getByTestId('piece-photos').getByRole('button').nth(1);
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      await shot(desk, 'peca-foto-grande');
      await desk.getByTestId('photo-viewer').getByRole('button', { name: 'Fechar' }).click();
    }
    await closeSide();
  }
  // Item 35: rosto no crachá e na etiqueta.
  const ricardo = tapeceiros[0]!.userId;
  if (await focusOn(ricardo, 3)) {
    await desk.waitForTimeout(2000);
    await shot(desk, 'cracha-com-foto');
    if (await clickAt(ricardo, 1.0)) await shot(desk, 'funcionario-com-foto');
    await closeSide();
  }
  // Item 37: Gerente por voz (microfone e voz de exemplo).
  const mic = desk.getByTestId('gerente-mic');
  if (await mic.isVisible().catch(() => false)) {
    const box = (await mic.boundingBox())!;
    await desk.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await desk.mouse.down();
    await desk.waitForTimeout(1500);
    await shot(desk, 'gerente-ouvindo');
    await desk.mouse.up();
    await desk.waitForTimeout(3000);
    await desk
      .getByText('Pensando...')
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .catch(() => undefined);
    await desk.waitForTimeout(1000);
    await shot(desk, 'gerente-respondeu');
  }
  ai.close();
  await db.end();
  await ctx.close();
  await micBrowser.close();
});
