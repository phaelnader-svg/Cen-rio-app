import { mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { panelUserWith } from './commercial-helpers';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { today, uploadPhoto } from './production-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok as okLine,
  receive,
} from './purchasing-helpers';
import { post, qualityKit } from './quality-helpers';

/** Respostas JSON livres nos testes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 1 — revisão final de integridade financeira (banco descartável, dados
 * fictícios):
 *  A. custo de material quando coexistem compra formal e custo informado na lista da OS:
 *     conciliação EXPLÍCITA (vincular ao registro formal ou marcar como distinto), nunca deduzida
 *     por valores iguais; lançamentos existentes nunca mudam (só compensações novas);
 *  B. entrega direta: mesmos efeitos financeiros da entrega pela logística, sem duplicar cobrança
 *     nem mão de obra, sem tocar peças já entregues.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
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
  setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ));
});
afterEach(() => setAttendanceClock());

const send = (c: Client, method: 'POST' | 'PATCH', url: string, body: unknown = {}) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const L = (soId: string) => `/api/v1/service-orders/${soId}/material-list`;
const R = (soId: string, id: string) => `${L(soId)}/${id}/reconcile`;
const result = async (c: Client, soId: string) =>
  ok(await c.get(`/api/v1/finance/service-orders/${soId}`));
/** Fotografia imutável do livro de custos da OS (para provar que nada existente muda). */
const ledger = (soId: string) =>
  db().serviceOrderCost.findMany({
    where: { serviceOrderId: soId },
    orderBy: [{ createdAt: 'asc' }, { sourceKey: 'asc' }],
    select: { id: true, source: true, sourceKey: true, amountCents: true, note: true },
  });

/**
 * OS com tecido comprado formalmente (12 m × R$ 45,00 = R$ 540,00) e recebido. `need` > 12 deixa
 * saldo da necessidade aprovada para outro pedido.
 */
async function formalFabric(admin: Client, name: string, need = 12) {
  const supplier = await createSupplier(admin, `Fornecedor ${name}`);
  const a = await approvedNeeds(admin, name, (s) => [linen(s.items[0].id, need)]);
  const po = await confirmedFabricPurchase(admin, supplier.id, { id: a.reqs[0]!.id, quantity: 12 });
  const item = po.items[0];
  expect((await receive(admin, po.id, [okLine(item.id, 12)])).status).toBe(201);
  // Leitura do resultado sincroniza o livro (compra recebida → COMPRA_EXCLUSIVA).
  await result(admin, a.so.id);
  const entry = await db().serviceOrderCost.findFirstOrThrow({
    where: { serviceOrderId: a.so.id, source: 'COMPRA_EXCLUSIVA' },
  });
  expect(entry.amountCents).toBe(54000);
  return { so: a.so, po, item, entry, supplier, req: a.reqs[0]! };
}

