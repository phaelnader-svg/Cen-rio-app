import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
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
  uploadPhoto,
  userIdOf,
} from './production-helpers';
import {
  approvedNeeds,
  confirmedFabricPurchase,
  createSupplier,
  linen,
  ok,
  receive,
  staples,
} from './purchasing-helpers';

/** Fase 6 — interface operacional dos tablets: Meu dia, execução, avisos e materiais por tarefa. */
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

type T = { id: string; activity: string; status: string; priority: string; version: number };

/** Sofá com Márcio como principal e João no apoio (rascunho; publicar à parte). */
async function scenario(materials: 'none' | 'missing' | 'complete' = 'complete') {
  const admin = await loginAdmin(app);
  const { so, reqs } = await serviceOrderWith(admin, materials, 'Cliente Tablet');
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
  const doPublish = async () => {
    const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    const p = await publish(admin, draft);
    return (a: string) => sofaTask(p, so.items[0].id, a);
  };
  return { admin, so, reqs, plan, marcio, joao, tJoao, tMarcio, doPublish };
}

const notices = async (userId: string) =>
  db().notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

describe('Tablet — Meu dia e detalhes', () => {
  it('login persistente: a sessão do tablet continua válida no dia seguinte e é revogável', async () => {
    const { admin, tJoao } = await scenario();
    const me = (await tJoao.get('/api/auth/me')).body;
    // Simula o início do próximo expediente: último uso há 16 horas.
    await db().session.update({
      where: { id: me.session.id },
      data: { lastSeenAt: new Date(Date.now() - 16 * 3_600_000) },
    });
    expect((await tJoao.get('/api/v1/production-tasks/mine')).status).toBe(200);
    expect((await admin.post(`/api/sessions/${me.session.id}/revoke`)).status).toBe(204);
    expect((await tJoao.get('/api/v1/production-tasks/mine')).status).toBe(401);
  });

  it('Meu dia: em execução, liberadas urgentes, liberadas, programadas e bloqueadas, nesta ordem', async () => {
    const { admin, so, plan, joao, tJoao, doPublish } = await scenario('missing');
    // Tarefas extras do João: uma urgente liberada e uma programada para mais tarde.
    const extra = async (activity: string, body: Record<string, unknown>) =>
      (
        await admin.post(
          `/api/v1/production-plans/${plan.id}/tasks`,
          { serviceOrderId: so.id, activity, assigneeUserId: joao, date: day(0), ...body },
          { 'idempotency-key': idemKey() },
        )
      ).body as T;
    const urgent = await extra('APOIO', {
      title: 'Apoio urgente',
      priority: 'URGENTE',
      time: '00:00',
    });
    const later = await extra('OUTRA', { title: 'Mais tarde', time: '23:59' });
    const t = await doPublish();
    await act(tJoao, t('DESMONTAGEM').id, 'start');
    const mine = (await tJoao.get('/api/v1/production-tasks/mine')).body.today as T[];
    const order = mine.map((x) => `${x.status}:${x.activity}`);
    expect(order[0]).toBe('EM_EXECUCAO:DESMONTAGEM');
    expect(order[1]).toBe('LIBERADA:APOIO');
    expect(order.indexOf(`PROGRAMADA:OUTRA`)).toBeGreaterThan(1);
    expect(order.at(-1)).toBe('BLOQUEADA:PREPARACAO');
    expect(mine.find((x) => x.id === urgent.id)?.priority).toBe('URGENTE');
    expect(mine.find((x) => x.id === later.id)?.status).toBe('PROGRAMADA');
    // Só as tarefas do próprio João.
    expect(
      mine.every(
        (x) => (x as unknown as { assignee: { userId: string } }).assignee.userId === joao,
      ),
    ).toBe(true);
  });

  it('detalhes técnicos sem dados financeiros; histórico técnico só com nomes de campos', async () => {
    const { admin, so, tMarcio, doPublish } = await scenario('complete');
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    const item = await admin.put(`/api/v1/service-orders/${so.id}/items/${so.items[0].id}`, {
      serviceType: os.items[0].serviceType,
      description: os.items[0].description,
      fabricName: 'Linho',
      fabricColor: 'Bege',
      foamSpecs: 'D33 10 cm',
      technicalNotes: 'Reforçar braços',
      version: os.items[0].version,
    });
    expect(item.status).toBe(200);
    const t = await doPublish();
    const d = (await tMarcio.get(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}`)).body;
    expect(d.serviceOrderInfo.items[0]).toMatchObject({
      fabricName: 'Linho',
      foamSpecs: 'D33 10 cm',
    });
    expect(
      d.technicalHistory.some((h: { fields: string[] }) => h.fields.includes('foamSpecs')),
    ).toBe(true);
    expect(d.taskMaterials).toBe('DISPONIVEIS');
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/agreedValue|Cents|paymentTerms|unitPrice|price|R\$|banc/i);
    // Valores antigos/novos das alterações não são expostos (só os nomes dos campos).
    expect(text).not.toMatch(/"from"|"to"/);
  });
});

describe('Tablet — execução', () => {
  it('início, andamento com etapa/próximo passo/foto, pausa por impedimento, retomada e conclusão', async () => {
    const { admin, tJoao, tMarcio, doPublish } = await scenario('complete');
    const t = await doPublish();
    const id = t('DESMONTAGEM').id;
    expect((await act(tJoao, id, 'start')).body.status).toBe('EM_EXECUCAO');
    // Foto da própria tarefa pelo tablet; outra pessoa não envia nem vê.
    const photo = await uploadPhoto(app, tJoao, 'PRODUCTION_TASK', id);
    expect(photo.status).toBe(201);
    expect((await uploadPhoto(app, tMarcio, 'PRODUCTION_TASK', id)).status).toBe(403);
    expect(
      (await tMarcio.get(`/api/v1/attachments?entityType=PRODUCTION_TASK&entityId=${id}`)).status,
    ).toBe(403);
    // Andamento: nada preenchido é recusado; percentual não é obrigatório.
    expect((await act(tJoao, id, 'progress', {})).status).toBe(400);
    const p = await act(tJoao, id, 'progress', {
      step: 'Braços desmontados',
      nextStep: 'Retirar espuma do assento',
      attachmentIds: [photo.body.id],
    });
    expect(p.status).toBe(200);
    expect(p.body.lastProgress).toMatchObject({
      step: 'Braços desmontados',
      nextStep: 'Retirar espuma do assento',
      percent: null,
    });
    // Foto que não é desta tarefa é recusada.
    const other = await uploadPhoto(app, admin, 'PRODUCTION_TASK', t('PREPARACAO').id);
    expect((await act(tJoao, id, 'progress', { attachmentIds: [other.body.id] })).status).toBe(422);
    // Pausa por impedimento real: evento próprio para a futura central de atenção.
    const paused = await act(tJoao, id, 'pause', {
      reason: 'AGUARDANDO_ORIENTACAO',
      impediment: true,
    });
    expect(paused.body).toMatchObject({ status: 'PAUSADA', pauseImpediment: true });
    expect(
      await db().domainEvent.count({
        where: { type: 'production.task_impediment', aggregateId: id },
      }),
    ).toBe(1);
    const resumed = await act(tJoao, id, 'resume');
    expect(resumed.body).toMatchObject({
      status: 'EM_EXECUCAO',
      pauseImpediment: false,
      lastProgress: { step: 'Braços desmontados' },
    });
    // Tarefa comum: conclusão sem foto nem justificativa.
    expect((await act(tJoao, id, 'complete')).body.status).toBe('CONCLUIDA');
    const d = (await tJoao.get(`/api/v1/production-tasks/${id}`)).body;
    const progress = d.events.find((e: { kind: string }) => e.kind === 'ANDAMENTO');
    expect(progress.extra).toMatchObject({
      step: 'Braços desmontados',
      attachmentIds: [photo.body.id],
    });
  });

  it('registro exigido na conclusão só quando a etapa pede (observação ou foto)', async () => {
    const { admin, tJoao, doPublish } = await scenario('complete');
    const t = await doPublish();
    const id = t('DESMONTAGEM').id;
    await admin.put(`/api/v1/production-tasks/${id}`, {
      completionRequirement: 'FOTO',
      reason: 'Registro do estado da estrutura',
      version: t('DESMONTAGEM').version,
    });
    await act(tJoao, id, 'start');
    const noPhoto = await act(tJoao, id, 'complete');
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.error.message).toMatch(/foto/);
    const photo = await uploadPhoto(app, tJoao, 'PRODUCTION_TASK', id);
    expect((await act(tJoao, id, 'complete', { attachmentIds: [photo.body.id] })).status).toBe(200);

    const prep = (await admin.get(`/api/v1/production-tasks/${t('PREPARACAO').id}`)).body;
    await admin.put(`/api/v1/production-tasks/${prep.id}`, {
      completionRequirement: 'OBSERVACAO',
      reason: 'Anotar reparos feitos',
      version: prep.version,
    });
    await act(tJoao, prep.id, 'start');
    expect((await act(tJoao, prep.id, 'complete')).status).toBe(422);
    const done = await act(tJoao, prep.id, 'complete', { note: 'Estrutura colada e grampeada' });
    expect(done.body.status).toBe('CONCLUIDA');
  });
});

describe('Avisos (notificações)', () => {
  it('publicação, liberação, reprogramação, prioridade, troca de responsável, cancelamento e OS', async () => {
    const { admin, so, joao, marcio, tJoao, tMarcio, doPublish } = await scenario('complete');
    const t = await doPublish();
    // Publicação: um aviso-resumo por pessoa + "Tarefa liberada" para o que já pode começar.
    const afterPublish = await notices(joao);
    expect(afterPublish.map((n) => n.kind).sort()).toEqual(['TAREFA_ATRIBUIDA', 'TAREFA_LIBERADA']);
    expect(afterPublish.find((n) => n.kind === 'TAREFA_ATRIBUIDA')!.body).toMatch(
      /2 tarefa\(s\) para você, 1 liberada/,
    );
    const m = await notices(marcio);
    expect(m.filter((n) => n.kind === 'TAREFA_ATRIBUIDA')).toHaveLength(1);
    expect(m.filter((n) => n.kind === 'TAREFA_LIBERADA')).toHaveLength(
      await db().productionTask.count({ where: { assigneeUserId: marcio, status: 'LIBERADA' } }),
    );
    // João conclui a desmontagem e a preparação; Márcio é avisado do avanço da montagem.
    await act(tJoao, t('DESMONTAGEM').id, 'start');
    await act(tJoao, t('DESMONTAGEM').id, 'complete');
    expect(
      (await notices(joao)).some(
        (n) => n.kind === 'TAREFA_LIBERADA' && n.taskId === t('PREPARACAO').id,
      ),
    ).toBe(true);
    await act(tJoao, t('PREPARACAO').id, 'start');
    const key = idemKey();
    await act(tJoao, t('PREPARACAO').id, 'complete', {}, key);
    await act(tJoao, t('PREPARACAO').id, 'complete', {}, key); // repetição: nada novo
    const dep = (await notices(marcio)).filter((n) => n.kind === 'DEPENDENCIA_CONCLUIDA');
    expect(dep).toHaveLength(1);
    expect(dep[0]!.taskId).toBe(t('MONTAGEM').id);

    // Gestor reprograma e muda a prioridade da costura do Márcio.
    const costura = (await admin.get(`/api/v1/production-tasks/${t('COSTURA').id}`)).body;
    await admin.put(`/api/v1/production-tasks/${costura.id}`, {
      date: day(1),
      time: '10:00',
      priority: 'URGENTE',
      reason: 'Cliente antecipou',
      version: costura.version,
    });
    const kinds = (await notices(marcio)).map((n) => n.kind);
    expect(kinds).toContain('TAREFA_REPROGRAMADA');
    expect(kinds).toContain('PRIORIDADE_ALTERADA');

    // Troca de responsável do acabamento (Márcio → Ricardo).
    const ricardo = await userIdOf('Ricardo');
    const acab = (await admin.get(`/api/v1/production-tasks/${t('ACABAMENTO').id}`)).body;
    await admin.put(`/api/v1/production-tasks/${acab.id}`, {
      assigneeUserId: ricardo,
      reason: 'Márcio em outra OS',
      version: acab.version,
    });
    expect((await notices(marcio)).some((n) => n.kind === 'TAREFA_REMOVIDA')).toBe(true);
    expect((await notices(ricardo)).some((n) => n.kind === 'TAREFA_ATRIBUIDA')).toBe(true);

    // Cancelamento.
    await admin.post(`/api/v1/production-tasks/${t('MONTAGEM').id}/cancel`, {
      reason: 'Montagem feita junto do acabamento',
    });
    expect((await notices(marcio)).some((n) => n.kind === 'TAREFA_CANCELADA')).toBe(true);

    // Atualização técnica da OS avisa quem tem tarefa aberta nela.
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    const osUpd = await admin.put(`/api/v1/service-orders/${so.id}`, {
      technicalInstructions: 'Usar grampo inox',
      priority: os.priority,
      technicalLeadId: os.technicalLead?.userId ?? null,
      version: os.version,
    });
    expect(osUpd.status).toBe(200);
    expect((await notices(marcio)).some((n) => n.kind === 'OS_ATUALIZADA')).toBe(true);

    // Caixa do tablet: persistente, lida/não lida, só do próprio usuário.
    const box = (await tMarcio.get('/api/v1/notifications')).body;
    expect(box.unread).toBe(box.items.length);
    const first = box.items[0];
    expect((await tJoao.post(`/api/v1/notifications/${first.id}/read`)).status).toBe(404);
    const read = await tMarcio.post(`/api/v1/notifications/${first.id}/read`);
    expect(read.body.unread).toBe(box.unread - 1);
    const all = await tMarcio.post('/api/v1/notifications/read-all');
    expect(all.body.unread).toBe(0);
    expect((await tMarcio.get('/api/v1/notifications?unread=1')).body.items).toEqual([]);
    // Ninguém é avisado da própria ação (o gestor não recebe avisos do que fez).
    expect(
      await db().notification.count({
        where: { userId: (await admin.get('/api/auth/me')).body.user.id },
      }),
    ).toBe(0);
  });

  it('tempo real e reconexão: avisos chegam só ao destinatário e são recuperados', async () => {
    const { admin, tJoao, tMarcio, doPublish } = await scenario('complete');
    const wJoao = track(await WsClient.connect(app, tJoao));
    const wMarcio = track(await WsClient.connect(app, tMarcio));
    const t = await doPublish();
    await wJoao.waitFor((m) => m.kind === 'event' && m.event.type === 'notification.created');
    // Márcio recebe os avisos ao vivo; depois a conexão cai (Wi-Fi) antes da próxima mudança.
    await wMarcio.waitFor((m) => m.kind === 'event' && m.event.type === 'notification.created');
    const lastSeq = wMarcio.events().at(-1)!.seq as string;
    await wMarcio.close();
    const costura = (await admin.get(`/api/v1/production-tasks/${t('COSTURA').id}`)).body;
    await admin.put(`/api/v1/production-tasks/${costura.id}`, {
      priority: 'ALTA',
      reason: 'Prioridade do cliente',
      version: costura.version,
    });
    const back = track(await WsClient.connect(app, tMarcio, String(lastSeq)));
    await back.waitFor((m) => m.kind === 'replay.done');
    const recovered = back
      .events('notification.created')
      .filter((e: { payload: { taskId: string } }) => e.payload.taskId === costura.id);
    expect(recovered).toHaveLength(1);
    // O tablet do João não recebe avisos do Márcio.
    expect(
      wJoao
        .events('notification.created')
        .some((e: { payload: { taskId: string } }) => e.payload.taskId === costura.id),
    ).toBe(false);
  });
});

describe('Materiais por tarefa', () => {
  it('corte vinculado ao tecido é liberado; costura sem vínculo e montagem seguem bloqueadas', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Materiais', (s) => [
      linen(s.items[0].id),
      staples(),
    ]);
    const fabric = reqs.find((r) => r.kind === 'TECIDO')!;
    const other = reqs.find((r) => r.kind !== 'TECIDO')!;
    const marcio = await userIdOf('Márcio');
    const joao = await userIdOf('João');
    const plan = await createPlan(admin);
    const added = (
      await addOs(admin, plan.id, { serviceOrderId: so.id, principalUserId: marcio, date: day(-1) })
    ).body;
    const t = (a: string) => sofaTask(added, so.items[0].id, a);
    for (const a of ['DESMONTAGEM', 'PREPARACAO']) await assign(admin, t(a), joao);
    // Validação: só materiais aprovados desta OS.
    const foreign = await admin.put(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}/materials`, {
      requirementIds: ['00000000-0000-4000-8000-000000000000'],
      version: t('CORTE_TECIDO').version,
    });
    expect(foreign.status).toBe(422);
    const linked = await admin.put(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}/materials`, {
      requirementIds: [fabric.id],
      version: t('CORTE_TECIDO').version,
    });
    expect(linked.status).toBe(200);
    const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    const published = await publish(admin, draft);
    const p = (a: string) => sofaTask(published, so.items[0].id, a);
    expect(p('CORTE_TECIDO')).toMatchObject({ status: 'BLOQUEADA', blockers: ['MATERIAIS'] });

    // Chega só o tecido: o corte (vinculado) libera; a costura (sem vínculo) espera a OS inteira.
    const supplier = await createSupplier(admin, 'Fornecedor Materiais');
    const po = await confirmedFabricPurchase(admin, supplier.id, fabric);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    const get = async (a: string) => (await admin.get(`/api/v1/production-tasks/${p(a).id}`)).body;
    expect((await get('CORTE_TECIDO')).status).toBe('LIBERADA');
    expect((await get('CORTE_TECIDO')).taskMaterials).toBe('DISPONIVEIS');
    expect((await get('COSTURA')).blockers).toContain('MATERIAIS');
    expect((await get('DESMONTAGEM')).status).toBe('LIBERADA');
    expect(
      (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).materialsReadiness,
    ).not.toBe('COMPLETO');

    // Vincular a montagem a um material faltante não a libera (nunca começa sem material).
    const montagem = await get('MONTAGEM');
    await admin.put(`/api/v1/production-tasks/${montagem.id}/materials`, {
      requirementIds: [other.id],
      reason: 'Montagem usa os grampos',
      version: montagem.version,
    });
    const m2 = await get('MONTAGEM');
    expect(m2.blockers).toContain('MATERIAIS');
    expect(m2.taskMaterials).toBe('FALTANDO');
    // O tablet do Márcio inicia o corte; o servidor confere os materiais vinculados no início.
    const tMarcio = await tabletOf(app, admin, 'Márcio', '736152');
    expect((await act(tMarcio, p('CORTE_TECIDO').id, 'start')).body.status).toBe('EM_EXECUCAO');
    expect((await act(tMarcio, montagem.id, 'start')).status).toBe(422);
  });
});

describe('Permissões e concorrência', () => {
  it('tablet não altera tarefas de outra pessoa nem planeja; leituras simultâneas não duplicam', async () => {
    const { tJoao, tMarcio, doPublish } = await scenario('complete');
    const t = await doPublish();
    const corte = t('CORTE_TECIDO');
    // João não age na tarefa do Márcio, nem vincula materiais, nem altera.
    for (const a of ['start', 'pause', 'resume', 'progress', 'complete'])
      expect(
        (await act(tJoao, corte.id, a, { note: 'x y', reason: 'FIM_EXPEDIENTE' })).status,
      ).toBe(403);
    expect(
      (
        await tJoao.put(`/api/v1/production-tasks/${corte.id}/materials`, {
          requirementIds: [],
          version: corte.version,
        })
      ).status,
    ).toBe(403);
    expect((await tJoao.get(`/api/v1/production-tasks/${corte.id}`)).status).toBe(403);
    // Duas marcações "todas lidas" simultâneas: contagem consistente.
    const [a, b] = await Promise.all([
      tMarcio.post('/api/v1/notifications/read-all'),
      tMarcio.post('/api/v1/notifications/read-all'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.unread + b.body.unread).toBe(0);
    expect(await db().domainEvent.count({ where: { type: 'notification.read' } })).toBe(1);
    // Início simultâneo da mesma tarefa em dois toques: um único registro.
    await Promise.all([act(tMarcio, corte.id, 'start'), act(tMarcio, corte.id, 'start')]);
    expect(
      await db().productionTaskEvent.count({ where: { taskId: corte.id, kind: 'INICIADA' } }),
    ).toBe(1);
  });
});
