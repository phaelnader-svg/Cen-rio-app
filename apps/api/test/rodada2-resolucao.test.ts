import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { detectAbsences } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, employeeByName, resetDatabase } from './helpers';
import { post, prepareCompany, scenario } from './labor-helpers';
import { act, today } from './production-helpers';
import { arrive, attendanceAction, setClock } from './presence-helpers';
import { qualityKit } from './quality-helpers';

/**
 * Remediação pós-auditoria, Rodada 2 — F10-19 (cobertura): cada aviso que pede ação é marcado
 * RESOLVIDO pela própria ação que encerra a condição (ausência presumida, ocorrência aberta,
 * pedido de ajuda, inspeção, embalagem, pronto para entrega, entrega atribuída), e volta a ficar
 * ativo se o mesmo fato acontecer de novo.
 */
let app: App;
const k = qualityKit(() => app);

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});
afterEach(() => setAttendanceClock());

const meId = async (c: Client) => (await c.get('/api/auth/me')).body.user.id as string;
const active = (userId: string, kind: string) =>
  db().notification.findMany({ where: { userId, kind, resolvedAt: null } });
const resolved = (userId: string, kind: string) =>
  db().notification.findMany({ where: { userId, kind, resolvedAt: { not: null } } });

describe('F10-19 — presença e ocorrências', () => {
  it('ausência presumida: a chegada resolve um aviso; a confirmação do gestor resolve o outro', async () => {
    const s = await scenario(app, { arrive: ['Ricardo'] });
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(3);
    const gestor = await meId(s.admin);
    expect(await active(gestor, 'AUSENCIA_PRESUMIDA')).toHaveLength(3);
    const marcio = await employeeByName('Márcio');
    const thiago = await employeeByName('Thiago');
    const rowOf = (employeeId: string) =>
      db().operationalAttendance.findUniqueOrThrow({
        where: { employeeId_date: { employeeId, date: new Date(`${today()}T00:00:00.000Z`) } },
      });
    const keyOf = async (employeeId: string) =>
      `AUSENCIA_PRESUMIDA:${(await rowOf(employeeId)).id}`;
    // O Márcio chega atrasado: só o aviso dele sai da lista ativa.
    setClock('09:45');
    expect((await arrive(s.tablets['Márcio']!)).status).toBe(200);
    const left = await active(gestor, 'AUSENCIA_PRESUMIDA');
    expect(left).toHaveLength(2);
    expect(left.map((n) => n.dedupeKey)).not.toContain(await keyOf(marcio.id));
    // O gestor confirma a ausência do Thiago: a condição foi tratada.
    const r = await attendanceAction(s.admin, {
      employeeId: thiago.id,
      date: today(),
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Avisou que está doente',
      version: (await rowOf(thiago.id)).version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const still = await active(gestor, 'AUSENCIA_PRESUMIDA');
    expect(still).toHaveLength(1);
    expect(still[0]!.dedupeKey).not.toBe(await keyOf(thiago.id));
    expect(await resolved(gestor, 'AUSENCIA_PRESUMIDA')).toHaveLength(2);
  });

  it('ocorrência aberta: atribuir a tratativa resolve o aviso dos gestores', async () => {
    const s = await scenario(app);
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    const issue = await post(s.tablets.Ricardo!, '/api/v1/issues', {
      taskId: s.sofaTask.id,
      kind: 'TECNICO',
      description: 'Grampeador sem pressão',
      impact: 'DIFICULDADE',
    });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    const gestor = await meId(s.admin);
    expect(await active(gestor, 'OCORRENCIA_ABERTA')).toHaveLength(1);
    const asg = await post(s.admin, `/api/v1/issues/${issue.body.id}/assign`, {
      assigneeUserId: s.ids.joao,
      instructions: 'Trocar o compressor',
      confirmConflict: true,
    });
    expect(asg.status, JSON.stringify(asg.body)).toBe(200);
    expect(await active(gestor, 'OCORRENCIA_ABERTA')).toHaveLength(0);
    expect(await resolved(gestor, 'OCORRENCIA_ABERTA')).toHaveLength(1);
    // A atribuição em si continua ativa para quem a recebeu.
    expect(await active(s.ids.joao, 'OCORRENCIA_ATRIBUIDA')).toHaveLength(1);
  });

  it('pedido de ajuda: a atribuição resolve o "procurando ajudante"', async () => {
    const s = await scenario(app);
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    const r = await s.tablets.Ricardo!.post(
      '/api/v1/help-requests',
      { taskId: s.sofaTask.id, kind: 'PARAFUSAR' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('ATRIBUIDA');
    expect(await active(s.ids.ricardo, 'AJUDA_SOLICITADA')).toHaveLength(0);
    const done = await resolved(s.ids.ricardo, 'AJUDA_SOLICITADA');
    expect(done.map((n) => n.dedupeKey)).toEqual([`AJUDA_SOLICITADA:${r.body.id}`]);
  });
});

describe('F10-19 — qualidade e entrega', () => {
  it('inspeção, embalagem, pronto e entrega: cada etapa vencida resolve o próprio aviso', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const inspNotices = () =>
      db().notification.findMany({
        where: { kind: { in: ['INSPECAO_PENDENTE', 'INSPECAO_ATRIBUIDA', 'NOVA_INSPECAO'] } },
      });
    expect((await inspNotices()).some((n) => n.resolvedAt === null)).toBe(true);
    await k.approveOpen(s, s.sofa.id);
    // Aprovada: nenhum aviso de inspeção da peça continua pedindo ação.
    expect((await inspNotices()).every((n) => n.resolvedAt !== null)).toBe(true);
    const packNotices = () => db().notification.findMany({ where: { kind: 'EMBALAGEM_LIBERADA' } });
    expect((await packNotices()).some((n) => n.resolvedAt === null)).toBe(true);
    await k.pack(s, s.sofa.id);
    expect((await packNotices()).every((n) => n.resolvedAt !== null)).toBe(true);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const ready = () =>
      db().notification.findMany({
        where: { dedupeKey: { startsWith: `PRONTO_ENTREGA:${s.sofa.id}` } },
      });
    expect((await ready()).some((n) => n.resolvedAt === null)).toBe(true);
    // Agendada: a peça deixa de estar "pronta, aguardando agendamento".
    const d = await k.schedule(s);
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await ready()).every((n) => n.resolvedAt !== null)).toBe(true);
    expect(await active(s.ids.andre, 'ENTREGA_ATRIBUIDA')).toHaveLength(1);
    // Cancelada: a atribuição deixa de pedir ação; a peça volta a ficar pronta e o aviso reativa.
    const cur = await db().delivery.findUniqueOrThrow({ where: { id: d.body.id } });
    const c = await post(s.admin, `/api/v1/deliveries/${d.body.id}/cancel`, {
      reason: 'Cliente pediu para remarcar',
      version: cur.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await active(s.ids.andre, 'ENTREGA_ATRIBUIDA')).toHaveLength(0);
    expect(await resolved(s.ids.andre, 'ENTREGA_ATRIBUIDA')).toHaveLength(1);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const again = await ready();
    expect(again.some((n) => n.resolvedAt === null)).toBe(true);
    expect(again.every((n) => n.readAt === null || n.resolvedAt !== null)).toBe(true);
  });
});
