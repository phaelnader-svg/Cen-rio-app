import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Evolução, Fase 5 — mão de obra dos tapeceiros. Painel (gestor) + tablets do Ricardo, do
 * Márcio e do João (sem permissão). Dados fictícios; nenhum pagamento real.
 * Sofá → Ricardo (R$ 320,00, combinado na tela da OS); poltronas → Márcio (R$ 450,00). O sofá
 * passa para o Márcio: revisão financeira aberta, resolvida pelo gestor (Ricardo R$ 100,00,
 * Márcio R$ 220,00). Cada um vê só os próprios valores, com PIN redigitado.
 */
const origin = `http://localhost:${E2E.webPort}`;
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/evolucao-fase-5/${name}.png`, fullPage: true })
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

async function grant(page: Page, displayName: string, permission: string) {
  const list = await call(page, 'GET', '/api/employees');
  const summary = list.find((e: { displayName: string }) => e.displayName === displayName);
  const e = await call(page, 'GET', `/api/employees/${summary.id}`);
  await call(page, 'PUT', `/api/employees/${e.id}`, {
    fullName: e.fullName,
    displayName: e.displayName,
    jobTitle: e.jobTitle,
    color: e.color,
    roleIds: e.roles.map((r: { id: string }) => r.id),
    extraPermissions: [...new Set([...e.extraPermissions, permission])],
    version: e.version,
  });
}

test.describe.serial('Evolução Fase 5 — mão de obra dos tapeceiros', () => {
  test('valor por peça na OS, substituição com revisão, resolução e "Meus valores" com PIN', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const people = (await call(page, 'GET', '/api/v1/finance/people')) as {
      userId: string;
      displayName: string;
    }[];
    const who = (n: string) => people.find((w) => w.displayName.startsWith(n))!;
    const RIC = who('Ricardo');
    const MAR = who('Márcio');
    const JOAO = who('João');
    const so = await openServiceOrder(page, 'Cliente Mão de Obra E2E');
    const [sofa, polt] = so.items as { id: string; code: string }[];
    const owner = (
      itemId: string,
      userId: string,
      expectedUserId: string | null,
      reason?: string,
    ) =>
      call(page, 'PUT', `/api/v1/service-order-items/${itemId}/upholsterer`, {
        userId,
        expectedUserId,
        reason,
        confirm: Boolean(expectedUserId),
      });
    await owner(sofa!.id, RIC.userId, null);
    await owner(polt!.id, MAR.userId, null);

    // ── Painel: aba "Mão de obra" da OS; sem valor ≠ R$ 0; combinar valor do sofá ──
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: 'Mão de obra' }).click();
    await expect(page.getByTestId(`no-value-${sofa!.code}`)).toHaveText('Sem valor combinado.');
    await page.getByTestId(`agree-${sofa!.code}`).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Serviço').fill('Reforma completa do sofá');
    await dlg.getByLabel('Valor combinado (R$)').fill('320,00');
    await dlg.getByLabel('Liberar o pagamento quando').selectOption('PRODUCAO_CONCLUIDA');
    await dlg.getByRole('button', { name: 'Combinar' }).click();
    const pieceSofa = page.getByTestId(`os-labor-piece-${sofa!.code}`);
    await expect(pieceSofa).toContainText('R$ 320,00');
    await expect(pieceSofa).toContainText('Combinado (previsto)');
    await expect(pieceSofa).toContainText(`Titular: ${RIC.displayName}`);
    const mar = await call(page, 'POST', '/api/v1/finance/labor', {
      professionalUserId: MAR.userId,
      serviceOrderId: so.id,
      serviceOrderItemId: polt!.id,
      service: 'Troca de tecido das poltronas',
      agreedCents: 45000,
      eligibility: 'QUALIDADE_APROVADA',
    });
    await page.reload();
    await page.getByRole('tab', { name: 'Mão de obra' }).click();
    await expect(page.getByTestId(`os-labor-piece-${polt!.code}`)).toContainText('R$ 450,00');
    await evidence(page, '01-os-mao-de-obra-por-peca');

    // ── Substituição do titular do sofá → revisão financeira, nada transferido ──
    await owner(sofa!.id, MAR.userId, RIC.userId, 'Ricardo afastado (teste)');
    await page.reload();
    await page.getByRole('tab', { name: 'Mão de obra' }).click();
    await expect(page.getByText(/Revisão financeira pendente — RF-\d{5}/)).toBeVisible();
    await expect(pieceSofa).toContainText('Em revisão financeira');
    await expect(pieceSofa).toContainText(RIC.displayName); // obrigação continua do Ricardo
    await evidence(page, '02-revisao-financeira-aberta');
    const ricPay = (await call(page, 'GET', `/api/v1/finance/service-orders/${so.id}/labor`))
      .pieces[0].payables[0];
    const blocked = await page.request.post(`/api/v1/finance/labor/${ricPay.id}/adjustments`, {
      data: { amountCents: 1000, reason: 'Teste de bloqueio', version: ricPay.version },
      headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
    });
    expect(blocked.status()).toBe(422);

    // ── Resolução explícita: Ricardo R$ 100,00 + Márcio R$ 220,00, com justificativa ──
    await page.getByRole('button', { name: 'Resolver revisão' }).first().click();
    const rd = page.getByRole('dialog');
    await rd.getByTestId(`resolve-amount-${RIC.displayName}`).fill('100,00');
    await rd.getByTestId(`resolve-amount-${MAR.displayName}`).fill('220,00');
    await expect(rd.getByTestId('resolve-totals')).toContainText('R$ 320,00');
    await rd.getByTestId('resolve-reason').fill('Ricardo fez a desmontagem; Márcio termina');
    await evidence(page, '03-resolver-revisao');
    await rd.getByTestId('resolve-submit').click();
    await expect(page.getByText(/Revisão financeira pendente/)).toHaveCount(0);
    await expect(pieceSofa).toContainText('R$ 100,00');
    await expect(pieceSofa).toContainText('R$ 220,00');
    await evidence(page, '04-revisao-resolvida');

    // ── Tablets: Ricardo e Márcio autorizados (PIN a cada abertura); João sem permissão ──
    await grant(page, RIC.displayName, 'financeiro.producao_propria');
    await grant(page, MAR.displayName, 'financeiro.producao_propria');
    const tablet = async (name: string, pin: string) => {
      await setPin(page, name, pin);
      return openTablet(browser, await registerDevice(page, `Tablet ${name} (F5)`, name), pin);
    };
    const r = await tablet(RIC.displayName, '482915');
    const rt = r.page;
    expect((await rt.request.get('/api/v1/finance/my-production')).status()).toBe(403);
    await rt.getByTestId('tile-values').click();
    await expect(rt.getByTestId('my-values-lock')).toBeVisible();
    await expect(rt.getByTestId('my-values')).toHaveCount(0);
    await rt.getByTestId('my-values-pin').fill('000000');
    await rt.getByTestId('my-values-unlock').click();
    await expect(rt.getByRole('alert').filter({ hasText: 'PIN' })).toBeVisible();
    await rt.getByTestId('my-values-pin').fill('482915');
    await rt.getByTestId('my-values-unlock').click();
    const rv = rt.getByTestId('my-values');
    await expect(rv).toContainText('R$ 100,00');
    await expect(rv).not.toContainText('220,00');
    await expect(rv).not.toContainText('450,00');
    await expect(rv).not.toContainText(MAR.displayName);
    await evidence(rt, '05-tablet-ricardo-meus-valores');
    expect((await rt.request.get(`/api/v1/finance/labor/${mar.id}`)).status()).toBe(403);
    expect((await rt.request.get(`/api/v1/finance/service-orders/${so.id}/labor`)).status()).toBe(
      403,
    );
    await rt.getByTestId('my-values-hide').click();
    await expect(rt.getByTestId('my-values')).toHaveCount(0);
    await expect(rt.getByTestId('my-values-lock')).toBeVisible();
    await r.context.close();

    const m = await tablet(MAR.displayName, '736152');
    await m.page.getByTestId('tile-values').click();
    await m.page.getByTestId('my-values-pin').fill('736152');
    await m.page.getByTestId('my-values-unlock').click();
    const mv = m.page.getByTestId('my-values');
    await expect(mv).toContainText('R$ 450,00');
    await expect(mv).toContainText('R$ 220,00');
    await expect(mv).not.toContainText('100,00');
    await expect(mv).not.toContainText(RIC.displayName);
    await evidence(m.page, '06-tablet-marcio-meus-valores');
    await m.context.close();

    const j = await tablet(JOAO.displayName, '121212');
    await expect(j.page.getByTestId('tile-values')).toHaveCount(0);
    expect(
      (
        await j.page.request.post('/api/v1/finance/my-production/unlock', {
          data: { pin: '121212' },
          headers: { origin },
        })
      ).status(),
    ).toBe(403);
    await j.context.close();
  });
});
