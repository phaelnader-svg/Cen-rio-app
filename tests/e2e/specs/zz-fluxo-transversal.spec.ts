import { expect, test, type Browser, type Page, type WebSocket } from '@playwright/test';
import pg from 'pg';
import { E2E, rootEnv } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Remediação pós-auditoria, Rodada 4 — E2E TRANSVERSAL (dados exclusivamente fictícios; nenhum
 * pagamento real). Um único serviço percorre o sistema inteiro pelas fontes reais (telas e API
 * do produto; nenhuma transição gravada direto no banco — o banco só é LIDO, para provar o que
 * NÃO foi gravado):
 *
 *   cliente → Novo serviço → pedido → retirada (celular do André) → coleta → recebimento físico
 *   (tablet do João) → OS automática → medição → necessidade → compra → recebimento do material
 *   com conferência técnica (tablet do Thiago) → material liberado → A planejar → publicação →
 *   tablets → início → execução das tarefas do modelo simplificado (João prepara; o titular faz
 *   corte/costura e montagem) → qualidade (Thiago) → embalagem (João) → pronto para entrega →
 *   entrega real (André) → obrigação financeira (DEVIDO) → Meus Ganhos (PIN, D12) → confirmação
 *   da semana (D13) → pagamento → Central sem as pendências resolvidas.
 *
 * Cenário de invalidação (D13): depois de um pagamento parcial, um ajuste muda a semana → a
 * confirmação antiga deixa de valer → o pagamento é recusado → nova confirmação → pagamento.
 *
 * Privacidade com dois profissionais (A titular, B sem ganhos neste serviço): Meus Ganhos só de
 * si; B não recebe o `finance.own_changed` de A; os tablets não recebem eventos financeiros
 * gerenciais; o `finance.own_changed` não leva valores; o desbloqueio D12 de A não abre o de B;
 * sessão de tablet não usa rotas do painel.
 *
 * Isolamento: os profissionais A e B são criados aqui (nomes únicos por execução); o relógio de
 * teste fica num dia próprio (+105) só durante a execução das tarefas — presença do João e do
 * Thiago nesse dia não colide com outras especificações.
 */
