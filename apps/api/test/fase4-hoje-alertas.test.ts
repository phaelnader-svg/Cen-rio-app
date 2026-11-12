import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { productivity } from '../src/modules/finance/results';
import { refreshOperationalAlerts } from '../src/modules/management/today';
import { panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, resetDatabase } from './helpers';
import { moneyKeys } from './labor-helpers';
import { day, today } from './production-helpers';
import { qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 4 — painel "Hoje", alertas internos (só o sininho), ações sugeridas
 * (explicativas, nunca executam nada) e produtividade operacional sem valores. Banco
 * descartável, dados fictícios.
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());
afterEach(() => setClock());

const DAY = 24 * 60 * 60 * 1000;
const alertsOf = (kind: string, resolved = false) =>
  db().notification.findMany({
    where: { kind, ...(resolved ? { resolvedAt: { not: null } } : { resolvedAt: null }) },
  });

/** Snapshot das tabelas que um recálculo "somente leitura" não pode tocar. */
async function businessSnapshot() {
  const d = db();
  return JSON.stringify(
    await Promise.all([
      d.serviceOrder.findMany({ orderBy: { id: 'asc' } }),
      d.serviceOrderItem.findMany({ orderBy: { id: 'asc' } }),
      d.productionTask.findMany({ orderBy: { id: 'asc' } }),
      d.delivery.findMany({ orderBy: { id: 'asc' } }),
      d.serviceOrderMaterial.findMany({ orderBy: { id: 'asc' } }),
      d.productionPayable.count(),
      d.customerReceivable.count(),
    ]),
  );
}

