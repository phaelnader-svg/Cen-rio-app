import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { detectAbsences } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import {
  WsClient,
  createTestApp,
  db,
  employeeByName,
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

/** Fase 7 — presença operacional (não é ponto eletrônico). Relógio fixo para regras de horário. */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';
const at = (hhmm: string) => zonedDateTime(today(), hhmm, TZ);
const setClock = (hhmm: string) => setAttendanceClock(() => at(hhmm));

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  // Todo dia é útil nos testes (o relógio é fixado em "hoje").
  await db().companySettings.update({
    where: { id: 1 },
    data: {
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      arrivalWindowStart: '07:00',
      workdayStart: '08:30',
      arrivalAlertAt: '09:30',
      workdayEnd: '18:00',
      lateAlertMinutes: 15,
    },
  });
  setClock('08:00');
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const arrive = (c: Client, key = idemKey()) =>
  c.post('/api/v1/attendance/me/arrive', {}, { 'idempotency-key': key });
const depart = (c: Client, body: unknown = {}) =>
  c.post('/api/v1/attendance/me/depart', body, { 'idempotency-key': idemKey() });
type Day = { employee: { displayName: string }; availability: string; situation: string | null };
const teamDay = async (admin: Client, name: string) =>
  ((await admin.get('/api/v1/attendance/team')).body.days as Day[]).find(
    (d) => d.employee.displayName === name,
  )!;
const gestorNotices = async (admin: Client) =>
  db().notification.findMany({
    where: { userId: (await admin.get('/api/auth/me')).body.user.id },
    orderBy: { createdAt: 'asc' },
  });
const action = (admin: Client, body: Record<string, unknown>) =>
  admin.post('/api/v1/attendance/actions', { date: today(), ...body });

/** Sofá publicado: João com desmontagem/preparação; Márcio principal (montagem depende da preparação). */
async function production(admin: Client, date = day(0)) {
  const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Presença');
  const marcio = await userIdOf('Márcio');
  const joao = await userIdOf('João');
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, { serviceOrderId: so.id, principalUserId: marcio, date })
  ).body;
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added, so.items[0].id, a), joao);
  const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
  const published = await publish(admin, draft);
  return (a: string) => sofaTask(published, so.items[0].id, a);
}

describe('Cheguei', () => {
  it('chegada às 8h30: no horário, um toque, dispositivo e histórico; painel atualiza', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const w = track(await WsClient.connect(app, admin));
    setClock('08:30');
    const r = await arrive(ricardo);
    expect(r.status).toBe(200);
    expect(r.body.day).toMatchObject({
      situation: 'PRESENTE',
      arrivalKind: 'NO_HORARIO',
      lateMinutes: 0,
      availability: 'DISPONIVEL',
    });
    expect(r.body.canArrive).toBe(false);
    const row = await db().operationalAttendance.findFirstOrThrow({});
    expect(row.arrivalDeviceId).not.toBeNull();
    expect(row.arrivedAt?.toISOString()).toBe(at('08:30').toISOString());
    expect(await db().attendanceCorrection.count({ where: { action: 'CHEGADA' } })).toBe(1);
    await w.waitFor((m) => m.kind === 'event' && m.event.type === 'attendance.arrived');
    expect((await teamDay(admin, 'Ricardo')).availability).toBe('DISPONIVEL');
    // Chegada normal não gera alerta ao gestor.
    expect(await gestorNotices(admin)).toHaveLength(0);
  });

  it('antes da janela não aceita; atraso operacional registrado e alerta só acima da tolerância', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const thiago = await tabletOf(app, admin, 'Thiago', '271828');
    setClock('06:40');
    const early = await arrive(ricardo);
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/07:00/);
    setClock('08:40');
    expect((await arrive(thiago)).body.day).toMatchObject({
      arrivalKind: 'ATRASO',
      lateMinutes: 10,
    });
    expect(await gestorNotices(admin)).toHaveLength(0); // 10 min < 15 min
    setClock('08:52');
    expect((await arrive(ricardo)).body.day).toMatchObject({
      arrivalKind: 'ATRASO',
      lateMinutes: 22,
    });
    const n = await gestorNotices(admin);
    expect(n.map((x) => x.kind)).toEqual(['ATRASO_OPERACIONAL']);
    expect(await db().domainEvent.count({ where: { type: 'attendance.late' } })).toBe(2);
  });

  it('confirmação duplicada (repetição e toques simultâneos) não cria novo registro', async () => {
    const admin = await loginAdmin(app);
    const joao = await tabletOf(app, admin, 'João', '121212');
    setClock('08:20');
    const results = await Promise.all([arrive(joao), arrive(joao), arrive(joao)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    setClock('08:45');
    const again = await arrive(joao);
    expect(again.body.day.arrivedAt).toBe(at('08:20').toISOString());
    expect(await db().operationalAttendance.count()).toBe(1);
    expect(await db().attendanceCorrection.count({ where: { action: 'CHEGADA' } })).toBe(1);
    expect(await db().domainEvent.count({ where: { type: 'attendance.arrived' } })).toBe(1);
  });

  it('sessão permanente sem PIN diário; revogação bloqueia o Cheguei', async () => {
    const admin = await loginAdmin(app);
    const marcio = await tabletOf(app, admin, 'Márcio', '736152');
    const me = (await marcio.get('/api/auth/me')).body;
    // Último uso ontem à tarde: a mesma sessão confirma a chegada de hoje.
    await db().session.update({
      where: { id: me.session.id },
      data: { lastSeenAt: new Date(Date.now() - 16 * 3_600_000) },
    });
    setClock('08:28');
    expect((await arrive(marcio)).status).toBe(200);
    expect((await admin.post(`/api/sessions/${me.session.id}/revoke`)).status).toBe(204);
    expect((await marcio.get('/api/v1/attendance/me')).status).toBe(401);
    expect((await arrive(marcio)).status).toBe(401);
  });
});

