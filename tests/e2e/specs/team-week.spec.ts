import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Evolução, Fase 4 — "Minha semana" nos tablets: gestor + João, Ricardo, Márcio e Thiago.
 * Fila semanal com distribuição automática (sofá → Ricardo, poltronas → Márcio, preparação →
 * João), semana própria no futuro e relógio de teste. No fim, tarefas canceladas e relógio normal.
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
const WEEK = mondayOf(addDays(today(), 63));
const br = (iso: string) => iso.split('-').reverse().slice(0, 2).join('/');
const at = (day: number, hhmm: string) =>
  new Date(`${addDays(WEEK, day)}T${hhmm}:00-03:00`).toISOString();
const shot = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/evolucao-fase-4/${name}.png`, fullPage: true })
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
/** Sem rolagem horizontal (layout cabe na largura). */
const noHorizontalScroll = async (p: Page) =>
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);

test.describe.serial('Evolução Fase 4 — Minha semana', () => {
  test('gestor + 4 tablets: destaque, próximas, fila completa, titular, bloqueio, reordenação, reconexão e virada do dia', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (iso: string | null) => call(page, 'POST', '/api/test/clock', { now: iso });
    let planId = '';
    try {
      await setClock(at(0, '08:00'));
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const w = (n: string) =>
        workers.find((x: { displayName: string }) => x.displayName.startsWith(n)) as {
          userId: string;
          displayName: string;
        };
      const so = await openServiceOrder(page, 'Cliente Semana E2E');
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${WEEK}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: WEEK });
      planId = plan.id;
      await call(page, 'POST', `/api/v1/production-plans/${planId}/items`, {
        serviceOrderId: so.id,
        pieces: [
          { serviceOrderItemId: so.items[0]!.id, upholstererUserId: w('Ricardo').userId },
          { serviceOrderItemId: so.items[1]!.id, upholstererUserId: w('Márcio').userId },
        ],
      });
      const draft = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
      await call(page, 'POST', `/api/v1/production-plans/${planId}/publish`, {
        version: draft.version,
      });

      const open = async (name: string, pin: string) => {
        await setPin(page, name, pin);
        return openTablet(
          browser,
          await registerDevice(page, `Tablet ${name} (semana)`, name),
          pin,
        );
      };
      const joao = await open('João', '820461');
      const ricardo = await open(w('Ricardo').displayName, '820462');
      const marcio = await open('Márcio', '820463');
      const thiago = await open('Thiago', '820464');
      const jt = joao.page;

      // CA4-01/02/04/10 — João: semana, destaque (1ª da fila), titular × apoio.
      await expect(jt.getByRole('heading', { level: 1 })).toContainText('Minha semana');
      await expect(jt.getByTestId('tablet-user')).toHaveText('João');
      await expect(jt.getByTestId('week-period')).toHaveText(
        new RegExp(`Semana de .*${br(WEEK)} a .*${br(addDays(WEEK, 6))}`),
      );
      const hl = jt.getByTestId('week-highlight');
      await expect(hl).toContainText('Desmontagem');
      await expect(hl).toContainText(`${so.code}/1`);
      await expect(hl.getByTestId('piece-owner')).toHaveText(
        `Tapeceiro titular da peça: ${w('Ricardo').displayName} — esta etapa é de apoio.`,
      );
      // CA4-03 — até três próximas; a fila completa na ordem.
      await expect(jt.getByTestId('week-upcoming').locator('li')).toHaveCount(3);
      await expect(jt.getByTestId('count-ready')).toHaveText('2');
      await expect(jt.getByTestId('count-blocked')).toHaveText('2');
      await shot(jt, '01-joao-tablet');
      await jt.getByTestId('week-all').click();
      await expect(jt.getByTestId('queue-all').locator('li')).toHaveCount(4);
      await expect(jt.getByTestId('queue-all-1')).toContainText(`${so.code}/1`);
      await jt.getByRole('button', { name: 'Voltar à minha semana' }).click();

      // Ricardo: nada executável ainda — motivo explicado, nenhuma ação liberada.
      const rt = ricardo.page;
      await expect(rt.getByTestId('week-nothing')).toBeVisible();
      await expect(rt.getByTestId('week-reasons')).toContainText('aguardando');
      await expect(rt.getByRole('button', { name: 'Iniciar' })).toHaveCount(0);
      await expect(rt.getByTestId('piece-owner').first()).toHaveText(
        'Você é o tapeceiro titular desta peça.',
      );
      await shot(rt, '02-ricardo-aguardando');
      // Márcio só vê as poltronas; Thiago (sem fila) mantém a tela anterior e as inspeções.
      await expect(marcio.page.getByTestId('my-week')).toContainText(`${so.code}/2`);
      await expect(marcio.page.getByTestId('my-week')).not.toContainText(`${so.code}/1`);
      await expect(thiago.page.getByTestId('my-week')).toHaveCount(0);
      await expect(thiago.page.getByTestId('tile-inspections')).toBeVisible();

      // CA4-08 — João inicia e conclui a desmontagem; a próxima não inicia sozinha.
      await hl.getByRole('button', { name: 'Iniciar' }).click();
      await expect(jt.getByRole('heading', { name: 'Em execução agora' })).toBeVisible();
      await hl.getByRole('button', { name: 'Concluir' }).click();
      await hl.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
      await expect(jt.getByTestId('count-done')).toHaveText('1');
      await expect(jt.getByRole('heading', { name: 'Próxima tarefa' })).toBeVisible();
      await expect(hl).toContainText('Preparação');
      await expect(hl.getByRole('button', { name: 'Iniciar' })).toBeVisible();

      // CA4-11 — reordenação do gestor chega em tempo real; depois, reconexão reconcilia.
      const queueOf = async () =>
        (await call(page, 'GET', `/api/v1/production-queue/${w('João').userId}`)) as {
          items: { task: { id: string; activity: string; serviceOrderItem: { id: string } } }[];
        };
      const reorder = async (ids: string[]) => {
        const p = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
        await call(page, 'PUT', `/api/v1/production-plans/${planId}/queue`, {
          userId: w('João').userId,
          taskIds: ids,
          version: p.version,
          reason: 'Cliente da poltrona com pressa',
        });
      };
      const q1 = (await queueOf()).items.map((e) => e.task);
      // Ordem atual: preparação do sofá, desmontagem e preparação das poltronas.
      await reorder([q1[1]!.id, q1[0]!.id, q1[2]!.id]);
      await expect(hl).toContainText(`${so.code}/2`);
      await joao.context.setOffline(true);
      await expect(jt.getByTestId('offline-banner')).toBeVisible();
      await reorder(q1.map((t) => t.id));
      await joao.context.setOffline(false);
      await expect(hl).toContainText(`${so.code}/1`, { timeout: 20_000 });
      await expect(hl).toContainText('Preparação');

      // CA4-09 — terça: a fila continua de onde parou.
      await setClock(at(1, '08:00'));
      await call(page, 'POST', '/api/test/attendance/check');
      await jt.reload();
      await expect(jt.getByTestId('count-done')).toHaveText('1');
      await expect(hl).toContainText('Preparação');
      await expect(hl).toContainText(`${so.code}/1`);

      // CA4-14 — larguras: celular, tablet e desktop, sem rolagem horizontal; teclado.
      for (const [name, size] of [
        ['celular', { width: 390, height: 844 }],
        ['tablet', { width: 1280, height: 800 }],
        ['desktop', { width: 1440, height: 900 }],
      ] as const) {
        await jt.setViewportSize(size);
        await expect(hl).toBeVisible();
        await noHorizontalScroll(jt);
        await shot(jt, `03-joao-${name}`);
      }
      await jt.getByTestId('week-all').focus();
      await jt.keyboard.press('Enter');
      await expect(jt.getByTestId('queue-all')).toBeVisible();
      await shot(jt, '04-fila-completa');
      for (const c of [joao, ricardo, marcio, thiago]) await c.context.close();
    } finally {
      if (planId) {
        const p = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
        for (const t of p.tasks as { id: string; status: string }[])
          if (!['CONCLUIDA', 'CANCELADA'].includes(t.status))
            await page.request.fetch(`/api/v1/production-tasks/${t.id}/cancel`, {
              method: 'POST',
              data: { reason: 'Fim do teste E2E da semana' },
              headers: { origin },
            });
      }
      await setClock(null);
    }
  });
});
