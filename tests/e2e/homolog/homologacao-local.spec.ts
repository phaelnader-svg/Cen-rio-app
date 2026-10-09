import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { openTablet, registerDevice, setPin } from '../specs/helpers';

/**
 * Homologação contra uma instância EM EXECUÇÃO — a local (scripts/homolog-local.sh) ou a pilha
 * de homologação atrás do Caddy (HTTPS + autenticação adicional no proxy). Somente dados
 * fictícios. Cada execução cria registros novos (nomes com carimbo de data), sem apagar nada.
 * Evidências: HOMOLOG_EVIDENCE_DIR (padrão docs/evidencias/homologacao-local/).
 */
const WEB = process.env.HOMOLOG_WEB_URL!;
// Sem porta da API (pilha atrás do proxy): saúde e prontidão consultadas pelo próprio domínio.
const API = process.env.API_PORT ? `http://127.0.0.1:${process.env.API_PORT}` : WEB;
const ADMIN = { email: process.env.SEED_ADMIN_EMAIL!, password: process.env.SEED_ADMIN_PASSWORD! };
const OUT = `../../${process.env.HOMOLOG_EVIDENCE_DIR ?? 'docs/evidencias/homologacao-local'}`;
const PROXY = process.env.HOMOLOG_BASIC_USER
  ? { username: process.env.HOMOLOG_BASIC_USER, password: process.env.HOMOLOG_BASIC_PASSWORD! }
  : undefined;
const IGNORE_TLS = process.env.HOMOLOG_IGNORE_HTTPS === '1';
/** Opções dos contextos extras (tablets e celulares): mesmas credenciais do proxy e HTTPS de teste. */
const CTX = { httpCredentials: PROXY, ignoreHTTPSErrors: IGNORE_TLS };
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const results: { etapa: string; resultado: string }[] = [];
const ok = (etapa: string, resultado = 'OK') => results.push({ etapa, resultado });
const shot = (p: Page, name: string, fullPage = false) =>
  p.screenshot({ path: `${OUT}/${name}.png`, fullPage });