describe('A. Conciliação do custo de material (formal × informado na OS)', () => {
  it('valores iguais NÃO são presumidos iguais: a linha fica pendente, continua contando e o risco aparece', async () => {
    const admin = await loginAdmin(app);
    const f = await formalFabric(admin, 'Cliente Conciliação Pendente');
    const list = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Linho bege',
        purchased: true,
        costCents: 54000,
      }),
      201,
    );
    const line = list.materials[0];
    expect(line.reconciliation).toMatchObject({ status: 'PENDENTE', linked: null });
    expect(list.pendingReconciliation).toEqual({ lines: 1, realizedCents: 54000 });
    // Os dois registros formais aparecem para escolha (o item de compra e o lançamento recebido).
    expect(list.formalRecords.map((r: J) => [r.kind, r.amountCents]).sort()).toEqual([
      ['COMPRA', 54000],
      ['LANCAMENTO', 54000],
    ]);
    const r = await result(admin, f.so.id);
    // Nada some: o formal e o informado contam até alguém decidir.
    expect(r.materials.consumedCents).toBe(108000);
    expect(r.materials).toMatchObject({
      mixedSources: true,
      pendingReconciliationLines: 1,
      pendingReconciliationCents: 54000,
    });
    expect(r.warnings.join(' ')).toMatch(/Conciliação pendente: 1 material/);
    expect(r.warnings.join(' ')).toMatch(/R\$\s?540,00/);
    // Linha sem custo informado não entra na conciliação (não há o que duplicar).
    const noCost = ok(await send(admin, 'POST', L(f.so.id), { description: 'Grampos' }), 201);
    expect(noCost.materials[1].reconciliation.status).toBe('NAO_SE_APLICA');
    expect(noCost.pendingReconciliation.lines).toBe(1);
  });

  it('vincular à compra formal: o informado deixa de contar por compensação; nada existente muda; repetir não grava; desfazer volta a contar', async () => {
    const admin = await loginAdmin(app);
    const f = await formalFabric(admin, 'Cliente Conciliação Vínculo');
    const line = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Linho bege',
        purchased: true,
        costCents: 54000,
      }),
      201,
    ).materials[0];
    const before = await ledger(f.so.id);
    expect(before.map((l) => [l.source, l.amountCents])).toEqual([
      ['COMPRA_EXCLUSIVA', 54000],
      ['MATERIAL_OS', 54000],
    ]);

    const linked = ok(
      await send(admin, 'POST', R(f.so.id, line.id), {
        mode: 'VINCULADO',
        purchaseItemId: f.item.id,
        version: line.version,
      }),
    );
    const l1 = linked.materials[0];
    expect(l1.reconciliation).toMatchObject({ status: 'VINCULADO' });
    expect(l1.reconciliation.linked).toMatchObject({ kind: 'COMPRA', id: f.item.id });
    expect(l1.reconciliation.reconciledBy.displayName).toBeTruthy();
    expect(l1.costCents).toBe(54000); // o valor informado continua visível (histórico)
    expect(linked.pendingReconciliation).toEqual({ lines: 0, realizedCents: 0 });
    // Livro: os lançamentos anteriores ficam idênticos; entra UMA compensação de −540,00.
    const after = await ledger(f.so.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((l) => [l.source, l.amountCents])).toEqual([
      ['MATERIAL_OS', -54000],
    ]);
    expect(after.at(-1)!.note).toMatch(/Vinculado ao custo formal/);
    let r = await result(admin, f.so.id);
    expect(r.materials.consumedCents).toBe(54000);
    expect(r.materials.informedCents).toBe(0);
    expect(r.materials.mixedSources).toBe(false);
    // Previsão também não soma o vinculado duas vezes.
    expect(r.materials.forecastCents).toBeLessThanOrEqual(54000);
    expect(r.warnings.join(' ')).not.toMatch(/Conciliação pendente/);
    // Repetir a mesma decisão: nada novo (nem livro, nem versão).
    const again = ok(
      await send(admin, 'POST', R(f.so.id, line.id), {
        mode: 'VINCULADO',
        purchaseItemId: f.item.id,
        version: l1.version,
      }),
    );
    expect(again.materials[0].version).toBe(l1.version);
    expect(await ledger(f.so.id)).toHaveLength(after.length);
    // Editar o custo de uma linha vinculada não volta a contar.
    const edited = ok(
      await send(admin, 'PATCH', `${L(f.so.id)}/${line.id}`, {
        costCents: 60000,
        version: l1.version,
      }),
    );
    expect(await ledger(f.so.id)).toHaveLength(after.length);
    // Desfazer: volta a pendente e o informado volta a contar (nova compensação, nada apagado).
    const undone = ok(
      await send(admin, 'POST', R(f.so.id, line.id), {
        mode: null,
        version: edited.materials[0].version,
      }),
    );
    expect(undone.materials[0].reconciliation.status).toBe('PENDENTE');
    const final = await ledger(f.so.id);
    expect(final.slice(0, after.length)).toEqual(after);
    expect(final.at(-1)).toMatchObject({ source: 'MATERIAL_OS', amountCents: 60000 });
    expect(final.at(-1)!.note).toMatch(/volta a contar/);
    r = await result(admin, f.so.id);
    expect(r.materials.consumedCents).toBe(54000 + 60000);
    expect(r.materials.pendingReconciliationCents).toBe(60000);
    // Auditoria de cada decisão (vincular e desfazer; a repetição não audita).
    expect(
      await db().auditLog.count({
        where: { action: 'service_order.material_list_reconciled', entityId: line.id },
      }),
    ).toBe(2);
  });

  it('marcar como distinto: continua contando, sem aviso; vincular ao lançamento formal do livro também vale', async () => {
    const admin = await loginAdmin(app);
    const f = await formalFabric(admin, 'Cliente Conciliação Distinto');
    const list = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Espuma extra',
        purchased: true,
        costCents: 12000,
      }),
      201,
    );
    const a = list.materials[0];
    const distinct = ok(
      await send(admin, 'POST', R(f.so.id, a.id), { mode: 'DISTINTO', version: a.version }),
    );
    expect(distinct.materials[0].reconciliation).toMatchObject({
      status: 'DISTINTO',
      linked: null,
    });
    let r = await result(admin, f.so.id);
    expect(r.materials.consumedCents).toBe(54000 + 12000);
    expect(r.materials.mixedSources).toBe(false);
    // Segunda linha: o mesmo tecido, vinculado ao LANÇAMENTO formal (recebimento).
    const b = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Linho (anotado na OS)',
        purchased: true,
        costCents: 54000,
      }),
      201,
    ).materials[1];
    ok(
      await send(admin, 'POST', R(f.so.id, b.id), {
        mode: 'VINCULADO',
        costId: f.entry.id,
        version: b.version,
      }),
    );
    r = await result(admin, f.so.id);
    expect(r.materials.consumedCents).toBe(54000 + 12000);
    expect(r.materials.pendingReconciliationLines).toBe(0);
  });

  it('vínculo com compra que deixa de existir (pedido cancelado): o custo informado volta a contar sozinho', async () => {
    const admin = await loginAdmin(app);
    const f = await formalFabric(admin, 'Cliente Conciliação Cancelada', 14);
    // Outro pedido exclusivo para a mesma necessidade, confirmado e ainda não recebido.
    const po2 = await createPurchase(admin, {
      supplierId: f.supplier.id,
      expectedDate: '2030-01-10',
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: f.req.id, quantity: 2 }],
          quantity: 2,
          unitPriceCents: 4000,
        },
      ],
    });
    expect(po2.status, JSON.stringify(po2.body)).toBe(201);
    const c2 = ok(await confirmPurchase(admin, po2.body));
    const line = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Linho complementar',
        purchased: true,
        costCents: 8000,
      }),
      201,
    ).materials[0];
    ok(
      await send(admin, 'POST', R(f.so.id, line.id), {
        mode: 'VINCULADO',
        purchaseItemId: c2.items[0].id,
        version: line.version,
      }),
    );
    expect((await result(admin, f.so.id)).materials.consumedCents).toBe(54000);
    ok(
      await send(admin, 'POST', `/api/v1/purchase-orders/${c2.id}/cancel`, {
        reason: 'Fornecedor sem estoque',
        version: c2.version,
      }),
    );
    // A leitura reconcilia: o vínculo deixou de valer, o custo informado volta (nada some).
    const r = await result(admin, f.so.id);
    expect(r.materials.consumedCents).toBe(54000 + 8000);
    expect(r.materials.pendingReconciliationLines).toBe(1);
    const list = ok(await admin.get(L(f.so.id)));
    expect(list.materials[0].reconciliation.status).toBe('PENDENTE');
  });

  it('vínculo com compra que depois teve ESTORNO de recebimento: nada muda sozinho, mas o resultado pede revisão', async () => {
    const admin = await loginAdmin(app);
    const f = await formalFabric(admin, 'Cliente Conciliação Estorno');
    const line = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Linho',
        purchased: true,
        costCents: 54000,
      }),
      201,
    ).materials[0];
    ok(
      await send(admin, 'POST', R(f.so.id, line.id), {
        mode: 'VINCULADO',
        costId: f.entry.id,
        version: line.version,
      }),
    );
    let r = await result(admin, f.so.id);
    expect(r.materials.linkedReversedLines).toBe(0);
    expect(r.warnings.join(' ')).not.toMatch(/Conciliação a revisar/);
    const informedBefore = r.materials.informedCents;
    // Estorno parcial do recebimento (2 de 12 m).
    const receiptLine = await db().materialReceiptLine.findFirstOrThrow({
      where: { purchaseOrderItemId: f.item.id },
    });
    ok(
      await send(admin, 'POST', `/api/v1/material-receipts/lines/${receiptLine.id}/reverse`, {
        quantity: 2,
        reason: 'Defeito no tecido',
      }),
    );
    r = await result(admin, f.so.id);
    // O formal cai pelo estorno (fluxo existente); o vínculo e o informado NÃO mudam sozinhos.
    expect(r.materials.consumedCents).toBe(54000 - 9000);
    expect(r.materials.informedCents).toBe(informedBefore);
    expect(r.materials.linkedReversedLines).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/Conciliação a revisar: 1 material/);
    const list = ok(await admin.get(L(f.so.id)));
    expect(list.materials[0].reconciliation.status).toBe('VINCULADO');
  });

  it('validações e permissões: registro de outra OS, sem custo formal, formato, versão, quem pode', async () => {
    const admin = await loginAdmin(app);
    const f = await formalFabric(admin, 'Cliente Conciliação Regras');
    const other = await formalFabric(admin, 'Cliente Outra OS');
    const line = ok(
      await send(admin, 'POST', L(f.so.id), {
        description: 'Linho',
        purchased: true,
        costCents: 54000,
      }),
      201,
    ).materials[0];
    // Registro formal de OUTRA OS: recusado.
    expect(
      (
        await send(admin, 'POST', R(f.so.id, line.id), {
          mode: 'VINCULADO',
          purchaseItemId: other.item.id,
          version: line.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send(admin, 'POST', R(f.so.id, line.id), {
          mode: 'VINCULADO',
          costId: other.entry.id,
          version: line.version,
        })
      ).status,
    ).toBe(422);
    // Formato: vincular sem registro, ou com dois registros, ou "distinto" com registro.
    for (const body of [
      { mode: 'VINCULADO' },
      { mode: 'VINCULADO', purchaseItemId: f.item.id, costId: f.entry.id },
      { mode: 'DISTINTO', costId: f.entry.id },
    ])
      expect(
        (await send(admin, 'POST', R(f.so.id, line.id), { ...body, version: line.version })).status,
      ).toBe(400);
    // Versão desatualizada.
    expect(
      (
        await send(admin, 'POST', R(f.so.id, line.id), {
          mode: 'DISTINTO',
          version: line.version + 5,
        })
      ).status,
    ).toBe(409);
    // OS sem custo formal: "distinto" e "vincular" não fazem sentido (nada a conciliar).
    const bare = await openServiceOrder(admin, 'Cliente Sem Custo Formal');
    const lone = ok(
      await send(admin, 'POST', L(bare.id), {
        description: 'Cola',
        purchased: true,
        costCents: 3000,
      }),
      201,
    );
    expect(lone.formalRecords).toEqual([]);
    expect(lone.materials[0].reconciliation.status).toBe('NAO_SE_APLICA');
    expect(
      (
        await send(admin, 'POST', R(bare.id, lone.materials[0].id), {
          mode: 'DISTINTO',
          version: lone.materials[0].version,
        })
      ).status,
    ).toBe(422);
    // Permissões: gerencia OS e vê o financeiro, mas não gerencia o financeiro → 403.
    const os = await panelUserWith(app, admin, 'gestor-os', [
      'os.ver',
      'os.gerenciar',
      'financeiro.ver',
    ]);
    expect(
      (await send(os, 'POST', R(f.so.id, line.id), { mode: 'DISTINTO', version: line.version }))
        .status,
    ).toBe(403);
    const seen = ok(await os.get(L(f.so.id)));
    expect(seen.canReconcile).toBe(false);
    expect(seen.materials[0].reconciliation.status).toBe('PENDENTE');
    // Sem financeiro: não vê custo nem conciliação.
    const viewer = await panelUserWith(app, admin, 'consulta-os', ['os.ver']);
    const hidden = ok(await viewer.get(L(f.so.id)));
    expect(hidden.materials[0].costCents).toBeUndefined();
    expect(hidden.materials[0].reconciliation).toBeUndefined();
    expect(hidden.formalRecords).toBeUndefined();
    // Nada mudou no livro com as tentativas recusadas.
    expect(
      await db().serviceOrderCost.count({
        where: { serviceOrderId: f.so.id, source: 'MATERIAL_OS' },
      }),
    ).toBe(1);
  });
});

