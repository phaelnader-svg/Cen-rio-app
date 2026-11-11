import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { processHelpQueue } from '../src/modules/help/queue';
import type { Client } from './helpers';
import {
  Client as HttpClient,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
} from './helpers';
import { panelUserWith } from './commercial-helpers';
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

/**
 * Reformulação, Fase 0 — interruptores de funcionalidade e desativação reversível dos pedidos de
 * ajuda. Padrão = comportamento anterior; desligada, a ajuda é recusada no SERVIDOR (não só
 * escondida), não vira pendência nem aviso, e nada do histórico é apagado; religar recupera tudo.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const setClock = (hhmm: string) => setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));
const PINS: Record<string, string> = { Ricardo: '482915', Márcio: '736152', João: '121212' };

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
    data: {
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      arrivalWindowStart: '07:00',
      workdayStart: '08:30',
    },
  });
  setClock('08:00');
});
afterEach(() => setAttendanceClock());

const put = (c: Client, key: string, body: unknown) =>
  c.put(`/api/company/modules/${key}`, body, { 'idempotency-key': idemKey() });
const setHelp = async (admin: Client, enabled: boolean) => {
  const current = (
    (await admin.get('/api/company/modules')).body as { key: string; version: number }[]
  ).find((m) => m.key === 'ajuda')!;
  const r = await put(admin, 'ajuda', { enabled, version: current.version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const ask = (c: Client, taskId: string) =>
  c.post('/api/v1/help-requests', { taskId, kind: 'PARAFUSAR' }, { 'idempotency-key': idemKey() });

/** Sofá publicado com materiais completos; Ricardo (corte) e João (desmontagem) presentes. */
async function workshop(arrive: string[] = ['Ricardo', 'João']) {
  const admin = await loginAdmin(app);
  const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Fase Zero');
  const ricardo = await userIdOf('Ricardo');
  const joao = await userIdOf('João');
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, { serviceOrderId: so.id, principalUserId: ricardo, date: day(-1) })
  ).body;
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added, so.items[0].id, a), joao);
  const published = await publish(
    admin,
    (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
  );
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'João'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  setClock('08:30');
  const arriveNow = async (name: string) =>
    expect(
      (
        await tablets[name]!.post(
          '/api/v1/attendance/me/arrive',
          {},
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(200);
  for (const name of arrive) await arriveNow(name);
  setClock('09:00');
  return {
    admin,
    so,
    tablets,
    arriveNow,
    main: sofaTask(published, so.items[0].id, 'CORTE_TECIDO') as { id: string },
  };
}

describe('Interruptores de funcionalidade', () => {
  it('sem configuração gravada: tudo ligado (comportamento anterior), versão 0, só "ajuda" configurável', async () => {
    const admin = await loginAdmin(app);
    expect((await admin.get('/api/v1/modules')).body).toEqual({
      logistica: true,
      ajuda: true,
      embalagem: true,
    });
    const list = (await admin.get('/api/company/modules')).body as {
      key: string;
      enabled: boolean;
      configurable: boolean;
      version: number;
      updatedBy: unknown;
    }[];
    expect(list.map((m) => m.key)).toEqual(['logistica', 'ajuda', 'embalagem']);
    expect(list.every((m) => m.enabled && m.version === 0 && m.updatedBy === null)).toBe(true);
    expect(list.filter((m) => m.configurable).map((m) => m.key)).toEqual(['ajuda']);
    expect(await db().moduleSetting.count()).toBe(0);
  });

  it('registro desconhecido ou de chave ainda não configurável não muda nada nem quebra a leitura', async () => {
    await db().moduleSetting.createMany({
      data: [
        { key: 'modulo_futuro', enabled: false },
        { key: 'logistica', enabled: false },
        { key: 'embalagem', enabled: false },
      ],
    });
    const admin = await loginAdmin(app);
    expect((await admin.get('/api/v1/modules')).body).toEqual({
      logistica: true,
      ajuda: true,
      embalagem: true,
    });
  });

  it('alteração: só o gestor com empresa.configurar; versão conferida; auditada; repetir o mesmo estado não grava', async () => {
    const admin = await loginAdmin(app);
    const s = await workshop();
    // Tablet (sessão de produção) lê o estado, mas não altera.
    expect((await s.tablets.Ricardo!.get('/api/v1/modules')).status).toBe(200);
    expect((await put(s.tablets.Ricardo!, 'ajuda', { enabled: false, version: 0 })).status).toBe(
      403,
    );
    expect((await s.tablets.Ricardo!.get('/api/company/modules')).status).toBe(403);
    // Painel só com empresa.ver: lê, não altera.
    const viewer = await panelUserWith(app, admin, 'empresa-ver', [
      'painel.acessar',
      'empresa.ver',
    ]);
    expect((await viewer.get('/api/company/modules')).status).toBe(200);
    expect((await put(viewer, 'ajuda', { enabled: false, version: 0 })).status).toBe(403);
    // Anônimo.
    expect((await new HttpClient(app).get('/api/v1/modules')).status).toBe(401);
    // Entrada inválida, chave inexistente, chave ainda não configurável.
    expect((await put(admin, 'ajuda', { enabled: 'nao', version: 0 })).status).toBe(400);
    expect((await put(admin, 'inexistente', { enabled: false, version: 0 })).status).toBe(404);
    const logi = await put(admin, 'logistica', { enabled: false, version: 0 });
    expect(logi.status).toBe(422);
    expect((await put(admin, 'embalagem', { enabled: false, version: 0 })).status).toBe(422);
    expect(await db().moduleSetting.count()).toBe(0);
    // Versão desatualizada.
    expect((await put(admin, 'ajuda', { enabled: false, version: 3 })).body.error.code).toBe(
      'VERSION_CONFLICT',
    );
    // Alteração válida.
    const off = await put(admin, 'ajuda', { enabled: false, version: 0 });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({
      key: 'ajuda',
      enabled: false,
      version: 1,
      updatedBy: { displayName: 'Gestor Teste' },
    });
    expect((await admin.get('/api/v1/modules')).body.ajuda).toBe(false);
    const audits = await db().auditLog.findMany({ where: { action: 'company.module_updated' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'module_setting', entityId: 'ajuda' });
    expect(await db().domainEvent.count({ where: { type: 'company.module_updated' } })).toBe(1);
    // A versão antiga não vale mais; repetir o mesmo estado com a versão certa não grava nada.
    expect((await put(admin, 'ajuda', { enabled: true, version: 0 })).status).toBe(409);
    expect((await put(admin, 'ajuda', { enabled: false, version: 1 })).body.version).toBe(1);
    expect(await db().auditLog.count({ where: { action: 'company.module_updated' } })).toBe(1);
    // Logística e embalagem continuam ligadas (fora desta fase).
    expect((await admin.get('/api/v1/modules')).body).toMatchObject({
      logistica: true,
      embalagem: true,
    });
  });
});

describe('Pedidos de ajuda desligados e religados', () => {
  it('ligados (padrão): o comportamento anterior continua — pedido criado e atribuído', async () => {
    const s = await workshop();
    const r = await ask(s.tablets.Ricardo!, s.main.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('ATRIBUIDA');
  });

  it('desligados: servidor recusa (409 MODULE_DISABLED), nada vira pendência ou aviso; produção e ocorrências seguem; histórico preservado; religar recupera', async () => {
    // Só o Ricardo chegou: o pedido URGENTE feito antes de desligar fica na fila (sem ajudante).
    const s = await workshop(['Ricardo']);
    const old = await s.tablets.Ricardo!.post(
      '/api/v1/help-requests',
      { taskId: s.main.id, kind: 'PARAFUSAR', urgent: true, justification: 'Peça pesada demais' },
      { 'idempotency-key': idemKey() },
    );
    expect(old.status, JSON.stringify(old.body)).toBe(201);
    expect(old.body.status).toBe('PENDENTE');
    expect(JSON.stringify((await s.admin.get('/api/v1/attention')).body)).toContain(old.body.id);
    const helpRows = await db().helpRequest.count();
    const helpEvents = await db().helpRequestEvent.count();
    const gestor = (await s.admin.get('/api/auth/me')).body.user.id as string;
    await db().notification.create({
      data: {
        userId: gestor,
        kind: 'AJUDA_SOLICITADA',
        title: 'Ajuda solicitada',
        body: 'Pedido antigo',
        dedupeKey: 'teste-fase0',
      },
    });
    const before = (await s.admin.get('/api/v1/notifications')).body;
    expect(before.items.some((n: { kind: string }) => n.kind === 'AJUDA_SOLICITADA')).toBe(true);

    await setHelp(s.admin, false);
    // João chega depois de desligar: a chegada dispara a fila, que não atribui nada.
    await s.arriveNow('João');

    // Servidor: criação, apoio prolongado, atribuição manual e fila recusados com código explícito.
    const denied = await ask(s.tablets.Ricardo!, s.main.id);
    expect(denied.status).toBe(409);
    expect(denied.body.error).toMatchObject({
      code: 'MODULE_DISABLED',
      details: { module: 'ajuda' },
    });
    const prolonged = await s.tablets.Ricardo!.post(
      '/api/v1/help-requests/prolonged',
      { taskId: s.main.id, estimatedMinutes: 120, justification: 'Peça grande demais' },
      { 'idempotency-key': idemKey() },
    );
    expect(prolonged.status).toBe(409);
    expect(
      (await s.admin.post('/api/v1/help-requests/process', {}, { 'idempotency-key': idemKey() }))
        .body.error.code,
    ).toBe('MODULE_DISABLED');
    expect(
      (
        await s.admin.post(
          `/api/v1/help-requests/${old.body.id}/assign`,
          { helperUserId: await userIdOf('João') },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(409);
    // A fila automática não atribui o pedido antigo.
    expect(await processHelpQueue(app.ctx.prisma)).toBe(0);
    expect((await db().helpRequest.findUniqueOrThrow({ where: { id: old.body.id } })).status).toBe(
      'PENDENTE',
    );

    // Central e avisos: nenhum pedido de ajuda como pendência; aviso de ajuda fora da caixa e do contador.
    const attention = (await s.admin.get('/api/v1/attention')).body;
    expect(JSON.stringify(attention)).not.toContain('"type":"AJUDA"');
    const after = (await s.admin.get('/api/v1/notifications')).body;
    expect(after.items.some((n: { kind: string }) => n.kind.startsWith('AJUDA_'))).toBe(false);
    // O contador conta só os avisos ativos, não lidos e visíveis (os de ajuda ficam de fora).
    expect(after.unread).toBe(
      await db().notification.count({
        where: {
          userId: gestor,
          readAt: null,
          resolvedAt: null,
          kind: { not: { startsWith: 'AJUDA_' } },
        },
      }),
    );
    expect(
      await db().notification.count({
        where: { userId: gestor, readAt: null, resolvedAt: null, kind: { startsWith: 'AJUDA_' } },
      }),
    ).toBeGreaterThan(0);

    // Produção segue: iniciar, pausar, retomar e concluir (João, desmontagem).
    const joaoTask = (
      (await s.tablets.João!.get('/api/v1/production-tasks/mine')).body.today as {
        id: string;
        status: string;
      }[]
    ).find((t: { status: string }) => t.status === 'LIBERADA')!;
    expect(joaoTask).toBeTruthy();
    expect((await act(s.tablets.João!, joaoTask.id, 'start')).status).toBe(200);
    expect(
      (await act(s.tablets.João!, joaoTask.id, 'pause', { reason: 'AGUARDANDO_ORIENTACAO' }))
        .status,
    ).toBe(200);
    expect((await act(s.tablets.João!, joaoTask.id, 'resume')).status).toBe(200);
    expect((await act(s.tablets.João!, joaoTask.id, 'complete', { note: 'ok' })).status).toBe(200);
    // Ocorrências seguem.
    const issue = await s.tablets.Ricardo!.post(
      '/api/v1/issues',
      {
        taskId: s.main.id,
        kind: 'OUTRO',
        impact: 'DIFICULDADE',
        canContinue: true,
        description: 'Teste com ajuda desligada',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);

    // Histórico preservado e consultável pelo gestor; cancelar o pedido antigo continua possível.
    expect(await db().helpRequest.count()).toBe(helpRows);
    expect(await db().helpRequestEvent.count()).toBeGreaterThanOrEqual(helpEvents);
    expect(
      await db().notification.count({ where: { kind: 'AJUDA_SOLICITADA', userId: gestor } }),
    ).toBeGreaterThan(0);
    const hist = await s.admin.get('/api/v1/help-requests');
    expect(hist.status).toBe(200);
    expect(hist.body.some((h: { id: string }) => h.id === old.body.id)).toBe(true);

    // Religar: o pedido antigo volta à fila, o aviso volta à caixa e novos pedidos são aceitos.
    await setHelp(s.admin, true);
    expect(
      (await s.admin.get('/api/v1/notifications')).body.items.some(
        (n: { kind: string }) => n.kind === 'AJUDA_SOLICITADA',
      ),
    ).toBe(true);
    expect(JSON.stringify((await s.admin.get('/api/v1/attention')).body)).toContain(old.body.id);
    // Com o João presente, a fila volta a atribuir o pedido antigo.
    await processHelpQueue(app.ctx.prisma);
    expect((await db().helpRequest.findUniqueOrThrow({ where: { id: old.body.id } })).status).toBe(
      'ATRIBUIDA',
    );
    // Novo pedido volta a ser aceito pelo módulo (aqui cai na regra antiga de um pedido aberto por
    // tarefa — o antigo acabou de ser atribuído —, nunca mais em MODULE_DISABLED).
    const again = await ask(s.tablets.Ricardo!, s.main.id);
    expect(again.body.error?.code).not.toBe('MODULE_DISABLED');
  });
});
