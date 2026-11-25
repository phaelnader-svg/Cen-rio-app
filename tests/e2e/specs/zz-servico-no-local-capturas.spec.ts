import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * 2026-11-25 — Serviço "No local" (feito na casa do cliente), ao lado da Retirada, em todo
 * agendamento. Dados fictícios. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/servico-no-local';
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

const addr = (street: string) => ({
  label: 'Residência',
  street,
  number: '120',
  district: 'Jardim das Flores',
  city: 'Cidade Exemplo',
  state: 'SP',
  postalCode: '01000-000',
  isPrimary: true,
});

async function closeService(
  page: Page,
  o: {
    name: string;
    street: string;
    service: string;
    piece: { pieceType: string; description: string; quantity: number; serviceType: string };
    kind: 'RETIRADA' | 'NO_LOCAL';
    at: string;
    userId: string;
  },
) {
  return call(page, 'POST', '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: o.name,
      phone: '(11) 90000-0000',
      allowSimilar: true,
      address: addr(o.street),
    },
    service: {
      contractedService: o.service,
      agreedValueCents: 120000,
      promisedDate: today(),
      deliveryBusinessDays: o.kind === 'NO_LOCAL' ? null : 10,
      items: [{ ...o.piece, fabricName: 'Linho cru' }],
    },
    pickup: {
      kind: o.kind,
      team: 'LOGISTICA_TERCEIRIZADA',
      logisticsUserId: o.userId,
      scheduledDate: today(),
      windowStart: o.at,
      participantUserIds: [],
    },
  }) as Promise<{ order: { id: string }; pickup: { id: string } }>;
}

test('capturas: serviço no local', async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const employees = (await call(page, 'GET', '/api/employees')) as {
    displayName: string;
    userId: string;
  }[];
  const andre = employees.find((e) => e.displayName === 'André')!;

  const silvia = await closeService(page, {
    name: 'Sílvia Moraes',
    street: 'Rua das Acácias',
    service: 'Troca de tecido das cadeiras',
    piece: {
      pieceType: 'CADEIRA',
      description: 'Cadeiras de jantar',
      quantity: 6,
      serviceType: 'TROCA_DE_TECIDO',
    },
    kind: 'NO_LOCAL',
    at: '09:00',
    userId: andre.userId,
  });
  await closeService(page, {
    name: 'Paulo Nogueira',
    street: 'Avenida Brasil',
    service: 'Reforma de poltrona',
    piece: {
      pieceType: 'POLTRONA',
      description: 'Poltrona do escritório',
      quantity: 1,
      serviceType: 'REFORMA_COMPLETA',
    },
    kind: 'RETIRADA',
    at: '14:00',
    userId: andre.userId,
  });
  // Pedido sem agendamento ainda (para o botão "Agendar").
  const marta = await call(page, 'POST', '/api/v1/customers', {
    kind: 'PF',
    name: 'Marta Siqueira',
    phone: null,
    allowSimilar: true,
    addresses: [addr('Rua dos Ipês')],
  });
  const martaOrder = await call(page, 'POST', '/api/v1/orders', {
    customerId: marta.id,
    pickupAddressId: marta.addresses[0].id,
    contractedService: 'Reforma da cabeceira',
    agreedValueCents: 80000,
    paymentTerms: 'À vista',
    promisedDate: today(),
    items: [{ pieceType: 'CABECEIRA', description: 'Cabeceira de casal', quantity: 1 }],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    timezoneId: TZ,
    storageState: await page.context().storageState(),
  });
  const pp = await ctx.newPage();
  const shot = (p: Page, name: string, full = false) =>
    p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

  // 1. Fechar serviço: três opções (Retirada, No local, Cliente traz).
  await pp.goto('/painel/servicos/novo');
  await pp.getByTestId('ns-delivery-onsite').click();
  const section = pp.locator('#ns-retirada');
  await section.scrollIntoViewIfNeeded();
  await expect(pp.getByTestId('ns-promised-onsite')).toBeVisible();
  await section.screenshot({ path: `${OUT}/1-fechar-servico-no-local.png` });

  // 2. Pedido sem agendamento: "Agendar" abre a escolha Retirada / No local.
  await pp.goto(`/painel/pedidos/${martaOrder.id}`);
  await pp.getByRole('button', { name: 'Agendar', exact: true }).click();
  const dlg = pp.getByRole('dialog');
  await dlg.getByTestId('pickup-kind-NO_LOCAL').click();
  await expect(dlg.getByRole('button', { name: 'Agendar serviço no local' })).toBeVisible();
  await shot(pp, '2-agendar-escolher-no-local');
  await pp.keyboard.press('Escape');

  // 3. Pedido No local: já pode gerar a OS (não espera a peça chegar).
  await pp.goto(`/painel/pedidos/${silvia.order.id}`);
  await expect(pp.getByTestId('order-generate-os')).toBeVisible();
  await expect(pp.getByTestId('order-status')).toContainText('No local agendado');
  await shot(pp, '3-pedido-no-local-gerar-os');

  // 4. Agenda do mês: No local em verde, contagem do mês.
  await pp.goto('/painel/retiradas');
  await expect(pp.getByTestId('agenda-month-count')).toContainText('1 no local');
  await shot(pp, '4-agenda-do-mes', true);

  // 5. Roteiro do dia.
  await pp.goto(`/painel/roteiro?data=${today()}`);
  await expect(pp.getByText('No local').first()).toBeVisible();
  await shot(pp, '5-roteiro-do-dia', true);

  // 6. OS do serviço no local: aviso com dia, horário e endereço.
  const order = await call(page, 'GET', `/api/v1/orders/${silvia.order.id}`);
  const os = await call(page, 'POST', '/api/v1/service-orders', {
    orderId: silvia.order.id,
    items: [
      {
        orderItemId: order.items[0].id,
        quantity: 6,
        description: 'Cadeiras de jantar',
        serviceType: 'TROCA_DE_TECIDO',
        fabricName: 'Linho cru',
      },
    ],
  });
  await pp.goto(`/painel/os/${os.id}`);
  await expect(pp.getByTestId('os-on-site')).toBeVisible();
  await shot(pp, '6-os-no-local');

  // 7. Celular do André: a parada "No local" com o botão do serviço.
  await setPin(page, 'André', '640218');
  const code = await registerDevice(page, 'Celular do André', 'André');
  const phone = await openTablet(
    browser,
    code,
    '640218',
    { width: 390, height: 844, isMobile: true },
    { deviceScaleFactor: 3, timezoneId: TZ },
  );
  await expect(phone.page.getByText('No local').first()).toBeVisible();
  await shot(phone.page, '7-celular-no-local', true);
});
