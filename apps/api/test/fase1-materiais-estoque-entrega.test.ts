import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { panelUserWith } from './commercial-helpers';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
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
import { post, qualityKit } from './quality-helpers';

/** Respostas JSON livres nos testes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 1 — materiais simples na OS, produção sem trava de materiais (interruptor),
 * estoque simples, logística desligável e entrega direta pela OS. Banco descartável, dados
 * fictícios. Cada caso prova uma regra do pedido; nenhum afrouxa as regras anteriores.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const setClock = (hhmm: string) => setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));
const k = qualityKit(() => app);

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
  setClock('09:00');
});
afterEach(() => setAttendanceClock());

const send = (c: Client, method: 'POST' | 'PATCH' | 'PUT', url: string, body: unknown = {}) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const L = (soId: string) => `/api/v1/service-orders/${soId}/material-list`;

async function moduleVersion(admin: Client, key: string) {
  const list = ok<{ key: string; version: number; enabled: boolean }[]>(
    await admin.get('/api/company/modules'),
  );
  return list.find((m) => m.key === key)!;
}
async function setModule(admin: Client, key: string, enabled: boolean) {
  const m = await moduleVersion(admin, key);
  return send(admin, 'PUT', `/api/company/modules/${key}`, { enabled, version: m.version });
}
const ledger = (serviceOrderId: string) =>
  db().serviceOrderCost.findMany({
    where: { serviceOrderId, source: 'MATERIAL_OS' },
    orderBy: { sourceKey: 'asc' },
  });
const informedTotal = async (serviceOrderId: string) =>
  (await ledger(serviceOrderId)).reduce((a, r) => a + r.amountCents, 0);

// ════════════════════════════════════════════════════════════════════ 11.1 materiais da OS
describe('Materiais necessários da OS (lista simples)', () => {
  it('cadastro, edição e as 4 combinações independentes de comprado × na oficina; aviso informativo', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Materiais');
    const combos = [
      {
        description: 'Tecido linho bege',
        quantity: 12,
        unit: 'm',
        purchased: true,
        available: true,
      },
      { description: 'Espuma D33', quantity: 2, unit: 'placa', purchased: true, available: false },
      {
        description: 'Percinta elástica',
        quantity: 10,
        unit: 'm',
        purchased: false,
        available: true,
      },
      {
        description: 'Cola de contato',
        quantity: 1,
        unit: 'un',
        purchased: false,
        available: false,
      },
    ];
    let list: J;
    for (const c of combos) list = ok(await send(admin, 'POST', L(so.id), c), 201);
    expect(list.materials.map((m: J) => [m.description, m.purchased, m.available])).toEqual(
      combos.map((c) => [c.description, c.purchased, c.available]),
    );
    expect(list.summary).toEqual({ total: 4, purchased: 2, available: 2, notAvailable: 2 });
    expect(list.notice).toBe('Existem materiais ainda não disponíveis na oficina.');
    // Nenhum indicador implica o outro: marcar "na oficina" não marca "comprado" e vice-versa.
    const cola = list.materials[3];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${cola.id}`, {
        available: true,
        version: cola.version,
      }),
    );
    expect(list.materials[3]).toMatchObject({ available: true, purchased: false });
    const cola2 = list.materials[3];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${cola2.id}`, {
        purchased: true,
        version: cola2.version,
      }),
    );
    expect(list.materials[3]).toMatchObject({ available: true, purchased: true });
    // Desmarcar funciona dos dois lados, de forma independente.
    const cola3 = list.materials[3];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${cola3.id}`, {
        available: false,
        version: cola3.version,
      }),
    );
    expect(list.materials[3]).toMatchObject({ available: false, purchased: true });
    // Edição de campos (descrição, quantidade, observação) com versão.
    const espuma = list.materials[1];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${espuma.id}`, {
        description: 'Espuma D33 — 5 cm',
        quantity: 3,
        notes: 'Conferir densidade',
        version: espuma.version,
      }),
    );
    expect(list.materials[1]).toMatchObject({
      description: 'Espuma D33 — 5 cm',
      quantity: 3,
      notes: 'Conferir densidade',
    });
    // Versão antiga: conflito (nada muda).
    expect(
      (
        await send(admin, 'PATCH', `${L(so.id)}/${espuma.id}`, {
          available: true,
          version: espuma.version,
        })
      ).status,
    ).toBe(409);
    // Nada formal foi criado: nenhuma compra, reserva, movimento de estoque, conta a pagar.
    expect(await db().purchaseOrder.count()).toBe(0);
    expect(await db().stockReservation.count()).toBe(0);
    expect(await db().stockMovement.count()).toBe(0);
    expect(await db().accountPayable.count()).toBe(0);
    expect(await db().inventoryAdjustment.count()).toBe(0);
    // Auditoria de cada mudança, com valores antes/depois.
    const audits = await db().auditLog.findMany({
      where: { entityType: 'service_order_material' },
    });
    expect(audits.filter((a) => a.action === 'service_order.material_list_added')).toHaveLength(4);
    expect(
      audits.filter((a) => a.action === 'service_order.material_list_updated').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('custo opcional: em branco ≠ zero; só o comprado vira realizado; edição, desmarcar e remover lançam a diferença (sem duplicar)', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Custos');
    // Sem custo e não comprado: previsão sem preço; nada no livro.
    let list = ok(
      await send(admin, 'POST', L(so.id), { description: 'Tecido veludo', quantity: 8, unit: 'm' }),
      201,
    );
    const tecido = list.materials[0];
    expect(tecido.costCents).toBeNull();
    expect(await ledger(so.id)).toHaveLength(0);
    let result = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(result.materials).toMatchObject({
      informedCents: 0,
      informedUnpriced: 0,
      forecastUnpriced: 1,
    });
    // Comprado sem custo: "sem preço" (aviso), nunca zero silencioso.
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${tecido.id}`, {
        purchased: true,
        version: tecido.version,
      }),
    );
    result = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(result.materials).toMatchObject({ informedUnpriced: 1, consumedCents: 0 });
    expect(result.materials.unpricedLines).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join(' ')).toMatch(/sem preço/);
    // Custo informado → realizado no livro (uma linha MATERIAL_OS).
    let t = list.materials[0];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${t.id}`, { costCents: 96000, version: t.version }),
    );
    expect(await informedTotal(so.id)).toBe(96000);
    result = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(result.materials).toMatchObject({
      informedCents: 96000,
      informedUnpriced: 0,
      consumedCents: 96000,
    });
    expect(result.actual.materialsCents).toBe(96000);
    // Leituras repetidas não duplicam (sincronização idempotente).
    for (let i = 0; i < 3; i++) await admin.get(`/api/v1/finance/service-orders/${so.id}`);
    expect(await ledger(so.id)).toHaveLength(1);
    // Correção do custo: lança só a diferença.
    t = list.materials[0];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${t.id}`, { costCents: 100000, version: t.version }),
    );
    expect((await ledger(so.id)).map((r) => r.amountCents)).toEqual([96000, 4000]);
    // Desmarcar "comprado": o custo volta a ser só previsão (estorno do realizado).
    t = list.materials[0];
    list = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${t.id}`, { purchased: false, version: t.version }),
    );
    expect(await informedTotal(so.id)).toBe(0);
    result = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(result.materials.forecastCents).toBeGreaterThanOrEqual(100000);
    // Custo zero explícito é aceito e é diferente de "não informado".
    const brinde = ok(
      await send(admin, 'POST', L(so.id), {
        description: 'Linha (sobra)',
        purchased: true,
        costCents: 0,
      }),
      201,
    );
    expect(brinde.materials[1].costCents).toBe(0);
    result = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(result.materials.informedUnpriced).toBe(0);
    // Remoção lógica: sai da lista, custo realizado estornado, linha preservada no banco.
    t = brinde.materials[0];
    const again = ok(
      await send(admin, 'PATCH', `${L(so.id)}/${t.id}`, { purchased: true, version: t.version }),
    );
    expect(await informedTotal(so.id)).toBe(100000);
    const rm = again.materials[0];
    const removed = ok(
      await send(admin, 'POST', `${L(so.id)}/${rm.id}/remove`, { version: rm.version }),
    );
    expect(removed.materials.map((m: J) => m.description)).toEqual(['Linha (sobra)']);
    expect(await informedTotal(so.id)).toBe(0);
    const kept = await db().serviceOrderMaterial.findUniqueOrThrow({ where: { id: rm.id } });
    expect(kept.removedAt).not.toBeNull();
    expect(kept.removedById).not.toBeNull();
    // Repetir a remoção não faz nada (idempotente).
    ok(await send(admin, 'POST', `${L(so.id)}/${rm.id}/remove`, { version: rm.version }));
    expect(await informedTotal(so.id)).toBe(0);
    // O livro é imutável e nenhum lançamento virou conta a pagar ou pagamento.
    await expect(
      db().serviceOrderCost.updateMany({ where: { serviceOrderId: so.id }, data: { note: 'x' } }),
    ).rejects.toThrow();
    expect(await db().accountPayable.count()).toBe(0);
    expect(await db().payablePayment.count()).toBe(0);
  });

  it('custo no relatório de custos e aviso de fontes misturadas (formal × informado)', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Relatório');
    ok(
      await send(admin, 'POST', L(so.id), {
        description: 'Cola',
        purchased: true,
        costCents: 4500,
      }),
      201,
    );
    // Um custo formal de outra origem (lançamento manual de material) convive: ambos contam.
    ok(
      await send(admin, 'POST', '/api/v1/finance/costs', {
        serviceOrderId: so.id,
        category: 'MATERIAL',
        description: 'Grampos',
        amountCents: 1200,
        reason: 'Compra avulsa registrada no financeiro',
      }),
      201,
    );
    const result = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(result.materials.consumedCents).toBe(5700);
    // Lançamento manual não é "formal de compra": sem aviso de mistura.
    expect(result.materials.mixedSources).toBe(false);
    // Compra formal registrada no livro (origem de compra exclusiva) + informado → aviso.
    await db().serviceOrderCost.create({
      data: {
        serviceOrderId: so.id,
        category: 'MATERIAL',
        source: 'COMPRA_EXCLUSIVA',
        sourceKey: `receipt_line:teste-${so.id}`,
        description: 'Cola (pedido formal)',
        amountCents: 4500,
        occurredAt: new Date(),
      },
    });
    const mixed = ok(await admin.get(`/api/v1/finance/service-orders/${so.id}`));
    expect(mixed.materials.mixedSources).toBe(true);
    expect(mixed.warnings.join(' ')).toMatch(/nos dois/);
    // Relatório de custos agrupa a origem nova (o custo não some dos relatórios).
    const report = ok(
      await admin.get(`/api/v1/finance/reports/custos?from=${today()}&to=${today()}`),
    );
    expect(JSON.stringify(report)).toMatch(/MATERIAL_OS/);
    const csv = await admin.get(
      `/api/v1/finance/reports/custos?format=csv&from=${today()}&to=${today()}`,
    );
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toMatch(/MATERIAL_OS/);
  });

  it('permissões: tablet não acessa; quem não vê o financeiro não vê nem altera custo', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Permissões');
    ok(
      await send(admin, 'POST', L(so.id), {
        description: 'Espuma D28',
        purchased: true,
        costCents: 8000,
      }),
      201,
    );
    const coord = await panelUserWith(app, admin, 'coordenador', ['os.ver', 'os.gerenciar']);
    const view = ok(await coord.get(L(so.id)));
    expect(view.canSeeCosts).toBe(false);
    expect(view.materials[0]).not.toHaveProperty('costCents');
    // Pode marcar comprado/disponível…
    ok(
      await send(coord, 'PATCH', `${L(so.id)}/${view.materials[0].id}`, {
        available: true,
        version: view.materials[0].version,
      }),
    );
    // …mas não informar nem alterar custo.
    expect(
      (await send(coord, 'POST', L(so.id), { description: 'Grampo', costCents: 100 })).status,
    ).toBe(403);
    const v2 = ok(await coord.get(L(so.id)));
    expect(
      (
        await send(coord, 'PATCH', `${L(so.id)}/${v2.materials[0].id}`, {
          costCents: 1,
          version: v2.materials[0].version,
        })
      ).status,
    ).toBe(403);
    // Só leitura de OS: não altera.
    const reader = await panelUserWith(app, admin, 'leitor', ['os.ver']);
    expect((await send(reader, 'POST', L(so.id), { description: 'Linha' })).status).toBe(403);
    // OS cancelada: só consulta.
    const current = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    ok(
      await send(admin, 'POST', `/api/v1/service-orders/${so.id}/cancel`, {
        reason: 'Cliente desistiu',
        version: current.version,
      }),
    );
    expect((await send(admin, 'POST', L(so.id), { description: 'Linha' })).status).toBe(422);
    // O histórico continua legível.
    expect(ok(await admin.get(L(so.id))).materials).toHaveLength(1);
  });

  it('compatibilidade: necessidades antigas e compras formais continuam como estavam', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await serviceOrderWith(admin, 'missing');
    const before = await db().materialRequirement.count();
    ok(await send(admin, 'POST', L(so.id), { description: 'Tecido novo (lista simples)' }), 201);
    expect(await db().materialRequirement.count()).toBe(before);
    expect(reqs.length).toBeGreaterThan(0);
    const readiness = ok(await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`));
    expect(readiness.state).not.toBe('COMPLETO');
  });
});

// ════════════════════════════════════════════════════════════════════ 11.2 produção
async function publishedSofa(materials: 'none' | 'missing' | 'complete') {
  const admin = await loginAdmin(app);
  const { so } = await serviceOrderWith(admin, materials);
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
  return { admin, so, t };
}
const taskOf = async (admin: Client, id: string) =>
  ok(await admin.get(`/api/v1/production-tasks/${id}`));

describe('Produção sem trava de materiais (interruptor "materiais")', () => {
  it('padrão LIGADO = comportamento anterior: sem levantamento, corte bloqueado por MATERIAIS', async () => {
    const { t } = await publishedSofa('none');
    expect(t('CORTE_TECIDO')).toMatchObject({ status: 'BLOQUEADA', blockers: ['MATERIAIS'] });
  });

  it('DESLIGADO: OS sem materiais e com materiais pendentes iniciam; pausa, retomada e conclusão; religar volta a travar o que aguarda', async () => {
    const { admin, so, t } = await publishedSofa('missing');
    const corte = t('CORTE_TECIDO');
    expect(corte.blockers).toContain('MATERIAIS');
    // Lista simples com material pendente (não disponível): só aviso.
    ok(await send(admin, 'POST', L(so.id), { description: 'Tecido', available: false }), 201);
    ok(await setModule(admin, 'materiais', false));
    // A troca reavalia na hora: MATERIAIS sai; dependências e horário continuam valendo.
    const released = await taskOf(admin, corte.id);
    expect(released.blockers).not.toContain('MATERIAIS');
    expect(released.status).toBe('LIBERADA');
    const costura = await taskOf(admin, t('COSTURA').id);
    expect(costura.blockers).toContain('DEPENDENCIAS');
    expect(costura.blockers).not.toContain('MATERIAIS');
    // Execução completa pelo tablet (responsável, início, pausa, retomada, conclusão).
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    expect((await act(ricardo, corte.id, 'start')).status).toBe(200);
    const paused = await act(ricardo, corte.id, 'pause', { reason: 'AGUARDANDO_ORIENTACAO' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect((await act(ricardo, corte.id, 'resume')).status).toBe(200);
    expect((await act(ricardo, corte.id, 'complete', { note: 'Corte feito' })).status).toBe(200);
    const done = await taskOf(admin, corte.id);
    expect(done.status).toBe('CONCLUIDA');
    // O tablet mostra a disponibilidade da lista simples, sem custos.
    const detail = ok(await ricardo.get(`/api/v1/production-tasks/${t('COSTURA').id}`));
    expect(JSON.stringify(detail)).not.toMatch(/costCents/);
    // Religar: a tarefa que ainda aguarda volta a ser travada por material (a dependência já foi
    // cumprida pelo corte concluído); a tarefa concluída não muda.
    ok(await setModule(admin, 'materiais', true));
    expect((await taskOf(admin, t('COSTURA').id)).blockers).toEqual(['MATERIAIS']);
    expect((await taskOf(admin, corte.id)).status).toBe('CONCLUIDA');
  });

  it('DESLIGADO: outras regras continuam — tarefa de outra pessoa não inicia; bloqueio manual segue valendo', async () => {
    const { admin, t } = await publishedSofa('none');
    ok(await setModule(admin, 'materiais', false));
    const corte = await taskOf(admin, t('CORTE_TECIDO').id);
    expect(corte.status).toBe('LIBERADA');
    const marcio = await tabletOf(app, admin, 'Márcio', '736152');
    expect((await act(marcio, corte.id, 'start')).status).not.toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════ 11.3 estoque simples
describe('Estoque simples (independente da OS)', () => {
  const I = '/api/v1/inventory';
  it('categorias personalizadas, materiais, rolos, ajustes auditados, arquivamento e exclusão segura', async () => {
    const admin = await loginAdmin(app);
    let cats = ok(await send(admin, 'POST', `${I}/categories`, { name: 'Tecidos' }), 201);
    cats = ok(await send(admin, 'POST', `${I}/categories`, { name: 'Colas' }), 201);
    expect(cats.map((c: J) => c.name).sort()).toEqual(['Colas', 'Tecidos']);
    // Nome repetido (sem diferenciar maiúsculas): conflito.
    expect((await send(admin, 'POST', `${I}/categories`, { name: 'tecidos' })).status).toBe(409);
    const tecidos = cats.find((c: J) => c.name === 'Tecidos');
    const item = ok(
      await send(admin, 'POST', `${I}/items`, {
        name: 'Linho bege',
        categoryId: tecidos.id,
        unit: 'm',
        quantity: 0,
        referenceCostCents: 8000,
        location: 'Prateleira A',
      }),
      201,
    );
    expect(item).toMatchObject({
      name: 'Linho bege',
      categoryName: 'Tecidos',
      quantity: 0,
      referenceCostCents: 8000,
      deletable: true,
    });
    // Rolos com identificação própria e metragem manual.
    let withRolls = ok(
      await send(admin, 'POST', `${I}/items/${item.id}/rolls`, {
        code: 'R-001',
        color: 'Bege',
        meters: 30,
      }),
      201,
    );
    withRolls = ok(
      await send(admin, 'POST', `${I}/items/${item.id}/rolls`, {
        code: 'R-002',
        color: 'Bege',
        meters: 12.5,
      }),
      201,
    );
    expect(withRolls.rolls.map((r: J) => [r.code, r.meters])).toEqual([
      ['R-001', 30],
      ['R-002', 12.5],
    ]);
    expect(withRolls.rollMeters).toBe(42.5);
    expect(
      (await send(admin, 'POST', `${I}/items/${item.id}/rolls`, { code: 'r-001' })).status,
    ).toBe(409);
    // Ajuste do rolo: anterior × novo, quem, quando, motivo (imutável).
    const r1 = withRolls.rolls[0];
    const adj = ok(
      await send(admin, 'POST', `${I}/rolls/${r1.id}/adjust`, {
        newQuantity: 22,
        reason: 'Corte para OS',
        version: r1.version,
      }),
    );
    expect(adj.rolls[0].meters).toBe(22);
    const history = ok(await admin.get(`${I}/adjustments?rollId=${r1.id}`));
    expect(history[0]).toMatchObject({
      previousQuantity: 30,
      newQuantity: 22,
      reason: 'Corte para OS',
    });
    expect(history[0].actor).not.toBeNull();
    await expect(db().inventoryAdjustment.updateMany({ data: { reason: 'x' } })).rejects.toThrow();
    // Ajuste do material.
    const fresh = ok(await admin.get(`${I}/items/${item.id}`));
    const adjItem = ok(
      await send(admin, 'POST', `${I}/items/${item.id}/adjust`, {
        newQuantity: 5,
        version: fresh.version,
      }),
    );
    expect(adjItem.quantity).toBe(5);
    // A quantidade não muda pela edição do cadastro (só por ajuste).
    const edited = ok(
      await send(admin, 'PATCH', `${I}/items/${item.id}`, {
        location: 'Prateleira B',
        version: adjItem.version,
      }),
    );
    expect(edited).toMatchObject({ location: 'Prateleira B', quantity: 5 });
    // Com histórico: não exclui, só arquiva (e reativa).
    expect(edited.deletable).toBe(false);
    expect(
      (await send(admin, 'POST', `${I}/items/${item.id}/delete`, { version: edited.version }))
        .status,
    ).toBe(422);
    expect(
      (await send(admin, 'POST', `${I}/rolls/${r1.id}/delete`, { version: adj.rolls[0].version }))
        .status,
    ).toBe(422);
    const archived = ok(
      await send(admin, 'POST', `${I}/items/${item.id}/archive`, {
        archived: true,
        version: edited.version,
      }),
    );
    expect(archived.archived).toBe(true);
    expect(ok(await admin.get(`${I}/items`)).map((x: J) => x.id)).not.toContain(item.id);
    expect(ok(await admin.get(`${I}/items?archived=true`)).map((x: J) => x.id)).toContain(item.id);
    ok(
      await send(admin, 'POST', `${I}/items/${item.id}/archive`, {
        archived: false,
        version: archived.version,
      }),
    );
    // Rolo sem ajuste: pode excluir.
    const r2 = (ok(await admin.get(`${I}/items/${item.id}`)) as J).rolls[1];
    expect(r2.deletable).toBe(true);
    ok(await send(admin, 'POST', `${I}/rolls/${r2.id}/delete`, { version: r2.version }));
    // Categoria com material: não exclui; categoria vazia: exclui.
    expect(
      (
        await send(admin, 'POST', `${I}/categories/${tecidos.id}/delete`, {
          version: tecidos.version,
        })
      ).status,
    ).toBe(422);
    const colas = cats.find((c: J) => c.name === 'Colas');
    ok(await send(admin, 'POST', `${I}/categories/${colas.id}/delete`, { version: colas.version }));
    // Material sem histórico: exclui.
    const tmp = ok(
      await send(admin, 'POST', `${I}/items`, { name: 'Grampo 10mm', unit: 'cx' }),
      201,
    );
    ok(await send(admin, 'POST', `${I}/items/${tmp.id}/delete`, { version: tmp.version }));
    expect(await db().inventoryItem.count({ where: { id: tmp.id } })).toBe(0);
  });

  it('independência: marcar comprado/na oficina na OS não move o estoque; uso em OS impede exclusão', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Estoque');
    const item = ok(
      await send(admin, 'POST', '/api/v1/inventory/items', {
        name: 'Espuma D33',
        unit: 'placa',
        quantity: 4,
      }),
      201,
    );
    const list = ok(
      await send(admin, 'POST', L(so.id), {
        description: 'Espuma D33',
        inventoryItemId: item.id,
        quantity: 2,
      }),
      201,
    );
    expect(list.materials[0].inventoryItemName).toBe('Espuma D33');
    const m = list.materials[0];
    ok(
      await send(admin, 'PATCH', `${L(so.id)}/${m.id}`, {
        available: true,
        purchased: true,
        version: m.version,
      }),
    );
    const after = ok(await admin.get(`/api/v1/inventory/items/${item.id}`));
    expect(after.quantity).toBe(4);
    expect(await db().inventoryAdjustment.count()).toBe(0);
    expect(after.deletable).toBe(false);
    expect(
      (
        await send(admin, 'POST', `/api/v1/inventory/items/${item.id}/delete`, {
          version: after.version,
        })
      ).status,
    ).toBe(422);
    // Arquivado não pode ser usado como referência nova.
    const arch = ok(
      await send(admin, 'POST', `/api/v1/inventory/items/${item.id}/archive`, {
        archived: true,
        version: after.version,
      }),
    );
    expect(arch.archived).toBe(true);
    expect(
      (await send(admin, 'POST', L(so.id), { description: 'Outra', inventoryItemId: item.id }))
        .status,
    ).toBe(422);
  });

  it('permissões: só estoque.gerenciar altera; custo de referência só com financeiro', async () => {
    const admin = await loginAdmin(app);
    const viewer = await panelUserWith(app, admin, 'estoquista', ['estoque.ver']);
    expect(
      (await send(viewer, 'POST', '/api/v1/inventory/items', { name: 'Cola', unit: 'un' })).status,
    ).toBe(403);
    const keeper = await panelUserWith(app, admin, 'almoxarife', [
      'estoque.ver',
      'estoque.gerenciar',
    ]);
    expect(
      (
        await send(keeper, 'POST', '/api/v1/inventory/items', {
          name: 'Cola',
          unit: 'un',
          referenceCostCents: 100,
        })
      ).status,
    ).toBe(403);
    const it2 = ok(
      await send(keeper, 'POST', '/api/v1/inventory/items', { name: 'Cola', unit: 'un' }),
      201,
    );
    expect(it2).not.toHaveProperty('referenceCostCents');
  });
});

// ════════════════════════════════════════════════════════════════════ 11.4 logística
describe('Logística desligável e reversível', () => {
  it('desligar é recusado com entrega em andamento; desligada recusa novas entregas e retiradas; religar volta tudo; histórico preservado', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = ok(await k.schedule(s), 201);
    // Em andamento: não desliga (nada fica pela metade) e diz qual entrega impede.
    const refused = await setModule(s.admin, 'logistica', false);
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(new RegExp(d.code));
    // Cancela a entrega pela logística; agora desliga.
    ok(
      await post(s.admin, `/api/v1/deliveries/${d.id}/cancel`, {
        reason: 'Cliente vem buscar',
        version: d.version,
      }),
    );
    ok(await setModule(s.admin, 'logistica', false));
    expect(ok(await s.admin.get('/api/v1/modules')).logistica).toBe(false);
    // Desligada: nova entrega e nova retirada recusadas no servidor.
    const blocked = await k.schedule(s);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MODULE_DISABLED');
    // Histórico preservado e legível.
    const old = ok(await s.admin.get(`/api/v1/deliveries/${d.id}`));
    expect(old.status).toBe('CANCELADA');
    // A Central orienta a entrega direta pela OS.
    const central = ok(await s.admin.get('/api/v1/attention'));
    const ready = central.items.find((i: J) => i.key === `LOGISTICA:pronta:${s.sofa.id}`);
    expect(ready.nextActions[0]).toMatch(/marcar como entregue na OS/i);
    // Religar: a operação volta como antes.
    ok(await setModule(s.admin, 'logistica', true));
    ok(await k.schedule(s), 201);
  });

  it('padrão: instalação existente continua com a logística ligada (nada muda sem decisão do gestor)', async () => {
    const admin = await loginAdmin(app);
    expect(ok(await admin.get('/api/v1/modules'))).toMatchObject({
      logistica: true,
      materiais: true,
      ajuda: true,
      embalagem: true,
    });
    expect(await db().moduleSetting.count()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════ 11.5 entrega direta
describe('Entrega direta pela OS ("Marcar como entregue")', () => {
  const D = (soId: string) => `/api/v1/service-orders/${soId}/deliver`;
  const E = (soId: string) => `/api/v1/service-orders/${soId}/direct-delivery`;

  it('não elegível: qualidade pendente; qualidade reprovada; correção aberta — nada é gravado', async () => {
    const s = await k.scenario();
    // Produção concluída, inspeção ainda não feita.
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    let e = ok(await s.admin.get(E(s.so.id)));
    expect(e.eligible).toBe(false);
    expect(JSON.stringify(e.blocks)).toMatch(/inspe/i);
    const r1 = await post(s.admin, D(s.so.id));
    expect(r1.status).toBe(422);
    // Reprovada: continua não elegível (a qualidade nunca é pulada).
    const open = (await k.openOf(s.sofa.id))!;
    const i = await k.checkAll(s.tablets.Thiago!, open.id, 'Costura torta');
    ok(
      await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/reject`, {
        reason: 'Refazer costura',
        version: i.version,
      }),
    );
    e = ok(await s.admin.get(E(s.so.id)));
    expect(e.eligible).toBe(false);
    expect((await post(s.admin, D(s.so.id))).status).toBe(422);
    expect(await db().delivery.count()).toBe(0);
    expect(await k.stage(s.sofa.id)).not.toBe('ENTREGUE');
  });

  it('elegível: entrega registrada (data, quem, origem DIRETA), etapa ENTREGUE, histórico, sem custo de viagem nem pendência no fechamento; cobrança "na entrega" vence', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    // Saldo com vencimento na entrega.
    const order = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const rec = ok(
      await post(s.admin, '/api/v1/finance/receivables', {
        orderId: order.orderId,
        description: 'Saldo na entrega',
        amountCents: 150000,
        dueTrigger: 'ENTREGA',
        expectedMethod: 'PIX',
      }),
      201,
    );
    expect(rec.effectiveDueDate).toBeNull();
    const e = ok(await s.admin.get(E(s.so.id)));
    expect(e).toMatchObject({ eligible: true, delivered: false, blocks: [] });
    expect(e.pendingItems).toHaveLength(2);

    const r = ok(await post(s.admin, D(s.so.id), { note: 'Cliente buscou na oficina' }));
    expect(r).toMatchObject({ created: true, deliveredItems: 2 });
    expect(r.eligibility).toMatchObject({ delivered: true, eligible: false });
    expect(r.eligibility.lastDelivery).toMatchObject({ origin: 'DIRETA', code: r.deliveryCode });
    expect(r.eligibility.lastDelivery.confirmedBy.id).toBe(s.ids.gestor);
    // Registro: entrega concluída, origem DIRETA, sem responsável de transporte.
    const d = await db().delivery.findUniqueOrThrow({
      where: { id: r.deliveryId },
      include: { items: true, events: true },
    });
    expect(d).toMatchObject({
      origin: 'DIRETA',
      status: 'CONCLUIDA',
      responsibleUserId: null,
      createdById: s.ids.gestor,
    });
    expect(d.completedAt).not.toBeNull();
    expect(d.items.every((i) => i.status === 'ENTREGUE' && i.deliveredAt)).toBe(true);
    expect(d.events.map((x) => x.kind)).toEqual(['ENTREGA_DIRETA']);
    expect(d.events[0]!.note).toMatch(/diretamente pela OS/);
    // Etapa das peças e estado operacional.
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    expect(await k.stage(s.poltronas.id)).toBe('ENTREGUE');
    const state = ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/operational-state`));
    expect(state.state).toBe('ENTREGUE');
    // Financeiro: a cobrança "na entrega" vence hoje (mesma regra da entrega pela logística).
    const recAfter = ok(await s.admin.get(`/api/v1/finance/receivables/${rec.id}`));
    expect(recAfter.effectiveDueDate).toBe(today());
    // Resultado da OS: concluída.
    const result = ok(await s.admin.get(`/api/v1/finance/service-orders/${s.so.id}`));
    expect(result.delivered ?? result.completion?.delivered ?? true).toBeTruthy();
    // Sem viagem: nenhum custo de frete, nenhuma pendência de "custo não informado".
    expect(await db().logisticsCost.count()).toBe(0);
    const trip = await post(s.admin, '/api/v1/finance/trip-costs', {
      deliveryId: r.deliveryId,
      amountCents: 5000,
      payeeUserId: s.ids.andre,
    });
    expect(trip.status).not.toBe(200);
    expect(trip.status).not.toBe(201);
    // Fora do roteiro do dia.
    const route = ok(await s.admin.get(`/api/v1/logistics/route?date=${today()}`));
    expect(JSON.stringify(route)).not.toMatch(new RegExp(r.deliveryCode));
    // Auditoria e evento em tempo real.
    expect(
      await db().auditLog.count({
        where: { action: 'delivery.direct_completed', entityId: r.deliveryId },
      }),
    ).toBe(1);
    expect(
      await db().domainEvent.count({
        where: { type: 'delivery.updated', aggregateId: r.deliveryId },
      }),
    ).toBe(1);
    expect(
      await db().domainEvent.count({
        where: { type: 'item.stage_changed', aggregateId: s.sofa.id },
      }),
    ).toBeGreaterThan(0);
  });

  it('idempotência e concorrência: dois cliques, requisições simultâneas e repetição após timeout geram UMA entrega', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const key = idemKey();
    // Simultâneas (chaves diferentes = dois cliques distintos).
    const [a, b] = await Promise.all([post(s.admin, D(s.so.id)), post(s.admin, D(s.so.id))]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    // Repetição com a mesma chave (timeout no cliente): mesma resposta, nada novo.
    const c1 = ok(await post(s.admin, D(s.so.id), {}, key));
    const c2 = ok(await post(s.admin, D(s.so.id), {}, key));
    expect(c2).toEqual(c1);
    expect(c1.created).toBe(false);
    expect(await db().delivery.count({ where: { origin: 'DIRETA' } })).toBe(1);
    expect(await db().deliveryItem.count()).toBe(2);
    expect(await db().deliveryEvent.count({ where: { kind: 'ENTREGA_DIRETA' } })).toBe(1);
    expect(await db().auditLog.count({ where: { action: 'delivery.direct_completed' } })).toBe(1);
    expect(await db().logisticsCost.count()).toBe(0);
    expect(await db().accountPayable.count()).toBe(0);
  });

  it('peça já numa entrega agendada pela logística: a OS indica e recusa (sem duas entregas da mesma peça)', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const d = ok(await k.schedule(s), 201);
    const e = ok(await s.admin.get(E(s.so.id)));
    expect(e.eligible).toBe(false);
    expect(JSON.stringify(e.blocks)).toMatch(new RegExp(d.code));
    expect((await post(s.admin, D(s.so.id))).status).toBe(422);
    expect(await db().delivery.count()).toBe(1);
  });

  it('permissões: só quem gerencia entregas confirma; tablet não confirma', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const viewer = await panelUserWith(app, s.admin, 'vendedor', ['os.ver']);
    expect((await viewer.get(E(s.so.id))).status).toBe(200);
    expect((await post(viewer, D(s.so.id))).status).toBe(403);
    expect((await post(s.tablets.Ricardo!, D(s.so.id))).status).toBe(403);
    expect(await db().delivery.count()).toBe(0);
  });

  it('com a logística desligada a OS continua entregável pela ação direta', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    ok(await setModule(s.admin, 'logistica', false));
    const r = ok(await post(s.admin, D(s.so.id)));
    expect(r.created).toBe(true);
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
  });
});
