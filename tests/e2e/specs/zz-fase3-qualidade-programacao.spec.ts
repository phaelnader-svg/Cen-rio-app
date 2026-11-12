import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Reformulação, Fase 3 — pela tela:
 *  1. o gestor que executou a peça aprova com "Tudo conforme" SÓ depois de justificar; a
 *     justificativa aparece na inspeção e a auditoria a mostra como exceção destacada;
 *  2. com a embalagem desligada, a peça aprovada fica "Pronta para entrega" (sem embalagem) e o
 *     estado geral aparece igual na lista de OS e no cabeçalho;
 *  3. programação semanal numa tela só (endereços antigos abrem a aba certa) e menu enxuto.
 * Dados fictícios. O interruptor da embalagem é religado no fim (outros specs dependem dele).
 * Prefixo "zz-": usa o plano da semana atual, que `production.spec` espera ainda não existir.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

async function call(page: Page, method: 'POST' | 'GET' | 'PUT', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}
async function setPackaging(page: Page, enabled: boolean) {
  const list = (await call(page, 'GET', '/api/company/modules')) as {
    key: string;
    version: number;
    enabled: boolean;
  }[];
  const m = list.find((x) => x.key === 'embalagem')!;
  if (m.enabled !== enabled)
    await call(page, 'PUT', '/api/company/modules/embalagem', { enabled, version: m.version });
}

test('qualidade: autoaprovação justificada do gestor, "Tudo conforme" e embalagem desligada', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const tag = Date.now().toString(36);
  const so = await openServiceOrder(page, `Cliente Fase 3 ${tag}`);
  const sofa = so.items[0]!;
  const me = await call(page, 'GET', '/api/auth/me');
  const gestorId = me.user.id as string;
  try {
    await setPackaging(page, false);
    // Programação: só uma tarefa do sofá, do próprio gestor (ele executa a peça).
    const week = mondayOf(DAY);
    let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
    if (!plan)
      plan = await call(page, 'POST', '/api/v1/production-plans', {
        weekStart: week,
        mode: 'LEGADO',
      });
    const workers = await call(page, 'GET', '/api/v1/production/workers');
    const ricardo =
      workers.find(
        (w: { displayName: string; isTapeceiro: boolean }) => w.displayName === 'Ricardo',
      ) ??
      // Na suíte completa outros specs alteram o Ricardo: serve qualquer tapeceiro ativo.
      workers.find((w: { isTapeceiro: boolean }) => w.isTapeceiro);
    const reason = `Teste Fase 3 ${tag}`;
    const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
      serviceOrderId: so.id,
      principalUserId: ricardo.userId,
      date: DAY,
      reason,
    });
    for (const t of added.tasks as { id: string; serviceOrder: { id: string } }[])
      if (t.serviceOrder.id === so.id)
        await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, {
          reason: 'Fora do teste',
        });
    const task = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      serviceOrderItemId: sofa.id,
      activity: 'REVESTIMENTO',
      title: `Revestimento do sofá ${tag}`,
      role: 'PRINCIPAL',
      assigneeUserId: gestorId,
      date: DAY,
      time: '00:00',
      reason,
    });
    const fresh = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
    if (fresh.status !== 'PUBLICADO')
      await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
        version: fresh.version,
      });
    await call(page, 'POST', `/api/v1/production-tasks/${task.id}/start`, {});
    await call(page, 'POST', `/api/v1/production-tasks/${task.id}/complete`, {
      note: 'Revestimento feito',
    });
    const insp = (await call(
      page,
      'GET',
      `/api/v1/quality/inspections?serviceOrderId=${so.id}`,
    )) as { id: string; piece: { code: string } }[];
    const inspection = insp.find((i) => i.piece.code === sofa.code)!;
    expect(inspection, 'inspeção criada ao concluir a produção').toBeTruthy();

    // Tela da inspeção: o gestor executou — exige justificativa.
    await page.goto(`/painel/qualidade/inspecoes/${inspection.id}`);
    const self = page.getByTestId('self-approval');
    await expect(self).toContainText('Você executou este serviço');
    const allOk = page.getByTestId('approve-all-conform');
    await expect(allOk).toBeDisabled();
    await page
      .getByLabel('Justificativa (obrigatória)')
      .fill('Inspetor ausente; conferido com o cliente');
    await expect(allOk).toBeEnabled();
    await allOk.click();
    await expect(page.getByTestId('self-approval-note')).toContainText(
      'Inspetor ausente; conferido com o cliente',
    );
    await expect(page.getByText('Embalagem dispensada')).toBeVisible();

    // Auditoria: exceção destacada.
    await page.goto('/painel/auditoria');
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Exceções destacadas' });
    const hl = page.locator('[data-highlighted="true"]').filter({ hasText: sofa.code });
    await expect(hl.first()).toContainText('Exceção destacada');
    await expect(hl.first()).toContainText('aprovou a própria execução');

    // Estado geral igual na OS e na lista: a peça está pronta, a OS espera a poltrona.
    await page.goto(`/painel/os/${so.id}?tab=pecas`);
    const header = page.getByTestId('os-state');
    const state = await header.getAttribute('data-state');
    expect(state).toBeTruthy();
    await page.goto(`/painel/os?q=${so.code}`);
    await expect(page.getByTestId(`so-${so.code}`).getByTestId('os-state-badge')).toHaveAttribute(
      'data-state',
      state!,
    );
    // "Aberta" não aparece mais ao lado do estado geral.
    await expect(page.getByTestId(`so-${so.code}`)).not.toContainText('Aberta');
    const piece = await call(page, 'GET', `/api/v1/pieces/${sofa.id}`);
    expect(piece.stage).toBe('PRONTA_ENTREGA');
    expect(piece.packaging).toBeNull();
  } finally {
    await setPackaging(page, true);
  }
});

