import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Fase 10 (plano principal) — o gestor no navegador (dados fictícios):
 *  1. Início: menu por grupos, "Serviços ativos" e a visão operacional/financeira canônica.
 *  2. Central: identifica a pendência (OS atrasada) e abre o contexto pelo link do item.
 *  3. Na OS: altera o prazo — sem motivo a API recusa; com motivo salva pelo fluxo canônico.
 *  4. A linha do tempo mostra o motivo; o item sai da Central e o Início acompanha.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}
type Attention = {
  counts: Record<string, number>;
  items: { key: string; serviceOrder: { id: string } | null }[];
};

test.describe.serial('Gestão: Início, Central e ação no contexto', () => {
  test('gestor vê, identifica a pendência, abre o contexto, age e a pendência some', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);

    const svc = await call(page, 'POST', '/api/v1/services', {
      customer: { mode: 'NOVO', kind: 'PF', name: 'Cliente Gestão E2E', phone: '(11) 93210-7788' },
      service: {
        contractedService: 'Reforma',
        promisedDate: shift(today(), -1),
        items: [
          {
            pieceType: 'SOFA',
            description: 'Sofá da gestão',
            quantity: 1,
            serviceType: 'REFORMA_COMPLETA',
          },
        ],
      },
    });
    const order = await call(page, 'GET', `/api/v1/orders/${svc.order.id}`);
    const rec = await call(page, 'POST', '/api/v1/receipts', {
      orderId: order.id,
      pickupId: null,
      origin: 'ENTREGUE_PELO_CLIENTE',
      lines: [
        { orderItemId: order.items[0].id, quantity: 1, condition: 'BOA', location: 'Recepção' },
      ],
    });
    const soId = rec.generatedServiceOrder.id as string;
    const overview = await call(page, 'GET', '/api/v1/management/overview');

    // 1. Início: grupos do menu e indicadores das fontes canônicas.
    await page.goto('/painel');
    const nav = page.getByRole('navigation');
    for (const g of ['Serviços', 'Produção', 'Financeiro', 'Administração'])
      await expect(nav.getByText(g, { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('dashboard-operations')).toBeVisible();
    await expect(page.getByTestId('ops-production')).toHaveText(
      String(overview.operations.pieces.production),
    );
    await expect(page.getByTestId('dashboard-finance')).toBeVisible();
    await expect(page.getByTestId('dashboard-deadlines-late')).toHaveText(
      String(overview.operations.deadlines.late),
    );

    // 2. Central: a OS atrasada aparece; "Abrir" leva à OS.
    await page.getByTestId('dashboard-deadlines').click();
    await expect(page).toHaveURL(/\/painel\/atencao\?type=PRAZO_OS$/);
    const item = page.getByTestId(`attention-PRAZO_OS:${soId}`);
    await expect(item).toBeVisible();
    await item.getByRole('link', { name: 'Abrir' }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/os/${soId}$`));
    await expect(page.getByTestId('deadline-state')).toContainText('Atrasado');

    // 3. Agir no contexto: sem motivo a alteração do prazo é recusada; com motivo, salva.
    await page.getByRole('button', { name: 'Editar dados gerais' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Prazo prometido').fill(shift(today(), 30));
    await dlg.getByRole('button', { name: 'Salvar' }).click();
    await expect(dlg.getByText('Informe o motivo da alteração do prazo.')).toBeVisible();
    await dlg.getByLabel('Motivo da alteração (histórico)').fill('Cliente pediu mais prazo');
    await dlg.getByRole('button', { name: 'Salvar' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId('deadline-state')).toHaveCount(0);

    // 4. A linha do tempo registra o motivo; a pendência saiu da Central e o Início acompanha.
    await page.getByRole('tab', { name: 'Linha do tempo' }).click();
    await expect(page.getByTestId('service-timeline')).toContainText('Cliente pediu mais prazo');
    const after = (await call(page, 'GET', '/api/v1/attention?type=PRAZO_OS')) as Attention;
    expect(after.items.some((i) => i.serviceOrder?.id === soId)).toBe(false);
    await page.goto('/painel/atencao?type=PRAZO_OS');
    await expect(page.getByTestId(`attention-PRAZO_OS:${soId}`)).toHaveCount(0);
    await page.goto('/painel');
    await expect(page.getByTestId('dashboard-deadlines-late')).toHaveText(
      String(after.counts.CRITICO ?? 0),
    );
  });
});
