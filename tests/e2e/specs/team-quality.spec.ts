import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 10 — qualidade, correção, embalagem, entrega e logística, com dados fictícios.
 * Painel (gestor) + tablets do Ricardo, do Thiago e do João + celular do André (logística
 * terceirizada). Ricardo conclui o sofá → Thiago reprova (costura) → Ricardo corrige → nova
 * inspeção aprovada → João embala → gestor agenda → André entrega. Presença num dia próprio.
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY = addDays(today(), 28);
const atLocal = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-03:00`).toISOString();
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({ path: `../../docs/evidencias/fase-10/${name}.png`, fullPage: true })
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

/** Abre a tarefa pelo cartão do Meu dia, inicia e conclui (com observação). */
async function startAndComplete(p: Page, card: Locator, note: string) {
  await card
    .getByRole('button', { name: /^Abrir/ })
    .first()
    .click();
  await p.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
  await expect(p.getByTestId('my-task-detail')).toContainText('Em execução');
  await p.getByTestId('task-actions').getByRole('button', { name: 'Concluir' }).click();
  const confirm = p.getByTestId('confirm-complete');
  // Observação só quando a etapa exige (a correção exige; o revestimento, não).
  if (await confirm.getByRole('textbox').count()) await confirm.getByRole('textbox').fill(note);
  await confirm.getByRole('button', { name: 'Sim, concluir' }).click();
  await expect(p.getByTestId('my-task-detail')).toContainText('Concluída');
  await p.getByRole('button', { name: 'Voltar ao Meu dia' }).click();
}

test.describe.serial('Fase 10 — qualidade, embalagem e entrega', () => {
  test('produção → reprovação → correção → aprovação → embalagem → agenda → entrega', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
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
      const RICARDO = worker('Ricardo').displayName as string;
      const so = await openServiceOrder(page, 'Cliente Qualidade E2E');
      const sofa = so.items[0]!;
      const week = mondayOf(today());
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
      if (!plan)
        plan = await call(page, 'POST', '/api/v1/production-plans', {
          weekStart: week,
          mode: 'LEGADO',
        });
      const reason = 'OS de teste da Fase 10';
      const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
        serviceOrderId: so.id,
        principalUserId: worker('Ricardo').userId,
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
      await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        serviceOrderItemId: sofa.id,
        activity: 'REVESTIMENTO',
        role: 'PRINCIPAL',
        title: 'Revestimento do sofá (qualidade)',
        assigneeUserId: worker('Ricardo').userId,
        date: today(),
        time: '00:00',
        reason,
      });
      if (plan.status !== 'PUBLICADO') {
        const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
        await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
          version: draft.version,
        });
      }

      const open = async (name: string, pin: string, label: string, mobile = false) => {
        await setPin(page, name, pin);
        return openTablet(
          browser,
          await registerDevice(page, label, name),
          pin,
          mobile ? { width: 412, height: 915, isMobile: true } : undefined,
        );
      };
      const ricardo = await open(RICARDO, '482915', 'Tablet Ricardo (qualidade)');
      const thiago = await open('Thiago', '271828', 'Tablet Thiago (qualidade)');
      const joao = await open('João', '591837', 'Tablet João (qualidade)');
      const rt = ricardo.page;
      const tt = thiago.page;
      const jt = joao.page;
      await setClock('08:30');
      for (const p of [rt, tt, jt]) {
        await p.reload();
        await p.getByTestId('arrive-button').click();
        await expect(p.getByTestId('presence-status')).toContainText('Presente desde');
      }
      await setClock('09:00');

      // 1. Ricardo conclui o revestimento: nasce a inspeção para o Thiago (tempo real).
      const myCard = (p: Page, text: string | RegExp) =>
        p
          .getByTestId('my-tasks-today')
          .locator('[data-testid^="my-task-"]')
          .filter({ hasText: text });
      await startAndComplete(rt, myCard(rt, 'Revestimento do sofá (qualidade)'), 'Revestido');
      await expect(tt.getByTestId('inspections-count')).not.toHaveText('0');
      await tt.getByTestId('tile-inspections').click();
      const insp = tt.locator('[data-testid^="inspection-IQ-"]').filter({ hasText: sofa.code });
      await expect(insp).toBeVisible();
      await expect(tt.getByText(/R\$/)).toHaveCount(0);
      await evidence(tt, '01-tablet-thiago-inspecoes');

      // 2. Thiago confere o checklist e reprova a costura (defeito + motivo).
      await insp.click();
      const detail = tt.getByTestId('inspection-detail');
      await expect(detail.getByTestId('inspection-production')).toContainText(
        'Revestimento do sofá (qualidade)',
      );
      await detail.getByRole('button', { name: 'Iniciar inspeção' }).click();
      await expect(detail.getByTestId('inspection-status')).toContainText('Em inspeção');
      const items = detail.getByTestId('checklist').locator('[data-testid^="check-"]');
      await expect(items.first()).toBeVisible();
      const n = await items.count();
      for (let i = 0; i < n; i += 1) {
        const item = items.nth(i);
        const label = await item.getAttribute('data-testid');
        if (label === 'check-Costuras') {
          await item.getByRole('button', { name: 'Não conforme' }).click();
          await item.getByLabel('Defeito encontrado').fill('Ponto solto no braço esquerdo');
          await item.getByRole('button', { name: 'Registrar defeito' }).click();
          await expect(item).toHaveAttribute('data-result', 'NAO_CONFORME');
        } else {
          await item.getByRole('button', { name: 'Conforme', exact: true }).click();
          await expect(item).toHaveAttribute('data-result', 'OK');
        }
      }
      await evidence(tt, '02-tablet-checklist-com-defeito');
      const decision = detail.getByTestId('inspection-decision');
      await expect(decision.getByRole('button', { name: 'Aprovar' })).toBeDisabled();
      await decision.getByRole('button', { name: 'Reprovar' }).click();
      await decision
        .getByLabel('Motivo da reprovação')
        .fill('Costura do braço precisa ser refeita');
      await decision.getByRole('button', { name: 'Confirmar reprovação' }).click();
      await expect(detail.getByTestId('inspection-status')).toContainText('Reprovada');

      // 3. Ricardo recebe a correção (defeitos visíveis) e conclui.
      const correction = myCard(rt, /Corrigir/);
      await expect(correction).toBeVisible();
      await expect(correction.getByTestId('quality-info')).toContainText('Ponto solto');
      await evidence(rt, '03-tablet-ricardo-correcao');
      await startAndComplete(rt, correction, 'Costura refeita com ponto duplo');

      // 4. Nova inspeção obrigatória (rodada 2) — o Thiago aprova.
      await tt.getByRole('button', { name: 'Voltar às inspeções' }).click();
      const second = tt.locator('[data-testid^="inspection-IQ-"]').filter({ hasText: sofa.code });
      await expect(second).toContainText('Nova inspeção após correção');
      await second.click();
      const d2 = tt.getByTestId('inspection-detail');
      const items2 = d2.getByTestId('checklist').locator('[data-testid^="check-"]');
      await expect(items2.first()).toBeVisible();
      await expect(items2.first()).toHaveAttribute('data-result', '');
      for (let i = 0; i < (await items2.count()); i += 1) {
        await items2.nth(i).getByRole('button', { name: 'Conforme', exact: true }).click();
        await expect(items2.nth(i)).toHaveAttribute('data-result', 'OK');
      }
      await d2.getByTestId('inspection-decision').getByRole('button', { name: 'Aprovar' }).click();
      await expect(d2.getByTestId('inspection-status')).toContainText('Aprovada');
      await evidence(tt, '04-tablet-thiago-aprovada');

      // 5. A embalagem vai para o João (disponível), que registra proteção e local.
      const pack = myCard(jt, /Embalar/);
      await expect(pack).toBeVisible();
      await pack
        .getByRole('button', { name: /^Abrir/ })
        .first()
        .click();
      await jt.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
      const panel = jt.getByTestId('packaging-panel');
      await panel.getByRole('button', { name: 'Plástico bolha' }).click();
      await panel.getByLabel('Onde a peça ficou').selectOption({ label: 'Expedição' });
      await evidence(jt, '05-tablet-joao-embalagem');
      await panel.getByRole('button', { name: 'Concluir embalagem' }).click();
      await expect(jt.getByText('Embalagem concluída').first()).toBeVisible();

      // 6. Painel: peça pronta para entrega; o gestor agenda (só ele) com o André.
      await page.goto('/painel/entregas');
      await page.getByRole('tab', { name: /Prontas para entrega/ }).click();
      const ready = page.getByTestId(`ready-${sofa.code}`);
      await expect(ready).toContainText('Expedição');
      await evidence(page, '06-painel-prontas-para-entrega');
      await page
        .getByTestId('ready-pieces')
        .locator('div')
        .filter({ has: ready })
        .getByRole('button', { name: 'Agendar entrega' })
        .first()
        .click();
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('Data do compromisso').fill(addDays(today(), 1));
      await dlg.getByLabel('Horário de chegada ao cliente').fill('09:00');
      await dlg.getByLabel('Responsável pela execução').selectOption({ label: 'André' });
      await dlg.getByLabel('Instruções para a equipe').fill('Portaria: avisar o zelador');
      await dlg.getByRole('button', { name: 'Agendar', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      await page.getByRole('tab', { name: 'Agenda' }).click();
      const row = page
        .locator('[data-testid^="delivery-EN-"]')
        .filter({ hasText: 'Cliente Qualidade E2E' });
      await expect(row).toContainText('Agendada');
      await expect(row).toContainText('André');
      await evidence(page, '07-painel-agenda-de-entregas');

      // 7. André (logística terceirizada, celular) vê só a própria entrega, sem valores.
      const andre = await open('André', '640218', 'Celular André', true);
      const at = andre.page;
      const job = at
        .locator('[data-testid^="job-EN-"]')
        .filter({ hasText: 'Cliente Qualidade E2E' });
      await expect(job).toContainText('Portaria: avisar o zelador');
      await expect(at.getByText(/R\$/)).toHaveCount(0);
      await evidence(at, '08-celular-andre-entrega');
      await job.getByRole('button', { name: 'Saí para entrega' }).click();
      await expect(job.getByTestId('job-status')).toHaveText('Em transporte');
      await job.getByRole('button', { name: 'Cheguei ao destino' }).click();
      await job.getByRole('button', { name: 'Confirmar peças' }).click();
      await job.getByRole('button', { name: 'Registrar peças' }).click();
      await job.getByRole('button', { name: 'Concluir entrega' }).click();
      await expect(job.getByTestId('job-status')).toHaveText('Concluída');
      await evidence(at, '09-celular-andre-concluida');

      // 8. Painel: histórico completo da entrega e da peça.
      await page.goto('/painel/entregas');
      await expect(row).toContainText('Concluída');
      await row.getByRole('link', { name: 'Abrir' }).click();
      await expect(page.getByTestId('delivery-header')).toContainText('Concluída');
      await expect(page.getByTestId('delivery-history')).toContainText('SAIDA');
      await expect(page.getByTestId('delivery-history')).toContainText('CONCLUIDA');
      await expect(page.getByTestId('delivery-items')).toContainText('Entregue');
      await evidence(page, '10-painel-entrega-concluida');
      await page.goto('/painel/qualidade');
      await page.getByRole('tab', { name: 'Histórico' }).click();
      await expect(page.getByTestId('inspections-all')).toContainText('Reprovada');
      await expect(page.getByTestId('inspections-all')).toContainText('Aprovada');
      await evidence(page, '11-painel-qualidade-historico');

      // Encerramento: as poltronas ficam fora do teste (sem tarefas abertas).
      for (const c of [ricardo, thiago, joao, andre]) await c.context.close();
    } finally {
      await setClock(null).catch(() => undefined);
      await setDays(page, [1, 2, 3, 4, 5]).catch(() => undefined);
    }
  });
});
