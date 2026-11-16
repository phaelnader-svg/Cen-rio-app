import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Etapa E1 da correção da reformulação — pela tela, no estado PADRÃO (nenhum interruptor mexido):
 *  G. Empresa → Funcionalidades: "Travas de materiais" vem desligada;
 *  A/B/C/D/E. OS sem medição, sem compra e com tecido na lista da OS ainda NÃO comprado e NÃO
 *     disponível: a etapa "Corte de tecido" (que o modelo padrão marca como "exige materiais")
 *     aparece liberada no tablet e o funcionário a inicia com um toque; o aviso de material
 *     continua só informativo;
 *  Resumo da OS: materiais e medições "não impedem o início".
 * Dados fictícios. Prefixo "zz-": usa o plano da semana atual depois dos demais specs.
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

const evidence = (p: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? p.screenshot({ path: `../../docs/evidencias/e1-materiais/${name}.png`, fullPage: true })
    : Promise.resolve();

type Task = {
  id: string;
  title: string;
  activity: string;
  version: number;
  serviceOrder: { id: string };
};

test('E1 — sem compra, sem medição e com material pendente, o tablet inicia a etapa que "exige materiais"', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);

  // G. Padrão: trava de materiais desligada, sem ninguém ter mexido.
  const modules = (await call(page, 'GET', '/api/company/modules')) as {
    key: string;
    enabled: boolean;
    defaultEnabled: boolean;
  }[];
  expect(modules.find((m) => m.key === 'materiais')).toMatchObject({
    enabled: false,
    defaultEnabled: false,
  });
  await page.goto('/painel/empresa');
  await expect(page.getByTestId('module-materiais-toggle')).not.toBeChecked();
  await evidence(page, '00-empresa-funcionalidades-padrao');

  // OS aberta, sem medição e sem nenhum pedido de compra.
  const tag = Date.now().toString(36).slice(-5);
  const so = await openServiceOrder(page, `Cliente E1 ${tag}`);
  // B/C. Tecido informado na OS, NÃO comprado e NÃO disponível na oficina.
  await call(page, 'POST', `/api/v1/service-orders/${so.id}/material-list`, {
    description: `Tecido linho E1 ${tag}`,
    quantity: 8,
    unit: 'm',
    purchased: false,
    available: false,
  });

  // Resumo da OS: materiais e medições só informam.
  await page.goto(`/painel/os/${so.id}`);
  const readiness = page.getByTestId('readiness');
  await expect(readiness).toContainText('Materiais · Não impede o início');
  await expect(readiness).toContainText('Medições · Não impede o início');
  await expect(readiness).toContainText('ainda não está(ão) na oficina');
  await expect(page.getByText('Materiais pendentes aparecem só como aviso.')).toBeVisible();
  await evidence(page, '01-os-resumo-prontidao');

  // Planejamento da semana com a OS; a etapa principal "Corte de tecido" vai para o tapeceiro.
  // Tapeceiro próprio do teste (sem tarefas de outros specs): o responsável principal de sofá
  // precisa ser tapeceiro, e um tapeceiro só executa uma etapa principal por vez.
  const roles = (await call(page, 'GET', '/api/roles')) as { id: string; key: string }[];
  const pin = String(100000 + (Date.now() % 900000));
  const workerName = `Tapeceiro E1 ${tag}`;
  const emp = await call(page, 'POST', '/api/employees', {
    fullName: `[TESTE E1] ${workerName}`,
    displayName: workerName,
    jobTitle: 'Tapeceiro (teste)',
    color: '#557799',
    roleIds: [roles.find((r) => r.key === 'tapeceiro')!.id],
    pin,
  });
  const worker = { userId: (emp.userId ?? emp.user?.id) as string, displayName: workerName };
  expect(worker.userId, JSON.stringify(emp)).toBeTruthy();
  const week = mondayOf(DAY);
  let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
  if (!plan)
    plan = await call(page, 'POST', '/api/v1/production-plans', {
      weekStart: week,
      mode: 'LEGADO',
    });
  const reason = `Teste E1 ${tag}`;
  const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
    serviceOrderId: so.id,
    principalUserId: worker.userId,
    date: DAY,
    reason,
  });
  const mine = (added.tasks as Task[]).filter((t) => t.serviceOrder.id === so.id);
  const cut0 = mine.find((t) => t.activity === 'CORTE_TECIDO')!;
  expect(cut0, 'etapa de corte gerada pelo modelo padrão').toBeTruthy();
  // As demais etapas da OS saem do teste (não interferem no tablet do tapeceiro).
  for (const t of mine)
    if (t.id !== cut0.id)
      await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, {
        reason: 'Fora do teste E1',
      });
  const cutNow = await call(page, 'GET', `/api/v1/production-tasks/${cut0.id}`);
  await call(page, 'PUT', `/api/v1/production-tasks/${cut0.id}`, {
    assigneeUserId: worker.userId,
    date: DAY,
    time: '00:00',
    reason,
    version: cutNow.version,
  });
  const fresh = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
  if (fresh.status !== 'PUBLICADO')
    await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
      version: fresh.version,
    });
  // A etapa continua marcada como "exige materiais" e mesmo assim está liberada.
  const cut = await call(page, 'GET', `/api/v1/production-tasks/${cut0.id}`);
  expect(cut.requiresMaterials).toBe(true);
  expect(cut.status).toBe('LIBERADA');
  expect(cut.blockers).not.toContain('MATERIAIS');

  // Tablet do tapeceiro: a etapa aparece e inicia com um toque.
  const tablet = await openTablet(
    browser,
    await registerDevice(page, `Tablet E1 ${tag}`, worker.displayName),
    pin,
  );
  const jt = tablet.page;
  // O cartão aparece liberado, com o aviso de material (só informativo) e o botão Iniciar.
  const next = jt.getByTestId('next-task');
  await expect(next).toContainText(so.code);
  await expect(next).toContainText('Corte de tecido');
  await expect(next).toContainText('Liberada');
  await expect(next).toContainText('Falta material');
  await evidence(jt, '02-tablet-cartao-liberado-com-aviso');
  await next.getByRole('button', { name: 'Iniciar' }).click();
  const current = jt.getByTestId('current-task');
  await expect(current.locator('[data-status="EM_EXECUCAO"]')).toBeVisible();
  await evidence(jt, '03-tablet-em-execucao');
  // Pausar, retomar e concluir pela sessão do tablet (mesmas rotas que a tela usa).
  const tcall = async (action: string, body: unknown = {}) => {
    const r = await jt.request.fetch(`/api/v1/production-tasks/${cut0.id}/${action}`, {
      method: 'POST',
      data: body,
      headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
    });
    expect(r.ok(), `${action}: ${await r.text()}`).toBe(true);
  };
  await tcall('pause', { reason: 'AGUARDANDO_ORIENTACAO' });
  await tcall('resume');
  await tcall('complete', { note: 'Corte feito sem compra formal' });
  const done = await call(page, 'GET', `/api/v1/production-tasks/${cut0.id}`);
  expect(done.status).toBe('CONCLUIDA');
  // Nenhum processo formal foi criado para isso acontecer.
  const readinessApi = await call(
    page,
    'GET',
    `/api/v1/service-orders/${so.id}/material-readiness`,
  );
  expect(readinessApi.state).not.toBe('COMPLETO');
  await tablet.context.close();
});
