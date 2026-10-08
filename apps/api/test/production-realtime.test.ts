import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { WsClient, createTestApp, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  act,
  addOs,
  assign,
  createPlan,
  day,
  publish,
  serviceOrderWith,
  sofaTask,
  tabletOf,
  userIdOf,
} from './production-helpers';

let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);

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

/** Sofá com Márcio como principal e João no apoio, publicado com materiais completos. */
async function scenario() {
  const admin = await loginAdmin(app);
  const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Tempo Real');
  const marcio = await userIdOf('Márcio');
  const joao = await userIdOf('João');
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, { serviceOrderId: so.id, principalUserId: marcio, date: day(-1) })
  ).body;
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added, so.items[0].id, a), joao);
  const tJoao = await tabletOf(app, admin, 'João', '121212');
  const tMarcio = await tabletOf(app, admin, 'Márcio', '736152');
  return { admin, so, plan, tJoao, tMarcio, marcio, joao };
}

describe('Produção em tempo real', () => {
  it('publicação chega aos dois tablets; conclusão do João libera a montagem do Márcio sem recarregar', async () => {
    const { admin, so, plan, tJoao, tMarcio } = await scenario();
    const wJoao = track(await WsClient.connect(app, tJoao));
    const wMarcio = track(await WsClient.connect(app, tMarcio));
    const wGestor = track(await WsClient.connect(app, admin));

    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const t = (a: string) => sofaTask(published, so.items[0].id, a);
    await wJoao.waitFor(
      (x) =>
        x.event?.type === 'production.task_assigned' && x.event.payload.id === t('DESMONTAGEM').id,
    );
    await wMarcio.waitFor(
      (x) =>
        x.event?.type === 'production.task_released' && x.event.payload.id === t('CORTE_TECIDO').id,
    );
    // O João não recebe atribuições do Márcio.
    expect(
      wJoao.events('production.task_assigned').some((e) => e.payload.id === t('CORTE_TECIDO').id),
    ).toBe(false);

    // Márcio faz corte e costura enquanto João desmonta e prepara.
    for (const [c, a] of [
      [tMarcio, 'CORTE_TECIDO'],
      [tMarcio, 'COSTURA'],
      [tJoao, 'DESMONTAGEM'],
    ] as const) {
      await act(c, t(a).id, 'start');
      await act(c, t(a).id, 'complete');
    }
    await act(tJoao, t('PREPARACAO').id, 'start');
    await act(tJoao, t('PREPARACAO').id, 'complete');
    const released = await wMarcio.waitFor(
      (x) =>
        x.event?.type === 'production.task_released' && x.event.payload.id === t('MONTAGEM').id,
    );
    expect(released.event.payload.status).toBe('LIBERADA');
    await wGestor.waitFor(
      (x) =>
        x.event?.type === 'production.task_completed' && x.event.payload.id === t('PREPARACAO').id,
    );
    // O tablet do Márcio vê a montagem liberada ao recarregar a lista (invalidação pelo evento).
    const mine = (await tMarcio.get('/api/v1/production-tasks/mine')).body.today;
    expect(mine.find((x: { id: string }) => x.id === t('MONTAGEM').id).status).toBe('LIBERADA');
  });

  it('reconexão: liberação ocorrida com o tablet do Márcio offline é recuperada', async () => {
    const { admin, so, plan, tJoao, tMarcio } = await scenario();
    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const t = (a: string) => sofaTask(published, so.items[0].id, a);
    for (const [c, a] of [
      [tMarcio, 'CORTE_TECIDO'],
      [tMarcio, 'COSTURA'],
      [tJoao, 'DESMONTAGEM'],
    ] as const) {
      await act(c, t(a).id, 'start');
      await act(c, t(a).id, 'complete');
    }
    let w = track(await WsClient.connect(app, tMarcio));
    await admin.post('/api/sync/signal', { message: 'antes' }, { 'idempotency-key': idemKey() });
    const last = (await w.waitFor((x) => x.event?.payload?.message === 'antes')).event
      .seq as string;
    await w.close(); // Wi-Fi caiu

    await act(tJoao, t('PREPARACAO').id, 'start');
    await act(tJoao, t('PREPARACAO').id, 'complete');

    w = track(await WsClient.connect(app, tMarcio, last));
    await w.waitFor((x) => x.kind === 'replay.done');
    const replayed = w
      .events('production.task_released')
      .filter((e) => e.payload.id === t('MONTAGEM').id);
    expect(replayed).toHaveLength(1);
  });
});
