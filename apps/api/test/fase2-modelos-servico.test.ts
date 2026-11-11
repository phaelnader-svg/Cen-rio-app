import { selectProductionTemplate } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 2 — modelos de serviço: visão unificada (etapas + checklist + materiais
 * padrão), materiais padrão auditados e sugestão na OS SEM compra, custo, despesa ou estoque.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

const send = (c: Client, method: 'POST' | 'PATCH', url: string, body: unknown = {}) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const M = '/api/v1/service-models/materials';
const S = (soId: string) => `/api/v1/service-orders/${soId}/material-suggestions`;

/** Fotografia de tudo que uma sugestão NÃO pode tocar. */
async function untouchable() {
  const d = db();
  const [costs, pos, poItems, needs, adjustments, items, movements, payables] = await Promise.all([
    d.serviceOrderCost.count(),
    d.purchaseOrder.count(),
    d.purchaseOrderItem.count(),
    d.materialRequirement.count(),
    d.inventoryAdjustment.count(),
    d.inventoryItem.findMany({ select: { id: true, quantity: true }, orderBy: { id: 'asc' } }),
    d.stockMovement.count(),
    d.accountPayable.count(),
  ]);
  return {
    costs,
    pos,
    poItems,
    needs,
    adjustments,
    items: items.map((i) => [i.id, String(i.quantity)]),
    movements,
    payables,
  };
}

