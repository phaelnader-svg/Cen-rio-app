import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 7 — presença operacional, com dados fictícios. Painel (gestor) + tablets do Márcio e do
 * João em sessões separadas. Fase 8: o horário é controlado pelo relógio de teste da API
 * (ENABLE_TEST_CLOCK, aceito só com APP_ENV=test), num dia próprio e sem registros — o teste
 * roda em qualquer horário real e percorre presença, atraso, ausência presumida e encerramento
 * com os horários padrão (07:00 / 08:30 / 09:30 / 18:00).
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Dia operacional do teste: sem registros de presença de outros specs. */
const DAY = addDays(today(), 21);
/** Instante (ISO) de um horário local no dia do teste (São Paulo, UTC−3, sem horário de verão). */
const atLocal = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-03:00`).toISOString();
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-8/${name}.png`, fullPage: true })
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

async function setTimes(
  page: Page,
  t: { window: string; start: string; alert: string; end: string; days?: number[] },
) {
  const c = await call(page, 'GET', '/api/company/settings');
  return call(page, 'PUT', '/api/company/settings', {
    ...c,
    workingDays: t.days ?? [0, 1, 2, 3, 4, 5, 6],
    arrivalWindowStart: t.window,
    workdayStart: t.start,
    arrivalAlertAt: t.alert,
    workdayEnd: t.end,
    lateAlertMinutes: 15,
  });
}

