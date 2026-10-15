import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Simplificação Fase 3 (estabilização) — chave de idempotência no navegador do tablet:
 * a confirmação de chegada CHEGA ao servidor e é gravada, mas a resposta se perde na rede.
 * O tablet mostra o erro de conexão; na nova tentativa reaproveita a MESMA chave e recebe o
 * mesmo resultado — um único recebimento e uma única OS.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const LOST =
  'Não foi possível confirmar se sua ação foi concluída. Atualize a tela e confira o status antes de tentar novamente.';

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('queda de rede depois do envio: nova tentativa usa a mesma chave e nada duplica', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await loginAdmin(page);
  const people = (await call(page, 'GET', '/api/v1/logistics/people')) as {
    userId: string;
    displayName: string;
  }[];
  const thiago = people.find((p) => p.displayName.startsWith('Thiago'))!;
  const svc = await call(page, 'POST', '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: 'Rita Rede Fictícia',
      phone: null,
      allowSimilar: true,
      address: {
        label: 'Residência',
        street: 'Rua da Rede',
        number: '5',
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
      agreedValueCents: 150000,
      items: [
        { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
      ],
    },
    pickup: {
      scheduledDate: today(),
      windowStart: '23:00',
      team: 'EQUIPE_PROPRIA',
      logisticsUserId: thiago.userId,
    },
  });
  const pickupCode = svc.pickup.code as string;
  const orderId = svc.order.id as string;

  await setPin(page, 'João', '731902');
  const code = await registerDevice(page, 'Tablet João (Rede)', 'João');
  // Tempo real intermediado: durante a "queda" as mensagens do servidor não chegam ao tablet
  // (como numa rede caída); fora dela, tudo passa normalmente nos dois sentidos.
  let muted = false;
  const joao = await openTablet(browser, code, '731902', undefined, {}, (context) =>
    context.routeWebSocket(/\/api\/realtime/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => {
        if (!muted) ws.send(m);
      });
      ws.onMessage((m) => server.send(m));
    }),
  );
  try {
    await joao.page.getByTestId('tile-arrivals').click();
    const card = joao.page.getByTestId(`arrival-piece-${pickupCode}`);
    await card.getByRole('button', { name: 'Confirmar chegada' }).click();

    // 1ª tentativa: o servidor processa (route.fetch), mas a resposta é derrubada (abort).
    const keys: string[] = [];
    let attempt = 0;
    await joao.page.route('**/api/v1/arrivals/pickups/*/confirm', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (attempt++ === 0) {
        muted = true; // a rede "cai" junto: nem a resposta nem o tempo real chegam
        const served = await route.fetch();
        expect(served.status()).toBe(201);
        await route.abort('connectionreset');
      } else {
        await route.continue();
      }
    });
    await joao.page.getByTestId('arrival-submit').click();
    // Mensagem aprovada: não atribui a causa a outro aparelho nem afirma que falhou.
    await expect(joao.page.getByTestId('arrival-error')).toHaveText(LOST);
    await expect(joao.page.getByText(/outro aparelho/)).toHaveCount(0);
    expect(keys).toHaveLength(1); // nenhuma repetição automática
    // Já gravado no servidor, embora o tablet não tenha recebido a resposta.
    const afterFirst = await call(page, 'GET', `/api/v1/receipts?orderId=${orderId}`);
    expect(afterFirst).toHaveLength(1);

    // 2ª tentativa: mesma chave → mesma resposta (sem novo recebimento).
    await joao.page.getByTestId('arrival-submit').click();
    await expect(joao.page.getByTestId('arrival-done')).toBeVisible();
    await expect(joao.page.getByTestId('arrival-done-os')).toContainText(/OS-\d{5}/);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9-]{16,}$/);
    expect(keys[1]).toBe(keys[0]);
    muted = false; // rede de volta
    const receipts = await call(page, 'GET', `/api/v1/receipts?orderId=${orderId}`);
    expect(receipts).toHaveLength(1);
    const sos = await call(page, 'GET', `/api/v1/service-orders?orderId=${orderId}`);
    expect(Array.isArray(sos) ? sos : sos.items).toHaveLength(1);
  } finally {
    await joao.context.close();
  }
});

