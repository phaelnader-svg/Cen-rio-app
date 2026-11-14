import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { releaseDueTasks } from '../src/modules/production/common';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
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
  today,
  userIdOf,
} from './production-helpers';

/** Respostas JSON livres nos testes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Etapa E1 da correção da reformulação — a produção não depende do processo formal de materiais.
 * Cenários de aceite A–H aprovados pelo proprietário. Banco descartável, dados fictícios. Nenhum
 * caso liga ou desliga nada antes de provar o comportamento padrão (cenário G): o padrão é que vale.
 */
let app: App;
const TZ = 'America/Sao_Paulo';

beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ));
});
afterEach(() => setAttendanceClock());

const send = (c: Client, method: 'POST' | 'PATCH' | 'PUT', url: string, body: unknown = {}) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const L = (soId: string) => `/api/v1/service-orders/${soId}/material-list`;
const taskOf = async (c: Client, id: string) => ok(await c.get(`/api/v1/production-tasks/${id}`));

async function setModule(admin: Client, key: string, enabled: boolean) {
  const list = ok<{ key: string; version: number }[]>(await admin.get('/api/company/modules'));
  const m = list.find((x) => x.key === key)!;
  return send(admin, 'PUT', `/api/company/modules/${key}`, { enabled, version: m.version });
}

/** Sofá com planejamento publicado (Ricardo titular; apoio do João), SEM mexer em interruptor. */
async function publishedSofa(
  materials: 'none' | 'missing' | 'complete',
  before?: (admin: Client, so: J) => Promise<void>,
) {
  const admin = await loginAdmin(app);
  const { so } = await serviceOrderWith(admin, materials);
  if (before) await before(admin, so);
  const ricardo = await userIdOf('Ricardo');
  const joao = await userIdOf('João');
  const plan = await createPlan(admin);
  const added = await addOs(admin, plan.id, {
    serviceOrderId: so.id,
    principalUserId: ricardo,
    date: day(-1),
  });
  expect(added.status).toBe(201);
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added.body, so.items[0].id, a), joao);
  const published = await publish(
    admin,
    (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
  );
  const t = (a: string) => sofaTask(published, so.items[0].id, a);
  return { admin, so, t, planId: plan.id };
}

/** Executa a etapa principal pelo tablet do titular: iniciar, pausar, retomar e concluir. */
async function runOnTablet(admin: Client, taskId: string) {
  const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
  const start = await act(ricardo, taskId, 'start');
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const pause = await act(ricardo, taskId, 'pause', { reason: 'AGUARDANDO_ORIENTACAO' });
  expect(pause.status, JSON.stringify(pause.body)).toBe(200);
  expect((await act(ricardo, taskId, 'resume')).status).toBe(200);
  const done = await act(ricardo, taskId, 'complete', { note: 'Etapa concluída' });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect((await taskOf(admin, taskId)).status).toBe('CONCLUIDA');
  return ricardo;
}