describe('Ausência presumida e impacto na produção', () => {
  it('9h30 sem confirmação: ausência presumida, tarefas e dependentes afetados, alerta único ao gestor', async () => {
    const admin = await loginAdmin(app);
    const t = await production(admin);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const marcioT = await tabletOf(app, admin, 'Márcio', '736152');
    const thiago = await tabletOf(app, admin, 'Thiago', '271828');
    setClock('08:25');
    for (const c of [ricardo, marcioT, thiago]) await arrive(c);
    const statusBefore = await db().productionTask.findMany({
      select: { id: true, status: true, assigneeUserId: true },
    });

    setClock('09:29');
    expect(await detectAbsences(app.ctx.prisma)).toBe(0);
    setClock('09:30');
    expect(await detectAbsences(app.ctx.prisma)).toBe(1);
    expect(await detectAbsences(app.ctx.prisma)).toBe(0); // idempotente

    const joao = await teamDay(admin, 'João');
    expect(joao).toMatchObject({
      situation: 'AUSENCIA_PRESUMIDA',
      availability: 'AUSENCIA_PRESUMIDA',
    });
    const impacts = (await admin.get('/api/v1/attendance/impacts')).body as {
      kind: string;
      task: { id: string };
      affectedUser: string | null;
      detail: string;
    }[];
    const own = impacts.filter((i) => i.kind === 'TAREFA_DO_AUSENTE').map((i) => i.task.id);
    expect(own).toEqual(expect.arrayContaining([t('DESMONTAGEM').id, t('PREPARACAO').id]));
    // A montagem do Márcio depende da preparação do João (e das etapas seguintes em cadeia).
    const montagem = impacts.find((i) => i.task.id === t('MONTAGEM').id)!;
    expect(montagem).toMatchObject({ kind: 'DEPENDENTE_AFETADA', affectedUser: 'Márcio' });
    expect(montagem.detail).toMatch(/Necessário reprogramar/);
    expect(impacts.some((i) => i.task.id === t('ACABAMENTO').id)).toBe(true);
    // Um alerta para o gestor (não um por tarefa) e eventos recuperáveis.
    const n = await gestorNotices(admin);
    expect(n.filter((x) => x.kind === 'AUSENCIA_PRESUMIDA')).toHaveLength(1);
    expect(n[0]!.body).toMatch(/João não confirmou chegada até 09:30/);
    expect(await db().domainEvent.count({ where: { type: 'attendance.absence_suspected' } })).toBe(
      1,
    );
    expect(
      await db().domainEvent.count({ where: { type: 'attendance.production_impact_detected' } }),
    ).toBe(1);
    // Nada foi cancelado ou transferido automaticamente.
    const statusAfter = await db().productionTask.findMany({
      select: { id: true, status: true, assigneeUserId: true },
    });
    expect(statusAfter).toEqual(expect.arrayContaining(statusBefore));

    // Chegada depois da ausência presumida: situação atualizada e impactos encaminhados.
    const joaoT = await tabletOf(app, admin, 'João', '121212');
    setClock('09:50');
    const late = await arrive(joaoT);
    expect(late.body.day).toMatchObject({
      situation: 'PRESENTE',
      arrivalKind: 'APOS_AUSENCIA_PRESUMIDA',
      lateMinutes: 80,
    });
    const after = (await admin.get('/api/v1/attendance/impacts')).body as {
      resolvedAt: string | null;
      kind: string;
    }[];
    expect(after.every((i) => i.resolvedAt)).toBe(true);
    expect((await gestorNotices(admin)).some((x) => x.kind === 'CHEGADA_APOS_AUSENCIA')).toBe(true);
    const hist = (
      await admin.get(`/api/v1/attendance/history?employeeId=${(await employeeByName('João')).id}`)
    ).body;
    expect(hist.days[0].history.map((h: { action: string }) => h.action)).toEqual([
      'AUSENCIA_PRESUMIDA',
      'CHEGADA',
    ]);
  });

  it('ausência justificada, atestado, folga e trabalho externo não viram ausência presumida', async () => {
    const admin = await loginAdmin(app);
    const ids = Object.fromEntries(
      await Promise.all(
        ['Ricardo', 'Márcio', 'Thiago', 'João'].map(async (n) => [n, (await employeeByName(n)).id]),
      ),
    );
    expect(
      (
        await action(admin, {
          employeeId: ids['Ricardo'],
          action: 'FOLGA',
          reason: 'Folga combinada',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await action(admin, {
          employeeId: ids['Márcio'],
          action: 'ATESTADO',
          reason: 'Atestado informado',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await action(admin, {
          employeeId: ids['Thiago'],
          action: 'TRABALHO_EXTERNO',
          reason: 'Instalação',
          externalNote: 'Instalação de cabeceira no cliente',
        })
      ).body,
    ).toMatchObject({ situation: 'TRABALHO_EXTERNO', availability: 'EXTERNO' });
    // Trabalho externo sem descrição é recusado; férias para um dia futuro é aceito.
    expect(
      (
        await action(admin, {
          employeeId: ids['João'],
          action: 'TRABALHO_EXTERNO',
          reason: 'Sem descrição',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await action(admin, {
          employeeId: ids['João'],
          action: 'FERIAS',
          reason: 'Férias programadas',
          date: day(5),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await action(admin, {
          employeeId: ids['João'],
          action: 'AUSENCIA_JUSTIFICADA',
          reason: 'Consulta do filho',
        })
      ).status,
    ).toBe(200);
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(0);
    expect((await teamDay(admin, 'Márcio')).availability).toBe('AUSENTE');
    // Atestado guarda só o fato informado (nenhum campo médico existe no registro).
    const atestado = await db().operationalAttendance.findFirstOrThrow({
      where: { situation: 'ATESTADO' },
    });
    expect(Object.keys(atestado)).not.toContain('cid');
  });

  it('correção administrativa e confirmação de ausência preservam o histórico original', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const id = (await employeeByName('Ricardo')).id;
    setClock('08:52');
    await arrive(ricardo);
    const fixed = await action(admin, {
      employeeId: id,
      action: 'ESQUECIMENTO',
      arrivalTime: '08:20',
      reason: 'Chegou no horário e esqueceu de confirmar',
    });
    expect(fixed.body).toMatchObject({ arrivalKind: 'NO_HORARIO', lateMinutes: 0 });
    const hist = await db().attendanceCorrection.findMany({ orderBy: { createdAt: 'asc' } });
    expect(hist.map((h) => h.action)).toEqual(['CHEGADA', 'ESQUECIMENTO']);
    expect((hist[1]!.before as { lateMinutes: number }).lateMinutes).toBe(22);
    await expect(
      db().attendanceCorrection.delete({ where: { id: hist[0]!.id } }),
    ).rejects.toThrow();
    // Sem motivo: recusado.
    expect(
      (await action(admin, { employeeId: id, action: 'CORRECAO', arrivalTime: '08:00' })).status,
    ).toBe(400);
    // Ausência confirmada de quem não chegou; funcionário é avisado.
    const joao = await employeeByName('João');
    setClock('09:40');
    await detectAbsences(app.ctx.prisma);
    const confirmed = await action(admin, {
      employeeId: joao.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Avisou por telefone',
    });
    expect(confirmed.body).toMatchObject({
      situation: 'AUSENCIA_CONFIRMADA',
      availability: 'AUSENTE',
    });
    expect(
      await db().notification.count({
        where: { userId: joao.userId, kind: 'AUSENCIA_CONFIRMADA' },
      }),
    ).toBe(1);
    expect(await db().domainEvent.count({ where: { type: 'attendance.absence_confirmed' } })).toBe(
      1,
    );
  });
});

describe('Encerrar expediente', () => {
  it('normal, com tarefa em andamento e sem atualização de andamento', async () => {
    const admin = await loginAdmin(app);
    const t = await production(admin, day(-1));
    const joao = await tabletOf(app, admin, 'João', '121212');
    const thiago = await tabletOf(app, admin, 'Thiago', '271828');
    setClock('08:15');
    // Sem chegada, não há saída a registrar.
    expect((await depart(thiago)).status).toBe(422);
    await arrive(thiago);
    await arrive(joao);
    // Disponibilidade acompanha as tarefas: ocupado, em pausa, disponível.
    await act(joao, t('DESMONTAGEM').id, 'start');
    expect((await teamDay(admin, 'João')).availability).toBe('OCUPADO');
    await act(joao, t('DESMONTAGEM').id, 'pause', { reason: 'AGUARDANDO_ORIENTACAO' });
    expect((await teamDay(admin, 'João')).availability).toBe('EM_PAUSA');
    await act(joao, t('DESMONTAGEM').id, 'resume');
    expect(
      await db().domainEvent.count({ where: { type: 'attendance.availability_changed' } }),
    ).toBeGreaterThanOrEqual(3);

    // Encerramento normal (sem tarefas) às 18h05.
    setClock('18:05');
    const normal = await depart(thiago, { note: 'Dia tranquilo' });
    expect(normal.body.day).toMatchObject({
      situation: 'ENCERRADO',
      earlyDeparture: false,
      availability: 'ENCERRADO',
    });
    expect((await depart(thiago)).status).toBe(200); // repetição não duplica
    expect(await db().attendanceCorrection.count({ where: { action: 'SAIDA' } })).toBe(1);

    // João: duas tarefas em execução? Só uma; encerra informando o andamento dela.
    await act(joao, t('DESMONTAGEM').id, 'progress', { note: 'Braços soltos' });
    const me = (await joao.get('/api/v1/attendance/me')).body;
    expect(me.openTasks.map((x: { id: string }) => x.id)).toEqual([t('DESMONTAGEM').id]);
    const done = await depart(joao, {
      tasks: [
        {
          taskId: t('DESMONTAGEM').id,
          step: 'Estrutura exposta',
          nextStep: 'Retirar molas',
          percent: 60,
        },
      ],
    });
    expect(done.status).toBe(200);
    const task = await db().productionTask.findUniqueOrThrow({
      where: { id: t('DESMONTAGEM').id },
    });
    expect(task).toMatchObject({
      status: 'PAUSADA',
      pauseReason: 'FIM_EXPEDIENTE',
      progressStep: 'Estrutura exposta',
      progressPercent: 60,
    });
    expect(await db().attendanceImpact.count({ where: { kind: 'ANDAMENTO_PENDENTE' } })).toBe(0);
    expect(
      (await gestorNotices(admin)).some((n) => n.kind === 'TAREFA_PENDENTE_ENCERRAMENTO'),
    ).toBe(false);
  });

  it('saída antecipada sem informar andamento: saída registrada, tarefa pausada e pendência ao gestor', async () => {
    const admin = await loginAdmin(app);
    const t = await production(admin, day(-1));
    const joao = await tabletOf(app, admin, 'João', '121212');
    setClock('08:10');
    await arrive(joao);
    await act(joao, t('DESMONTAGEM').id, 'start');
    await act(joao, t('DESMONTAGEM').id, 'progress', { note: 'Assento solto', percent: 30 });
    setClock('16:00');
    const r = await depart(joao);
    expect(r.status).toBe(200);
    expect(r.body.day).toMatchObject({ situation: 'ENCERRADO', earlyDeparture: true });
    const task = await db().productionTask.findUniqueOrThrow({
      where: { id: t('DESMONTAGEM').id },
    });
    // O andamento anterior é preservado.
    expect(task).toMatchObject({
      status: 'PAUSADA',
      progressNote: 'Assento solto',
      progressPercent: 30,
    });
    const pend = (await admin.get('/api/v1/attendance/impacts')).body as {
      kind: string;
      task: { id: string };
      resolvedAt: string | null;
      id: string;
    }[];
    expect(pend).toEqual([
      expect.objectContaining({
        kind: 'ANDAMENTO_PENDENTE',
        task: expect.objectContaining({ id: task.id }),
      }),
    ]);
    expect((await gestorNotices(admin)).map((n) => n.kind)).toContain(
      'TAREFA_PENDENTE_ENCERRAMENTO',
    );
    expect(
      await db().notification.count({
        where: { userId: await userIdOf('João'), kind: 'EXPEDIENTE_ENCERRADO' },
      }),
    ).toBe(1);
    // O gestor encaminha a pendência.
    const resolved = await admin.post(`/api/v1/attendance/impacts/${pend[0]!.id}/resolve`, {
      resolution: 'Conversado com o João',
    });
    expect(resolved.status).toBe(200);
    expect(
      (
        await admin.post(`/api/v1/attendance/impacts/${pend[0]!.id}/resolve`, {
          resolution: 'De novo',
        })
      ).status,
    ).toBe(422);
  });
});

describe('Permissões, configuração, tempo real e reconexão', () => {
  it('cada um só a própria presença; gestão por permissão; horários configuráveis', async () => {
    const admin = await loginAdmin(app);
    const joao = await tabletOf(app, admin, 'João', '121212');
    const ricardoId = (await employeeByName('Ricardo')).id;
    // Tablet não consulta a equipe nem corrige registros (nem os de outro funcionário).
    expect((await joao.get('/api/v1/attendance/team')).status).toBe(403);
    expect(
      (
        await joao.post('/api/v1/attendance/actions', {
          employeeId: ricardoId,
          date: today(),
          action: 'ESQUECIMENTO',
          arrivalTime: '08:00',
          reason: 'tentativa',
        })
      ).status,
    ).toBe(403);
    // O "Cheguei" não aceita indicar outra pessoa: o corpo é ignorado, vale o usuário da sessão.
    setClock('08:30');
    await joao.post(
      '/api/v1/attendance/me/arrive',
      { employeeId: ricardoId },
      { 'idempotency-key': idemKey() },
    );
    expect(await db().operationalAttendance.count({ where: { employeeId: ricardoId } })).toBe(0);
    // Consulta sem gerenciar.
    const viewer = await panelUserWith(app, admin, 'consulta-presenca', ['presenca.ver']);
    expect((await viewer.get('/api/v1/attendance/team')).status).toBe(200);
    expect(
      (
        await viewer.post('/api/v1/attendance/actions', {
          employeeId: ricardoId,
          date: today(),
          action: 'FOLGA',
          reason: 'tentativa',
        })
      ).status,
    ).toBe(403);
    // A equipe são os quatro funcionários (o gestor não registra presença).
    const names = (await admin.get('/api/v1/attendance/team')).body.days.map(
      (d: { employee: { displayName: string } }) => d.employee.displayName,
    );
    expect(names.sort()).toEqual(['João', 'Márcio', 'Ricardo', 'Thiago']);
    // Horários e tolerância configuráveis pela empresa (com validação).
    const company = (await admin.get('/api/company/settings')).body;
    const bad = await admin.put('/api/company/settings', {
      ...company,
      arrivalWindowStart: '09:00',
    });
    expect(bad.status).toBe(400);
    const ok = await admin.put('/api/company/settings', {
      ...company,
      workdayStart: '08:00',
      arrivalAlertAt: '09:00',
      lateAlertMinutes: 5,
    });
    expect(ok.body).toMatchObject({
      workdayStart: '08:00',
      arrivalAlertAt: '09:00',
      lateAlertMinutes: 5,
    });
  });

  it('tempo real só para quem pode ver; reconexão recupera os eventos de presença', async () => {
    const admin = await loginAdmin(app);
    const joao = await tabletOf(app, admin, 'João', '121212');
    const marcio = await tabletOf(app, admin, 'Márcio', '736152');
    const wGestor = track(await WsClient.connect(app, admin));
    const wMarcio = track(await WsClient.connect(app, marcio));
    setClock('08:29');
    await arrive(joao);
    const ev = await wGestor.waitFor(
      (m) => m.kind === 'event' && m.event.type === 'attendance.arrived',
    );
    const lastSeq = ev.event.seq as string;
    await wGestor.close(); // painel perde a conexão
    setClock('09:30');
    await detectAbsences(app.ctx.prisma);
    const back = track(await WsClient.connect(app, admin, lastSeq));
    await back.waitFor((m) => m.kind === 'replay.done');
    // Ricardo, Márcio e Thiago não confirmaram: três eventos recuperados na reconexão.
    expect(back.events('attendance.absence_suspected')).toHaveLength(3);
    // O tablet do Márcio só recebe a própria presença (nem a chegada do João, nem a dos outros).
    const marcioId = (await employeeByName('Márcio')).id;
    await wMarcio.waitFor(
      (m) => m.kind === 'event' && m.event.type === 'attendance.absence_suspected',
    );
    expect(wMarcio.events('attendance.arrived')).toHaveLength(0);
    expect(
      wMarcio
        .events('attendance.absence_suspected')
        .every((e: { payload: { employeeId: string } }) => e.payload.employeeId === marcioId),
    ).toBe(true);
  });
});
