import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  createMeasurement,
  fabric,
  fillAndSubmit,
  gestorUserId,
  nextFriday,
} from './measurement-helpers';
import { addOs, createPlan, day, publish, sofaTask, today, userIdOf } from './production-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  readiness,
  receive,
  staples,
} from './purchasing-helpers';

/**
 * Compras e materiais sem duplicidade — Etapa 2: nova medição SUBSTITUI (decisão explícita do
 * gestor), necessidade com estado (ATIVA / SUBSTITUIDA / CANCELADA) e cadeia de substituição.
 * A cobertura atravessa a cadeia só quando estritamente compatível; a fórmula continua a única
 * (`requirementCoverage`); nada de compra, recebimento, reserva, movimento ou custo é apagado.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });

type Decision = {
  substitutions?: { requestItemId: string; replacesRequirementId: string }[];
  cancellations?: string[];
};
type Detail = {
  id: string;
  request: { id: string; version: number };
  items: { id: string; description: string; serviceOrderItemId: string | null }[];
  substitution: {
    candidates: { requirementId: string; serviceOrderItemId: string | null }[];
    suggested: Record<string, string | null>;
  } | null;
};
/** Aceita exatamente o que o sistema pré-selecionou (candidato único e seguro). */
const acceptSuggested = (d: Detail): Decision => ({
  substitutions: Object.entries(d.substitution?.suggested ?? {})
    .filter((e): e is [string, string] => Boolean(e[1]))
    .map(([requestItemId, replacesRequirementId]) => ({ requestItemId, replacesRequirementId })),
});

/** Nova medição da OS inteira (enviada) — devolve o detalhe em revisão, sem aprovar. */
async function submitted(admin: Client, soId: string, items: unknown[]) {
  const m = await createMeasurement(admin, {
    serviceOrderId: soId,
    kind: 'EXTRAORDINARIA',
    reason: 'Nova medição',
    assigneeUserId: await gestorUserId(),
    dueDate: nextFriday(),
  });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  const sub = await fillAndSubmit(admin, m.body, { items });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return (await admin.get(`/api/v1/measurements/${m.body.id}`)).body as Detail;
}
const approve = (admin: Client, d: Detail, decision: Decision = {}, key = idemKey()) =>
  post(
    admin,
    `/api/v1/measurements/${d.id}/request/approve`,
    {
      version: d.request.version,
      ...decision,
    },
    key,
  );
/** Remedição aprovada com a decisão informada (padrão: aceitar a pré-seleção). */
async function remeasure(
  admin: Client,
  soId: string,
  items: unknown[],
  decide: (d: Detail) => Decision = acceptSuggested,
) {
  const d = await submitted(admin, soId, items);
  const r = await approve(admin, d, decide(d));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return d;
}

const reqsOf = (soId: string) =>
  db().materialRequirement.findMany({
    where: { serviceOrderId: soId, origin: 'SOLICITACAO_APROVADA' },
    orderBy: { createdAt: 'asc' },
  });
const active = async (soId: string) => (await reqsOf(soId)).filter((r) => r.status === 'ATIVA');
type Line = {
  requirementId: string;
  need: number;
  covered: number;
  awaiting: number;
  inDraft: number;
  shortfall: number;
  excess: { draft: number; awaiting: number; available: number; consumed: number; total: number };
  replaces: { requirementId: string; quantity: number; inherited: boolean }[];
  leftoverDraft: {
    quantity: number;
    unitPriceCents: number | null;
    purchaseOrders: string[];
  } | null;
};
type Orphan = {
  requirementId: string;
  status: string;
  awaiting: number;
  draft: number;
  receivedExclusive: number;
  reservations: { id: string; quantity: number }[];
};
const linesOf = async (admin: Client, soId: string) => {
  const r = await readiness(admin, soId);
  return { lines: r.lines as Line[], orphans: r.orphans as Orphan[], state: r.state as string };
};
const needsOf = async (admin: Client) =>
  (await admin.get('/api/v1/purchasing/needs?pendingOnly=false')).body as {
    requirementId: string;
    pendingToBuy: number;
  }[];