describe('E1 — a produção não depende do processo formal de materiais', () => {
  it('G — empresa nova: travas de materiais desligadas por padrão, sem nenhum registro gravado', async () => {
    const admin = await loginAdmin(app);
    expect(await db().moduleSetting.count()).toBe(0);
    const list = ok<J[]>(await admin.get('/api/company/modules'));
    expect(list.find((m) => m.key === 'materiais')).toMatchObject({
      enabled: false,
      defaultEnabled: false,
    });
    // As demais funcionalidades não mudaram nesta etapa.
    for (const k of ['logistica', 'ajuda', 'embalagem'])
      expect(list.find((m) => m.key === k)).toMatchObject({ enabled: true });
    // A leitura do tablet/painel (só booleanos) também reflete o padrão.
    expect(ok<J>(await admin.get('/api/v1/modules')).materiais).toBe(false);
  });

  it('A — OS sem materiais: etapas que "exigem materiais" ficam liberadas; iniciar, pausar, retomar e concluir', async () => {
    const { admin, so, t } = await publishedSofa('none');
    expect(await db().serviceOrderMaterial.count({ where: { serviceOrderId: so.id } })).toBe(0);
    const corte = await taskOf(admin, t('CORTE_TECIDO').id);
    // A etapa continua marcada como "exige materiais" pelo modelo padrão — e mesmo assim libera.
    expect(
      (await db().productionTask.findUniqueOrThrow({ where: { id: corte.id } })).requiresMaterials,
    ).toBe(true);
    expect(corte.status).toBe('LIBERADA');
    expect(corte.blockers).not.toContain('MATERIAIS');
    await runOnTablet(admin, corte.id);
    // A OS informa, sem impedir: materiais e medições "não impedem o início".
    const os = ok<J>(await admin.get(`/api/v1/service-orders/${so.id}`));
    expect(os.readiness).toMatchObject({
      materialsGate: false,
      materials: 'INFORMATIVO',
      measurements: 'INFORMATIVO',
      simpleMaterialsPending: 0,
    });
  });

  it('B — tecido cadastrado na OS e NÃO comprado: a produção inicia', async () => {
    const { admin, so, t } = await publishedSofa('none', async (a, s) => {
      ok(
        await send(a, 'POST', L(s.id), {
          description: 'Tecido linho bege',
          quantity: 12,
          unit: 'm',
          purchased: false,
          available: false,
        }),
        201,
      );
    });
    const corte = await taskOf(admin, t('CORTE_TECIDO').id);
    expect(corte.status).toBe('LIBERADA');
    await runOnTablet(admin, corte.id);
    const list = ok<J>(await admin.get(L(so.id)));
    expect(list.materials[0]).toMatchObject({ purchased: false, available: false });
  });

  it('C — material indisponível na oficina: inicia, e o aviso informativo continua (OS e tablet)', async () => {
    const { admin, so, t } = await publishedSofa('none', async (a, s) => {
      ok(
        await send(a, 'POST', L(s.id), {
          description: 'Espuma D33',
          quantity: 2,
          unit: 'placa',
          purchased: true,
          available: false,
        }),
        201,
      );
    });
    // Aviso preservado na lista da OS e na prontidão (só informa).
    const list = ok<J>(await admin.get(L(so.id)));
    expect(list.notice).toBe('Existem materiais ainda não disponíveis na oficina.');
    const os = ok<J>(await admin.get(`/api/v1/service-orders/${so.id}`));
    expect(os.readiness).toMatchObject({ materials: 'INFORMATIVO', simpleMaterialsPending: 1 });
    // No tablet: a etapa está LIBERADA e mostra "materiais faltando" só como informação.
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const corteId = t('CORTE_TECIDO').id;
    const detail = ok<J>(await ricardo.get(`/api/v1/production-tasks/${corteId}`));
    expect(detail.status).toBe('LIBERADA');
    expect(detail.taskMaterials).toBe('FALTANDO');
    expect(detail.blockers).not.toContain('MATERIAIS');
    // "Minhas tarefas" (cartão do tablet): o mesmo aviso, sem impedir — e só onde há falta.
    const mine = ok<J>(await ricardo.get('/api/v1/production-tasks/mine'));
    const card = mine.today.find((x: J) => x.id === corteId);
    expect(card).toMatchObject({ status: 'LIBERADA', osMaterialsMissing: true });
    expect((await act(ricardo, corteId, 'start')).status).toBe(200);
  });

  it('D — sem pedido de compra, fornecedor, aprovação, recebimento ou reserva: o funcionário inicia', async () => {
    const { admin, t } = await publishedSofa('none');
    const d = db();
    expect(await d.purchaseOrder.count()).toBe(0);
    expect(await d.supplier.count()).toBe(0);
    expect(await d.materialRequest.count()).toBe(0);
    expect(await d.materialReceipt.count()).toBe(0);
    expect(await d.stockReservation.count()).toBe(0);
    await runOnTablet(admin, t('CORTE_TECIDO').id);
  });

  it('E — sem medição formal (e com solicitação aprovada ainda não comprada): não bloqueia por materiais', async () => {
    // Sem nenhuma medição.
    const sem = await publishedSofa('none');
    expect(await db().measurementRevision.count()).toBe(0);
    expect((await taskOf(sem.admin, sem.t('CORTE_TECIDO').id)).status).toBe('LIBERADA');
    // Cadeia formal começada e parada no meio (medição → solicitação aprovada, sem compra).
    await resetDatabase();
    await db().companySettings.update({
      where: { id: 1 },
      data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
    });
    const meio = await publishedSofa('missing');
    const readiness = ok<J>(
      await meio.admin.get(`/api/v1/service-orders/${meio.so.id}/material-readiness`),
    );
    expect(readiness.state).not.toBe('COMPLETO');
    const corte = await taskOf(meio.admin, meio.t('CORTE_TECIDO').id);
    expect(corte.status).toBe('LIBERADA');
    await runOnTablet(meio.admin, corte.id);
  });

  it('F — segurança: dependências, responsável, plano não publicado, tarefa concluída e execução simultânea continuam valendo', async () => {
    const { admin, t } = await publishedSofa('none');
    const corte = t('CORTE_TECIDO');
    // Dependência real: a costura depende do corte.
    const costura = await taskOf(admin, t('COSTURA').id);
    expect(costura.status).toBe('BLOQUEADA');
    expect(costura.blockers).toEqual(['DEPENDENCIAS']);
    // Outro funcionário não inicia a tarefa do titular (autorização no servidor).
    const marcio = await tabletOf(app, admin, 'Márcio', '736152');
    expect((await act(marcio, corte.id, 'start')).status).not.toBe(200);
    // Conflito real de execução: o titular não roda duas etapas principais ao mesmo tempo.
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    expect((await act(ricardo, corte.id, 'start')).status).toBe(200);
    expect((await act(ricardo, costura.id, 'start')).status).not.toBe(200);
    // Tarefa concluída não volta a iniciar.
    expect((await act(ricardo, corte.id, 'complete', { note: 'ok' })).status).toBe(200);
    expect((await act(ricardo, corte.id, 'start')).status).not.toBe(200);
    // Bloqueio manual do gestor continua impedindo (etapa de apoio do João, liberada).
    const desmontagem = await taskOf(admin, t('DESMONTAGEM').id);
    expect(desmontagem.status).toBe('LIBERADA');
    ok(
      await admin.post(`/api/v1/production-tasks/${desmontagem.id}/block`, {
        reason: 'Aguardando decisão do cliente',
      }),
    );
    expect((await taskOf(admin, desmontagem.id)).blockers).toContain('BLOQUEIO');
    const joao = await tabletOf(app, admin, 'João', '271828');
    expect((await act(joao, desmontagem.id, 'start')).status).not.toBe(200);
    // Tarefa de plano ainda não publicado (rascunho) não chega ao tablet nem inicia.
    const admin2 = admin;
    const { so: so2 } = await serviceOrderWith(admin2, 'none', 'Cliente Rascunho');
    const plan2 = await createPlan(admin2, day(7));
    const draft = await addOs(admin2, plan2.id, {
      serviceOrderId: so2.id,
      principalUserId: await userIdOf('Ricardo'),
      date: day(7),
    });
    expect(draft.status).toBe(201);
    const draftCut = sofaTask(draft.body, so2.items[0].id, 'CORTE_TECIDO');
    expect((await act(ricardo, draftCut.id, 'start')).status).not.toBe(200);
  });

  it('H — compatibilidade: compras, recebimentos, medições e históricos continuam íntegros; ligar a trava restaura o comportamento formal', async () => {
    const { admin, so, t } = await publishedSofa('complete');
    const d = db();
    const counts = async () => ({
      purchaseOrders: await d.purchaseOrder.count(),
      receipts: await d.materialReceipt.count(),
      requests: await d.materialRequest.count(),
      measurements: await d.measurementRevision.count(),
      audit: await d.auditLog.count(),
    });
    const before = await counts();
    expect(before.purchaseOrders).toBe(1);
    expect(before.receipts).toBe(1);
    // A prontidão formal continua calculada e consultável.
    const readiness = ok<J>(await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`));
    expect(readiness.state).toBe('COMPLETO');
    expect(ok<J>(await admin.get('/api/v1/purchase-orders')).length ?? 1).toBeGreaterThan(0);
    await runOnTablet(admin, t('CORTE_TECIDO').id);
    // Nada formal foi apagado ou alterado pela execução.
    const after = await counts();
    expect(after.purchaseOrders).toBe(before.purchaseOrders);
    expect(after.receipts).toBe(before.receipts);
    expect(after.requests).toBe(before.requests);
    expect(after.measurements).toBe(before.measurements);
    expect(after.audit).toBeGreaterThan(before.audit);
  });

  it('H — quem quiser o controle formal liga a trava: volta a bloquear; desligar libera de novo', async () => {
    const { admin, t } = await publishedSofa('missing');
    const corte = t('CORTE_TECIDO');
    expect((await taskOf(admin, corte.id)).status).toBe('LIBERADA');
    ok(await setModule(admin, 'materiais', true));
    expect(await taskOf(admin, corte.id)).toMatchObject({
      status: 'BLOQUEADA',
      blockers: ['MATERIAIS'],
    });
    ok(await setModule(admin, 'materiais', false));
    expect((await taskOf(admin, corte.id)).status).toBe('LIBERADA');
  });

  it('H — tarefas gravadas como bloqueadas por MATERIAIS antes da mudança do padrão são liberadas pelo ciclo periódico', async () => {
    // Simula uma instalação existente: a trava estava ligada e a tarefa foi gravada bloqueada.
    const { admin, t } = await publishedSofa('none', async (a) => {
      ok(await setModule(a, 'materiais', true));
    });
    const corte = t('CORTE_TECIDO');
    expect(await taskOf(admin, corte.id)).toMatchObject({ status: 'BLOQUEADA' });
    // Volta ao padrão sem registro (como uma instalação que nunca gravou a configuração): a tarefa
    // continua gravada como bloqueada até o ciclo periódico reavaliá-la.
    await db().moduleSetting.deleteMany({ where: { key: 'materiais' } });
    expect((await taskOf(admin, corte.id)).blockers).toContain('MATERIAIS');
    expect(await releaseDueTasks(db())).toBeGreaterThanOrEqual(1);
    expect(await taskOf(admin, corte.id)).toMatchObject({ status: 'LIBERADA' });
    // Idempotente: um novo ciclo não muda mais nada nessa tarefa.
    await releaseDueTasks(db());
    expect((await taskOf(admin, corte.id)).status).toBe('LIBERADA');
  });
});
