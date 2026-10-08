import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 9 — central de atenção e ocorrências, com dados fictícios. Painel (gestor) + tablets
 * do Márcio e do Thiago. Márcio registra que a máquina de costura está com problema; o gestor
 * delega ao Thiago ("Verificar a máquina de costura do Márcio"); Thiago resolve no tablet;
 * concluir a ação não encerra a ocorrência; o gestor confirma e o Márcio retoma. Presença no
 * relógio de teste num dia próprio; tarefas programadas para hoje às 00:01 (liberadas).
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY = addDays(today(), 7);
const atLocal = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-03:00`).toISOString();
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-9/${name}.png`, fullPage: true })
    : Promise.resolve();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

async function setDays(page: Page, days: number[]) {
  const c = await call(page, 'GET', '/api/company/settings');
  return call(page, 'PUT', '/api/company/settings', {
    ...c,
    workingDays: days,
    arrivalWindowStart: '07:00',
    workdayStart: '08:30',
    arrivalAlertAt: '09:30',
    workdayEnd: '18:00',
    lateAlertMinutes: 15,
  });
}

type Task = { id: string; title: string; status: string; serviceOrder: { id: string } };

test.describe.serial('Fase 9 — central de atenção e ocorrências', () => {
  test('Márcio registra o problema, gestor delega ao Thiago, verifica e Márcio retoma', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (hhmm: string | null) =>
      call(page, 'POST', '/api/test/clock', { now: hhmm ? atLocal(hhmm) : null });
    try {
      await setDays(page, [0, 1, 2, 3, 4, 5, 6]);
      await setClock('08:20');
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const worker = (n: string) =>
        workers.find((w: { displayName: string }) => w.displayName.startsWith(n));
      const so = await openServiceOrder(page, 'Cliente Ocorrência E2E');
      const week = mondayOf(today());
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: week });
      const reason = 'OS de teste da Fase 9';
      const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
        serviceOrderId: so.id,
        principalUserId: worker('Márcio').userId,
        date: today(),
        reason,
      });
      for (const t of (added.tasks as Task[]).filter(
        (x) => x.serviceOrder.id === so.id && !['CONCLUIDA', 'CANCELADA'].includes(x.status),
      )) {
        await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, {
          reason: 'Fora do escopo do teste',
        });
      }
      const revest = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        activity: 'REVESTIMENTO',
        title: 'Revestimento com costura dupla',
        assigneeUserId: worker('Márcio').userId,
        date: today(),
        time: '00:01',
        reason,
      });
      if (plan.status !== 'PUBLICADO') {
        const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
        await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
          version: draft.version,
        });
      }

      const open = async (name: string, pin: string) => {
        await setPin(page, name, pin);
        return openTablet(
          browser,
          await registerDevice(page, `Tablet ${name} (ocorrência)`, name),
          pin,
        );
      };
      const marcio = await open('Márcio', '736204');
      const thiago = await open('Thiago', '271828');
      const mt = marcio.page;
      const tt = thiago.page;
      await setClock('08:30');
      for (const p of [mt, tt]) {
        await p.reload();
        await p.getByTestId('arrive-button').click();
        await expect(p.getByTestId('presence-status')).toContainText('Presente desde');
      }
      await setClock('09:00');

      // 1. Márcio inicia o revestimento e registra: "Tenho um problema" → problema técnico.
      await mt
        .getByRole('button', { name: 'Abrir Revestimento com costura dupla' })
        .first()
        .click();
      await mt.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
      await expect(mt.getByTestId('my-task-detail')).toContainText('Em execução');
      const panel = mt.getByTestId('problem-panel');
      await panel.getByRole('button', { name: 'Problema técnico' }).click();
      const form = mt.getByTestId('problem-form');
      await form.getByTestId('problem-description').fill('Máquina de costura travando a linha');
      await form.getByRole('button', { name: 'Impedido de continuar' }).click();
      await form.getByTestId('problem-photo').setInputFiles({
        name: 'maquina.png',
        mimeType: 'image/png',
        buffer: PNG,
      });
      await evidence(mt, '01-tablet-tenho-um-problema');
      await form.getByRole('button', { name: 'Registrar problema' }).click();
      const issueCard = panel.locator('[data-testid^="issue-OC-"]').first();
      await expect(issueCard).toContainText('o gestor vai decidir');
      await expect(mt.getByTestId('my-task-detail')).toContainText('Pausada');
      await evidence(mt, '02-tablet-problema-registrado');

      // 2. Central de atenção recebe a ocorrência (ação necessária) e o gestor delega ao Thiago.
      await page.goto('/painel/atencao');
      const item = page
        .locator('[data-testid^="attention-OCORRENCIA:"]')
        .filter({ hasText: 'Máquina de costura travando a linha' });
      await expect(item).toHaveAttribute('data-category', 'ACAO');
      await expect(item).toContainText('Márcio');
      await expect(item).toContainText('Delegar a solução');
      await evidence(page, '03-painel-central-de-atencao');
      await item.getByRole('link', { name: /Abrir/ }).click();
      await expect(page.getByTestId('issue-header')).toContainText('Aberta');
      await page.getByRole('button', { name: 'Delegar solução' }).click();
      const dlg = page.getByRole('dialog');
      await dlg
        .getByLabel('Quem vai resolver')
        .selectOption({ label: worker('Thiago').displayName });
      await dlg.getByLabel('O que fazer').fill('Verificar a máquina de costura do Márcio');
      await dlg.getByRole('button', { name: 'Delegar' }).click();
      await expect(dlg).toHaveCount(0);
      await expect(page.getByTestId('issue-header')).toContainText('Atribuída');
      await evidence(page, '04-painel-ocorrencia-delegada');

      // 3. Thiago recebe a tarefa de resolução no tablet (tempo real), inicia e conclui.
      const card = tt
        .getByTestId('my-tasks-today')
        .locator('[data-testid^="my-task-"]')
        .filter({ hasText: 'Verificar a máquina de costura do Márcio' });
      await expect(card).toBeVisible();
      await expect(card.getByTestId('issue-info')).toContainText('Máquina de costura travando');
      await expect(tt.getByText(/R\$/)).toHaveCount(0);
      await evidence(tt, '05-tablet-thiago-resolucao');
      await card.getByRole('button', { name: 'Iniciar' }).click();
      await tt
        .getByTestId('current-task')
        .getByRole('button', { name: /^Abrir/ })
        .first()
        .click();
      await tt.getByTestId('task-actions').getByRole('button', { name: 'Concluir' }).click();
      const confirm = tt.getByTestId('confirm-complete');
      await confirm
        .getByLabel('Resultado (o que foi feito)')
        .fill('Agulha trocada e tensão ajustada');
      await confirm.getByRole('button', { name: 'Sim, concluir' }).click();
      await expect(tt.getByTestId('my-task-detail')).toContainText('Concluída');

      // Concluir a ação não encerra a ocorrência: aguarda a verificação do gestor.
      await expect(issueCard).toContainText('aguardando o gestor confirmar');
      await expect(mt.getByRole('button', { name: 'Retomar' })).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('issue-header')).toContainText('Aguardando verificação');

      // 4. Gestor verifica e confirma a resolução.
      await page.getByRole('button', { name: 'Verificar resolução' }).click();
      const v = page.getByRole('dialog');
      await v.getByLabel('Resultado da verificação').fill('Testada com o Márcio: costura normal');
      await v.getByRole('button', { name: 'Confirmar resolução' }).click();
      await expect(v).toHaveCount(0);
      await expect(page.getByTestId('issue-header')).toContainText('Resolvida');
      await expect(page.getByTestId('issue-history')).toContainText('Agulha trocada');
      await evidence(page, '06-painel-ocorrencia-resolvida');

      // 5. Márcio é avisado (tarefa desbloqueada) e retoma — nada retomou sozinho.
      await expect(mt.getByTestId('notifications-unread')).not.toHaveText('0');
      await mt.getByRole('button', { name: 'Retomar' }).click();
      await expect(mt.getByTestId('my-task-detail')).toContainText('Em execução');
      await mt.getByTestId('notifications-button').click();
      await expect(mt.getByTestId('notification-TAREFA_DESBLOQUEADA').first()).toBeVisible();
      await expect(mt.getByTestId('notification-OCORRENCIA_RESOLVIDA').first()).toBeVisible();
      await evidence(mt, '07-tablet-marcio-avisos');

      // Encerramento: revestimento concluído pela API (nada fica aberto para os outros specs).
      await call(page, 'POST', `/api/v1/production-tasks/${revest.id}/cancel`, {
        reason: 'Fim do teste da Fase 9',
      });
      await marcio.context.close();
      await thiago.context.close();
    } finally {
      await setClock(null).catch(() => undefined);
      await setDays(page, [1, 2, 3, 4, 5]).catch(() => undefined);
    }
  });
});