describe('B. Entrega direta — efeitos financeiros equivalentes, sem duplicidade', () => {
  const D = (soId: string) => `/api/v1/service-orders/${soId}/deliver`;

  /** Cenário com saldo "na entrega" e mão de obra liberada só na entrega concluída. */
  async function withFinance() {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
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
    const labor = ok(
      await post(s.admin, '/api/v1/finance/labor', {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        service: 'Reforma do sofá',
        agreedCents: 80000,
        eligibility: 'ENTREGA_CONCLUIDA',
      }),
      201,
    );
    expect(labor.status).toBe('PREVISTO');
    return { s, rec, labor };
  }
  /** O que a entrega muda no financeiro (para comparar os dois caminhos). */
  async function effects(s: J, recId: string, laborId: string) {
    const rec = ok(await s.admin.get(`/api/v1/finance/receivables/${recId}`));
    const labor = await db().productionPayable.findUniqueOrThrow({ where: { id: laborId } });
    const res = await result(s.admin, s.so.id);
    return {
      due: rec.effectiveDueDate,
      receivables: await db().customerReceivable.count(),
      laborStatus: labor.status,
      laborEligible: labor.eligibleAt !== null,
      payables: await db().productionPayable.count(),
      delivered: res.delivered,
      completed: res.completedAt !== null,
      logisticsCosts: await db().logisticsCost.count(),
      accountsPayable: await db().accountPayable.count(),
    };
  }
  const EXPECTED = {
    due: today(),
    receivables: 1,
    laborStatus: 'LIBERADO',
    laborEligible: true,
    payables: 1,
    delivered: true,
    completed: true,
    accountsPayable: 0,
  };

  it('pela logística (referência): saldo vence, mão de obra liberada, OS concluída', async () => {
    const { s, rec, labor } = await withFinance();
    const d = ok(
      await k.schedule(s, {
        itemIds: [s.sofa.id, s.poltronas.id],
        scheduledDate: today(),
        team: 'EQUIPE_PROPRIA',
      }),
      201,
    );
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const items = ok(
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [
          { serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' },
          { serviceOrderItemId: s.poltronas.id, status: 'ENTREGUE' },
        ],
        version: v,
      }),
    );
    expect((await uploadPhoto(app, andre, 'DELIVERY', d.id)).status).toBe(201);
    ok(await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: items.version }));
    expect(await effects(s, rec.id, labor.id)).toMatchObject(EXPECTED);
    // Controle positivo: a viagem da logística SEM custo vira pendência do fechamento (a entrega
    // direta não — ver o teste seguinte e o da Fase 1).
    const closing = ok(await s.admin.get(`/api/v1/finance/weekly-closings/${mondayOf(today())}`));
    expect(JSON.stringify(closing)).toMatch(new RegExp(`Entrega ${d.code} realizada sem custo`));
  });

  it('pela OS (direta): os MESMOS efeitos; sem frete; repetir e concorrer não duplicam nada', async () => {
    const { s, rec, labor } = await withFinance();
    const before = await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } });
    expect(before.eligibleAt).toBeNull();
    // Três requisições simultâneas.
    const rs = await Promise.all([1, 2, 3].map(() => post(s.admin, D(s.so.id))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.body.created)).toHaveLength(1);
    const e = await effects(s, rec.id, labor.id);
    expect(e).toMatchObject({ ...EXPECTED, logisticsCosts: 0 });
    // Data de conclusão = momento da entrega registrada.
    const d = await db().delivery.findFirstOrThrow({ where: { origin: 'DIRETA' } });
    const res = await result(s.admin, s.so.id);
    expect(res.completedAt).toBe(d.completedAt!.toISOString());
    // Nada duplicado: uma entrega, uma cobrança, uma mão de obra, uma liberação registrada.
    const releasedAt = (await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } }))
      .eligibleAt;
    const again = ok(await post(s.admin, D(s.so.id)));
    expect(again.created).toBe(false);
    expect(await effects(s, rec.id, labor.id)).toEqual(e);
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } })).eligibleAt,
    ).toEqual(releasedAt);
    expect(await db().delivery.count()).toBe(1);
    const closing = ok(await s.admin.get(`/api/v1/finance/weekly-closings/${mondayOf(today())}`));
    // A única entrega da semana é a direta: nenhuma pendência de custo de viagem.
    expect(JSON.stringify(closing)).not.toMatch(/Entrega EN-\d+ realizada sem custo/);
  });

  it('peça já entregue pela logística não é tocada: a direta entrega só as pendentes', async () => {
    const { s, rec, labor } = await withFinance();
    // Sofá entregue pela logística.
    const d = ok(
      await k.schedule(s, { itemIds: [s.sofa.id], scheduledDate: today(), team: 'EQUIPE_PROPRIA' }),
      201,
    );
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const items = ok(
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      }),
    );
    expect((await uploadPhoto(app, andre, 'DELIVERY', d.id)).status).toBe(201);
    ok(await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: items.version }));
    const sofaBefore = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } });
    const sofaItemBefore = await db().deliveryItem.findFirstOrThrow({
      where: { serviceOrderItemId: s.sofa.id },
    });
    const sofaEvents = await db().qualityEvent.count({ where: { serviceOrderItemId: s.sofa.id } });
    // Mão de obra do sofá já liberada pela entrega da logística.
    const laborAfterLogistics = await db().productionPayable.findUniqueOrThrow({
      where: { id: labor.id },
    });
    expect(laborAfterLogistics.status).toBe('LIBERADO');

    const r = ok(await post(s.admin, D(s.so.id)));
    expect(r).toMatchObject({ created: true, deliveredItems: 1 });
    const direct = await db().delivery.findUniqueOrThrow({
      where: { id: r.deliveryId },
      include: { items: true },
    });
    expect(direct.items.map((i) => i.serviceOrderItemId)).toEqual([s.poltronas.id]);
    // Sofá intacto: mesma linha de entrega, mesma data, nenhuma etapa/evento novo.
    expect(await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } })).toEqual(
      sofaBefore,
    );
    expect(await db().deliveryItem.findMany({ where: { serviceOrderItemId: s.sofa.id } })).toEqual([
      sofaItemBefore,
    ]);
    expect(await db().qualityEvent.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
      sofaEvents,
    );
    // Mão de obra não muda de novo (mesma liberação), saldo vence uma vez.
    expect(await db().productionPayable.findUniqueOrThrow({ where: { id: labor.id } })).toEqual(
      laborAfterLogistics,
    );
    expect(await effects(s, rec.id, labor.id)).toMatchObject({ ...EXPECTED });
  });
});
