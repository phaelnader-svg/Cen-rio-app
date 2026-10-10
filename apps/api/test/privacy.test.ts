import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, WsClient, createTestApp, idemKey, loginAdmin, resetDatabase } from './helpers';
import { panelUserWith } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { act, addOs, createPlan, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 8 — exposição mínima do cliente nos tablets da produção.
 * A execução de uma tarefa precisa de OS, peça e etapa; o nome completo do cliente não é
 * necessário no tablet (dado pessoal). Regra: sessão DEVICE recebe só o primeiro nome e a
 * inicial do sobrenome ("Maria F."); o painel (WEB) continua com o nome completo. A logística
 * (endereço e nome para entrega/retirada) fica fora desta regra por necessidade operacional.
 */
let app: App;
const sockets: WsClient[] = [];
const FULL = 'Maria Aparecida Fictícia';
const SHORT = 'Maria F.';

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

async function workshop() {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(admin, FULL);
  const ricardo = await userIdOf('Ricardo');
  const marcio = await userIdOf('Márcio');
  const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
  const r = await addOs(admin, plan.id, {
    serviceOrderId: so.id,
    pieces: [
      { serviceOrderItemId: so.items[0].id, upholstererUserId: ricardo },
      { serviceOrderItemId: so.items[1].id, upholstererUserId: marcio },
    ],
  });
  expect(r.status).toBe(201);
  await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  const tabs: Record<string, Client> = {
    joao: await tabletOf(app, admin, 'João', '271828'),
    ricardo: await tabletOf(app, admin, 'Ricardo', '482915'),
    thiago: await tabletOf(app, admin, 'Thiago', '314159'),
  };
  return { admin, so, plan, tabs };
}

describe('Privacidade do cliente no tablet (Fase 8)', () => {
  it('tablet: só “Maria F.” em tarefas, fila, detalhe, ações e WebSocket; painel mantém o nome completo', async () => {
    const { admin, plan, tabs } = await workshop();
    const ws = await WsClient.connect(app, tabs.joao!);
    sockets.push(ws);
    const queue = (await tabs.joao!.get('/api/v1/production-tasks/mine/queue')).body;
    const next = queue.next.id as string;
    const started = await act(tabs.joao!, next, 'start');
    expect(started.status).toBe(200);
    expect(started.body.customerName).toBe(SHORT);
    await act(tabs.joao!, next, 'complete');
    await ws.waitFor((m) => m.event?.type === 'production.task_completed');
    const ricQueue = (await tabs.ricardo!.get('/api/v1/production-tasks/mine/queue')).body;
    const paths = [
      '/api/v1/production-tasks/mine',
      '/api/v1/production-tasks/mine/queue',
      '/api/v1/production-tasks/mine/today',
      `/api/v1/production-tasks/${next}`,
      `/api/v1/production-tasks/${ricQueue.items[0].task.id}`,
      '/api/v1/notifications?limit=50',
      '/api/v1/help-requests/mine',
      '/api/v1/help-requests/support-options',
      '/api/v1/issues/mine',
    ];
    let checked = 0;
    for (const [name, c] of Object.entries(tabs))
      for (const p of paths) {
        const r = await c.get(p);
        if (r.status >= 400) continue;
        checked += 1;
        expect(JSON.stringify(r.body), `${name} ${p}`).not.toContain(FULL);
        expect(JSON.stringify(r.body), `${name} ${p}`).not.toContain('Aparecida');
      }
    expect(checked).toBeGreaterThan(8);
    expect(JSON.stringify(ws.messages)).not.toContain('Aparecida');
    const mine = (await tabs.ricardo!.get('/api/v1/production-tasks/mine/queue')).body;
    expect(mine.items[0].task.customerName).toBe(SHORT);
    // Painel (sessão WEB): nome completo para o gestor.
    const panel = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(JSON.stringify(panel)).toContain(FULL);
    expect((await admin.get(`/api/v1/production-tasks/${next}`)).body.customerName).toBe(FULL);
    // Repetir com a mesma chave de idempotência devolve a mesma forma reduzida.
    const key = idemKey();
    const a = await tabs.ricardo!.post(
      `/api/v1/production-tasks/${mine.items[0].task.id}/start`,
      {},
      { 'idempotency-key': key },
    );
    const b = await tabs.ricardo!.post(
      `/api/v1/production-tasks/${mine.items[0].task.id}/start`,
      {},
      { 'idempotency-key': key },
    );
    expect(a.status).toBe(b.status);
    expect(JSON.stringify(b.body)).not.toContain('Aparecida');
  });

  it('regressão de autorização: rotas das Fases 2–7 recusadas para tablet, painel sem permissão, anônimo e sem Origin', async () => {
    const { admin, tabs } = await workshop();
    const plain = await panelUserWith(app, admin, 'sem-nada', ['entregas.ver']);
    const anon = new Client(app);
    const id = '00000000-0000-4000-8000-000000000000';
    const week = '2026-10-05';
    const routes: [method: 'GET' | 'POST' | 'PUT', path: string, deviceOk?: boolean][] = [
      // Fase 2–3: gestão da fila e da distribuição (tablet só lê a própria fila).
      ['PUT', `/api/v1/production-plans/${id}/queue`],
      ['POST', `/api/v1/production-plans/${id}/carry-over`],
      ['GET', `/api/v1/production-queue/${id}`],
      ['GET', `/api/v1/production-plans/${id}/distribution`],
      ['POST', `/api/v1/production-plans/${id}/items/${id}/distribute`],
      ['PUT', `/api/v1/service-order-items/${id}/upholsterer`],
      ['GET', '/api/v1/production/distribution-settings'],
      ['PUT', '/api/v1/production/distribution-settings'],
      // Fase 5: mão de obra.
      ['GET', '/api/v1/finance/labor'],
      ['GET', `/api/v1/finance/labor/${id}`],
      ['POST', '/api/v1/finance/labor'],
      ['POST', `/api/v1/finance/labor/${id}/payments`],
      ['POST', `/api/v1/finance/labor/${id}/agreed`],
      ['GET', '/api/v1/finance/labor-reviews'],
      ['POST', `/api/v1/finance/labor-reviews/${id}/resolve`],
      ['GET', '/api/v1/finance/labor-weekly?from=2026-10-05&to=2026-10-11'],
      ['GET', '/api/v1/finance/my-production'],
      // Fase 6: logística.
      ['GET', '/api/v1/finance/logistics-defaults'],
      ['PUT', '/api/v1/finance/logistics-defaults'],
      ['PUT', '/api/v1/finance/trip-costs'],
      ['POST', '/api/v1/finance/trip-costs/fee'],
      ['POST', `/api/v1/finance/logistics-costs/${id}/adjustments`],
      ['POST', `/api/v1/finance/payables/${id}/payments/${id}/reverse`],
      ['GET', '/api/v1/finance/logistics-weekly?from=2026-10-05&to=2026-10-11'],
      // Fase 7: fechamento.
      ['GET', '/api/v1/finance/weekly-closings'],
      ['GET', `/api/v1/finance/weekly-closings/${week}`],
      ['GET', `/api/v1/finance/weekly-closings/${week}?format=csv`],
      ['POST', `/api/v1/finance/weekly-closings/${week}/confirm`],
      ['POST', `/api/v1/finance/weekly-closings/${week}/reopen`],
      ['POST', `/api/v1/finance/weekly-closings/${week}/payments`],
      ['POST', `/api/v1/finance/closing-payments/${id}/reverse`],
      ['POST', `/api/v1/finance/labor/${id}/payments/${id}/reverse`],
      ['POST', '/api/v1/finance/trip-costs/free'],
    ];
    const call = (c: Client, m: 'GET' | 'POST' | 'PUT', p: string) =>
      c.req(m, p, m === 'GET' ? undefined : {}, { 'idempotency-key': idemKey() });
    const leaks: string[] = [];
    for (const [m, p] of routes) {
      for (const [who, c] of [
        ['tablet Ricardo', tabs.ricardo!],
        ['tablet Thiago', tabs.thiago!],
        ['painel sem permissão', plain],
      ] as const) {
        const r = await call(c, m, p);
        if (r.status !== 403) leaks.push(`${who} ${m} ${p} → ${r.status}`);
      }
      const a = await call(anon, m, p);
      if (a.status !== 401 && a.status !== 403) leaks.push(`anônimo ${m} ${p} → ${a.status}`);
    }
    expect(leaks).toEqual([]);
    // CSRF: mutação do gestor sem Origin permitido é recusada antes de qualquer efeito.
    const before = await admin.get('/api/v1/finance/weekly-closings');
    const noOrigin = new Client(app, null);
    noOrigin.cookies = new Map(admin.cookies);
    const csrf = await noOrigin.post(
      `/api/v1/finance/weekly-closings/${week}/confirm`,
      { version: 0 },
      { 'idempotency-key': idemKey() },
    );
    expect(csrf.status).toBe(403);
    const evil = new Client(app, 'https://atacante.example');
    evil.cookies = new Map(admin.cookies);
    expect(
      (
        await evil.post(
          '/api/v1/finance/trip-costs/free',
          { pickupId: id, reason: 'x' },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);
    expect((await admin.get('/api/v1/finance/weekly-closings')).body).toEqual(before.body);
  });
});
