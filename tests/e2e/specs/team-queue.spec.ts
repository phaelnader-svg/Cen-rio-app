import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Evolução, Fase 2 — planejamento semanal em FILA (sem horário), painel + tablet do João.
 * Semana própria no futuro (não interfere nos planos LEGADO dos outros specs); o relógio de
 * teste da API percorre segunda → terça para provar a continuidade da fila. No fim, as tarefas
 * criadas são canceladas e o relógio volta ao normal.
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const WEEK = mondayOf(addDays(today(), 35));
const at = (day: number, hhmm: string) =>
  new Date(`${addDays(WEEK, day)}T${hhmm}:00-03:00`).toISOString();
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/evolucao-fase-2/${name}.png`, fullPage: true })
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

type Task = { id: string; title: string; code: string; status: string; version: number };

test.describe.serial('Evolução Fase 2 — fila semanal', () => {
  test('publica sem horário, tablet segue a fila, início explícito e continuidade em dois dias', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (iso: string | null) => call(page, 'POST', '/api/test/clock', { now: iso });
    const created: string[] = [];
    try {
      await setClock(at(0, '08:00'));
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const idOf = (n: string) =>
        workers.find((w: { displayName: string }) => w.displayName.startsWith(n)).userId as string;

      // Planejamento em fila (padrão da API) com 6 tarefas do João, sem data nem horário.
      const so = await openServiceOrder(page, 'Cliente Fila E2E');
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${WEEK}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: WEEK });
      expect(plan.mode).toBe('FILA_SEMANAL');
      await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
        serviceOrderId: so.id,
        principalUserId: idOf('Ricardo'),
        generate: false,
      });
      const tasks: Task[] = [];
      for (let i = 1; i <= 6; i++) {
        const t = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
          serviceOrderId: so.id,
          activity: 'PREPARACAO',
          title: `Fila E2E ${i}`,
          assigneeUserId: idOf('João'),
        });
        created.push(t.id);
        tasks.push(t);
      }

      // Painel: semana em fila, publica pela tela (sem colunas de dia/hora).
      await page.goto('/painel/producao/planejamento');
      await page.getByLabel('Semana', { exact: true }).fill(WEEK);
      await expect(page.getByTestId('plan-mode')).toHaveText('Fila semanal');
      await expect(page.getByTestId('queue-João')).toContainText('Fila E2E 6');
      await expect(page.getByRole('columnheader', { name: 'Hora' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Revisar e publicar' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Publicar' }).click();
      await expect(page.getByText(/Publicado · revisão 1/)).toBeVisible();

      // Reordenação publicada: exige motivo, gera revisão e chega ao tablet.
      await page.getByLabel('Motivo das alterações').fill('Cliente pediu a 2 antes');
      await page.getByRole('button', { name: `Descer ${tasks[0]!.code}` }).click();
      await expect(page.getByText(/Publicado · revisão 2/)).toBeVisible();
      await evidence(page, '01-painel-fila');

      // Tablet do João.
      await setPin(page, 'João', '602413');
      const joao = await openTablet(
        browser,
        await registerDevice(page, 'Tablet João (fila)', 'João'),
        '602413',
      );
      const jt = joao.page;
      const queue = jt.getByTestId('my-queue');
      await expect(queue).toContainText('Minha fila da semana (6)');
      await expect(jt.getByTestId('queue-item-1')).toContainText('Fila E2E 2');
      await expect(jt.getByTestId('queue-item-2')).toContainText('Fila E2E 1');
      await expect(jt.getByTestId('next-task')).toContainText('Fila E2E 2');
      await evidence(jt, '02-tablet-fila');

      // Segunda: inicia e conclui as duas primeiras. A próxima fica disponível, sem iniciar.
      for (const n of [1, 2]) {
        const card = jt.getByTestId('queue-item-1'); // a fila anda: a próxima vira a 1ª
        await card.getByRole('button', { name: 'Iniciar' }).click();
        await expect(card.getByRole('button', { name: 'Concluir' })).toBeVisible();
        await card.getByRole('button', { name: 'Concluir' }).click();
        await card.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
        await expect(queue).toContainText(`Minha fila da semana (${6 - n})`);
      }
      await expect(jt.getByTestId('next-task')).toContainText('Fila E2E 3');
      await expect(
        jt.getByTestId('queue-item-1').getByRole('button', { name: 'Iniciar' }),
      ).toBeVisible();
      const third = await call(page, 'GET', `/api/v1/production-tasks/${tasks[2]!.id}`);
      expect(third.status).toBe('LIBERADA');

      // Virada para terça 08:00: a fila continua de onde parou (sem zerar nem duplicar).
      await setClock(at(1, '00:01'));
      await call(page, 'POST', '/api/test/attendance/check');
      await setClock(at(1, '08:00'));
      await call(page, 'POST', '/api/test/attendance/check');
      await jt.reload();
      await expect(queue).toContainText('Minha fila da semana (4)');
      await expect(jt.getByTestId('queue-item-1')).toContainText('Fila E2E 3');

      // Primeira bloqueada → a próxima executável aparece sem mudar a ordem.
      await call(page, 'POST', `/api/v1/production-tasks/${tasks[2]!.id}/block`, {
        reason: 'Falta a grampeadeira',
      });
      await expect(jt.getByTestId('next-task')).toContainText('Fila E2E 4');
      await expect(jt.getByTestId('queue-item-1')).toContainText('Fila E2E 3');
      await jt.getByTestId('queue-item-2').getByRole('button', { name: 'Iniciar' }).click();
      await expect(
        jt.getByTestId('queue-item-2').getByRole('button', { name: 'Concluir' }),
      ).toBeVisible();
      // Ferramenta chegou: desbloqueio não interrompe a tarefa em execução.
      await call(page, 'POST', `/api/v1/production-tasks/${tasks[2]!.id}/unblock`, {
        reason: 'Chegou a grampeadeira',
      });
      await expect(jt.getByTestId('current-task')).toContainText('Fila E2E 4');
      await expect(jt.getByTestId('next-task')).toContainText('Fila E2E 3');
      const fourth = await call(page, 'GET', `/api/v1/production-tasks/${tasks[3]!.id}`);
      expect(fourth.status).toBe('EM_EXECUCAO');
      await evidence(jt, '03-tablet-terca');
      await joao.context.close();
    } finally {
      for (const id of created)
        await page.request.fetch(`/api/v1/production-tasks/${id}/cancel`, {
          method: 'POST',
          data: { reason: 'Fim do teste E2E da fila' },
          headers: { origin },
        });
      await setClock(null);
    }
  });
});
