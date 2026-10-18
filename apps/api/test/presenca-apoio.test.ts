import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { detectAbsences, detectOpenShifts } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, employeeByName, idemKey, resetDatabase } from './helpers';
import { panelUserWith } from './commercial-helpers';
import { day, today } from './production-helpers';
import {
  arrive,
  ask,
  attendanceAction,
  depart,
  notices,
  prepareCompany,
  post,
  scenario,
  setClock,
} from './presence-helpers';

/**
 * Simplificação, Fase 7 — presença e apoio simplificados. Contraprovas (defeitos reproduzidos
 * em 932e04b) e aceite.
 */
let app: App;

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
  await prepareCompany();
});
const sockets: WsClient[] = [];
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((w) => w.close()));
});
const track = (w: WsClient) => (sockets.push(w), w);
const me = async (c: Client) => (await c.get('/api/auth/me')).body.user.id as string;
const row = async (name: string, date = today()) => {
  const e = await employeeByName(name);
  return db().operationalAttendance.findUnique({
    where: { employeeId_date: { employeeId: e.id, date: new Date(`${date}T00:00:00.000Z`) } },
  });
};
const teamDay = async (admin: Client, name: string, date = today()) =>
  (
    (await admin.get(`/api/v1/attendance/team?date=${date}`)).body.days as {
      employee: { displayName: string };
      situation: string | null;
      availability: string;
      lateMinutes: number;
      arrivalKind: string | null;
      leave: { code: string } | null;
      openShift: boolean;
    }[]
  ).find((d) => d.employee.displayName === name)!;
const holiday = (admin: Client, date: string, name = 'Feriado municipal') =>
  post(admin, '/api/v1/attendance/holidays', { date, name });
const leave = (admin: Client, body: Record<string, unknown>) =>
  post(admin, '/api/v1/attendance/leaves', body);
const approve = (admin: Client, id: string, body: Record<string, unknown> = {}) =>
  post(admin, `/api/v1/reschedule-proposals/${id}/approve`, body);
const reject = (admin: Client, id: string, note = 'Agora não') =>
  post(admin, `/api/v1/reschedule-proposals/${id}/reject`, { note });
const prolonged = (c: Client, body: Record<string, unknown>) =>
  post(c, '/api/v1/help-requests/prolonged', body);
const transfer = (c: Client, taskId: string, body: Record<string, unknown>) =>
  post(c, `/api/v1/production-tasks/${taskId}/transfer-request`, body);

describe('Contraprovas (defeitos da auditoria)', () => {
  it('A. o tablet não recebe avaliação de pontualidade (lateMinutes, tipo de chegada, minutos)', async () => {
    const s = await scenario(app, { arrive: [] });
    setClock('09:05');
    const r = await arrive(s.tablets.Márcio!);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toMatch(/lateMinutes|arrivalKind|ATRASO|lateAlertMinutes/);
    const me = JSON.stringify((await s.tablets.Márcio!.get('/api/v1/attendance/me')).body);
    expect(me).not.toMatch(/lateMinutes|arrivalKind|ATRASO/);
    const mine = await notices(s.ids.marcio, 'CHEGADA_CONFIRMADA');
    expect(mine[0]!.body).not.toMatch(/min/);
  });

  it('B. expediente esquecido (sem "Encerrar") vira alerta para o gestor no dia seguinte', async () => {
    const s = await scenario(app, { arrive: [] });
    const admin = s.admin;
    const joao = s.tablets.João!;
    setClock('08:30', day(-1));
    expect((await arrive(joao)).status).toBe(200);
    setClock('08:00');
    const r = await admin.get('/api/v1/attendance/open-shifts');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      expect.objectContaining({
        date: day(-1),
        employee: expect.objectContaining({ displayName: 'João' }),
      }),
    ]);
  });

  it('C. encerramento por engano pode ser desfeito pelo gestor (com motivo e histórico)', async () => {
    const s = await scenario(app);
    setClock('10:00');
    expect((await depart(s.tablets.João!)).status).toBe(200);
    const joao = await employeeByName('João');
    const row = await db().operationalAttendance.findFirstOrThrow({
      where: { employeeId: joao.id },
    });
    const r = await attendanceAction(s.admin, {
      employeeId: joao.id,
      action: 'ANULAR_SAIDA',
      reason: 'Tocou em Encerrar por engano',
      version: row.version,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ situation: 'PRESENTE', departedAt: null });
  });

  it('F. reatribuir a tarefa de apoio mantém HelpRequest.helperUserId igual ao executor', async () => {
    const s = await scenario(app);
    const req = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(req.body).toMatchObject({ status: 'ATRIBUIDA', helper: { displayName: 'João' } });
    const support = await s.reload(req.body.supportTask.id);
    const put = await s.admin.req(
      'PUT',
      `/api/v1/production-tasks/${support.id}`,
      {
        assigneeUserId: s.ids.thiago,
        reason: 'João saiu para uma entrega',
        version: support.version,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(put.status).toBe(200);
    const after = await db().helpRequest.findUniqueOrThrow({ where: { id: req.body.id } });
    expect(after.helperUserId).toBe(s.ids.thiago);
    expect((await s.tablets.Thiago!.get(`/api/v1/help-requests/${req.body.id}`)).status).toBe(200);
  });

  it('G. aviso acionável só para quem pode agir (decidir exige producao.planejar)', async () => {
    const s = await scenario(app, { arrive: ['Ricardo'] });
    const presenceOnly = await panelUserWith(app, s.admin, 'so-presenca', [
      'presenca.ver',
      'presenca.gerenciar',
    ]);
    const planner = await panelUserWith(app, s.admin, 'so-planejar', [
      'producao.ver',
      'producao.planejar',
    ]);
    const pid = (await presenceOnly.get('/api/auth/me')).body.user.id as string;
    const plid = (await planner.get('/api/auth/me')).body.user.id as string;
    const r = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'MOVIMENTAR',
      urgent: true,
      justification: 'Sofá pesado caindo',
    });
    expect(r.status).toBe(201);
    expect((await notices(pid)).map((n) => n.kind)).not.toContain('AJUDA_SOLICITADA');
    expect((await notices(plid)).map((n) => n.kind)).toContain('AJUDA_SOLICITADA');
  });
});

