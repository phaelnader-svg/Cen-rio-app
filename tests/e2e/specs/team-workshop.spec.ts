import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 12 — os quatro tablets da oficina (Ricardo, Márcio, João, Thiago) operando ao mesmo
 * tempo com o painel aberto: chegada, início simultâneo das tarefas, queda de conexão de um
 * tablet enquanto o gestor muda a prioridade, conclusão e inspeção nascendo em tempo real.
 * Dados fictícios; relógio de teste num dia próprio.
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY = addDays(today(), 35);
const atLocal = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-03:00`).toISOString();
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-12/${name}.png`, fullPage: true })
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

type Task = { id: string; title: string; status: string; serviceOrder: { id: string } };
const card = (p: Page, title: string): Locator =>
  p.getByTestId('my-tasks-today').locator('[data-testid^="my-task-"]').filter({ hasText: title });

async function start(p: Page, title: string) {
  await card(p, title)
    .getByRole('button', { name: /^Abrir/ })
    .first()
    .click();
  await p.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
  await expect(p.getByTestId('my-task-detail')).toContainText('Em execução');
}

test.describe.serial('Fase 12 — painel + quatro tablets simultâneos', () => {
  test('chegada, início simultâneo, queda de conexão, prioridade e inspeção em tempo real', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (hhmm: string | null) =>
      call(page, 'POST', '/api/test/clock', { now: hhmm ? atLocal(hhmm) : null });
    try {
      const c = await call(page, 'GET', '/api/company/settings');
      await call(page, 'PUT', '/api/company/settings', {
        ...c,
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        arrivalWindowStart: '07:00',
        workdayStart: '08:30',
        arrivalAlertAt: '09:30',
        workdayEnd: '18:00',
        lateAlertMinutes: 15,
      });
      await setClock('08:20');
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const w = (n: string) =>
        workers.find((x: { displayName: string }) => x.displayName.startsWith(n));
      const so = await openServiceOrder(page, 'Cliente Quatro Tablets E2E');
      const week = mondayOf(today());
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: week });
      const reason = 'OS de teste da Fase 12';
      const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
        serviceOrderId: so.id,
        principalUserId: w('Ricardo').userId,
        date: today(),
        reason,
      });
      for (const t of (added.tasks as Task[]).filter(
        (x) => x.serviceOrder.id === so.id && !['CONCLUIDA', 'CANCELADA'].includes(x.status),
      ))
        await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, {
          reason: 'Fora do escopo do teste',
        });
      const titles = {
        Ricardo: 'Revestimento do sofá (4 tablets)',
        Márcio: 'Revestimento das poltronas (4 tablets)',
        João: 'Preparação de apoio (4 tablets)',
        Thiago: 'Limpeza de apoio (4 tablets)',
      } as const;
      const ids: Record<string, string> = {};
      for (const [name, item, activity, role] of [
        ['Ricardo', so.items[0]!.id, 'REVESTIMENTO', 'PRINCIPAL'],
        ['Márcio', so.items[1]!.id, 'REVESTIMENTO', 'PRINCIPAL'],
        ['João', so.items[0]!.id, 'PREPARACAO', 'APOIO'],
        ['Thiago', so.items[1]!.id, 'ACABAMENTO', 'APOIO'],
      ] as const) {
        const t = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
          serviceOrderId: so.id,
          serviceOrderItemId: item,
          activity,
          role,
          title: titles[name],
          assigneeUserId: w(name).userId,
          date: today(),
          time: '00:00',
          reason,
        });
        ids[name] = t.id;
      }
      if (plan.status !== 'PUBLICADO') {
        const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
        await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
          version: draft.version,
        });
      }

      // Os quatro tablets abertos ao mesmo tempo.
      const PINS = {
        Ricardo: '482915',
        Márcio: '736152',
        João: '591837',
        Thiago: '271828',
      } as const;
      const tablets: Record<string, { page: Page; close: () => Promise<void> }> = {};
      for (const name of Object.keys(PINS) as (keyof typeof PINS)[]) {
        const display = w(name).displayName as string;
        await setPin(page, display, PINS[name]);
        const t = await openTablet(
          browser,
          await registerDevice(page, `Tablet ${name} (4 tablets)`, display),
          PINS[name],
        );
        tablets[name] = { page: t.page, close: () => t.context.close() };
      }
      await setClock('08:30');
      await Promise.all(
        Object.values(tablets).map(async ({ page: p }) => {
          await p.reload();
          await p.getByTestId('arrive-button').click();
          await expect(p.getByTestId('presence-status')).toContainText('Presente desde');
        }),
      );
      await setClock('09:00');

      // Início simultâneo nos quatro tablets.
      await Promise.all(
        (Object.keys(titles) as (keyof typeof titles)[]).map(async (name) => {
          const p = tablets[name]!.page;
          await p.reload();
          await start(p, titles[name]);
        }),
      );
      for (const name of Object.keys(ids)) {
        const t = await call(page, 'GET', `/api/v1/production-tasks/${ids[name]}`);
        expect(t.status, name).toBe('EM_EXECUCAO');
      }
      await page.goto('/painel/producao');
      await expect(page.getByText(titles.Ricardo).first()).toBeVisible();
      await evidence(page, 'quatro-tablets-painel');
      for (const name of Object.keys(tablets))
        await evidence(tablets[name]!.page, `quatro-tablets-${name}`);

      // Queda de conexão do Márcio enquanto o gestor muda a prioridade da tarefa dele.
      const mp = tablets['Márcio']!.page;
      await mp.context().setOffline(true);
      await expect(mp.getByTestId('offline-banner')).toBeVisible({ timeout: 20_000 });
      const cur = await call(page, 'GET', `/api/v1/production-tasks/${ids['Márcio']}`);
      await call(page, 'PUT', `/api/v1/production-tasks/${ids['Márcio']}`, {
        priority: 'URGENTE',
        reason: 'Cliente antecipou a entrega',
        version: cur.version,
      });
      // Durante a queda, Ricardo conclui o sofá (precisa da preparação do João concluída antes).
      const jp = tablets['João']!.page;
      await jp.getByTestId('task-actions').getByRole('button', { name: 'Concluir' }).click();
      const jc = jp.getByTestId('confirm-complete');
      if (await jc.getByRole('textbox').count()) await jc.getByRole('textbox').fill('Preparado');
      await jc.getByRole('button', { name: 'Sim, concluir' }).click();
      await expect(jp.getByTestId('my-task-detail')).toContainText('Concluída');
      const rp = tablets.Ricardo!.page;
      await rp.getByTestId('task-actions').getByRole('button', { name: 'Concluir' }).click();
      const rc = rp.getByTestId('confirm-complete');
      if (await rc.getByRole('textbox').count()) await rc.getByRole('textbox').fill('Revestido');
      await rc.getByRole('button', { name: 'Sim, concluir' }).click();
      await expect(rp.getByTestId('my-task-detail')).toContainText('Concluída');
      // Thiago (inspetor) recebe a inspeção do sofá em tempo real, sem recarregar.
      const tp = tablets.Thiago!.page;
      await tp.getByRole('button', { name: 'Voltar ao Meu dia' }).click();
      await expect(tp.getByTestId('inspections-count')).not.toHaveText('0', { timeout: 20_000 });
      // Reconexão do Márcio: recupera o estado (prioridade) sem recarregar a página.
      await mp.context().setOffline(false);
      await expect(mp.getByTestId('offline-banner')).toHaveCount(0, { timeout: 20_000 });
      await expect(mp.getByTestId('my-task-detail')).toContainText(/Prioridade urgente/i, {
        timeout: 20_000,
      });
      // A tarefa continua em execução uma única vez (nenhuma duplicidade).
      const marcio = await call(page, 'GET', `/api/v1/production-tasks/${ids['Márcio']}`);
      expect(marcio.status).toBe('EM_EXECUCAO');
      await evidence(mp, 'quatro-tablets-reconexao-marcio');
      for (const t of Object.values(tablets)) await t.close();
    } finally {
      await setClock(null);
    }
  });
});