describe('Modelos de serviço', () => {
  it('visão geral usa as MESMAS regras do planejamento (etapas) e da inspeção (checklist)', async () => {
    const admin = await loginAdmin(app);
    const ov = ok(await admin.get('/api/v1/service-models'));
    expect(ov.can).toEqual({ production: true, quality: true, materials: true });
    expect(ov.rows).toHaveLength(9 * 7);
    const templates = await db().productionTemplate.findMany({
      where: { active: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of ov.rows) {
      const expected = selectProductionTemplate(templates, row);
      expect(row.productionTemplate?.id ?? null, `${row.pieceType}/${row.serviceType}`).toBe(
        expected?.id ?? null,
      );
    }
    // Detalhe: checklist filtrado pelo serviço, igual ao que a inspeção monta.
    const q = await db().qualityTemplate.findFirst({
      where: { active: true, pieceTypes: { has: 'SOFA' } },
      include: { items: { orderBy: { position: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    const det = ok(
      await admin.get('/api/v1/service-models/detail?pieceType=SOFA&serviceType=TROCA_DE_TECIDO'),
    );
    const expectedItems = q
      ? q.items
          .filter((i) => !i.serviceTypes.length || i.serviceTypes.includes('TROCA_DE_TECIDO'))
          .map((i) => i.label)
      : ['Acabamento', 'Conformidade com a OS'];
    expect(det.quality.items.map((i: J) => i.label)).toEqual(expectedItems);
    expect(det.production).toBeDefined();
  });

  it('cada parte só aparece para quem já podia vê-la; sem permissão nenhuma = 403', async () => {
    const admin = await loginAdmin(app);
    const quality = await panelUserWith(app, admin, 'qual', ['qualidade.gerenciar']);
    const ov = ok(await quality.get('/api/v1/service-models'));
    expect(ov.can).toEqual({ production: false, quality: true, materials: false });
    expect(ov.rows[0].productionTemplate).toBeUndefined();
    expect(ov.rows[0].qualityTemplate).not.toBeUndefined();
    const det = ok(
      await quality.get('/api/v1/service-models/detail?pieceType=SOFA&serviceType=REPARO'),
    );
    expect(det.production).toBeUndefined();
    // Só qualidade: não edita materiais padrão.
    expect(
      (await send(quality, 'POST', M, { pieceType: 'SOFA', serviceType: null, description: 'X1' }))
        .status,
    ).toBe(403);
    const nobody = await panelUserWith(app, admin, 'ninguem', ['os.ver']);
    expect((await nobody.get('/api/v1/service-models')).status).toBe(403);
  });

  it('materiais padrão: cadastro, edição com versão, arquivamento — tudo auditado', async () => {
    const admin = await loginAdmin(app);
    const m = ok(
      await send(admin, 'POST', M, {
        pieceType: 'SOFA',
        serviceType: 'TROCA_DE_TECIDO',
        description: 'Tecido',
        quantity: 8,
        unit: 'm',
      }),
      201,
    );
    expect(m).toMatchObject({ pieceType: 'SOFA', serviceType: 'TROCA_DE_TECIDO', quantity: 8 });
    const geral = ok(
      await send(admin, 'POST', M, {
        pieceType: 'SOFA',
        serviceType: null,
        description: 'Grampos',
        quantity: 1,
        unit: 'cx',
      }),
      201,
    );
    // Validação: descrição curta e quantidade não positiva.
    expect(
      (await send(admin, 'POST', M, { pieceType: 'SOFA', serviceType: null, description: 'a' }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(admin, 'POST', M, {
          pieceType: 'SOFA',
          serviceType: null,
          description: 'Cola',
          quantity: 0,
        })
      ).status,
    ).toBe(400);
    // Vale para o serviço: específico + geral; outro serviço: só o geral.
    const tt = ok(
      await admin.get('/api/v1/service-models/detail?pieceType=SOFA&serviceType=TROCA_DE_TECIDO'),
    );
    expect(tt.materials.map((x: J) => x.description)).toEqual(['Tecido', 'Grampos']);
    const rp = ok(
      await admin.get('/api/v1/service-models/detail?pieceType=SOFA&serviceType=REPARO'),
    );
    expect(rp.materials.map((x: J) => x.description)).toEqual(['Grampos']);
    // Edição com versão; versão velha = 409.
    const ed = ok(
      await send(admin, 'PATCH', `${M}/${m.id}`, { quantity: 9.5, version: m.version }),
    );
    expect(ed.quantity).toBe(9.5);
    expect(
      (await send(admin, 'PATCH', `${M}/${m.id}`, { quantity: 7, version: m.version })).status,
    ).toBe(409);
    ok(await send(admin, 'POST', `${M}/${geral.id}/archive`, { version: geral.version }));
    ok(await send(admin, 'POST', `${M}/${geral.id}/archive`, { version: geral.version })); // repetição
    const after = ok(await admin.get(`${M}?pieceType=SOFA`));
    expect(after.map((x: J) => x.description)).toEqual(['Tecido']);
    // Arquivar não apaga.
    expect(await db().serviceModelMaterial.count()).toBe(2);
    const audits = await db().auditLog.findMany({
      where: { entityType: 'service_model_material' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'service_model.material_added',
      'service_model.material_added',
      'service_model.material_updated',
      'service_model.material_archived',
    ]);
  });

  it('sugestão na OS: prévia, aplicação sem compra/custo/estoque, sem duplicar, revisável', async () => {
    const admin = await loginAdmin(app);
    // OS: 1 sofá (REFORMA_COMPLETA) + 2 poltronas (TROCA_DE_TECIDO).
    const so = await openServiceOrder(admin, 'Cliente Modelo');
    const tecidoPoltrona = ok(
      await send(admin, 'POST', M, {
        pieceType: 'POLTRONA',
        serviceType: 'TROCA_DE_TECIDO',
        description: 'Tecido',
        quantity: 3.5,
        unit: 'm',
        notes: 'Conferir estampa',
      }),
      201,
    );
    const espumaSofa = ok(
      await send(admin, 'POST', M, {
        pieceType: 'SOFA',
        serviceType: null,
        description: 'Espuma D33',
        quantity: 2,
        unit: 'placa',
      }),
      201,
    );
    // Material do estoque como referência: a sugestão NÃO baixa o estoque.
    const stock = await db().inventoryItem.create({
      data: { name: 'Grampo 106/8', unit: 'cx', quantity: 5 },
    });
    const grampo = ok(
      await send(admin, 'POST', M, {
        pieceType: 'POLTRONA',
        serviceType: null,
        description: 'Grampo',
        quantity: 0.5,
        unit: 'cx',
        inventoryItemId: stock.id,
      }),
      201,
    );
    const before = await untouchable();
    const prev = ok(await admin.get(S(so.id)));
    const by = (id: string) => prev.suggestions.find((s: J) => s.modelMaterialId === id);
    expect(by(tecidoPoltrona.id)).toMatchObject({ quantity: 7, unit: 'm', alreadyAdded: false });
    expect(by(tecidoPoltrona.id).sources).toEqual(['Poltrona · Troca de tecido (2)']);
    expect(by(espumaSofa.id)).toMatchObject({ quantity: 2, sources: ['Sofá · Reforma completa'] });
    expect(by(grampo.id)).toMatchObject({ quantity: 1, inventoryItemName: 'Grampo 106/8' });
    expect(prev.withoutModel).toEqual([]);
    // A prévia não grava nada.
    expect(await db().serviceOrderMaterial.count()).toBe(0);

    const applied = ok(
      await send(admin, 'POST', `${S(so.id)}/apply`, {
        modelMaterialIds: [tecidoPoltrona.id, grampo.id],
      }),
      201,
    );
    expect(applied).toMatchObject({ added: 2, skipped: 0 });
    const lines = applied.list.materials;
    expect(
      lines.map((l: J) => [l.description, l.quantity, l.purchased, l.available, l.costCents]),
    ).toEqual([
      ['Tecido', 7, false, false, null],
      ['Grampo', 1, false, false, null],
    ]);
    expect(lines[0].notes).toContain('Sugerido pelo modelo de serviço');
    expect(lines[0].notes).toContain('Conferir estampa');
    // NADA de compra, necessidade formal, custo, despesa, ajuste ou movimento de estoque.
    expect(await untouchable()).toEqual(before);

    // Repetir não duplica (idempotência por origem), mas aplica o que faltava.
    const again = ok(
      await send(admin, 'POST', `${S(so.id)}/apply`, {
        modelMaterialIds: [tecidoPoltrona.id, espumaSofa.id],
      }),
      201,
    );
    expect(again).toMatchObject({ added: 1, skipped: 1 });
    expect(await db().serviceOrderMaterial.count({ where: { serviceOrderId: so.id } })).toBe(3);
    const now = ok(await admin.get(S(so.id)));
    expect(now.suggestions.every((s: J) => s.alreadyAdded)).toBe(true);

    // O gestor revisa: altera a quantidade e remove uma linha; removida pode ser sugerida de novo.
    const tecidoLine = again.list.materials.find((l: J) => l.description === 'Tecido');
    ok(
      await send(admin, 'PATCH', `/api/v1/service-orders/${so.id}/material-list/${tecidoLine.id}`, {
        quantity: 6,
        version: tecidoLine.version,
      }),
    );
    const grampoLine = again.list.materials.find((l: J) => l.description === 'Grampo');
    ok(
      await send(
        admin,
        'POST',
        `/api/v1/service-orders/${so.id}/material-list/${grampoLine.id}/remove`,
        {
          version: grampoLine.version,
        },
      ),
    );
    expect(
      ok(await admin.get(S(so.id))).suggestions.find((s: J) => s.modelMaterialId === grampo.id)
        .alreadyAdded,
    ).toBe(false);

    // Material escolhido que não serve para a OS: recusa sem gravar nada.
    const cadeira = ok(
      await send(admin, 'POST', M, {
        pieceType: 'CADEIRA',
        serviceType: null,
        description: 'Cola',
      }),
      201,
    );
    const n = await db().serviceOrderMaterial.count();
    expect(
      (await send(admin, 'POST', `${S(so.id)}/apply`, { modelMaterialIds: [cadeira.id] })).status,
    ).toBe(422);
    expect(await db().serviceOrderMaterial.count()).toBe(n);
    expect((await send(admin, 'POST', `${S(so.id)}/apply`, { modelMaterialIds: [] })).status).toBe(
      400,
    );

    // Auditoria da OS registra a origem.
    const audit = await db().auditLog.findFirst({
      where: { action: 'service_order.material_list_added', entityType: 'service_order_material' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit?.summary).toContain('sugerido pelo modelo de serviço');
    // Arquivar o material padrão não mexe nas linhas que já vieram dele.
    ok(
      await send(admin, 'POST', `${M}/${tecidoPoltrona.id}/archive`, {
        version: tecidoPoltrona.version,
      }),
    );
    const kept = await db().serviceOrderMaterial.findFirst({
      where: { sourceModelMaterialId: tecidoPoltrona.id },
    });
    expect(kept?.removedAt).toBeNull();
    expect(String(kept?.quantity)).toBe('6');
  });

  it('sugestão exige os.gerenciar; quem só vê OS não aplica; OS cancelada não aceita', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Permissão');
    const m = ok(
      await send(admin, 'POST', M, { pieceType: 'SOFA', serviceType: null, description: 'Espuma' }),
      201,
    );
    const viewer = await panelUserWith(app, admin, 'leitor', ['os.ver']);
    expect((await viewer.get(S(so.id))).status).toBe(403);
    expect(
      (await send(viewer, 'POST', `${S(so.id)}/apply`, { modelMaterialIds: [m.id] })).status,
    ).toBe(403);
    // Sem financeiro: a resposta não traz custos.
    const manager = await panelUserWith(app, admin, 'gestor-mod', ['os.ver', 'os.gerenciar']);
    const r = ok(
      await send(manager, 'POST', `${S(so.id)}/apply`, { modelMaterialIds: [m.id] }),
      201,
    );
    expect(r.list.canSeeCosts).toBe(false);
    expect(r.list.materials[0].costCents).toBeUndefined();
    await db().serviceOrder.update({
      where: { id: so.id },
      data: { status: 'CANCELADA', cancelledAt: new Date() },
    });
    const m2 = ok(
      await send(admin, 'POST', M, {
        pieceType: 'POLTRONA',
        serviceType: null,
        description: 'Cola',
      }),
      201,
    );
    expect(
      (await send(admin, 'POST', `${S(so.id)}/apply`, { modelMaterialIds: [m2.id] })).status,
    ).toBe(422);
  });
});