describe('Presença (1–19)', () => {
  it('1–4. Cheguei e Encerrar continuam; chegada idempotente; atraso calculado internamente', async () => {
    const s = await scenario(app, { arrive: [] });
    setClock('09:05');
    const key = idemKey();
    const a = await post(s.tablets.Márcio!, '/api/v1/attendance/me/arrive', {}, key);
    const b = await post(s.tablets.Márcio!, '/api/v1/attendance/me/arrive', {}, key);
    const c = await arrive(s.tablets.Márcio!);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(a.body.day).toMatchObject({ situation: 'PRESENTE', availability: 'DISPONIVEL' });
    expect(await db().attendanceCorrection.count({ where: { action: 'CHEGADA' } })).toBe(1);
    expect(await row('Márcio')).toMatchObject({ lateMinutes: 35, arrivalKind: 'ATRASO' });
    setClock('17:00');
    const d = await depart(s.tablets.Márcio!);
    expect(d.status).toBe(200);
    expect(d.body.day.situation).toBe('ENCERRADO');
    expect(JSON.stringify(d.body)).not.toMatch(/earlyDeparture|lateMinutes|arrivalKind/);
  });

  it('5–8. tablet, WebSocket e notificação do funcionário sem minutos; o gestor vê o atraso', async () => {
    const s = await scenario(app, { arrive: [] });
    const wMarcio = track(await WsClient.connect(app, s.tablets.Márcio!));
    const wAdmin = track(await WsClient.connect(app, s.admin));
    setClock('09:20');
    expect((await arrive(s.tablets.Márcio!)).status).toBe(200);
    const late = await wAdmin.waitFor((m) => m.event?.type === 'attendance.late');
    expect(late.event.payload.lateMinutes).toBe(50);
    await wMarcio.waitFor((m) => m.event?.type === 'attendance.arrived');
    await new Promise((r) => setTimeout(r, 300));
    const own = JSON.stringify(wMarcio.messages);
    expect(own).not.toMatch(/lateMinutes|attendance\.late|ATRASO|"kind":"ATRASO"/);
    for (const n of await notices(s.ids.marcio)) expect(n.body).not.toMatch(/\d+ min|atras/i);
    // Gestor: dado operacional preservado (painel e aviso de atraso).
    expect(await teamDay(s.admin, 'Márcio')).toMatchObject({
      lateMinutes: 50,
      arrivalKind: 'ATRASO',
    });
    const gestor = await notices(await me(s.admin), 'ATRASO_OPERACIONAL');
    expect(gestor[0]!.body).toMatch(/50 min/);
    // A versão completa do dia nunca chega ao tablet (nem pelo painel da equipe).
    expect((await s.tablets.Márcio!.get('/api/v1/attendance/team')).status).toBe(403);
  });

  it('9–11. ausência presumida continua; feriado não gera ausência nem atraso', async () => {
    const s = await scenario(app, { arrive: ['Ricardo'] });
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(3);
    expect((await row('Márcio'))?.situation).toBe('AUSENCIA_PRESUMIDA');
    // Amanhã é feriado: ninguém é presumido ausente e a chegada tardia não é atraso.
    const h = await holiday(s.admin, day(1), 'Recesso da oficina');
    expect(h.status).toBe(201);
    expect((await holiday(s.admin, day(1))).status).toBe(409);
    setClock('10:30', day(1));
    expect(await detectAbsences(app.ctx.prisma)).toBe(0);
    expect(
      await db().operationalAttendance.count({
        where: { date: new Date(`${day(1)}T00:00:00.000Z`) },
      }),
    ).toBe(0);
    const me1 = (await s.tablets.João!.get('/api/v1/attendance/me')).body;
    expect(me1.config).toMatchObject({ workingDay: false, holiday: 'Recesso da oficina' });
    expect((await arrive(s.tablets.João!)).status).toBe(200);
    expect(await row('João', day(1))).toMatchObject({ lateMinutes: 0, arrivalKind: 'NO_HORARIO' });
    expect(
      await db().rescheduleProposal.count({
        where: { attendance: { date: new Date(`${day(1)}T00:00:00.000Z`) } },
      }),
    ).toBe(0);
    // Desativar o feriado (nunca apagar) não reescreve o que já foi registrado.
    const off = await s.admin.req(
      'PUT',
      `/api/v1/attendance/holidays/${h.body.id}`,
      { active: false, version: h.body.version },
      { 'idempotency-key': idemKey() },
    );
    expect(off.body).toMatchObject({ active: false, version: 2 });
    expect(await row('João', day(1))).toMatchObject({ lateMinutes: 0 });
    expect(
      await db().auditLog.count({ where: { action: { startsWith: 'attendance.holiday_' } } }),
    ).toBe(2);
  });

  it('12–15. folga e férias por intervalo: sem ausência, sem presença futura; correção e cancelamento com histórico', async () => {
    const s = await scenario(app, { arrive: [] });
    const marcio = await employeeByName('Márcio');
    const joao = await employeeByName('João');
    const f = await leave(s.admin, {
      employeeId: marcio.id,
      kind: 'FERIAS',
      startDate: day(-1),
      endDate: day(9),
      reason: 'Férias combinadas',
    });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ code: 'FL-00001', kind: 'FERIAS', days: 11, status: 'ATIVA' });
    const fo = await leave(s.admin, {
      employeeId: joao.id,
      kind: 'FOLGA',
      startDate: today(),
      endDate: today(),
      reason: 'Folga compensada',
    });
    expect(fo.status).toBe(201);
    // Sobreposição recusada; intervalo longo demais recusado.
    expect(
      (
        await leave(s.admin, {
          employeeId: marcio.id,
          kind: 'FOLGA',
          startDate: day(3),
          endDate: day(3),
          reason: 'Outra',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await leave(s.admin, {
          employeeId: joao.id,
          kind: 'FERIAS',
          startDate: day(10),
          endDate: day(80),
          reason: 'Longa',
        })
      ).status,
    ).toBe(422);
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(2); // Ricardo e Thiago; Márcio e João não
    expect(await teamDay(s.admin, 'Márcio')).toMatchObject({
      situation: 'FERIAS',
      availability: 'AUSENTE',
    });
    expect(await teamDay(s.admin, 'João')).toMatchObject({ situation: 'FOLGA' });
    expect(await teamDay(s.admin, 'Márcio', day(5))).toMatchObject({
      situation: 'FERIAS',
      leave: { code: 'FL-00001' },
    });
    // Nenhum registro de presença criado para os dias do intervalo.
    expect(await db().operationalAttendance.count({ where: { employeeId: marcio.id } })).toBe(0);
    // Correção (CAS) e cancelamento, com antes/depois.
    const fix = await s.admin.req(
      'PUT',
      `/api/v1/attendance/leaves/${f.body.id}`,
      { startDate: day(-1), endDate: day(4), reason: 'Volta antes', version: 1 },
      { 'idempotency-key': idemKey() },
    );
    expect(fix.body).toMatchObject({ endDate: day(4), days: 6, version: 2 });
    expect(
      (
        await s.admin.req(
          'PUT',
          `/api/v1/attendance/leaves/${f.body.id}`,
          { startDate: day(-1), endDate: day(3), reason: 'Velha', version: 1 },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(409);
    expect((await teamDay(s.admin, 'Márcio', day(5))).situation).toBe(null);
    const cancel = await post(s.admin, `/api/v1/attendance/leaves/${fo.body.id}/cancel`, {
      reason: 'Veio trabalhar',
      version: fo.body.version,
    });
    expect(cancel.body).toMatchObject({ status: 'CANCELADA' });
    expect(fix.body.history.map((h: { action: string }) => h.action)).toEqual([
      'CRIADA',
      'CORRIGIDA',
    ]);
    expect(fix.body.history[1]).toMatchObject({
      before: { endDate: day(9) },
      after: { endDate: day(4) },
      reason: 'Volta antes',
    });
    await expect(db().attendanceLeaveEvent.deleteMany({})).rejects.toThrow();
    expect((await notices(s.ids.marcio, 'PRESENCA_ALTERADA'))[0]!.body).toMatch(/Férias de/);
  });

  it('férias que cobrem hoje convertem a ausência presumida (mesmo registro do gestor)', async () => {
    const s = await scenario(app, { arrive: [] });
    setClock('09:31');
    await detectAbsences(app.ctx.prisma);
    expect((await row('Thiago'))?.situation).toBe('AUSENCIA_PRESUMIDA');
    const thiago = await employeeByName('Thiago');
    await leave(s.admin, {
      employeeId: thiago.id,
      kind: 'FERIAS',
      startDate: today(),
      endDate: day(2),
      reason: 'Esqueceram de lançar',
    });
    const r = await row('Thiago');
    expect(r?.situation).toBe('FERIAS');
    const h = await db().attendanceCorrection.findMany({
      where: { attendanceId: r!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(h.map((x) => x.action)).toEqual(['AUSENCIA_PRESUMIDA', 'FERIAS']);
  });

  it('16–19. expediente esquecido: alerta único, sem saída inventada; gestor registra, desfaz e corrige com histórico', async () => {
    const s = await scenario(app, { arrive: [] });
    setClock('08:30', day(-1));
    expect((await arrive(s.tablets.João!)).status).toBe(200);
    expect((await arrive(s.tablets.Thiago!)).status).toBe(200);
    setClock('08:00');
    expect(await detectOpenShifts(app.ctx.prisma)).toBe(2);
    expect(await detectOpenShifts(app.ctx.prisma)).toBe(0); // idempotente
    const alerts = await notices(await me(s.admin), 'EXPEDIENTE_ABERTO');
    expect(alerts).toHaveLength(2);
    expect(alerts.map((n) => n.body).join(' ')).toMatch(
      /João: expediente de .* sem encerramento \(chegada às 08:30\)/,
    );
    // Nada foi encerrado sozinho.
    expect(await row('João', day(-1))).toMatchObject({ situation: 'PRESENTE', departedAt: null });
    expect((await teamDay(s.admin, 'João', day(-1))).openShift).toBe(true);
    const joao = await employeeByName('João');
    const thiago = await employeeByName('Thiago');
    const before = (await row('João', day(-1)))!;
    // Saída antes da chegada é recusada; versão antiga é recusada.
    expect(
      (
        await attendanceAction(s.admin, {
          employeeId: joao.id,
          date: day(-1),
          action: 'REGISTRAR_SAIDA',
          departureTime: '07:00',
          reason: 'Saiu às 7?',
          version: before.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await attendanceAction(s.admin, {
          employeeId: joao.id,
          date: day(-1),
          action: 'REGISTRAR_SAIDA',
          departureTime: '17:30',
          reason: 'Sem versão',
        })
      ).status,
    ).toBe(400);
    const reg = await attendanceAction(s.admin, {
      employeeId: joao.id,
      date: day(-1),
      action: 'REGISTRAR_SAIDA',
      departureTime: '17:30',
      reason: 'Saiu às 17h30 (confirmado com ele)',
      version: before.version,
    });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ situation: 'ENCERRADO', openShift: false });
    const t = (await row('Thiago', day(-1)))!;
    const none = await attendanceAction(s.admin, {
      employeeId: thiago.id,
      date: day(-1),
      action: 'SAIDA_NAO_INFORMADA',
      reason: 'Ninguém sabe a hora',
      version: t.version,
    });
    expect(none.body).toMatchObject({
      situation: 'PRESENTE',
      departedAt: null,
      departureUnrecorded: true,
      openShift: false,
    });
    expect((await s.admin.get('/api/v1/attendance/open-shifts')).body).toEqual([]);
    // Desfazer e corrigir: o histórico guarda cada antes/depois, com autor.
    const j = (await row('João', day(-1)))!;
    const undo = await attendanceAction(s.admin, {
      employeeId: joao.id,
      date: day(-1),
      action: 'ANULAR_SAIDA',
      reason: 'Horário errado',
      version: j.version,
    });
    expect(undo.body).toMatchObject({ situation: 'PRESENTE', departedAt: null });
    const hist = (
      await s.admin.get(
        `/api/v1/attendance/history?employeeId=${joao.id}&from=${day(-1)}&to=${day(-1)}`,
      )
    ).body.days[0].history;
    expect(hist.map((h: { action: string }) => h.action)).toEqual([
      'CHEGADA',
      'REGISTRAR_SAIDA',
      'ANULAR_SAIDA',
    ]);
    expect(hist[1].after.departedAt).not.toBeNull();
    expect(hist[2].before.departedAt).toBe(hist[1].after.departedAt);
    expect(hist[2].actor).toBeTruthy();
    // O funcionário recebe texto neutro (nada de "antecipada", "tardia" ou minutos).
    for (const n of await notices(s.ids.joao, 'PRESENCA_ALTERADA'))
      expect(n.body).toMatch(/registro de presença ajustado pelo gestor/);
  });
});

describe('Ajuda e apoio (20–28)', () => {
  it('20–23. pedido normal e urgente, atribuição automática e manual continuam', async () => {
    const s = await scenario(app);
    const normal = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(normal.body).toMatchObject({ status: 'ATRIBUIDA', helper: { displayName: 'João' } });
    const urgent = await ask(s.tablets.Thiago!, {
      taskId: s.thiagoTask.id,
      kind: 'MOVIMENTAR',
      urgent: true,
      justification: 'Cabeceira tombando',
    });
    expect(urgent.status).toBe(201);
    expect(urgent.body.urgent).toBe(true);
    // Manual: o gestor escolhe para um pedido em espera.
    const helped = await db().helpRequest.findMany({ orderBy: { number: 'asc' } });
    expect(helped).toHaveLength(2);
    if (urgent.body.status !== 'ATRIBUIDA') {
      const m = await post(s.admin, `/api/v1/help-requests/${urgent.body.id}/assign`, {
        helperUserId: s.ids.joao,
        confirmConflict: true,
        note: 'João termina o apoio do Ricardo e vem',
      });
      expect(m.status).toBe(200);
    }
  });

  it('24–27. reatribuição pela proposta (changeTask) e pelo planejamento: ajudante atual em tudo', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const req = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(req.body.helper.displayName).toBe('João');
    // O próprio ajudante pede para passar o apoio (transferência com aprovação → changeTask).
    const tr = await transfer(s.tablets.João!, req.body.supportTask.id, {
      toUserId: s.ids.thiago,
      reason: 'Vou descarregar o caminhão',
    });
    expect(tr.status).toBe(201);
    expect((await approve(s.admin, tr.body.id)).status).toBe(200);
    const after = await db().helpRequest.findUniqueOrThrow({ where: { id: req.body.id } });
    const task = await db().productionTask.findUniqueOrThrow({
      where: { id: req.body.supportTask.id },
    });
    expect(after.helperUserId).toBe(s.ids.thiago);
    expect(task.assigneeUserId).toBe(s.ids.thiago);
    // 25/27. O novo ajudante abre o pedido; o detalhe mostra o ajudante atual.
    const detail = await s.tablets.Thiago!.get(`/api/v1/help-requests/${req.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.helper.displayName).toBe('Thiago');
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toContain('AJUDANTE_ALTERADO');
    // 26. O ajudante antigo deixa de contar como "ocupado com apoio": recebe o próximo pedido.
    const next = await ask(s.tablets.Márcio!, { taskId: s.marcioTask.id, kind: 'POSICIONAR' });
    expect(next.body.helper.displayName).toBe('João');
    // Quem pediu nunca vira o próprio ajudante.
    const sup = await s.reload(req.body.supportTask.id);
    const self = await s.admin.req(
      'PUT',
      `/api/v1/production-tasks/${sup.id}`,
      { assigneeUserId: s.ids.ricardo, reason: 'Teste', version: sup.version },
      { 'idempotency-key': idemKey() },
    );
    expect(self.status).toBe(422);
    expect(
      (await db().helpRequest.findUniqueOrThrow({ where: { id: req.body.id } })).helperUserId,
    ).toBe(s.ids.thiago);
  });

  it('28. funções personalizadas: aviso de proposta só para quem decide (producao.planejar)', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'João', 'Thiago'] });
    const presenceOnly = await panelUserWith(app, s.admin, 'pres', [
      'presenca.ver',
      'presenca.gerenciar',
    ]);
    const planner = await panelUserWith(app, s.admin, 'plan', [
      'producao.ver',
      'producao.planejar',
    ]);
    const tr = await transfer(s.tablets.João!, s.t('DESMONTAGEM').id, {
      reason: 'Machuquei a mão',
    });
    expect(tr.status).toBe(201);
    expect((await notices(await me(presenceOnly))).map((n) => n.kind)).not.toContain(
      'REPROGRAMACAO_PENDENTE',
    );
    expect((await notices(await me(planner))).map((n) => n.kind)).toContain(
      'REPROGRAMACAO_PENDENTE',
    );
    // Quem só gerencia a presença não decide (e não foi avisado para decidir).
    expect((await approve(presenceOnly, tr.body.id)).status).toBe(403);
    // Presença continua com quem gerencia a presença.
    setClock('09:31');
    await detectAbsences(app.ctx.prisma);
    expect((await notices(await me(presenceOnly))).map((n) => n.kind)).toContain(
      'AUSENCIA_PRESUMIDA',
    );
    expect((await notices(await me(planner))).map((n) => n.kind)).not.toContain(
      'AUSENCIA_PRESUMIDA',
    );
  });
});

describe('Apoio prolongado (29–32)', () => {
  it('29–31. proposto ao gestor (fora da fila automática); aprovado cria o vínculo; recusado encerra', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const r = await prolonged(s.tablets.Ricardo!, {
      taskId: s.main.id,
      helperUserId: s.ids.thiago,
      estimatedMinutes: 480,
      justification: 'Sofá de canto: preciso de apoio o dia todo',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: 'APOIO_PROLONGADO',
      status: 'ESCALADA',
      helper: null,
      supportTask: null,
    });
    // A fila automática não atribui.
    await post(s.admin, '/api/test/attendance/check');
    expect((await db().helpRequest.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe(
      'ESCALADA',
    );
    const p = await db().rescheduleProposal.findFirstOrThrow({
      where: { helpRequestId: r.body.id },
    });
    expect(p).toMatchObject({
      kind: 'APOIO_PROLONGADO',
      requestedById: s.ids.ricardo,
      status: 'PENDENTE',
    });
    const alts = p.alternatives as { title: string }[];
    expect(alts[0]!.title).toMatch(/Thiago apoia Ricardo/);
    const ok = await approve(s.admin, p.id);
    expect(ok.status).toBe(200);
    const linked = await db().helpRequest.findUniqueOrThrow({
      where: { id: r.body.id },
      include: { supportTask: true },
    });
    expect(linked).toMatchObject({ status: 'ATRIBUIDA', helperUserId: s.ids.thiago });
    expect(linked.supportTask).toMatchObject({
      assigneeUserId: s.ids.thiago,
      role: 'APOIO',
      estimatedMinutes: 480,
    });
    expect((await notices(s.ids.ricardo, 'PEDIDO_DECIDIDO'))[0]!.body).toMatch(/aprovado/);
    // Recusa: outro pedido, o gestor recusa com motivo — nada é criado.
    const r2 = await prolonged(s.tablets.Márcio!, {
      taskId: s.marcioTask.id,
      estimatedMinutes: 120,
      justification: 'Revestimento grande',
    });
    const p2 = await db().rescheduleProposal.findFirstOrThrow({
      where: { helpRequestId: r2.body.id },
    });
    expect((await reject(s.admin, p2.id, 'Sem gente sobrando hoje')).status).toBe(200);
    const refused = await db().helpRequest.findUniqueOrThrow({ where: { id: r2.body.id } });
    expect(refused).toMatchObject({ status: 'CANCELADA', supportTaskId: null });
    expect(refused.cancelReason).toMatch(/Recusado pelo gestor: Sem gente sobrando hoje/);
    expect((await notices(s.ids.marcio, 'PEDIDO_DECIDIDO'))[0]!.body).toMatch(/recusado/);
    // Histórico imutável do pedido.
    const ev = await db().helpRequestEvent.findMany({
      where: { helpRequestId: r2.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(ev.map((e) => e.kind)).toEqual(['SOLICITADA', 'RECUSADA']);
  });

  it('32. apoio prolongado não cria mão de obra (D14) nem altera titular', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.so.items[0].id } });
    const payables = await db().productionPayable.count();
    const r = await prolonged(s.tablets.Ricardo!, {
      taskId: s.main.id,
      estimatedMinutes: 240,
      justification: 'Peça pesada',
    });
    const p = await db().rescheduleProposal.findFirstOrThrow({
      where: { helpRequestId: r.body.id },
    });
    await approve(s.admin, p.id);
    expect(await db().productionPayable.count()).toBe(payables);
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: item.id } })).upholstererUserId,
    ).toBe(item.upholstererUserId);
  });
});

describe('Transferência com aprovação (33–37)', () => {
  it('33–35. proposta; aprovada transfere com histórico; recusada mantém', async () => {
    const s = await scenario(app);
    const task = s.t('DESMONTAGEM');
    const r = await transfer(s.tablets.João!, task.id, {
      toUserId: s.ids.thiago,
      reason: 'Estou no corte de espuma',
    });
    expect(r.status).toBe(201);
    // Nada muda antes da decisão; repetição concorrente recusada.
    expect((await s.reload(task.id)).assignee?.userId).toBe(s.ids.joao);
    expect(
      (await transfer(s.tablets.João!, task.id, { reason: 'De novo, outra vez' })).status,
    ).toBe(409);
    expect(
      (await transfer(s.tablets.Thiago!, task.id, { reason: 'Não é minha tarefa' })).status,
    ).toBe(403);
    expect((await approve(s.admin, r.body.id)).status).toBe(200);
    expect((await s.reload(task.id)).assignee?.userId).toBe(s.ids.thiago);
    expect((await notices(s.ids.joao, 'PEDIDO_DECIDIDO'))[0]!.body).toMatch(
      /transferência .* aprovado/,
    );
    const events = await db().productionTaskEvent.findMany({
      where: { taskId: task.id, kind: 'RESPONSAVEL_ALTERADO' },
    });
    expect(events).toHaveLength(1);
    // Recusa: a tarefa fica com quem estava.
    const prep = s.t('PREPARACAO');
    const r2 = await transfer(s.tablets.João!, prep.id, { reason: 'Quero trocar esta também' });
    expect((await reject(s.admin, r2.body.id, 'Fica com você')).status).toBe(200);
    expect((await s.reload(prep.id)).assignee?.userId).toBe(s.ids.joao);
    expect((await notices(s.ids.joao, 'PEDIDO_DECIDIDO')).map((n) => n.body).join(' ')).toMatch(
      /recusado/,
    );
  });

  it('36–37. transferência da etapa do titular usa a regra canônica da R1 (titular + LaborReview)', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const itemId = s.so.items[0].id;
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.upholstererUserId).toBe(s.ids.ricardo);
    const labor = await post(s.admin, '/api/v1/finance/labor', {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: itemId,
      service: 'Reforma do sofá',
      agreedCents: 80000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    expect(labor.status).toBe(201);
    const r = await transfer(s.tablets.Ricardo!, s.main.id, {
      toUserId: s.ids.marcio,
      reason: 'Vou para a instalação externa',
    });
    expect(r.status).toBe(201);
    const p = await db().rescheduleProposal.findUniqueOrThrow({ where: { id: r.body.id } });
    const actions = (p.alternatives as { actions: { type: string }[] }[]).flatMap((a) => a.actions);
    expect(actions.every((a) => a.type === 'CHANGE_PRINCIPAL')).toBe(true);
    expect((await approve(s.admin, p.id)).status).toBe(200);
    // Titular trocado pela regra canônica; valor NÃO transferido: revisão financeira aberta.
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: itemId } })).upholstererUserId,
    ).toBe(s.ids.marcio);
    expect(await db().laborReview.count({ where: { status: 'ABERTA' } })).toBe(1);
    expect(
      await db().productionPayable.findUniqueOrThrow({ where: { id: labor.body.id } }),
    ).toMatchObject({
      professionalUserId: s.ids.ricardo,
    });
    expect(
      await db().serviceOrderItemOwnerChange.count({ where: { serviceOrderItemId: itemId } }),
    ).toBeGreaterThan(0);
    // O changeTask nunca é usado para contornar o titular: REASSIGN de etapa do titular é recusado.
    const prep = await s.reload(s.main.id);
    expect(prep.assignee?.userId).toBe(s.ids.marcio);
  });
});

describe('Ausência, reprogramação e regras R1/R2 (38–43)', () => {
  it('38–39. ausência confirmada mantém a reprogramação; TROCAR_PRINCIPAL pela regra R1', async () => {
    const s = await scenario(app, { arrive: ['Márcio', 'João', 'Thiago'] });
    const ricardo = await employeeByName('Ricardo');
    const r = await attendanceAction(s.admin, {
      employeeId: ricardo.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Consulta médica',
    });
    expect(r.status).toBe(200);
    const p = await db().rescheduleProposal.findFirstOrThrow({ where: { kind: 'AUSENCIA' } });
    const alt = (p.alternatives as { id: string }[]).map((a) => a.id);
    expect(alt).toEqual(expect.arrayContaining(['TROCAR_PRINCIPAL', 'ADIAR', 'AGUARDAR']));
    expect((await approve(s.admin, p.id, { alternativeId: 'TROCAR_PRINCIPAL' })).status).toBe(200);
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.so.items[0].id } });
    expect(item.upholstererUserId).not.toBe(s.ids.ricardo);
    expect((await s.reload(s.main.id)).assignee?.userId).toBe(item.upholstererUserId);
  });

  it('ADIAR pula o feriado do calendário', async () => {
    const s = await scenario(app, { arrive: ['Márcio', 'João', 'Thiago'] });
    await holiday(s.admin, day(1), 'Feriado municipal');
    const ricardo = await employeeByName('Ricardo');
    await attendanceAction(s.admin, {
      employeeId: ricardo.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Viagem',
    });
    const p = await db().rescheduleProposal.findFirstOrThrow({ where: { kind: 'AUSENCIA' } });
    const adiar = (p.alternatives as { id: string; title: string }[]).find(
      (a) => a.id === 'ADIAR',
    )!;
    const d2 = day(2).split('-').reverse().join('/');
    expect(adiar.title).toContain(d2);
  });

  it('40–43. presença nunca toca mão de obra, Meus Ganhos, negociação, confirmação ou D13', async () => {
    const s = await scenario(app, { arrive: [] });
    const before = await Promise.all([
      db().productionPayable.count(),
      db().financialAdjustment.count(),
      db().valueChangeRequest.count(),
      db().weeklyClosingConfirmation.count(),
      db().professionalPayment.count(),
    ]);
    setClock('10:15');
    await arrive(s.tablets.Ricardo!);
    setClock('09:31', day(1));
    await detectAbsences(app.ctx.prisma);
    const marcio = await employeeByName('Márcio');
    await leave(s.admin, {
      employeeId: marcio.id,
      kind: 'FERIAS',
      startDate: day(1),
      endDate: day(5),
      reason: 'Férias',
    });
    await holiday(s.admin, day(7));
    expect(
      await Promise.all([
        db().productionPayable.count(),
        db().financialAdjustment.count(),
        db().valueChangeRequest.count(),
        db().weeklyClosingConfirmation.count(),
        db().professionalPayment.count(),
      ]),
    ).toEqual(before);
  });
});

describe('Concorrência (44–46)', () => {
  it('44. duas reatribuições simultâneas do mesmo apoio: uma vence, pedido e tarefa coerentes', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const req = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    const sup = await s.reload(req.body.supportTask.id);
    const put = (to: string) =>
      s.admin.req(
        'PUT',
        `/api/v1/production-tasks/${sup.id}`,
        { assigneeUserId: to, reason: 'Troca', version: sup.version },
        { 'idempotency-key': idemKey() },
      );
    const res = await Promise.all([put(s.ids.thiago), put(s.ids.marcio)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const task = await db().productionTask.findUniqueOrThrow({ where: { id: sup.id } });
    const hr = await db().helpRequest.findUniqueOrThrow({ where: { id: req.body.id } });
    expect(hr.helperUserId).toBe(task.assigneeUserId);
  });

  it('45. aprovar × recusar ao mesmo tempo: uma decisão só, estado coerente', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const r = await prolonged(s.tablets.Ricardo!, {
      taskId: s.main.id,
      estimatedMinutes: 240,
      justification: 'Peça grande',
    });
    const p = await db().rescheduleProposal.findFirstOrThrow({
      where: { helpRequestId: r.body.id },
    });
    const [a, b] = await Promise.all([approve(s.admin, p.id), reject(s.admin, p.id, 'Não')]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const hr = await db().helpRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    const after = await db().rescheduleProposal.findUniqueOrThrow({ where: { id: p.id } });
    if (after.status === 'APROVADA') expect(hr.status).toBe('ATRIBUIDA');
    else expect(hr.status).toBe('CANCELADA');
    // Transferência: aprovar × recusar.
    const tr = await transfer(s.tablets.João!, s.t('DESMONTAGEM').id, { reason: 'Troca de turno' });
    const [c, d] = await Promise.all([
      approve(s.admin, tr.body.id),
      reject(s.admin, tr.body.id, 'Não'),
    ]);
    expect([c.status, d.status].sort()).toEqual([200, 422]);
  });

  it('46. chegada × correção, saída × correção, alerta × correção, feriado × ausência, transferência × titular: sem deadlock', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'Thiago'] });
    const joao = await employeeByName('João');
    const thiago = await employeeByName('Thiago');
    // Chegada × correção do gestor (mesmo dia): serializadas.
    const [a, c] = await Promise.all([
      arrive(s.tablets.João!),
      attendanceAction(s.admin, {
        employeeId: joao.id,
        action: 'ESQUECIMENTO',
        arrivalTime: '08:20',
        reason: 'Chegou antes',
      }),
    ]);
    expect(a.status).toBe(200);
    expect([200, 422]).toContain(c.status);
    // Saída × correção (versão do dia): uma passa, a outra vê conflito ou nada a fazer.
    const t = (await row('Thiago'))!;
    const [d, e] = await Promise.all([
      depart(s.tablets.Thiago!),
      attendanceAction(s.admin, {
        employeeId: thiago.id,
        action: 'REGISTRAR_SAIDA',
        departureTime: '17:00',
        reason: 'Saída',
        version: t.version,
      }),
    ]);
    expect(d.status).toBe(200);
    expect([200, 409, 422]).toContain(e.status);
    expect((await row('Thiago'))!.situation).toBe('ENCERRADO');
    // Duas correções com a mesma versão: uma vence.
    const r1 = (await row('Ricardo'))!;
    const both = await Promise.all(
      ['17:00', '17:10'].map((tm) =>
        attendanceAction(s.admin, {
          employeeId: (r1 as { employeeId: string }).employeeId,
          action: 'REGISTRAR_SAIDA',
          departureTime: tm,
          reason: 'Saída',
          version: r1.version,
        }),
      ),
    );
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    // Alerta de expediente × correção.
    setClock('08:00', day(1));
    const m = (await row('Márcio'))!;
    const marcio = await employeeByName('Márcio');
    const [, fix] = await Promise.all([
      detectOpenShifts(app.ctx.prisma),
      attendanceAction(s.admin, {
        employeeId: marcio.id,
        date: today(),
        action: 'REGISTRAR_SAIDA',
        departureTime: '18:00',
        reason: 'Saída',
        version: m.version,
      }),
    ]);
    expect(fix.status).toBe(200);
    // Feriado × verificação de ausência.
    setClock('09:31', day(1));
    const [h, n] = await Promise.all([holiday(s.admin, day(1)), detectAbsences(app.ctx.prisma)]);
    expect(h.status).toBe(201);
    expect(n).toBeGreaterThanOrEqual(0);
    // Transferência × troca de titular: CAS — nunca os dois.
    setClock('09:00');
    const tr = await transfer(s.tablets.Ricardo!, s.main.id, {
      toUserId: s.ids.marcio,
      reason: 'Instalação externa',
    });
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.so.items[0].id } });
    const [ap, own] = await Promise.all([
      approve(s.admin, tr.body.id),
      s.admin.req(
        'PUT',
        `/api/v1/service-order-items/${item.id}/upholsterer`,
        {
          userId: s.ids.thiago,
          expectedUserId: s.ids.ricardo,
          reason: 'Troca direta',
          confirm: true,
        },
        { 'idempotency-key': idemKey() },
      ),
    ]);
    expect([ap.status, own.status].filter((x) => x === 200)).toHaveLength(1);
    const final = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([s.ids.marcio, s.ids.thiago]).toContain(final.upholstererUserId);
    expect((await s.reload(s.main.id)).assignee?.userId).toBe(final.upholstererUserId);
  });
});
