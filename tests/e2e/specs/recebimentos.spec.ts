import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Simplificação Fase 3 — recebimentos compartilhados entre tablets (dados fictícios):
 *  1. Serviço com retirada de hoje pela equipe própria (Thiago) com João participando.
 *     João vê a parada em "Minhas retiradas e entregas de hoje" (sem valores).
 *  2. Dois tablets (João e Márcio) com "Aguardando chegada" aberto. Márcio abre a confirmação;
 *     João confirma parte das peças → OS criada só com o que chegou. A tela do Márcio avisa
 *     "já atualizado" em tempo real; ele confere o saldo e confirma o restante → o aviso some
 *     dos dois tablets.
 *  3. Materiais: contagem física (placas) + rolos de material controlado em metros (sem
 *     metragem inventada); o gestor confere a chegada física no painel.
 *  4. Painel: quem confirmou, em qual aparelho, OS criada.
 *  5. Auditoria visual do "Aguardando chegada" em 390/768/1280/1440 sem rolagem horizontal.
 */
const origin = `http://localhost:${E2E.webPort}`;
const shot = (page: Page, name: string) =>
  process.env.E2E_GEOMETRIA
    ? page.screenshot({
        path: `../../docs/evidencias/simplificacao-fase-3/${name}.png`,
        fullPage: true,
      })
    : Promise.resolve();
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, 'rolagem horizontal').toBeLessThanOrEqual(0);
}