/** Requisição HTTPS "crua" (sem nenhuma credencial herdada da configuração do Playwright). */
function raw(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = httpsRequest(
        `${WEB}${path}`,
        { headers, rejectUnauthorized: !IGNORE_TLS },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

async function call(page: Page, method: string, path: string, data?: unknown, expected = 0) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin: WEB, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  if (expected) expect(r.status(), `${method} ${path}: ${await r.text()}`).toBe(expected);
  else expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function login(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(ADMIN.email);
  await page.getByLabel('Senha').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/painel$/);
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
}

/** Visita uma tela: sem erro de JavaScript, com título e sem rolagem horizontal. */
async function visit(page: Page, route: string) {
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
  page.on('pageerror', onError);
  const res = await page.goto(route, { waitUntil: 'networkidle' });
  const h1 = await page
    .locator('h1')
    .first()
    .textContent({ timeout: 5000 })
    .catch(() => null);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  page.off('pageerror', onError);
  return { route, status: res?.status() ?? 0, h1: h1?.trim() ?? null, overflow, errors };
}

test.describe.serial('Homologação local — instância em execução', () => {
  test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
  test.afterAll(() =>
    writeFileSync(
      `${OUT}/resultado.json`,
      JSON.stringify({ executadoEm: new Date().toISOString(), web: WEB, results }, null, 2),
    ),
  );

  test('0. Proxy: HTTPS, autenticação adicional e WebSocket só com o cookie de acesso', async ({
    browser,
  }) => {
    test.skip(!PROXY, 'Instância sem proxy de autenticação (homologação local direta).');
    const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    const semCredencial = await raw('/painel');
    expect(semCredencial.status).toBe(401);
    expect(String(semCredencial.headers['www-authenticate'])).toMatch(/^Basic/);
    expect(semCredencial.body).not.toContain('Cenário');
    expect((await raw('/api/ready')).status).toBe(401);
    expect((await raw('/api/realtime')).status).toBe(401);
    const errada = await raw('/painel', { authorization: basic(PROXY!.username, 'senha-errada') });
    expect(errada.status).toBe(401);
    expect(String(errada.headers['set-cookie'] ?? '')).not.toContain('cenario_homolog');
    const liberada = await raw('/entrar', {
      authorization: basic(PROXY!.username, PROXY!.password),
    });
    expect(liberada.status).toBe(200);
    const cookie = String(liberada.headers['set-cookie'] ?? '');
    expect(cookie).toMatch(/cenario_homolog=[0-9a-f]{64}/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    const token = /cenario_homolog=([0-9a-f]{64})/.exec(cookie)![1]!;
    expect((await raw('/api/ready', { cookie: `cenario_homolog=${token}` })).status).toBe(200);
    expect((await raw('/api/ready', { cookie: `cenario_homolog=${'0'.repeat(64)}` })).status).toBe(
      401,
    );
    ok(
      'Proxy: sem credencial 401 (nada exposto, inclusive /api e o WebSocket); senha errada 401; senha certa grava cookie Secure/HttpOnly; cookie falso 401',
    );

    // Só o cookie (como um app adicionado à tela inicial depois da primeira autenticação).
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: IGNORE_TLS,
      httpCredentials: undefined,
    });
    await ctx.addCookies([
      { name: 'cenario_homolog', value: token, url: WEB, secure: true, httpOnly: true },
    ]);
    const page = await ctx.newPage();
    const sockets: string[] = [];
    const comAutorizacao: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    page.on('request', (r) => {
      void r.allHeaders().then((h) => {
        if (h.authorization) comAutorizacao.push(r.url());
      });
    });
    await login(page);
    expect(comAutorizacao, 'nenhuma requisição deve usar a senha do proxy').toEqual([]);
    expect(sockets.some((u) => u.startsWith('wss://') && u.endsWith('/api/realtime'))).toBe(true);
    await shot(page, 'proxy-cookie-painel');
    await ctx.close();
    ok('Só com o cookie de acesso: painel, login e WebSocket wss:// /api/realtime conectado');
  });

  test('1. API: saúde, prontidão e proteções de acesso', async ({ request }) => {
    expect((await (await request.get(`${API}/api/health`)).json()).status).toBe('ok');
    expect((await (await request.get(`${API}/api/ready`)).json()).status).toBe('ready');
    expect((await request.get(`${WEB}/api/v1/orders`)).status()).toBe(401);
    const foreign = await request.post(`${WEB}/api/auth/login`, {
      data: ADMIN,
      headers: { origin: 'https://site-estranho.example' },
    });
    expect(foreign.status()).toBe(403);
    const wrong = await request.post(`${WEB}/api/auth/login`, {
      data: { email: ADMIN.email, password: 'senha-errada-123' },
      headers: { origin: WEB },
    });
    expect(wrong.status()).toBe(401);
    const page = await request.get(`${WEB}/painel`);
    expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers()['x-frame-options']).toBe('DENY');
    ok('API: health/ready; anônimo 401; origem estranha 403; senha errada 401; CSP e X-Frame');
  });

  test('2. Painel e oficina: login, dados sintéticos, quatro tablets, logística e sincronização', async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await shot(page, 'painel-inicio');
    ok('Login do gestor no painel e tempo real conectado');

    // Configuração de homologação: chegada liberada a qualquer hora (testes fora do expediente).
    const settings = await call(page, 'GET', '/api/company/settings');
    await call(page, 'PUT', '/api/company/settings', {
      ...settings,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      arrivalWindowStart: '00:00',
      workdayStart: '00:00',
      arrivalAlertAt: '23:00',
      workdayEnd: '23:59',
    });
    ok('Expediente de homologação configurado (00:00–23:59, todos os dias)');

    // Dados sintéticos: OS aberta (cliente fictício → pedido → recebimento → OS).
    const customer = await call(page, 'POST', '/api/v1/customers', {
      kind: 'PF',
      name: `Cliente Fictício Homologação ${stamp}`,
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Residência',
          street: 'Rua Fictícia de Homologação',
          number: '10',
          district: 'Bairro Teste',
          city: 'Cidade Teste',
          state: 'SP',
          postalCode: '01000-000',
        },
      ],
    });
    const order = await call(page, 'POST', '/api/v1/orders', {
      customerId: customer.id,
      pickupAddressId: customer.addresses[0].id,
      contractedService: 'Reforma completa (fictício)',
      agreedValueCents: 320000,
      paymentTerms: '50% na retirada, 50% na entrega',
      items: [
        { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
        { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
      ],
    });
    await call(page, 'POST', '/api/v1/receipts', {
      orderId: order.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      lines: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
        condition: 'BOA',
        location: 'Área de recebimento',
      })),
    });
    const so = await call(page, 'POST', '/api/v1/service-orders', {
      orderId: order.id,
      items: [
        {
          orderItemId: order.items[0].id,
          quantity: 1,
          description: 'Sofá 3 lugares',
          serviceType: 'REFORMA_COMPLETA',
        },
        {
          orderItemId: order.items[1].id,
          quantity: 2,
          description: 'Poltronas',
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    });
    ok('Cliente, pedido, recebimento e OS fictícios criados pela API', so.number ?? so.id);

    // Programação da semana com as quatro pessoas da oficina.
    const workers = await call(page, 'GET', '/api/v1/production/workers');
    const w = (n: string) =>
      workers.find((x: { displayName: string }) => x.displayName.startsWith(n));
    const week = mondayOf(today());
    let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
    if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: week });
    const reason = 'Homologação local';
    const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
      serviceOrderId: so.id,
      principalUserId: w('Ricardo').userId,
      date: today(),
      reason,
    });
    for (const t of added.tasks as { id: string; status: string; serviceOrder: { id: string } }[])
      if (t.serviceOrder.id === so.id && !['CONCLUIDA', 'CANCELADA'].includes(t.status))
        await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, {
          reason: 'Fora do roteiro da homologação',
        });
    const titles = {
      Ricardo: `Revestimento do sofá (homologação ${stamp})`,
      Márcio: `Revestimento das poltronas (homologação ${stamp})`,
      João: `Preparação do sofá (homologação ${stamp})`,
      Thiago: `Acabamento de apoio (homologação ${stamp})`,
    } as const;
    const ids: Record<string, string> = {};
    for (const [name, item, activity, role] of [
      ['Ricardo', so.items[0].id, 'REVESTIMENTO', 'PRINCIPAL'],
      ['Márcio', so.items[1].id, 'REVESTIMENTO', 'PRINCIPAL'],
      ['João', so.items[0].id, 'PREPARACAO', 'APOIO'],
      ['Thiago', so.items[1].id, 'ACABAMENTO', 'APOIO'],
    ] as const) {
      const t = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        serviceOrderItemId: item,
        activity,
        role,
        title: titles[name],
        assigneeUserId: w(name).userId,
        date: today(),
        time: '00:00',
        reason,
      });
      ids[name] = t.id;
    }
    const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
    if (draft.status !== 'PUBLICADO')
      await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
        version: draft.version,
      });
    ok('Programação semanal com 4 tarefas publicada');

    // Quatro tablets + celulares da logística (André e Izaías).
    const pins = {
      Ricardo: '482915',
      Márcio: '736152',
      João: '591837',
      Thiago: '271828',
      André: '640273',
      Izaías: '815926',
    } as const;
    const devices: Record<string, { page: Page; close: () => Promise<void> }> = {};
    const open = async (b: Browser, name: keyof typeof pins, phone = false) => {
      const display = w(name)?.displayName ?? name;
      await setPin(page, display, pins[name]);
      const code = await registerDevice(
        page,
        `${phone ? 'Celular' : 'Tablet'} ${name} ${stamp}`,
        display,
      );
      const t = await openTablet(
        b,
        code,
        pins[name],
        phone ? { width: 390, height: 844, isMobile: true } : undefined,
        CTX,
      );
      devices[name] = { page: t.page, close: () => t.context.close() };
    };
    for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'] as const) await open(browser, name);
    ok('PIN, cadastro, vinculação e entrada dos 4 tablets (Ricardo, Márcio, João, Thiago)');

    await Promise.all(
      (Object.keys(titles) as (keyof typeof titles)[]).map(async (name) => {
        const p = devices[name]!.page;
        await p.reload();
        const card0 = p.getByTestId('presence-card');
        await expect(card0).toBeVisible();
        if ((await card0.getAttribute('data-state')) === 'pending')
          await p.getByTestId('arrive-button').click();
        await expect(p.getByTestId('presence-status')).toContainText('Presente desde');
        const card = p
          .getByTestId('my-tasks-today')
          .locator('[data-testid^="my-task-"]')
          .filter({ hasText: titles[name] });
        await card
          .getByRole('button', { name: /^Abrir/ })
          .first()
          .click();
        await p.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
        await expect(p.getByTestId('my-task-detail')).toContainText('Em execução');
      }),
    );
    for (const name of Object.keys(ids)) {
      const t = await call(page, 'GET', `/api/v1/production-tasks/${ids[name]}`);
      expect(t.status, name).toBe('EM_EXECUCAO');
    }
    for (const name of Object.keys(devices)) await shot(devices[name]!.page, `tablet-${name}`);
    await page.goto('/painel/producao');
    await expect(page.getByText(titles.Ricardo).first()).toBeVisible();
    await shot(page, 'painel-quadro-producao');
    ok('Chegada e início simultâneo nos 4 tablets; quadro do painel atualizado');

    // Tablets nunca exibem valores financeiros.
    for (const name of Object.keys(devices)) {
      const text = (await devices[name]!.page.locator('body').textContent()) ?? '';
      expect(text, name).not.toMatch(/R\$\s?\d/);
      const r = await devices[name]!.page.request.get('/api/v1/finance/receivables', {
        headers: { origin: WEB },
      });
      expect(r.status(), name).toBe(403);
    }
    ok('Tablets sem valores financeiros na tela e 403 nas rotas financeiras');

    // Queda de conexão do Márcio enquanto o gestor muda a prioridade.
    const mp = devices['Márcio']!.page;
    await mp.context().setOffline(true);
    await expect(mp.getByTestId('offline-banner')).toBeVisible({ timeout: 20_000 });
    const cur = await call(page, 'GET', `/api/v1/production-tasks/${ids['Márcio']}`);
    await call(page, 'PUT', `/api/v1/production-tasks/${ids['Márcio']}`, {
      priority: 'URGENTE',
      reason: 'Cliente antecipou a entrega (fictício)',
      version: cur.version,
    });
    for (const name of ['João', 'Ricardo'] as const) {
      const p = devices[name]!.page;
      await p.getByTestId('task-actions').getByRole('button', { name: 'Concluir' }).click();
      const c = p.getByTestId('confirm-complete');
      if (await c.getByRole('textbox').count()) await c.getByRole('textbox').fill('Concluído');
      await c.getByRole('button', { name: 'Sim, concluir' }).click();
      await expect(p.getByTestId('my-task-detail')).toContainText('Concluída');
    }
    const tp = devices.Thiago!.page;
    await tp.getByRole('button', { name: 'Voltar ao Meu dia' }).click();
    await expect(tp.getByTestId('inspections-count')).not.toHaveText('0', { timeout: 20_000 });
    await mp.context().setOffline(false);
    await expect(mp.getByTestId('offline-banner')).toHaveCount(0, { timeout: 20_000 });
    await expect(mp.getByTestId('my-task-detail')).toContainText(/Prioridade urgente/i, {
      timeout: 20_000,
    });
    expect((await call(page, 'GET', `/api/v1/production-tasks/${ids['Márcio']}`)).status).toBe(
      'EM_EXECUCAO',
    );
    await shot(mp, 'tablet-Márcio-reconectado', true);
    ok('Queda e reconexão do Márcio: prioridade recuperada sem recarregar, sem duplicidade');
    ok('Conclusões de João e Ricardo; inspeção do sofá chega ao Thiago em tempo real');

    // Thiago aprova a inspeção do sofá pela sessão do tablet.
    const list = await call(tp, 'GET', '/api/v1/quality/inspections');
    const all = (Array.isArray(list) ? list : (list.items ?? [])) as {
      id: string;
      status: string;
    }[];
    const insp = all.find(
      (i) =>
        ['PENDENTE', 'EM_ANDAMENTO'].includes(i.status) &&
        JSON.stringify(i).includes(so.items[0].id),
    );
    expect(insp, 'inspeção do sofá').toBeTruthy();
    let detail = await call(tp, 'GET', `/api/v1/quality/inspections/${insp!.id}`);
    for (const it of detail.items as { id: string }[])
      await call(tp, 'PUT', `/api/v1/quality/inspections/${insp!.id}/items/${it.id}`, {
        result: 'OK',
        note: null,
      });
    detail = await call(tp, 'GET', `/api/v1/quality/inspections/${insp!.id}`);
    await call(tp, 'POST', `/api/v1/quality/inspections/${insp!.id}/approve`, {
      version: detail.version,
    });
    await page.goto(`/painel/qualidade/inspecoes/${insp!.id}`);
    await expect(page.getByText(/Aprovada/i).first()).toBeVisible();
    await shot(page, 'painel-inspecao-aprovada');
    ok('Inspeção aprovada pelo Thiago (tablet) e visível no painel');

    // Logística terceirizada: celular do André, visão restrita.
    await open(browser, 'André', true);
    const ap = devices['André']!.page;
    await expect(ap.getByTestId('tablet-user')).toBeVisible();
    const andreOrders = await ap.request.get('/api/v1/orders', { headers: { origin: WEB } });
    expect(andreOrders.status()).toBe(403);
    expect((await ap.locator('body').textContent()) ?? '').not.toMatch(/R\$\s?\d/);
    await shot(ap, 'celular-André');
    ok('Celular do André (390 px): entrada por PIN, sem pedidos (403) e sem valores');

    // Financeiro no painel: cobrança do pedido e painel do mês.
    await call(page, 'POST', '/api/v1/finance/receivables', {
      orderId: order.id,
      description: 'Entrada (fictícia)',
      amountCents: 160000,
      dueDate: today(),
      expectedMethod: 'PIX',
    });
    await page.goto('/painel/financeiro');
    await expect(page.locator('h1').first()).toBeVisible();
    await shot(page, 'painel-financeiro');
    ok('Cobrança registrada e financeiro do painel aberto');

    for (const d of Object.values(devices)) await d.close();
  });

  test('3. Telas do painel em desktop e celular', async ({ page }) => {
    await login(page);
    const routes = [
      '/painel',
      '/painel/atencao',
      '/painel/funcionarios',
      '/painel/dispositivos',
      '/painel/clientes',
      '/painel/pedidos',
      '/painel/recebimentos',
      '/painel/os',
      '/painel/medicoes',
      '/painel/compras',
      '/painel/estoque',
      '/painel/prontidao',
      '/painel/producao/planejamento',
      '/painel/producao',
      '/painel/ajuda',
      '/painel/reprogramacao',
      '/painel/qualidade',
      '/painel/entregas',
      '/painel/devolucoes',
      '/painel/presenca',
      '/painel/financeiro',
      '/painel/empresa',
      '/painel/auditoria',
      '/painel/sincronizacao',
    ];
    const found = [];
    for (const [vp, size] of [
      ['desktop', { width: 1440, height: 900 }],
      ['celular', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size);
      for (const r of routes) found.push({ viewport: vp, ...(await visit(page, r)) });
      await shot(page, `${vp}-sincronizacao`);
    }
    writeFileSync(`${OUT}/telas.json`, JSON.stringify(found, null, 2));
    const bad = found.filter((f) => f.errors.length || !f.h1 || f.overflow > 2 || f.status >= 400);
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    ok(`Telas do painel: ${found.length} visitas (desktop e celular), sem erro, título ou rolagem`);
  });
});