const origin = `http://localhost:${E2E.webPort}`;
const TZ = 'America/Sao_Paulo';
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
/** Dia próprio da execução (nenhuma outra especificação usa +105). */
const DAY = addDays(today(), 105);
const DAY_WEEK = mondayOf(DAY);
/** Semana financeira: a da competência real (a obrigação fica devida na data real). */
const WEEK = mondayOf(today());
const atLocal = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-03:00`).toISOString();
const RUN = Date.now().toString(36).slice(-5);
const NAME_A = `Tapeceiro A ${RUN}`;
const NAME_B = `Tapeceiro B ${RUN}`;
const CUSTOMER = `Cliente Transversal ${RUN}`;
const SUPPLIER = `Tecidos Transversal ${RUN}`;
const PIN_A = '615243';
const PIN_B = '624351';
const LABOR = 45000; // R$ 450,00 — mão de obra prevista no Novo serviço

const ACT: Record<string, string> = {
  DESMONTAGEM: 'Desmontagem',
  PREPARACAO: 'Preparação',
  CORTE: 'Corte',
  CORTE_TECIDO: 'Corte de tecido',
  COSTURA: 'Costura',
  REVESTIMENTO: 'Revestimento',
  MONTAGEM: 'Montagem',
  ACABAMENTO: 'Acabamento',
};
const idem = () => crypto.randomUUID().replace(/-/g, '');
async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': idem() },
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

/** Concede uma permissão individual pelo cadastro do funcionário (fluxo existente). */
async function grant(page: Page, displayName: string, permission: string) {
  const list = await call(page, 'GET', '/api/employees');
  const summary = list.find((e: { displayName: string }) => e.displayName === displayName);
  const e = await call(page, 'GET', `/api/employees/${summary.id}`);
  if (e.extraPermissions.includes(permission)) return;
  await call(page, 'PUT', `/api/employees/${e.id}`, {
    fullName: e.fullName,
    displayName: e.displayName,
    jobTitle: e.jobTitle,
    color: e.color,
    roleIds: e.roles.map((r: { id: string }) => r.id),
    extraPermissions: [...e.extraPermissions, permission],
    version: e.version,
  });
}

const eventsIn = (frames: string[]) =>
  frames.flatMap((f) => {
    try {
      const m = JSON.parse(f) as { type?: string; event?: { type?: string; payload?: unknown } };
      return m.event?.type ? [{ type: m.event.type, payload: m.event.payload, raw: f }] : [];
    } catch {
      return [];
    }
  });

async function openDevice(
  page: Page,
  browser: Browser,
  who: string,
  pin: string,
  label: string,
  device?: { width: number; height: number; isMobile?: boolean },
) {
  await setPin(page, who, pin);
  const code = await registerDevice(page, label, who);
  // Os quadros do tempo real são registrados desde a primeira página do contexto.
  const frames: string[] = [];
  const t = await openTablet(browser, code, pin, device, {}, async (ctx) => {
    ctx.on('page', (p) => recordInto(p, frames));
  });
  return { ...t, frames };
}
/** Registra os quadros do tempo real recebidos por uma página (tablet). */
function recordInto(p: Page, frames: string[]) {
  p.on('websocket', (ws: WebSocket) =>
    ws.on('framereceived', (f) => frames.push(String(f.payload))),
  );
}

test.describe.serial('Rodada 4 — fluxo transversal completo', () => {
  test('do Novo serviço ao pagamento, com D12/D13, privacidade e Central', async ({
    page,
    browser,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (hhmm: string | null) =>
      call(page, 'POST', '/api/test/clock', { now: hhmm ? atLocal(hhmm) : null });
    const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
    await db.connect();
    let planId = '';
    try {
      // ───────────── 0. Profissionais sintéticos A e B (cadastro do produto) ─────────────
      const roles = (await call(page, 'GET', '/api/roles')) as { id: string; key: string }[];
      const tapeceiro = roles.find((r) => r.key === 'tapeceiro')!;
      const mk = (displayName: string, pin: string, color: string) =>
        call(page, 'POST', '/api/employees', {
          fullName: `${displayName} Fictício`,
          displayName,
          jobTitle: 'Tapeceiro',
          color,
          roleIds: [tapeceiro.id],
          extraPermissions: [],
          pin,
        });
      const A = await mk(NAME_A, PIN_A, '#2563eb');
      const B = await mk(NAME_B, PIN_B, '#16a34a');
      const userA = A.userId as string;
      const userB = B.userId as string;

      const defaults = await call(page, 'GET', '/api/v1/finance/logistics-defaults');
      const ANDRE = (defaults.people as { userId: string; displayName: string }[]).find((p) =>
        p.displayName.startsWith('André'),
      )!;
      await call(page, 'PUT', '/api/v1/finance/logistics-defaults', {
        defaultPickupCostCents: 10000,
        defaultDeliveryCostCents: defaults.defaultDeliveryCostCents ?? 12000,
        logisticsPayeeUserId: ANDRE.userId,
      });

      // ───────────── 1. Cliente → Novo serviço → pedido + retirada (tela) ─────────────
      await page.goto('/painel/servicos/novo');
      const form = page.getByTestId('new-service-form');
      await page.getByTestId('ns-mode-new').click();
      await page.getByTestId('ns-name').fill(CUSTOMER);
      await page.getByTestId('ns-phone').fill(`(11) 9${String(Date.now()).slice(-8)}`);
      await form.getByLabel('Logradouro').fill('Rua Transversal Fictícia');
      await form.getByLabel('Número').fill('105');
      await form.getByLabel('Cidade').fill('Cidade Teste');
      await page.getByTestId('ns-piece-desc-0').fill('Sofá transversal');
      await page.getByTestId('ns-piece-service-0').selectOption('REFORMA_COMPLETA');
      await page.getByTestId('ns-piece-owner-0').selectOption(userA);
      await page.getByTestId('ns-piece-labor-0').fill('450,00');
      await page
        .getByTestId('ns-promised')
        .fill(new Date(Date.now() + 150 * 86_400_000).toISOString().slice(0, 10));
      await page.getByTestId('ns-value').fill('3.000,00');
      await page.getByTestId('ns-date').fill(today());
      await page.getByTestId('ns-arrival').fill('10:00');
      await expect(page.getByTestId('ns-responsible')).toHaveValue(ANDRE.userId);
      await page.getByTestId('ns-submit').click();
      await expect(page.getByTestId('ns-confirmation')).toContainText('Aguardando retirada');
      await page.getByTestId('ns-open-order').click();
      await expect(page).toHaveURL(/\/painel\/pedidos\/[0-9a-f-]{36}$/);
      const orderId = page.url().split('/').pop()!;
      const pickup = (await call(page, 'GET', `/api/v1/pickups?orderId=${orderId}`))[0] as {
        id: string;
        code: string;
      };

      // ───────────── 2. Retirada → coleta (celular do André) ─────────────
      const andre = await openDevice(page, browser, 'André', '640218', `Celular André ${RUN}`, {
        width: 390,
        height: 844,
        isMobile: true,
      });
      const pjob = andre.page.getByTestId(`job-${pickup.code}`);
      await expect(pjob).toBeVisible();
      await expect(andre.page.getByText(/R\$/)).toHaveCount(0);
      await pjob.getByRole('button', { name: 'Saí para a retirada' }).click();
      await expect(pjob.getByTestId('job-status')).toHaveText('Em execução');
      await pjob.getByRole('button', { name: 'Peças retiradas' }).click();
      await expect(pjob.getByTestId('job-status')).not.toHaveText('Em execução');

      // ───── TRANSIÇÃO 1 (coleta → recebimento): chegada física confirmada no tablet do João ─────
      const joao = await openDevice(page, browser, 'João', '591837', `Tablet João ${RUN}`);
      await joao.page.getByTestId('tile-arrivals').click();
      const arrival = joao.page.getByTestId(`arrival-piece-${pickup.code}`);
      await expect(arrival).toBeVisible();
      await arrival.getByRole('button', { name: 'Confirmar chegada' }).click();
      await joao.page.getByTestId('arrival-submit').click();
      const arrivalDone = joao.page.getByTestId('arrival-done');
      await expect(arrivalDone.getByTestId('arrival-done-os')).toContainText(/OS-\d{5}/);
      const osCode = (await arrivalDone.getByTestId('arrival-done-os').textContent())!.match(
        /OS-\d{5}/,
      )![0];
      await joao.page.getByRole('button', { name: 'Voltar ao Aguardando chegada' }).click();

      // OS automática: titular e mão de obra prevista viraram titular e mão de obra combinada.
      const sos = await call(page, 'GET', `/api/v1/service-orders?orderId=${orderId}`);
      const soId = ((sos.items ?? sos) as { id: string; code: string }[]).find(
        (s) => s.code === osCode,
      )!.id;
      const so = await call(page, 'GET', `/api/v1/service-orders/${soId}`);
      const sofa = so.items[0] as { id: string; code: string };
      const labor = (await call(page, 'GET', `/api/v1/finance/labor?serviceOrderId=${soId}`)) as {
        id: string;
        code: string;
        status: string;
        agreedCents: number;
        professional: { userId: string };
      }[];
      expect(labor).toHaveLength(1);
      expect(labor[0]!).toMatchObject({ status: 'PREVISTO', agreedCents: LABOR });
      expect(labor[0]!.professional.userId).toBe(userA);
      const laborCode = labor[0]!.code;

      // ───── TRANSIÇÃO 2 (OS automática → medição): medição pela tela da OS ─────
      await page.goto(`/painel/os/${soId}`);
      await page.getByRole('button', { name: 'Solicitar medição' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Atribuir medição' }).click();
      await page.getByRole('button', { name: 'Medir agora' }).click();
      await page.getByRole('button', { name: 'Próximo' }).click();
      await page.getByRole('button', { name: 'Adicionar tecido' }).click();
      await page.getByLabel('Tecido (nome ou referência)').fill('Veludo');
      await page.getByLabel('Cor').fill('Grafite');
      await page.getByLabel('Metragem (m)').fill('8');
      await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
      await page.getByRole('button', { name: 'Próximo' }).click();
      await page.getByRole('button', { name: 'Próximo' }).click();
      await page.getByRole('button', { name: 'Próximo' }).click();
      await page.getByRole('button', { name: 'Enviar medição' }).click();
      await expect(page.getByTestId('measurement-badges')).toContainText('Materiais: enviada');
      // Necessidade: revisão e aprovação para compra.
      await page.getByRole('button', { name: 'Iniciar revisão' }).click();
      await page.getByRole('button', { name: 'Aprovar para compra' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Aprovar' }).click();
      await expect(page.getByText('Quantidades conferidas e aprovadas para compra')).toBeVisible();

      // Compra: fornecedor + pedido de compra a partir da necessidade.
      await page.goto('/painel/fornecedores');
      await page.getByRole('button', { name: 'Novo fornecedor' }).click();
      await page.getByRole('dialog').getByLabel('Nome ou razão social').fill(SUPPLIER);
      await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
      await expect(page.getByTestId(`supplier-${SUPPLIER}`)).toBeVisible();
      await page.goto('/painel/compras');
      await page.getByLabel(`Selecionar Veludo da ${osCode}`).check();
      await page.getByRole('button', { name: /Criar pedido de compra \(1\)/ }).click();
      await page.getByLabel('Fornecedor').selectOption({ label: SUPPLIER });
      await page.getByTestId('po-line-1').getByLabel('Preço unitário').fill('52,00');
      await page.getByRole('button', { name: 'Salvar rascunho' }).click();
      await expect(
        page.getByRole('heading', { name: /^Pedido de compra CP-\d{5}$/ }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Confirmar pedido' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
      await expect(page.getByTestId('po-status')).toContainText('Confirmado');

      // ───── TRANSIÇÃO 3 (material recebido/conferido → liberação): tablet do Thiago ─────
      await grant(page, 'Thiago', 'estoque.conferir');
      const thiago = await openDevice(page, browser, 'Thiago', '271828', `Tablet Thiago ${RUN}`);
      await thiago.page.getByTestId('tile-materials').click();
      const receivable = thiago.page
        .getByTestId('pending-receipts')
        .getByRole('button')
        .filter({ hasText: SUPPLIER });
      await receivable.first().click();
      await expect(thiago.page.getByText(/R\$/)).toHaveCount(0);
      const veludo = thiago.page.getByTestId('receive-item-Veludo');
      await veludo.getByLabel('Recebido em ordem').fill('8');
      await veludo.getByLabel('Conferi referência, cor e especificação').check();
      await thiago.page.getByRole('button', { name: 'Confirmar recebimento' }).click();
      await expect(thiago.page.getByTestId('material-receipt-done')).toContainText(
        /Recebimento RM-\d{5} registrado/,
      );
      await page.goto(`/painel/os/${soId}`);
      await page.getByRole('tab', { name: /Materiais/ }).click();
      await expect(page.getByTestId('os-readiness-state')).toHaveText('Completo');

      // ───────────── Planejamento: A planejar → data própria → publicação ─────────────
      // Relógio de teste no dia próprio (+105) antes de planejar: a liberação das tarefas é
      // avaliada pelo relógio operacional na publicação.
      await setDays(page, [0, 1, 2, 3, 4, 5, 6]);
      await setClock('08:20');
      await page.goto('/painel/producao/a-planejar');
      const row = page.getByTestId(`to-plan-${osCode}`);
      await expect(row).toContainText(CUSTOMER);
      await row.getByTestId('plan-one').click();
      const entry = page.getByTestId(`plan-entry-${osCode}`);
      await entry.getByTestId('plan-start').fill(DAY);
      // O titular previsto no Novo serviço chegou à OS e vem travado no planejamento.
      await expect(entry.getByTestId(`plan-owner-${sofa.code}`)).toHaveValue(userA);
      await page.getByTestId('plan-submit').click();
      await expect(row).toHaveCount(0);
      await page.getByRole('tab', { name: /Planejados/ }).click();
      await page.getByTestId(`week-${DAY_WEEK}`).getByTestId('publish-week').click();
      await expect(page.getByTestId('publish-preview')).toContainText(NAME_A);
      await page.getByTestId('publish-confirm').click();
      await expect(page.getByTestId('publish-preview')).toHaveCount(0);
      const pipe = await call(page, 'GET', '/api/v1/production/pipeline');
      planId = pipe.items.find((i: { serviceOrder: { id: string } }) => i.serviceOrder.id === soId)
        .plan.planId;
      const plan = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
      const sofaTasks = (
        plan.tasks as {
          title: string;
          status: string;
          serviceOrderItem: { id: string } | null;
          assignee: { userId: string; displayName: string } | null;
        }[]
      ).filter((t) => t.serviceOrderItem?.id === sofa.id);
      // Modelo simplificado da reforma: preparação (João) + 2 etapas do titular (A).
      expect(sofaTasks.map((t) => [t.title.split(' — ')[0], t.assignee?.displayName])).toEqual([
        ['Desmontagem e preparação', 'João'],
        ['Corte e costura', NAME_A],
        ['Montagem e acabamento', NAME_A],
      ]);

      // ───── TRANSIÇÃO 4 (tablet → execução das tarefas do modelo simplificado) ─────
      const a = await openDevice(page, browser, NAME_A, PIN_A, `Tablet ${NAME_A}`);
      const b = await openDevice(page, browser, NAME_B, PIN_B, `Tablet ${NAME_B}`);
      await setClock('08:30');
      for (const t of [a, joao, thiago]) {
        await t.page.reload();
        await t.page.getByTestId('arrive-button').click();
        await expect(t.page.getByTestId('presence-status')).toContainText('Presente desde');
      }
      await setClock('09:00');
      // Cartão da tarefa no Meu dia — na fila semanal ou em "Tarefas de hoje".
      const myCard = (p: Page, text: string | RegExp) =>
        p
          .locator('[data-testid^="my-task-"]')
          .filter({ hasText: text })
          .filter({ hasText: osCode });
      // Execução pelo tablet ("Minha semana"): a próxima tarefa da fila é iniciada e concluída.
      const startAndComplete = async (p: Page, title: RegExp) => {
        const hl = p.getByTestId('week-highlight');
        await expect(async () => {
          await p.reload();
          await expect(hl).toContainText(title, { timeout: 5_000 });
        }).toPass({ timeout: 30_000 });
        await expect(hl).toContainText(osCode);
        await hl.getByRole('button', { name: 'Iniciar' }).click();
        await expect(p.getByRole('heading', { name: 'Em execução agora' })).toBeVisible();
        await hl.getByRole('button', { name: 'Concluir' }).click();
        await hl.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
        await expect
          .poll(async () => {
            const pl = await call(page, 'GET', `/api/v1/production-plans/${planId}`);
            return (
              pl.tasks as {
                activity: string;
                status: string;
                serviceOrderItem: { id: string } | null;
              }[]
            )
              .filter(
                (t) => t.serviceOrderItem?.id === sofa.id && title.test(ACT[t.activity] ?? ''),
              )
              .map((t) => t.status);
          })
          .toEqual(['CONCLUIDA']);
      };
      await startAndComplete(joao.page, /Desmontagem/);
      await startAndComplete(a.page, /Corte|Costura/);
      await startAndComplete(a.page, /Montagem|Acabamento/);
      // B não vê nenhuma tarefa deste serviço.
      const bQueue = await (await b.page.request.get('/api/v1/production-tasks/mine/queue')).json();
      expect(JSON.stringify(bQueue)).not.toContain(osCode);

      // ───────────── Qualidade (Thiago) → aprovação ─────────────
      await thiago.page.reload();
      await thiago.page.getByTestId('tile-inspections').click();
      const insp = thiago.page
        .locator('[data-testid^="inspection-IQ-"]')
        .filter({ hasText: sofa.code });
      await insp.click();
      const detail = thiago.page.getByTestId('inspection-detail');
      await detail.getByRole('button', { name: 'Iniciar inspeção' }).click();
      const checks = detail.getByTestId('checklist').locator('[data-testid^="check-"]');
      await expect(checks.first()).toBeVisible();
      for (let i = 0; i < (await checks.count()); i += 1) {
        await checks.nth(i).getByRole('button', { name: 'Conforme', exact: true }).click();
        await expect(checks.nth(i)).toHaveAttribute('data-result', 'OK');
      }
      await detail
        .getByTestId('inspection-decision')
        .getByRole('button', { name: 'Aprovar' })
        .click();
      await expect(detail.getByTestId('inspection-status')).toContainText('Aprovada');

      // Obrigação financeira: aprovação na qualidade → mão de obra DEVIDA (liberada).
      await expect
        .poll(
          async () =>
            (
              (await call(page, 'GET', `/api/v1/finance/labor?serviceOrderId=${soId}`)) as {
                status: string;
              }[]
            )[0]!.status,
        )
        .toBe('LIBERADO');

      // ───────────── Embalagem (João) → pronto para entrega ─────────────
      await joao.page.reload();
      const pack = myCard(joao.page, /Embalar/);
      await expect(pack).toBeVisible();
      await pack
        .getByRole('button', { name: /^Abrir/ })
        .first()
        .click();
      await joao.page.getByTestId('task-actions').getByRole('button', { name: 'Iniciar' }).click();
      const panel = joao.page.getByTestId('packaging-panel');
      await panel.getByRole('button', { name: 'Plástico bolha' }).click();
      await panel.getByLabel('Onde a peça ficou').selectOption({ label: 'Expedição' });
      await panel.getByRole('button', { name: 'Concluir embalagem' }).click();
      await expect(joao.page.getByText('Embalagem concluída').first()).toBeVisible();
      await setClock(null);

      // ───── TRANSIÇÃO 5a (pronto → entrega real): agenda no painel, entrega no celular ─────
      await page.goto('/painel/entregas');
      await page.getByRole('tab', { name: /Prontas para entrega/ }).click();
      const ready = page.getByTestId(`ready-${sofa.code}`);
      await expect(ready).toContainText('Expedição');
      await page
        .getByTestId('ready-pieces')
        .locator('div')
        .filter({ has: ready })
        .getByRole('button', { name: 'Agendar entrega' })
        .first()
        .click();
      const dlg = page.getByRole('dialog');
      await dlg.getByLabel('Data do compromisso').fill(today());
      await dlg.getByLabel('Horário de chegada ao cliente').fill('23:00');
      await dlg.getByLabel('Responsável pela execução').selectOption({ label: 'André' });
      const aware = dlg.getByLabel('Estou ciente do saldo pendente');
      if (await aware.count()) await aware.check();
      await dlg.getByRole('button', { name: 'Agendar', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      await andre.page.reload();
      const djob = andre.page.locator('[data-testid^="job-EN-"]').filter({ hasText: CUSTOMER });
      await expect(djob).toBeVisible();
      await djob.getByRole('button', { name: 'Saí para entrega' }).click();
      await expect(djob.getByTestId('job-status')).toHaveText('Em transporte');
      await djob.getByRole('button', { name: 'Cheguei ao destino' }).click();
      await djob.getByRole('button', { name: 'Confirmar peças' }).click();
      await djob.getByRole('button', { name: 'Registrar peças' }).click();
      await djob.getByRole('button', { name: 'Concluir entrega' }).click();
      await expect(djob.getByTestId('job-status')).toHaveText('Concluída');
      expect((await call(page, 'GET', `/api/v1/pieces/${sofa.id}`)).stage).toBe('ENTREGUE');
      await andre.context.close();

      // ───── TRANSIÇÃO 5b (entrega → Meus Ganhos): A desbloqueia com o PIN (D12) ─────
      const unlockUi = async (p: Page, pin: string) => {
        await p.reload();
        await p.getByTestId('tile-values').click();
        await p.getByTestId('my-values-pin').fill(pin);
        await p.getByTestId('my-values-unlock').click();
        await expect(p.getByTestId('my-values')).toBeVisible();
      };
      await unlockUi(a.page, PIN_A);
      const mine = a.page.getByTestId(`my-value-${laborCode}`);
      await expect(mine).toContainText('R$ 450,00');
      await expect(a.page.getByTestId(`my-value-terms-${laborCode}`)).toContainText('devido');

      // Privacidade: B vê só os próprios ganhos (nada de A) — pela tela e pela API.
      await unlockUi(b.page, PIN_B);
      await expect(b.page.getByTestId(`my-value-${laborCode}`)).toHaveCount(0);
      await expect(b.page.getByTestId('my-values')).not.toContainText('450,00');
      const unlockApi = async (p: Page, pin: string) =>
        (
          await (
            await p.request.post('/api/v1/finance/my-earnings/unlock', {
              data: { pin },
              headers: { origin },
            })
          ).json()
        ).unlockToken as string;
      const tokA = await unlockApi(a.page, PIN_A);
      const tokB = await unlockApi(b.page, PIN_B);
      const earnings = (p: Page, token: string, week = WEEK) =>
        p.request.get(`/api/v1/finance/my-earnings?week=${week}`, {
          headers: { 'x-earnings-unlock': token },
        });
      const bBody = await (await earnings(b.page, tokB)).text();
      // E o inverso: os ganhos de A não trazem nada de B.
      expect(await (await earnings(a.page, tokA)).text()).not.toContain(userB);
      expect(bBody).not.toContain(laborCode);
      expect(bBody).not.toContain(userA);
      // O desbloqueio D12 de A não abre o Meus Ganhos de B (nem em outra sessão).
      expect((await earnings(b.page, tokA)).status()).toBe(403);
      // Sem desbloqueio: recusado.
      expect((await a.page.request.get(`/api/v1/finance/my-earnings?week=${WEEK}`)).status()).toBe(
        403,
      );
      // Sessão de tablet não usa rotas do painel (WEB).
      for (const path of [
        `/api/v1/finance/weekly-closings/${WEEK}`,
        `/api/v1/finance/labor?serviceOrderId=${soId}`,
        '/api/v1/attention',
        '/api/employees',
      ])
        expect((await a.page.request.get(path)).status(), path).toBe(403);
      // PIN nunca guardado em claro (só o hash do cadastro) e nunca no histórico de auditoria.
      const pinLeak = await db.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE changes::text LIKE $1 OR summary LIKE $1`,
        [`%${PIN_A}%`],
      );
      expect(pinLeak.rows[0].n).toBe(0);
      const pinRow = await db.query(`SELECT pin_hash FROM users WHERE id = $1`, [userA]);
      expect(pinRow.rows[0].pin_hash).not.toContain(PIN_A);

      // ───── TRANSIÇÃO 5c (Meus Ganhos → confirmação D13) ─────
      const ownChangedBefore = eventsIn(b.frames).filter(
        (e) => e.type === 'finance.own_changed',
      ).length;
      await a.page.getByTestId('week-confirm-open').click();
      await expect(a.page.getByTestId('week-confirm-panel')).toContainText(laborCode);
      await a.page.getByTestId('week-confirm-check').check();
      await a.page.getByTestId('week-confirm-submit').click();
      await expect(a.page.getByTestId('week-confirmation-state')).toHaveText(
        'Confirmada pelo profissional',
      );
      // Snapshot + hash da semana gravados; evidência do D12 sem PIN, token ou assinatura.
      const conf1 = await db.query(
        `SELECT id, hash, items, kind FROM weekly_closing_confirmations
          WHERE beneficiary_user_id = $1 AND week_start = $2 ORDER BY created_at`,
        [userA, WEEK],
      );
      expect(conf1.rows).toHaveLength(1);
      expect(conf1.rows[0].kind).toBe('PROFISSIONAL');
      expect(conf1.rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(conf1.rows[0].items)).toContain(laborCode);
      const confAudit = await db.query(
        `SELECT changes::text AS a FROM audit_logs WHERE entity_id = $1`,
        [conf1.rows[0].id],
      );
      const auditText = confAudit.rows.map((r) => r.a).join('\n');
      expect(auditText).toContain('PIN_D12');
      expect(auditText).not.toContain(PIN_A);
      expect(auditText).not.toContain(tokA);
      expect(auditText).not.toContain(tokA.split('.')[1]!);

      // ───── TRANSIÇÃO 5d (confirmação → pagamento): parcial de R$ 200,00 no Fechamento ─────
      await page.goto(`/painel/financeiro?tab=fechamento&semana=${WEEK}&profissional=${userA}`);
      const aRow = page.getByTestId(`closing-row-${NAME_A}-TAPECARIA`);
      await expect(aRow.getByTestId(`closing-confirmation-${NAME_A}-TAPECARIA`)).toContainText(
        'Confirmada pelo profissional',
      );
      await aRow.getByTestId('closing-pay').click();
      const pay = page.getByRole('dialog');
      await pay.getByTestId('closing-pay-amount').fill('200,00');
      await pay.getByTestId('closing-pay-review').click();
      await expect(pay.getByTestId('closing-pay-summary')).toContainText('R$ 200,00');
      await pay.getByTestId('closing-pay-confirm').click();
      await expect(page.getByTestId('closing-payments')).toContainText('R$ 200,00');
      type Row = {
        beneficiary: { userId: string | null };
        category: string;
        currentOpenCents: number;
      };
      const openOf = async () =>
        ((await call(page, 'GET', `/api/v1/finance/weekly-closings/${WEEK}`)).rows as Row[]).find(
          (r) => r.beneficiary.userId === userA && r.category === 'TAPECARIA',
        )!.currentOpenCents;
      await expect.poll(openOf).toBe(LABOR - 20000);

      // ───── Invalidação D13: ajuste muda a semana → confirmação antiga não vale → bloqueio ─────
      const laborNow = (
        (await call(page, 'GET', `/api/v1/finance/labor?serviceOrderId=${soId}`)) as {
          id: string;
          version: number;
        }[]
      )[0]!;
      await call(page, 'POST', `/api/v1/finance/labor/${laborNow.id}/adjustments`, {
        amountCents: 5000,
        reason: 'Acréscimo combinado (E2E transversal)',
        version: laborNow.version,
      });
      // A recebe o aviso "seus ganhos mudaram" ao vivo, SEM valores; B não recebe nada de A.
      await expect
        .poll(() => eventsIn(a.frames).filter((e) => e.type === 'finance.own_changed').length)
        .toBeGreaterThan(0);
      for (const e of eventsIn(a.frames).filter((x) => x.type === 'finance.own_changed')) {
        expect(e.raw).not.toMatch(/[Cc]ents|R\$|45000|50000|5000\b/);
        expect(Object.keys((e.payload as object) ?? {})).toEqual(['reason']);
      }
      expect(eventsIn(b.frames).filter((e) => e.type === 'finance.own_changed').length).toBe(
        ownChangedBefore,
      );
      // Tablets não recebem eventos financeiros gerenciais (só o próprio aviso sem valores).
      for (const t of [a, b, joao, thiago])
        for (const e of eventsIn(t.frames))
          if (e.type.startsWith('finance.')) expect(e.type).toBe('finance.own_changed');

      await page.reload();
      await expect(aRow.getByTestId(`closing-confirmation-${NAME_A}-TAPECARIA`)).not.toContainText(
        'Confirmada pelo profissional',
      );
      const blocked = await page.request.post(`/api/v1/finance/weekly-closings/${WEEK}/payments`, {
        data: {
          beneficiaryUserId: userA,
          category: 'TAPECARIA',
          amountCents: 30000,
          paidAt: today(),
          method: 'PIX',
        },
        headers: { origin, 'idempotency-key': idem() },
      });
      expect(blocked.status()).toBe(422);
      expect(await blocked.text()).toMatch(/confirma/i);
      expect(await openOf()).toBe(LABOR + 5000 - 20000);

      // Nova confirmação (novo snapshot) → pagamento do restante liberado e feito.
      await unlockUi(a.page, PIN_A);
      await expect(a.page.getByTestId(`my-value-${laborCode}`)).toContainText('R$ 500,00');
      await a.page.getByTestId('week-confirm-open').click();
      await a.page.getByTestId('week-confirm-check').check();
      await a.page.getByTestId('week-confirm-submit').click();
      await expect(a.page.getByTestId('week-confirmation-state')).toHaveText(
        'Confirmada pelo profissional',
      );
      const conf2 = await db.query(
        `SELECT hash FROM weekly_closing_confirmations
          WHERE beneficiary_user_id = $1 AND week_start = $2 ORDER BY created_at`,
        [userA, WEEK],
      );
      expect(conf2.rows).toHaveLength(2);
      expect(conf2.rows[1].hash).not.toBe(conf2.rows[0].hash);
      await page.reload();
      await aRow.getByTestId('closing-pay').click();
      await pay.getByTestId('closing-pay-amount').fill('300,00');
      await pay.getByTestId('closing-pay-review').click();
      await pay.getByTestId('closing-pay-confirm').click();
      await expect(page.getByTestId('closing-payments')).toContainText('R$ 300,00');
      await expect.poll(openOf).toBe(0);
      await expect
        .poll(
          async () =>
            (
              (await call(page, 'GET', `/api/v1/finance/labor?serviceOrderId=${soId}`)) as {
                status: string;
              }[]
            )[0]!.status,
        )
        .toBe('PAGO');
      // Saldo de A atualizado no Meus Ganhos.
      await unlockUi(a.page, PIN_A);
      await expect(a.page.getByTestId(`my-value-${laborCode}`)).toContainText(/[Pp]ago/);

      // ───────────── Central sem as pendências resolvidas ─────────────
      const attention = (await call(page, 'GET', '/api/v1/attention')) as {
        items: { key: string; serviceOrder: { code: string } | null }[];
      };
      const left = attention.items.filter(
        (i) => i.key.includes(userA) || i.serviceOrder?.code === osCode,
      );
      expect(left.map((i) => i.key)).toEqual([]);
      await page.goto('/painel/atencao?type=FINANCEIRO');
      await expect(page.getByTestId(`attention-FINANCEIRO:confirmacao:${userA}`)).toHaveCount(0);
      await expect(page.getByTestId(`attention-FINANCEIRO:pagamento:${userA}`)).toHaveCount(0);

      for (const t of [a, b, joao, thiago]) await t.context.close();
    } finally {
      await setClock(null).catch(() => undefined);
      await setDays(page, [1, 2, 3, 4, 5]).catch(() => undefined);
      await db.end().catch(() => undefined);
    }
  });
});
