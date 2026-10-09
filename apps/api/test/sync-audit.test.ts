import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, resetDatabase } from './helpers';
import { act } from './production-helpers';
import { prepareCompany, workshop } from './audit-helpers';

/**
 * Fase 12 — auditoria de sincronização: painel + quatro tablets conectados ao mesmo tempo,
 * ações simultâneas, queda e reconexão, eventos repetidos, reinício da API, revogação e
 * mudança de permissão. Nenhuma tarefa pode ser concluída duas vezes.
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
async function boot() {
  const a = await createTestApp();
  await a.startBackground();
  await a.app.listen({ port: 0, host: '127.0.0.1' });
  return a;
}
beforeAll(async () => {
  app = await boot();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  await prepareCompany();
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const seqs = (w: WsClient) => w.events().map((e) => BigInt(e.seq));
const strictlyIncreasing = (xs: bigint[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);

describe('Painel + quatro tablets', () => {
  it('ações simultâneas nos quatro tablets chegam a todos, em ordem e sem duplicar', async () => {
    const s = await workshop(app);
    const panel = track(await WsClient.connect(app, s.admin));
    const ws: Record<string, WsClient> = {};
    for (const n of Object.keys(s.tablets))
      ws[n] = track(await WsClient.connect(app, s.tablets[n]!));
    // Simultâneo: Ricardo e Márcio iniciam, João inicia a preparação, Thiago envia um sinal.
    const results = await Promise.all([
      act(s.tablets.Ricardo!, s.sofaTask.id, 'start'),
      act(s.tablets['Márcio']!, s.poltronaTask.id, 'start'),
      act(s.tablets['João']!, s.prep.id, 'start'),
      s.tablets.Thiago!.post(
        '/api/sync/signal',
        { message: 'thiago' },
        { 'idempotency-key': idemKey() },
      ),
    ]);
    // O acabamento das poltronas pode depender da preparação: inicia ou fica bloqueado, nunca erro 500.
    for (const r of results) expect([200, 201, 409, 422]).toContain(r.status);
    await panel.waitFor((m) => m.event?.payload?.message === 'thiago');
    for (const n of Object.keys(ws)) {
      await ws[n]!.waitFor((m) => m.event?.payload?.message === 'thiago');
      expect(strictlyIncreasing(seqs(ws[n]!)), n).toBe(true);
      expect(new Set(seqs(ws[n]!)).size, n).toBe(seqs(ws[n]!).length);
    }
    expect(strictlyIncreasing(seqs(panel))).toBe(true);
    // O painel vê o início das tarefas; cada tablet vê só o que lhe diz respeito.
    expect(panel.events('production.task_started').length).toBeGreaterThanOrEqual(2);
    for (const e of ws.Thiago!.events('production.task_started'))
      expect(JSON.stringify(e.payload)).not.toContain('Cents');
  });

  it('queda, ações perdidas e reconexão: o tablet recupera exatamente o que perdeu', async () => {
    const s = await workshop(app);
    let w = track(await WsClient.connect(app, s.tablets.Ricardo!));
    await s.admin.post('/api/sync/signal', { message: 'antes' }, { 'idempotency-key': idemKey() });
    const before = await w.waitFor((m) => m.event?.payload?.message === 'antes');
    await w.close();
    // Enquanto offline: o gestor e outros tablets mexem; o próprio Ricardo inicia pela API (fila).
    await s.admin.post(
      '/api/sync/signal',
      { message: 'durante' },
      { 'idempotency-key': idemKey() },
    );
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    w = track(await WsClient.connect(app, s.tablets.Ricardo!, before.event.seq as string));
    const done = await w.waitFor((m) => m.kind === 'replay.done');
    expect(done.count).toBeGreaterThanOrEqual(2);
    const msgs = w.events('sync.signal').map((e) => e.payload.message);
    expect(msgs).toEqual(['durante']);
    expect(w.events('production.task_started').length).toBe(1);
    // Reconectar de novo com o mesmo ponto não duplica nada além do reenvio pedido.
    expect(new Set(seqs(w)).size).toBe(seqs(w).length);
  });

  it('envio repetido (rede instável) não conclui a tarefa duas vezes', async () => {
    const s = await workshop(app);
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    const key = idemKey();
    const first = await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'ok' }, key);
    // Reenvio com a mesma chave (resposta perdida) e com chave nova (botão apertado de novo).
    const replay = await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'ok' }, key);
    const again = await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'ok' });
    expect(first.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect([200, 409, 422]).toContain(again.status);
    expect(
      await db().productionTaskEvent.count({ where: { taskId: s.sofaTask.id, kind: 'CONCLUIDA' } }),
    ).toBe(1);
    expect(await db().qualityInspection.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
      1,
    );
  });

  it('reinício da API: eventos gravados antes continuam disponíveis na reconexão', async () => {
    const s = await workshop(app);
    const w = track(await WsClient.connect(app, s.tablets.Ricardo!));
    await s.admin.post('/api/sync/signal', { message: 'marco' }, { 'idempotency-key': idemKey() });
    const mark = await w.waitFor((m) => m.event?.payload?.message === 'marco');
    await w.close();
    await s.admin.post(
      '/api/sync/signal',
      { message: 'antes do reinício' },
      { 'idempotency-key': idemKey() },
    );
    // Derruba e sobe a API (mesmo banco). Sessões e dispositivos continuam válidos.
    await app.close();
    app = await boot();
    const reconnect = (c: Client) => {
      // Os clientes guardam a referência da instância antiga; troca para a nova.
      (c as unknown as { app: App }).app = app;
      return c;
    };
    const tablet = reconnect(s.tablets.Ricardo!);
    reconnect(s.admin);
    const w2 = track(await WsClient.connect(app, tablet, mark.event.seq as string));
    await w2.waitFor((m) => m.kind === 'replay.done');
    expect(w2.events('sync.signal').map((e) => e.payload.message)).toEqual(['antes do reinício']);
    // A operação pendente do tablet segue normalmente depois do reinício.
    expect((await act(tablet, s.sofaTask.id, 'start')).status).toBe(200);
    const status = await tablet.get('/api/sync/status');
    expect(status.status).toBe(200);
  });

  it('permissão retirada e sessão revogada valem para todos os dispositivos imediatamente', async () => {
    const s = await workshop(app);
    const thiago = s.tablets.Thiago!;
    expect((await thiago.get('/api/v1/quality/inspections')).status).toBe(200);
    // Retira a permissão de inspecionar do Thiago (concessão por função → usa função sem ela).
    const e = await db().employee.findFirstOrThrow({
      where: { displayName: 'Thiago' },
      include: { user: { include: { roles: true } } },
    });
    const tapeceiro = await db().role.findFirstOrThrow({ where: { key: 'tapeceiro' } });
    const r = await s.admin.put(`/api/employees/${e.id}`, {
      fullName: e.fullName,
      displayName: e.displayName,
      jobTitle: e.jobTitle,
      color: e.color,
      roleIds: [tapeceiro.id],
      extraPermissions: [],
      version: e.version,
    });
    expect(r.status).toBe(200);
    expect((await thiago.get('/api/v1/quality/inspections')).status).toBe(403);
    // Revogar o dispositivo do Ricardo derruba o tablet (HTTP e tempo real).
    const w = track(await WsClient.connect(app, s.tablets.Ricardo!));
    const dev = await db().device.findFirstOrThrow({ where: { name: 'Tablet Ricardo' } });
    const rev = await s.admin.post(
      `/api/devices/${dev.id}/revoke`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(rev.status).toBe(200);
    for (let i = 0; i < 100 && !w.closed; i++) await new Promise((x) => setTimeout(x, 50));
    expect(w.closed).not.toBeNull();
    expect((await s.tablets.Ricardo!.get('/api/v1/production-tasks/mine')).status).toBe(401);
    // Os outros tablets seguem funcionando.
    expect((await s.tablets['Márcio']!.get('/api/v1/production-tasks/mine')).status).toBe(200);
  });
});
