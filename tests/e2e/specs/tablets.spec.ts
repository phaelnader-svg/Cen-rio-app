import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 6 — interface operacional dos tablets, com dados fictícios.
 * Painel (gestor) + tablet do João (1280×800) + celular do Márcio (390×844), em sessões
 * separadas: Meu dia, execução simplificada, avisos em tempo real, reprogramação e queda de rede.
 */
const TZ = 'America/Sao_Paulo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const origin = `http://localhost:${E2E.webPort}`;
/** Segunda-feira da semana de uma data (AAAA-MM-DD). */
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-6/${name}.png`, fullPage: true })
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

type Task = { id: string; code: string; title: string; version: number };

test.describe.serial('Fase 6 — interface operacional dos tablets', () => {
  test('Meu dia, execução simplificada, avisos, reprogramação e queda de conexão', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const so = await openServiceOrder(page, 'Cliente Tablets E2E');
    const sofa = so.items[0]!.code;
    const prepTitle = `Preparação — ${sofa}`;
    const joaoId = (await call(page, 'GET', '/api/v1/production/workers')).find(
      (w: { displayName: string }) => w.displayName === 'João',
    ).userId;
    const marcioId = (await call(page, 'GET', '/api/v1/production/workers')).find(
      (w: { displayName: string }) => w.displayName === 'Márcio',
    ).userId;

    // Tablet do João e celular do Márcio (sessões próprias, PIN da Fase 1).
    await setPin(page, 'João', '591837');
    await setPin(page, 'Márcio', '736204');
    const joao = await openTablet(
      browser,
      await registerDevice(page, 'Tablet João (dia)', 'João'),
      '591837',
    );
    const marcio = await openTablet(
      browser,
      await registerDevice(page, 'Celular Márcio', 'Márcio'),
      '736204',
      { width: 390, height: 844, isMobile: true },
    );
    const jt = joao.page;
    const mt = marcio.page;
    // Rede do tablet do João controlável (simula Wi-Fi caindo).
    let blocked = false;
    let live: WebSocketRoute | null = null;
    await jt.routeWebSocket(/\/api\/realtime$/, (ws) => {
      if (blocked) return void ws.close({ code: 1006 as never, reason: 'rede indisponível' });
      live = ws;
      ws.connectToServer();
    });
    await jt.reload();
    await expect(jt.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
    await expect(jt.getByRole('heading', { name: /Meu dia/ })).toBeVisible();
    await expect(jt.getByTestId('tablet-date')).not.toBeEmpty();

    // 1. Programação da semana (já publicada pela Fase 5 ou criada agora) recebe a OS.
    const week = mondayOf(today());
    let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
    if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: week });
    const reason = 'Inclusão da OS de teste da Fase 6';
    const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
      serviceOrderId: so.id,
      principalUserId: marcioId,
      date: today(),
      reason,
    });
    const find = (title: string) => (added.tasks as Task[]).find((t) => t.title === title)!;
    const desm = find(`Desmontagem — ${sofa}`);
    await call(page, 'POST', `/api/v1/production-tasks/${desm.id}/cancel`, {
      reason: 'Peça chegou desmontada',
    });
    // A desmontagem cancelada reavalia a preparação (nova versão): relê antes de alterar.
    const prep0 = await call(page, 'GET', `/api/v1/production-tasks/${find(prepTitle).id}`);
    const prep = await call(page, 'PUT', `/api/v1/production-tasks/${prep0.id}`, {
      assigneeUserId: joaoId,
      date: today(),
      time: '00:00',
      instructions: 'Limpar a estrutura e conferir os percintas.',
      reason,
      version: prep0.version,
    });
    const rev = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      activity: 'REVESTIMENTO',
      title: 'Revestimento do encosto',
      assigneeUserId: marcioId,
      date: today(),
      time: '00:00',
      dependsOn: [prep.id],
      reason,
    });
    if (plan.status !== 'PUBLICADO') {
      const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
      await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
        version: draft.version,
      });
    }

    // 2. Meu dia do João atualiza sozinho: próxima tarefa liberada e aviso não lido.
    const next = jt.getByTestId('next-task');
    await expect(next).toContainText('Preparação');
    await expect(next).toContainText(so.code);
    await expect(next).toContainText(sofa);
    await expect(jt.getByTestId('notifications-unread')).not.toHaveText('0');
    await expect(jt.getByText(/R\$/)).toHaveCount(0);
    // Não aparecem tarefas de outra pessoa (o revestimento é do Márcio).
    await expect(jt.getByTestId('my-day')).not.toContainText('Revestimento do encosto');
    await evidence(jt, '01-tablet-meu-dia');

    // 3. Iniciar com um toque, direto no cartão.
    await next.getByRole('button', { name: 'Iniciar' }).click();
    const current = jt.getByTestId('current-task');
    await expect(current).toContainText('Preparação');
    await expect(current.locator('[data-status="EM_EXECUCAO"]')).toBeVisible();

    // 4. Detalhe técnico, andamento estruturado, pausa por impedimento e retomada.
    await current.getByRole('button', { name: new RegExp(`Abrir ${prepTitle}`) }).click();
    const detail = jt.getByTestId('my-task-detail');
    await expect(detail).toContainText('Limpar a estrutura');
    await expect(jt.getByTestId('task-pieces')).toContainText('Sofá 3 lugares');
    await expect(detail).toContainText('Ao concluir, libera');
    await expect(detail).toContainText('Revestimento do encosto');
    await jt.getByRole('button', { name: 'Registrar andamento' }).click();
    await jt.getByLabel('Etapa atual').fill('Estrutura limpa');
    await jt.getByLabel('Próximo passo').fill('Trocar percintas do assento');
    await jt.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(jt.getByTestId('last-progress')).toContainText('Estrutura limpa');
    await expect(jt.getByTestId('last-progress')).toContainText('Trocar percintas');
    await jt.getByRole('button', { name: 'Pausar', exact: true }).click();
    await jt.getByText('É um impedimento').click();
    await jt.getByRole('button', { name: 'Aguardando orientação' }).click();
    await expect(detail).toContainText('Marcada como impedimento');
    await evidence(jt, '02-tablet-detalhe-pausada');
    await jt.getByRole('button', { name: 'Retomar' }).click();
    await expect(detail.getByRole('button', { name: 'Concluir', exact: true })).toBeEnabled();

    // 5. Queda de conexão: aviso visível, dados preservados e ações desativadas.
    blocked = true;
    await joao.context.setOffline(true);
    (live as WebSocketRoute | null)?.close({ code: 1006 as never, reason: 'rede caiu' });
    await expect(jt.getByTestId('offline-banner')).toBeVisible();
    await expect(detail).toContainText('Limpar a estrutura');
    await expect(detail.getByRole('button', { name: 'Concluir', exact: true })).toBeDisabled();
    await evidence(jt, '03-tablet-sem-conexao');
    // Enquanto isso o gestor muda a prioridade da preparação (o tablet não vê ainda).
    const prepNow = await call(page, 'GET', `/api/v1/production-tasks/${prep.id}`);
    await call(page, 'PUT', `/api/v1/production-tasks/${prep.id}`, {
      priority: 'ALTA',
      reason: 'Cliente pediu urgência',
      version: prepNow.version,
    });
    blocked = false;
    await joao.context.setOffline(false);
    await expect(jt.getByTestId('offline-banner')).toHaveCount(0, { timeout: 20_000 });
    await expect(jt.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');
    // Reconciliação com o servidor: a nova prioridade aparece sem recarregar.
    await expect(detail).toContainText('Prioridade alta');

    // 6. Conclusão simples a partir do Meu dia (toque + confirmação, sem formulário).
    await jt.getByRole('button', { name: 'Voltar ao Meu dia' }).click();
    const quick = current.getByRole('button', { name: 'Concluir' });
    await quick.click();
    await current.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
    await expect(jt.getByTestId('my-tasks-done')).toContainText('Preparação');

    // 7. Celular do Márcio: liberação em tempo real e aviso persistente com abertura da tarefa.
    await expect(mt.getByTestId('next-task')).toContainText('Revestimento do encosto');
    await expect(mt.getByTestId('notifications-unread')).not.toHaveText('0');
    await evidence(mt, '04-celular-meu-dia');
    await mt.getByTestId('notifications-button').click();
    const released = mt.getByTestId('notification-TAREFA_LIBERADA').first();
    await expect(released).toHaveAttribute('data-read', 'false');
    await evidence(mt, '05-celular-avisos');
    await released.click();
    await expect(mt.getByTestId('my-task-detail')).toContainText('Revestimento do encosto');
    await expect(mt.getByTestId('my-task-detail')).toContainText('Liberada');
    await mt.getByRole('button', { name: 'Voltar aos avisos' }).click();
    await expect(mt.getByTestId('notification-TAREFA_LIBERADA').first()).toHaveAttribute(
      'data-read',
      'true',
    );

    // 8. Gestor reprograma pelo painel; o celular recebe o aviso e a mudança sem recarregar.
    await page.goto(`/painel/producao/tarefas/${rev.id}`);
    await page.getByRole('button', { name: 'Reprogramar / editar' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Prioridade').selectOption({ label: 'Urgente' });
    await dialog.getByLabel('Hora').fill('00:05');
    await dialog.getByLabel('Motivo da alteração').fill('Cliente antecipou a entrega');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).toHaveCount(0);
    // Só os avisos desta tarefa (o spec da Fase 5 deixa outro aviso de prioridade para o Márcio).
    const ofRev = (kind: string) =>
      mt.getByTestId(`notification-${kind}`).filter({ hasText: 'Revestimento do encosto' });
    await expect(ofRev('PRIORIDADE_ALTERADA')).toBeVisible();
    await expect(ofRev('TAREFA_REPROGRAMADA')).toBeVisible();
    await mt.getByRole('button', { name: /Marcar todos como lidos/ }).click();
    await expect(mt.getByTestId('notifications-unread')).toHaveCount(0);
    await mt.getByRole('button', { name: 'Voltar ao Meu dia' }).click();
    await expect(mt.getByTestId('next-task')).toContainText('Urgente');

    // 9. Márcio inicia no celular; o João não consegue agir na tarefa dele.
    await mt.getByTestId('next-task').getByRole('button', { name: 'Iniciar' }).click();
    await expect(mt.getByTestId('current-task')).toContainText('Revestimento do encosto');
    const forbidden = await jt.request.post(`/api/v1/production-tasks/${rev.id}/complete`, {
      data: {},
      headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
    });
    expect(forbidden.status()).toBe(403);
    await evidence(mt, '06-celular-em-execucao');

    await joao.context.close();
    await marcio.context.close();
  });
});
