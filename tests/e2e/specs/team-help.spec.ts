import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Fase 8 — distribuição automática de ajudantes e reprogramação, com dados fictícios.
 * Painel (gestor) + tablets do Ricardo, do João e do Thiago em sessões separadas. A presença
 * usa o relógio de teste da API num dia próprio (roda em qualquer horário real); as tarefas
 * são programadas para hoje às 00:01 (liberadas). No fim, tudo o que foi criado é encerrado
 * para não interferir nos outros specs.
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY = addDays(today(), 14);
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

type Task = { id: string; title: string; status: string; version: number };

test.describe.serial('Fase 8 — ajuda e reprogramação', () => {
  test('pedido normal, apoio no tablet, urgente escalado e aprovação do gestor', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (hhmm: string | null) =>
      call(page, 'POST', '/api/test/clock', { now: hhmm ? atLocal(hhmm) : null });
    const created: string[] = [];
    try {
      await setDays(page, [0, 1, 2, 3, 4, 5, 6]);
      await setClock('08:20');
      const workers = await call(page, 'GET', '/api/v1/production/workers');
      // Nome atual (o spec de sincronização renomeia o Ricardo para "Ricardo S.").
      const worker = (n: string) =>
        workers.find((w: { displayName: string }) => w.displayName.startsWith(n));
      const idOf = (n: string) => worker(n).userId as string;
      const RICARDO = worker('Ricardo').displayName as string;

      // Programação: duas tarefas do Ricardo e uma cabeceira do Thiago, liberadas hoje.
      const so = await openServiceOrder(page, 'Cliente Ajuda E2E');
      const week = mondayOf(today());
      let plan = (await call(page, 'GET', `/api/v1/production-plans?week=${week}`))[0];
      if (!plan) plan = await call(page, 'POST', '/api/v1/production-plans', { weekStart: week });
      const reason = 'OS de teste da Fase 8';
      const added = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/items`, {
        serviceOrderId: so.id,
        principalUserId: idOf('Ricardo'),
        date: today(),
        reason,
      });
      // A resposta traz o plano inteiro da semana: só as tarefas abertas desta OS.
      const mine = (added.tasks as (Task & { serviceOrder: { id: string } })[]).filter(
        (t) => t.serviceOrder.id === so.id && !['CONCLUIDA', 'CANCELADA'].includes(t.status),
      );
      for (const t of mine) {
        await call(page, 'POST', `/api/v1/production-tasks/${t.id}/cancel`, {
          reason: 'Fora do escopo do teste',
        });
      }
      const extra = async (title: string, activity: string, who: string) => {
        const t = await call(page, 'POST', `/api/v1/production-plans/${plan.id}/tasks`, {
          serviceOrderId: so.id,
          activity,
          title,
          assigneeUserId: idOf(who),
          date: today(),
          time: '00:01',
          reason,
        });
        created.push(t.id);
        return t as Task;
      };
      const montagem = await extra('Montagem da estrutura', 'MONTAGEM', 'Ricardo');
      const acabamento = await extra('Acabamento lateral', 'ACABAMENTO', 'Ricardo');
      const cabeceira = await extra('Cabeceira estofada', 'OUTRA', 'Thiago');
      if (plan.status !== 'PUBLICADO') {
        const draft = await call(page, 'GET', `/api/v1/production-plans/${plan.id}`);
        await call(page, 'POST', `/api/v1/production-plans/${plan.id}/publish`, {
          version: draft.version,
        });
      }

      // Tablets (sessões separadas, PIN só no vínculo).
      const open = async (name: string, pin: string) => {
        await setPin(page, name, pin);
        return openTablet(browser, await registerDevice(page, `Tablet ${name} (ajuda)`, name), pin);
      };
      const ricardo = await open(RICARDO, '482915');
      const joao = await open('João', '591837');
      const thiago = await open('Thiago', '271828');
      const rt = ricardo.page;
      const jt = joao.page;
      const tt = thiago.page;

      // 1. 8h30 — os três confirmam chegada.
      await setClock('08:30');
      for (const p of [rt, jt, tt]) {
        await p.reload();
        await p.getByTestId('arrive-button').click();
        await expect(p.getByTestId('presence-status')).toContainText('Presente desde');
      }
      await setClock('09:00');

      // 2. Ricardo inicia a montagem e pede ajudante (parafusar, 30 min).
      await rt.getByRole('button', { name: 'Abrir Montagem da estrutura' }).first().click();
      await rt.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
      await expect(rt.getByTestId('my-task-detail')).toContainText('Em execução');
      const help = rt.getByTestId('help-panel');
      await help.getByRole('button', { name: 'Solicitar ajudante' }).click();
      const form = rt.getByTestId('help-form');
      await form.getByRole('button', { name: 'Parafusar estrutura' }).click();
      await expect(form).toContainText('sugestão: 20 min');
      await form.getByRole('button', { name: '30 min' }).click();
      await evidence(rt, '01-tablet-solicitar-ajudante');
      await form.getByRole('button', { name: 'Pedir ajuda' }).click();
      // Os dois estão livres: o João é escolhido (o Thiago fica preservado).
      await expect(help).toContainText('João vai ajudar');
      await expect(help).toContainText('Parafusar estrutura · 30 min');
      await evidence(rt, '02-tablet-ajudante-a-caminho');

      const done = async (p: Page, title: string | RegExp) => {
        const card = p
          .getByTestId('my-tasks-today')
          .locator('[data-testid^="my-task-"]')
          .filter({ hasText: title });
        await card.getByRole('button', { name: 'Concluir' }).click();
        await card.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
        await expect(card).toHaveCount(0);
      };

      // 3. João recebe o apoio no Meu dia (tempo real), inicia e conclui.
      const support = jt
        .getByTestId('my-tasks-today')
        .locator('[data-testid^="my-task-"]')
        .filter({ hasText: 'Apoio para Ricardo' });
      await expect(support).toBeVisible();
      await expect(jt.getByTestId('notifications-unread')).not.toHaveText('0');
      await expect(jt.getByText(/R\$/)).toHaveCount(0);
      await evidence(jt, '03-tablet-joao-apoio-recebido');
      await support.getByRole('button', { name: 'Iniciar' }).click();
      await expect(jt.getByTestId('current-task')).toContainText('Apoio: Parafusar estrutura');
      await expect(help).toContainText('João está ajudando');
      await done(jt, 'Apoio: Parafusar estrutura');
      await expect(help).toContainText('Apoio concluído por João');
      // A montagem do Ricardo continua com ele, em execução.
      await expect(rt.getByTestId('my-task-detail')).toContainText('Em execução');

      // 4. Painel: pedido concluído com a avaliação dos candidatos.
      await page.goto('/painel/ajuda');
      await page.getByRole('tab', { name: /Concluídas/ }).click();
      const row = page.locator('[data-testid^="help-row-"]').filter({ hasText: 'Ricardo' }).first();
      await expect(row).toContainText('Parafusar estrutura · 30 min');
      await row.getByRole('button', { name: 'Detalhes' }).click();
      const candidates = page.getByTestId('candidates').first();
      await expect(candidates).toContainText('João');
      await expect(candidates).toContainText('Thiago');
      await expect(candidates).toContainText('Elegível');
      await evidence(page, '04-painel-pedido-avaliacao');
      await page.keyboard.press('Escape');

      // 5. Ambos ocupados: João num novo apoio (Movimentar) e Thiago na cabeceira.
      await rt
        .getByTestId('help-panel')
        .getByRole('button', { name: 'Solicitar ajudante' })
        .click();
      await rt.getByTestId('help-form').getByRole('button', { name: 'Movimentar sofá' }).click();
      await rt.getByTestId('help-form').getByRole('button', { name: 'Pedir ajuda' }).click();
      await expect(rt.getByTestId('help-panel')).toContainText('João vai ajudar');
      const support2 = jt
        .getByTestId('my-tasks-today')
        .locator('[data-testid^="my-task-"]')
        .filter({ hasText: 'Apoio: Movimentar sofá' });
      await support2.getByRole('button', { name: 'Iniciar' }).click();
      await expect(jt.getByTestId('current-task')).toContainText('Movimentar sofá');
      await tt
        .getByTestId('my-tasks-today')
        .locator('[data-testid^="my-task-"]')
        .filter({ hasText: 'Cabeceira estofada' })
        .getByRole('button', { name: 'Iniciar' })
        .click();
      await expect(tt.getByTestId('current-task')).toContainText('Cabeceira estofada');

      // 6. "Preciso de ajuda agora" no acabamento: ninguém livre → vai ao gestor.
      await rt.goto('/tablet');
      await rt.getByRole('button', { name: 'Abrir Acabamento lateral' }).first().click();
      await rt
        .getByTestId('help-panel')
        .getByRole('button', { name: 'Preciso de ajuda agora' })
        .click();
      const urgent = rt.getByTestId('help-form-urgent');
      await urgent.getByRole('button', { name: 'Virar ou posicionar peça' }).click();
      await urgent.getByTestId('help-justification').fill('Peça escorregando da bancada');
      await evidence(rt, '05-tablet-ajuda-urgente');
      await urgent.getByRole('button', { name: 'Pedir ajuda agora' }).click();
      await expect(rt.getByTestId('help-panel')).toContainText('Encaminhado ao gestor');
      // Nada foi interrompido sem aprovação.
      await expect(tt.getByTestId('current-task')).toContainText('Cabeceira estofada');

      // 7. Gestor decide em Reprogramação: pausar a cabeceira do Thiago para o apoio.
      await page.goto('/painel/reprogramacao');
      const proposal = page
        .locator('[data-testid^="proposal-"]')
        .filter({ hasText: `${RICARDO} pediu ajuda urgente` });
      await expect(proposal).toContainText('Crítica');
      await expect(proposal).toContainText('Pausar');
      await expect(proposal).toContainText('Thiago');
      await expect(proposal).toContainText('Manter na fila');
      await evidence(page, '06-painel-proposta-critica');
      await proposal.getByRole('button', { name: /^Aprovar:/ }).click();
      await expect(proposal).toHaveCount(0);

      // Thiago: cabeceira pausada (interrupção programada) e apoio recebido; Ricardo avisado.
      const support3 = tt
        .getByTestId('my-tasks-today')
        .locator('[data-testid^="my-task-"]')
        .filter({ hasText: 'Apoio para Ricardo' });
      await expect(support3).toBeVisible();
      await expect(tt.getByTestId('my-day')).toContainText('Interrupção programada');
      await expect(rt.getByTestId('help-panel')).toContainText('Thiago vai ajudar');
      await evidence(tt, '07-tablet-thiago-apoio-aprovado');

      // 8. Histórico: atribuição automática e decisão do gestor (quem, quando, por quê).
      await page.getByRole('tab', { name: 'Histórico de alterações' }).click();
      const history = page.getByTestId('planning-history');
      await expect(history).toContainText('Ajudante atribuído automaticamente');
      await expect(history).toContainText('Reprogramação aprovada e aplicada');
      await expect(history).toContainText('Automática');
      await evidence(page, '08-painel-historico');

      // 9. Competências e quadro de produção com o apoio vinculado.
      await page.goto('/painel/competencias');
      await expect(page.getByTestId('skills-João')).toBeVisible();
      await expect(page.getByTestId('skills-Thiago')).toContainText('Cabeceiras');
      await evidence(page, '09-painel-competencias');
      await page.goto('/painel/producao');
      await expect(page.getByText(/Apoio para Ricardo/).first()).toBeVisible();

      // Encerramento: apoios concluídos, cabeceira retomada e concluída, tarefas do Ricardo concluídas.
      await support3.getByRole('button', { name: 'Iniciar' }).click();
      await expect(tt.getByTestId('current-task')).toContainText('Apoio');
      await done(tt, 'Apoio para Ricardo');
      await done(jt, 'Apoio: Movimentar sofá');
      for (const id of [montagem.id, acabamento.id, cabeceira.id]) {
        const t = await call(page, 'GET', `/api/v1/production-tasks/${id}`);
        if (t.status !== 'CONCLUIDA')
          await call(page, 'POST', `/api/v1/production-tasks/${id}/cancel`, {
            reason: 'Fim do teste da Fase 8',
          });
      }
      await ricardo.context.close();
      await joao.context.close();
      await thiago.context.close();
    } finally {
      await setClock(null).catch(() => undefined);
      await setDays(page, [1, 2, 3, 4, 5]).catch(() => undefined);
    }
  });
});