describe('Fase 4 — alertas internos', () => {
  it('prazo em risco/atrasado: avisa quem gerencia OS, sem duplicar, e resolve quando normaliza', async () => {
    const s = await k.scenario();
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    await refreshOperationalAlerts(app.ctx.prisma);
    await refreshOperationalAlerts(app.ctx.prisma);
    const open = await alertsOf('PRAZO_EM_RISCO');
    expect(open.length).toBeGreaterThan(0);
    // Um aviso por pessoa (o gestor tem os.gerenciar), mesmo recalculando duas vezes.
    const mine = open.filter((n) => n.userId === s.ids.gestor);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toMatch(/atrasada/);
    expect(mine[0]!.serviceOrderId).toBe(s.so.id);
    // Prazo renegociado para longe → aviso resolvido sozinho.
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(60)}T00:00:00Z`) },
    });
    await refreshOperationalAlerts(app.ctx.prisma);
    expect(await alertsOf('PRAZO_EM_RISCO')).toHaveLength(0);
    expect((await alertsOf('PRAZO_EM_RISCO', true)).length).toBeGreaterThan(0);
  });

  it('peça pronta sem entrega há 2+ dias: avisa entregas.gerenciar; resolve ao entregar', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    // No mesmo dia: ainda não é alerta.
    await refreshOperationalAlerts(app.ctx.prisma);
    expect(await alertsOf('PECA_PRONTA_SEM_ENTREGA')).toHaveLength(0);
    // Três dias depois, sem entrega.
    const base = Date.now();
    setClock(() => new Date(base + 3 * DAY));
    await refreshOperationalAlerts(app.ctx.prisma);
    const open = await alertsOf('PECA_PRONTA_SEM_ENTREGA');
    expect(open.filter((n) => n.userId === s.ids.gestor)).toHaveLength(1);
    expect(open[0]!.body).toMatch(/pronta há 3 dia/);
    // A peça sai do estado "pronta" (entregue) → alerta resolvido.
    await db().serviceOrderItem.update({
      where: { id: s.sofa.id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    await refreshOperationalAlerts(app.ctx.prisma);
    expect(await alertsOf('PECA_PRONTA_SEM_ENTREGA')).toHaveLength(0);
  });

  it('material faltante com produção próxima: avisa; resolve quando o material chega', async () => {
    const s = await k.scenario();
    const m = await db().serviceOrderMaterial.create({
      data: { serviceOrderId: s.so.id, description: 'Espuma D33', available: false },
    });
    await refreshOperationalAlerts(app.ctx.prisma);
    const open = await alertsOf('MATERIAL_FALTANTE');
    expect(open.filter((n) => n.userId === s.ids.gestor)).toHaveLength(1);
    expect(open[0]!.body).toMatch(/Espuma D33/);
    await db().serviceOrderMaterial.update({ where: { id: m.id }, data: { available: true } });
    await refreshOperationalAlerts(app.ctx.prisma);
    expect(await alertsOf('MATERIAL_FALTANTE')).toHaveLength(0);
  });

  it('só avisos internos e nenhuma alteração operacional ou financeira', async () => {
    const s = await k.scenario();
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    await db().serviceOrderMaterial.create({
      data: { serviceOrderId: s.so.id, description: 'Tecido linho', available: false },
    });
    const before = await businessSnapshot();
    await refreshOperationalAlerts(app.ctx.prisma);
    expect(await businessSnapshot()).toBe(before);
    // Os avisos são registros internos (notifications); o módulo não tem nenhum canal externo.
  });

  it('recálculos concorrentes não duplicam avisos', async () => {
    const s = await k.scenario();
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    await Promise.all([1, 2, 3, 4].map(() => refreshOperationalAlerts(app.ctx.prisma)));
    const mine = (await alertsOf('PRAZO_EM_RISCO')).filter((n) => n.userId === s.ids.gestor);
    expect(mine).toHaveLength(1);
  });
});

describe('Fase 4 — painel "Hoje" e ações sugeridas', () => {
  it('mostra serviços em execução, peças prontas, alertas e sugestões explicativas', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const start = await s.tablets['Márcio']!.post(
      `/api/v1/production-tasks/${s.poltronaTask.id}/start`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(start.status).toBe(200);
    await db().serviceOrderMaterial.create({
      data: { serviceOrderId: s.so.id, description: 'Grampo 106', available: false },
    });
    await refreshOperationalAlerts(app.ctx.prisma);
    const before = await businessSnapshot();
    const r = await s.admin.get('/api/v1/management/today');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = r.body as J;
    expect(t.date).toBe(today());
    expect(t.inExecution.map((x: J) => x.taskId)).toContain(s.poltronaTask.id);
    expect(t.readyPieces.map((x: J) => x.itemId)).toContain(s.sofa.id);
    expect(t.present).not.toBeNull();
    expect(t.pendencies).not.toBeNull();
    expect(t.alerts.map((a: J) => a.kind)).toContain('MATERIAL_FALTANTE');
    const mat = t.suggestions.find((x: J) => x.key === 'materiais');
    expect(mat).toMatchObject({ priority: 'ALTA' });
    expect(mat.why.length).toBeGreaterThan(10);
    expect(mat.link).toMatch(/^\/painel\//);
    // Toda sugestão é só um texto com link: nada de ação executável embutida.
    for (const sug of t.suggestions)
      expect(Object.keys(sug).sort()).toEqual(['key', 'link', 'priority', 'title', 'why']);
    // Ler o painel não altera nada.
    expect(await businessSnapshot()).toBe(before);
  });

  it('seções respeitam permissões e nunca expõem valores', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const entregas = await panelUserWith(app, s.admin, 'entregas4', ['entregas.ver']);
    const t = (await entregas.get('/api/v1/management/today')).body as J;
    expect(t.readyPieces.length).toBeGreaterThan(0);
    expect(t.inExecution).toBeNull();
    expect(t.present).toBeNull();
    expect(t.pendencies).toBeNull();
    expect(moneyKeys(t)).toEqual([]);
    const full = (await s.admin.get('/api/v1/management/today')).body;
    expect(moneyKeys(full)).toEqual([]);
    const nobody = await panelUserWith(app, s.admin, 'semnada4', ['clientes.ver']);
    expect((await nobody.get('/api/v1/management/today')).status).toBe(403);
  });
});

describe('Fase 4 — produtividade operacional', () => {
  it('exige producao.planejar, devolve os mesmos indicadores do financeiro e nenhum valor', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const q = `?from=${day(-7)}&to=${today()}`;
    const fin = (await s.admin.get(`/api/v1/finance/productivity${q}`)).body as J;
    const plan = await panelUserWith(app, s.admin, 'planejador4', ['producao.planejar']);
    const op = await plan.get(`/api/v1/production/productivity${q}`);
    expect(op.status, JSON.stringify(op.body)).toBe(200);
    expect(op.body.rows).toEqual(fin.rows);
    expect(moneyKeys(op.body)).toEqual([]);
    expect(op.body.rows.find((r: J) => r.userId === s.ids.ricardo).tasksCompleted).toBe(1);
    // Quem planeja não ganha acesso ao financeiro; quem não planeja não vê a operacional.
    expect((await plan.get(`/api/v1/finance/productivity${q}`)).status).toBe(403);
    const viewer = await panelUserWith(app, s.admin, 'visual4', ['producao.ver']);
    expect((await viewer.get(`/api/v1/production/productivity${q}`)).status).toBe(403);
  });

  it('consulta em lote: o número de consultas não cresce com o número de pessoas', async () => {
    const s = await k.scenario();
    const q = { from: day(-7), to: today() };
    const counted = () => {
      let n = 0;
      const client = db().$extends({
        query: {
          $allOperations: async ({ args, query }) => {
            n++;
            return query(args);
          },
        },
      });
      return { client, n: () => n };
    };
    const a = counted();
    const ra = await productivity(a.client as never, q);
    for (let i = 0; i < 6; i++) await panelUserWith(app, s.admin, `extra${i}`, ['producao.ver']);
    const b = counted();
    const rb = await productivity(b.client as never, q);
    expect(rb.rows.length).toBeGreaterThanOrEqual(ra.rows.length);
    // Antes: ~7 consultas por pessoa. Agora: número fixo, independente da equipe.
    expect(b.n()).toBe(a.n());
    expect(b.n()).toBeLessThan(15);
  });
});
