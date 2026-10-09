import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Evolução, Fase 3 — distribuição automática por peça, painel + tablet do Márcio.
 * Semana própria no futuro (fila semanal); no fim, as tarefas criadas são canceladas.
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
const WEEK = mondayOf(addDays(today(), 49));
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/evolucao-fase-3/${name}.png`, fullPage: true })
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

test.describe.serial('Evolução Fase 3 — distribuição automática', () => {
  test('titular por peça, geração sem distribuição manual, substituição auditada e fila do titular', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    let planId = '';
    try {
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const w = (n: string) =>
        workers.find((x: { displayName: string }) => x.displayName.startsWith(n)) as {
          userId: string;
          displayName: string;
        };
      const so = await openServiceOrder(page, 'Cliente Distribuição E2E');
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${WEEK}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: WEEK });
      planId = plan.id;

      // Painel: inclui a OS escolhendo o titular de cada peça (sofá → Ricardo, poltronas → Márcio).
      await page.goto('/painel/producao/planejamento');
      await page.getByLabel('Semana', { exact: true }).fill(WEEK);
      await page
        .getByTestId(`candidate-${so.code}`)
        .getByRole('button', { name: 'Adicionar à semana' })
        .click();
      const add = page.getByRole('dialog');
      await add.getByLabel(/^Titular de .*\/1/).selectOption(w('Ricardo').userId);
      await add.getByLabel(/^Titular de .*\/2/).selectOption(w('Márcio').userId);
      await add.getByRole('button', { name: 'Adicionar' }).click();
      const dist = page.getByTestId('distribution');
      await expect(dist).toContainText(`${so.code}/1`);
      await expect(page.getByLabel(new RegExp(`Titular de ${so.code}/1`))).toHaveValue(
        w('Ricardo').userId,
      );
      await expect(page.getByLabel(new RegExp(`Titular de ${so.code}/2`))).toHaveValue(
        w('Márcio').userId,
      );
      await expect(page.getByTestId(`pendencies-${so.code}/1`)).toHaveCount(0);
      await evidence(page, '01-distribuicao-por-peca');

      // Tarefas geradas automaticamente: tapeçaria de cada peça só com o seu titular.
      const full = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
      const mine = (
        full.tasks as {
          serviceOrder: { id: string };
          serviceOrderItem: { id: string } | null;
          activity: string;
          assignee: { userId: string } | null;
        }[]
      ).filter((t) => t.serviceOrder.id === so.id);
      const tap = ['CORTE_TECIDO', 'CORTE', 'COSTURA', 'MONTAGEM', 'ACABAMENTO', 'REVESTIMENTO'];
      for (const t of mine.filter((x) => tap.includes(x.activity)))
        expect(t.assignee?.userId).toBe(
          t.serviceOrderItem!.id === so.items[0]!.id ? w('Ricardo').userId : w('Márcio').userId,
        );

      // Publica pela tela; o tablet do Márcio recebe só a tapeçaria das poltronas.
      if (full.status !== 'PUBLICADO') {
        await page.getByRole('button', { name: 'Revisar e publicar' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Publicar' }).click();
        await expect(page.getByText(/Publicado · revisão/)).toBeVisible();
      }
      await setPin(page, 'Márcio', '715324');
      const marcio = await openTablet(
        browser,
        await registerDevice(page, 'Tablet Márcio (distribuição)', 'Márcio'),
        '715324',
      );
      const queue = marcio.page.getByTestId('my-week');
      await expect(queue).toContainText(`${so.code}/2`);
      await expect(queue).not.toContainText(`${so.code}/1`);

      // Substituição excepcional: poltronas Márcio → Ricardo, com motivo e confirmação.
      await page.goto('/painel/producao/planejamento');
      await page.getByLabel('Semana', { exact: true }).fill(WEEK);
      await page
        .getByLabel(new RegExp(`Titular de ${so.code}/2`))
        .selectOption(w('Ricardo').userId);
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('button', { name: 'Substituir' })).toBeDisabled();
      await dlg.getByLabel('Motivo (histórico e auditoria)').fill('Márcio de férias');
      await dlg.getByLabel('Confirmo a substituição (ação excepcional)').check();
      await dlg.getByRole('button', { name: 'Substituir' }).click();
      await expect(page.getByTestId(`piece-${so.code}/2`)).toContainText('Substituído');
      await expect(page.getByLabel(new RegExp(`Titular de ${so.code}/2`))).toHaveValue(
        w('Ricardo').userId,
      );
      await evidence(page, '02-substituicao');
      // Tempo real: as tarefas saem da fila do Márcio sem recarregar.
      await expect(marcio.page.getByTestId('my-day')).not.toContainText(`${so.code}/2`);
      await marcio.context.close();
    } finally {
      if (planId) {
        const p = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
        for (const t of p.tasks as { id: string; status: string }[])
          if (!['CONCLUIDA', 'CANCELADA'].includes(t.status))
            await page.request.fetch(`/api/v1/production-tasks/${t.id}/cancel`, {
              method: 'POST',
              data: { reason: 'Fim do teste E2E da distribuição' },
              headers: { origin },
            });
      }
    }
  });
});
