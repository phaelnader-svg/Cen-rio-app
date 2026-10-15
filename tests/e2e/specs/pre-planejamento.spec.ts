import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Simplificação Fase 4 — pré-planejamento no navegador (dados fictícios):
 *  1. Sofá chega (confirmação de chegada) → OS automática → aparece em "A planejar".
 *  2. Planejar serviço: só data de início e tapeceiro (Ricardo) → rascunho da semana.
 *  3. Lote: OS com dois sofás — Sofá A → Ricardo, Sofá B → Márcio.
 *  4. Revisar e publicar semana (uma ação) → João (preparação), Ricardo e Márcio (tapeçaria)
 *     veem exatamente as suas tarefas; nada antes da data de início.
 *  5. Auditoria visual 390/768/1280/1440. No fim, as tarefas criadas são canceladas (a semana
 *     futura não interfere nos outros testes).
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
// Semana própria no futuro: não colide com semanas usadas por outros testes.
// 91 dias: nenhuma outra especificação usa esta semana (35, 49 e 63 já são usadas).
const WEEK = mondayOf(addDays(today(), 91));
const START = addDays(WEEK, 1); // terça-feira
const shot = (page: Page, name: string) =>
  process.env.E2E_GEOMETRIA
    ? page.screenshot({
        path: `../../docs/evidencias/simplificacao-fase-4/${name}.png`,
        fullPage: true,
      })
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

/** Novo serviço (Fase 2) + confirmação de chegada (Fase 3) → OS automática. */
async function receivedService(page: Page, name: string, pieces: string[]) {
  const svc = await call(page, 'POST', '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name,
      phone: null,
      allowSimilar: true,
      address: {
        label: 'Residência',
        street: 'Rua do Planejamento',
        number: '7',
        district: 'Bairro Fictício',
        postalCode: '01000-000',
        city: 'Cidade Teste',
        state: 'SP',
        isPrimary: true,
      },
    },
    service: {
      promisedDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      contractedService: 'Reforma completa',
      agreedValueCents: 200000,
      items: pieces.map((d) => ({
        pieceType: 'SOFA',
        description: d,
        quantity: 1,
        serviceType: 'REFORMA_COMPLETA',
      })),
    },
    pickup: { scheduledDate: today(), windowStart: '23:30', team: 'EQUIPE_PROPRIA' },
  });
  const pk = await call(page, 'GET', `/api/v1/pickups/${svc.pickup.id}`);
  const r = await call(page, 'POST', `/api/v1/arrivals/pickups/${svc.pickup.id}/confirm`, {
    version: pk.version,
  });
  expect(r.serviceOrder?.code).toMatch(/OS-\d{5}/);
  return r.serviceOrder as { id: string; code: string };
}

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, 'rolagem horizontal').toBeLessThanOrEqual(0);
}

