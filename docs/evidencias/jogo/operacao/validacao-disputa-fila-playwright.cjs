// Complemento da aceitação: disputa pela última placa feita pela TELA (duas abas) e fila com
// vários móveis, incluindo duas peças da mesma OS (Bruno). Dados sintéticos recém-criados.
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const OUT = '/tmp/claude-0/shots/operacao';
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);
const idem = () => ({ 'idempotency-key': crypto.randomUUID().replace(/-/g, ''), origin: BASE });

async function login(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/entrar`);
  await p.getByLabel('E-mail').fill('gestor@cenario.test');
  await p.getByLabel('Senha').fill('Cenario-Dev-2026!');
  await p.getByRole('button', { name: 'Entrar' }).click();
  await p.waitForURL(/painel/);
  return p;
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const a = await login(browser);
  const errors = [];
  a.on('pageerror', (e) => errors.push(e.message));
  const api = async (method, url, data) => {
    const r = await a.request.fetch(`${BASE}${url}`, { method, data, headers: idem() });
    if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${await r.text()}`);
    return r.json();
  };

  // Carla também passa a precisar de 1 placa de espuma D28 (medição oficial aprovada).
  const me = await api('GET', '/api/auth/me');
  const carla = (
    await api('GET', `/api/v1/service-orders?q=${encodeURIComponent('Carla Fictícia')}`)
  ).items[0];
  const stock = (await api('GET', '/api/v1/stock-items')).find((s) =>
    /Espuma D28/.test(s.description),
  );
  const m = await api('POST', '/api/v1/measurements', {
    serviceOrderId: carla.id,
    kind: 'ROTINA',
    assigneeUserId: me.user.id,
    dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
  });
  const draft = await api('PUT', `/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items: [
      {
        kind: 'ESPUMA',
        sourcing: 'ESTOQUE',
        description: 'Espuma D28',
        foamDensity: 'D28',
        thicknessCm: 10,
        lengthCm: 190,
        widthCm: 130,
        quantity: 1,
        unit: 'PLACA',
      },
    ],
    version: m.version,
  });
  const sub = await api('POST', `/api/v1/measurements/${m.id}/submit`, { version: draft.version });
  await api('POST', `/api/v1/measurements/${m.id}/request/approve`, {
    version: sub.request.version,
  });
  log(
    'Carla precisa de 1 placa; estoque da espuma:',
    stock ? `${stock.onHand} físico, ${stock.reserved} reservado` : '(lista não paginada)',
  );

  // Duas abas: ficha da Ana e ficha da Carla, cada uma com "Reservar 1 do estoque".
  const b = await login(browser);
  const open = async (p, name, code) => {
    await p.goto(`${BASE}/jogo`);
    await p.getByTestId('game-canvas').waitFor();
    await wait(p, 4000);
    await p.getByTestId('game-search').fill(name);
    await p.getByTestId('search-results').getByText(code).first().click();
    await p.getByTestId('piece-panel').waitFor();
    await p.getByTestId('piece-tab-MATERIAIS').click();
    await wait(p, 2500);
    return p.getByTestId('piece-materials').locator('li').filter({ hasText: 'Espuma D28' });
  };
  const ea = await open(a, 'Ana', 'OS-00001/1');
  const eb = await open(b, 'Carla', 'OS-00003/1');
  await ea.getByTestId('material-reserve').waitFor();
  await eb.getByTestId('material-reserve').waitFor();
  await shot(a, '26-disputa-ana-antes');
  await shot(b, '27-disputa-carla-antes');
  await Promise.all([
    ea.getByTestId('material-reserve').click(),
    eb.getByTestId('material-reserve').click(),
  ]);
  await wait(a, 2500);
  await shot(a, '28-disputa-ana-depois');
  await shot(b, '29-disputa-carla-depois');
  const state = async (p, e) => ({
    erro:
      (await p
        .getByTestId('piece-error')
        .textContent()
        .catch(() => null)) ?? '—',
    numeros: (await e.getByTestId('material-numbers').textContent()).replace(/\s+/g, ' '),
    comprar:
      (await e
        .getByTestId('material-buy')
        .textContent()
        .catch(() => null)) ?? '—',
    reservar: await e
      .getByTestId('material-reserve')
      .isVisible()
      .catch(() => false),
  });
  log('Ana:', JSON.stringify(await state(a, ea)));
  log('Carla:', JSON.stringify(await state(b, eb)));
  const reservations = (
    await api('GET', `/api/v1/service-orders/${carla.id}/material-readiness`)
  ).lines.find((l) => /Espuma/.test(l.description));
  log('Carla espuma: reservada', reservations.reserved, '| falta comprar', reservations.shortfall);

  // Fila com vários móveis e duas peças da mesma OS: planejar o Bruno (poltronas + cabeceira).
  await a.getByTestId('game-search').fill('Bruno');
  await a.getByTestId('search-results').getByText('OS-00002/1').first().click();
  await a.getByTestId('piece-panel').waitFor();
  await a.getByTestId('piece-tab-ATRIBUICAO').click();
  await a.getByTestId('plan-service').click();
  await wait(a, 2000);
  await a.getByTestId('publish-week').click();
  await wait(a, 3500);
  await a.evaluate(() => window.__cenarioGame.overview());
  await wait(a, 2500);
  await shot(a, '30-fila-varias-pecas-mesma-os');
  const snap = await api('GET', '/api/v1/game/snapshot');
  const bruno = snap.pieces.filter((p) => p.osCode === 'OS-00002');
  for (const p of bruno) {
    const s = await a.evaluate((id) => window.__cenarioGame.screenOf(id, 0.6), p.id);
    await a.mouse.click(s.x, s.y);
    await wait(a, 1200);
    const title = await a.getByTestId('piece-panel').locator('h2').textContent();
    log(`clique em ${p.itemCode}: abriu "${title}" | ${p.placement.label}`);
  }
  await shot(a, '31-segunda-peca-selecionada');
  const queue = snap.employees.find((e) => e.queue.some((q) => q.osCode === 'OS-00002'));
  await a.getByTestId('game-search').fill(queue.name);
  await a.getByTestId('search-results').getByText(queue.name).first().click();
  await a.getByTestId('employee-panel').waitFor();
  await wait(a, 1500);
  log(
    'fila de',
    queue.name,
    ':',
    (await a.getByTestId('employee-panel').locator('h3').allTextContents()).join(' | '),
  );
  await shot(a, '32-fila-do-funcionario-pecas');
  console.log('erros no console:', errors.length ? errors : 'nenhum');
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