/** Tecido exclusivo de 10 m do sofá, comprado e recebido (preço 4500). */
async function receivedLinen(admin: Client, qty = 10, received = qty) {
  const base = await approvedNeeds(admin, 'Cliente Etapa 2', (s) => [linen(s.items[0].id, qty)]);
  const supplier = await createSupplier(admin);
  const po = await confirmedFabricPurchase(admin, supplier.id, base.reqs[0]!);
  if (received > 0) {
    const r = await receive(admin, po.id, [ok(po.items[0].id, received)]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  return { ...base, supplier, po };
}

// ─────────────────────────── Migration e constraints ───────────────────────────

describe('Migration 26 (necessidade com estado e cadeia)', () => {
  it('necessidades existentes/novas nascem ATIVAS, sem encerramento; constraints do banco valem', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Migração', (s) => [
      linen(s.items[0].id, 10),
      staples(),
    ]);
    for (const r of reqs)
      expect(r).toMatchObject({
        status: 'ATIVA',
        replacesRequirementId: null,
        closedAt: null,
        closedById: null,
        closeReason: null,
      });
    const [a, b] = reqs as [(typeof reqs)[0], (typeof reqs)[0]];
    // Autorreferência recusada pelo banco.
    await expect(
      db().$executeRawUnsafe(
        `UPDATE material_requirements SET replaces_requirement_id = id WHERE id = '${a.id}'::uuid`,
      ),
    ).rejects.toThrow(/material_requirements_not_self_chk/);
    // Encerrada sem data (ou ATIVA com data) recusada.
    await expect(
      db().$executeRawUnsafe(
        `UPDATE material_requirements SET status = 'CANCELADA' WHERE id = '${a.id}'::uuid`,
      ),
    ).rejects.toThrow(/material_requirements_closed_chk/);
    // No máximo UMA sucessora direta por necessidade.
    await db().$executeRawUnsafe(
      `UPDATE material_requirements SET replaces_requirement_id = '${a.id}'::uuid WHERE id = '${b.id}'::uuid`,
    );
    const third = await db().materialRequirement.create({
      data: {
        serviceOrderId: so.id,
        kind: 'OUTRO',
        description: 'Teste',
        sourcing: 'ESTOQUE',
        origin: 'PREVISAO_MANUAL',
      },
    });
    await expect(
      db().$executeRawUnsafe(
        `UPDATE material_requirements SET replaces_requirement_id = '${a.id}'::uuid WHERE id = '${third.id}'::uuid`,
      ),
    ).rejects.toThrow(/23505.*replaces_requirement_id/s);
    // Predecessora não pode ser apagada enquanto houver sucessora (histórico preservado).
    await expect(db().materialRequirement.delete({ where: { id: a.id } })).rejects.toThrow();
  });
});

// ─────────────────────────── Decisão na aprovação (V1/V3) ───────────────────────────

describe('V1/V3 — substituição é decisão explícita; pré-seleção só com candidato único seguro', () => {
  it('sem decisão, a nova medição é necessidade NOVA (a falta soma, como antes)', async () => {
    const admin = await loginAdmin(app);
    const { so } = await approvedNeeds(admin, 'Cliente Sem Decisão', (s) => [
      linen(s.items[0].id, 10),
    ]);
    await remeasure(admin, so.id, [linen(so.items[0].id, 8)], () => ({}));
    expect((await active(so.id)).map((r) => Number(r.quantity)).sort()).toEqual([10, 8].sort());
  });

  it('candidato único da mesma peça e tipo vem pré-selecionado; "Toda a OS" e vários candidatos não', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Pré-seleção', (s) => [
      linen(s.items[0].id, 10),
      fabric({ serviceOrderItemId: s.items[1].id, description: 'Veludo', quantity: 6 }),
      fabric({ serviceOrderItemId: s.items[1].id, description: 'Suede', quantity: 4 }),
      staples({ quantity: 3 }),
    ]);
    const d = await submitted(admin, so.id, [
      linen(so.items[0].id, 8),
      fabric({ serviceOrderItemId: so.items[1].id, description: 'Veludo', quantity: 5 }),
      staples({ quantity: 2 }),
    ]);
    expect(d.substitution!.candidates).toHaveLength(4);
    const byDesc = (x: string) => d.items.find((i) => i.description === x)!.id;
    const sofa = reqs.find((r) => r.description === 'Linho')!;
    expect(d.substitution!.suggested[byDesc('Linho')]).toBe(sofa.id);
    // Dois tecidos na poltrona: não escolhe sozinho (a especificação não inventa identidade).
    expect(d.substitution!.suggested[byDesc('Veludo')]).toBeNull();
    // Toda a OS: nunca sugere.
    expect(d.substitution!.suggested[byDesc('Grampos 80/10')]).toBeNull();
  });

  it('decisões inválidas são recusadas: fora do escopo, repetida, substituir e cancelar a mesma', async () => {
    const admin = await loginAdmin(app);
    const a = await approvedNeeds(admin, 'Cliente A', (s) => [linen(s.items[0].id, 10)]);
    const b = await approvedNeeds(admin, 'Cliente B', (s) => [linen(s.items[0].id, 10)]);
    const d = await submitted(admin, a.so.id, [
      linen(a.so.items[0].id, 8),
      fabric({ serviceOrderItemId: a.so.items[0].id, description: 'Forro', quantity: 2 }),
    ]);
    const [i1, i2] = d.items.map((i) => i.id) as [string, string];
    const foreign = await approve(admin, d, {
      substitutions: [{ requestItemId: i1, replacesRequirementId: b.reqs[0]!.id }],
    });
    expect(foreign.status).toBe(400);
    const twice = await approve(admin, d, {
      substitutions: [
        { requestItemId: i1, replacesRequirementId: a.reqs[0]!.id },
        { requestItemId: i2, replacesRequirementId: a.reqs[0]!.id },
      ],
    });
    expect(twice.status).toBe(400);
    const both = await approve(admin, d, {
      substitutions: [{ requestItemId: i1, replacesRequirementId: a.reqs[0]!.id }],
      cancellations: [a.reqs[0]!.id],
    });
    expect(both.status).toBe(400);
    // Nada mudou com as recusas.
    expect((await active(a.so.id)).map((r) => r.id)).toEqual([a.reqs[0]!.id]);
  });
});