test('resposta perdida com o tempo real ativo: aviso some, mensagem aprovada, nada reenviado sozinho', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await loginAdmin(page);
  const people = (await call(page, 'GET', '/api/v1/logistics/people')) as {
    userId: string;
    displayName: string;
  }[];
  const thiago = people.find((p) => p.displayName.startsWith('Thiago'))!;
  const svc = await call(page, 'POST', '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: 'Rita Rede Dois',
      phone: null,
      allowSimilar: true,
      address: {
        label: 'Residência',
        street: 'Rua da Rede',
        number: '7',
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
      items: [
        { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
      ],
    },
    pickup: {
      scheduledDate: today(),
      windowStart: '23:00',
      team: 'EQUIPE_PROPRIA',
      logisticsUserId: thiago.userId,
    },
  });
  const pickupCode = svc.pickup.code as string;
  const orderId = svc.order.id as string;
  await setPin(page, 'João', '731903');
  const code = await registerDevice(page, 'Tablet João (Rede 2)', 'João');
  const joao = await openTablet(browser, code, '731903');
  try {
    await joao.page.getByTestId('tile-arrivals').click();
    await joao.page
      .getByTestId(`arrival-piece-${pickupCode}`)
      .getByRole('button', { name: 'Confirmar chegada' })
      .click();
    let sent = 0;
    await joao.page.route('**/api/v1/arrivals/pickups/*/confirm', async (route) => {
      sent++;
      const served = await route.fetch(); // o servidor grava…
      expect(served.status()).toBe(201);
      await route.abort('connectionreset'); // …mas a resposta se perde
    });
    await joao.page.getByTestId('arrival-submit').click();
    // O tempo real tira o aviso da lista; a tela não diz que foi outro aparelho.
    await expect(joao.page.getByTestId('arrival-gone-message')).toHaveText(LOST);
    await expect(joao.page.getByText(/outro aparelho/)).toHaveCount(0);
    await joao.page.waitForTimeout(1500);
    expect(sent).toBe(1); // nenhuma repetição automática
    const receipts = await call(page, 'GET', `/api/v1/receipts?orderId=${orderId}`);
    expect(receipts).toHaveLength(1);
  } finally {
    await joao.context.close();
  }
});

test('aviso some sem resposta perdida neste tablet: texto neutro, sem atribuir a outro aparelho', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await loginAdmin(page);
  const people = (await call(page, 'GET', '/api/v1/logistics/people')) as {
    userId: string;
    displayName: string;
  }[];
  const thiago = people.find((p) => p.displayName.startsWith('Thiago'))!;
  const svc = await call(page, 'POST', '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: 'Rita Rede Três',
      phone: null,
      allowSimilar: true,
      address: {
        label: 'Residência',
        street: 'Rua da Rede',
        number: '9',
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
      items: [
        { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
      ],
    },
    pickup: {
      scheduledDate: today(),
      windowStart: '23:00',
      team: 'EQUIPE_PROPRIA',
      logisticsUserId: thiago.userId,
    },
  });
  const pickupCode = svc.pickup.code as string;
  const order = await call(page, 'GET', `/api/v1/orders/${svc.order.id}`);
  await setPin(page, 'João', '731904');
  const code = await registerDevice(page, 'Tablet João (Rede 3)', 'João');
  const joao = await openTablet(browser, code, '731904');
  try {
    await joao.page.getByTestId('tile-arrivals').click();
    await joao.page
      .getByTestId(`arrival-piece-${pickupCode}`)
      .getByRole('button', { name: 'Confirmar chegada' })
      .click();
    await expect(joao.page.getByTestId('arrival-confirm')).toBeVisible();
    // A chegada é registrada no painel (este tablet não enviou nada).
    await call(page, 'POST', '/api/v1/receipts', {
      orderId: svc.order.id,
      pickupId: svc.pickup.id,
      origin: 'RETIRADA',
      lines: order.items.map((i: { id: string }) => ({
        orderItemId: i.id,
        quantity: 1,
        condition: 'BOA',
        location: 'Área de recebimento',
      })),
    });
    await expect(joao.page.getByTestId('arrival-gone-message')).toHaveText(
      'Esta chegada não está mais pendente.',
    );
    await expect(joao.page.getByText(/outro aparelho/)).toHaveCount(0);
    await expect(joao.page.getByText(LOST)).toHaveCount(0);
  } finally {
    await joao.context.close();
  }
});
