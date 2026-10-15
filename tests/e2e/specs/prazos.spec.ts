import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Prazos e serviços em risco no navegador (dados fictícios):
 *  1. Início: cartão "Prazos" com as MESMAS contagens da Central (mesma rota/regra).
 *  2. O cartão abre a Central filtrada no tipo "Prazo da OS"; a OS atrasada está lá.
 *  3. Pedido: "Alterar prazo" com motivo e a pergunta explícita "Aplicar … às OS abertas?";
 *     com SIM a OS deixa de estar atrasada, o histórico aparece e a contagem cai.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
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
  items: { key: string; title: string; serviceOrder: { id: string; code: string } | null }[];
};

test.describe.serial('Prazos e serviços em risco', () => {
  test('Início → Central filtrada → alterar prazo do pedido (SIM às OS) → contagens atualizadas', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);

    // Serviço com prazo vencido (ontem) cuja peça chegou: OS automática ATRASADA.
    const svc = await call(page, 'POST', '/api/v1/services', {
      customer: { mode: 'NOVO', kind: 'PF', name: 'Cliente Prazo E2E', phone: '(11) 93210-4455' },
      service: {
        contractedService: 'Reforma',
        promisedDate: shift(today(), -1),
        items: [
          {
            pieceType: 'SOFA',
            description: 'Sofá do prazo',
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
    const soCode = rec.generatedServiceOrder.code as string;

    // 1. Início: mesmas contagens da Central (tipo Prazo da OS).
    const before = (await call(page, 'GET', '/api/v1/attention?type=PRAZO_OS')) as Attention;
    expect(before.items.some((i) => i.serviceOrder?.id === soId)).toBe(true);
    await page.goto('/painel');
    const card = page.getByTestId('dashboard-deadlines');
    await expect(card.getByTestId('dashboard-deadlines-late')).toHaveText(
      String(before.counts.CRITICO),
    );
    await expect(card.getByTestId('dashboard-deadlines-risk')).toHaveText(
      String(before.counts.ACAO),
    );

    // 2. O cartão abre a Central filtrada; a OS atrasada aparece com o rótulo.
    await card.click();
    await expect(page).toHaveURL(/\/painel\/atencao\?type=PRAZO_OS$/);
    await expect(page.getByText(`${soCode} · Cliente Prazo E2E — ATRASADO`)).toBeVisible();

    // Detalhe da OS: rótulo vindo da API.
    await page.goto(`/painel/os/${soId}`);
    await expect(page.getByTestId('deadline-state')).toContainText('Atrasado');

    // 3. Pedido: alterar o prazo com motivo e SIM para as OS abertas.
    await page.goto(`/painel/pedidos/${order.id}`);
    await page.getByTestId('order-promised-edit').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('order-promised-date').fill(shift(today(), 30));
    await dlg.getByTestId('order-promised-reason').fill('Cliente pediu para entregar depois');
    await expect(
      dlg.getByText('Aplicar este novo prazo também às OS abertas deste pedido?'),
    ).toBeVisible();
    // Sem resposta explícita não salva.
    await expect(dlg.getByTestId('order-promised-save')).toBeDisabled();
    await dlg.getByTestId('order-promised-apply-SIM').check();
    await dlg.getByTestId('order-promised-save').click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId('order-promised-history')).toContainText(
      'Cliente pediu para entregar depois',
    );
    await expect(page.getByTestId('order-promised-history')).toContainText(soCode);

    // A OS deixou de estar atrasada (sem rótulo: no prazo) e saiu da Central.
    await page.goto(`/painel/os/${soId}`);
    await expect(page.getByTestId('deadline-state')).toHaveCount(0);
    const after = (await call(page, 'GET', '/api/v1/attention?type=PRAZO_OS')) as Attention;
    expect(after.items.some((i) => i.serviceOrder?.id === soId)).toBe(false);
    expect(after.counts.CRITICO).toBe((before.counts.CRITICO ?? 0) - 1);
    await page.goto('/painel');
    await expect(page.getByTestId('dashboard-deadlines-late')).toHaveText(
      String(after.counts.CRITICO),
    );
  });
});
