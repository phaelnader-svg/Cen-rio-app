/* eslint-disable no-console -- roteiro de validação: imprime o resultado no terminal. */
// Quadro de Metas na prévia (dados de scripts/jogo-quadro-metas-demo.mjs). Capturas em /tmp/claude-0/shots/quadro-metas.
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const OUT = '/tmp/claude-0/shots/quadro-metas';
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);
const step = async (name, fn) => {
  try {
    await fn();
    console.log('  ✔', name);
  } catch (e) {
    console.log('  ✘', name, '—', e.message.split('\n')[0]);
  }
};

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const g = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  g.on('pageerror', (e) => errors.push(e.message));
  g.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 200));
  });
  await g.goto(`${BASE}/entrar`);
  await g.getByLabel('E-mail').fill('gestor@cenario.test');
  await g.getByLabel('Senha').fill('Cenario-Dev-2026!');
  await g.getByRole('button', { name: 'Entrar' }).click();
  await g.waitForURL(/painel/);
  const api = async (url) => (await g.request.get(`${BASE}${url}`)).json();
  const ask = async (t) => {
    await g.getByTestId('cenaria-input').fill(t);
    await g.getByTestId('cenaria-input').press('Enter');
    await wait(g, 2500);
  };
  await g.goto(`${BASE}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 5000);

  await step('versão compacta na Tapeçaria', async () => {
    await g.getByTestId('goals-compact').waitFor();
    log('compacto:', await g.getByTestId('goals-compact').textContent());
    await shot(g, '01-tapecaria-compacto');
  });

  await step('escritório: quadro 3D, comemorações (entrega e meta)', async () => {
    await g.getByTestId('space-ESCRITORIO').click();
    await wait(g, 1200);
    await shot(g, '02-escritorio-comemoracao');
    await wait(g, 3500);
    const office = await api('/api/v1/game/spaces/ESCRITORIO');
    const board = office.stations.find((s) => s.kind === 'QUADRO_METAS');
    const s = await g.evaluate((id) => window.__cenarioGame.screenOf(id, 1.2), board.id);
    await g.evaluate(
      ([x, y]) => window.__cenarioGame.focus(x, y, 7),
      [board.xCm + board.wCm / 2, board.yCm],
    );
    await wait(g, 2000);
    await shot(g, '03-quadro-no-escritorio');
    const s2 = await g.evaluate((id) => window.__cenarioGame.screenOf(id, 1.2), board.id);
    await g.mouse.click(s2.x, s2.y);
    await g.getByTestId('goals-panel').waitFor();
    void s;
    await wait(g, 1000);
    await shot(g, '04-painel-resumo');
    log(
      'saldo:',
      await g.getByTestId('goals-balance').textContent(),
      '| próxima:',
      await g.getByTestId('goals-next').textContent(),
      '|',
      await g.getByTestId('goals-pct').textContent(),
      '| falta',
      await g.getByTestId('goals-missing').textContent(),
    );
    log('entregas:', await g.getByTestId('goals-delivery').first().textContent());
  });

  await step('do saldo até os lançamentos', async () => {
    await g.getByTestId('goals-balance').click();
    await g.getByTestId('cash-moves').waitFor();
    await wait(g, 800);
    log(
      'lançamentos:',
      await g.getByTestId('cash-move').count(),
      '| soma',
      await g.getByTestId('cash-moves-total').textContent(),
    );
    await shot(g, '05-lancamentos-do-saldo');
    await g.getByRole('button', { name: '← Quadro' }).click();
  });

  await step('semanas: positiva, negativa, gráfico, animação e lançamentos', async () => {
    await g.getByTestId('goals-tab-RESUMO').click();
    await wait(g, 600);
    await shot(g, '06-semanas');
    const closed = g.getByTestId('week-closed');
    for (let i = 0; i < (await closed.count()); i++)
      log(
        'semana:',
        await closed.nth(i).locator('b').first().textContent(),
        '→',
        await closed.nth(i).getByTestId('week-delta').textContent(),
        '| fechamento',
        await closed.nth(i).getByTestId('week-closing').textContent(),
      );
    await closed.last().getByTestId('week-all').click();
    await g.getByTestId('cash-moves').waitFor();
    await wait(g, 600);
    await shot(g, '07-lancamentos-semana-positiva');
    log(
      'semana −2:',
      (await g.getByTestId('cash-move').allTextContents())
        .map((x) => x.replace(/\s+/g, ' ').slice(0, 90))
        .join(' | '),
    );
    await g.getByRole('button', { name: '← Quadro' }).click();
    await g.getByTestId('week-closed').first().getByTestId('week-animate').click();
    await wait(g, 1500);
    await shot(g, '08-animacao-fechamento');
  });

  await step('metas: conquistada e abaixo do patamar; editar', async () => {
    await g.getByTestId('goals-tab-METAS').click();
    await wait(g, 600);
    await shot(g, '09-metas');
    log(
      'metas:',
      (await g.getByTestId('goal-row').allTextContents())
        .map((x) => x.replace(/\s+/g, ' ').slice(0, 110))
        .join(' | '),
    );
  });

  await step('a receber / pagar e projeção', async () => {
    await g.getByTestId('goals-tab-RECEBER').click();
    await wait(g, 600);
    await shot(g, '10-receber-pagar-projecao');
  });

  await step('contas: saldo informado, origem e última atualização', async () => {
    await g.getByTestId('goals-tab-CONTAS').click();
    await wait(g, 600);
    await shot(g, '11-contas');
    log(
      'contas:',
      (await g.getByTestId('cash-account').allTextContents())
        .map((x) => x.replace(/\s+/g, ' ').slice(0, 160))
        .join(' | '),
    );
  });

  await step(
    'reenviar a mesma confirmação de pagamento pela tela: saldo muda uma vez',
    async () => {
      const before = (await api('/api/v1/office/cash')).balanceCents;
      await g.getByTestId('game-search').fill('Bruno');
      await g.getByTestId('search-results').getByText('OS-00002/1').first().click();
      await g.getByTestId('open-ficha').click();
      await g.getByTestId('ficha-tab-COBRANCA').click();
      await g.getByTestId('charge-resend').first().click();
      await wait(g, 2500);
      await shot(g, '12-reenvio-confirmacao');
      const after = (await api('/api/v1/office/cash')).balanceCents;
      log('saldo antes/depois do reenvio:', before / 100, after / 100);
      if (before !== after) throw new Error('o saldo mudou no reenvio');
    },
  );

  await step('chat: as quatro perguntas', async () => {
    await g.getByTestId('space-ESCRITORIO').click();
    await wait(g, 1500);
    for (const [i, q] of [
      'Quanto falta pra bater os 100 mil?',
      'Quanto eu cresci essa semana?',
      'Por que o caixa caiu desde segunda?',
      'Com o que tenho pra receber e pagar, bato a meta até o prazo?',
    ].entries()) {
      await ask(q);
      await shot(g, `${13 + i}-chat-${i + 1}`);
      const last =
        (await g.getByTestId('cenaria-log').locator('div').allTextContents())
          .filter((x) => x.length > 30)
          .at(-1) ?? '';
      log(`P${i + 1}:`, last.replace(/\s+/g, ' ').slice(0, 220));
    }
  });

  await step('construção: quadro no catálogo do escritório', async () => {
    await g.getByTestId('mode-construcao').click();
    await wait(g, 1500);
    await g.getByText('Quadro de Metas').first().waitFor();
    await shot(g, '17-construcao-catalogo-quadro');
  });

  console.log('erros no console:', errors.length ? errors : 'nenhum');
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
