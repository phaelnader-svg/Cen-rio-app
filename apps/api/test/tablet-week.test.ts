import { mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import {
  approvedNeeds,
  confirmedFabricPurchase,
  createSupplier,
  linen,
} from './purchasing-helpers';
import { act, addOs, createPlan, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 4 — contratos do tablet "Minha semana": semana, contagens, titular × apoio,
 * privacidade (nenhum valor financeiro) e concorrência. Relógio controlado.
 */
let app: App;
const sockets: WsClient[] = [];
const TZ = 'America/Sao_Paulo';
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MONDAY = () => mondayOf(today());
const clockAt = (wd: number, hhmm: string) =>
  setClock(() => zonedDateTime(addDays(MONDAY(), wd), hhmm, TZ));

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  clockAt(0, '08:00');
});
afterEach(async () => {
  setClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

type Q = {
  week: { start: string; end: string };
  counts: { done: number; running: number; paused: number; executable: number; blocked: number };
  current: { id: string } | null;
  next: { id: string } | null;
  total: number;
  items: {
    position: number;
    executable: boolean;
    task: {
      id: string;
      activity: string;
      stepClass: string | null;
      status: string;
      serviceOrderItem: {
        id: string;
        upholsterer: { userId: string; displayName: string } | null;
      } | null;
    };
  }[];
};
const queueOf = async (c: Client) => (await c.get('/api/v1/production-tasks/mine/queue')).body as Q;

/** Fila semanal publicada pela distribuição: sofá → Ricardo, poltronas → Márcio, preparo → João. */
async function workshop() {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(admin, 'Cliente Semana');
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
  };
  const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
  const r = await addOs(admin, plan.id, {
    serviceOrderId: so.id,
    pieces: [
      { serviceOrderItemId: so.items[0].id, upholstererUserId: ids.ricardo },
      { serviceOrderItemId: so.items[1].id, upholstererUserId: ids.marcio },
    ],
  });
  expect(r.status).toBe(201);
  const pub = await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  const tabs = {
    joao: await tabletOf(app, admin, 'João', '271828'),
    ricardo: await tabletOf(app, admin, 'Ricardo', '482915'),
    marcio: await tabletOf(app, admin, 'Márcio', '602413'),
    thiago: await tabletOf(app, admin, 'Thiago', '314159'),
  };
  return { admin, so, ids, plan: pub, tabs };
}

/** Percorre o JSON e devolve as chaves com cara de valor financeiro. */
function moneyKeys(v: unknown, path = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => moneyKeys(x, `${path}[${i}]`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => [
      ...(/cents$|price|revenue|margin|cost|valor|preco|amount|salary|payable/i.test(k)
        ? [`${path}.${k}`]
        : []),
      ...moneyKeys(x, `${path}.${k}`),
    ]);
  return [];
}

describe('Minha semana (tablet)', () => {
  it('CA4-01/02/04/10: semana e identidade; destaque; OS/peça/etapa; titular × executor de apoio', async () => {
    const { ids, tabs, so } = await workshop();
    const me = (await tabs.joao.get('/api/auth/me')).body;
    expect(me.user.id).toBe(ids.joao);
    const q = await queueOf(tabs.joao);
    expect(q.week).toEqual({ start: MONDAY(), end: addDays(MONDAY(), 6) });
    expect(q.total).toBe(4); // desmontagem + preparação do sofá e das poltronas
    expect(q.next!.id).toBe(q.items[0]!.task.id);
    expect(q.counts).toMatchObject({ done: 0, running: 0 });
    const prep = q.items.find((e) => e.task.activity === 'PREPARACAO')!.task;
    expect(prep.stepClass).toBe('PREPARACAO');
    expect(prep.serviceOrderItem!.upholsterer!.userId).not.toBe(ids.joao); // João não é o titular
    const qr = await queueOf(tabs.ricardo);
    expect(qr.items.every((e) => e.task.stepClass === 'TAPECARIA')).toBe(true);
    expect(
      qr.items.every(
        (e) =>
          e.task.serviceOrderItem!.id === so.items[0].id &&
          e.task.serviceOrderItem!.upholsterer!.userId === ids.ricardo,
      ),
    ).toBe(true);
    // Ricardo não executa tapeçaria das poltronas (titular Márcio) nem vê a fila dele.
    const marcioTask = (await queueOf(tabs.marcio)).items[0]!.task.id;
    expect((await act(tabs.ricardo, marcioTask, 'start')).status).toBe(403);
    expect((await tabs.ricardo.get(`/api/v1/production-queue/${ids.marcio}`)).status).toBe(403);
  });

  it('CA4-05/06/07/08/09: bloqueio explicado, prioridade mantida, desbloqueio sem interromper, contagens e continuidade', async () => {
    const { admin, tabs } = await workshop();
    let q = await queueOf(tabs.joao);
    const [a, b] = [q.items[0]!.task, q.items[1]!.task];
    await admin.post(
      `/api/v1/production-tasks/${a.id}/block`,
      { reason: 'Falta ferramenta' },
      { 'idempotency-key': idemKey() },
    );
    q = await queueOf(tabs.joao);
    expect(q.items[0]!.task.id).toBe(a.id); // prioridade original
    expect(q.items[0]!.executable).toBe(false);
    expect(q.counts.blocked).toBeGreaterThan(0);
    const nextExec = q.next!.id;
    expect(nextExec).not.toBe(a.id);
    // Iniciar a bloqueada: recusado; iniciar a executável: ok; segunda principal: 409.
    expect((await act(tabs.joao, a.id, 'start')).status).toBe(422);
    clockAt(0, '09:00');
    expect((await act(tabs.joao, nextExec, 'start')).status).toBe(200);
    // Desbloqueio não interrompe a tarefa em execução; a desbloqueada não pode ser iniciada
    // em paralelo (uma principal ativa), nem com cliques simultâneos.
    await admin.post(
      `/api/v1/production-tasks/${a.id}/unblock`,
      { reason: 'Chegou' },
      { 'idempotency-key': idemKey() },
    );
    const both = await Promise.all([act(tabs.joao, a.id, 'start'), act(tabs.joao, a.id, 'start')]);
    expect(both.every((r) => r.status === 409)).toBe(true);
    q = await queueOf(tabs.joao);
    expect(q.current!.id).toBe(nextExec);
    expect(q.next!.id).toBe(a.id); // volta a ser a próxima, na posição original
    expect(q.counts.running).toBe(1);
    // Pausar/retomar/concluir com auditoria; concluir duplo não duplica.
    expect(
      (await act(tabs.joao, nextExec, 'pause', { reason: 'AGUARDANDO_ORIENTACAO' })).status,
    ).toBe(200);
    expect((await act(tabs.joao, nextExec, 'resume')).status).toBe(200);
    const done = await Promise.all([
      act(tabs.joao, nextExec, 'complete'),
      act(tabs.joao, nextExec, 'complete'),
    ]);
    expect(done.every((r) => r.status === 200)).toBe(true);
    const kinds = (await db().productionTaskEvent.findMany({ where: { taskId: nextExec } })).map(
      (e) => e.kind,
    );
    expect(kinds.filter((k) => k === 'CONCLUIDA')).toHaveLength(1);
    expect(kinds).toEqual(expect.arrayContaining(['INICIADA', 'PAUSADA', 'RETOMADA', 'CONCLUIDA']));
    q = await queueOf(tabs.joao);
    expect(q.counts.done).toBe(1);
    // Terça: nada muda sozinho; a fila continua de onde parou.
    const before = await db().productionTask.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, status: true, version: true, planId: true },
    });
    clockAt(1, '08:00');
    const after = await db().productionTask.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, status: true, version: true, planId: true },
    });
    expect(after).toEqual(before);
    const qt = await queueOf(tabs.joao);
    expect(qt.items.map((e) => e.task.id)).toEqual(q.items.map((e) => e.task.id));
    expect(qt.counts.done).toBe(1); // mesma semana
    void b;
  });

  it('CA4-11/12: reordenação do gestor chega ao tablet (inclusive após reconexão); funcionário não reordena nem troca titular', async () => {
    const { admin, ids, plan, so, tabs } = await workshop();
    let w = await WsClient.connect(app, tabs.joao);
    sockets.push(w);
    await tabs.joao.post(
      '/api/sync/signal',
      { message: 'marco' },
      { 'idempotency-key': idemKey() },
    );
    const mark = await w.waitFor((m) => m.event?.payload?.message === 'marco');
    await w.close();
    const q = await queueOf(tabs.joao);
    const reversed = [...q.items].reverse().map((e) => e.task.id);
    const body = {
      userId: ids.joao,
      taskIds: reversed,
      version: (await admin.get(`/api/v1/production-plans/${plan.id}`)).body.version,
      reason: 'Prioridade',
    };
    // Funcionário não reordena nem troca titular.
    expect(
      (
        await tabs.joao.req('PUT', `/api/v1/production-plans/${plan.id}/queue`, body, {
          'idempotency-key': idemKey(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await tabs.ricardo.req(
          'PUT',
          `/api/v1/service-order-items/${so.items[1].id}/upholsterer`,
          { userId: ids.ricardo, expectedUserId: ids.marcio, reason: 'quero', confirm: true },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);
    // Gestor reordena com o tablet desconectado; a reconexão recupera o evento.
    const r = await admin.req('PUT', `/api/v1/production-plans/${plan.id}/queue`, body, {
      'idempotency-key': idemKey(),
    });
    expect(r.status).toBe(422); // faixa de prioridade/dependência: desmontagem antes da preparação
    const swap = [q.items[0]!, q.items[2]!, q.items[1]!, q.items[3]!];
    const ok = await admin.req(
      'PUT',
      `/api/v1/production-plans/${plan.id}/queue`,
      { ...body, taskIds: swap.map((e) => e.task.id) },
      { 'idempotency-key': idemKey() },
    );
    expect(ok.status).toBe(200);
    w = await WsClient.connect(app, tabs.joao, mark.event.seq as string);
    sockets.push(w);
    await w.waitFor((m) => m.kind === 'replay.done');
    expect(w.events('production.queue_reordered')).toHaveLength(1);
    expect((await queueOf(tabs.joao)).items.map((e) => e.task.id)).toEqual(
      swap.map((e) => e.task.id),
    );
  });

  it('CA4-13: nenhum valor financeiro nas respostas do tablet, no WebSocket nem nas notificações', async () => {
    const { admin, ids, so, tabs } = await workshop();
    // Há mão de obra combinada (valor) para a peça do Ricardo: não pode aparecer para ninguém no tablet.
    expect(
      (
        await admin.post(
          '/api/v1/finance/labor',
          {
            professionalUserId: ids.ricardo,
            serviceOrderId: so.id,
            serviceOrderItemId: so.items[0].id,
            service: 'Sofá',
            agreedCents: 150000,
          },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(201);
    // Pedido de compra com preço aguardando chegada (o tablet confere o recebimento).
    const { reqs } = await approvedNeeds(admin, 'Cliente Compra', (x) => [linen(x.items[0].id)]);
    const po = await confirmedFabricPurchase(admin, (await createSupplier(admin)).id, reqs[0]!);
    const priced = await db().purchaseOrderItem.count({
      where: { purchaseOrderId: po.id, unitPriceCents: { gt: 0 } },
    });
    expect(priced).toBeGreaterThan(0); // há preço no banco; o tablet não pode recebê-lo
    const pending = (await tabs.joao.get('/api/v1/material-receipts/pending')).body;
    expect(pending.length).toBeGreaterThan(0);
    const ws = await WsClient.connect(app, tabs.joao);
    sockets.push(ws);
    const q = await queueOf(tabs.joao);
    await act(tabs.joao, q.next!.id, 'start');
    await act(tabs.joao, q.next!.id, 'complete');
    await ws.waitFor((m) => m.event?.type === 'production.task_completed');
    const paths = [
      '/api/auth/me',
      '/api/v1/production-tasks/mine',
      '/api/v1/production-tasks/mine/queue',
      `/api/v1/production-tasks/${q.items[1]!.task.id}`,
      '/api/v1/notifications?limit=50',
      '/api/v1/attendance/me',
      '/api/v1/help-requests/mine',
      '/api/v1/issues/mine',
      '/api/v1/material-receipts/pending',
    ];
    for (const [name, c] of Object.entries(tabs))
      for (const p of paths) {
        const r = await c.get(p);
        if (r.status >= 400) continue; // sem permissão: nada é exposto
        expect(moneyKeys(r.body), `${name} ${p}`).toEqual([]);
      }
    expect(moneyKeys(ws.messages)).toEqual([]);
    // Valores próprios só com a permissão específica (nenhum dos tablets da equipe a tem por padrão).
    expect((await tabs.joao.get('/api/v1/finance/my-production')).status).toBe(403);
  });
});