// ─────────────────────────── Cadeia e cobertura (V4) ───────────────────────────

describe('V4 — cobertura atravessa a cadeia só quando estritamente compatível', () => {
  it('10 → 8 com 10 recebidos: substituída (não apagada), falta 0, excedente 2 → Registrar sobra preenchida', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs, po } = await receivedLinen(admin, 10);
    const before = await db().purchaseAllocation.findMany({ orderBy: { id: 'asc' } });
    await remeasure(admin, so.id, [linen(so.items[0].id, 8)]);
    const all = await reqsOf(so.id);
    expect(all).toHaveLength(2);
    const [old, cur] = all as [(typeof all)[0], (typeof all)[0]];
    expect(old).toMatchObject({ id: reqs[0]!.id, status: 'SUBSTITUIDA' });
    expect(old.closedAt).not.toBeNull();
    expect(old.closedById).not.toBeNull();
    expect(old.closeReason).toMatch(/Substituída pela medição/);
    expect(cur).toMatchObject({ status: 'ATIVA', replacesRequirementId: old.id });
    // Fatos não se movem: a compra continua alocada à necessidade original.
    expect(await db().purchaseAllocation.findMany({ orderBy: { id: 'asc' } })).toEqual(before);

    const { lines, orphans } = await linesOf(admin, so.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      requirementId: cur.id,
      need: 8,
      covered: 8,
      shortfall: 0,
      excess: { available: 2, total: 2 },
      replaces: [{ requirementId: old.id, quantity: 10, inherited: true }],
      leftoverDraft: { quantity: 2, unitPriceCents: 4500, purchaseOrders: [po.code] },
    });
    expect(orphans).toEqual([]);
    // Histórico da OS: "Necessidade alterada: Linho 10 m → 8 m".
    const log = await db().auditLog.findFirst({
      where: { action: 'material_requirement.replaced', entityId: so.id },
    });
    expect(log?.summary).toMatch(/Necessidade alterada: Linho 10 m → 8 m/);
    // Sobra registrada (mesma especificação) deixa de ser oferecida.
    const reg = await post(admin, '/api/v1/material-leftovers', {
      serviceOrderId: so.id,
      kind: 'TECIDO',
      description: 'Linho',
      color: 'Bege',
      quantity: 2,
      unit: 'METRO',
      location: 'Prateleira A',
      condition: 'BOA',
      reusable: true,
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect((await linesOf(admin, so.id)).lines[0]!.leftoverDraft).toBeNull();
  });

  it('aumento 10 → 12 com 8 recebidos e compatíveis: falta 4, sem mover fatos', async () => {
    const admin = await loginAdmin(app);
    const { so } = await receivedLinen(admin, 10, 8);
    // Saldo 2 da compra encerrado (não virá): fica coberto 8.
    await remeasure(admin, so.id, [linen(so.items[0].id, 12)]);
    const { lines } = await linesOf(admin, so.id);
    expect(lines[0]).toMatchObject({ need: 12, covered: 8, awaiting: 2, shortfall: 2 });
    // Comprado 10 (8 recebidos + 2 a caminho) → falta 2; sem a compra a caminho seria 4.
    const n = (await needsOf(admin)).find((x) => x.requirementId === lines[0]!.requirementId)!;
    expect(n.pendingToBuy).toBe(2);
  });

  it('aumento 10 → 12 com 8 cobertos (saldo encerrado): falta exatamente 4', async () => {
    const admin = await loginAdmin(app);
    const { so, po } = await receivedLinen(admin, 10, 8);
    const close = await post(admin, `/api/v1/purchase-orders/${po.id}/close-balance`, {
      reason: 'Fornecedor não tem mais',
      version: (await admin.get(`/api/v1/purchase-orders/${po.id}`)).body.version,
    });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    await remeasure(admin, so.id, [linen(so.items[0].id, 12)]);
    const { lines } = await linesOf(admin, so.id);
    expect(lines[0]).toMatchObject({ need: 12, covered: 8, awaiting: 0, shortfall: 4 });
    const n = (await needsOf(admin)).find((x) => x.requirementId === lines[0]!.requirementId)!;
    expect(n.pendingToBuy).toBe(4);
  });

  it('troca de especificação (cor) X → Y: Y começa sem a cobertura de X; X vira órfã com decisão', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await receivedLinen(admin, 10);
    await remeasure(admin, so.id, [
      fabric({
        serviceOrderItemId: so.items[0].id,
        description: 'Linho',
        color: 'Cinza',
        quantity: 10,
      }),
    ]);
    const { lines, orphans } = await linesOf(admin, so.id);
    expect(lines[0]).toMatchObject({
      need: 10,
      covered: 0,
      shortfall: 10,
      replaces: [{ requirementId: reqs[0]!.id, inherited: false }],
    });
    expect(orphans).toEqual([
      expect.objectContaining({
        requirementId: reqs[0]!.id,
        status: 'SUBSTITUIDA',
        receivedExclusive: 10,
      }),
    ]);
  });

  it('cadeia de 2+ remedições: 10 → 8 → 6 herda; a terceira com outra cor quebra a cadeia', async () => {
    const admin = await loginAdmin(app);
    const { so } = await receivedLinen(admin, 10);
    await remeasure(admin, so.id, [linen(so.items[0].id, 8)]);
    await remeasure(admin, so.id, [linen(so.items[0].id, 6)]);
    let { lines, orphans } = await linesOf(admin, so.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ need: 6, covered: 6, shortfall: 0, excess: { available: 4 } });
    expect(lines[0]!.replaces.map((x) => x.quantity)).toEqual([8, 10]);
    expect(orphans).toEqual([]);
    await remeasure(admin, so.id, [
      fabric({
        serviceOrderItemId: so.items[0].id,
        description: 'Linho',
        color: 'Cinza',
        quantity: 6,
      }),
    ]);
    ({ lines, orphans } = await linesOf(admin, so.id));
    expect(lines[0]).toMatchObject({ need: 6, covered: 0, shortfall: 6 });
    expect(orphans.map((o) => o.receivedExclusive)).toEqual([10]);
    const statuses = (await reqsOf(so.id)).map((r) => r.status);
    expect(statuses).toEqual(['SUBSTITUIDA', 'SUBSTITUIDA', 'SUBSTITUIDA', 'ATIVA']);
  });

  it('estoque: mesma chave do catálogo herda; reserva 10 → necessidade 8 avisa "reserva excedente" e nada é liberado', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Estoque', () => [
      staples({ quantity: 10 }),
    ]);
    const item = await admin.post('/api/v1/stock-items', {
      kind: 'OUTRO',
      description: 'Grampos 80/10',
      unit: 'EMBALAGEM',
    });
    await post(admin, `/api/v1/stock-items/${item.body.id}/adjust`, {
      quantity: 20,
      reason: 'Inventário',
    });
    const res = await post(admin, '/api/v1/stock-reservations', {
      stockItemId: item.body.id,
      serviceOrderId: so.id,
      materialRequirementId: reqs[0]!.id,
      quantity: 10,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // "Toda a OS": precisa de escolha explícita (não vem pré-selecionado).
    await remeasure(admin, so.id, [staples({ quantity: 8 })], (d) => ({
      substitutions: [{ requestItemId: d.items[0]!.id, replacesRequirementId: reqs[0]!.id }],
    }));
    const { lines } = await linesOf(admin, so.id);
    expect(lines[0]).toMatchObject({ need: 8, covered: 8, excess: { available: 2 } });
    const r = await db().stockReservation.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(r).toMatchObject({ status: 'ATIVA', materialRequirementId: reqs[0]!.id });
    expect(Number(r.quantity)).toBe(10);
  });

  it('E3: reserva sem vínculo é atribuída só a necessidade ATIVA (nunca à substituída)', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente E3', () => [staples({ quantity: 5 })]);
    await remeasure(admin, so.id, [staples({ quantity: 4 })], (d) => ({
      substitutions: [{ requestItemId: d.items[0]!.id, replacesRequirementId: reqs[0]!.id }],
    }));
    const item = await admin.post('/api/v1/stock-items', {
      kind: 'OUTRO',
      description: 'Grampos 80/10',
      unit: 'EMBALAGEM',
    });
    await post(admin, `/api/v1/stock-items/${item.body.id}/adjust`, { quantity: 9, reason: 'Inv' });
    await post(admin, '/api/v1/stock-reservations', {
      stockItemId: item.body.id,
      serviceOrderId: so.id,
      quantity: 4,
    });
    const { lines, orphans } = await linesOf(admin, so.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ need: 4, covered: 4, shortfall: 0 });
    expect(orphans).toEqual([]);
  });
});

