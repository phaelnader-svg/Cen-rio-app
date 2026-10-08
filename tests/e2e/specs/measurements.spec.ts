import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Fase 3 — medições e solicitações de materiais, com dados fictícios.
 * A OS de partida é criada pela API (o fluxo comercial já é coberto pela Fase 2).
 */
const origin = `http://localhost:${E2E.webPort}`;

async function post(page: Page, path: string, data: unknown) {
  const r = await page.request.post(path, {
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.status(), `${path}: ${await r.text()}`).toBe(201);
  return r.json();
}

/** Cliente → pedido → recebimento → OS aberta (sofá + poltronas). */
async function openServiceOrder(page: Page, name: string) {
  const customer = await post(page, '/api/v1/customers', {
    kind: 'PF',
    name,
    phone: null,
    allowSimilar: true,
    addresses: [
      {
        label: 'Residência',
        street: 'Rua Fictícia de Teste',
        number: '10',
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
    agreedValueCents: 100000,
    paymentTerms: 'À vista',
    items: [
      { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
      { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
    ],
  });
  await post(page, '/api/v1/receipts', {
    orderId: order.id,
    pickupId: null,
    origin: 'ENTREGUE_PELO_CLIENTE',
    lines: order.items.map((i: { id: string; quantity: number }) => ({
      orderItemId: i.id,
      quantity: i.quantity,
      condition: 'BOA',
      location: 'Área de recebimento',
    })),
  });
  return post(page, '/api/v1/service-orders', {
    orderId: order.id,
    items: [
      {
        orderItemId: order.items[0].id,
        quantity: 1,
        description: 'Sofá 3 lugares',
        serviceType: 'REFORMA_COMPLETA',
      },
      {
        orderItemId: order.items[1].id,
        quantity: 2,
        description: 'Poltronas',
        serviceType: 'TROCA_DE_TECIDO',
      },
    ],
  }) as Promise<{ id: string; code: string; items: { id: string; code: string }[] }>;
}

test.describe.serial('Fase 3 — medições e solicitações de materiais', () => {
  test('gestor delega a Ricardo, tablet mede e envia, gestor devolve, Ricardo corrige, gestor aprova', async ({
    page,
    browser,
  }) => {
    await loginAdmin(page);
    const so = await openServiceOrder(page, 'Cliente Medição E2E');

    // Ricardo recebe a autorização para executar medições atribuídas.
    await page.goto('/painel/funcionarios');
    await page.getByTestId('employee-Ricardo').getByRole('button', { name: 'Editar' }).click();
    await page.getByLabel('Executar medições atribuídas').check();
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await setPin(page, 'Ricardo', '482915');
    const code = await registerDevice(page, 'Tablet Ricardo (medição)', 'Ricardo');
    const tablet = await openTablet(browser, code, '482915');
    const t = tablet.page;
    await expect(t.getByTestId('measurements-count')).toHaveText('0');

    // Peças aguardando medição → medição extraordinária delegada.
    await page.goto('/painel/medicoes');
    await expect(page.getByTestId(`awaiting-${so.items[0]!.code}`)).toBeVisible();
    await page
      .getByTestId(`awaiting-${so.items[0]!.code}`)
      .getByRole('button', { name: 'Solicitar medição' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Extraordinária', { exact: true }).click();
    await dialog.getByLabel('Responsável').selectOption({ label: 'Ricardo — Tapeceiro' });
    await dialog.getByLabel('Prazo').fill('2030-01-15');
    await dialog.getByLabel('Motivo').fill('Cliente com urgência');
    await dialog.getByRole('button', { name: 'Atribuir medição' }).click();
    await expect(
      page.getByRole('heading', { name: new RegExp(`^MD-\\d{5} · ${so.code}$`) }),
    ).toBeVisible();
    const detailUrl = page.url();

    // Aparece no tablet sem recarregar.
    await expect(t.getByTestId('measurements-count')).toHaveText('1');
    await t.getByTestId('tile-measurements').click();
    await t.getByRole('button', { name: new RegExp(so.code) }).click();
    await expect(t.getByText('Cliente com urgência')).toBeVisible();
    await expect(t.getByText(/R\$|1\.000,00/)).toHaveCount(0);
    await t.getByRole('button', { name: 'Começar medição' }).click();

    // Etapa 1: medidas da peça.
    const piece = so.items[0]!.code;
    await t.getByLabel(`Largura de ${piece} em cm`).fill('205,5');
    await t.getByLabel(`Profundidade de ${piece} em cm`).fill('90');
    await t.getByLabel(`Altura de ${piece} em cm`).fill('85');
    await t.getByRole('button', { name: 'Próximo' }).click();

    // Etapa 2: tecido.
    await t.getByRole('button', { name: 'Adicionar tecido' }).click();
    await t.getByLabel('Tecido (nome ou referência)').fill('Linho');
    await t.getByLabel('Cor').fill('Bege');
    await t.getByLabel('Metragem (m)').fill('11,5');
    await t.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(t.getByTestId('material-items')).toContainText('11,5 metros');
    await t.getByRole('button', { name: 'Salvar rascunho' }).click();
    await expect(t.getByText('Rascunho salvo.')).toBeVisible();
    await t.getByRole('button', { name: 'Próximo' }).click();

    // Etapa 3: espuma (densidade obrigatória).
    await t.getByRole('button', { name: 'Adicionar espuma' }).click();
    await t.getByLabel('Espessura (cm)').fill('3');
    await t.getByLabel('Quantidade').fill('2');
    await t.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(t.getByText(/Informe o tipo\/densidade/)).toBeVisible();
    await t.getByLabel('Tipo / densidade').fill('D28');
    await t.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await t.getByRole('button', { name: 'Próximo' }).click();
    await t.getByRole('button', { name: 'Próximo' }).click();

    // Revisar e enviar.
    await expect(t.getByTestId('review-pieces')).toContainText('Largura 205,5 cm');
    await expect(t.getByTestId('os-totals')).toContainText('Linho Bege');
    await t.getByRole('button', { name: 'Enviar medição' }).click();
    await expect(t.getByText('Medição enviada ao gestor.')).toBeVisible();
    await expect(t.getByTestId('my-sent-measurements')).toContainText('Enviada');

    // O painel vê o envio em tempo real (sem recarregar).
    await page.goto('/painel/medicoes');
    await page.getByRole('tab', { name: /Aguardando revisão/ }).click();
    await expect(page.getByTestId('measurement-list')).toContainText(so.code);
    await page.goto(detailUrl);
    await expect(page.getByTestId('measurement-badges')).toContainText('Materiais: enviada');
    await expect(page.getByTestId('measured-pieces')).toContainText('205,5 cm');

    // Revisão → devolução com motivo.
    await page.getByRole('button', { name: 'Iniciar revisão' }).click();
    await expect(page.getByTestId('measurement-badges')).toContainText('em revisão');
    await page.getByRole('button', { name: 'Devolver para correção' }).click();
    await page.getByLabel('O que precisa ser corrigido').fill('Conferir metragem do tecido');
    await page.getByRole('button', { name: 'Devolver', exact: true }).click();
    await expect(page.getByText('Solicitação devolvida ao responsável.')).toBeVisible();

    // Tablet: devolvida em destaque, com motivo; Ricardo corrige e reenvia.
    await expect(t.getByTestId('my-measurements')).toContainText('Devolvida — corrigir e reenviar');
    await t
      .getByRole('button', { name: new RegExp(so.code) })
      .first()
      .click();
    await expect(t.getByText('Conferir metragem do tecido')).toBeVisible();
    await t.getByRole('button', { name: 'Corrigir medição' }).click();
    await t.getByRole('button', { name: /^2 Tecidos/ }).click();
    await t.getByRole('button', { name: 'Editar Linho' }).click();
    await t.getByLabel('Metragem (m)').fill('12');
    await t.getByRole('button', { name: 'Salvar material' }).click();
    await t.getByRole('button', { name: /Revisar e enviar/ }).click();
    await t.getByRole('button', { name: 'Reenviar ao gestor' }).click();
    await expect(t.getByText('Medição enviada ao gestor.')).toBeVisible();

    // Gestor revisa e aprova; o histórico preserva tudo.
    await expect(page.getByTestId('measurement-badges')).toContainText('Materiais: enviada');
    await page.getByRole('button', { name: 'Iniciar revisão' }).click();
    await page.getByRole('button', { name: 'Aprovar para compra' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Aprovar' }).click();
    await expect(page.getByText('Quantidades conferidas e aprovadas para compra')).toBeVisible();
    await expect(page.getByTestId('measurement-history')).toContainText('Devolvida para correção');
    await expect(page.getByTestId('measurement-history')).toContainText('Corrigida e reenviada');
    await expect(t.getByTestId('my-sent-measurements')).toContainText('Aprovada para compra');

    // Lista consolidada e CSV.
    await page.goto('/painel/materiais');
    await expect(page.getByTestId('consolidated-TECIDO')).toContainText('Linho Bege');
    await expect(page.getByTestId('consolidated-TECIDO')).toContainText(`Exclusivo ${so.code}`);
    await expect(page.getByTestId('consolidated-TECIDO')).toContainText('12 metros');
    await expect(page.getByTestId('consolidated-ESPUMA')).toContainText('D28');
    const csv = await page.request.get('/api/v1/materials/consolidated.csv');
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(`Linho Bege;12;metros;${so.code}`);

    // Planejamento de sexta: compra e recebimento vêm de registros reais (Fase 4) — nada comprado ainda.
    await page.goto('/painel/planejamento');
    await expect(page.getByTestId('check-purchase')).toHaveAttribute('data-state', 'pending');
    await expect(page.getByTestId('check-purchase')).toContainText('a comprar');

    // OS mostra o material como aprovado (não como comprado).
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('tab', { name: /Materiais/ }).click();
    await expect(page.getByTestId('materials')).toContainText('Aprovado para compra');
    await tablet.context.close();
  });

  test('rotina de sexta: o gestor mede pelo painel', async ({ page }) => {
    await loginAdmin(page);
    const so = await openServiceOrder(page, 'Cliente Rotina E2E');
    await page.goto(`/painel/os/${so.id}`);
    await page.getByRole('button', { name: 'Solicitar medição' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Responsável')).toHaveValue(/.+/);
    await expect(dialog.getByLabel('Prazo')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await dialog.getByRole('button', { name: 'Atribuir medição' }).click();
    await page.getByRole('button', { name: 'Medir agora' }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Adicionar outro material' }).click();
    await page.getByLabel('Descrição').fill('Grampos 80/10');
    await page.getByLabel('Quantidade').fill('1,5');
    await page.getByLabel('Unidade').selectOption({ label: 'embalagens' });
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(page.getByText(/número inteiro/)).toBeVisible();
    await page.getByLabel('Quantidade').fill('2');
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await page.getByRole('button', { name: 'Próximo' }).click();
    await page.getByRole('button', { name: 'Enviar medição' }).click();
    await expect(page.getByTestId('measurement-badges')).toContainText('Concluída');
    await expect(page.getByTestId('measurement-badges')).toContainText('Materiais: enviada');
  });
});