test.describe.serial('Simplificação Fase 3 — Aguardando chegada', () => {
  test('dois tablets: chegada parcial, aviso de atualização, materiais e conferência', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);

    const people = (await call(page, 'GET', '/api/v1/logistics/people')) as {
      userId: string;
      displayName: string;
    }[];
    const who = (n: string) => people.find((p) => p.displayName.startsWith(n))!;
    const THIAGO = who('Thiago');
    const JOAO = who('João');

    // ── 1. Serviço (Fase 2) com retirada da equipe própria; João participa.
    const svc = await call(page, 'POST', '/api/v1/services', {
      customer: {
        mode: 'NOVO',
        kind: 'PF',
        name: 'Helena Chegada Fictícia',
        phone: null,
        allowSimilar: true,
        address: {
          label: 'Residência',
          street: 'Rua das Chegadas',
          number: '10',
          district: 'Bairro Fictício',
          postalCode: '01000-000',
          city: 'Cidade Teste',
          state: 'SP',
          isPrimary: true,
        },
      },
      service: {
        promisedDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        contractedService: 'Reforma completa',
        agreedValueCents: 300000,
        items: [
          {
            pieceType: 'SOFA',
            description: 'Sofá da sala',
            quantity: 1,
            serviceType: 'REFORMA_COMPLETA',
          },
          {
            pieceType: 'POLTRONA',
            description: 'Poltronas',
            quantity: 2,
            serviceType: 'TROCA_DE_TECIDO',
          },
        ],
      },
      pickup: {
        scheduledDate: today(),
        windowStart: '23:00',
        team: 'EQUIPE_PROPRIA',
        logisticsUserId: THIAGO.userId,
        participantUserIds: [JOAO.userId],
      },
    });
    const pickupCode = svc.pickup.code as string;

    // Material: placas de espuma (contagem) + manta em metros (chegada física em rolos).
    const supplier = await call(page, 'POST', '/api/v1/suppliers', {
      name: 'Fornecedor Chegada E2E',
      phone: '(11) 4000-0000',
      categories: ['ESPUMA', 'OUTRO'],
    });
    const foam = await call(page, 'POST', '/api/v1/stock-items', {
      kind: 'ESPUMA',
      description: 'Placa espuma D28 E2E',
      unit: 'PLACA',
      foamDensity: 'D28',
      thicknessCm: 10,
      lengthCm: 190,
      widthCm: 130,
    });
    const blanket = await call(page, 'POST', '/api/v1/stock-items', {
      kind: 'OUTRO',
      description: 'Manta acrílica E2E',
      unit: 'METRO',
    });
    const draft = await call(page, 'POST', '/api/v1/purchase-orders', {
      supplierId: supplier.id,
      expectedDate: today(),
      items: [
        { sourcing: 'ESTOQUE', stockItemId: foam.id, quantity: 3, unitPriceCents: 9000 },
        { sourcing: 'ESTOQUE', stockItemId: blanket.id, quantity: 30, unitPriceCents: 1500 },
      ],
    });
    const po = await call(page, 'POST', `/api/v1/purchase-orders/${draft.id}/confirm`, {
      version: draft.version,
    });
    const poCode = po.code as string;

    // ── Dois tablets (João 1280×800, Márcio 768×1024).
    await setPin(page, 'João', '731902');
    await setPin(page, 'Márcio', '582046');
    const cj = await registerDevice(page, 'Tablet João (Chegada)', 'João');
    const cm = await registerDevice(page, 'Tablet Márcio (Chegada)', 'Márcio');
    const joao = await openTablet(browser, cj, '731902');
    const marcio = await openTablet(browser, cm, '582046', { width: 768, height: 1024 });

    // João participa da retirada do Thiago: vê a parada (sem valores).
    const stop = joao.page.getByTestId(`route-stop-${pickupCode}`);
    await expect(stop).toContainText('Thiago');
    await expect(stop).toContainText('João');
    await expect(joao.page.getByText(/R\$/)).toHaveCount(0);
    await shot(joao.page, '01-joao-inicio-minhas-retiradas');

    for (const t of [joao, marcio]) {
      await expect(t.page.getByTestId('arrivals-count')).not.toHaveText('0');
      await t.page.getByTestId('tile-arrivals').click();
      await expect(t.page.getByTestId(`arrival-piece-${pickupCode}`)).toBeVisible();
    }
    const jCard = joao.page.getByTestId(`arrival-piece-${pickupCode}`);
    await expect(jCard).toContainText('Helena F.');
    await expect(jCard).not.toContainText('Fictícia');
    await expect(jCard.getByTestId('arrival-situation')).toContainText(
      /Retirada (de hoje|prevista)/,
    );
    await expect(joao.page.getByText(/atrasad/i)).toHaveCount(0);
    await expect(joao.page.getByText(/R\$/)).toHaveCount(0);
    await shot(joao.page, '02-tablet-aguardando-chegada');

    // ── 2. Márcio abre a confirmação; João confirma 1 sofá + 1 poltrona.
    await marcio.page
      .getByTestId(`arrival-piece-${pickupCode}`)
      .getByRole('button', { name: 'Confirmar chegada' })
      .click();
    await jCard.getByRole('button', { name: 'Confirmar chegada' }).click();
    await joao.page
      .getByTestId('arrival-line-Poltronas')
      .getByRole('button', { name: 'Menos' })
      .click();
    await expect(joao.page.getByTestId('arrival-line-Poltronas').getByTestId('qty')).toHaveText(
      '1',
    );
    await expect(joao.page.getByTestId('arrival-submit')).toHaveText('Confirmar 2 peça(s)');
    await shot(joao.page, '03-tablet-confirmacao-parcial');
    await joao.page.getByTestId('arrival-submit').click();
    const done = joao.page.getByTestId('arrival-done');
    await expect(done.getByTestId('arrival-done-os')).toContainText(/OS-\d{5}/);
    await expect(done.getByTestId('arrival-done-remaining')).toContainText('Ainda aguardando: 1');
    await expect(done).toContainText('Por João');
    await shot(joao.page, '04-tablet-resultado-os');

    // Tela do Márcio desatualizada → aviso em tempo real; confirmar fica bloqueado.
    await expect(marcio.page.getByTestId('arrival-stale')).toBeVisible();
    // Sem resposta perdida neste tablet: texto neutro, sem atribuir a causa a outro aparelho.
    await expect(marcio.page.getByTestId('arrival-stale-message')).toHaveText(
      'Este aviso foi atualizado depois que a tela abriu. Confira o saldo atual antes de confirmar.',
    );
    await expect(marcio.page.getByTestId('arrival-submit')).toBeDisabled();
    await shot(marcio.page, '05-tablet-marcio-ja-atualizado');
    await marcio.page.getByTestId('arrival-reload').click();
    await expect(marcio.page.getByTestId('arrival-line-Sofá da sala')).toHaveCount(0);
    await expect(marcio.page.getByTestId('arrival-line-Poltronas').getByTestId('qty')).toHaveText(
      '1',
    );
    await marcio.page.getByTestId('arrival-submit').click();
    await expect(marcio.page.getByTestId('arrival-done-remaining')).toContainText(
      'Nada mais aguardando',
    );
    // O aviso some dos DOIS tablets.
    await joao.page.getByRole('button', { name: 'Voltar ao Aguardando chegada' }).click();
    await expect(joao.page.getByTestId(`arrival-piece-${pickupCode}`)).toHaveCount(0);
    await marcio.page.getByRole('button', { name: 'Voltar ao Aguardando chegada' }).click();
    await expect(marcio.page.getByTestId(`arrival-piece-${pickupCode}`)).toHaveCount(0);

    // ── 3. Materiais: João conta 2 de 3 placas e 2 rolos de manta.
    const mCard = joao.page.getByTestId(`arrival-material-${poCode}`);
    await expect(mCard.getByTestId('arrival-situation')).toHaveText('Previsto para hoje');
    await expect(marcio.page.getByTestId(`arrival-material-${poCode}`)).toBeVisible();
    await mCard.getByRole('button', { name: 'Confirmar materiais' }).click();
    const foamLine = joao.page.getByTestId('arrival-line-Placa espuma D28 E2E');
    await expect(foamLine.getByTestId('qty')).toHaveText('3');
    await foamLine.getByRole('button', { name: 'Menos' }).click();
    const rollLine = joao.page.getByTestId('arrival-line-Manta acrílica E2E');
    await rollLine.getByRole('button', { name: 'Mais' }).click();
    await rollLine.getByRole('button', { name: 'Mais' }).click();
    await shot(joao.page, '06-tablet-materiais-contagem-fisica');
    await joao.page.getByTestId('arrival-submit').click();
    const mDone = joao.page.getByTestId('arrival-done');
    await expect(mDone.getByTestId('arrival-done-receipt')).toContainText(/RM-\d{5}|Recebimento/);
    await expect(mDone.getByTestId('arrival-done-arrival')).toContainText(/CH-\d{5}/);
    const arrivalCode = (await mDone.getByTestId('arrival-done-arrival').textContent())!.match(
      /CH-\d{5}/,
    )![0];
    // Márcio vê o saldo atualizado sem recarregar: a manta saiu (aguarda conferência).
    const mm = marcio.page.getByTestId(`arrival-material-${poCode}`);
    await expect(mm).toContainText('1 item(ns) já chegaram e aguardam conferência.');
    await expect(mm).not.toContainText('Manta acrílica E2E');

    // ── 4. Painel: conferência técnica da chegada física (metragem real).
    await page.goto('/painel/recebimento-materiais');
    const row = page.getByTestId(`material-arrival-${arrivalCode}`);
    await expect(row).toContainText('2 rolo(s) de Manta acrílica E2E');
    await expect(row).toContainText('João');
    await expect(row).toContainText('Tablet João (Chegada)');
    await shot(page, '07-painel-chegadas-fisicas');
    await row.getByRole('button', { name: 'Conferir' }).click();
    const form = page.getByTestId('receive-form');
    await expect(form).toContainText(`Conferência da chegada ${arrivalCode}`);
    await expect(page.getByTestId('receive-item-Placa espuma D28 E2E')).toHaveCount(0);
    const it = page.getByTestId('receive-item-Manta acrílica E2E');
    await it.getByLabel('Recebido em ordem').fill('24,5');
    await it.getByText('Conferi referência, cor e especificação').click();
    await page.getByRole('button', { name: 'Confirmar recebimento' }).click();
    await expect(page.getByTestId('material-receipt-done')).toBeVisible();
    const arrivals = await call(page, 'GET', '/api/v1/material-arrivals?status=CONFERIDA');
    expect(arrivals.some((a: { code: string }) => a.code === arrivalCode)).toBe(true);

    // Recebimentos de peças: quem confirmou, aparelho e OS criada.
    await page.goto('/painel/recebimentos');
    const list = page.getByTestId('receipts-list');
    await expect(
      list.getByText('Confirmado por João no aparelho Tablet João (Chegada)'),
    ).toBeVisible();
    await expect(
      list.getByText('Confirmado por Márcio no aparelho Tablet Márcio (Chegada)'),
    ).toBeVisible();
    await shot(page, '08-painel-recebimentos-quem-confirmou');

    // ── 5. Auditoria visual do "Aguardando chegada".
    await joao.page.getByRole('button', { name: 'Voltar ao Aguardando chegada' }).click();
    for (const [w, h] of [
      [390, 844],
      [768, 1024],
      [1280, 800],
      [1440, 900],
    ] as const) {
      await joao.page.setViewportSize({ width: w, height: h });
      await expect(joao.page.getByTestId('arrivals-center')).toBeVisible();
      await noHorizontalScroll(joao.page);
      await shot(joao.page, `09-aguardando-chegada-${w}`);
      await joao.page
        .getByTestId(`arrival-material-${poCode}`)
        .getByRole('button', { name: 'Confirmar materiais' })
        .click();
      await expect(joao.page.getByTestId('arrival-confirm')).toBeVisible();
      await noHorizontalScroll(joao.page);
      await shot(joao.page, `10-confirmar-materiais-${w}`);
      await joao.page.getByRole('button', { name: 'Voltar', exact: true }).click();
    }
    await joao.context.close();
    await marcio.context.close();
  });
});
