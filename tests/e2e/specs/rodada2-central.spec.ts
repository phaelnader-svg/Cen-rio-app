import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { post } from './os-helpers';

/**
 * Remediação pós-auditoria, Rodada 2 — no navegador: o Meus Ganhos aberto no celular do André se
 * atualiza sozinho quando o valor dele muda (F8-15b); a Central mostra "aguardando confirmação"
 * e, depois da conferência no celular, "pagamento liberado", com o link abrindo o Fechamento na
 * semana e no profissional certos (F10-11/F10-12); o Início mostra "Entregues hoje" e "Pago na
 * semana" (F10-21m/s); o painel de avisos separa ativos e resolvidos (F10-19). Dados fictícios.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const mondayOf = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
const WEEK = mondayOf(today());

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('Rodada 2 — Central derivada, Meus Ganhos ao vivo e indicadores', () => {
  test('valor muda → celular atualiza sozinho; Central: confirmação → pagamento; links; Início; avisos', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
    const ANDRE = (defaults.people as { userId: string; displayName: string }[]).find((p) =>
      p.displayName.startsWith('André'),
    )!;
    await call(page, 'PUT', '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: null,
      defaultDeliveryCostCents: null,
      logisticsPayeeUserId: ANDRE.userId,
    });

    // ── Retirada realizada com custo de R$ 100,00 (devido ao André nesta semana) ──
    const customer = await post(page, '/api/v1/customers', {
      kind: 'PF',
      name: 'Cliente Rodada 2 E2E',
      phone: null,
      allowSimilar: true,
      addresses: [
        {
          label: 'Residência',
          street: 'Rua Fictícia da Rodada',
          number: '2',
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
    const pickup = await post(page, '/api/v1/pickups', {
      orderId: order.id,
      scheduledDate: today(),
      windowStart: '09:00',
      windowEnd: '12:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    });
    await call(page, 'PUT', '/api/v1/finance/trip-costs', {
      pickupId: pickup.id,
      amountCents: 10000,
    });
    for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
      const cur = await call(page, 'GET', `/api/v1/pickups/${pickup.id}`);
      await call(page, 'POST', `/api/v1/pickups/${pickup.id}/transition`, {
        toStatus,
        version: cur.version,
      });
    }
    const tripCost = async () =>
      (await call(page, 'GET', `/api/v1/finance/trip-costs?pickupId=${pickup.id}`)).cost as {
        id: string;
        code: string;
        version: number;
        dueCents: number;
      };
    const cost = await tripCost();
    expect(cost.dueCents).toBe(10000);

    // ── André (celular): Meus Ganhos aberto com o PIN ──
    await setPin(page, ANDRE.displayName, '640218');
    const a = await openTablet(
      browser,
      await registerDevice(page, 'Celular André (Rodada 2)', ANDRE.displayName),
      '640218',
      { width: 390, height: 844, isMobile: true },
    );
    const at = a.page;
    await at.getByTestId('tile-values').click();
    await at.getByTestId('my-values-pin').fill('640218');
    await at.getByTestId('my-values-unlock').click();
    await expect(at.getByTestId('my-values')).toBeVisible();
    await expect(at.getByTestId(`my-value-${cost.code}`)).toContainText('R$ 100,00');

    // ── F8-15b: o gestor ajusta o valor; o celular mostra o novo valor sem recarregar ──
    await call(page, 'POST', `/api/v1/finance/logistics-costs/${cost.id}/adjustments`, {
      amountCents: 2000,
      reason: 'Pedágio combinado depois da viagem',
      version: cost.version,
    });
    await expect(at.getByTestId(`my-value-${cost.code}`)).toContainText('R$ 120,00', {
      timeout: 15_000,
    });

    // ── F10-11: Central → "aguardando confirmação" do André; o link abre o Fechamento certo ──
    await page.goto('/painel/atencao?type=FINANCEIRO');
    const confirmCard = page.getByTestId(`attention-FINANCEIRO:confirmacao:${ANDRE.userId}`);
    await expect(confirmCard).toBeVisible();
    await expect(confirmCard).toContainText('aguardando confirmação');
    await expect(confirmCard).not.toContainText('R$');
    await confirmCard.getByRole('link', { name: /Abrir/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`tab=fechamento&semana=${WEEK}&profissional=${ANDRE.userId}`),
    );
    await expect(page.getByTestId('closing-week')).toHaveValue(WEEK);
    await expect(page.getByTestId(`closing-row-${ANDRE.displayName}-LOGISTICA`)).toBeVisible();

    // ── André confere a semana no celular ──
    await at.getByTestId('week-confirm-open').click();
    await expect(at.getByTestId('week-confirm-panel')).toContainText(cost.code);
    await at.getByTestId('week-confirm-check').check();
    await at.getByTestId('week-confirm-submit').click();
    await expect(at.getByTestId('week-confirmation-state')).toHaveText(
      'Confirmada pelo profissional',
    );
    await a.context.close();

    // ── F10-12: confirmação some; "pagamento liberado" aparece com o link do Fechamento ──
    await page.goto('/painel/atencao?type=FINANCEIRO');
    await expect(page.getByTestId(`attention-FINANCEIRO:confirmacao:${ANDRE.userId}`)).toHaveCount(
      0,
    );
    const payCard = page.getByTestId(`attention-FINANCEIRO:pagamento:${ANDRE.userId}`);
    await expect(payCard).toBeVisible();
    await expect(payCard).toContainText('liberado(s) para pagar');
    await expect(payCard).not.toContainText('R$');
    await payCard.getByRole('link', { name: /Abrir/ }).click();
    await expect(page).toHaveURL(new RegExp(`semana=${WEEK}&profissional=${ANDRE.userId}`));

    // ── F10-21m/s: Início com "Entregues hoje" e "Pago na semana" (mesma fonte do Fechamento) ──
    const paidBefore = (await call(page, 'GET', `/api/v1/finance/weekly-closings/${WEEK}`)).totals
      .paidInWeekCents as number;
    await page.goto('/painel');
    await expect(page.getByTestId('dl-delivered')).toBeVisible();
    await expect(page.getByTestId('fin-paid')).toBeVisible();
    const shown = (await page.getByTestId('fin-paid').textContent()) ?? '';
    expect(Number(shown.replace(/\D/g, ''))).toBe(paidBefore);
    const overview = await call(page, 'GET', '/api/v1/management/overview');
    expect(overview.finance.paid).toEqual({ weekStart: WEEK, paidInWeekCents: paidBefore });

    // ── F10-19: avisos ativos × resolvidos no painel ──
    await page.getByTestId('panel-notifications').click();
    await page.getByTestId('panel-notifications-toggle').click();
    await expect(page.getByRole('button', { name: 'Ver avisos ativos' })).toBeVisible();
    await page.getByTestId('panel-notifications-toggle').click();
    await expect(page.getByRole('button', { name: 'Ver resolvidos' })).toBeVisible();
  });
});