test('programação semanal numa tela só; endereços antigos e menu enxuto', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  await page.goto('/painel/producao/programacao');
  await expect(page.getByRole('heading', { name: 'Programação semanal', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Serviços', selected: true })).toBeVisible();
  await expect(page.getByTestId('pipeline-A_PLANEJAR')).toBeVisible();
  await page.getByRole('tab', { name: 'Semana detalhada' }).click();
  await expect(page.getByRole('button', { name: 'Semana anterior' })).toBeVisible();
  // Endereços antigos abrem a aba certa.
  await page.goto('/painel/producao/a-planejar');
  await expect(page.getByRole('tab', { name: 'Serviços', selected: true })).toBeVisible();
  await page.goto('/painel/producao/planejamento');
  await expect(page.getByRole('tab', { name: 'Semana detalhada', selected: true })).toBeVisible();
  // Menu: uma entrada só; as páginas que saíram do menu continuam abrindo.
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Programação semanal' })).toBeVisible();
  for (const gone of [
    'Produção — A planejar',
    'Planejamento de produção',
    'Competências da equipe',
    'Planejamento de sexta',
  ])
    await expect(nav.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
  await page.goto('/painel/competencias');
  await expect(
    page.getByRole('heading', { name: 'Competências da equipe', level: 1 }),
  ).toBeVisible();
  await page.goto('/painel/planejamento');
  await expect(
    page.getByRole('heading', { name: 'Planejamento de sexta', level: 1 }),
  ).toBeVisible();
});

test('desfazer a entrega direta: prévia, justificativa e histórico preservado', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const tag = Date.now().toString(36);
  const so = await openServiceOrder(page, `Cliente Desfazer ${tag}`);
  const me = await call(page, 'GET', '/api/auth/me');
  const gestorId = me.user.id as string;
  try {
    await setPackaging(page, false);
    const week = mondayOf(DAY);
    let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
    if (!plan)
      plan = await call(page, 'POST', '/api/v1/production-plans', {
        weekStart: week,
        mode: 'LEGADO',
      });
    const workers = await call(page, 'GET', '/api/v1/production/workers');
    const upholsterer = workers.find((w: { isTapeceiro: boolean }) => w.isTapeceiro);
    const reason = `Desfazer ${tag}`;
    const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
      serviceOrderId: so.id,
      principalUserId: upholsterer.userId,
      date: DAY,
      reason,
    });
    for (const t of added.tasks as { id: string; serviceOrder: { id: string } }[])
      if (t.serviceOrder.id === so.id)
        await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, { reason: 'Fora' });
    // As duas peças executadas pelo gestor, aprovadas com justificativa (embalagem desligada).
    for (const item of so.items) {
      const task = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        serviceOrderItemId: item.id,
        activity: 'REVESTIMENTO',
        title: `Revestimento ${item.code}`,
        role: 'PRINCIPAL',
        assigneeUserId: gestorId,
        date: DAY,
        time: '00:00',
        reason,
      });
      const fresh = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
      if (fresh.status !== 'PUBLICADO')
        await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
          version: fresh.version,
        });
      await call(page, 'POST', `/api/v1/production-tasks/${task.id}/start`, {});
      await call(page, 'POST', `/api/v1/production-tasks/${task.id}/complete`, { note: 'Feito' });
    }
    const insps = (await call(
      page,
      'GET',
      `/api/v1/quality/inspections?serviceOrderId=${so.id}`,
    )) as { id: string; version: number }[];
    expect(insps).toHaveLength(2);
    for (const i of insps)
      await call(page, 'POST', `/api/v1/quality/inspections/${i.id}/approve`, {
        version: i.version,
        allConform: true,
        selfApprovalReason: 'Teste E2E: inspetor ausente hoje',
      });

    // Entrega direta pela tela.
    await page.goto(`/painel/os/${so.id}?tab=qualidade`);
    const box = page.getByTestId('os-direct-delivery');
    await box.getByTestId('os-direct-delivery-start').click();
    await box.getByTestId('os-direct-delivery-confirm').click();
    await expect(box).toContainText('Entregue');

    // Desfazer: prévia com efeitos, justificativa obrigatória.
    await box.getByTestId('os-direct-delivery-revert').click();
    const dialog = page.getByRole('dialog', { name: 'Desfazer a entrega direta?' });
    await expect(dialog.getByTestId('revert-effects')).toContainText('pronta para entrega');
    const confirm = dialog.getByTestId('revert-confirm');
    await expect(confirm).toBeDisabled();
    await dialog
      .getByLabel('Justificativa (obrigatória)')
      .fill('Cliente não levou: marcado por engano');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(box.getByTestId('os-direct-delivery-reverted')).toContainText(
      'Cliente não levou: marcado por engano',
    );
    await expect(box.getByTestId('os-direct-delivery-start')).toBeVisible();
    // A entrega original continua no histórico, marcada como desfeita.
    const reverted = await call(page, 'GET', `/api/v1/service-orders/${so.id}/direct-delivery`);
    await page.goto(`/painel/entregas/${reverted.lastReverted.id}`);
    await expect(page.getByTestId('delivery-reverted')).toContainText('Desfeita');
  } finally {
    await setPackaging(page, true);
  }
});