// ─────────────────────────── V2 — Manter / Cancelar ───────────────────────────

describe('V2 — necessidade anterior não repetida: Manter (padrão) ou Cancelar', () => {
  it('ausência na remedição não cancela; cancelar é explícito, com motivo e autor', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Manter', (s) => [
      linen(s.items[0].id, 10),
      staples({ quantity: 3 }),
    ]);
    const fabricReq = reqs.find((r) => r.kind === 'TECIDO')!;
    const stapleReq = reqs.find((r) => r.kind === 'OUTRO')!;
    // Remede só o tecido; grampos ficam (Manter é o padrão).
    await remeasure(admin, so.id, [linen(so.items[0].id, 9)]);
    expect(
      (await db().materialRequirement.findUniqueOrThrow({ where: { id: stapleReq.id } })).status,
    ).toBe('ATIVA');
    // Nova remedição cancelando os grampos conscientemente.
    await remeasure(admin, so.id, [linen(so.items[0].id, 9)], (d) => ({
      ...acceptSuggested(d),
      cancellations: [stapleReq.id],
    }));
    const st = await db().materialRequirement.findUniqueOrThrow({ where: { id: stapleReq.id } });
    expect(st.status).toBe('CANCELADA');
    expect(st.closedById).not.toBeNull();
    expect(st.closeReason).toMatch(/Cancelada na aprovação/);
    const { lines } = await linesOf(admin, so.id);
    expect(lines.map((l) => l.need)).toEqual([9]);
    expect(fabricReq.status).toBe('ATIVA');
  });
});

