// Primeira demonstração do escritório financeiro (dev, dados sintéticos, provedores em teste local):
// orçamento aprovado → contrato preparado/revisado/enviado → assinado (retorno de teste) →
// entrada → pagamento confirmado (retorno de teste) → baixa na OS → ficha atualizada;
// reenviar a MESMA confirmação não gera nova baixa. Capturas em /tmp/claude-0/shots/financeiro.
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const OUT = '/tmp/claude-0/shots/financeiro';
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);
const idem = () => ({ 'idempotency-key': crypto.randomUUID().replace(/-/g, ''), origin: BASE });

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const g = await ctx.newPage();
  const errors = [];
  g.on('pageerror', (e) => errors.push(e.message));
  g.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
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

  log('0. Cadastro: CNPJ/endereço da Cenário e CPF/e-mail da Ana (rotas oficiais); provedores em teste');
  const co = await api('GET', '/api/company/settings');
  await api('PUT', '/api/company/settings', { ...co, legalName: co.legalName || 'Cenário Estofados Ltda (fictícia)', document: co.document || '11.222.333/0001-81', address: co.address || 'Rua das Oficinas, 50, Centro, São José dos Campos/SP', email: co.email || 'contato@cenario.test' });
  const sos = await api('GET', `/api/v1/service-orders?q=${encodeURIComponent('Ana Fictícia')}`);
  const so = await api('GET', `/api/v1/service-orders/${sos.items[0].id}`);
  const cust = await api('GET', `/api/v1/customers/${so.customer.id}`);
  if (!cust.document || !cust.email) {
    const { id: _i, version, addresses: _a, createdAt: _c, updatedAt: _u, active: _ac, ...rest } = cust;
    await api('PUT', `/api/v1/customers/${cust.id}`, { kind: rest.kind, name: rest.name, tradeName: rest.tradeName ?? null, document: '529.982.247-25', phone: rest.phone ?? null, whatsapp: rest.whatsapp ?? null, email: 'ana.ficticia@exemplo.test', notes: rest.notes ?? null, version, allowSimilar: true });
  }
  for (const k of ['ASSINATURA', 'COBRANCAS', 'FISCAL']) await api('POST', `/api/v1/connections/${k}/test-mode`, {}).catch(() => {});

  await g.goto(`${BASE}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 4000);

  log('1. Sofá da Ana → ficha comercial');
  await g.getByTestId('game-search').fill('Ana');
  await g.getByTestId('search-results').getByText('OS-00001/1').click();
  await g.getByTestId('piece-panel').waitFor();
  await g.getByTestId('open-ficha').click();
  await g.getByTestId('ficha-steps').waitFor();
  await wait(g, 800);
  await shot(g, '01-ficha-orcamento-aprovado');

  log('2. Contrato: preparar, revisar, enviar');
  await g.getByTestId('ficha-tab-CONTRATO').click();
  await g.getByTestId('contract-tab').waitFor();
  await g.waitForLoadState('networkidle');
  await wait(g, 1200);
  if (await g.getByTestId('contract-prepare').isVisible().catch(() => false)) await g.getByTestId('contract-prepare').click();
  await g.getByTestId('contract-body').waitFor();
  await wait(g, 500);
  if (await g.getByTestId('contract-missing').isVisible().catch(() => false)) {
    // Rascunho antigo com campos faltando: o agente refaz pelo modelo com os dados atuais.
    await g.getByRole('button', { name: 'Refazer pelo modelo' }).click();
    await wait(g, 1500);
  }
  if (await g.getByTestId('contract-missing').isVisible().catch(() => false)) throw new Error('contrato ainda com campos faltando');
  await shot(g, '02-contrato-preenchido');
  await g.getByTestId('contract-review-send').click();
  await g.getByTestId('contract-confirm').waitFor();
  await shot(g, '03-contrato-confirmar-envio');
  await g.getByTestId('contract-send').click();
  await g.getByTestId('contract-simulate').waitFor();
  await shot(g, '04-contrato-enviado');
  await g.getByTestId('contract-simulate').click();
  await g.getByTestId('contract-pdf').waitFor();
  await shot(g, '05-contrato-assinado');

  log('3. Entrada: plano, aprovar e emitir');
  await g.getByTestId('ficha-tab-COBRANCA').click();
  await g.getByTestId('charge-plan').waitFor();
  await wait(g, 600);
  await shot(g, '06-plano-entrada-saldo');
  await g.getByTestId('charge-approve').click();
  await g.getByTestId('charge-row').first().waitFor();
  await wait(g, 600);
  await shot(g, '07-entrada-emitida-pix');

  log('4. Pagamento confirmado pelo provedor (teste) → baixa');
  await g.getByTestId('charge-simulate').first().click();
  await g.getByTestId('charge-resend').first().waitFor();
  await wait(g, 600);
  await shot(g, '08-entrada-paga-baixa');
  const orderId = so.orderId ?? so.order?.id;
  const before = (await api('GET', `/api/v1/office/orders/${orderId}/charges`)).map((r) => r.receivedCents).reduce((a, b) => a + b, 0);
  await g.getByTestId('charge-resend').first().click();
  await wait(g, 1500);
  await shot(g, '09-reenvio-ignorado');
  const after = (await api('GET', `/api/v1/office/orders/${orderId}/charges`)).map((r) => r.receivedCents).reduce((a, b) => a + b, 0);
  if (before !== after) throw new Error(`baixa duplicada: ${before} → ${after}`);

  log('5. Ficha atualizada');
  await g.getByTestId('ficha-tab-RESUMO').click();
  await g.getByTestId('ficha-step-ENTRADA').getByText('Pago').waitFor();
  await shot(g, '10-ficha-atualizada');
  const ficha = await api('GET', `/api/v1/office/service-orders/${so.id}/ficha`);
  console.log('ficha:', ficha.steps.map((s) => `${s.key}=${s.state}`).join(' | '));
  console.log('recebido antes/depois do reenvio:', before, after);

  log('6. Chat financeiro e painel do escritório');
  await g.getByTestId('cenaria-input').fill('Quais entregas de amanhã têm saldo?');
  await g.getByTestId('cenaria-input').press('Enter');
  await wait(g, 1500);
  await g.getByTestId('cenaria-input').fill('Separe as notas e comprovantes do mês');
  await g.getByTestId('cenaria-input').press('Enter');
  await g.getByTestId('finance-panel').waitFor();
  await g.getByTestId('closing-tab').waitFor();
  await wait(g, 800);
  await shot(g, '11-fechamento-do-mes');
  await g.getByTestId('fin-tab-HOJE').click();
  await g.getByTestId('forecast-tab').waitFor();
  await wait(g, 600);
  await shot(g, '12-previsao');
  console.log('erros no console:', errors.length ? errors : 'nenhum');
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
