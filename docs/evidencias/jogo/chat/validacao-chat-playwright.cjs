/* eslint-disable no-console -- roteiro de validação: imprime o resultado no terminal. */
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const idem = () => ({ 'idempotency-key': crypto.randomUUID().replace(/-/g, ''), origin: BASE });
const log = (...a) => console.log('•', ...a);
(async () => {
  const b = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const g = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  g.on('pageerror', (e) => errs.push(e.message));
  g.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|Failed to load resource/.test(m.text()))
      errs.push(m.text().slice(0, 160));
  });
  await g.goto(BASE + '/entrar');
  await g.getByLabel('E-mail').fill('gestor@cenario.test');
  await g.getByLabel('Senha').fill('Cenario-Dev-2026!');
  await g.getByRole('button', { name: 'Entrar' }).click();
  await g.waitForURL(/painel/);
  // Segunda cliente "Ana" para testar mais de um resultado (dados fictícios, pela API oficial).
  const addr = {
    label: 'Casa',
    street: 'Rua Fictícia',
    number: '1',
    district: 'Centro',
    city: 'Teste',
    state: 'SP',
    postalCode: '01000-000',
  };
  const c = await (
    await g.request.post(BASE + '/api/v1/customers', {
      headers: idem(),
      data: {
        kind: 'PF',
        name: 'Ana Paula Fictícia (jogo)',
        phone: null,
        addresses: [addr],
        allowSimilar: true,
      },
    })
  ).json();
  const o = await (
    await g.request.post(BASE + '/api/v1/orders', {
      headers: idem(),
      data: {
        customerId: c.id,
        pickupAddressId: c.addresses[0].id,
        contractedService: 'Troca de tecido',
        agreedValueCents: 90000,
        paymentTerms: 'À vista',
        items: [{ pieceType: 'POLTRONA', description: 'Poltrona bergère', quantity: 1 }],
      },
    })
  ).json();
  await g.request.post(BASE + '/api/v1/receipts', {
    headers: idem(),
    data: {
      orderId: o.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      lines: [
        { orderItemId: o.items[0].id, quantity: 1, condition: 'BOA', location: 'Recebimento' },
      ],
    },
  });
  await g.request.post(BASE + '/api/v1/service-orders', {
    headers: idem(),
    data: {
      orderId: o.id,
      items: [
        {
          orderItemId: o.items[0].id,
          quantity: 1,
          description: 'Poltrona bergère',
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    },
  });
  await g.goto(BASE + '/jogo');
  await g.getByTestId('game-canvas').waitFor();
  await g.waitForTimeout(6000);
  const say = async (t) => {
    await g.getByTestId('cenaria-input').fill(t);
    await g.getByTestId('cenaria-input').press('Enter');
    await g.waitForTimeout(2500);
  };
  const cam = () => g.evaluate(() => window.__cenarioGame.viewCenterCm());
  const shot = (n) => g.screenshot({ path: `/tmp/claude-0/shots/chat-${n}.png` });

  // 1. OS: nome com mais de um resultado → opções → escolher a Ana do sofá.
  const c0 = await cam();
  await say('Cadê o sofá da Ana?');
  const opts = g.getByTestId('cenaria-options').last();
  log(
    'opções:',
    (await opts.locator('button').allTextContents()).map((s) => s.slice(0, 45)),
  );
  await shot('01-opcoes-ana');
  await opts.locator('button').filter({ hasText: 'Ana Fictícia' }).first().click();
  await g.getByTestId('piece-panel').waitFor();
  await g.waitForTimeout(1500);
  const c1 = await cam();
  log(
    'câmera moveu:',
    Math.round(c0.x),
    Math.round(c0.y),
    '→',
    Math.round(c1.x),
    Math.round(c1.y),
    '| ficha:',
    await g.getByTestId('piece-panel').locator('h2').textContent(),
  );
  await shot('02-ficha-ana');
  await say('Abre a OS 3');
  log('OS 3 →', await g.getByTestId('piece-panel').locator('h2').textContent());
  // 2. Material
  await say('Onde fica a espuma D28?');
  await g.getByTestId('storage-panel').waitFor();
  log(
    'material →',
    await g.getByTestId('storage-panel').locator('h2').textContent(),
    '|',
    (await g.getByTestId('storage-panel').locator('header').textContent()).slice(0, 80),
  );
  await shot('03-material-espuma');
  await say('Onde fica o linho?');
  log(
    'linho →',
    (await g.getByTestId('cenaria-log').locator('div').last().textContent()).slice(0, 140),
  );
  // 3. Mover para perto da costura → prévia → aplicar → recarregar
  const before = await (await g.request.get(BASE + '/api/v1/game/spaces/TAPECARIA')).json();
  const mesa0 = before.stations.find((s) => s.kind === 'MESA_CORTE');
  await say('Joga a mesa de corte pra perto da costura');
  await g.getByTestId('move-card').waitFor();
  await g.waitForTimeout(1500);
  log('prévia:', (await g.getByTestId('move-card').textContent()).slice(0, 160));
  await shot('04-previa-mesa-corte');
  await g.getByTestId('move-apply').click();
  await g.waitForTimeout(3000);
  await shot('05-aplicado');
  await g.reload();
  await g.getByTestId('game-canvas').waitFor();
  await g.waitForTimeout(5000);
  const after = await (await g.request.get(BASE + '/api/v1/game/spaces/TAPECARIA')).json();
  const mesa1 = after.stations.find((s) => s.id === mesa0.id);
  log(
    'após recarregar: mesa de corte',
    mesa0.xCm,
    mesa0.yCm,
    '→',
    mesa1.xCm,
    mesa1.yCm,
    'versão',
    before.version,
    '→',
    after.version,
  );
  await shot('06-recarregado');
  // 4. Lugar ocupado
  await say('Joga a mesa de corte em cima da bancada do Márcio');
  await g.getByTestId('move-card').waitFor();
  await g.waitForTimeout(1500);
  log('ocupado:', (await g.getByTestId('cenaria-log').textContent()).match(/já ocupa[^.]*\./)?.[0]);
  await shot('07-ocupado');
  await g.getByTestId('move-cancel').click();
  await g.waitForTimeout(800);
  const after2 = await (await g.request.get(BASE + '/api/v1/game/spaces/TAPECARIA')).json();
  log(
    'cancelado sem salvar: versão',
    after2.version,
    'mesa',
    after2.stations.find((s) => s.id === mesa0.id).xCm,
  );
  // 5. Planta pelo chat (escritório)
  await say('Aumenta o escritório dois metros');
  await g.getByTestId('mestre-panel').waitFor();
  await g.waitForTimeout(1500);
  log('mestre (aumentar):', (await g.getByTestId('mestre-chat').textContent()).slice(-160));
  await shot('08-aumenta-escritorio');
  await say('Coloca mais duas mesas perto da janela');
  await g.waitForTimeout(1500);
  log('mestre (janela):', (await g.getByTestId('mestre-chat').textContent()).slice(-200));
  await shot('09-mesas-janela');
  await say('Cria uma mesa para o agente de compras');
  await g.waitForTimeout(1500);
  log('mestre (agente):', (await g.getByTestId('mestre-chat').textContent()).slice(-160));
  await shot('10-mesa-agente');
  // 6. Atribuição com confirmação
  g.once('dialog', (d) => d.accept());
  await g.getByTestId('mode-gestao').click();
  await g.waitForTimeout(1000);
  await say('Passa o desmanche da OS 2 pro João amanhã');
  await g.getByTestId('assign-card').waitFor();
  log('atribuição (prévia):', (await g.getByTestId('assign-card').textContent()).slice(0, 160));
  await shot('11-atribuicao-previa');
  console.log('erros', errs.length, errs.slice(0, 5));
  await b.close();
})().catch((e) => {
  console.error('FALHOU', e.message);
  process.exit(1);
});