test.describe.serial('Simplificação Fase 4 — pré-planejamento', () => {
  test('recebido → A planejar → Ricardo/Márcio → publicar semana → tablets', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    let planId = '';
    try {
      const one = await receivedService(page, 'Helena Planejamento Fictícia', ['Sofá retrátil']);
      const two = await receivedService(page, 'Caio Dois Sofás Fictício', ['Sofá A', 'Sofá B']);

      // ── 1. A planejar
      await page.goto('/painel/producao/a-planejar');
      const row1 = page.getByTestId(`to-plan-${one.code}`);
      const row2 = page.getByTestId(`to-plan-${two.code}`);
      await expect(row1).toContainText('Helena Planejamento Fictícia');
      await expect(row1).toContainText('Sofá');
      await expect(row1).toContainText('Materiais:');
      await expect(row2).toBeVisible();
      await expect(page.getByText(/R\$/)).toHaveCount(0);
      await shot(page, '01-a-planejar');

      // ── 2. Planejar serviço (individual): data + Ricardo
      await row1.getByTestId('plan-one').click();
      const entry1 = page.getByTestId(`plan-entry-${one.code}`);
      await entry1.getByTestId('plan-start').fill(START);
      await entry1.locator('select').first().selectOption({ label: 'Ricardo' });
      await expect(page.getByTestId('plan-summary')).toContainText('Ricardo: 1 peça(s)');
      await shot(page, '02-planejar-servico');
      await page.getByTestId('plan-submit').click();
      await expect(row1).toHaveCount(0); // saiu de "A planejar"

      // ── 3. Lote: dois sofás, titulares diferentes
      await row2.getByRole('checkbox').check();
      await page.getByTestId('plan-selected').click();
      const entry2 = page.getByTestId(`plan-entry-${two.code}`);
      await entry2.getByTestId('plan-start').fill(START);
      const owners = entry2.locator('select');
      await owners.nth(0).selectOption({ label: 'Ricardo' });
      await owners.nth(1).selectOption({ label: 'Márcio' });
      await expect(page.getByTestId('plan-summary')).toContainText('Márcio: 1 peça(s)');
      await shot(page, '03-planejar-lote-dois-sofas');
      await page.getByTestId('plan-submit').click();
      await expect(row2).toHaveCount(0);

      // ── 4. Planejados: rascunho separado do publicado; revisar e publicar
      await page.getByRole('tab', { name: /Planejados/ }).click();
      const week = page.getByTestId(`week-${WEEK}`);
      await expect(week.getByTestId(`planned-${one.code}`)).toContainText(
        START.split('-').reverse().join('/'),
      );
      await expect(week).toContainText('Rascunho — ainda não visível aos funcionários');
      await shot(page, '04-planejados-rascunho');
      const pipe = await call(page, 'GET', '/api/v1/production/pipeline');
      planId = pipe.items.find(
        (i: { serviceOrder: { id: string } }) => i.serviceOrder.id === one.id,
      ).plan.planId;

      // Rascunho invisível no tablet do Ricardo (antes de publicar).
      await setPin(page, 'Ricardo', '482913');
      await setPin(page, 'João', '730561');
      await setPin(page, 'Márcio', '582046');
      const cr = await registerDevice(page, 'Tablet Ricardo (Planejamento)', 'Ricardo');
      const cj = await registerDevice(page, 'Tablet João (Planejamento)', 'João');
      const cm = await registerDevice(page, 'Tablet Márcio (Planejamento)', 'Márcio');
      const ricardo = await openTablet(browser, cr, '482913');
      const mine = async (t: { page: Page }) =>
        (
          (await (await t.page.request.get('/api/v1/production-tasks/mine/queue')).json()) as {
            items: {
              executable: boolean;
              task: { serviceOrder: { code: string }; serviceOrderItem: { code: string } | null };
            }[];
          }
        ).items.filter((i) => [one.code, two.code].includes(i.task.serviceOrder.code));
      expect(await mine(ricardo)).toHaveLength(0);

      await page.goto('/painel/producao/a-planejar');
      await page.getByRole('tab', { name: /Planejados/ }).click();
      await page.getByTestId(`week-${WEEK}`).getByTestId('publish-week').click();
      const prev = page.getByTestId('publish-preview');
      await expect(prev).toContainText('João');
      await expect(prev).toContainText('Ricardo');
      await expect(prev).toContainText('Márcio');
      await shot(page, '05-revisar-e-publicar');
      await page.getByTestId('publish-confirm').click();
      await expect(prev).toHaveCount(0);
      // Sem levantamento de materiais: planejado ≠ liberado — vai para "Aguardando condição".
      await page.getByRole('tab', { name: /Aguardando condição/ }).click();
      for (const so of [one, two])
        await expect(page.getByTestId(`stage-${so.code}`).getByTestId('blockers')).toContainText(
          /[Mm]ateria/,
        );
      await shot(page, '06-aguardando-condicao');

      // ── Tablets: cada um vê as suas; nada liberado antes da data de início.
      const joao = await openTablet(browser, cj, '730561', { width: 768, height: 1024 });
      const marcio = await openTablet(browser, cm, '582046');
      await expect.poll(async () => (await mine(joao)).length).toBeGreaterThan(0);
      const r = await mine(ricardo);
      const m = await mine(marcio);
      const j = await mine(joao);
      expect(r.length).toBeGreaterThan(0);
      expect(m.length).toBeGreaterThan(0);
      // Ricardo: sofá da OS 1 + Sofá A da OS 2; Márcio: só o Sofá B.
      expect(new Set(r.map((x) => x.task.serviceOrderItem!.code))).toEqual(
        new Set([`${one.code}/1`, `${two.code}/1`]),
      );
      expect(new Set(m.map((x) => x.task.serviceOrderItem!.code))).toEqual(
        new Set([`${two.code}/2`]),
      );
      expect([...r, ...m, ...j].every((x) => !x.executable)).toBe(true);
      await shot(joao.page, '07-tablet-joao');
      await shot(ricardo.page, '08-tablet-ricardo');
      for (const t of [ricardo, joao, marcio]) await t.context.close();

      // ── 5. Auditoria visual
      for (const [w, h] of [
        [390, 844],
        [768, 1024],
        [1280, 800],
        [1440, 900],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto('/painel/producao/a-planejar');
        await page.getByRole('tab', { name: /Aguardando condição/ }).click();
        await expect(page.getByTestId(`stage-${two.code}`)).toBeVisible();
        await noHorizontalScroll(page);
        await shot(page, `09-producao-${w}`);
      }
    } finally {
      // Limpeza: tarefas da semana futura canceladas (com motivo) — não afetam outros testes.
      if (planId) {
        const plan = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
        for (const it of plan.items as { id: string }[])
          await call(page, 'POST', `/api/v1/production-plans/${planId}/items/${it.id}/remove`, {
            reason: 'Limpeza do teste E2E',
          });
      }
    }
  });
});
