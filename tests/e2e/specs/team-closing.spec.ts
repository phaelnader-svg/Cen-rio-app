import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder, post } from './os-helpers';

/**
 * Evolução, Fase 7 — fechamento semanal geral (dados fictícios; nenhum Pix real).
 * Gestor: confere a semana (tapeçaria + logística), registra Pix feito fora do sistema,
 * reabre, estorna e consulta o histórico — desktop e celular. Ricardo, André e Thiago (sem
 * permissão) não acessam o fechamento geral.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const monday = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const WEEK = monday(today());
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/evolucao-fase-7/${name}.png`, fullPage: true })
    : Promise.resolve();

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}
type Row = {
  beneficiary: { userId: string | null; displayName: string };
  category: string;
  dueCents: number;
  openAtEndCents: number;
  currentOpenCents: number;
  paidInWeekCents: number;
};

test.describe.serial('Evolução Fase 7 — fechamento semanal geral', () => {
  test('conferir, registrar Pix, reabrir, estornar; celular; sem acesso para tablets e logística', async ({
    page,
    browser,
  }) => {
    test.setTimeout(360_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const people = (await call(page, 'GET', '/api/v1/finance/people')) as {
      userId: string;
      displayName: string;
    }[];
    const who = (n: string) => people.find((p) => p.displayName.startsWith(n))!;
    const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
    const ANDRE = (defaults.people as { userId: string; displayName: string }[]).find((p) =>
      p.displayName.startsWith('André'),
    )!;
    const RIC = who('Ricardo');
    const MAR = who('Márcio');
    await call(page, 'PUT', '/api/v1/finance/logistics-defaults', {
      defaultPickupCostCents: 10000,
      defaultDeliveryCostCents: 10000,
      logisticsPayeeUserId: ANDRE.userId,
    });

    // ── Dados: duas peças liberadas (Ricardo R$ 700, Márcio R$ 800) e duas retiradas do André ──
    const so = await openServiceOrder(page, 'Cliente Fechamento E2E');
    const items = so.items as { id: string }[];
    for (const [it, u] of [
      [items[0]!, RIC],
      [items[1]!, MAR],
    ] as const)
      await call(page, 'PUT', `/api/v1/service-order-items/${it.id}/upholsterer`, {
        userId: u.userId,
        expectedUserId: null,
      });
    await call(page, 'POST', '/api/v1/finance/labor', {
      professionalUserId: RIC.userId,
      serviceOrderId: so.id,
      serviceOrderItemId: items[0]!.id,
      service: 'Sofá',
      agreedCents: 70000,
      eligibility: 'QUALIDADE_APROVADA',
    });
    await call(page, 'POST', '/api/v1/finance/labor', {
      professionalUserId: MAR.userId,
      serviceOrderId: so.id,
      serviceOrderItemId: items[1]!.id,
      service: 'Poltronas',
      agreedCents: 80000,
      eligibility: 'QUALIDADE_APROVADA',
    });
    // Aprovação de qualidade (atalho de dados no banco E2E) + leitura que recalcula a liberação.
    const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
    await db.connect();
    await db.query(
      `UPDATE service_order_items SET fulfillment_stage = 'AGUARDANDO_EMBALAGEM' WHERE id = ANY($1::uuid[])`,
      [items.map((i) => i.id)],
    );
    await db.end();
    await call(page, 'GET', '/api/v1/finance/labor');
    for (let i = 0; i < 2; i++) {
      const customer = await post(page, '/api/v1/customers', {
        kind: 'PF',
        name: `Cliente Retirada Fechamento ${i}`,
        phone: null,
        allowSimilar: true,
        addresses: [
          {
            label: 'Casa',
            street: 'Rua Teste',
            number: String(30 + i),
            district: 'Centro',
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
        agreedValueCents: 50000,
        paymentTerms: 'À vista',
        items: [{ pieceType: 'POLTRONA', description: 'Poltrona', quantity: 1 }],
      });
      const pk = await post(page, '/api/v1/pickups', {
        orderId: order.id,
        scheduledDate: today(),
        team: 'LOGISTICA_TERCEIRIZADA',
        items: [{ orderItemId: order.items[0].id, quantity: 1 }],
        tripCost: { amountCents: 10000, participantUserIds: [ANDRE.userId] },
      });
      for (const toStatus of ['EM_EXECUCAO', 'RETIRADA_REALIZADA']) {
        const cur = await call(page, 'GET', `/api/v1/pickups/${pk.id}`);
        await call(page, 'POST', `/api/v1/pickups/${pk.id}/transition`, {
          toStatus,
          version: cur.version,
        });
      }
    }
    const before = (await call(page, 'GET', `/api/v1/finance/weekly-closings/${WEEK}`)) as {
      rows: Row[];
      pendencies: { kind: string; blocking: boolean; ref: { kind: string; id: string } | null }[];
      version: number;
      status: string;
    };
    const row = (d: { rows: Row[] }, n: string) =>
      d.rows.find((r) => r.beneficiary.displayName.startsWith(n))!;
    expect(row(before, 'Ricardo').dueCents).toBeGreaterThanOrEqual(70000);
    expect(row(before, 'André').category).toBe('LOGISTICA');
    const andreOpen = row(before, 'André').currentOpenCents;

    // ── Tela (desktop): linhas, pendências que bloqueiam a conferência ──
    await page.goto('/painel/financeiro');
    await page.getByRole('tab', { name: 'Fechamento semanal' }).click();
    const closing = page.getByTestId('weekly-closing');
    await expect(closing.getByTestId('closing-rows')).toContainText(RIC.displayName);
    await expect(closing.getByTestId('closing-rows')).toContainText(MAR.displayName);
    await expect(closing.getByTestId('closing-rows')).toContainText(ANDRE.displayName);
    await expect(closing.getByTestId('closing-totals')).toContainText('Previsto (não pagável)');
    await evidence(page, '01-fechamento-semana');
    // Pendências de outras etapas da suíte (retirada realizada sem custo): resolução explícita.
    for (const p of before.pendencies.filter((x) => x.blocking)) {
      expect(p.kind).toBe('CUSTO_NAO_INFORMADO');
      await call(page, 'POST', '/api/v1/finance/trip-costs/free', {
        [p.ref!.kind === 'pickup' ? 'pickupId' : 'deliveryId']: p.ref!.id,
        reason: 'Viagem de teste sem custo (E2E)',
      });
    }
    await page.reload();
    await page.getByRole('tab', { name: 'Fechamento semanal' }).click();

    // ── Registrar Pix do André (revisar → confirmar) ──
    await page
      .getByTestId(`closing-row-${ANDRE.displayName}-LOGISTICA`)
      .getByTestId('closing-pay')
      .click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('closing-pay-amount').fill('100,00');
    await dlg.getByTestId('closing-pay-review').click();
    await expect(dlg.getByTestId('closing-pay-summary')).toContainText('R$ 100,00');
    await evidence(page, '02-registrar-pix-revisao');
    await dlg.getByTestId('closing-pay-confirm').click();
    await expect(page.getByTestId('closing-payments')).toContainText(/PF-\d{5}/);
    const afterPay = (await call(page, 'GET', `/api/v1/finance/weekly-closings/${WEEK}`)) as {
      rows: Row[];
      version: number;
    };
    expect(row(afterPay, 'André').currentOpenCents).toBe(andreOpen - 10000);

    // ── Conferir, reabrir, estornar; histórico ──
    await page.getByTestId('closing-confirm').click();
    await page.getByRole('dialog').getByLabel('Observação').fill('Conferido no E2E');
    await page.getByRole('dialog').getByRole('button', { name: 'Conferir' }).click();
    await expect(page.getByTestId('closing-status')).toContainText('Conferido');
    await evidence(page, '03-semana-conferida');
    await page.getByRole('button', { name: 'Reabrir' }).click();
    await page.getByRole('dialog').getByLabel('Motivo').fill('Conferir de novo após estorno');
    await page.getByRole('dialog').getByRole('button', { name: 'Reabrir' }).click();
    await expect(page.getByTestId('closing-status')).toContainText('Reaberto');
    await page
      .getByTestId('closing-payments')
      .getByRole('button', { name: 'Estornar' })
      .first()
      .click();
    await page.getByRole('dialog').getByLabel('Motivo do estorno').fill('Pix devolvido (E2E)');
    await page.getByRole('dialog').getByRole('button', { name: 'Estornar' }).click();
    await expect(page.getByTestId('closing-payments')).toContainText('Estornado');
    await expect(page.getByTestId('closing-history')).toContainText('CONFERIDO');
    await expect(page.getByTestId('closing-history')).toContainText('REABERTO');
    await expect(page.getByTestId('closing-history')).toContainText('ESTORNO');
    const end = (await call(page, 'GET', `/api/v1/finance/weekly-closings/${WEEK}`)) as {
      rows: Row[];
    };
    expect(row(end, 'André').currentOpenCents).toBe(andreOpen);
    await evidence(page, '04-reaberto-estornado-historico');

    // ── Celular (390×844): mesma tela utilizável ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole('tab', { name: 'Fechamento semanal' }).click();
    await expect(page.getByTestId('closing-rows')).toBeVisible();
    await expect(page.getByTestId('closing-totals')).toBeVisible();
    await evidence(page, '05-fechamento-celular');

    // ── Sem acesso: tablet do Ricardo, celular do André, tablet do Thiago ──
    const tablet = async (
      name: string,
      pin: string,
      device?: { width: number; height: number; isMobile?: boolean },
    ) => {
      await setPin(page, name, pin);
      return openTablet(
        browser,
        await registerDevice(page, `Aparelho ${name} (F7)`, name),
        pin,
        device,
      );
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [name, pin] of [
      [RIC.displayName, '482915'],
      [ANDRE.displayName, '640218'],
      [who('Thiago')?.displayName ?? 'Thiago', '271828'],
    ] as const) {
      const t = await tablet(name, pin, { width: 820, height: 1180 });
      for (const path of [
        `/api/v1/finance/weekly-closings/${WEEK}`,
        `/api/v1/finance/weekly-closings/${WEEK}?format=csv`,
        '/api/v1/finance/weekly-closings',
      ])
        expect((await t.page.request.get(path)).status(), `${name} ${path}`).toBe(403);
      const pay = await t.page.request.post(`/api/v1/finance/weekly-closings/${WEEK}/payments`, {
        data: {
          beneficiaryUserId: ANDRE.userId,
          category: 'LOGISTICA',
          amountCents: 100,
          paidAt: today(),
          method: 'PIX',
        },
        headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
      });
      expect(pay.status()).toBe(403);
      await t.context.close();
    }
  });
});
