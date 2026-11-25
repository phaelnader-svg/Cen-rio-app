import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { nextWorkday, runOfficeRound } from '../src/modules/game/office';

describe('próximo dia útil', () => {
  it('pula fim de semana e feriado', () => {
    expect(nextWorkday('2026-11-27')).toBe('2026-11-30'); // sexta → segunda
    expect(nextWorkday('2026-12-24')).toBe('2026-12-28'); // Natal na sexta
  });
});
import { type Client, createTestApp, db, idemKey, naEmpresa1, resetDatabase } from './helpers';
import { qualityKit } from './quality-helpers';

/**
 * Escritório trabalhando sozinho (2026-11-25): rodada dos agentes, níveis por tarefa, parar tudo
 * e a tarefa nova "agendar a entrega da peça pronta". Dados fictícios, banco descartável.
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));
const round = async (c: Client) => ok(await send(c, 'POST', '/api/v1/office/round', {}));

/** Peça pronta na expedição e o Atendimento contratado pelo Escritório. */
async function readyWithAttendance() {
  const s = await k.scenario();
  await k.ready(s, 'sofa');
  ok(await send(s.admin, 'POST', '/api/v1/office/hire', { roleKey: 'ATENDIMENTO' }), 201);
  return s;
}

describe('Escritório trabalhando sozinho', () => {
  it('Atendimento propõe agendar a entrega da peça pronta; aprovar cria a entrega e devolve o WhatsApp com a data', async () => {
    const s = await readyWithAttendance();
    await round(s.admin);
    const o = await overview(s.admin);
    const p = o.pending.find((x) => x.task === 'AGENDAR_ENTREGA')!;
    expect(p, JSON.stringify(o.pending.map((x) => x.title))).toBeTruthy();
    expect(p.payload.itemIds).toEqual([s.sofa.id]);
    expect(String(p.payload.scheduledDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.detail).toMatch(/entrega/);
    expect(p.suggestion).toBe(false);
    // Sem o aviso solto de "peça pronta" para a mesma OS.
    expect(o.pending.filter((x) => x.task === 'AVISAR_PRONTO')).toHaveLength(0);
    // O dono recebe o aviso no sininho.
    const n = await db().notification.findFirst({ where: { kind: 'AGENTES_PEDEM' } });
    expect(n?.body).toMatch(/Agendar a entrega/);

    // Rodar de novo não repete o pedido.
    await round(s.admin);
    expect(
      (await overview(s.admin)).pending.filter((x) => x.task === 'AGENDAR_ENTREGA'),
    ).toHaveLength(1);

    // Aprovar mudando o horário: a entrega é criada e a mensagem sai com o horário novo.
    const decided = ok(
      await send(s.admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, {
        decision: 'APROVAR',
        edits: { windowStart: '14:00', windowEnd: '17:00' },
      }),
    );
    expect(decided.status).toBe('APROVADA');
    expect(decided.payload.sent).toBe(false);
    expect(decodeURIComponent(String(decided.payload.href))).toMatch(/a partir das 14:00/);
    const d = await db().delivery.findUniqueOrThrow({
      where: { id: String(decided.payload.deliveryId) },
      include: { items: true },
    });
    expect(d.status).toBe('AGENDADA');
    expect(d.windowStart).toBe('14:00');
    expect(d.items.map((i) => i.serviceOrderItemId)).toEqual([s.sofa.id]);
    expect(await k.stage(s.sofa.id)).toBe('ENTREGA_AGENDADA');
    // Agendada: a rodada seguinte não propõe de novo.
    await round(s.admin);
    expect(
      (await overview(s.admin)).pending.filter((x) => x.task === 'AGENDAR_ENTREGA'),
    ).toHaveLength(0);
  });

  it('pedido de uma peça que ganhou entrega por fora fica desatualizado e não executa', async () => {
    const s = await readyWithAttendance();
    await round(s.admin);
    const p = (await overview(s.admin)).pending.find((x) => x.task === 'AGENDAR_ENTREGA')!;
    ok(await k.schedule(s), 201);
    const r = await send(s.admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, {
      decision: 'APROVAR',
    });
    expect(r.status).toBe(409);
    expect(await db().delivery.count()).toBe(1);
  });

  it('nível "Sozinho" sem o WhatsApp da empresa continua pedindo; com ele, o agente faz e fica registrado', async () => {
    const s = await readyWithAttendance();
    const o = await overview(s.admin);
    const at = o.agents.find((a) => a.roleKey === 'ATENDIMENTO')!;
    const task = at.tasks.find((t) => t.key === 'AGENDAR_ENTREGA')!;
    expect(task.level).toBe(2);
    expect(task.maxLevel).toBe(2);
    expect(task.maxReason).toMatch(/WhatsApp da empresa/);
    ok(
      await send(s.admin, 'PUT', '/api/v1/office/tasks', {
        agentId: at.agentId,
        task: 'AGENDAR_ENTREGA',
        setting: { nivel: 4 },
      }),
    );
    await round(s.admin);
    expect(
      (await overview(s.admin)).pending.filter((x) => x.task === 'AGENDAR_ENTREGA'),
    ).toHaveLength(1);

    // Parar tudo: mesmo com o WhatsApp ligado, nada sai sozinho.
    ok(await send(s.admin, 'POST', '/api/v1/connections/WHATSAPP/test-mode', {}));
    ok(await send(s.admin, 'PUT', '/api/v1/office/settings', { paused: true }));
    await round(s.admin);
    expect(await db().delivery.count()).toBe(0);

    // Cliente sem WhatsApp: o agente não tem para onde mandar e volta a pedir.
    ok(await send(s.admin, 'PUT', '/api/v1/office/settings', { paused: false }));
    expect((await round(s.admin)).doneAlone).toBe(0);
    const tried = (await overview(s.admin)).pending.find((x) => x.task === 'AGENDAR_ENTREGA')!;
    expect(tried.payload.autoError).toMatch(/Sem WhatsApp/);
    // A tentativa só se repete no dia seguinte.
    await db().aiAgentProposal.update({
      where: { id: tried.id },
      data: { payload: { ...tried.payload, autoTriedAt: null, phone: '5512999990001' } },
    });
    // Voltar a trabalhar: o agente agenda e manda pelo WhatsApp da empresa (modo de teste).
    ok(await send(s.admin, 'PUT', '/api/v1/office/settings', { paused: false }));
    const r = await round(s.admin);
    expect(r.doneAlone).toBe(1);
    const after = await overview(s.admin);
    const done = after.recent.find((x) => x.task === 'AGENDAR_ENTREGA')!;
    expect(done.decidedByAgent).toBe(true);
    expect(done.status).toBe('EXECUTADA_TESTE');
    expect(after.today.doneAlone).toBe(1);
    expect(await db().delivery.count({ where: { status: 'AGENDADA' } })).toBe(1);
    const action = await db().agentAction.findFirst({ where: { kind: 'ENVIAR_MENSAGEM' } });
    expect(action?.status).toBe('ENVIADO_TESTE');
  });

  it('nível 1 só sugere: fica na lista sem aviso no celular', async () => {
    const s = await readyWithAttendance();
    const at = (await overview(s.admin)).agents.find((a) => a.roleKey === 'ATENDIMENTO')!;
    ok(
      await send(s.admin, 'PUT', '/api/v1/office/tasks', {
        agentId: at.agentId,
        task: 'AGENDAR_ENTREGA',
        setting: { nivel: 1 },
      }),
    );
    await round(s.admin);
    const p = (await overview(s.admin)).pending.find((x) => x.task === 'AGENDAR_ENTREGA')!;
    expect(p.suggestion).toBe(true);
    expect(await db().notification.count({ where: { kind: 'AGENTES_PEDEM' } })).toBe(0);
  });

  it('níveis inválidos são recusados e o Escritório exige o plano com o jogo', async () => {
    const s = await readyWithAttendance();
    const o = await overview(s.admin);
    const at = o.agents.find((a) => a.roleKey === 'ATENDIMENTO')!;
    // Sem valor em dinheiro não existe "sozinho com limite".
    expect(
      (
        await send(s.admin, 'PUT', '/api/v1/office/tasks', {
          agentId: at.agentId,
          task: 'AGENDAR_ENTREGA',
          setting: { nivel: 3, limiteCents: 1000 },
        })
      ).status,
    ).toBe(400);
    // Tarefa de outro agente.
    expect(
      (
        await send(s.admin, 'PUT', '/api/v1/office/tasks', {
          agentId: at.agentId,
          task: 'COBRAR_CLIENTE',
          setting: { nivel: 2 },
        })
      ).status,
    ).toBe(400);
    // Contratar duas vezes o mesmo agente.
    expect(
      (await send(s.admin, 'POST', '/api/v1/office/hire', { roleKey: 'ATENDIMENTO' })).status,
    ).toBe(409);
    await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao' } });
    expect((await s.admin.get('/api/v1/office')).status).toBe(409);
    // Sem o plano com o jogo, a rodada automática não faz nada.
    expect((await naEmpresa1(() => runOfficeRound(app.ctx.prisma, { force: true }))).skipped).toBe(
      'MODULO',
    );
  });

  it('fora do horário da oficina a rodada automática espera', async () => {
    const s = await readyWithAttendance();
    void s;
    // 03:00 em São Paulo.
    const r = await naEmpresa1(() =>
      runOfficeRound(app.ctx.prisma, { at: new Date('2026-11-25T06:00:00Z') }),
    );
    expect(r.skipped).toBe('FORA_DO_HORARIO');
  });
});
