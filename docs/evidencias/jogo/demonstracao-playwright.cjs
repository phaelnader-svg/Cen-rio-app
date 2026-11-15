/* eslint-disable no-console -- roteiro de validação: imprime o resultado no terminal. */
// Demonstrações ponta a ponta do jogo (dev, dados sintéticos). Gera capturas em /tmp/claude-0/shots.
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const CODES = JSON.parse(process.env.CODES);
const PINS = { João: '813572', Márcio: '924681', Ricardo: '735914', Thiago: '461829' };
const shot = (p, n) => p.screenshot({ path: `/tmp/claude-0/shots/${n}.png` });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);

async function screenOf(page, id, h) {
  return page.evaluate(([i, hh]) => window.__cenarioGame.screenOf(i, hh), [id, h ?? 0.6]);
}
async function clickObj(page, id, h) {
  const s = await screenOf(page, id, h);
  if (!s) throw new Error('objeto fora do mapa: ' + id);
  await page.mouse.click(s.x, s.y);
}
async function tablet(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/tablet`);
  await page.getByLabel('Código de vinculação').fill(CODES[name]);
  await page.getByRole('button', { name: 'Vincular tablet' }).click();
  await page.getByText('Digite seu PIN de 6 dígitos').waitFor();
  for (const d of PINS[name]) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByTestId('tablet-user').waitFor();
  return page;
}
async function piece(page, code) {
  const r = await page.request.get(`${BASE}/api/v1/game/snapshot`);
  const d = await r.json();
  return d.pieces.find((p) => p.itemCode === code);
}
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
  await g.goto(`${BASE}/jogo`);
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 6000);
  await shot(g, '10-visao-geral');

  if (!process.env.SKIP2) {
    // ───────────── Demonstração 2: produzir um sofá ─────────────
    log('Demo 2: produzir um sofá');
    await g.getByTestId('game-search').fill('Ana');
    await g.getByTestId('search-results').getByText('OS-00001/1').click();
    await g.getByTestId('piece-panel').waitFor();
    await wait(g, 2500);
    await shot(g, '20-os-ana-falta-material');
    // Estoque: grampos e espuma já existem → reservar pela estante.
    for (const q of ['Grampos', 'Espuma']) {
      await g.getByTestId('game-search').fill(q);
      await g
        .getByTestId('search-results')
        .locator('button')
        .filter({ hasText: q })
        .first()
        .click();
      await g.getByTestId('storage-panel').waitFor();
      await wait(g, 1500);
      const btn = g.getByTestId('reserve-for-os').first();
      if (await btn.isVisible()) {
        if (q === 'Espuma') await shot(g, '21-estante-espuma-antes');
        await btn.click();
        await wait(g, 1500);
      }
    }
    // A espuma só tinha 1 de 2 placas: registra a chegada da outra (entrada oficial) e reserva.
    await g.getByTestId('adjust-open').click();
    await g.getByLabel('Quantidade do ajuste').fill('1');
    await g.getByLabel('Motivo do ajuste').fill('Placa recebida do fornecedor (fictício)');
    await g.getByTestId('adjust-save').click();
    await wait(g, 1500);
    await g.getByTestId('reserve-for-os').first().click();
    await wait(g, 1500);
    await shot(g, '22-estante-espuma-reservada');
    // Mecanismo: chegou do fornecedor → entrada pelo fluxo oficial e reserva.
    await g.getByTestId('game-search').fill('Mecanismo');
    await g
      .getByTestId('search-results')
      .locator('button')
      .filter({ hasText: 'Mecanismo' })
      .first()
      .click();
    await g.getByTestId('storage-panel').waitFor();
    await g.getByTestId('adjust-open').click();
    await g.getByLabel('Quantidade do ajuste').fill('2');
    await g.getByLabel('Motivo do ajuste').fill('Chegou do fornecedor (fictício)');
    await g.getByTestId('adjust-save').click();
    await wait(g, 1500);
    await g.getByTestId('reserve-for-os').first().click();
    await wait(g, 1500);
    // Tecido exclusivo da OS: compra confirmada + recebimento conferido (rotas oficiais).
    const sn = await piece(g, 'OS-00001/1');
    const ready = await (
      await g.request.get(`${BASE}/api/v1/service-orders/${sn.serviceOrderId}/material-readiness`)
    ).json();
    const linho = ready.lines.find((l) => l.kind === 'TECIDO');
    const sup = await (
      await g.request.post(`${BASE}/api/v1/suppliers`, {
        headers: idem(),
        data: { name: 'Tecidos Fictícios da Demonstração', categories: ['TECIDO'] },
      })
    ).json();
    let po = await (
      await g.request.post(`${BASE}/api/v1/purchase-orders`, {
        headers: idem(),
        data: {
          supplierId: sup.id,
          expectedDate: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10),
          items: [
            {
              sourcing: 'EXCLUSIVO_OS',
              allocations: [{ materialRequirementId: linho.requirementId, quantity: linho.need }],
              quantity: linho.need,
              unitPriceCents: 4500,
            },
          ],
        },
      })
    ).json();
    po = await (
      await g.request.post(`${BASE}/api/v1/purchase-orders/${po.id}/confirm`, {
        headers: idem(),
        data: { version: po.version },
      })
    ).json();
    const rec = await g.request.post(`${BASE}/api/v1/material-receipts`, {
      headers: idem(),
      data: {
        purchaseOrderId: po.id,
        lines: [
          {
            purchaseOrderItemId: po.items[0].id,
            acceptedQuantity: linho.need,
            specConfirmed: true,
          },
        ],
      },
    });
    log('recebimento do linho', rec.status());
    // Reabre a ficha: material verde. Planeja (titular Márcio) e publica pelo jogo.
    await g.getByTestId('game-search').fill('Ana');
    await g.getByTestId('search-results').getByText('OS-00001/1').click();
    await g.getByTestId('plan-form').waitFor();
    await wait(g, 1500);
    await shot(g, '23-os-ana-material-ok-planejar');
    await g.getByTestId('plan-form').locator('select').first().selectOption({ label: 'Márcio' });
    await g.getByTestId('plan-service').click();
    await g.getByTestId('publish-week').waitFor();
    await g.getByTestId('publish-week').click();
    await wait(g, 2500);
    log('após publicar:', (await piece(g, 'OS-00001/1')).placement.label);
    await shot(g, '24-na-fila-do-joao');

    // João no tablet real: conclui o sofá do Diego (em execução) e inicia o da Ana.
    const jt = await tablet(browser, 'João');
    const hl = jt.getByTestId('week-highlight');
    await wait(jt, 1500);
    await shot(jt, '25-tablet-joao');
    if (await hl.getByRole('button', { name: 'Concluir' }).isVisible()) {
      await hl.getByRole('button', { name: 'Concluir' }).click();
      await hl.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
      await wait(jt, 1500);
    }
    await hl.getByRole('button', { name: 'Iniciar' }).click();
    await wait(g, 3500);
    const p1 = await piece(g, 'OS-00001/1');
    log('João iniciou:', p1.placement.label);
    await g.evaluate(() => window.__cenarioGame.overview());
    await wait(g, 2500);
    await shot(g, '26-sofa-na-estacao-do-joao');
    await shot(jt, '27-tablet-joao-iniciado');
    await hl.getByRole('button', { name: 'Concluir' }).click();
    await hl.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
    await wait(g, 3000);
    log('João concluiu:', (await piece(g, 'OS-00001/1')).placement.label);
    await shot(g, '28-aguardando-etapa-seguinte');

    // Márcio no tablet: cada etapa iniciada leva o sofá para a estação da etapa.
    const mt = await tablet(browser, 'Márcio');
    const mh = mt.getByTestId('week-highlight');
    for (let i = 0; i < 10; i++) {
      await wait(mt, 1500);
      const start = mh.getByRole('button', { name: 'Iniciar' });
      if (!(await start.isVisible())) break;
      const title = (await mh.textContent()) ?? '';
      await start.click();
      await wait(g, 3000);
      const p = await piece(g, 'OS-00001/1');
      log(`Márcio iniciou (${title.slice(0, 50)}…):`, p.placement.label);
      await g.evaluate(() => window.__cenarioGame.overview());
      await wait(g, 2000);
      await shot(g, `29-marcio-etapa-${i + 1}`);
      await mh.getByRole('button', { name: 'Concluir' }).click();
      const confirm = mh.getByRole('button', { name: 'Toque de novo para confirmar' });
      if (await confirm.isVisible()) await confirm.click();
      else {
        // Etapa exige registro: preenche a observação.
        const note = mt.getByRole('textbox').first();
        if (await note.isVisible()) {
          await note.fill('Concluído (demonstração)');
          await mt
            .getByRole('button', { name: /Concluir/ })
            .last()
            .click();
        }
      }
    }
    let p = await piece(g, 'OS-00001/1');
    log('após produção:', p.stage, p.placement.label);

    // Qualidade (Thiago) e embalagem → expedição.
    const tt = await tablet(browser, 'Thiago');
    const insps = await (await tt.request.get(`${BASE}/api/v1/quality/inspections`)).json();
    const list = insps.items ?? insps;
    const insp =
      list.find(
        (x) =>
          x.serviceOrderItem?.id === p.id ||
          x.itemCode === 'OS-00001/1' ||
          x.serviceOrderItemId === p.id,
      ) ?? list[0];
    if (insp) {
      const full = await (
        await tt.request.get(`${BASE}/api/v1/quality/inspections/${insp.id}`)
      ).json();
      for (const it of full.items)
        await tt.request.put(`${BASE}/api/v1/quality/inspections/${insp.id}/items/${it.id}`, {
          headers: { origin: BASE },
          data: { result: 'OK', note: null },
        });
      const fresh = await (
        await tt.request.get(`${BASE}/api/v1/quality/inspections/${insp.id}`)
      ).json();
      const ap = await tt.request.post(`${BASE}/api/v1/quality/inspections/${insp.id}/approve`, {
        headers: idem(),
        data: { version: fresh.version },
      });
      log('inspeção aprovada', ap.status());
    }
    await wait(g, 2500);
    await shot(g, '30-embalagem');
    const packs = await (await g.request.get(`${BASE}/api/v1/packaging`)).json();
    const pk =
      (packs.items ?? packs).find(
        (x) => (x.serviceOrderItem?.code ?? x.itemCode) === 'OS-00001/1',
      ) ?? (packs.items ?? packs)[0];
    const locs = await (await g.request.get(`${BASE}/api/v1/locations`)).json();
    const exp = (locs.items ?? locs).find((l) => l.key === 'EXPEDICAO');
    const pr = await g.request.post(`${BASE}/api/v1/packaging/${pk.id}/complete`, {
      headers: idem(),
      data: { protection: 'PLASTICO_BOLHA', locationId: exp.id, version: pk.version },
    });
    log('embalagem concluída', pr.status());
    await wait(g, 3000);
    p = await piece(g, 'OS-00001/1');
    log('final:', p.stage, p.placement.label, p.confirmedLocation?.label);
    await g.getByTestId('game-search').fill('Ana');
    await g.getByTestId('search-results').getByText('OS-00001/1').click();
    await wait(g, 2500);
    await shot(g, '31-sofa-na-expedicao');
  }
  // ───────────── Demonstração 1: expandir a empresa ─────────────
  log('Demo 1: expandir a empresa');
  await g.keyboard.press('Escape');
  await g.getByTestId('space-ESCRITORIO').click();
  await wait(g, 2500);
  await g.getByTestId('mode-construcao').click();
  await g.getByTestId('mestre-panel').waitFor();
  await g
    .getByLabel('Pergunta ao Mestre de Obras')
    .fill('Mudei para um escritório maior. Como encaixo mais quatro mesas?');
  await g.getByRole('button', { name: 'Perguntar' }).click();
  await wait(g, 2500);
  await shot(g, '40-mestre-quatro-mesas');
  await g.getByTestId('mestre-apply').click();
  await wait(g, 1500);
  await g.getByTestId('preview-toggle').click();
  await wait(g, 1500);
  await shot(g, '41-previa-escritorio-maior');
  await g.getByTestId('preview-toggle').click();
  await g.getByTestId('save-layout').click();
  await wait(g, 2500);
  await g.getByTestId('mode-gestao').click();
  await wait(g, 2500);
  const office = await (await g.request.get(`${BASE}/api/v1/game/spaces/ESCRITORIO`)).json();
  const agents = await (await g.request.get(`${BASE}/api/v1/game/agents`)).json();
  const freeDesk = office.stations
    .filter((s) => s.kind === 'MESA_ESCRITORIO')
    .find((s) => !agents.some((a) => a.deskStationId === s.id));
  await clickObj(g, freeDesk.id, 0.8);
  await g.getByTestId('desk-new-agent').click();
  await g.getByTestId('agent-config').waitFor();
  await g.getByRole('button', { name: '+ Função nova' }).click();
  await g.getByLabel('Nome').fill('Pós-venda');
  await g.getByTestId('agent-config').getByPlaceholder('Ex.: Pós-venda').fill('Pós-venda');
  await g
    .getByTestId('agent-config')
    .locator('textarea')
    .fill('Acompanhe as entregas da semana e prepare a mensagem de pós-venda para eu aprovar.');
  await g.getByTestId('agent-config').getByLabel('Ordens de serviço').check();
  await shot(g, '42-novo-agente');
  await g.getByTestId('agent-save').click();
  await wait(g, 2500);
  await shot(g, '43-agente-na-mesa');
  // Tapeçaria: muda a bancada do Ricardo (arrastar) e salva.
  await g.getByTestId('space-TAPECARIA').click();
  await wait(g, 2500);
  await g.getByTestId('mode-construcao').click();
  await wait(g, 1500);
  const shop = await (await g.request.get(`${BASE}/api/v1/game/spaces/TAPECARIA`)).json();
  const bench = shop.stations.find((s) => s.name === 'Bancada do Ricardo');
  const a = await screenOf(g, bench.id, 0.85);
  await g.mouse.click(a.x, a.y);
  await wait(g, 800);
  await g.mouse.move(a.x, a.y);
  await g.mouse.down();
  for (let i = 1; i <= 10; i++) await g.mouse.move(a.x - i * 7, a.y + i * 4);
  await wait(g, 400);
  await shot(g, '44-arrastando-bancada');
  await g.mouse.up();
  await wait(g, 1200);
  await g.getByTestId('save-layout').click();
  await wait(g, 2500);
  await shot(g, '45-bancada-movida-salva');
  // Reabre o jogo do zero.
  await g.reload();
  await g.getByTestId('game-canvas').waitFor();
  await wait(g, 6000);
  const shop2 = await (await g.request.get(`${BASE}/api/v1/game/spaces/TAPECARIA`)).json();
  const bench2 = shop2.stations.find((s) => s.id === bench.id);
  const office2 = await (await g.request.get(`${BASE}/api/v1/game/spaces/ESCRITORIO`)).json();
  const agents2 = await (await g.request.get(`${BASE}/api/v1/game/agents`)).json();
  log(
    'bancada antes',
    bench.xCm,
    bench.yCm,
    'depois',
    bench2.xCm,
    bench2.yCm,
    'vínculo',
    JSON.stringify(bench2.assigneeUserIds) === JSON.stringify(bench.assigneeUserIds),
  );
  log(
    'escritório',
    office.widthCm + 'x' + office.depthCm,
    '→',
    office2.widthCm + 'x' + office2.depthCm,
    'mesas',
    office2.stations.filter((s) => s.kind === 'MESA_ESCRITORIO').length,
  );
  const pv = agents2.find((x) => x.name === 'Pós-venda');
  log('agente Pós-venda na mesa', pv && office2.stations.some((s) => s.id === pv.deskStationId));
  await shot(g, '46-reaberto');

  // ───────────── Demonstração 3: tomar uma decisão ─────────────
  log('Demo 3: decisão');
  await g.getByTestId('game-search').fill('Espuma');
  await g
    .getByTestId('search-results')
    .locator('button')
    .filter({ hasText: 'Espuma' })
    .first()
    .click();
  await g.getByTestId('storage-panel').waitFor();
  await wait(g, 2500);
  await shot(g, '50-prateleira-espuma');
  await g.getByTestId('space-ESCRITORIO').click();
  await wait(g, 2500);
  const ger = agents2.find((x) => x.roleKey === 'GERENTE');
  await clickObj(g, ger.id, 1.0);
  await g.getByTestId('agent-panel').waitFor();
  await g.getByRole('button', { name: 'Monte o plano semanal' }).click();
  await wait(g, 4000);
  await shot(g, '51-gerente-plano-semanal');
  console.log('erros de página/console:', errors.length, errors.slice(0, 8));
  await browser.close();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
