import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Simplificação Fase 5 — modelos de produção simplificados, de ponta a ponta no painel.
 * O banco E2E é criado pelas migrations + seed oficiais: os modelos simplificados vêm da
 * migration e João/Thiago como responsáveis das etapas de preparação vêm do seed. Semana
 * própria no futuro (fila semanal); no fim, as tarefas criadas são canceladas.
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

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('Simplificação Fase 5 — modelos simplificados', () => {
  test('modelo de reforma com responsável por etapa e geração de 3 tarefas pelo planejamento', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    let planId = '';
    try {
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      const w = (n: string) =>
        workers.find((x: { displayName: string }) => x.displayName.startsWith(n)) as {
          userId: string;
        };

      // Cadastro: modelos simplificados com tipo de serviço e responsável padrão por etapa.
      await page.goto('/painel/producao/modelos');
      const card = (name: string) =>
        page.locator('div.card', { has: page.getByRole('heading', { name, exact: true }) });
      const reforma = card('Reforma de estofados (simplificado)');
      await expect(reforma).toBeVisible();
      await expect(reforma.getByText('Reforma completa').first()).toBeVisible();
      await expect(reforma.getByLabel('Responsável padrão da etapa 1')).toHaveValue(
        w('João').userId,
      );
      await expect(reforma.getByText('Titular da peça', { exact: true })).toHaveCount(2);
      const cabeceira = card('Fabricação de cabeceiras (simplificado)');
      await expect(cabeceira.getByLabel('Responsável padrão da etapa 1')).toHaveValue(
        w('Thiago').userId,
      );

      // Planejamento: OS com sofá (reforma completa) e poltronas (troca de tecido).
      const so = await openServiceOrder(page, 'Cliente Modelos Simplificados E2E');
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${WEEK}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: WEEK });
      planId = plan.id;
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
      await expect(page.getByTestId(`piece-${so.code}/1`)).toContainText(
        'Modelo: Reforma de estofados (simplificado)',
      );
      await expect(page.getByTestId(`piece-${so.code}/2`)).toContainText(
        'Modelo: Cadeira ou poltrona',
      );
      await expect(page.getByTestId(`pendencies-${so.code}/1`)).toHaveCount(0);

      // Geração: exatamente 3 tarefas para o sofá — João, Ricardo, Ricardo.
      const full = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
      const sofa = (
        full.tasks as {
          title: string;
          serviceOrderItem: { id: string } | null;
          assignee: { userId: string } | null;
        }[]
      ).filter((t) => t.serviceOrderItem?.id === so.items[0]!.id);
      expect(sofa.map((t) => [t.title.split(' — ')[0], t.assignee?.userId])).toEqual([
        ['Desmontagem e preparação', w('João').userId],
        ['Corte e costura', w('Ricardo').userId],
        ['Montagem e acabamento', w('Ricardo').userId],
      ]);
    } finally {
      if (planId) {
        const p = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
        for (const t of p.tasks as { id: string; status: string }[])
          if (!['CONCLUIDA', 'CANCELADA'].includes(t.status))
            await page.request.fetch(`/api/v1/production-tasks/${t.id}/cancel`, {
              method: 'POST',
              data: { reason: 'Fim do teste E2E dos modelos simplificados' },
              headers: { origin },
            });
      }
    }
  });
});
