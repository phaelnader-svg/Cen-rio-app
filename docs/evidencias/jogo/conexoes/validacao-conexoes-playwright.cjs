/* eslint-disable no-console -- roteiro de validação: imprime o resultado no terminal. */
// Validação ponta a ponta: Central de Conexões + WhatsApp (conta de teste) + Instagram/Messenger/Ads.
// Dev com dados sintéticos; capturas em /tmp/claude-0/shots/conexoes.
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const OUT = '/tmp/claude-0/shots/conexoes';
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);
const idem = () => ({ 'idempotency-key': crypto.randomUUID().replace(/-/g, ''), origin: BASE });

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const g = await ctx.newPage();
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
  const api = async (method, url, data) => {
    const r = await g.request.fetch(`${BASE}${url}`, { method, data, headers: idem() });
    if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${await r.text()}`);
    return r.json();
  };
  // Estado limpo das conexões de teste (reexecutável).
  for (const k of ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'META_ADS'])
    await api('POST', `/api/v1/connections/${k}/disconnect`, {}).catch(() => {});

  await g.goto(`${BASE}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 4000);
  await g.getByTestId('space-ESCRITORIO').click();
  await wait(g, 2500);

  log('1. Central de Conexões');
  await g.getByTestId('central-chip').click();
  await g.getByTestId('central-panel').waitFor();
  await g.getByTestId('conn-CENARIO').locator('button').first().click();
  await wait(g, 400);
  await shot(g, '01-central-sessao-cenario');
  await g.getByTestId('conn-CENARIO').locator('button').first().click();
  await g.getByTestId('conn-WHATSAPP').locator('button').first().click();
  await g.getByTestId('missing-WHATSAPP').waitFor();
  await shot(g, '02-whatsapp-o-que-falta');
  await g.getByTestId('testmode-WHATSAPP').click();
  await g.getByTestId('simulate-WHATSAPP').waitFor();
  await g.getByTestId('test-WHATSAPP').click();
  await wait(g, 600);
  await shot(g, '03-whatsapp-conta-teste');

  // Agente de Atendimento (rascunho no WhatsApp/Instagram/Messenger) — mesma rota da tela de configuração.
  const agents = await api('GET', '/api/v1/game/agents');
  let atend = agents.find((a) => a.roleKey === 'ATENDIMENTO' && a.status === 'ATIVO');
  if (!atend)
    atend = await api('POST', '/api/v1/game/agents', {
      name: 'Atendimento',
      roleKey: 'ATENDIMENTO',
      roleLabel: 'Atendimento',
      instructions: 'Responda no tom da Cenário.',
      dataScopes: ['os', 'clientes'],
      channelPolicies: { WHATSAPP: 'RASCUNHO', INSTAGRAM: 'RASCUNHO', MESSENGER: 'RASCUNHO' },
      autoSendRules: [],
      color: '#16a34a',
    });

  log('2. Mensagem chega pelo webhook assinado');
  const stamp = Date.now().toString().slice(-4);
  await g
    .getByTestId('simulate-WHATSAPP')
    .getByLabel('Nome do contato')
    .fill(`Hadassa Lima ${stamp}`);
  await g
    .getByTestId('simulate-WHATSAPP')
    .getByLabel('Número ou id do contato')
    .fill(`55129911${stamp}`);
  await g.getByTestId('simulate-send-WHATSAPP').click();
  await wait(g, 1500);
  await g.getByTestId('inbox-chip').click();
  await g.getByTestId('inbox-panel').waitFor();
  await wait(g, 500);
  await shot(g, '04-caixa-de-entrada');
  await g
    .getByTestId('inbox-row')
    .filter({ hasText: `Hadassa Lima ${stamp}` })
    .click();
  await g.getByTestId('conversation-panel').waitFor();
  await g.getByTestId('conv-summary').waitFor();
  const draft = await g.getByTestId('conv-text').inputValue();
  if (!/Hadassa/.test(draft)) throw new Error('rascunho do agente não carregou: ' + draft);
  await shot(g, '05-rascunho-do-agente');

  log('3. Revisar e enviar');
  await g.getByTestId('conv-text').fill(`${draft} Atendemos em São José dos Campos e região.`);
  await g.getByTestId('conv-send').click();
  await g.getByTestId('conv-messages').getByText('enviada (teste)').waitFor();
  await shot(g, '06-resposta-enviada');

  log('4. Vincular a uma OS de teste');
  const sos = await api('GET', '/api/v1/service-orders?limit=5');
  const so = (sos.items ?? sos)[0];
  await g.getByTestId('conv-os-input').fill(String(so.number));
  await g.getByTestId('conv-link-os').click();
  await g.getByTestId('conv-os').waitFor();
  await shot(g, '07-vinculada-a-os');

  log('5. Falar com a Cenário: quem espera orçamento no WhatsApp');
  await g.getByTestId('cenaria-input').fill('quem está esperando orçamento no WhatsApp?');
  await g.getByTestId('cenaria-input').press('Enter');
  await g
    .getByTestId('cenaria-log')
    .getByText(`Hadassa Lima ${stamp} (WhatsApp)`)
    .first()
    .waitFor();
  await shot(g, '08-chat-esperando-orcamento');
  await g.getByTestId('cenaria-log').getByText(`Hadassa Lima ${stamp} (WhatsApp)`).first().click();
  await g.getByTestId('conversation-panel').waitFor();
  await shot(g, '09-chat-abre-conversa');

  log('6. Instagram direct, Messenger e post de teste');
  await g.getByTestId('central-chip').click();
  for (const k of ['INSTAGRAM', 'MESSENGER', 'META_ADS']) {
    await g.getByTestId(`conn-${k}`).locator('button').first().click();
    await g.getByTestId(`testmode-${k}`).click();
    await wait(g, 700);
    if (k !== 'META_ADS') {
      await g
        .getByTestId(`simulate-${k}`)
        .getByLabel('Mensagem')
        .fill(
          k === 'INSTAGRAM'
            ? 'Vocês fazem cabeceira sob medida? Quanto fica?'
            : 'Qual o valor para trocar a espuma de 2 poltronas?',
        );
      await g
        .getByTestId(`simulate-${k}`)
        .getByLabel('Nome do contato')
        .fill(k === 'INSTAGRAM' ? '@carla.decor' : 'Paulo Messenger');
      await g.getByTestId(`simulate-send-${k}`).click();
      await wait(g, 1200);
    }
    await g.getByTestId(`conn-${k}`).locator('button').first().click();
  }
  await shot(g, '10-central-canais-conectados');
  await g.getByTestId('inbox-chip').click();
  await wait(g, 600);
  await shot(g, '11-caixa-tres-canais');

  await g.getByTestId('central-chip').click();
  await g.getByTestId('conn-INSTAGRAM').locator('button').first().click();
  await g.getByRole('button', { name: 'Publicações' }).click();
  await g.getByTestId('marketing-panel').waitFor();
  await g.getByTestId('mkt-draft').click();
  await g.getByTestId('mkt-post').first().waitFor();
  const media = g.getByTestId('mkt-post').first().locator('textarea').nth(1);
  if (!(await media.inputValue()).trim()) {
    await media.fill('https://exemplo.test/sofa-reformado.jpg');
    await g.getByTestId('mkt-post').first().getByRole('button', { name: 'Salvar' }).click();
    await wait(g, 600);
  }
  await shot(g, '12-post-previa');
  await g.getByTestId('mkt-publish').first().click();
  await wait(g, 1000);
  await shot(g, '13-post-publicado-teste');

  log('7. Meta Ads: leitura e proposta de orçamento');
  const all = await api('GET', '/api/v1/game/agents');
  if (!all.find((a) => a.roleKey === 'TRAFEGO' && a.status === 'ATIVO'))
    await api('POST', '/api/v1/game/agents', {
      name: 'Tráfego',
      roleKey: 'TRAFEGO',
      roleLabel: 'Tráfego',
      instructions: 'Otimize custo por contato.',
      dataScopes: [],
      channelPolicies: { META_ADS: 'CONSULTAR' },
      color: '#2563eb',
    });
  await g.getByTestId('central-chip').click();
  await g.getByTestId('conn-META_ADS').locator('button').first().click();
  await g.getByRole('button', { name: 'Campanhas' }).click();
  await g.getByTestId('ads-panel').waitFor();
  await wait(g, 800);
  await shot(g, '14-campanhas');
  await g.getByTestId('ads-analyze').click();
  await g.getByTestId('agent-panel').waitFor();
  await wait(g, 1200);
  await shot(g, '15-trafego-propostas');
  await g.getByTestId('proposal-approve').first().click();
  await g.getByTestId('agent-actions').getByText('Mudança de orçamento').first().waitFor();
  await shot(g, '16-orcamento-aprovado-historico');

  log('8. Histórico do agente de Atendimento');
  await g.evaluate(() => window.scrollTo(0, 0));
  const hist = await api('GET', `/api/v1/game/agents/${atend.id}/actions`);
  if (!hist.some((h) => h.kind === 'RESPOSTA_APROVADA' && h.approvedById))
    throw new Error('histórico sem resposta aprovada');
  await g.goto(`${BASE}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 3000);
  await g.getByTestId('cenaria-input').fill('quem está esperando orçamento no WhatsApp?');
  await g.getByTestId('cenaria-input').press('Enter');
  await wait(g, 1500);
  console.log(
    'histórico:',
    hist
      .map((h) => `${h.channel}/${h.kind}/${h.status}${h.approvedById ? '/aprovado' : ''}`)
      .join(', '),
  );
  console.log('erros no console:', errors.length ? errors : 'nenhum');
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