test.describe.serial('Fase 7 — presença operacional', () => {
  test('Cheguei, ausência presumida com impacto, correção, chegada tardia e encerramento', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (hhmm: string | null) =>
      call(page, 'POST', '/api/test/clock', { now: hhmm ? atLocal(hhmm) : null });
    try {
      await setTimes(page, { window: '07:00', start: '08:30', alert: '09:30', end: '18:00' });
      await setClock('08:00');
      const so = await openServiceOrder(page, 'Cliente Presença E2E');
      const sofa = so.items[0]!.code;
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const idOf = (n: string) =>
        workers.find((w: { displayName: string }) => w.displayName === n).userId;
      const week = mondayOf(today());
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: week });
      const reason = 'OS de teste da Fase 7';
      const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
        serviceOrderId: so.id,
        principalUserId: idOf('Márcio'),
        date: today(),
        reason,
      });
      const find = (title: string) =>
        (added.tasks as { id: string; title: string }[]).find((t) => t.title === title)!;
      await call(
        page,
        'POST',
        `/api/v1/production-tasks/${find(`Desmontagem — ${sofa}`).id}/cancel`,
        {
          reason: 'Não se aplica',
        },
      );
      const prep0 = await call(
        page,
        'GET',
        `/api/v1/production-tasks/${find(`Preparação — ${sofa}`).id}`,
      );
      const prep = await call(page, 'PUT', `/api/v1/production-tasks/${prep0.id}`, {
        assigneeUserId: idOf('João'),
        date: today(),
        time: '00:01',
        dueDate: today(),
        reason,
        version: prep0.version,
      });
      await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        activity: 'REVESTIMENTO',
        title: 'Revestimento do assento',
        assigneeUserId: idOf('Márcio'),
        date: today(),
        time: '00:01',
        dependsOn: [prep.id],
        reason,
      });
      if (plan.status !== 'PUBLICADO') {
        const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
        await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
          version: draft.version,
        });
      }

      // Tablets do Márcio e do João (sessões separadas, PIN só no vínculo).
      await setPin(page, 'Márcio', '736204');
      await setPin(page, 'João', '591837');
      const marcio = await openTablet(
        browser,
        await registerDevice(page, 'Tablet Márcio (presença)', 'Márcio'),
        '736204',
      );
      const joao = await openTablet(
        browser,
        await registerDevice(page, 'Tablet João (presença)', 'João'),
        '591837',
      );
      const mt = marcio.page;
      const jt = joao.page;

      // 1. Painel aberto na Presença da equipe.
      await page.goto('/painel/presenca');
      const row = (n: string) => page.getByTestId(`attendance-${n}`);
      await expect(row('Márcio')).toContainText('Não confirmou chegada');

      // 2. 8h30 — Márcio: "Cheguei" em destaque, um toque; o painel atualiza sem recarregar.
      await setClock('08:30');
      await expect(mt.getByTestId('arrive-button')).toBeVisible();
      await evidence(mt, 'presenca-01-tablet-cheguei');
      await mt.getByTestId('arrive-button').click();
      await expect(mt.getByTestId('presence-status')).toContainText('Presente desde');
      // Disponível, ou ocupado se ainda tiver tarefa em execução de specs anteriores.
      await expect(row('Márcio')).toContainText(/Presente e (disponível|ocupado)/);
      await expect(row('Márcio')).not.toContainText('Atraso');
      await evidence(mt, 'presenca-02-tablet-presente');

      await expect(row('Márcio')).toContainText('08:30');

      // 3. 9h31 — passou o limite de 9h30: João vira ausência presumida (verificação imediata,
      // a mesma que roda a cada minuto).
      await setClock('09:31');
      await call(page, 'POST', '/api/test/attendance/check', {});
      await expect(row('João')).toContainText('Ausência presumida');
      const impacts = page.getByTestId('attendance-impacts');
      await expect(
        impacts.getByTestId('impact-TAREFA_DO_AUSENTE').filter({ hasText: 'Preparação' }),
      ).toBeVisible();
      const dep = impacts
        .getByTestId('impact-DEPENDENTE_AFETADA')
        .filter({ hasText: 'Revestimento do assento' });
      await expect(dep).toContainText('Márcio');
      await expect(dep).toContainText('Necessário reprogramar');
      await expect(page.getByTestId('panel-notifications-unread')).toBeVisible();
      await evidence(page, 'presenca-03-painel-ausencia-presumida');
      // Nada foi transferido nem cancelado.
      const prepNow = await call(page, 'GET', `/api/v1/production-tasks/${prep.id}`);
      expect(prepNow.assignee.userId).toBe(idOf('João'));
      expect(prepNow.status).not.toBe('CANCELADA');

      // 4. Gestor registra folga do Thiago (com justificativa) e confere o histórico.
      await row('Thiago').getByRole('button', { name: 'Registrar' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('O que registrar').selectOption({ label: 'Folga' });
      await dlg.getByLabel('Justificativa').fill('Folga combinada na semana passada');
      await dlg.getByRole('button', { name: 'Salvar' }).click();
      await expect(dlg).toHaveCount(0);
      await expect(row('Thiago')).toContainText('Ausência confirmada');
      await expect(row('Thiago')).toContainText('Folga');
      await page.getByRole('button', { name: 'Histórico de Thiago' }).click();
      await expect(page.getByTestId('attendance-history')).toContainText('Folga combinada');
      await page.keyboard.press('Escape');

      // 5. 9h50 — João chega depois da ausência presumida: situação atualizada, impactos encaminhados.
      await setClock('09:50');
      await expect(jt.getByTestId('presence-card')).toContainText('não foi confirmada');
      await jt.getByTestId('arrive-button').click();
      await expect(jt.getByTestId('presence-card')).toContainText(
        'Chegada após ausência presumida',
      );
      await expect(row('João')).toContainText('Chegada após ausência presumida');
      await expect(row('João')).toContainText('09:50');
      await expect(impacts.getByTestId('impact-DEPENDENTE_AFETADA').first()).toContainText(
        'Encaminhado',
      );

      // 6. João inicia a preparação (ocupado) e encerra o expediente sem informar o andamento.
      await jt.getByTestId('next-task').getByRole('button', { name: 'Iniciar' }).click();
      await expect(row('João')).toContainText('Presente e ocupado');
      await jt.getByTestId('depart-button').click();
      await expect(jt.getByTestId('depart-screen')).toContainText('Preparação');
      await evidence(jt, 'presenca-04-tablet-encerrar');
      await jt.getByTestId('confirm-depart').click();
      await expect(jt.getByTestId('presence-status')).toContainText('Expediente encerrado');
      await expect(row('João')).toContainText('Expediente encerrado');
      await expect(impacts.getByTestId('impact-ANDAMENTO_PENDENTE')).toContainText('Preparação');
      const paused = await call(page, 'GET', `/api/v1/production-tasks/${prep.id}`);
      expect(paused).toMatchObject({ status: 'PAUSADA', pauseReason: 'FIM_EXPEDIENTE' });

      // 7. Márcio encerra informando nada a registrar (sem tarefa em execução).
      await mt.getByTestId('depart-button').click();
      await mt.getByTestId('confirm-depart').click();
      await expect(mt.getByTestId('presence-status')).toContainText('Expediente encerrado');
      await expect(row('Márcio')).toContainText('Expediente encerrado');
      await evidence(page, 'presenca-05-painel-presenca');

      // 8. Avisos do gestor: ausência presumida, chegada após ausência e pendência.
      await page.getByTestId('panel-notifications').click();
      const list = page.getByTestId('panel-notification-list');
      await expect(list).toContainText('Ausência presumida');
      await expect(list).toContainText('Chegada após ausência presumida');
      await expect(list).toContainText('Tarefa pendente ao encerrar');
      await evidence(page, 'presenca-06-painel-avisos');
      await page.keyboard.press('Escape');

      await marcio.context.close();
      await joao.context.close();
    } finally {
      await setClock(null).catch(() => undefined);
      await setTimes(page, {
        window: '07:00',
        start: '08:30',
        alert: '09:30',
        end: '18:00',
        days: [1, 2, 3, 4, 5],
      }).catch(() => undefined);
    }
  });
});
