import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { post } from './os-helpers';

/**
 * Evolução, Fase 6 — custos de retirada e entrega (dados fictícios; nenhum pagamento real).
 * Gestor configura os padrões e o recebedor (André), agenda a retirada com o custo total
 * (André + Izaías = R$ 100,00, não R$ 200,00), a viagem é realizada, a obrigação nasce uma vez,
 * é paga em parte, estornada, ajustada e conciliada. André não acessa o financeiro.
 */
const origin = `http://localhost:${E2E.webPort}`;
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/evolucao-fase-6/${name}.png`, fullPage: true })
    : Promise.resolve();
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const plus = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('Evolução Fase 6 — custos de retirada e entrega', () => {
  test('padrões → agendar com custo total → realizar → obrigação única → pagar, estornar, ajustar, conciliar', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
    const who = (n: string) =>
      (defaults.people as { userId: string; displayName: string }[]).find((p) =>
        p.displayName.startsWith(n),
      )!;
    const ANDRE = who('André');
    const IZAIAS = who('Izaías');

    // ── Padrões e recebedor (aba Custos do financeiro) ──
    await page.goto('/painel/financeiro');
    await page.getByRole('tab', { name: 'Custos e resultado por OS' }).click();
    const panel = page.getByTestId('logistics-defaults');
    await panel.getByTestId('logistics-defaults-edit').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Padrão de retirada (R$)').fill('80,00');
    await dlg.getByLabel('Padrão de entrega (R$)').fill('120,00');
    await dlg.getByLabel('Recebedor único da logística').selectOption(ANDRE.userId);
    await dlg.getByRole('button', { name: 'Salvar' }).click();
    await expect(panel).toContainText('R$ 80,00');
    await expect(panel).toContainText(`Recebedor: ${ANDRE.displayName}`);
    await evidence(page, '01-padroes-e-recebedor');

    // ── Pedido (API) e retirada agendada pela tela, com o custo total ──
    const customer = await post(page, '/api/v1/customers', {
      kind: 'PF',
      name: 'Cliente Logística E2E',
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Residência',
          street: 'Rua Fictícia de Teste',
          number: '20',
          district: 'Bairro Teste',
          city: 'Cidade Teste',
          state: 'SP',
          postalCode: '01000-000',
        },
      ],
    });
    const order = await post(page, '/api/v1/orders', {
      customerId: customer.id,
      pickupAddressId: customer.addresses[0].id,
      contractedService: 'Reforma',
      agreedValueCents: 90000,
      paymentTerms: 'À vista',
      items: [{ pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1 }],
    });
    await page.goto(`/painel/pedidos/${order.id}`);
    await page.getByRole('button', { name: 'Solicitar retirada' }).click();
    await page.getByLabel('Data combinada').fill(plus(2));
    const fields = page.getByTestId('trip-cost-fields');
    await expect(page.getByTestId('trip-cost-amount')).toHaveValue('80,00');
    await expect(fields.getByTestId('trip-payee')).toContainText(`${ANDRE.displayName} (100%)`);
    await page.getByTestId('trip-cost-amount').fill('100,00');
    await fields.getByTestId(`trip-participant-${IZAIAS.displayName}`).check();
    await evidence(page, '02-agendar-com-custo-total');
    await page.getByRole('button', { name: 'Solicitar e agendar' }).click();
    await expect(page.getByTestId('order-status')).toContainText('Retirada agendada');

    await page.getByRole('button', { name: /RT-\d{5}/ }).click();
    const detail = page.getByTestId('pickup-detail');
    const card = detail.getByTestId('trip-cost-card');
    await expect(card.getByTestId('trip-cost-total')).toHaveText('R$ 100,00');
    await expect(card).toContainText('Combinado (agendado, nada devido)');
    await expect(card).toContainText(`${ANDRE.displayName}, ${IZAIAS.displayName}`);
    await evidence(page, '03-retirada-custo-combinado');

    // ── Realização: devido uma vez, conta a pagar do André ──
    await detail.getByRole('button', { name: 'Equipe a caminho / em execução' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(detail).toContainText('Em execução');
    await expect(card).toContainText('Combinado');
    await detail.getByRole('button', { name: 'Confirmar retirada realizada' }).click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(card).toContainText('Devido (a pagar)');
    await evidence(page, '04-retirada-realizada-devido');
    const pickupId = (
      (await call(page, 'GET', `/api/v1/pickups?orderId=${order.id}`)) as { id: string }[]
    )[0]!.id;
    const view = await call(page, 'GET', `/api/v1/finance/trip-costs?pickupId=${pickupId}`);
    expect(view.cost).toMatchObject({
      status: 'DEVIDO',
      dueCents: 10000,
      payee: { userId: ANDRE.userId },
    });
    const payableCode = view.cost.payable.code as string;

    // ── Contas a pagar: parcial, estorno, quitação ──
    await page.goto('/painel/financeiro');
    await page.getByRole('tab', { name: 'Contas a pagar' }).click();
    const row = page.getByTestId(`payable-${payableCode}`);
    await expect(row).toContainText(ANDRE.displayName);
    await expect(row).toContainText('R$ 100,00');
    await row.getByRole('button', { name: 'Abrir' }).click();
    await page.getByRole('button', { name: 'Registrar pagamento' }).click();
    const payDlg = page.getByRole('dialog').last();
    await payDlg.getByLabel('Valor pago (R$)').fill('40,00');
    await payDlg.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByTestId('payable-paid')).toHaveText('R$ 40,00');
    await page.getByRole('button', { name: 'Estornar' }).click();
    const revDlg = page.getByRole('dialog').last();
    await revDlg.getByLabel('Motivo do estorno').fill('PIX devolvido (teste)');
    await revDlg.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByTestId('payable-paid')).toHaveText('R$ 0,00');
    await expect(page.getByText('estornado: PIX devolvido (teste)')).toBeVisible();
    await evidence(page, '05-pagamento-estornado');

    // ── Ajuste auditável (R$ 100 → R$ 90) e quitação ──
    const cost = (await call(page, 'GET', `/api/v1/finance/trip-costs?pickupId=${pickupId}`)).cost;
    const adj = await call(page, 'POST', `/api/v1/finance/logistics-costs/${cost.id}/adjustments`, {
      amountCents: -1000,
      reason: 'Combinado corrigido com o André',
      version: cost.version,
    });
    expect(adj).toMatchObject({ dueCents: 9000, adjustmentsCents: -1000 });
    const payable = await call(page, 'GET', `/api/v1/finance/payables/${cost.payable.id}`);
    expect(payable).toMatchObject({ amountCents: 9000, paidCents: 0, status: 'ABERTO' });
    const paid = await call(page, 'POST', `/api/v1/finance/payables/${payable.id}/payments`, {
      amountCents: 9000,
      paidAt: today(),
      method: 'PIX',
      version: payable.version,
    });
    expect(paid).toMatchObject({ status: 'PAGO', paidCents: 9000, openCents: 0 });

    // ── Conciliação: base semanal (Fase 7) e uma única obrigação ──
    const w = await call(
      page,
      'GET',
      `/api/v1/finance/logistics-weekly?from=${plus(-7)}&to=${plus(7)}&payeeUserId=${ANDRE.userId}`,
    );
    const item = (
      w.items as { code: string; dueCents: number; paidCents: number; openCents: number }[]
    ).find((i) => i.code === cost.code)!;
    expect(item).toMatchObject({ dueCents: 9000, paidCents: 9000, openCents: 0 });
    const trip = await call(page, 'GET', `/api/v1/finance/trip-costs?pickupId=${pickupId}`);
    expect(trip.cost.situation).toBe('PAGO');
    expect(trip.fees).toEqual([]);

    // ── André: executa, mas não acessa o financeiro ──
    await setPin(page, ANDRE.displayName, '640218');
    const andre = await openTablet(
      browser,
      await registerDevice(page, 'Celular André (F6)', ANDRE.displayName),
      '640218',
      { width: 390, height: 844, isMobile: true },
    );
    for (const path of [
      `/api/v1/finance/trip-costs?pickupId=${pickupId}`,
      '/api/v1/finance/logistics-weekly?from=2026-01-01&to=2026-12-31',
      '/api/v1/finance/payables',
    ])
      expect((await andre.page.request.get(path)).status(), path).toBe(403);
    const jobs = await andre.page.request.get('/api/v1/logistics/jobs');
    expect(await jobs.text()).not.toMatch(/Cents|9000|10000/);
    await andre.context.close();
  });
});
