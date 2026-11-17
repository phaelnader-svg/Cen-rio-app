/* eslint-disable */
// Demonstração do Firma Viva (6 passos) contra o ambiente local:
// Firma Viva web :3100 (API :4100) e Cenário Gestão web :3000 (API :4000).
// Uso: FIRMA_SENHA=... CENARIO_EMAIL=... CENARIO_SENHA=... CODES='{"Márcio":"XXXX-XXXX"}' node demo-playwright.cjs
const { chromium } = require('playwright');
const FIRMA = 'http://localhost:3100';
const CENARIO = 'http://localhost:3000';
const OUT = __dirname;
const PINS = { João: '813572', Márcio: '924681', Ricardo: '735914', Thiago: '461829' };
const CODES = JSON.parse(process.env.CODES || '{}');
const ONLY = process.env.ONLY ? Number(process.env.ONLY) : 99;
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('·', ...a);
const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const g = await ctx.newPage();
  const errors = [];
  g.on('pageerror', (e) => errors.push(e.message));
  const api = (method, url, body) =>
    g.evaluate(
      async ([m, u, b]) => {
        const r = await fetch(u, {
          method: m,
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: b ? JSON.stringify(b) : undefined,
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [method, url, body],
    );

  log('1. Entrar no Firma Viva');
  await g.goto(`${FIRMA}/jogo`);
  await g.getByTestId('login-email').waitFor();
  log('URL sem sessão:', g.url());
  await shot(g, '01-entrar-firma-viva');
  await g.getByTestId('login-email').fill('dono@firmaviva.test');
  await g.getByTestId('login-password').fill(process.env.FIRMA_SENHA);
  await g.getByTestId('login-submit').click();
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 4000);
  log('organização no topo:', await g.getByTestId('org-name').textContent());
  log('chip:', await g.getByTestId('connect-cenario-chip').textContent());
  await shot(g, '02-jogo-antes-de-conectar');
  const before = await api('GET', '/api/v1/service-orders');
  log('OS antes de conectar →', before.status, before.body?.error?.code);
  if (ONLY < 2) return browser.close();

  log('2. Central de Conexões → Conectar Cenário Gestão → tela oficial → volta');
  await g.getByTestId('connect-cenario-chip').click();
  await g.getByTestId('central-panel').waitFor();
  await g.getByTestId('conn-CENARIO').locator('button').first().click();
  await g.getByTestId('cenario-card').waitFor();
  await wait(g, 1500);
  await shot(g, '03-central-conectar');
  await g.getByTestId('cenario-connect').click();
  await g.waitForURL(/localhost:3000\/entrar/);
  log('tela de login do Cenário:', g.url().split('?')[0]);
  await shot(g, '04-login-oficial-cenario');
  await g.getByLabel('E-mail').fill(process.env.CENARIO_EMAIL);
  await g.getByLabel('Senha').fill(process.env.CENARIO_SENHA);
  await g.getByRole('button', { name: /Entrar/ }).click();
  await g.waitForURL(/localhost:3000\/autorizar/);
  await g.getByTestId('authorize-company').waitFor();
  log('empresa na autorização:', await g.getByTestId('authorize-company').textContent());
  log('organização:', await g.getByTestId('authorize-org').textContent());
  await shot(g, '05-autorizacao-oficial-cenario');
  await g.getByTestId('authorize-allow').click();
  await g.waitForURL(/localhost:3100\/jogo/);
  await g.getByTestId('central-panel').waitFor();
  await wait(g, 2500);
  await shot(g, '06-de-volta-conectado');
  await g.getByTestId('conn-CENARIO').locator('button').first().click();
  await wait(g, 1500);
  log(
    'cartão Cenário:',
    (await g.getByTestId('cenario-card').textContent()).replace(/\s+/g, ' ').slice(0, 260),
  );
  await shot(g, '07-central-cartao-conectado');
  if (ONLY < 3) return browser.close();

  log('3. Empresa conectada e OS de teste no mapa');
  await g.goto(`${FIRMA}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 6000);
  const snap = (await api('GET', '/api/v1/game/snapshot')).body;
  log(
    'peças no mapa:',
    snap.pieces.length,
    '| funcionários:',
    snap.employees.map((e) => e.name).join(', '),
  );
  await g.evaluate(() => window.__cenarioGame?.overview());
  await wait(g, 2500);
  await shot(g, '08-mapa-com-a-empresa');
  if (ONLY < 4) return browser.close();

  log('4. Atribuir etapa pelo jogo → tablet oficial → funcionário confirma o início');
  log(
    'peças sem plano:',
    snap.pieces
      .filter((p) => !p.planned)
      .map((p) => `${p.itemCode} (${p.tone})`)
      .join(', '),
  );
  const unplanned = snap.pieces.filter((p) => !p.planned);
  const target = unplanned.find((p) => p.tone === 'DISPONIVEL') ?? unplanned[0] ?? snap.pieces[0];
  log('peça escolhida:', target.osCode, target.itemCode, '| tarefas:', (target.tasks || []).length);
  await g.getByTestId('game-search').fill(target.osCode);
  await g
    .getByTestId('search-results')
    .getByText(target.itemCode ?? target.osCode)
    .first()
    .click();
  await g.getByTestId('piece-panel').waitFor();
  await g.getByTestId('piece-tab-ATRIBUICAO').click();
  await wait(g, 1000);
  // Tapeceiro livre agora (a regra oficial permite uma etapa principal em execução por pessoa).
  const free = snap.employees.filter((e) => !e.currentTask).map((e) => e.name);
  const chosen = ['Márcio', 'Ricardo'].find((n) => free.includes(n)) ?? 'Márcio';
  log('livres:', free.join(', '), '| tapeceiro escolhido no jogo:', chosen);
  for (const sel of await g.getByTestId('plan-form').locator('select').all())
    if ((await sel.locator('option').allTextContents()).includes(chosen))
      await sel.selectOption({ label: chosen });
  await shot(g, '09-ficha-atribuicao');
  await g.getByTestId('plan-service').click();
  await wait(g, 2500);
  await g.getByTestId('publish-week').click();
  await wait(g, 4000);
  const after = (await api('GET', '/api/v1/game/snapshot')).body.pieces.find(
    (p) => p.id === target.id,
  );
  const task =
    after.tasks.find((t) => t.status === 'LIBERADA' && t.assigneeName === chosen) ??
    after.tasks.find((t) => t.status === 'LIBERADA');
  log('etapa liberada:', task?.title, '→', task?.assigneeName);
  await shot(g, '10-etapa-atribuida-no-jogo');
  const who = task.assigneeName;
  const tctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const t = await tctx.newPage();
  await t.goto(`${CENARIO}/tablet`);
  await t.getByLabel('Código de vinculação').fill(CODES[who]);
  await t.getByRole('button', { name: 'Vincular tablet' }).click();
  await t.getByText('Digite seu PIN de 6 dígitos').waitFor();
  for (const d of PINS[who]) await t.getByRole('button', { name: d, exact: true }).click();
  await t.getByTestId('tablet-user').waitFor();
  await wait(t, 2500);
  await t.screenshot({ path: `${OUT}/11-tablet-oficial-fila.png` });
  const hl = t.getByTestId('week-highlight');
  await hl.getByRole('button', { name: 'Iniciar' }).click();
  await wait(t, 3000);
  await t.screenshot({ path: `${OUT}/12-tablet-funcionario-iniciou.png` });
  await wait(g, 7000);
  const started = (await api('GET', '/api/v1/game/snapshot')).body.pieces.find(
    (p) => p.id === target.id,
  );
  log('no jogo depois do tablet:', started.tasks.find((x) => x.id === task.id).status);
  await g
    .getByTestId('piece-tab-ATRIBUICAO')
    .click()
    .catch(() => {});
  await wait(g, 1000);
  await shot(g, '13-jogo-mostra-em-execucao');
  await tctx.close();
  if (ONLY < 5) return browser.close();

  log('5. Desconectar → ações integradas indisponíveis, planta acessível');
  await g.goto(`${FIRMA}/jogo?central=CENARIO`);
  await g.getByTestId('central-panel').waitFor();
  await g.getByTestId('conn-CENARIO').locator('button').first().click();
  g.once('dialog', (d) => d.accept());
  await g.getByTestId('cenario-disconnect').click();
  await wait(g, 3000);
  await shot(g, '14-desconectado-central');
  const os = await api('GET', `/api/v1/service-orders/${target.serviceOrderId}`);
  log(
    'OS depois de desconectar →',
    os.status,
    os.body?.error?.code,
    '|',
    os.body?.error?.message?.slice(0, 90),
  );
  const spaces = await api('GET', '/api/v1/game/spaces');
  log(
    'planta depois de desconectar →',
    spaces.status,
    spaces.body.map((s) => `${s.name} v${s.version}`).join(', '),
  );
  await g.goto(`${FIRMA}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 4000);
  await shot(g, '15-planta-continua-sem-conexao');
  if (ONLY < 6) return browser.close();

  log('6. Outra organização: isolamento');
  const b = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await b.goto(`${FIRMA}/entrar`);
  await b.getByTestId('login-email').fill('outra@firmaviva.test');
  await b.getByTestId('login-password').fill(process.env.FIRMA_SENHA);
  await b.getByTestId('login-submit').click();
  await b.getByTestId('game-canvas').waitFor();
  await wait(b, 4000);
  log('organização B:', await b.getByTestId('org-name').textContent());
  const fb = (m, u, body) =>
    b.evaluate(
      async ([m, u, body]) => {
        const r = await fetch(u, {
          method: m,
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [m, u, body],
    );
  const byId = await fb('GET', `/api/v1/service-orders/${target.serviceOrderId}`);
  log('B abre a OS da empresa A pelo ID →', byId.status, byId.body?.error?.code);
  const meA = await api('GET', '/api/auth/me');
  const sw = await fb('POST', '/api/auth/organizacao', { orgId: meA.body.organization.id });
  log('B tenta abrir a organização A →', sw.status, sw.body?.error?.message);
  const plantB = await fb('GET', '/api/v1/game/spaces');
  const plantA = await api('GET', '/api/v1/game/spaces');
  log('planta B ≠ planta A:', plantB.body[0].id !== plantA.body[0].id);
  await shot(b, '16-organizacao-b-isolada');
  console.log('erros no console:', errors.length ? errors : 'nenhum');
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
