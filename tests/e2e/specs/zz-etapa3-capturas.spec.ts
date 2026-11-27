import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * 2026-11-27 — Etapa 3 da lista de 53: repetir do último (7), prazo pela fila (12), lucro mínimo
 * (13), tempo das etapas (17), lucro por tipo de peça (18), folgas e prazos (19), padrão da casa
 * (20), "Como ficou?" (22) e cuidados com a peça (23). Dados fictícios. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/etapa3';
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR' };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'pt-BR',
};
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

async function call(
  page: Page,
  method: 'POST' | 'GET' | 'PUT' | 'PATCH',
  path: string,
  data?: unknown,
) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.status() === 204 ? null : r.json();
}

let n = 1;
async function shot(p: Page, name: string, fullPage = false) {
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-${name}.png`, fullPage });
}

test('capturas: etapa 3 da lista de 53', async ({ page, browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  // Telefone da empresa já cadastrado (senão a janela "Qual é o seu telefone?" cobre a tela).
  const me = await call(page, 'GET', '/api/auth/me');
  if (me.company?.needsWhatsapp)
    await call(page, 'POST', '/api/company/contact', { whatsapp: '(12) 99887-6655' });

  // ─────────── Base do orçamento: tecidos, espuma, mão de obra, alíquota e lucro mínimo.
  const add = async (body: Record<string, unknown>) =>
    (
      (await call(page, 'POST', '/api/v1/quotes/catalog', body)) as {
        id: string;
        kind: string;
        name: string;
      }[]
    )
      .filter((x) => x.kind === body.kind && x.name === body.name)
      .at(-1)!;
  const linho = await add({
    kind: 'MATERIAL',
    category: 'Tecidos',
    name: 'Linho Rústico',
    priceCents: 4500,
    unit: 'm',
  });
  await add({
    kind: 'MATERIAL',
    category: 'Tecidos',
    name: 'Veludo Cotelê',
    priceCents: 6900,
    unit: 'm',
  });
  await add({
    kind: 'MATERIAL',
    category: 'Tecidos',
    name: 'Corino Preto',
    priceCents: 3900,
    unit: 'm',
  });
  const d33 = await add({
    kind: 'MATERIAL',
    category: 'Espumas',
    name: 'D33',
    priceCents: 138000,
    unit: 'm³',
  });
  const sofaLabor = await add({
    kind: 'MAO_TAPECEIRO',
    name: 'Sofá reto - 3 lugares',
    priceCents: 40000,
  });
  const catalog = (await call(page, 'GET', '/api/v1/quotes/catalog')) as {
    id: string;
    kind: string;
    linkedItemId: string | null;
  }[];
  const helper = catalog.find((x) => x.kind === 'MAO_AJUDANTE' && x.linkedItemId === sofaLabor.id)!;
  await call(page, 'PATCH', `/api/v1/quotes/catalog/${helper.id}`, { priceCents: 12000 });
  const st = await call(page, 'GET', '/api/v1/quotes/settings');
  await call(page, 'PATCH', '/api/v1/quotes/settings', {
    version: st.version,
    taxRateBps: 600,
    minProfitBps: 3000,
  });

  const draft = (customerName: string, phone: string, profitCents: number) => ({
    customerName,
    phone,
    city: 'São José dos Campos',
    service: 'Reforma de Sofá',
    serviceOther: '',
    fabricChange: true,
    foamChange: true,
    items: [
      { id: 'a', catalogItemId: linho.id, qty: 9, heightCm: 0, widthCm: 0, lengthCm: 0 },
      { id: 'b', catalogItemId: d33.id, qty: 3, heightCm: 10, widthCm: 55, lengthCm: 190 },
    ],
    logisticsId: null,
    upholsteryServiceId: sofaLabor.id,
    helperServiceId: helper.id,
    sofaCount: 1,
    profitCents,
    feeId: null,
    deliveryDays: 20,
    validityDays: 15,
    paymentTerms: '50% na aprovação e 50% na entrega.',
    notes: '',
  });

  // ─────────── Quatro serviços fictícios, com OS e peças.
  const clientes = ['Ana Ribeiro', 'Paulo Souza', 'Beatriz Lima', 'Carlos Mota'];
  const sos: { id: string; code: string; items: { id: string }[] }[] = [];
  for (const c of clientes) sos.push(await openServiceOrder(page, c));
  const lucros = [52000, 38000, 61000, 9000];
  for (const [i, c] of clientes.entries()) {
    const q = await call(
      page,
      'POST',
      '/api/v1/quotes',
      draft(c, `(12) 99${i}12-34${i}7`, lucros[i]!),
    );
    const { rows } = await db.query('SELECT order_id FROM service_orders WHERE id = $1', [
      sos[i]!.id,
    ]);
    await db.query('UPDATE quotes SET order_id = $1 WHERE id = $2', [rows[0].order_id, q.id]);
  }
  // Cadeiras e cabeceira (outros tipos de peça) para o lucro por tipo.
  for (const [nome, itens, lucro] of [
    [
      'Restaurante Sabor da Serra',
      [{ pieceType: 'CADEIRA', description: 'Cadeiras de jantar', quantity: 8 }],
      64000,
    ],
    [
      'Hotel Vale Verde',
      [{ pieceType: 'CABECEIRA', description: 'Cabeceira king', quantity: 1 }],
      21000,
    ],
  ] as const) {
    const cust = await call(page, 'POST', '/api/v1/customers', {
      kind: 'PF',
      name: nome,
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Comercial',
          street: 'Avenida Fictícia',
          number: '500',
          district: 'Centro',
          city: 'São José dos Campos',
          state: 'SP',
          postalCode: '12200-000',
        },
      ],
    });
    const order = await call(page, 'POST', '/api/v1/orders', {
      customerId: cust.id,
      pickupAddressId: cust.addresses[0].id,
      contractedService: 'Reforma',
      agreedValueCents: 100000,
      paymentTerms: 'À vista',
      items: itens,
    });
    const q = await call(page, 'POST', '/api/v1/quotes', draft(nome, '', lucro));
    await db.query('UPDATE quotes SET order_id = $1 WHERE id = $2', [order.id, q.id]);
  }

  const ricardo = (
    (await call(page, 'GET', '/api/v1/production/workers')) as {
      displayName: string;
      userId: string;
    }[]
  ).find((w) => w.displayName.startsWith('Ricardo'))!;
  // ─────────── Histórico do tablet (tempo real de cada etapa, últimas semanas).
  const etapas: [string, number][] = [
    ['DESMONTAGEM', 55],
    ['CORTE_TECIDO', 70],
    ['COSTURA', 150],
    ['REVESTIMENTO', 240],
    ['ACABAMENTO', 60],
  ];
  // Serviços já entregues nas últimas semanas (só histórico).
  const antigos: typeof sos = [];
  for (const c of ['Fernanda Alves', 'Rogério Dias', 'Luciana Prado', 'Marcelo Cunha'])
    antigos.push(await openServiceOrder(page, c));
  for (const [i, so] of [...sos.slice(1), ...antigos].entries()) {
    for (const item of so.items) {
      for (const [act, min] of etapas) {
        const days = 3 + i * 7;
        const mins = Math.round(min * (0.85 + ((i * 7 + min) % 5) / 10));
        await db.query(
          `INSERT INTO production_tasks (id, company_id, service_order_id, service_order_item_id, activity, title,
             role, status, assignee_user_id, started_at, completed_at, updated_at)
           VALUES (gen_random_uuid(), 1, $1, $2, $3, $4, 'PRINCIPAL', 'CONCLUIDA', $7,
             now() - make_interval(days => $5::int) - make_interval(mins => $6::int),
             now() - make_interval(days => $5::int), now())`,
          [so.id, item.id, act, `Etapa ${act}`, days, mins, ricardo.userId],
        );
      }
    }
  }

  await db.query(
    `UPDATE service_order_items SET fulfillment_stage = 'ENTREGUE' WHERE service_order_id = ANY($1::uuid[])`,
    [[...sos.slice(1), ...antigos].map((s) => s.id)],
  );
  // ─────────── Entregas concluídas com as notas dos clientes (Ana ainda não respondeu).
  await db.query(
    `UPDATE service_order_items SET fabric_name = CASE WHEN piece_type = 'SOFA' THEN 'Veludo Cotelê' ELSE 'Linho Rústico' END
      WHERE service_order_id = ANY($1::uuid[])`,
    [sos.map((s) => s.id)],
  );
  const notas: [number | null, string | null, number][] = [
    [null, null, 0],
    [5, 'Ficou igual de loja, obrigado!', 2],
    [4, null, 5],
    [2, 'O braço esquerdo ficou mais alto que o direito.', 1],
  ];
  const entregas: string[] = [];
  for (const [i, so] of sos.entries()) {
    const [stars, comment, ago] = notas[i]!;
    const { rows } = await db.query(
      `INSERT INTO deliveries (id, company_id, customer_id, address_snapshot, scheduled_date, status, completed_at,
         origin, updated_at, rating_stars, rating_comment, rated_at)
       SELECT gen_random_uuid(), 1, o.customer_id,
         '{"street":"Rua das Acácias","number":"120","district":"Jardim Aquarius","city":"São José dos Campos","state":"SP"}'::jsonb,
         (now() - make_interval(days => $2::int))::date, 'CONCLUIDA', now() - make_interval(days => $2::int),
         'DIRETA', now(), $3::smallint, $4::varchar, CASE WHEN $3::smallint IS NULL THEN NULL ELSE now() - make_interval(days => $2::int) + interval '3 hours' END
       FROM service_orders o WHERE o.id = $1 RETURNING id`,
      [so.id, ago + 1, stars, comment],
    );
    entregas.push(rows[0].id);
    for (const item of so.items)
      await db.query(
        `INSERT INTO delivery_items (company_id, delivery_id, service_order_item_id, active, status, delivered_at)
         VALUES (1, $1, $2, false, 'ENTREGUE', now())`,
        [rows[0].id, item.id],
      );
  }

  const desk = page;

  // 1–3. Orçamento: telefone de quem já orçou → "Repetir do último"; lucro baixo; prazo pela fila.
  await desk.goto('/painel/orcamentos?tab=elaborar', { waitUntil: 'networkidle' });
  await desk.getByLabel('Telefone / WhatsApp').fill('(12) 99312-3437');
  await expect(desk.getByTestId('repetir-ultimo')).toBeVisible();
  await desk.getByTestId('repetir-ultimo').scrollIntoViewIfNeeded();
  await shot(desk, 'orcamento-repetir-do-ultimo');
  await desk.getByTestId('repetir-ultimo-botao').click();
  await expect(desk.getByTestId('lucro-baixo')).toBeVisible();
  await desk.getByTestId('lucro-baixo').scrollIntoViewIfNeeded();
  await desk.evaluate(() => window.scrollBy(0, -260));
  await shot(desk, 'orcamento-lucro-baixo');
  await desk.getByTestId('prazo-fila').scrollIntoViewIfNeeded();
  await desk.evaluate(() => window.scrollBy(0, -200));
  await shot(desk, 'orcamento-prazo-pela-fila');

  // 4–5. Base de dados: lucro mínimo e cuidados com os tecidos.
  await desk.goto('/painel/orcamentos?tab=base', { waitUntil: 'networkidle' });
  await desk.getByRole('tab', { name: 'Alíquota do serviço' }).click();
  await expect(desk.getByTestId('lucro-minimo')).toBeVisible();
  await shot(desk, 'base-lucro-minimo');
  await desk.getByRole('tab', { name: 'Cuidados com os tecidos' }).click();
  await expect(desk.getByTestId('cuidados-tecidos')).toBeVisible();
  await shot(desk, 'base-cuidados-dos-tecidos', true);

  // 6. Financeiro: lucro por tipo de peça.
  await desk.goto('/painel/financeiro?tab=pecas', { waitUntil: 'networkidle' });
  await expect(desk.getByTestId('lucro-por-peca')).toBeVisible();
  await shot(desk, 'financeiro-lucro-por-tipo-de-peca');

  // 7. Produtividade: tempo real de cada etapa por tipo de peça.
  await desk.goto('/painel/produtividade', { waitUntil: 'networkidle' });
  await desk.getByTestId('tempo-etapas').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await desk.evaluate(() => window.scrollBy(0, -90));
  await shot(desk, 'produtividade-tempo-das-etapas');

  // 8–10. "Como ficou?": o botão na entrega e a página do cliente no celular (antes e depois).
  await desk.goto(`/painel/entregas/${entregas[0]}`, { waitUntil: 'networkidle' });
  await expect(desk.getByTestId('pedir-avaliacao')).toBeVisible();
  await shot(desk, 'entrega-botao-como-ficou');
  const link = await call(desk, 'GET', `/api/v1/deliveries/${entregas[0]}/review-link`);
  const cliente = await browser.newContext({ ...PHONE, baseURL: origin });
  const cp = await cliente.newPage();
  await cp.goto(new URL(link.url).pathname + new URL(link.url).search, {
    waitUntil: 'networkidle',
  });
  await expect(cp.getByTestId('avaliar-pagina')).toBeVisible();
  await cp.getByTestId('estrela-5').click();
  await cp.getByTestId('avaliar-comentario').fill('Ficou linda, parece nova!');
  await shot(cp, 'cliente-como-ficou', true);
  await cp.getByTestId('avaliar-enviar').click();
  await expect(cp.getByTestId('avaliar-obrigado')).toBeVisible();
  await shot(cp, 'cliente-obrigado-e-cuidados', true);
  await cliente.close();

  // 11. Qualidade: notas dos clientes, com a nota baixa em vermelho.
  await desk.goto('/painel/qualidade?tab=ratings', { waitUntil: 'networkidle' });
  await expect(desk.getByTestId('notas-clientes')).toBeVisible();
  await shot(desk, 'qualidade-notas-dos-clientes');

  // 12. Folga marcada: as OS que ficam apertadas.
  const prazo = addDays(today(), 9);
  await db.query(`UPDATE service_orders SET promised_date = $1 WHERE id = ANY($2::uuid[])`, [
    prazo,
    [sos[0]!.id, sos[2]!.id],
  ]);
  const week = mondayOf(today());
  let plan = (await call(desk, 'GET', `/api/v1/production-plans?week=${week}`))[0];
  if (!plan)
    plan = await call(desk, 'POST', '/api/v1/production-plans', {
      weekStart: week,
      mode: 'FILA_SEMANAL',
    });
  await call(desk, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
    serviceOrderId: sos[0]!.id,
    pieces: sos[0]!.items.map((i) => ({
      serviceOrderItemId: i.id,
      upholstererUserId: ricardo.userId,
    })),
  });
  plan = await call(desk, 'GET', `/api/v1/production-plans/${plan.id}`);
  if (plan.status !== 'PUBLICADO')
    await call(desk, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
      version: plan.version,
      notes: 'Semana fictícia',
    });
  await db.query(
    `UPDATE production_tasks SET assignee_user_id = $1
      WHERE service_order_id = $2 AND status NOT IN ('CONCLUIDA','CANCELADA') AND activity = 'REVESTIMENTO'`,
    [ricardo.userId, sos[2]!.id],
  );
  await db.query(
    `INSERT INTO production_tasks (id, company_id, service_order_id, service_order_item_id, activity, title,
       role, status, assignee_user_id, updated_at)
     VALUES (gen_random_uuid(), 1, $1, $2, 'REVESTIMENTO', 'Revestimento das poltronas', 'PRINCIPAL', 'PROGRAMADA', $3, now())`,
    [sos[2]!.id, sos[2]!.items[1]!.id, ricardo.userId],
  );
  await desk.goto('/painel/presenca', { waitUntil: 'networkidle' });
  await desk.getByTestId('leave-new').click();
  const dlg = desk.getByRole('dialog');
  await dlg.getByLabel('Funcionário').selectOption({ label: ricardo.displayName });
  await dlg.getByLabel('Data inicial').fill(addDays(today(), 7));
  await dlg.getByLabel('Data final').fill(addDays(today(), 8));
  await expect(dlg.getByTestId('folga-impacto')).toBeVisible();
  await shot(desk, 'folga-os-apertadas');
  await desk.keyboard.press('Escape');

  // 13. Padrão da casa: o dono grava o texto e a foto de cada etapa.
  for (const [act, text] of [
    [
      'REVESTIMENTO',
      'Grampo a cada dois dedos, começando pelo meio e puxando para as pontas. Conferir o fio do tecido antes de grampear.',
    ],
    ['COSTURA', 'Linha 40 no veludo, ponto 3,5. Vivo sempre com cordão de 4 mm.'],
    [
      'DESMONTAGEM',
      'Fotografe a peça antes de desmontar. Guarde grampos e parafusos no pote com o número da OS.',
    ],
  ] as const) {
    const png = readFileSync(new URL('../fixtures/foto-gps.jpg', import.meta.url));
    const up = await desk.request.post('/api/v1/house-standards/upload', {
      headers: { origin },
      multipart: { file: { name: 'padrao.jpg', mimeType: 'image/jpeg', buffer: png } },
    });
    expect(up.ok(), await up.text()).toBe(true);
    await call(desk, 'PUT', `/api/v1/house-standards/${act}`, {
      text,
      fileId: act === 'COSTURA' ? null : (await up.json()).fileId,
    });
  }
  await desk.goto('/painel/producao/modelos?tab=padrao', { waitUntil: 'networkidle' });
  await expect(desk.getByTestId('padrao-casa')).toBeVisible();
  await shot(desk, 'padrao-da-casa-painel');

  // 14. Tablet do Ricardo: "Padrão da casa" aberto na tarefa de revestimento.
  await setPin(desk, ricardo.displayName, '771355');
  const tab = await openTablet(
    browser,
    await registerDevice(desk, 'Tablet Ricardo (etapa 3)', ricardo.displayName),
    '771355',
    undefined,
    { deviceScaleFactor: 2, timezoneId: TZ },
  );
  await tab.page
    .getByRole('button', { name: /^Abrir .*(Revestimento|Desmontagem|Costura)/ })
    .first()
    .click();
  await expect(tab.page.getByTestId('padrao-casa-tarefa')).toBeVisible();
  await tab.page.getByRole('button', { name: 'Padrão da casa' }).click();
  await shot(tab.page, 'tablet-padrao-da-casa-na-tarefa');
  await tab.context.close();
  await db.end();
});
