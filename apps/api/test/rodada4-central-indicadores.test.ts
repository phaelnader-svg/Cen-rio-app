import { MATERIALS_PENDING_STATES, type AttentionDto, type OverviewDto } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { detectAbsences } from '../src/modules/attendance/absence';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, employeeByName, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, panelUserWith } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import {
  approvedNeeds,
  confirmedFabricPurchase,
  createSupplier,
  linen,
  ok,
  receive,
} from './purchasing-helpers';
import { act, day, today, userIdOf } from './production-helpers';
import {
  arrive,
  ask,
  attendanceAction,
  prepareCompany,
  scenario,
  setClock,
} from './presence-helpers';
import { post, qualityKit } from './quality-helpers';

/**
 * Remediação pós-auditoria, Rodada 4 — PROVA da Central do Gestor e dos indicadores do Início
 * (Fase 10): F10-13k2 (ausência com impacto + permissão `presenca.*`), F10-13l (pedido de ajuda
 * atrasado na Central, link para o item exato, sai quando resolvido), F10-21d (aguardando
 * material — número exato), F10-21e (em produção), F10-21g (prontas para entrega), F10-21j
 * (cobranças vencidas no Início), F10-21n (retrabalho), F10-21o (a receber), F10-21p (vencido)
 * e F10-21t (decisões financeiras / revisões). Cada indicador tem caso POSITIVO com valor exato
 * vindo de cenário criado pelas rotas e é comparado com a tela/rota de origem. Dados fictícios.
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
  await prepareCompany(); // todos os dias úteis; alerta de chegada às 9h30
  setClock('09:00');
});
afterEach(() => setAttendanceClock());

const attention = async (c: Client, query = '') => {
  const r = await c.get(`/api/v1/attention${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AttentionDto;
};
const overview = async (c: Client) => {
  const r = await c.get('/api/v1/management/overview');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as OverviewDto;
};
const item = (a: AttentionDto, key: string) => a.items.find((i) => i.key === key);
const attendanceOf = (employeeId: string) =>
  db().operationalAttendance.findUniqueOrThrow({
    where: { employeeId_date: { employeeId, date: new Date(`${today()}T00:00:00.000Z`) } },
  });
const openImpacts = async (c: Client) =>
  (
    (await c.get(`/api/v1/attendance/impacts?date=${today()}`)).body as {
      id: string;
      attendanceId: string;
      task: { id: string };
      resolvedAt: string | null;
    }[]
  ).filter((i) => !i.resolvedAt);

// ─────────────────────────── F10-13k2 ───────────────────────────

describe('F10-13k2 — Presença: ausência com impacto na Central', () => {
  it('ausência presumida e depois CONFIRMADA pelo gestor: item de impacto com link para o registro; encaminhado, sai', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'João', 'Thiago'] });
    const marcio = await employeeByName('Márcio');
    // Antes do limite de chegada: Márcio só não chegou, nada de impacto.
    expect((await attention(s.admin, '?type=PRESENCA')).items).toEqual([]);
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(1);
    const r = await attendanceAction(s.admin, {
      employeeId: marcio.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Consulta médica',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const att = await attendanceOf(marcio.id);
    expect(att.situation).toBe('AUSENCIA_CONFIRMADA');
    // A fonte: os impactos do dia na tela de Presença (mesma rota que a tela usa).
    const open = (await openImpacts(s.admin)).filter((i) => i.attendanceId === att.id);
    expect(open.map((i) => i.task.id)).toContain(s.marcioTask.id);
    const a = await attention(s.admin, '?type=PRESENCA');
    expect(a.items).toHaveLength(1);
    expect(item(a, `PRESENCA:${att.id}`)).toMatchObject({
      type: 'PRESENCA',
      category: 'ACAO',
      status: 'AUSENCIA_CONFIRMADA',
      employee: { userId: s.ids.marcio, displayName: 'Márcio' },
      description: `${open.length} impacto(s) em tarefas a encaminhar.`,
      link: `/painel/presenca?foco=${att.id}`,
    });
    expect(item(a, `PRESENCA:${att.id}`)!.impacts.join(' ')).toContain(s.marcioTask.code);
    // Encaminhar todos os impactos (rota canônica) → o item sai da Central.
    for (const i of open) {
      const res = await post(s.admin, `/api/v1/attendance/impacts/${i.id}/resolve`, {
        resolution: 'Reprogramada para amanhã',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(item(await attention(s.admin), `PRESENCA:${att.id}`)).toBeUndefined();
  });

  it('ausência confirmada DIRETO, com troca simples automática: nada pendente, nada na Central (operação normal)', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'João', 'Thiago'] });
    const marcio = await employeeByName('Márcio');
    const r = await attendanceAction(s.admin, {
      employeeId: marcio.id,
      action: 'CONFIRMAR_AUSENCIA',
      reason: 'Consulta médica',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const att = await attendanceOf(marcio.id);
    // A tarefa do dia já foi passada (registrado) a quem está presente e capacitado.
    const t = await db().productionTask.findUniqueOrThrow({ where: { id: s.marcioTask.id } });
    expect(t.assigneeUserId).not.toBe(s.ids.marcio);
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_REATRIBUIDA' } })).toBe(1);
    // Sem impacto pendente: a Central não inventa item de presença.
    expect((await openImpacts(s.admin)).filter((i) => i.attendanceId === att.id)).toEqual([]);
    expect(item(await attention(s.admin), `PRESENCA:${att.id}`)).toBeUndefined();
  });

  it('ausência PRESUMIDA (após o limite) gera o item; a chegada da pessoa resolve e ele sai', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'João', 'Thiago'] });
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(1); // só Márcio
    const marcio = await employeeByName('Márcio');
    const att = await db().operationalAttendance.findUniqueOrThrow({
      where: {
        employeeId_date: { employeeId: marcio.id, date: new Date(`${today()}T00:00:00.000Z`) },
      },
    });
    expect(att.situation).toBe('AUSENCIA_PRESUMIDA');
    expect(item(await attention(s.admin, '?type=PRESENCA'), `PRESENCA:${att.id}`)).toMatchObject({
      status: 'AUSENCIA_PRESUMIDA',
      link: `/painel/presenca?foco=${att.id}`,
    });
    setClock('09:45');
    expect((await arrive(s.tablets.Márcio!)).status).toBe(200);
    expect(item(await attention(s.admin), `PRESENCA:${att.id}`)).toBeUndefined();
  });

  it('permissão: só "ocorrencias.ver" NÃO vê a ausência; com "presenca.ver" ou "presenca.gerenciar" vê', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'João', 'Thiago'] });
    setClock('09:31');
    expect(await detectAbsences(app.ctx.prisma)).toBe(1);
    const key = `PRESENCA:${(await attendanceOf((await employeeByName('Márcio')).id)).id}`;
    expect(item(await attention(s.admin), key)).toBeDefined(); // controle positivo
    const onlyIssues = await panelUserWith(app, s.admin, 'r4-ocorr', ['ocorrencias.ver']);
    const v = await attention(onlyIssues);
    expect(v.items.filter((i) => i.type === 'PRESENCA')).toEqual([]);
    expect(v.total).toBe(v.items.length); // nada contado que não se vê
    // A tela de origem também é negada a ele (mesma permissão).
    expect((await onlyIssues.get('/api/v1/attendance/impacts')).status).toBe(403);
    const viewer = await panelUserWith(app, s.admin, 'r4-presv', [
      'ocorrencias.ver',
      'presenca.ver',
    ]);
    expect(item(await attention(viewer), key)).toBeDefined();
    const manager = await panelUserWith(app, s.admin, 'r4-presg', [
      'ocorrencias.ver',
      'presenca.gerenciar',
    ]);
    expect(item(await attention(manager), key)).toBeDefined();
  });
});

// ─────────────────────────── F10-13l ───────────────────────────

describe('F10-13l — Apoio: pedido de ajuda atrasado na Central', () => {
  it('pedido esperando além do limite aparece com link para o pedido exato; atribuído, sai', async () => {
    // Só Ricardo chegou: ninguém livre para ajudar → o pedido fica PENDENTE.
    const s = await scenario(app, { arrive: ['Ricardo'] });
    const h = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(h.body.status).toBe('PENDENTE');
    const key = `AJUDA:${h.body.id}`;
    // Dentro do limite (20 min, pedido normal): operação normal, não aparece.
    setClock('09:19');
    expect(item(await attention(s.admin), key)).toBeUndefined();
    // Passou do limite: aparece, com o pedido e a tarefa exatos.
    setClock('09:21');
    const a = await attention(s.admin, '?type=AJUDA');
    expect(a.items).toHaveLength(1);
    expect(item(a, key)).toMatchObject({
      type: 'AJUDA',
      category: 'ATENCAO',
      status: 'PENDENTE',
      task: { id: s.main.id },
      employee: { userId: s.ids.ricardo },
      impacts: ['Aguardando há 21 min'],
      // F10-14: o link leva ao pedido (foco), não à lista genérica.
      link: `/painel/ajuda?foco=${h.body.id}`,
    });
    expect(item(a, key)!.link).not.toBe('/painel/ajuda');
    // A tela de origem tem o mesmo pedido (o foco aponta para uma linha que existe).
    const list = (await s.admin.get('/api/v1/help-requests')).body as { id: string }[];
    expect(list.map((x) => x.id)).toContain(h.body.id);
    // Permissão do domínio: só "ocorrencias.ver" não vê; com "producao.planejar" vê.
    const onlyIssues = await panelUserWith(app, s.admin, 'r4-ajuda-o', ['ocorrencias.ver']);
    expect(item(await attention(onlyIssues), key)).toBeUndefined();
    const planner = await panelUserWith(app, s.admin, 'r4-ajuda-p', [
      'ocorrencias.ver',
      'producao.planejar',
    ]);
    expect(item(await attention(planner), key)).toBeDefined();
    // Resolvido: João chega e a fila (rota canônica) atribui → sai da Central.
    setClock('09:25');
    expect((await arrive(s.tablets.João!)).status).toBe(200);
    await post(s.admin, '/api/v1/help-requests/process');
    expect((await db().helpRequest.findUniqueOrThrow({ where: { id: h.body.id } })).status).toBe(
      'ATRIBUIDA',
    );
    expect(item(await attention(s.admin), key)).toBeUndefined();
  });

  it('pedido urgente sem ajudante livre aparece como CRÍTICO após o limite; cancelado pelo gestor, sai', async () => {
    const s = await scenario(app, { arrive: ['Ricardo'] });
    const h = await ask(s.tablets.Ricardo!, {
      taskId: s.main.id,
      kind: 'MOVIMENTAR',
      urgent: true,
      justification: 'Sofá tombando',
    });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const key = `AJUDA:${h.body.id}`;
    expect(h.body.status).toBe('PENDENTE');
    // Urgente aparece logo (atenção) e, passado o limite de 5 min, vira crítico.
    expect(item(await attention(s.admin), key)).toMatchObject({
      category: 'ATENCAO',
      priority: 'URGENTE',
      link: `/painel/ajuda?foco=${h.body.id}`,
    });
    setClock('09:06');
    // A fila (rota canônica) roda e não acha ninguém: continua pendente, sem proposta.
    expect((await post(s.admin, '/api/v1/help-requests/process')).body).toEqual({ assigned: 0 });
    expect(await db().rescheduleProposal.count()).toBe(0);
    expect(item(await attention(s.admin), key)).toMatchObject({
      category: 'CRITICO',
      priority: 'URGENTE',
      impacts: ['Aguardando há 6 min'],
      link: `/painel/ajuda?foco=${h.body.id}`,
    });
    // Encerrado pelo gestor: nada de ajuda na Central.
    const c = await post(s.admin, `/api/v1/help-requests/${h.body.id}/cancel`, {
      reason: 'Resolvido no local',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await attention(s.admin, '?type=AJUDA')).items).toEqual([]);
  });

  it('pedido ESCALADO (apoio prolongado) vira UM item: a proposta com link exato; recusada, os dois saem', async () => {
    const s = await scenario(app, { arrive: ['Ricardo', 'Márcio', 'João', 'Thiago'] });
    const r = await post(s.tablets.Ricardo!, '/api/v1/help-requests/prolonged', {
      taskId: s.main.id,
      helperUserId: s.ids.thiago,
      estimatedMinutes: 480,
      justification: 'Sofá de canto: apoio o dia todo',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('ESCALADA');
    const p = await db().rescheduleProposal.findFirstOrThrow({
      where: { helpRequestId: r.body.id, status: 'PENDENTE' },
    });
    setClock('10:00');
    const a = await attention(s.admin);
    // Sem item AJUDA duplicado: a decisão é a proposta.
    expect(item(a, `AJUDA:${r.body.id}`)).toBeUndefined();
    expect(item(a, `PROPOSTA:${p.id}`)).toMatchObject({
      type: 'PROPOSTA',
      link: `/painel/reprogramacao?foco=${p.id}`,
    });
    const rej = await post(s.admin, `/api/v1/reschedule-proposals/${p.id}/reject`, {
      note: 'Sem gente sobrando hoje',
    });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const after = await attention(s.admin);
    expect(item(after, `PROPOSTA:${p.id}`)).toBeUndefined();
    expect(item(after, `AJUDA:${r.body.id}`)).toBeUndefined();
  });
});

// ─────────────────────────── F10-21d ───────────────────────────

describe('F10-21d — Início: aguardando material (número exato)', () => {
  it('3 OS com necessidade aprovada sem material + 1 sem necessidade → 3; material recebido em uma → 2', async () => {
    const admin = await loginAdmin(app);
    const needs = [];
    for (const n of ['A', 'B', 'C'])
      needs.push(
        await approvedNeeds(admin, `Cliente Material ${n}`, (x) => [linen(x.items[0]!.id)]),
      );
    await openServiceOrder(admin, 'Cliente Sem Material');
    // Cada uma das 3 está num estado pendente canônico.
    const pendingSet = new Set<string>(MATERIALS_PENDING_STATES);
    for (const n of needs)
      expect(
        pendingSet.has(
          (await db().serviceOrder.findUniqueOrThrow({ where: { id: n.so.id } }))
            .materialsReadiness,
        ),
      ).toBe(true);
    // Mesma fonte da tela "Prontidão de materiais".
    const readinessPending = async () =>
      (
        (await admin.get('/api/v1/material-readiness')).body as {
          serviceOrder: { id: string };
          state: string;
        }[]
      ).filter((r) => pendingSet.has(r.state)).length;
    expect(await readinessPending()).toBe(3);
    expect((await overview(admin)).operations!.awaitingMaterials).toBe(3);
    // Compra confirmada e recebida por inteiro (rotas reais) para a OS A → sai.
    const sup = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, sup.id, needs[0]!.reqs[0]!);
    const rec = await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(
      pendingSet.has(
        (await db().serviceOrder.findUniqueOrThrow({ where: { id: needs[0]!.so.id } }))
          .materialsReadiness,
      ),
    ).toBe(false);
    expect(await readinessPending()).toBe(2);
    expect((await overview(admin)).operations!.awaitingMaterials).toBe(2);
  });
});

// ─────────────────────────── F10-21e/g/n ───────────────────────────

describe('F10-21e/g/n — Início: em produção, retrabalho e prontas para entrega', () => {
  it('valores exatos a cada etapa real da peça, iguais aos da lista de peças (/pieces)', async () => {
    const s = await k.scenario();
    const pieces = async (stage: string) =>
      ((await s.admin.get(`/api/v1/pieces?stage=${stage}`)).body as unknown[]).length;
    // Início: as duas peças da OS (sofá e poltronas) em produção.
    let o = await overview(s.admin);
    expect(o.operations!.pieces).toMatchObject({ production: 2, rework: 0, ready: 0 });
    expect(o.operations!.pieces.production).toBe(await pieces('EM_PRODUCAO'));
    // Sofá concluído e reprovado na inspeção → retrabalho (F10-21n).
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const open = (await k.openOf(s.sofa.id))!;
    const bad = await k.checkAll(s.tablets.Thiago!, open.id, 'Ponto solto no braço');
    const rj = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${open.id}/reject`, {
      reason: 'Costura com ponto solto',
      version: bad.version,
    });
    expect(rj.status, JSON.stringify(rj.body)).toBe(200);
    expect(await k.stage(s.sofa.id)).toBe('EM_CORRECAO');
    o = await overview(s.admin);
    expect(o.operations!.pieces).toMatchObject({ production: 1, rework: 1, ready: 0 });
    expect(o.operations!.pieces.rework).toBe(await pieces('EM_CORRECAO'));
    // Poltronas produzidas, aprovadas e embaladas → prontas para entrega (F10-21g).
    await k.ready(s, 'poltronas');
    expect(await k.stage(s.poltronas.id)).toBe('PRONTA_ENTREGA');
    o = await overview(s.admin);
    expect(o.operations!.pieces).toMatchObject({ production: 0, rework: 1, ready: 1 });
    expect(o.operations!.pieces.ready).toBe(await pieces('PRONTA_ENTREGA'));
    expect(o.operations!.pieces.production).toBe(await pieces('EM_PRODUCAO'));
    // Agendada a entrega das poltronas: sai de "prontas" e vai para "agendadas".
    const d = await k.schedule(s, { itemIds: [s.poltronas.id] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    o = await overview(s.admin);
    expect(o.operations!.pieces).toMatchObject({ ready: 0, scheduled: 1, rework: 1 });
    // Correção concluída pelo Ricardo → sai do retrabalho.
    const correction = await db().productionTask.findFirstOrThrow({
      where: { activity: 'CORRECAO', serviceOrderItemId: s.sofa.id },
    });
    expect((await act(s.tablets.Ricardo!, correction.id, 'start')).status).toBe(200);
    expect(
      (await act(s.tablets.Ricardo!, correction.id, 'complete', { note: 'Corrigido' })).status,
    ).toBe(200);
    o = await overview(s.admin);
    expect(o.operations!.pieces.rework).toBe(0);
    expect(o.operations!.pieces.rework).toBe(await pieces('EM_CORRECAO'));
  });
});

// ─────────────────────────── F10-21j/o/p ───────────────────────────

const F = (p: string) => `/api/v1/finance${p}`;
type Rec = { id: string; openCents: number; overdue: boolean; status: string; version: number };

async function receivables(admin: Client) {
  const c = await createCustomer(admin, { name: 'Cliente Cobrança R4', allowSimilar: true });
  const order = await createOrder(admin, c); // valor contratado R$ 3.500,00
  const create = async (description: string, amountCents: number, dueDate: string) => {
    const r = await post(admin, F('/receivables'), {
      orderId: order.id,
      description,
      amountCents,
      dueDate,
      expectedMethod: 'PIX',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as Rec;
  };
  const a = await create('Entrada', 100000, day(-3)); // vencida, saldo 1.000
  let b = await create('Segunda parcela', 50000, day(-1)); // vencida, paga em parte
  const c3 = await create('Saldo final', 80000, day(5)); // a vencer
  const paid = await post(admin, F(`/receivables/${b.id}/payments`), {
    amountCents: 20000,
    receivedAt: today(),
    method: 'PIX',
    version: b.version,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  b = paid.body as Rec;
  return { order, a, b, c: c3 };
}

describe('F10-21j/o/p — Início: a receber, vencido e cobranças que exigem atenção', () => {
  it('valores exatos, iguais à lista de cobranças e às cobranças vencidas da Central', async () => {
    const admin = await loginAdmin(app);
    const r = await receivables(admin);
    const o = await overview(admin);
    // a receber = 1.000 + 300 + 800; vencido = 1.000 + 300 (2 cobranças).
    expect(o.finance!.receivables).toEqual({
      openCents: 210000,
      overdueCents: 130000,
      overdueCount: 2,
    });
    // Fonte de origem: Financeiro → Receitas (/finance/receivables) e o filtro de vencidas.
    const list = (await admin.get(F('/receivables'))).body as Rec[];
    const openList = list.filter((x) => ['ABERTO', 'PARCIAL'].includes(x.status));
    expect(openList.reduce((s, x) => s + x.openCents, 0)).toBe(o.finance!.receivables.openCents);
    const overdue = (await admin.get(F('/receivables?overdue=1'))).body as Rec[];
    expect(overdue.map((x) => x.id).sort()).toEqual([r.a.id, r.b.id].sort());
    expect(overdue.reduce((s, x) => s + x.openCents, 0)).toBe(o.finance!.receivables.overdueCents);
    // F10-21j: as cobranças vencidas que a Central acusa são as mesmas contadas no Início.
    const cob = (await attention(admin, '?type=COBRANCA')).items.filter((i) =>
      i.key.startsWith('COBRANCA:VENCIDA:'),
    );
    expect(cob.map((i) => i.key).sort()).toEqual(
      [`COBRANCA:VENCIDA:${r.a.id}`, `COBRANCA:VENCIDA:${r.b.id}`].sort(),
    );
    expect(cob).toHaveLength(o.finance!.receivables.overdueCount);
    // Quitada a entrada vencida: tudo cai junto (1 vencida, 300 vencido, 1.100 a receber).
    const a = (await admin.get(F(`/receivables/${r.a.id}`))).body as Rec;
    const q = await post(admin, F(`/receivables/${a.id}/payments`), {
      amountCents: 100000,
      receivedAt: today(),
      method: 'PIX',
      version: a.version,
    });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect((await overview(admin)).finance!.receivables).toEqual({
      openCents: 110000,
      overdueCents: 30000,
      overdueCount: 1,
    });
    expect(
      (await attention(admin, '?type=COBRANCA')).items.filter((i) =>
        i.key.startsWith('COBRANCA:VENCIDA:'),
      ),
    ).toHaveLength(1);
  });

  it('sem "financeiro.ver", com cobranças reais existentes, os indicadores financeiros vêm null (nunca zero)', async () => {
    const admin = await loginAdmin(app);
    await receivables(admin);
    const ops = await panelUserWith(app, admin, 'r4-semfin', ['os.ver', 'ocorrencias.ver']);
    const o = await overview(ops);
    expect(o.finance).toBeNull();
    expect(o.operations).not.toBeNull();
    expect(JSON.stringify(o)).not.toMatch(/Cents|overdueCount|laborReviews/);
    // E a Central não lhe mostra as cobranças.
    expect((await attention(ops)).items.filter((i) => i.type === 'COBRANCA')).toEqual([]);
    // Com a permissão, os números aparecem (o null é o corte, não a falta de dado).
    const fin = await panelUserWith(app, admin, 'r4-fin', ['financeiro.ver']);
    expect((await overview(fin)).finance!.receivables.overdueCount).toBe(2);
  });
});

// ─────────────────────────── F10-21t ───────────────────────────

describe('F10-21t — Início: decisões financeiras (revisões de mão de obra)', () => {
  it('2 revisões abertas pela troca real de titular → 2, iguais à lista e à Central; resolvida uma → 1', async () => {
    const admin = await loginAdmin(app);
    const ric = await userIdOf('Ricardo');
    const mar = await userIdOf('Márcio');
    const owner = (itemId: string, userId: string, expectedUserId: string | null) =>
      admin.req(
        'PUT',
        `/api/v1/service-order-items/${itemId}/upholsterer`,
        { userId, expectedUserId, confirm: Boolean(expectedUserId), reason: 'Troca de titular' },
        { 'idempotency-key': idemKey() },
      );
    for (const n of ['A', 'B']) {
      const so = await openServiceOrder(admin, `Cliente Revisão ${n}`);
      expect((await owner(so.items[0]!.id, ric, null)).status).toBe(200);
      const l = await post(admin, F('/labor'), {
        professionalUserId: ric,
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[0]!.id,
        service: 'Mão de obra',
        agreedCents: 80000,
      });
      expect(l.status, JSON.stringify(l.body)).toBe(201);
      const t = await owner(so.items[0]!.id, mar, ric);
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      expect(t.body).toMatchObject({ financialReviewRequired: true });
    }
    const reviews = async () =>
      (await admin.get(F('/labor-reviews?status=ABERTA'))).body as {
        id: string;
        version: number;
      }[];
    const open = await reviews();
    expect(open).toHaveLength(2);
    let o = await overview(admin);
    expect(o.finance!.decisions).toMatchObject({ laborReviews: 2, valueRequests: 0 });
    const central = (await attention(admin, '?type=FINANCEIRO')).items.filter((i) =>
      i.key.startsWith('FINANCEIRO:revisao:'),
    );
    expect(central.map((i) => i.key).sort()).toEqual(
      open.map((r) => `FINANCEIRO:revisao:${r.id}`).sort(),
    );
    for (const i of central) expect(i.link).toMatch(/^\/painel\/financeiro\?tab=producao&foco=/);
    // Resolver uma (rota canônica): Início, lista e Central caem para 1.
    const rv = open[0]!;
    const res = await post(admin, F(`/labor-reviews/${rv.id}/resolve`), {
      lines: [
        { professionalUserId: ric, amountCents: 30000 },
        { professionalUserId: mar, amountCents: 50000 },
      ],
      reason: 'Divisão definida pelo gestor',
      version: rv.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await reviews()).toHaveLength(1);
    o = await overview(admin);
    expect(o.finance!.decisions.laborReviews).toBe(1);
    expect(
      (await attention(admin, '?type=FINANCEIRO')).items.filter((i) =>
        i.key.startsWith('FINANCEIRO:revisao:'),
      ),
    ).toHaveLength(1);
    // Sem "financeiro.ver": o bloco inteiro é null.
    const ops = await panelUserWith(app, admin, 'r4-rev-semfin', ['os.ver']);
    expect((await overview(ops)).finance).toBeNull();
  });
});
