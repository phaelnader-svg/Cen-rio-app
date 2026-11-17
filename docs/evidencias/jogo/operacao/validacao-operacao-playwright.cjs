// Aceitação operacional do jogo (dev, dados sintéticos de scripts/jogo-dados-sinteticos.mjs).
// Uso: CODES='{"Ricardo":"XXXX-XXXX"}' node validacao-operacao-playwright.cjs
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const OUT = '/tmp/claude-0/shots/operacao';
const CODES = JSON.parse(process.env.CODES || '{}');
const PINS = { João: '813572', Márcio: '924681', Ricardo: '735914', Thiago: '461829' };
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);
const idem = () => ({ 'idempotency-key': crypto.randomUUID().replace(/-/g, ''), origin: BASE });
const step = async (name, fn) => {
  try {
    await fn();
    console.log('  ✔', name);
    return true;
  } catch (e) {
    console.log('  ✘', name, '—', e.message.split('\n')[0]);
    return false;
  }
};

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const gctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const g = await gctx.newPage();
  const errors = [];
  g.on('pageerror', (e) => errors.push(e.message));
  g.on('console', (m) => {
    if (
      m.type() === 'error' &&
      !/WebSocket|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())
    )
      errors.push(m.text().slice(0, 200));
  });
  await g.goto(`${BASE}/entrar`);
  await g.getByLabel('E-mail').fill('gestor@cenario.test');
  await g.getByLabel('Senha').fill('Cenario-Dev-2026!');
  await g.getByRole('button', { name: 'Entrar' }).click();
  await g.waitForURL(/painel/);
  const api = async (method, url, data) => {
    const r = await g.request.fetch(`${BASE}${url}`, { method, data, headers: idem() });
    const body = await r.json().catch(() => null);
    return { status: r.status(), body };
  };
  const snap = async () => (await api('GET', '/api/v1/game/snapshot')).body;
  const pieceOf = async (code) => (await snap()).pieces.find((p) => p.itemCode === code);
  const screenOf = (id, h = 0.8) =>
    g.evaluate(([i, hh]) => window.__cenarioGame.screenOf(i, hh), [id, h]);
  const ask = async (t) => {
    await g.getByTestId('cenaria-input').fill(t);
    await g.getByTestId('cenaria-input').press('Enter');
    await wait(g, 2000);
  };
  const results = {};

  await g.goto(`${BASE}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 5000);

  log('1. Leitura rápida: filtros');
  results.filtros = await step('filtros rápidos e lista de decisões', async () => {
    await shot(g, '01-visao-geral-filtros');
    await g.getByTestId('quick-PARADOS').click();
    await g.getByTestId('quick-panel').waitFor();
    await wait(g, 1200);
    await shot(g, '02-filtro-parados');
    await g.getByTestId('quick-SEM_MATERIAL').click();
    await g.getByTestId('quick-panel').waitFor();
    await wait(g, 800);
    await shot(g, '03-filtro-sem-material');
    await g.getByTestId('quick-SEM_MATERIAL').click();
  });

  log('2. Ficha da Ana: estados separados, próxima ação, tecido, espuma 2 × 1 livre');
  results.ficha = await step('ficha da Ana', async () => {
    await ask('Cadê o sofá da Ana?');
    await g.getByTestId('piece-panel').waitFor();
    await wait(g, 1500);
    await shot(g, '04-ficha-ana-resumo');
    const phase = await g.getByTestId('piece-phase').textContent();
    log(
      'situação:',
      phase,
      '| próxima ação:',
      await g
        .getByTestId('piece-next-action')
        .textContent()
        .catch(() => '—'),
    );
    await g.getByTestId('piece-tab-SERVICO').click();
    log('tecido:', await g.getByTestId('piece-fabric').textContent());
    await shot(g, '05-ficha-ana-servico-tecido');
    await g.getByTestId('piece-tab-MATERIAIS').click();
    await wait(g, 800);
    await shot(g, '06-ficha-ana-materiais');
  });
  results.reserva = await step('reservar a placa livre e comprar só o restante', async () => {
    const espuma = g.getByTestId('piece-materials').locator('li').filter({ hasText: 'Espuma D28' });
    log(
      'espuma antes:',
      (await espuma.getByTestId('material-numbers').textContent()).replace(/\s+/g, ' '),
    );
    await espuma.getByTestId('material-reserve').click();
    await wait(g, 2500);
    log(
      'espuma depois:',
      (await espuma.getByTestId('material-numbers').textContent()).replace(/\s+/g, ' '),
    );
    await shot(g, '07-espuma-reservada-restante');
    const [buy] = await Promise.all([
      g.waitForEvent('popup'),
      espuma.getByTestId('material-buy').click(),
    ]);
    await buy.waitForLoadState('networkidle');
    await wait(buy, 1500);
    await buy.setViewportSize({ width: 1280, height: 900 });
    await buy.screenshot({ path: `${OUT}/08-compra-oficial-quantidade.png` });
    const qty = await buy
      .locator('input')
      .filter({ hasNot: buy.locator('[type=date]') })
      .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
    log('tela oficial de compra, valores:', JSON.stringify(qty.slice(0, 6)));
    await buy.close();
  });

  log('3. Tablet do Ricardo: dependência, início pelo funcionário, queda de conexão');
  results.tablet = await step('tablet com queda e reconexão', async () => {
    if (!CODES.Ricardo) throw new Error('sem código de vinculação do Ricardo');
    const tctx = await browser.newContext({
      viewport: { width: 1180, height: 820 },
      hasTouch: true,
    });
    const t = await tctx.newPage();
    await t.goto(`${BASE}/tablet`);
    await t.getByLabel('Código de vinculação').fill(CODES.Ricardo);
    await t.getByRole('button', { name: 'Vincular tablet' }).click();
    await t.getByText('Digite seu PIN de 6 dígitos').waitFor();
    for (const d of PINS.Ricardo) await t.getByRole('button', { name: d, exact: true }).click();
    await t.getByTestId('tablet-user').waitFor();
    await wait(t, 2000);
    await t.screenshot({ path: `${OUT}/09-tablet-ricardo-fila.png` });
    const diego = await pieceOf('OS-00004/1');
    const corte = diego.tasks.find((x) => /corte/i.test(x.title));
    log(
      'Diego antes:',
      corte.status,
      '| montagem:',
      diego.tasks.find((x) => /montagem/i.test(x.title))?.status,
    );
    // 3a. Sem conexão: o tablet oficial desabilita "Iniciar"; o jogo marca o mapa como pendente.
    await gctx.setOffline(true);
    await tctx.setOffline(true);
    const hl = t.getByTestId('week-highlight');
    await wait(t, 1500);
    log(
      'Iniciar habilitado sem conexão?',
      await hl.getByRole('button', { name: 'Iniciar' }).isEnabled(),
    );
    await t.screenshot({ path: `${OUT}/10-tablet-sem-conexao.png` });
    await wait(g, 6000);
    await shot(g, '11-jogo-pendente-de-atualizacao');
    log('indicador do jogo:', await g.getByTestId('sync-status').textContent());
    await tctx.setOffline(false);
    await gctx.setOffline(false);
    await wait(t, 4000);
    // 3b. A conexão cai DURANTE o início: o servidor registra, a resposta se perde; o funcionário
    // toca de novo e o tablet reenvia com a MESMA chave → uma única atualização.
    let dropped = 0;
    await t.route('**/api/v1/production-tasks/*/start', async (route) => {
      if (dropped++ === 0) {
        await route.fetch();
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await hl.getByRole('button', { name: 'Iniciar' }).click();
    await wait(t, 2500);
    await t.screenshot({ path: `${OUT}/12-tablet-resposta-perdida.png` });
    const again = hl.getByRole('button', { name: 'Iniciar' });
    if (await again.isVisible().catch(() => false)) await again.click();
    await wait(t, 4000);
    await t.screenshot({ path: `${OUT}/12b-tablet-iniciado.png` });
    await wait(g, 6000);
    const after = await pieceOf('OS-00004/1');
    const c2 = after.tasks.find((x) => x.id === corte.id);
    const detail = (await api('GET', `/api/v1/production-tasks/${corte.id}`)).body;
    const starts = detail.events.filter((e) => e.kind === 'INICIADA').length;
    log('Diego depois:', c2.status, '| eventos de início:', starts);
    if (starts !== 1) throw new Error(`esperado 1 início, veio ${starts}`);
    await ask('Cadê o sofá do Diego?');
    await wait(g, 1500);
    await shot(g, '13-diego-em-execucao-ricardo');
    await tctx.close();
  });

  log('4. Proposta antiga do Gerente');
  results.gerente = await step('aprovar proposta antiga é recusado', async () => {
    await g.getByTestId('space-ESCRITORIO').click();
    await wait(g, 2500);
    const agents = (await api('GET', '/api/v1/game/agents')).body;
    const ger = agents.find((x) => x.roleKey === 'GERENTE');
    const s = await screenOf(ger.id, 1.0);
    await g.mouse.click(s.x, s.y);
    await g.getByTestId('agent-panel').waitFor();
    await g.getByRole('button', { name: 'Monte o plano semanal' }).click();
    await wait(g, 4000);
    const prop = g
      .getByTestId('agent-proposals')
      .locator('li')
      .filter({ hasText: /Planejar OS-\d+/ })
      .first();
    await prop.waitFor();
    await shot(g, '14-gerente-propostas-e-caixa');
    const code = (await prop.textContent()).match(/OS-(\d+)/)[0];
    // Essa OS é planejada por fora (fluxo oficial) enquanto a proposta continua na tela.
    const s2 = await snap();
    const target = s2.pieces.filter((p) => p.osCode === code);
    const ricardoId = s2.employees.find((e) => e.name === 'Ricardo').userId;
    const pl = await api('POST', '/api/v1/production/plan-services', {
      entries: [
        {
          serviceOrderId: target[0].serviceOrderId,
          startDate: new Date().toISOString().slice(0, 10),
          pieces: target.map((p) => ({ serviceOrderItemId: p.id, upholstererUserId: ricardoId })),
        },
      ],
    });
    log(`${code} planejada por fora:`, pl.status, JSON.stringify(pl.body).slice(0, 120));
    await prop.getByTestId('proposal-approve').click();
    await wait(g, 2500);
    await shot(g, '15-proposta-desatualizada');
    log(
      'obsoletas:',
      await g
        .getByTestId('agent-obsolete')
        .textContent()
        .catch(() => '—'),
    );
  });

  log('5. Construção: bancada com funcionário e estante com material');
  results.construcao = await step(
    'remover → desfazer → impacto → cancelar → mover → salvar → recarregar',
    async () => {
      await g.getByTestId('space-TAPECARIA').click();
      await wait(g, 2500);
      await g.getByTestId('mode-construcao').click();
      await wait(g, 1500);
      const shop = (await api('GET', '/api/v1/game/spaces/TAPECARIA')).body;
      const bench = shop.stations.find((s) => s.name === 'Bancada do Ricardo');
      const rack = shop.storageUnits.find((u) => /espuma/i.test(u.label));
      let a = await screenOf(bench.id, 0.85);
      await g.mouse.click(a.x, a.y);
      await wait(g, 600);
      await g.getByTestId('remove-selected').click();
      await wait(g, 600);
      await shot(g, '16-bancada-removida-rascunho');
      await g.keyboard.press('Control+z');
      await wait(g, 800);
      await shot(g, '17-desfazer-bancada-volta');
      a = await screenOf(bench.id, 0.85);
      await g.mouse.click(a.x, a.y);
      await g.getByTestId('remove-selected').click();
      const r = await screenOf(rack.id, 0.8);
      await g.mouse.click(r.x, r.y);
      await wait(g, 400);
      await g.getByTestId('remove-selected').click();
      await g.getByTestId('save-layout').click();
      await g.getByTestId('impact-dialog').waitFor();
      await wait(g, 600);
      await shot(g, '18-impacto-funcionario-e-material');
      log(
        'impacto:',
        (await g.getByTestId('impact-dialog').textContent()).replace(/\s+/g, ' ').slice(0, 300),
      );
      await g
        .getByTestId('impact-dialog')
        .getByRole('button', { name: /Cancelar|Voltar/ })
        .first()
        .click();
      await g.keyboard.press('Control+z');
      await g.keyboard.press('Control+z');
      await wait(g, 800);
      // Move a bancada (arrastar) e salva.
      a = await screenOf(bench.id, 0.85);
      await g.mouse.click(a.x, a.y);
      await g.mouse.move(a.x, a.y);
      await g.mouse.down();
      for (let i = 1; i <= 8; i++) await g.mouse.move(a.x + i * 6, a.y + i * 3);
      await g.mouse.up();
      await wait(g, 800);
      await g.getByTestId('save-layout').click();
      await wait(g, 2500);
      const after = (await api('GET', '/api/v1/game/spaces/TAPECARIA')).body;
      const b2 = after.stations.find((s) => s.id === bench.id);
      const rack2 = after.storageUnits.find((u) => u.id === rack.id);
      log(
        'bancada',
        bench.xCm,
        bench.yCm,
        '→',
        b2.xCm,
        b2.yCm,
        '| vínculo mantido:',
        JSON.stringify(b2.assigneeUserIds) === JSON.stringify(bench.assigneeUserIds),
        '| estante mantida:',
        Boolean(rack2),
      );
      await g.reload();
      await g.getByTestId('game-canvas').waitFor();
      await wait(g, 5000);
      await shot(g, '19-bancada-movida-recarregada');
    },
  );

  log('6. Os três comandos do chat');
  results.chat = await step('cadê / onde fica / move com recarga', async () => {
    await ask('Cadê o sofá da Ana?');
    await g.getByTestId('piece-panel').waitFor();
    await shot(g, '20-chat-cade-sofa-ana');
    await ask('Onde fica a espuma D28?');
    await wait(g, 1500);
    await shot(g, '21-chat-onde-espuma');
    const shop = (await api('GET', '/api/v1/game/spaces/TAPECARIA')).body;
    const mesa = shop.stations.find((s) => /mesa de corte/i.test(s.name));
    await ask('Move a mesa de corte para perto da costura');
    await g.getByTestId('move-card').waitFor();
    await wait(g, 1500);
    await shot(g, '22-chat-previa-mover-mesa');
    await g.getByTestId('move-apply').click();
    await wait(g, 3000);
    await g.reload();
    await g.getByTestId('game-canvas').waitFor();
    await wait(g, 5000);
    const after = (await api('GET', '/api/v1/game/spaces/TAPECARIA')).body.stations.find(
      (s) => s.id === mesa.id,
    );
    log('mesa de corte', mesa.xCm, mesa.yCm, '→', after.xCm, after.yCm);
    if (after.xCm === mesa.xCm && after.yCm === mesa.yCm)
      throw new Error('mesa não mudou de lugar');
    await shot(g, '23-mesa-movida-apos-recarregar');
  });

  console.log('resultado:', JSON.stringify(results));
  console.log('erros no console:', errors.length ? errors : 'nenhum');
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