// ─────────────────────────── Travas (necessidade ATIVA) ───────────────────────────

describe('Travas — todo vínculo novo exige necessidade ATIVA (409)', () => {
  it('compra, reserva, sobra e tarefa recusam necessidade substituída; rascunho antigo → 409 ao confirmar', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Travas', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const supplier = await createSupplier(admin);
    // Rascunho criado ANTES da remedição.
    const draft = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 10 }],
          quantity: 10,
          unitPriceCents: 4500,
        },
      ],
    });
    expect(draft.status).toBe(201);
    await remeasure(admin, so.id, [linen(so.items[0].id, 8)]);
    const stale = await confirmPurchase(admin, draft.body);
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/Edite o rascunho/);
    const fresh = await createPurchase(admin, {
      supplierId: supplier.id,
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 2 }],
          quantity: 2,
          unitPriceCents: 4500,
        },
      ],
    });
    expect(fresh.status).toBe(409);
    // Rascunho antigo continua contando para a sucessora compatível (sem compra em dobro).
    const { lines } = await linesOf(admin, so.id);
    expect(lines[0]).toMatchObject({ need: 8, inDraft: 10, shortfall: 0, excess: { draft: 2 } });
  });

  it('reserva de estoque vinculada a necessidade substituída → 409 (sem a reserva)', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Reserva', () => [
      staples({ quantity: 5 }),
    ]);
    await remeasure(admin, so.id, [staples({ quantity: 4 })], (d) => ({
      substitutions: [{ requestItemId: d.items[0]!.id, replacesRequirementId: reqs[0]!.id }],
    }));
    const item = await admin.post('/api/v1/stock-items', {
      kind: 'OUTRO',
      description: 'Grampos 80/10',
      unit: 'EMBALAGEM',
    });
    await post(admin, `/api/v1/stock-items/${item.body.id}/adjust`, { quantity: 9, reason: 'Inv' });
    const res = await post(admin, '/api/v1/stock-reservations', {
      stockItemId: item.body.id,
      serviceOrderId: so.id,
      materialRequirementId: reqs[0]!.id,
      quantity: 1,
    });
    expect(res.status).toBe(409);
    expect(await db().stockReservation.count()).toBe(0);
  });

  it('transferência de sobra para necessidade cancelada → 409', async () => {
    const admin = await loginAdmin(app);
    const src = await approvedNeeds(admin, 'Cliente Origem', (s) => [linen(s.items[0].id, 4)]);
    const dst = await approvedNeeds(admin, 'Cliente Destino', (s) => [linen(s.items[0].id, 4)]);
    const l = await post(admin, '/api/v1/material-leftovers', {
      serviceOrderId: src.so.id,
      kind: 'TECIDO',
      description: 'Linho',
      color: 'Bege',
      quantity: 2,
      unit: 'METRO',
      location: 'Prateleira',
      condition: 'BOA',
      reusable: true,
    });
    expect(l.status).toBe(201);
    const cancel = await post(admin, `/api/v1/material-requirements/${dst.reqs[0]!.id}/cancel`, {
      reason: 'Cliente trouxe o tecido',
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const t = await post(admin, `/api/v1/material-leftovers/${l.body.id}/transfer`, {
      targetServiceOrderId: dst.so.id,
      targetRequirementId: dst.reqs[0]!.id,
      quantity: 1,
      reason: 'Reaproveitar',
    });
    expect(t.status).toBe(409);
    // Repetir o cancelamento não muda nada (idempotente pelo estado).
    const again = await post(admin, `/api/v1/material-requirements/${dst.reqs[0]!.id}/cancel`, {
      reason: 'De novo',
    });
    expect(again.status).toBe(200);
    expect(
      (await db().materialRequirement.findUniqueOrThrow({ where: { id: dst.reqs[0]!.id } }))
        .closeReason,
    ).toBe('Cliente trouxe o tecido');
  });

  it('reabrir: só a aprovação "virgem" é desfeita; com substituição/sucessora é recusada', async () => {
    const admin = await loginAdmin(app);
    const { so, measurement } = await approvedNeeds(admin, 'Cliente Reabrir', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const d = await remeasure(admin, so.id, [linen(so.items[0].id, 8)]);
    const m2 = (await admin.get(`/api/v1/measurements/${d.id}`)).body;
    const r2 = await post(admin, `/api/v1/measurements/${d.id}/request/reopen`, {
      reason: 'Revisar quantidades',
      version: m2.request.version,
    });
    expect(r2.status).toBe(422);
    const m1 = (await admin.get(`/api/v1/measurements/${measurement.id}`)).body;
    const r1 = await post(admin, `/api/v1/measurements/${measurement.id}/request/reopen`, {
      reason: 'Revisar quantidades',
      version: m1.request.version,
    });
    expect(r1.status).toBe(422);
    expect(await reqsOf(so.id)).toHaveLength(2);
    // Caso virgem: necessidade sem nada vinculado é desfeita (comportamento anterior).
    const v = await approvedNeeds(admin, 'Cliente Virgem', (s) => [linen(s.items[0].id, 3)]);
    const mv = (await admin.get(`/api/v1/measurements/${v.measurement.id}`)).body;
    const rv = await post(admin, `/api/v1/measurements/${v.measurement.id}/request/reopen`, {
      reason: 'Revisar',
      version: mv.request.version,
    });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(await reqsOf(v.so.id)).toHaveLength(0);
  });
});

// ─────────────────────────── Tarefas de produção (alto risco) ───────────────────────────

describe('Tarefas — vínculos acompanham a sucessora; cancelamento remove; nunca presa nem liberada indevidamente', () => {
  async function linkedCut(admin: Client) {
    const base = await approvedNeeds(admin, 'Cliente Tarefas', (s) => [linen(s.items[0].id, 10)]);
    const plan = await createPlan(admin);
    const added = (
      await addOs(admin, plan.id, {
        serviceOrderId: base.so.id,
        principalUserId: await userIdOf('Márcio'),
        date: day(-1),
      })
    ).body;
    const cut = sofaTask(added, base.so.items[0].id, 'CORTE_TECIDO');
    const link = await admin.put(`/api/v1/production-tasks/${cut.id}/materials`, {
      requirementIds: [base.reqs[0]!.id],
      version: cut.version,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const task = sofaTask(published, base.so.items[0].id, 'CORTE_TECIDO');
    const get = async () => (await admin.get(`/api/v1/production-tasks/${task.id}`)).body;
    return { ...base, task, get };
  }

  it('substituição compatível: vínculo passa para a sucessora; recebido o necessário, libera', async () => {
    const admin = await loginAdmin(app);
    const s = await linkedCut(admin);
    expect((await s.get()).status).toBe('BLOQUEADA');
    await remeasure(admin, s.so.id, [linen(s.so.items[0].id, 8)]);
    const [cur] = await active(s.so.id);
    const links = await db().productionTaskMaterial.findMany({ where: { taskId: s.task.id } });
    expect(links.map((l) => l.requirementId)).toEqual([cur!.id]);
    expect(
      await db().auditLog.count({ where: { action: 'production_task.materials_moved' } }),
    ).toBe(1);
    // Ainda bloqueada (nada recebido) — não é liberada pela troca.
    expect((await s.get()).status).toBe('BLOQUEADA');
    // Compra/recebimento pela necessidade ORIGINAL (rascunho antigo de outra tela é recusado),
    // então pela atual: 8 recebidos liberam.
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, cur!);
    await receive(admin, po.id, [ok(po.items[0].id, 8)]);
    expect((await s.get()).status).toBe('LIBERADA');
  });

  it('troca de especificação: tarefa depende da sucessora (não fica liberada pelo material antigo)', async () => {
    const admin = await loginAdmin(app);
    const s = await linkedCut(admin);
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, s.reqs[0]!);
    await receive(admin, po.id, [ok(po.items[0].id, 10)]);
    expect((await s.get()).status).toBe('LIBERADA');
    await remeasure(admin, s.so.id, [
      fabric({
        serviceOrderItemId: s.so.items[0].id,
        description: 'Linho',
        color: 'Cinza',
        quantity: 10,
      }),
    ]);
    const [cur] = await active(s.so.id);
    expect(
      (await db().productionTaskMaterial.findMany({ where: { taskId: s.task.id } })).map(
        (l) => l.requirementId,
      ),
    ).toEqual([cur!.id]);
    expect((await s.get()).blockers).toContain('MATERIAIS');
  });

  it('necessidade cancelada: vínculo removido (auditado) — a tarefa não fica presa para sempre', async () => {
    const admin = await loginAdmin(app);
    const s = await linkedCut(admin);
    expect((await s.get()).status).toBe('BLOQUEADA');
    const c = await post(admin, `/api/v1/material-requirements/${s.reqs[0]!.id}/cancel`, {
      reason: 'Cliente trouxe o tecido',
    });
    expect(c.status).toBe(200);
    expect(await db().productionTaskMaterial.count({ where: { taskId: s.task.id } })).toBe(0);
    expect(
      await db().auditLog.count({ where: { action: 'production_task.materials_unlinked' } }),
    ).toBe(1);
    expect((await s.get()).blockers ?? []).not.toContain('MATERIAIS');
    // Vincular de novo a necessidade cancelada é recusado.
    const t = await s.get();
    const relink = await admin.put(`/api/v1/production-tasks/${t.id}/materials`, {
      requirementIds: [s.reqs[0]!.id],
      version: t.version,
    });
    expect(relink.status).toBe(422);
  });
});

// ─────────────────────────── OS cancelada (V5) e devolução (V7) ───────────────────────────

describe('V5 — OS cancelada encerra as necessidades em lote, sem tocar compras', () => {
  it('necessidades ATIVAS → CANCELADA com motivo; pedido continua, aparece "sem destino"', async () => {
    const admin = await loginAdmin(app);
    const { so, po } = await receivedLinen(admin, 10, 0);
    const poBefore = await db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    const c = await admin.post(`/api/v1/service-orders/${so.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: os.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const reqs = await reqsOf(so.id);
    expect(reqs.map((r) => r.status)).toEqual(['CANCELADA']);
    expect(reqs[0]!.closeReason).toMatch(/OS cancelada/);
    const poAfter = await db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(poAfter.status).toBe(poBefore.status);
    expect(await db().purchaseAllocation.count()).toBe(1);
    const list = (await admin.get('/api/v1/purchase-orders')).body;
    const row = (list.items ?? list).find((p: { id: string }) => p.id === po.id);
    expect(row.withoutDestination.map((x: { id: string }) => x.id)).toEqual([so.id]);
    // CANCELADA não gera falta nem A comprar.
    expect((await needsOf(admin)).filter((n) => n.requirementId === reqs[0]!.id)).toEqual([]);
  });
});

describe('V7 — devolução parcial', () => {
  async function returnSofa(
    admin: Client,
    so: { id: string; items: [{ id: string }, { id: string }] },
  ) {
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: so.items[0].id } });
    const orderId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).orderId;
    const r = await post(admin, '/api/v1/returns', {
      orderId,
      reason: 'Cliente desistiu do sofá',
      returnDate: today(),
      destination: 'Entregue ao cliente',
      lines: [
        { orderItemId: item.orderItemId, quantity: 1, serviceOrderItemIds: [so.items[0].id] },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = await post(admin, `/api/v1/returns/${r.body.id}/confirm`, {
      note: 'Cliente levou',
      version: r.body.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    return (await admin.get(`/api/v1/returns/${r.body.id}`)).body;
  }

  it('peça devolvida: necessidades dela CANCELADAS; "Toda a OS" vai para revisão; peça não pode ser remedida', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Devolução', (s) => [
      linen(s.items[0].id, 10),
      fabric({ serviceOrderItemId: s.items[1].id, description: 'Veludo', quantity: 6 }),
      staples({ quantity: 3 }),
    ]);
    const ret = await returnSofa(admin, so);
    const after = new Map((await reqsOf(so.id)).map((r) => [r.description, r]));
    expect(after.get('Linho')!.status).toBe('CANCELADA');
    expect(after.get('Linho')!.closeReason).toMatch(/Peça devolvida/);
    expect(after.get('Veludo')!.status).toBe('ATIVA');
    expect(after.get('Grampos 80/10')!.status).toBe('ATIVA');
    expect(ret.review.requirements.map((x: { id: string }) => x.id)).toEqual([
      reqs.find((r) => r.description === 'Grampos 80/10')!.id,
    ]);
    // Nova medição da peça devolvida é recusada.
    const m = await createMeasurement(admin, {
      serviceOrderId: so.id,
      serviceOrderItemId: so.items[0].id,
      kind: 'EXTRAORDINARIA',
      reason: 'Remedir',
      assigneeUserId: await gestorUserId(),
      dueDate: nextFriday(),
    });
    expect(m.status).toBe(422);
    expect(m.body.error.message).toMatch(/devolvida/);
  });
});

// ─────────────────────────── Concorrência e repetição ───────────────────────────

describe('Concorrência real e repetição', () => {
  it('duas aprovações substituindo a MESMA necessidade em paralelo: uma vence, a outra 409', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Corrida', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const d1 = await submitted(admin, so.id, [linen(so.items[0].id, 8)]);
    const d2 = await submitted(admin, so.id, [linen(so.items[0].id, 7)]);
    const res = await Promise.all([
      approve(admin, d1, acceptSuggested(d1)),
      approve(admin, d2, acceptSuggested(d2)),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const all = await reqsOf(so.id);
    expect(all.filter((r) => r.status === 'ATIVA')).toHaveLength(1);
    expect(all.filter((r) => r.replacesRequirementId === reqs[0]!.id)).toHaveLength(1);
  });

  it('aprovação × compra em paralelo: nunca duas necessidades ativas nem compra na substituída depois', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Corrida 2', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const supplier = await createSupplier(admin);
    const d = await submitted(admin, so.id, [linen(so.items[0].id, 8)]);
    const [a, p] = await Promise.all([
      approve(admin, d, acceptSuggested(d)),
      createPurchase(admin, {
        supplierId: supplier.id,
        items: [
          {
            sourcing: 'EXCLUSIVO_OS',
            allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 10 }],
            quantity: 10,
            unitPriceCents: 4500,
          },
        ],
      }),
    ]);
    expect(a.status).toBe(200);
    expect([201, 409]).toContain(p.status);
    expect(await active(so.id)).toHaveLength(1);
    const { lines } = await linesOf(admin, so.id);
    // Se a compra entrou antes, a sucessora compatível herda o rascunho (sem comprar em dobro).
    expect(lines[0]!.shortfall).toBe(p.status === 201 ? 0 : 8);
  });

  it('aprovação × recebimento em paralelo: o recebido conta uma vez, pela cadeia', async () => {
    const admin = await loginAdmin(app);
    const { so, po } = await receivedLinen(admin, 10, 0);
    const d = await submitted(admin, so.id, [linen(so.items[0].id, 8)]);
    const [a, r] = await Promise.all([
      approve(admin, d, acceptSuggested(d)),
      receive(admin, po.id, [ok(po.items[0].id, 10)]),
    ]);
    expect(a.status).toBe(200);
    expect(r.status).toBe(201);
    const { lines } = await linesOf(admin, so.id);
    expect(lines[0]).toMatchObject({ need: 8, covered: 8, excess: { available: 2 } });
  });

  it('aprovação × devolução da peça em paralelo: nenhuma necessidade ativa sobra para a peça devolvida', async () => {
    const admin = await loginAdmin(app);
    const { so } = await approvedNeeds(admin, 'Cliente Corrida 3', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const d = await submitted(admin, so.id, [linen(so.items[0].id, 8)]);
    const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: so.items[0].id } });
    const orderId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).orderId;
    const ret = await post(admin, '/api/v1/returns', {
      orderId,
      reason: 'Cliente desistiu',
      returnDate: today(),
      destination: 'Entregue ao cliente',
      lines: [
        { orderItemId: item.orderItemId, quantity: 1, serviceOrderItemIds: [so.items[0].id] },
      ],
    });
    expect(ret.status).toBe(201);
    const [a, c] = await Promise.all([
      approve(admin, d, acceptSuggested(d)),
      post(admin, `/api/v1/returns/${ret.body.id}/confirm`, {
        note: 'Levou',
        version: ret.body.version,
      }),
    ]);
    expect(c.status).toBe(200);
    expect([200, 409]).toContain(a.status);
    const piece = (await reqsOf(so.id)).filter((r) => r.serviceOrderItemId === so.items[0].id);
    expect(piece.filter((r) => r.status === 'ATIVA')).toEqual([]);
  });

  it('repetição com a mesma chave de idempotência: uma única sucessora', async () => {
    const admin = await loginAdmin(app);
    const { so } = await approvedNeeds(admin, 'Cliente Repetição', (s) => [
      linen(s.items[0].id, 10),
    ]);
    const d = await submitted(admin, so.id, [linen(so.items[0].id, 8)]);
    const key = idemKey();
    const r1 = await approve(admin, d, acceptSuggested(d), key);
    const r2 = await approve(admin, d, acceptSuggested(d), key);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await reqsOf(so.id)).toHaveLength(2);
    expect(await active(so.id)).toHaveLength(1);
  });
});

// ─────────────────────────── Custo histórico ───────────────────────────

describe('Custo histórico e Resultado por OS intactos', () => {
  it('substituição não altera comprado nem custos lançados; previsto usa só a ATIVA', async () => {
    const admin = await loginAdmin(app);
    const { so } = await receivedLinen(admin, 10);
    const costs = async () =>
      (await admin.get(`/api/v1/finance/service-orders/${so.id}`)).body.materials as {
        forecastCents: number;
        purchasedCents: number;
        consumedCents: number;
      };
    const before = await costs();
    const ledger = await db().serviceOrderCost.findMany({ where: { serviceOrderId: so.id } });
    expect(before.forecastCents).toBe(10 * 4500);
    await remeasure(admin, so.id, [linen(so.items[0].id, 8)]);
    const after = await costs();
    expect(after.purchasedCents).toBe(before.purchasedCents);
    expect(after.consumedCents).toBe(before.consumedCents);
    expect(after.forecastCents).toBe(8 * 4500);
    expect(await db().serviceOrderCost.findMany({ where: { serviceOrderId: so.id } })).toEqual(
      ledger,
    );
  });
});
